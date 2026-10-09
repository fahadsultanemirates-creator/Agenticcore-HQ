// Config, Telegram helpers, safety guard, scheduler and spending — no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv, readConfig, missing } from '../src/config.js';
import { chunkText, kindForFile, makeTelegram } from '../src/telegram.js';
import { classify, childEnv } from '../src/guard.js';
import { parseWhen, parseEvery, makeScheduler } from '../src/schedule.js';
import { makeStore } from '../src/store.js';
import { makeUsage, dayKey } from '../src/usage.js';
import { makeApprovals } from '../src/approvals.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hq-'));

test('config: .env parsing and strong defaults (Opus 5.5, max effort)', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nB="two words"\n\nC=\'x=y\'\nBAD'), { A: '1', B: 'two words', C: 'x=y' });
  const c = readConfig({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_OWNER_ID: '123', ANTHROPIC_API_KEY: 'k' });
  assert.equal(c.model, 'claude-opus-5-5');
  assert.equal(c.modelHard, 'claude-fable-5-1');
  assert.equal(c.effort, 'max');
  assert.equal(c.voiceUr, 'naksh'); assert.equal(c.voiceEn, 'orion');
  assert.deepEqual(missing(c), []);
  assert.deepEqual(missing(readConfig({ TELEGRAM_OWNER_ID: 'abc' })), ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_ID', 'ANTHROPIC_API_KEY']);
  assert.equal(readConfig({ HQ_EFFORT: 'silly' }).effort, 'max');
  assert.equal(readConfig({ CLAUDE_EFFORT: 'medium' }).effort, 'max', 'other programs\' CLAUDE_* settings must not change HQ');
});

test('telegram: long replies are split under 4096 characters, files get the right kind', () => {
  const long = Array.from({ length: 300 }, (_, i) => 'Line ' + i + ' ' + 'x'.repeat(30)).join('\n');
  const parts = chunkText(long);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 4000));
  assert.equal(parts.join('\n').replace(/\s+/g, ''), long.replace(/\s+/g, ''));
  assert.deepEqual(chunkText('  '), []);
  assert.equal(kindForFile('a/b.PNG'), 'photo'); assert.equal(kindForFile('x.mp4'), 'video');
  assert.equal(kindForFile('v.mp3'), 'audio'); assert.equal(kindForFile('r.pdf'), 'document');
});

test('telegram: send() posts each chunk; buttons only on the last', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { json: async () => ({ ok: true, result: { message_id: calls.length } }) }; };
  const tg = makeTelegram('TOKEN', fetchImpl);
  await tg.send(5, 'a'.repeat(5000), { reply_markup: { inline_keyboard: [] } });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith('/sendMessage'));
  assert.equal(calls[0].body.reply_markup, undefined);
  assert.ok(calls[1].body.reply_markup);
});

test('guard: reading and working in the workspace is free; risky actions ask; keys are never readable', () => {
  const ws = path.resolve('/hq/workspace');
  const c = (t, i) => classify(t, i, { workspace: ws }).decision;
  assert.equal(c('Read', { file_path: '/hq/workspace/repos/x/a.js' }), 'allow');
  assert.equal(c('Grep', { pattern: 'x' }), 'allow');
  assert.equal(c('mcp__hq__ask_gemini', {}), 'allow');
  assert.equal(c('Write', { file_path: '/hq/workspace/media/a.txt' }), 'allow');
  assert.equal(c('Write', { file_path: '/etc/hosts' }), 'ask');
  assert.equal(c('Read', { file_path: '/hq/.env' }), 'deny');
  assert.equal(c('Bash', { command: 'git status && npm test' }), 'allow');
  assert.equal(c('Bash', { command: 'gh pr create --title x --body y' }), 'allow');
  for (const cmd of ['git push -u origin feature', 'gh pr merge 41 --squash', 'rm -rf node_modules', 'Remove-Item C:\\x -Recurse',
    'netlify deploy --prod', 'supabase db push', 'psql -c "delete from listings"', 'psql -c "DROP TABLE users"', 'shutdown /r', 'git reset --hard HEAD~1'])
    assert.equal(c('Bash', { command: cmd }), 'ask', cmd);
  for (const cmd of ['cat .env', 'type C:\\AgenticCoreHQ\\.env', 'printenv', 'Get-ChildItem env:', 'echo $ANTHROPIC_API_KEY', 'echo $env:OPENAI_API_KEY'])
    assert.equal(c('Bash', { command: cmd }), 'deny', cmd);
  assert.equal(c('Bash', { command: 'psql -c "update listings set status=1"' }), 'ask');
});

