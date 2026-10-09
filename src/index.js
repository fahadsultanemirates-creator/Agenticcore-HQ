// AgenticCore HQ — start here. Reads Telegram (long polling), answers only
// the owner, turns messages / voice notes / files into jobs for the boss,
// and runs reminders and scheduled jobs.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadEnvFile, readConfig, missing, EFFORT_LEVELS } from './config.js';
import { makeStore } from './store.js';
import { makeTelegram } from './telegram.js';
import { makeOpenAI } from './providers/openai.js';
import { makeGemini } from './providers/gemini.js';
import { makeXai } from './providers/xai.js';
import { makeUsage, dayKey } from './usage.js';
import { makeApprovals } from './approvals.js';
import { makeScheduler } from './schedule.js';
import { makeHqServer } from './tools.js';
import { makeBoss, MODEL_ALIASES } from './boss.js';

loadEnvFile();
const cfg = readConfig();
fs.mkdirSync(cfg.logDir, { recursive: true });
const logFile = path.join(cfg.logDir, 'hq.log');
function log(line) {
  const s = new Date().toISOString() + ' ' + line;
  console.log(s);
  try { fs.appendFileSync(logFile, s + '\n'); } catch { /* disk issue: console only */ }
}

const need = missing(cfg);
if (need.length) { log('Missing settings in .env: ' + need.join(', ') + ' — run scripts/setup.ps1'); process.exit(1); }

// Workspace: Claude's working folder (repos, media, inbox, memory).
for (const d of ['', 'inbox', 'media', 'memory', 'repos']) fs.mkdirSync(path.join(cfg.workspace, d), { recursive: true });
for (const [from, to] of [['CLAUDE.md', 'CLAUDE.md'], ['notes.md', 'memory/notes.md']]) {
  const dest = path.join(cfg.workspace, to);
  if (!fs.existsSync(dest)) fs.copyFileSync(path.join(ROOT, 'workspace-template', from), dest);
}

const store = makeStore(cfg.dataDir);
const tg = makeTelegram(cfg.telegramToken);
const providers = { openai: makeOpenAI(cfg), gemini: makeGemini(cfg), xai: makeXai(cfg) };
const PROVIDER_ALIASES = { gpt: 'openai', openai: 'openai', chatgpt: 'openai', gemini: 'gemini', google: 'gemini', grok: 'xai', xai: 'xai' };
for (const [k, id] of Object.entries(store.read('settings', {}).models || {})) if (providers[k]) providers[k].setModel(id);   // choices made with /use
const usage = makeUsage(store, cfg);
const approvals = makeApprovals(tg);
let activeChat = cfg.ownerId;
let boss;
const scheduler = makeScheduler(store, {
  onDue: async (x) => {
    if (x.kind === 'task') { boss.enqueue({ chatId: x.chatId, prompt: 'Scheduled job (#' + x.id + '): ' + x.text + '\nDo it now and report the result to Fahad.' }); }
    else await tg.send(x.chatId, '⏰ Reminder: ' + x.text).catch(() => null);
  }
});
const hqServer = makeHqServer({ cfg, tg, providers, usage, scheduler, chatId: () => activeChat });
boss = makeBoss({ cfg, tg, store, usage, approvals, hqServer, log });

const HELP = [
  'AgenticCore HQ — your AI team. Just write or send a voice note.',
  '',
  '/new — start a fresh conversation (memory notes stay)',
  '/stop — stop the current job',
  '/status — what I\'m doing now',
  '/cost — spending (Claude per day, other AI calls)',
  '/budget 50 — raise today\'s Claude cap to $50',
  '/model opus | fable | sonnet — which Claude leads (now: {model})',
  '/effort low | medium | high | xhigh | max — how hard I think (now: {effort})',
  '/models — the GPT / Gemini / Grok models I\'m using (/models all = the choices)',
  '/use gemini <model> — pick a model yourself (/use gemini auto = newest again)',
  '/help — this list'
].join('\n');

