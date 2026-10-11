// Outreach edition: the plan's rules enforced in code (quality gates, suppression,
// approved-only email with per-account caps), the report numbers, and the wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeOutreach, parseCsv, toCsv, nextDubai, OUTREACH_JOBS } from '../src/outreach.js';
import { readConfig } from '../src/config.js';
import { makeBoss } from '../src/boss.js';
import { makeStore } from '../src/store.js';
import { makeUsage } from '../src/usage.js';
import { hqTools } from '../src/tools.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
const clock = (iso) => () => new Date(iso);
const lead = (o) => Object.assign({ company_name: 'Glow Salon', country: 'AE', region: 'GCC', website: 'https://glowsalon.ae', source_url: 'https://maps.google.com/x', personalization_hook: 'No website on your Maps listing', brand_fit: 'click' }, o);

test('CSV round trip keeps commas, quotes and new lines', () => {
  const rows = [{ a: 'x, y', b: 'he said "hi"', c: 'line1\nline2' }];
  assert.deepEqual(parseCsv(toCsv(['a', 'b', 'c'], rows)), rows);
});

test('quality gates: Pakistan real estate, no evidence, no hook, duplicates, own PK sites', () => {
  const o = makeOutreach({ dir: tmp(), now: clock('2026-10-12T05:00:00Z') });
  const r = o.addLeads([
    lead({}),
    lead({ company_name: 'Lahore Homes', country: 'PK', industry: 'Real estate agency', website: 'https://lh.pk' }),
    lead({ company_name: 'No Source', website: 'https://ns.com', source_url: '' }),
    lead({ company_name: 'No Hook', website: 'https://nh.com', personalization_hook: '' }),
    lead({ company_name: 'Glow Salon again', website: 'https://www.glowsalon.ae/contact' }),
    lead({ company_name: 'Karachi Dev Shop', country: 'PK', industry: 'software', website: 'https://kds.pk' }),
    lead({ company_name: 'Mentions', website: 'https://m.com', notes: 'like agenticcore.estate' })
  ]);
  assert.equal(r.added.length, 2);   // Glow Salon + a Pakistan non-real-estate business
  assert.deepEqual(r.rejected.map((x) => x.reason), ['Pakistan real estate is out of scope', 'no evidence (source_url)', 'no personal hook', 'already in the list', 'mentions agenticcore.estate / agenticcorepk.com']);
  assert.match(r.added[0], /^20261012-AE-0001$/);
});

test('leads without a website ("none") are not duplicates of each other', () => {
  const o = makeOutreach({ dir: tmp() });
  const r = o.addLeads([lead({ company_name: 'Salon A', website: 'none' }), lead({ company_name: 'Salon B', website: 'none' }), lead({ company_name: 'Salon C', website: 'N/A' })]);
  assert.equal(r.added.length, 3);
});

test('emails: personal addresses dropped in strict regions, no email without its source', () => {
  const o = makeOutreach({ dir: tmp() });
  o.addLeads([
    lead({ company_name: 'UK Plumber', website: 'https://ukp.co.uk', business_email: 'john@gmail.com', email_source_url: 'https://ukp.co.uk/contact', strict_region_flag: 'Y' }),
    lead({ company_name: 'US Coach', website: 'https://usc.com', business_email: 'hello@usc.com' }),
    lead({ company_name: 'Good Co', website: 'https://good.com', business_email: 'hello@good.com', email_source_url: 'https://good.com/contact' })
  ]);
  const byName = Object.fromEntries(o.listLeads().map((l) => [l.company_name, l.business_email]));
  assert.deepEqual(byName, { 'UK Plumber': '', 'US Coach': '', 'Good Co': 'hello@good.com' });
});

test('suppression: opt-out and bounce lists block re-adding and mark the lead', () => {
  const o = makeOutreach({ dir: tmp() });
  const [id] = o.addLeads([lead({ business_email: 'hi@glowsalon.ae', email_source_url: 'https://glowsalon.ae' })]).added;
  o.logTouch({ lead_id: id, channel: 'email', outcome: 'opted-out' });
  assert.equal(o.listLeads()[0].do_not_contact, 'Y');
  assert.equal(o.listLeads()[0].status, 'opted-out');
  const again = makeOutreach({ dir: o.dir }).addLeads([lead({ company_name: 'Other name', website: 'https://glowsalon.ae/about' })]);
  assert.equal(again.rejected[0].reason, 'on the suppression list');
});

