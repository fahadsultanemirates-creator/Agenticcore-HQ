// Lite on Gemini: the engine is pointed at the local gateway, model names are the gateway's
// aliases, quick replies use the fast model, and HQ / Outreach (no gateway) are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { makeBoss } from '../src/boss.js';
import { makeStore } from '../src/store.js';
import { makeUsage } from '../src/usage.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gem-'));
const tick = () => new Promise((r) => setTimeout(r, 20));

function run(env) {
  const cfg = readConfig(Object.assign({ HQ_WORKSPACE: tmp(), ANTHROPIC_API_KEY: 'k' }, env));
  const store = makeStore(tmp());
  const seen = [];
  const queryFn = ({ prompt, options }) => {
    seen.push(options);
    const hold = prompt === 'long';
    return (async function* () {
      if (hold) await new Promise((r) => options.abortController.signal.addEventListener('abort', r));
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ANSWERED\nok', total_cost_usd: 0, num_turns: 1, session_id: 's' };
    })();
  };
  const boss = makeBoss({ cfg, tg: { send: async () => ({}), typing: () => null }, store, usage: makeUsage(store, cfg), approvals: { request: async () => ({ allowed: false }), cancelAll() {} }, hqServer: {}, log: () => null, queryFn });
  return { boss, seen, cfg };
}

const GEMINI = { HQ_LITE: '1', HQ_ENGINE: 'gemini', ANTHROPIC_API_KEY: 'sk-gw-x', ANTHROPIC_BASE_URL: 'http://127.0.0.1:4123', HQ_MODEL: 'gemini-main', HQ_EFFORT: 'medium',
  HQ_HELPER_MODEL: 'gemini-helper', HQ_SCOUT_MODEL: 'gemini-scout', HQ_MODEL_HARD: 'gemini-hard', HQ_FAST_MODEL: 'gemini-scout' };

test('Lite on Gemini: engine goes through the gateway with the Gemini aliases', async () => {
  const { boss, seen } = run(GEMINI);
  boss.enqueue({ chatId: '1', prompt: 'x' }); await tick();
  const o = seen[0];
  assert.equal(o.model, 'gemini-main');
  assert.equal(o.effort, 'medium');
  assert.equal(o.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4123');
  assert.equal(o.env.ANTHROPIC_API_KEY, 'sk-gw-x');
  assert.equal(o.env.DISABLE_PROMPT_CACHING, '1');
  assert.equal(o.env.ANTHROPIC_SMALL_FAST_MODEL, 'gemini-scout');
  assert.equal(o.agents.scout.model, 'gemini-scout');
  assert.equal(o.agents.marketing.model, 'gemini-helper');
  assert.match(o.systemPrompt.append, /Gemini edition/);
  assert.equal(boss.modelId('fable'), 'gemini-hard');
  assert.equal(boss.modelId('haiku'), 'gemini-scout');
});

test('Lite on Gemini: quick replies while busy use the fast Gemini model through the gateway', async () => {
  const { boss, seen } = run(GEMINI);
  boss.enqueue({ chatId: '1', prompt: 'long' }); await tick();
  await boss.quickReply('1', 'what are you doing?');
  const q = seen.find((o) => Array.isArray(o.tools) && o.tools.length === 0);
  assert.equal(q.model, 'gemini-scout');
  assert.equal(q.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:4123');
  boss.stop();
});

test('HQ and Outreach without a gateway are unchanged (Claude, no base URL, no Gemini prompt)', async () => {
  for (const env of [{}, { HQ_LITE: '1', HQ_OUTREACH: '1' }]) {
    const { boss, seen } = run(env);
    boss.enqueue({ chatId: '1', prompt: 'x' }); await tick();
    assert.equal(seen[0].env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(seen[0].env.DISABLE_PROMPT_CACHING, undefined);
    assert.ok(!/Gemini edition/.test(seen[0].systemPrompt.append));
    assert.match(boss.modelId('haiku'), /^claude-haiku/);
  }
});

test('switching engines starts a fresh conversation instead of resuming the other engine\'s one', async () => {
  const dataDir = tmp();
  const ws = tmp();
  const sessionFor = async (env) => {
    const cfg = readConfig(Object.assign({ HQ_WORKSPACE: ws, ANTHROPIC_API_KEY: 'k' }, env));
    const store = makeStore(dataDir);
    const seen = [];
    const queryFn = ({ options }) => { seen.push(options); return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, num_turns: 1, session_id: 's-' + cfg.engine }; })(); };
    const boss = makeBoss({ cfg, tg: { send: async () => ({}), typing: () => null }, store, usage: makeUsage(store, cfg), approvals: { request: async () => ({ allowed: true }), cancelAll() {} }, hqServer: {}, log: () => null, queryFn });
    boss.enqueue({ chatId: '1', prompt: 'x' }); await tick();
    return seen[0].resume;
  };
  assert.equal(await sessionFor({ HQ_LITE: '1' }), undefined);          // first Claude job: new conversation
  assert.equal(await sessionFor({ HQ_LITE: '1' }), 's-claude');         // next Claude job continues it
  assert.equal(await sessionFor(GEMINI), undefined);                    // switched to Gemini: fresh
  assert.equal(await sessionFor(GEMINI), 's-gemini');                   // Gemini continues its own
  assert.equal(await sessionFor({ HQ_LITE: '1' }), undefined);          // back to Claude: fresh again
});

test('/key switches every Gemini model (manager, helpers, scout, quick model) to the named key', async () => {
  const { boss, seen, cfg } = run(Object.assign({}, GEMINI, { GEMINI_KEY_FREE: 'k1', GEMINI_KEY_PAID: 'k2', GEMINI_KEY_EMPTY: '' }));
  assert.deepEqual(cfg.geminiKeys, ['free', 'paid']);            // empty lines are ignored
  assert.equal(boss.keyName(), '');                               // default key first
  boss.setKey('free');
  assert.equal(boss.keyName(), 'free');
  boss.enqueue({ chatId: '1', prompt: 'x' }); await tick();
  const o = seen.at(-1);
  assert.equal(o.model, 'gemini-main-free');
  assert.equal(o.agents.scout.model, 'gemini-scout-free');
  assert.equal(o.agents.marketing.model, 'gemini-helper-free');
  assert.equal(o.env.ANTHROPIC_SMALL_FAST_MODEL, 'gemini-scout-free');
  assert.equal(boss.modelId('fable'), 'gemini-hard-free');
  boss.setKey('');                                                // back to the default key
  assert.equal(boss.modelId('main'), 'gemini-main');
  boss.setKey('nope');                                            // unknown names never reach the models
  assert.equal(boss.modelId('main'), 'gemini-main');
});

test('/key has no effect on Claude bots', async () => {
  const { boss } = run({ HQ_LITE: '1', GEMINI_KEY_FREE: 'k1' });
  boss.setKey('free');
  assert.equal(boss.keyName(), '');
  assert.match(boss.modelId('main'), /^claude-/);
});