test('guard: the Claude process does not get the other keys or the Telegram token', () => {
  const env = childEnv({ PATH: '/bin', OPENAI_API_KEY: 'o', XAI_API_KEY: 'x', TELEGRAM_BOT_TOKEN: 't', GEMINI_API_KEY: 'g', TEMP: '/tmp' }, { ANTHROPIC_API_KEY: 'a' });
  assert.deepEqual(env, { PATH: '/bin', TEMP: '/tmp', ANTHROPIC_API_KEY: 'a' });
});

test('schedule: times in Pakistan time, relative times and repeats', () => {
  const now = new Date('2026-10-09T10:00:00Z');
  assert.equal(parseWhen('in 30m', now).toISOString(), '2026-10-09T10:30:00.000Z');
  assert.equal(parseWhen('in 2 hours', now).toISOString(), '2026-10-09T12:00:00.000Z');
  assert.equal(parseWhen('2026-10-10 09:00', now).toISOString(), '2026-10-10T04:00:00.000Z');
  assert.equal(parseWhen('2026-10-10', now).toISOString(), '2026-10-10T04:00:00.000Z');
  assert.equal(parseWhen('nonsense', now), null);
  assert.equal(parseEvery('daily'), 86400000); assert.equal(parseEvery('every 6h'), 6 * 3600000); assert.equal(parseEvery(''), 0);
});

test('schedule: due items fire once; repeating ones move to the next time', async () => {
  let t = new Date('2026-10-09T10:00:00Z');
  const fired = [];
  const s = makeScheduler(makeStore(tmp()), { onDue: async (x) => fired.push(x.text), now: () => t });
  s.add({ when: 'in 10m', text: 'once', chatId: 1 });
  s.add({ when: 'in 20m', text: 'daily check', kind: 'task', every: 'daily', chatId: 1 });
  assert.throws(() => s.add({ when: 'in 1m', text: 'x', every: 'every 5m', chatId: 1 }), /15 minutes/);
  t = new Date('2026-10-09T10:25:00Z');
  assert.equal(await s.tick(), 2);
  assert.deepEqual(fired, ['once', 'daily check']);
  assert.equal(s.list().length, 1);
  assert.equal(s.list()[0].at, '2026-10-10T10:20:00.000Z');
  assert.equal(await s.tick(), 0);
});

test('usage: daily cap, today\'s override and the report', () => {
  const now = new Date('2026-10-09T10:00:00Z');
  const u = makeUsage(makeStore(tmp()), { dailyBudget: 30 }, () => now);
  assert.equal(dayKey(now), '2026-10-09');
  u.addClaude(12.5); u.addClaude(-3); u.addCall('openai'); u.addCall('openai');
  assert.equal(u.today().claude, 12.5);
  assert.equal(u.left(), 17.5);
  u.setCapToday(50);
  assert.equal(u.left(), 37.5);
  assert.match(u.report(), /Claude \$12\.50 \(2 jobs\) · calls: openai 2/);
});

test('approvals: Allow resolves true, Deny false, timeouts deny', async () => {
  const sent = [];
  const tg = { send: async (c, text, extra) => { sent.push({ text, extra }); return { message_id: 9 }; }, clearButtons: async () => null };
  const a = makeApprovals(tg, { timeoutMs: 50 });
  const p1 = a.request(1, 'push code to GitHub', 'git push');
  await new Promise((r) => setImmediate(r));
  const id = sent[0].extra.reply_markup.inline_keyboard[0][0].callback_data.slice(3);
  assert.equal(a.handle('ok:' + id), 'Allowed');
  assert.equal((await p1).allowed, true);
  assert.equal(a.handle('ok:' + id), 'Already answered');
  const p2 = a.request(1, 'delete files');
  await new Promise((r) => setImmediate(r));
  const id2 = sent[1].extra.reply_markup.inline_keyboard[0][1].callback_data.slice(3);
  a.handle('no:' + id2);
  assert.equal((await p2).allowed, false);
  const p3 = await a.request(1, 'deploy');
  assert.equal(p3.allowed, false);
  assert.ok(sent.some((m) => /timed out/.test(m.text)));
});
