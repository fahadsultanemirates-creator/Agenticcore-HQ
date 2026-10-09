// The boss: every Telegram request becomes a job run by the Claude Agent SDK
// (the Claude Code engine) with full tools, Fahad's rules, the hq tools and the
// specialist sub-agents. One conversation per chat continues across messages
// (/new starts fresh). Jobs run one at a time; new messages wait in a queue.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { HQ_PROMPT, SPECIALISTS } from './prompt.js';
import { classify, childEnv } from './guard.js';

export const MODEL_ALIASES = { opus: 'model', fable: 'modelHard', sonnet: 'claude-sonnet-5-5' };

export function describeTool(name, input = {}) {
  if (name === 'Bash' || name === 'PowerShell') {
    // Prefer the plain-words description the engine gives each command; else a short guess from the command.
    if (input.description) return String(input.description).slice(0, 80);
    const cmd = String(input.command || '');
    if (/https?:\/\//.test(cmd) && /curl|wget|Invoke-WebRequest|iwr|fetch/i.test(cmd)) return 'reading a web page';
    if (/\bgit\b/.test(cmd)) return 'working with GitHub';
    if (/\bnpm|node\b/.test(cmd)) return 'running a script';
    return 'running a command';
  }
  if (name === 'Read') return 'reading ' + String(input.file_path || '').split(/[\\/]/).slice(-2).join('/');
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') return 'editing ' + String(input.file_path || '').split(/[\\/]/).slice(-2).join('/');
  if (name === 'Task' || name === 'Agent') return (input.subagent_type ? input.subagent_type + ': ' : '') + String(input.description || 'working on a sub-task').slice(0, 80);
  if (name === 'WebSearch') return 'searching the web: ' + String(input.query || '').slice(0, 60);
  if (name === 'WebFetch') return 'reading ' + String(input.url || '').replace(/^https?:\/\//, '').slice(0, 60);
  const br = /^mcp__browser__browser_(.+)$/.exec(name);
  if (br) return br[1] === 'navigate' ? 'opening ' + String(input.url || '').replace(/^https?:\/\//, '').slice(0, 60) : 'using the browser (' + br[1].replace(/_/g, ' ') + ')';
  if (/^mcp__netlify__/.test(name)) return 'working on Netlify';
  const sb = /^mcp__supabase(\d)__(.+)$/.exec(name);
  if (sb) return 'Supabase account ' + sb[1] + ': ' + sb[2].replace(/_/g, ' ');
  const hq = /^mcp__hq__(.+)$/.exec(name);
  if (hq) return ({ ask_gpt: 'asking GPT', ask_gemini: 'researching with Gemini', ask_grok: 'asking Grok', generate_image: 'making images', generate_video: 'rendering a video', speak: 'recording a voice message', request_approval: 'waiting for your approval' })[hq[1]] || hq[1].replace(/_/g, ' ');
  return name;
}

// deps: { cfg, tg, store, usage, approvals, hqServer, log, queryFn?, timers? }
export function makeBoss(deps) {
  const { cfg, tg, store, usage, approvals, log } = deps;
  const runQuery = deps.queryFn || query;
  const queue = [];
  let current = null; // { chatId, abort, startedAt, activity }
  let running = false;
  let nextJobBudget = null;   // /bigjob: a higher spending limit for the next job only
  let jobCap = cfg.jobBudget;
  const external = deps.externalServers || {};
  const systemAppend = HQ_PROMPT + (deps.accountsNote ? '\n\n' + deps.accountsNote : '');

  const settings = () => store.read('settings', { model: 'opus', effort: cfg.effort });
  function modelId(alias) { const k = MODEL_ALIASES[alias] || 'model'; return cfg[k] || k; }

  function options(chatId, sessionId, abort) {
    const s = settings();
    const okFiles = new Set();   // files Fahad allowed in this job: later edits of the same file do not ask again
    const fileKey = (input) => (input.file_path ? String(input.file_path).replace(/\//g, '\\').toLowerCase() : '');
    return {
      model: modelId(s.model),
      fallbackModel: s.model === 'opus' ? undefined : cfg.model,
      effort: s.effort || cfg.effort,
      thinking: { type: 'adaptive' },
      cwd: cfg.workspace,
      settingSources: ['project'],                       // loads workspace/CLAUDE.md (+ memory/notes.md)
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend },
      mcpServers: Object.assign({ hq: deps.hqServer }, external),
      agents: Object.fromEntries(Object.entries(SPECIALISTS).map(([k, a]) => [k, Object.assign({ model: modelId('opus'), mcpServers: ['hq'].concat(Object.keys(external)) }, a)])),
      permissionMode: 'default',
      canUseTool: async (toolName, input) => {
        const c = classify(toolName, input, { workspace: cfg.workspace });
        if (c.decision === 'allow') return { behavior: 'allow', updatedInput: input };
        if (c.decision === 'deny') return { behavior: 'deny', message: 'Not allowed: ' + c.reason + '.' };
        const key = fileKey(input);
        if (key && okFiles.has(key)) return { behavior: 'allow', updatedInput: input };
        const detail = input.command ? String(input.command) : (key ? 'Later changes to this same file in this job will not ask again.' : '');
        const r = await approvals.request(chatId, c.reason, detail);
        if (r.allowed && key) okFiles.add(key);
        return r.allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Fahad did not approve this (' + (r.note || 'denied') + '). Do not try to do it another way; tell him what you would need.' };
      },
      resume: sessionId || undefined,
      maxBudgetUsd: Math.min(jobCap, Math.max(0.5, usage.left())),
      abortController: abort,
      env: childEnv(process.env, Object.assign({ ANTHROPIC_API_KEY: cfg.anthropicKey }, cfg.ghToken ? { GH_TOKEN: cfg.ghToken } : {})),
      stderr: (d) => log('claude: ' + String(d).trim().slice(0, 500))
    };
  }

  async function runOnce(chatId, prompt, sessionId) {
    const abort = new AbortController();
    current = { chatId, abort, startedAt: Date.now(), activity: 'thinking', lastNote: Date.now() };
    const typing = setInterval(() => tg.typing(chatId), 5000);
    tg.typing(chatId);
    const progress = setInterval(() => {
      if (!current || Date.now() - current.lastNote < 4 * 60000) return;
      current.lastNote = Date.now();
      tg.send(chatId, '⏳ Still working — ' + current.activity + ' (' + Math.round((Date.now() - current.startedAt) / 60000) + ' min so far). Send /stop to cancel.').catch(() => null);
    }, 30000);
    let newSession = sessionId, result = null;
    try {
      for await (const m of runQuery({ prompt, options: options(chatId, sessionId, abort) })) {
        if (m.session_id) newSession = m.session_id;
        if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
          for (const b of m.message.content) {
            if (b.type === 'tool_use') {
              current.activity = describeTool(b.name, b.input);
              if (b.name === 'mcp__hq__tell_owner') current.lastNote = Date.now();
            }
          }
        }
        if (m.type === 'result') result = m;
      }
    } catch (e) {
      if (!result && !abort.signal.aborted) throw e;   // the engine also throws after an error result: the result already says why
    } finally { clearInterval(typing); clearInterval(progress); }
    return { result, sessionId: newSession, aborted: abort.signal.aborted };
  }

  async function runJob({ chatId, prompt, fresh = false }) {
    if (usage.left() <= 0) {
      return tg.send(chatId, '💸 Today\'s Claude budget ($' + usage.cap().toFixed(2) + ') is used up, so I paused. Send /budget 50 (any amount) to raise today\'s cap, or wait until tomorrow.');
    }
    jobCap = nextJobBudget || cfg.jobBudget;
    nextJobBudget = null;
    const sessions = store.read('sessions', {});
    let prev = fresh ? null : sessions[chatId];
    let out;
    try {
      out = await runOnce(chatId, prompt, prev && prev.sessionId);
    } catch (e) {
      if (prev && /session|resume|conversation/i.test(String(e && e.message))) {       // old conversation missing: start fresh once
        log('resume failed, starting fresh: ' + e.message);
        prev = null;
        out = await runOnce(chatId, prompt, null);
      } else throw e;
    }
    const r = out.result;
    const total = r ? Number(r.total_cost_usd) || 0 : 0;
    const spent = prev && prev.sessionId === out.sessionId && total >= (prev.lastTotal || 0) ? total - (prev.lastTotal || 0) : total;
    usage.addClaude(spent);
    store.update('sessions', {}, (s) => { s[chatId] = { sessionId: out.sessionId, lastTotal: total, at: new Date().toISOString() }; });
    log('job done: $' + spent.toFixed(4) + ', ' + (r ? r.subtype + ', ' + r.num_turns + ' turns' : 'no result'));

    if (out.aborted) return tg.send(chatId, '⏹ Stopped. Tell me what to do next.');
    if (!r) return tg.send(chatId, '⚠️ The job ended without an answer. Please send it again.');
    if (r.subtype === 'error_max_budget_usd') return tg.send(chatId, '💸 This job reached its spending limit ($' + Math.min(jobCap, usage.cap()).toFixed(2) + ') before finishing. Reply "continue" to let me carry on from where I stopped (or /bigjob 40 first for a bigger limit).');
    if (r.subtype === 'error_max_turns') return tg.send(chatId, '⏸ I paused after many steps. Reply "continue" and I\'ll carry on.');
    if (r.is_error || r.subtype !== 'success') return tg.send(chatId, '⚠️ I hit a problem: ' + String(r.result || r.subtype || 'unknown error').slice(0, 800) + '\nYour conversation is kept — reply to continue, or /new to start fresh.');
    const text = String(r.result || '').trim();
    return tg.send(chatId, text || '✅ Done.');
  }

  async function pump() {
    if (running || !queue.length) return;
    running = true;
    const job = queue.shift();
    try { await runJob(job); }
    catch (e) {
      log('job error: ' + (e && e.stack || e));
      await tg.send(job.chatId, '⚠️ Something went wrong: ' + String(e && e.message || e).slice(0, 500) + '\nPlease try again.').catch(() => null);
    } finally {
      current = null;
      running = false;
      setImmediate(pump);
    }
  }

  function enqueue(job) {
    queue.push(job);
    const waiting = running || queue.length > 1;
    pump();
    return waiting ? queue.length : 0;
  }

  function stop() {
    queue.length = 0;
    approvals.cancelAll();
    if (current) { current.abort.abort(); return true; }
    return false;
  }

  function newConversation(chatId) { store.update('sessions', {}, (s) => { delete s[chatId]; }); }

  const status = () => current
    ? { busy: true, activity: current.activity, minutes: Math.round((Date.now() - current.startedAt) / 60000), queued: queue.length }
    : { busy: false, queued: queue.length };

  // /bigjob 40 → the next job may spend up to $40 (still within today's cap).
  function setBigJob(usd) { nextJobBudget = usd > 0 ? usd : null; return nextJobBudget; }

  return { enqueue, stop, status, newConversation, settings, modelId, setBigJob };
}