async function command(chatId, text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ').toLowerCase();
  const rawArgs = rest;
  const s = boss.settings();
  switch (cmd.toLowerCase().replace(/@.*$/, '')) {
    case '/start': case '/help':
      return tg.send(chatId, HELP.replace('{model}', s.model).replace('{effort}', s.effort));
    case '/new':
      boss.newConversation(chatId);
      return tg.send(chatId, '🆕 Fresh conversation started. What shall we work on?');
    case '/stop':
      return tg.send(chatId, boss.stop() ? '⏹ Stopping…' : 'Nothing is running.');
    case '/status': {
      const st = boss.status();
      return tg.send(chatId, st.busy ? '🔧 Working (' + st.minutes + ' min): ' + st.activity + (st.queued ? '\n' + st.queued + ' message(s) waiting.' : '') : '🟢 Free. Model: ' + s.model + ', effort: ' + s.effort + '.\nToday: $' + usage.today().claude.toFixed(2) + ' of $' + usage.cap().toFixed(2));
    }
    case '/cost': return tg.send(chatId, usage.report());
    case '/budget': {
      const n = Number(arg.replace(/[$,]/g, ''));
      if (!(n > 0 && n <= 1000)) return tg.send(chatId, 'Send an amount in dollars, e.g. /budget 50');
      usage.setCapToday(n);
      return tg.send(chatId, '✅ Today\'s Claude cap is now $' + n.toFixed(2) + '.');
    }
    case '/model':
      if (!MODEL_ALIASES[arg]) return tg.send(chatId, 'Use /model opus (default), /model fable (hardest jobs) or /model sonnet (faster, cheaper). Now: ' + s.model);
      store.write('settings', Object.assign({}, s, { model: arg }));
      return tg.send(chatId, '✅ ' + arg + ' (' + boss.modelId(arg) + ') leads from your next message.');
    case '/effort':
      if (!EFFORT_LEVELS.includes(arg)) return tg.send(chatId, 'Use /effort low | medium | high | xhigh | max. Now: ' + s.effort);
      store.write('settings', Object.assign({}, s, { effort: arg }));
      return tg.send(chatId, '✅ Effort set to ' + arg + '.');
    case '/models': {
      const all = arg === 'all';
      const lines = [];
      for (const p of Object.values(providers)) {
        if (!p.configured) { lines.push(p.name + ': not set up'); continue; }
        try {
          lines.push(p.name + ': ' + await p.model());
          if (all) lines.push('  choices: ' + (await p.candidates()).slice(0, 12).join(', ') + '\n');
        } catch (e) { lines.push(p.name + ': error — ' + e.message); }
      }
      return tg.send(chatId, 'Claude: ' + boss.modelId(s.model) + ' (effort ' + s.effort + ')\n' + lines.join('\n') + (all ? '\nTo pick one: /use gemini <model>' : ''));
    }
    case '/use': {
      const key = PROVIDER_ALIASES[(rawArgs[0] || '').toLowerCase()];
      const id = (rawArgs[1] || '').trim();
      if (!key || !id) return tg.send(chatId, 'Use: /use gpt | gemini | grok <model name>, or auto for the newest. See /models all for the choices.');
      const p = providers[key];
      const auto = id.toLowerCase() === 'auto';
      if (!auto) {
        let known = [];
        try { known = (await p.listModels()).map((m) => m.id); } catch (e) { return tg.send(chatId, p.name + ': error — ' + e.message); }
        if (!known.includes(id)) return tg.send(chatId, p.name + ' has no model called ' + id + '. See /models all.');
      }
      const models = Object.assign({}, s.models || {});
      if (auto) delete models[key]; else models[key] = id;
      store.write('settings', Object.assign({}, s, { models }));
      p.setModel(auto ? null : id);
      return tg.send(chatId, '✅ ' + p.name + ' now uses ' + await p.model().catch(() => id) + '.');
    }
    default: return null;
  }
}

async function saveIncoming(fileId, name) {
  const f = await tg.download(fileId);
  const dir = path.join(cfg.workspace, 'inbox', dayKey());
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name || path.basename(f.path)).replace(/[^\w.\-]+/g, '_').slice(-80);
  let dest = path.join(dir, safe), n = 2;
  while (fs.existsSync(dest)) dest = path.join(dir, n++ + '-' + safe);
  fs.writeFileSync(dest, f.bytes);
  return path.relative(cfg.workspace, dest).replace(/\\/g, '/');
}

