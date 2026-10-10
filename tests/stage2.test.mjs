// Stage 2: browser / Netlify / Supabase servers, their safety rules,
// request_approval and /bigjob — no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { classify } from '../src/guard.js';
import { externalServers, accountsNote } from '../src/mcp.js';
import { makeBoss } from '../src/boss.js';
import { hqTools } from '../src/tools.js';
import { makeStore } from '../src/store.js';
import { makeUsage } from '../src/usage.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hq2-'));
const tick = () => new Promise((r) => setTimeout(r, 20));
const ws = { workspace: '/w' };
const env = { HQ_WORKSPACE: '/w', NETLIFY_TOKEN: 'nfp_secret', SUPABASE_TOKEN_1: 'sbp_one', SUPABASE_LABEL_1: 'Estate + PK', SUPABASE_TOKEN_3: 'sbp_three' };

test('config: Netlify, numbered Supabase accounts with labels, browser on by default', () => {
  const c = readConfig(env);
  assert.equal(c.netlifyToken, 'nfp_secret');
  assert.deepEqual(c.supabase.map((a) => [a.n, a.label]), [[1, 'Estate + PK'], [3, '']]);
  assert.equal(c.browserCdp, 'http://127.0.0.1:9222');
  assert.equal(readConfig({ HQ_BROWSER_CDP: 'off' }).browserCdp, '');
});

test('servers: each token goes only to its own server; the boss is told labels, never tokens', () => {
  const cfg = readConfig(env);
  const s = externalServers(cfg, (pkg) => '/bin/' + pkg);
  assert.deepEqual(Object.keys(s), ['browser', 'netlify', 'supabase1', 'supabase3']);
  assert.ok(s.browser.args.includes('--cdp-endpoint'));
  assert.equal(s.netlify.env.NETLIFY_PERSONAL_ACCESS_TOKEN, 'nfp_secret');
  assert.equal(s.supabase1.env.SUPABASE_ACCESS_TOKEN, 'sbp_one');
  assert.equal(s.supabase3.env.SUPABASE_ACCESS_TOKEN, 'sbp_three');
  assert.ok(!JSON.stringify(s.browser).includes('sbp_') && !JSON.stringify(s.supabase1).includes('nfp_'));
  const note = accountsNote(cfg);
  assert.match(note, /Supabase account 1 .*Estate \+ PK/);
  assert.ok(!/nfp_|sbp_/.test(note));
  assert.deepEqual(Object.keys(externalServers(readConfig({ HQ_BROWSER_CDP: 'off' }), () => 'x')), []);
});

test('guard: browser reading is free; publishing clicks, sending and custom code ask; closing is refused', () => {
  const c = (t, i) => classify('mcp__browser__' + t, i, ws).decision;
  assert.equal(c('browser_navigate', { url: 'https://facebook.com/groups' }), 'allow');
  assert.equal(c('browser_snapshot', {}), 'allow');
  assert.equal(c('browser_click', { element: 'See more link' }), 'allow');
  assert.equal(c('browser_click', { element: 'Posts tab' }), 'allow');
  assert.equal(c('browser_click', { element: 'Post button' }), 'ask');
  assert.equal(c('browser_click', { element: 'Schedule post' }), 'ask');
  assert.equal(c('browser_click', { element: 'Send' }), 'ask');
  assert.equal(c('browser_type', { element: 'Search Facebook', text: 'plots DHA', submit: true }), 'allow');
  assert.equal(c('browser_type', { element: 'Write a comment', text: 'Nice', submit: true }), 'ask');
  assert.equal(c('browser_run_code_unsafe', { code: 'x' }), 'ask');
  assert.equal(c('browser_close', {}), 'deny');
});

