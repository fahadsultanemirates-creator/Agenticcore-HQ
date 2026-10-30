// The boss: every Telegram request becomes a job run by the Claude Agent SDK
// (the Claude Code engine) with full tools, Fahad's rules, the hq tools and the
// specialist sub-agents. One conversation per chat continues across messages
// (/new starts fresh). Jobs run one at a time; new messages wait in a queue.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { HQ_PROMPT, LITE_PROMPT, OUTREACH_PROMPT, GEMINI_PROMPT, SPECIALISTS, SCOUT, SCOUT_OUTREACH } from './prompt.js';
import { classify, childEnv } from './guard.js';

// "main" = the model set for this bot (HQ: Opus 5.5, Lite: Sonnet 5.5); the others are fixed models.
export const MODEL_ALIASES = { main: 'model', opus: 'claude-opus-5-5', fable: 'modelHard', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };

// What the approval message shows, so Fahad can see what he is allowing.
export function describeForApproval(input = {}, fileKey = '') {
  if (input.command) return String(input.command);
  if (input.code) return 'Code:\n' + String(input.code).slice(0, 1200);
  if (input.query) return 'SQL:\n' + String(input.query).slice(0, 1200);
  if (input.element) return 'On the page: ' + String(input.element) + (input.text ? '\nText: ' + String(input.text).slice(0, 600) : '');
  if (fileKey) return 'Later changes to this same file in this job will not ask again.';
  const shown = JSON.stringify(input);
  return shown && shown !== '{}' ? shown.slice(0, 800) : '';
}

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
  const systemAppend = HQ_PROMPT.replace('# You are AgenticCore HQ', '# You are ' + cfg.name)
    + (cfg.lite ? '\n\n' + LITE_PROMPT : '') + (cfg.outreach ? '\n\n' + OUTREACH_PROMPT.replace('{accounts}', cfg.outreachAccounts.join(', ') || '(none set yet)').replace('{cap}', String(cfg.outreachEmailCap)) : '') + (cfg.engine === 'gemini' ? '\n\n' + GEMINI_PROMPT : '') + (deps.accountsNote ? '\n\n' + deps.accountsNote : '');
  const servers = ['hq'].concat(Object.keys(external));
  function specialists() {
    const out = {};
    for (const [k, a] of Object.entries(SPECIALISTS)) out[k] = Object.assign({}, a, { model: cfg.helperModel, effort: cfg.helperEffort || a.effort, mcpServers: servers });
    if (cfg.lite) out.scout = Object.assign({}, SCOUT, { prompt: SCOUT.prompt + (cfg.outreach ? SCOUT_OUTREACH : ''), model: cfg.scoutModel, effort: cfg.scoutEffort, mcpServers: servers });
    return out;
  }

  const settings = () => store.read('settings', { model: 'main', effort: cfg.effort });
  function modelId(alias) {
    if (alias === 'haiku' && cfg.fastModel) return cfg.fastModel;   // Gemini edition: the gateway's quick model
    const k = MODEL_ALIASES[alias] || MODEL_ALIASES.main; return cfg[k] || k;
  }
  // Engine environment: the API key, plus the local Gemini gateway when one is set.
  function engineEnv(extra = {}) {
    const gw = cfg.baseUrl ? { ANTHROPIC_BASE_URL: cfg.baseUrl, DISABLE_PROMPT_CACHING: '1', ANTHROPIC_DEFAULT_HAIKU_MODEL: cfg.fastModel || cfg.scoutModel, ANTHROPIC_SMALL_FAST_MODEL: cfg.fastModel || cfg.scoutModel } : {};
    return childEnv(process.env, Object.assign({ ANTHROPIC_API_KEY: cfg.anthropicKey }, gw, extra));
  }

  function options(chatId, sessionId, abort) {
    const s = settings();
    const okFiles = new Set();   // files Fahad allowed in this job: later edits of the same file do not ask again
    let browserAll = false;      // Fahad tapped "Allow all (this job)": the job's remaining browser clicks don't ask
    const fileKey = (input) => (input.file_path ? String(input.file_path).replace(/\//g, '\\').toLowerCase() : '');
    return {
      model: modelId(s.model),
      fallbackModel: modelId(s.model) === cfg.model ? undefined : cfg.model,
      effort: s.effort || cfg.effort,
      thinking: { type: 'adaptive' },
      cwd: cfg.workspace,
      settingSources: ['project'],                       // loads workspace/CLAUDE.md (+ memory/notes.md)
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend },
      mcpServers: Object.assign({ hq: deps.hqServer }, external),
      agents: specialists(),
      permissionMode: 'default',
      canUseTool: async (toolName, input, opts = {}) => {
        if (cfg.managerNoBrowser && !opts.agentID && toolName.startsWith('mcp__browser__')) {
          return { behavior: 'deny', message: 'You do not use the browser yourself: hand this browsing to the scout helper (Task tool, subagent "scout") with exact instructions and what to bring back.' };
        }
        // An email Fahad approved in a batch and the bot reserved with outreach_reserve_send: one Send click is allowed.
        if (deps.outreach && toolName === 'mcp__browser__browser_click' && /\bsend\b/i.test(String(input.element || '')) && deps.outreach.spendSendToken()) {
          return { behavior: 'allow', updatedInput: input };
        }
        const c = classify(toolName, input, { workspace: cfg.workspace, blocked: deps.blockedIds ? deps.blockedIds() : [] });
        if (c.decision === 'allow') return { behavior: 'allow', updatedInput: input };
        if (c.decision === 'deny') return { behavior: 'deny', message: 'Not allowed: ' + c.reason + '.' };
        const key = fileKey(input);
        if (key && okFiles.has(key)) return { behavior: 'allow', updatedInput: input };
        const browserStep = toolName.startsWith('mcp__browser__') && toolName !== 'mcp__browser__browser_run_code_unsafe';
        if (browserStep && browserAll) return { behavior: 'allow', updatedInput: input };
        const detail = describeForApproval(input, key);
        const r = await approvals.request(chatId, c.reason, detail, { allowAll: browserStep });
        if (r.allowed && key) okFiles.add(key);
        if (r.allowed && r.all && browserStep) browserAll = true;
        return r.allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Fahad did not approve this (' + (r.note || 'denied') + '). Do not try to do it another way; tell him what you would need.' };
      },
      resume: sessionId || undefined,
      maxBudgetUsd: Math.min(jobCap, Math.max(0.5, usage.left())),
      abortController: abort,
      env: engineEnv(cfg.ghToken ? { GH_TOKEN: cfg.ghToken } : {}),
      stderr: (d) => log('claude: ' + String(d).trim().slice(0, 500))
    };
  }

  async function runOnce(chatId, prompt, sessionId) {
    const abort = new AbortController();
    current = { chatId, abort, prompt, startedAt: Date.now(), activity: 'thinking', lastNote: Date.now() };
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

    if (out.aborted) return tg.send(chatId, queue.length && queue[0].chatId === chatId ? '⏹ Stopped that job — starting on your new message now (the earlier job\'s progress is kept in this conversation; say "continue the earlier job" later).' : '⏹ Stopped. Tell me what to do next.');
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

  // Fahad wrote while a job is running: "stop and …" / "urgent …" stops the job and runs his message
  // first; anything else gets a quick answer from a small model at once (no tools), which says
  // whether the message is a new task (queued after the current job) or already answered.
  const URGENT = /^\s*(stop( it)?( and| now|,)|urgent\b|now:|abhi\b|pehle\b|first:)/i;
  function interrupt(job) {
    queue.unshift(job);
    approvals.cancelAll();
    if (current) current.abort.abort();
    else pump();
  }
  async function quickReply(chatId, text) {
    if (!current) return { action: 'queued', position: enqueue({ chatId, prompt: text }) };
    if (URGENT.test(text)) { interrupt({ chatId, prompt: text }); return { action: 'now' }; }
    const job = current;
    const sys = 'You are the quick-reply line of ' + cfg.name + ', Fahad\'s AI team on Telegram. The main team is busy with a job and cannot be interrupted, so you answer his message right away, briefly (1-4 short lines, his language). '
      + 'You have no tools and cannot do work yourself. Never invent facts or results.\n'
      + 'The running job (started ' + Math.round((Date.now() - job.startedAt) / 60000) + ' min ago) was asked: "' + String(job.prompt).slice(0, 600) + '"\nRight now it is: ' + job.activity + '. Jobs waiting after it: ' + queue.length + '.\n'
      + 'Start your answer with exactly one tag on its own first line:\n'
      + 'TASK - his message asks for work, a change, or something you cannot answer from this information: say it will start right after the current job, and that he can reply "stop and do it now" to switch.\n'
      + 'NOW - he clearly wants the current job stopped or his new message done first.\n'
      + 'ANSWERED - a question you fully answered (e.g. what the team is doing, how long, a simple fact or greeting).';
    let out = '', spent = 0;
    try {
      for await (const m of runQuery({ prompt: text, options: {
        model: modelId('haiku'), effort: 'low', systemPrompt: sys, tools: [], mcpServers: {}, settingSources: [], maxTurns: 1, cwd: cfg.workspace,
        maxBudgetUsd: 0.1, canUseTool: async () => ({ behavior: 'deny', message: 'no tools in quick replies' }),
        env: engineEnv()
      } })) {
        if (m.type === 'result') { out = String(m.result || ''); spent = Number(m.total_cost_usd) || 0; }
      }
    } catch (e) { log('quick reply: ' + (e && e.message || e)); }
    usage.addClaude(spent);
    const tag = (/^\s*(TASK|NOW|ANSWERED)\b/i.exec(out) || [])[1];
    const body = out.replace(/^\s*(TASK|NOW|ANSWERED)\b[:\s-]*/i, '').trim();
    if (tag && tag.toUpperCase() === 'NOW') { interrupt({ chatId, prompt: text }); return { action: 'now', text: body }; }
    if (tag && tag.toUpperCase() === 'ANSWERED' && body) { await tg.send(chatId, '💬 ' + body); return { action: 'answered', text: body }; }
    const position = enqueue({ chatId, prompt: text });
    await tg.send(chatId, '💬 ' + (body || 'Got it.') + '\n📝 Queued (' + position + ' waiting) — reply "stop and do it now" to switch, /stop to cancel the current job.');
    return { action: 'queued', position, text: body };
  }

  function newConversation(chatId) { store.update('sessions', {}, (s) => { delete s[chatId]; }); }

  const status = () => current
    ? { busy: true, activity: current.activity, minutes: Math.round((Date.now() - current.startedAt) / 60000), queued: queue.length }
    : { busy: false, queued: queue.length };

  // /bigjob 40 → the next job may spend up to $40 (still within today's cap).
  function setBigJob(usd) { nextJobBudget = usd > 0 ? usd : null; return nextJobBudget; }

  return { enqueue, stop, status, newConversation, settings, modelId, setBigJob, quickReply, interrupt };
}