async function onMessage(msg) {
  const chatId = String(msg.chat.id);
  activeChat = chatId;
  if (msg.text && msg.text.startsWith('/')) { const handled = await command(chatId, msg.text); if (handled !== null) return; }

  if (approvals.waiting && msg.text) {
    const t = msg.text.trim().toLowerCase().replace(/[.!]+$/, '');
    const yes = /^(yes|y|allow|ok|okay|haan|han|ji|jee|ha|go ahead|approve|approved)$/.test(t);
    const no = /^(no|n|deny|nahi|nahin|na|stop|reject)$/.test(t);
    if ((yes || no) && approvals.answerLatest(yes)) return tg.send(chatId, yes ? '✅ Allowed.' : '❌ Denied.');
  }

  let prompt = msg.text || msg.caption || '';
  if (msg.voice || msg.audio) {
    if (!providers.xai.configured) return tg.send(chatId, 'Voice notes need the xAI key on the VPS. Please type for now.');
    try {
      const f = await tg.download((msg.voice || msg.audio).file_id, 20 * 1024 * 1024);
      const heard = await providers.xai.transcribe(f.bytes, 'voice.ogg');
      usage.addCall('xai-stt');
      await tg.send(chatId, '🎙️ ' + heard.slice(0, 600));
      prompt = '(Voice note from Fahad, transcribed:) ' + heard;
    } catch (e) { log('stt: ' + e.message); return tg.send(chatId, 'I couldn\'t make out that voice note. Please try again or type it.'); }
  }
  const files = [];
  try {
    if (msg.photo && msg.photo.length) files.push(await saveIncoming(msg.photo[msg.photo.length - 1].file_id, 'photo-' + msg.message_id + '.jpg'));
    if (msg.document) files.push(await saveIncoming(msg.document.file_id, msg.document.file_name));
    if (msg.video) files.push(await saveIncoming(msg.video.file_id, 'video-' + msg.message_id + '.mp4'));
  } catch (e) { return tg.send(chatId, '⚠️ I couldn\'t download that file (' + e.message + '). Files over 20 MB can\'t come through the bot — share a link instead.'); }
  if (files.length) prompt = (prompt ? prompt + '\n\n' : 'Fahad sent this without a message — ask what he wants if it is not obvious.\n\n') + 'Attached (saved in the workspace): ' + files.join(', ');
  if (!prompt.trim()) return tg.send(chatId, 'I can read text, voice notes, photos and files. What would you like me to do?');

  const pos = boss.enqueue({ chatId, prompt });
  if (pos) await tg.send(chatId, '📝 Got it — I\'ll start on this as soon as the current job is done (' + pos + ' waiting). /stop cancels the current job.');
}

async function onCallback(cb) {
  if (String(cb.from.id) !== cfg.ownerId) return tg.answer(cb.id);
  const r = approvals.handle(cb.data);
  return tg.answer(cb.id, r || '');
}

async function poll() {
  let offset = store.read('state', {}).offset || 0;
  let warnedStranger = new Set();
  let wait = 5000;
  for (;;) {
    let updates = [];
    try { updates = await tg.getUpdates(offset, 50); wait = 5000; }
    catch (e) {
      log('getUpdates: ' + e.message + ' (retrying in ' + wait / 1000 + 's)');
      if (e.code === 401) { log('Telegram rejected the bot token — check TELEGRAM_BOT_TOKEN in .env'); process.exit(1); }
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 60000);
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      store.write('state', { offset });
      try {
        if (u.callback_query) { await onCallback(u.callback_query); continue; }
        const msg = u.message;
        if (!msg || !msg.from) continue;
        if (String(msg.from.id) !== cfg.ownerId) {
          if (!warnedStranger.has(msg.from.id)) { warnedStranger.add(msg.from.id); log('ignored message from user ' + msg.from.id); await tg.send(msg.chat.id, 'This is a private assistant.').catch(() => null); }
          continue;
        }
        onMessage(msg).catch((e) => { log('message error: ' + (e && e.stack || e)); tg.send(msg.chat.id, '⚠️ ' + e.message).catch(() => null); });
      } catch (e) { log('update error: ' + (e && e.stack || e)); }
    }
  }
}

setInterval(() => scheduler.tick().catch((e) => log('scheduler: ' + e.message)), 30000);
process.on('unhandledRejection', (e) => log('unhandled: ' + (e && e.stack || e)));

await tg.setCommands([
  { command: 'new', description: 'Start a fresh conversation' },
  { command: 'stop', description: 'Stop the current job' },
  { command: 'status', description: 'What I\'m doing now' },
  { command: 'cost', description: 'Spending report' },
  { command: 'model', description: 'opus | fable | sonnet' },
  { command: 'effort', description: 'low … max' },
  { command: 'models', description: 'Which AI models are in use' },
  { command: 'use', description: 'Pick a GPT / Gemini / Grok model' },
  { command: 'help', description: 'Help' }
]);
log('AgenticCore HQ started — model ' + boss.modelId(boss.settings().model) + ', effort ' + boss.settings().effort + ', workspace ' + cfg.workspace);
await tg.send(cfg.ownerId, '🟢 AgenticCore HQ is online. Model: ' + boss.settings().model + ', effort: ' + boss.settings().effort + '. Send /help for commands.').catch((e) => log('could not message the owner: ' + e.message + ' — have you pressed Start on the bot in Telegram?'));
poll();