test('email: only approved emails, one Send click per reserved email, per-account daily cap', () => {
  const o = makeOutreach({ dir: tmp(), accounts: ['a@gmail.com', 'b@gmail.com'], emailCapPerAccount: 1 });
  const ids = o.addLeads([1, 2, 3].map((n) => lead({ company_name: 'Co' + n, website: 'https://co' + n + '.com', business_email: 'hi@co' + n + '.com', email_source_url: 'https://co' + n + '.com' }))).added;
  assert.throws(() => o.reserveSend(ids[0]), /not in a batch Fahad approved/);
  assert.equal(o.spendSendToken(), false);                       // no Send click without a reservation
  o.approveBatch(ids.map((lead_id) => ({ lead_id, subject: 'Quick idea', body: 'Hi there, a short note. Not relevant? Reply no.' })));
  const r1 = o.reserveSend(ids[0]);
  assert.equal(r1.to, 'hi@co1.com');
  assert.equal(o.spendSendToken(), true);
  assert.equal(o.spendSendToken(), false);                       // exactly one click per reserved email
  o.logTouch({ lead_id: ids[0], channel: 'email', account_used: r1.account, outcome: 'sent' });
  const r2 = o.reserveSend(ids[1]);
  assert.notEqual(r2.account, r1.account);                       // the other account still has room
  o.logTouch({ lead_id: ids[1], channel: 'email', account_used: r2.account, outcome: 'sent' });
  assert.throws(() => o.reserveSend(ids[2]), /reached today's limit/);
  assert.throws(() => o.reserveSend(ids[0]), /not in a batch/);  // can't send the same approval twice
  // the approval survives a restart
  const o2 = makeOutreach({ dir: o.dir, accounts: ['c@gmail.com'], emailCapPerAccount: 5 });
  assert.equal(o2.pendingApproved().length, 1);
});

test('report numbers come from the sheets: by channel, template, brand, ideas', () => {
  const o = makeOutreach({ dir: tmp(), now: clock('2026-10-12T06:00:00Z') });
  const [a, b] = o.addLeads([lead({}), lead({ company_name: 'Bolt Gym', website: 'https://bolt.ae', brand_fit: 'agency' })]).added;
  o.logTouch({ lead_id: a, channel: 'email', template_id: 'E1', outcome: 'sent' });
  o.logTouch({ lead_id: a, channel: 'email', template_id: 'E1', outcome: 'positive' });
  o.logTouch({ lead_id: b, channel: 'linkedin', template_id: 'L2', outcome: 'sent' });
  o.addIdea({ idea: 'Gyms in Dubai rarely have booking sites', evidence: '7 of 10 checked' });
  const s = o.stats(24);
  assert.equal(s.touches, 2);
  assert.deepEqual(s.byChannel.email, { sent: 1, replies: 1, positive: 1, negative: 0, bounced: 0, optedOut: 0 });
  assert.equal(s.byTemplate.L2.sent, 1);
  assert.equal(s.byBrand.click.positive, 1);
  assert.equal(s.leadsByStatus.replied, 1);
  assert.deepEqual(s.newIdeas, ['Gyms in Dubai rarely have booking sites']);
});

test('schedule times are Dubai time', () => {
  assert.equal(nextDubai('10:00', new Date('2026-10-12T05:00:00Z')), '2026-10-12T06:00:00.000Z');   // 09:00 Dubai → today 10:00
  assert.equal(nextDubai('03:00', new Date('2026-10-12T05:00:00Z')), '2026-10-12T23:00:00.000Z');   // already past → tomorrow 03:00
  assert.match(OUTREACH_JOBS.report, /what worked|worked/);
  assert.match(OUTREACH_JOBS.report, /ideas/);
  assert.match(OUTREACH_JOBS.research, /at most 15 new targets/);
});

function bossFor(extraEnv) {
  const cfg = readConfig(Object.assign({ HQ_WORKSPACE: tmp(), ANTHROPIC_API_KEY: 'k' }, extraEnv));
  const store = makeStore(tmp());
  const seen = [];
  const outreach = cfg.outreach ? makeOutreach({ dir: path.join(cfg.workspace, 'outreach'), accounts: cfg.outreachAccounts }) : null;
  const boss = makeBoss({ cfg, tg: { send: async () => ({}), typing: () => null }, store, usage: makeUsage(store, cfg), approvals: { request: async () => ({ allowed: false }), cancelAll() {} }, hqServer: {}, outreach, log: () => null,
    queryFn: ({ options }) => { seen.push(options); return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, num_turns: 1, session_id: 's' }; })(); } });
  return { boss, seen, outreach, cfg };
}

