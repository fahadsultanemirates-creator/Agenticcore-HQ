// The boss with a fake Claude engine: replies always arrive, conversations
// continue, cost is counted once, approvals gate risky tools, budget stops.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { makeStore } from '../src/store.js';
import { makeUsage } from '../src/usage.js';
import { makeBoss, describeTool } from '../src/boss.js';
import { hqTools } from '../src/tools.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hq-'));
const tick = () => new Promise((r) => setTimeout(r, 20));

function setup({ results, onOptions, approve = true, budget = 30 } = {}) {
  const ws = tmp();
  const cfg = Object.assign(readConfig({ HQ_WORKSPACE: ws, ANTHROPIC_API_KEY: 'k' }), { dailyBudget: budget });
  const store = makeStore(tmp());
  const usage = makeUsage(store, cfg);
  const sent = [];
  const tg = { send: async (chat, text) => { sent.push(text); return { message_id: 1 }; }, typing: () => null };
  const approvals = { asked: 0, request: async () => { approvals.asked++; return { allowed: approve }; }, cancelAll: () => null };
  let i = 0;
  const queryFn = ({ prompt, options }) => {
    if (onOptions) onOptions(options, prompt);
    const r = results[Math.min(i++, results.length - 1)];
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: r.session || 's1' };
      yield { type: 'assistant', session_id: r.session || 's1', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a/b.js' } }] } };
      yield Object.assign({ type: 'result', subtype: 'success', is_error: false, num_turns: 3, session_id: r.session || 's1' }, r);
    })();
  };
  const boss = makeBoss({ cfg, tg, store, usage, approvals, hqServer: {}, log: () => null, queryFn });
  setup.lastApprovals = approvals;
  return { boss, sent, store, usage, cfg };
}

test('a reply always comes back, and the conversation continues on the next message', async () => {
  const seen = [];
  const { boss, sent, store } = setup({ results: [{ result: 'Hello Fahad', total_cost_usd: 0.4 }, { result: '', total_cost_usd: 1.0 }], onOptions: (o) => seen.push(o) });
  boss.enqueue({ chatId: '7', prompt: 'hi' }); await tick();
  boss.enqueue({ chatId: '7', prompt: 'and?' }); await tick();
  assert.deepEqual(sent, ['Hello Fahad', '✅ Done.']);
  assert.equal(seen[0].resume, undefined);
  assert.equal(seen[1].resume, 's1');
  assert.equal(store.read('usage', {}).days[Object.keys(store.read('usage', {}).days)[0]].claude, 1.0); // 0.4 + (1.0 - 0.4)
});

test('Claude runs as the strongest setup: Opus 5.5, max effort, Claude Code tools + HQ rules + specialists', async () => {
  let opts;
  const { boss } = setup({ results: [{ result: 'ok', total_cost_usd: 0 }], onOptions: (o) => (opts = o) });
  boss.enqueue({ chatId: '7', prompt: 'x' }); await tick();
  assert.equal(opts.model, 'claude-opus-5-5');
  assert.equal(opts.effort, 'max');
  assert.equal(opts.systemPrompt.preset, 'claude_code');
  assert.match(opts.systemPrompt.append, /ASK one short, specific question/);
  assert.deepEqual(Object.keys(opts.agents).sort(), ['creative', 'developer', 'marketing', 'researcher']);
  assert.deepEqual(opts.settingSources, ['project']);
  assert.ok(opts.env.ANTHROPIC_API_KEY && !opts.env.OPENAI_API_KEY);
});

test('risky tools wait for approval; denied ones are refused; keys are never readable', async () => {
  let opts;
  const { boss } = setup({ results: [{ result: 'ok' }], approve: false, onOptions: (o) => (opts = o) });
  boss.enqueue({ chatId: '7', prompt: 'x' }); await tick();
  assert.equal((await opts.canUseTool('Bash', { command: 'npm test' })).behavior, 'allow');
  const push = await opts.canUseTool('Bash', { command: 'git push origin main' });
  assert.equal(push.behavior, 'deny'); assert.match(push.message, /did not approve/);
  assert.equal((await opts.canUseTool('Read', { file_path: 'C:\\AgenticCoreHQ\\.env' })).behavior, 'deny');
});

test('an allowed file outside the workspace does not ask again in the same job', async () => {
  let opts;
  const { boss } = setup({ results: [{ result: 'ok' }], onOptions: (o) => (opts = o) });
  const approvals = setup.lastApprovals;
  boss.enqueue({ chatId: '7', prompt: 'x' }); await tick();
  assert.equal((await opts.canUseTool('Write', { file_path: '/elsewhere/tmp/make-post.ps1', content: 'a' })).behavior, 'allow');
  assert.equal(approvals.asked, 1);
  assert.equal((await opts.canUseTool('Edit', { file_path: '\\elsewhere\\tmp\\make-post.ps1', old_string: 'a', new_string: 'b' })).behavior, 'allow');
  assert.equal(approvals.asked, 1);   // same file: not asked again
  await opts.canUseTool('Write', { file_path: '/elsewhere/other.txt', content: 'c' });
  assert.equal(approvals.asked, 2);   // a different file still asks
});