test('guard: Netlify and Supabase read freely, changes ask; read-only SQL passes, writing SQL asks', () => {
  assert.equal(classify('mcp__netlify__netlify-project-services-reader', {}, ws).decision, 'allow');
  assert.equal(classify('mcp__netlify__netlify-deploy-services-updater', {}, ws).decision, 'ask');
  assert.equal(classify('mcp__supabase1__list_tables', {}, ws).decision, 'allow');
  assert.equal(classify('mcp__supabase2__get_advisors', {}, ws).decision, 'allow');
  for (const t of ['apply_migration', 'create_project', 'deploy_edge_function', 'pause_project', 'merge_branch']) {
    assert.equal(classify('mcp__supabase1__' + t, {}, ws).decision, 'ask', t);
  }
  const sql = (q) => classify('mcp__supabase1__execute_sql', { query: q }, ws).decision;
  assert.equal(sql('select count(*) from listings where city = \'Lahore\''), 'allow');
  assert.equal(sql('select * from pg_policies'), 'allow');
  assert.equal(sql('delete from listings'), 'ask');
  assert.equal(sql('with x as (delete from listings returning id) select count(*) from x'), 'ask');
  assert.equal(sql('select public.wipe_everything()'), 'ask');
  assert.equal(sql('update profiles set role = \'admin\''), 'ask');
});

test('guard: the Agenticcore-token project is refused everywhere; unknown outside tools ask', () => {
  assert.equal(classify('Bash', { command: 'gh repo clone fahadsultanemirates-creator/Agenticcore-token' }, ws).decision, 'deny');
  assert.equal(classify('mcp__browser__browser_navigate', { url: 'https://github.com/x/agenticcore-token' }, ws).decision, 'deny');
  assert.equal(classify('mcp__somethingelse__do', {}, ws).decision, 'ask');
});

function bossSetup(extra = {}) {
  const cfg = Object.assign(readConfig({ HQ_WORKSPACE: tmp(), ANTHROPIC_API_KEY: 'k' }), { dailyBudget: 100 });
  const store = makeStore(tmp());
  const usage = makeUsage(store, cfg);
  const seen = [];
  const sent = [];
  const tg = { send: async (c, t) => { sent.push(t); return { message_id: 1 }; }, typing: () => null };
  const queryFn = ({ options }) => { seen.push(options); return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's' };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, num_turns: 1, session_id: 's' };
  })(); };
  const boss = makeBoss(Object.assign({ cfg, tg, store, usage, approvals: { request: async () => ({ allowed: true }), cancelAll() {} }, hqServer: { hq: 1 }, log: () => null, queryFn }, extra));
  return { boss, seen, sent, cfg };
}

test('boss: outside servers are loaded for the boss and every specialist; the accounts note is in its instructions', async () => {
  const { boss, seen } = bossSetup({ externalServers: { browser: { command: 'node' }, supabase1: { command: 'node' } }, accountsNote: '## Your connected accounts\n- Supabase account 1: Estate' });
  boss.enqueue({ chatId: '1', prompt: 'x' }); await tick();
  assert.deepEqual(Object.keys(seen[0].mcpServers), ['hq', 'browser', 'supabase1']);
  for (const a of Object.values(seen[0].agents)) assert.deepEqual(a.mcpServers, ['hq', 'browser', 'supabase1']);
  assert.match(seen[0].systemPrompt.append, /Supabase account 1: Estate/);
  assert.match(seen[0].systemPrompt.append, /Message yourself/);
});

test('/bigjob raises the spending limit for the next job only', async () => {
  const { boss, seen, cfg } = bossSetup();
  boss.setBigJob(40);
  boss.enqueue({ chatId: '1', prompt: 'campaign' }); await tick();
  boss.enqueue({ chatId: '1', prompt: 'small thing' }); await tick();
  assert.equal(seen[0].maxBudgetUsd, 40);
  assert.equal(seen[1].maxBudgetUsd, cfg.jobBudget);
});

test('request_approval asks Fahad and reports his answer', async () => {
  const asked = [];
  let answer = true;
  const tools = hqTools({
    cfg: readConfig({ HQ_WORKSPACE: tmp() }), tg: {}, providers: {}, usage: {}, scheduler: {}, chatId: () => '9',
    approvals: { request: async (chat, what, details) => { asked.push([chat, what, details]); return { allowed: answer, note: answer ? undefined : 'denied' }; } }
  });
  const t = tools.find((x) => x.name === 'request_approval');
  let r = await t.handler({ what: 'Publish this post on the Estate Facebook page', details: 'Text: Khwabon se ghar tak' });
  assert.match(r.content[0].text, /APPROVED/);
  answer = false;
  r = await t.handler({ what: 'Message a group admin' });
  assert.match(r.content[0].text, /NOT approved/);
  assert.deepEqual(asked[0], ['9', 'Publish this post on the Estate Facebook page', 'Text: Khwabon se ghar tak']);
});