test('outreach edition: manager cannot use the browser, the scout can; a reserved email unlocks one Send', async () => {
  const { boss, seen, outreach } = bossFor({ HQ_LITE: '1', HQ_OUTREACH: '1', HQ_MANAGER_NO_BROWSER: '1', OUTREACH_EMAIL_ACCOUNTS: 'a@gmail.com' });
  boss.enqueue({ chatId: '1', prompt: 'x' }); await new Promise((r) => setTimeout(r, 20));
  const o = seen[0];
  assert.match(o.systemPrompt.append, /outreach field team/);
  assert.match(o.systemPrompt.append, /a@gmail\.com/);
  assert.match(o.systemPrompt.append, /Never keep browsing on your own/);
  assert.match(o.systemPrompt.append, /\/auto on/);
  assert.match(o.systemPrompt.append, /no cold messages ever/);
  assert.match(o.agents.scout.prompt, /public pages only/);
  const nav = { url: 'https://example.com' };
  assert.equal((await o.canUseTool('mcp__browser__browser_navigate', nav, {})).behavior, 'deny');                   // manager
  assert.equal((await o.canUseTool('mcp__browser__browser_navigate', nav, { agentID: 'scout-1' })).behavior, 'allow');
  const send = { element: 'Send button' };
  assert.equal((await o.canUseTool('mcp__browser__browser_click', send, { agentID: 's' })).behavior, 'deny');      // asks → fake approvals deny
  const [id] = outreach.addLeads([lead({ business_email: 'hi@glowsalon.ae', email_source_url: 'https://glowsalon.ae' })]).added;
  outreach.approveBatch([{ lead_id: id, subject: 's', body: 'body text long enough' }]);
  outreach.reserveSend(id);
  assert.equal((await o.canUseTool('mcp__browser__browser_click', send, { agentID: 's' })).behavior, 'allow');
  assert.equal((await o.canUseTool('mcp__browser__browser_click', send, { agentID: 's' })).behavior, 'deny');
});

test('HQ and Lite are untouched: no outreach rules, the manager keeps the browser', async () => {
  const { boss, seen } = bossFor({ HQ_LITE: '1' });
  boss.enqueue({ chatId: '1', prompt: 'x' }); await new Promise((r) => setTimeout(r, 20));
  assert.ok(!/outreach field team/.test(seen[0].systemPrompt.append));
  assert.equal((await seen[0].canUseTool('mcp__browser__browser_navigate', { url: 'https://example.com' }, {})).behavior, 'allow');
  const tools = hqTools({ cfg: readConfig({ HQ_WORKSPACE: tmp() }), tg: {}, providers: {}, usage: {}, scheduler: {}, chatId: () => '1' }).map((t) => t.name);
  assert.ok(!tools.some((n) => n.startsWith('outreach_')));
});

test('outreach tools are on the hq server in the outreach edition', () => {
  const dir = tmp();
  const outreach = makeOutreach({ dir });
  const names = hqTools({ cfg: readConfig({ HQ_WORKSPACE: dir }), tg: {}, providers: {}, usage: {}, scheduler: {}, outreach, approvals: {}, chatId: () => '1' }).map((t) => t.name);
  for (const n of ['outreach_add_leads', 'outreach_request_email_batch', 'outreach_reserve_send', 'outreach_stats', 'outreach_add_idea', 'outreach_log_touch', 'outreach_suppress']) assert.ok(names.includes(n), n);
});