test('budget: a used-up day stops before running; a job that hits its limit says how to continue', async () => {
  const a = setup({ results: [{ result: 'x' }], budget: 1 });
  a.usage.addClaude(1);
  a.boss.enqueue({ chatId: '7', prompt: 'x' }); await tick();
  assert.match(a.sent[0], /budget .* is used up/);
  const b = setup({ results: [{ subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 8 }] });
  b.boss.enqueue({ chatId: '7', prompt: 'big job' }); await tick();
  assert.match(b.sent[0], /spending limit .* "continue"/);
});

test('errors are reported, never silent; /new starts a fresh conversation', async () => {
  const { boss, sent, store } = setup({ results: [{ subtype: 'error_during_execution', is_error: true, result: 'tool crashed' }] });
  boss.enqueue({ chatId: '7', prompt: 'x' }); await tick();
  assert.match(sent[0], /I hit a problem: tool crashed/);
  boss.newConversation('7');
  assert.equal(store.read('sessions', {})['7'], undefined);
});

test('an engine error after the result keeps the clear message (e.g. a wrong API key)', async () => {
  const ws = tmp();
  const cfg = readConfig({ HQ_WORKSPACE: ws, ANTHROPIC_API_KEY: 'k' });
  const store = makeStore(tmp());
  const sent = [];
  const tg = { send: async (c, t) => { sent.push(t); return {}; }, typing: () => null };
  const queryFn = () => (async function* () {
    yield { type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Fix external API key', session_id: 's' };
    throw new Error('Claude Code returned an error result');
  })();
  const boss = makeBoss({ cfg, tg, store, usage: makeUsage(store, cfg), approvals: { cancelAll() {} }, hqServer: {}, log: () => null, queryFn });
  boss.enqueue({ chatId: '7', prompt: 'x' }); await tick();
  assert.match(sent[0], /I hit a problem: Invalid API key/);
});

test('progress descriptions are readable', () => {
  assert.equal(describeTool('mcp__hq__ask_gemini', {}), 'researching with Gemini');
  assert.equal(describeTool('Bash', { command: 'npm test\nmore' }), 'running a script');
  assert.equal(describeTool('Bash', { command: 'curl -A "Mozilla/5.0" https://zameen.com', description: 'Check a source page' }), 'Check a source page');
  assert.equal(describeTool('PowerShell', { command: '$UA="Mozilla/5.0"; Invoke-WebRequest https://x.pk -UserAgent $UA' }), 'reading a web page');
  assert.equal(describeTool('Task', { subagent_type: 'researcher', description: 'DHA price trends' }), 'researcher: DHA price trends');
});

test('hq tools: voice in the right language, files only from the workspace, no secrets in memory', async () => {
  const ws = tmp();
  const cfg = readConfig({ HQ_WORKSPACE: ws });
  const files = [], spoken = [];
  const tg = { send: async () => null, sendFile: async (chat, f, o) => files.push({ f, o }) };
  const providers = { xai: { name: 'xai', configured: true, speak: async (a) => { spoken.push(a); return Buffer.from('mp3'); } }, openai: { name: 'openai', configured: false }, gemini: { name: 'gemini', configured: false } };
  const usage = { addCall: () => null, report: () => 'r' };
  const tools = Object.fromEntries(hqTools({ cfg, tg, providers, usage, scheduler: {}, chatId: () => '7' }).map((t) => [t.name, t]));
  await tools.speak.handler({ text: 'السلام علیکم', language: 'ur' });
  assert.deepEqual(spoken[0], { text: 'السلام علیکم', lang: 'ur' });
  assert.equal(files[0].o.kind, 'voice');
  const bad = await tools.send_file.handler({ path: '../.env' });
  assert.equal(bad.isError, true);
  const off = await tools.ask_gpt.handler({ prompt: 'x' });
  assert.match(off.content[0].text, /openai is not set up/);
  const secret = await tools.remember.handler({ note: 'my key is sk-ant-abc123' });
  assert.equal(secret.isError, true);
  await tools.remember.handler({ note: 'Prefers Roman Urdu replies' });
  assert.match(fs.readFileSync(path.join(ws, 'memory', 'notes.md'), 'utf8'), /Prefers Roman Urdu replies/);
});
