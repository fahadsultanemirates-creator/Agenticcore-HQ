// The boss's own tools (an in-process MCP server called "hq"): talking to
// Fahad mid-task, sending files and voice, asking the other AIs, making
// images and video, remembering things and scheduling.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { dayKey } from './usage.js';

const ok = (text) => ({ content: [{ type: 'text', text: String(text) }] });
const fail = (text) => ({ content: [{ type: 'text', text: String(text) }], isError: true });
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'file';

function withSources(r) {
  const src = (r.sources || []).map((s, i) => (i + 1) + '. ' + s.title + ' — ' + s.url).join('\n');
  return '[' + r.model + ', ' + r.variant + ']\n\n' + (r.text || '(empty answer)') + (src ? '\n\nSources:\n' + src : '');
}

// deps: { cfg, tg, providers: { openai, gemini, xai }, usage, scheduler, chatId: () => id }
export function hqTools(deps) {
  const { cfg, tg, providers, usage, scheduler } = deps;
  const ws = cfg.workspace;
  const chat = () => deps.chatId();
  const inWs = (p) => {
    const abs = path.resolve(ws, String(p || ''));
    const rel = path.relative(ws, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel) || /(^|[\\/])\.env$/i.test(abs)) throw new Error('only files inside the workspace can be sent');
    return abs;
  };
  function saveMedia(buf, name, ext) {
    const dir = path.join(ws, 'media', dayKey());
    fs.mkdirSync(dir, { recursive: true });
    let file = path.join(dir, slug(name) + '.' + ext), n = 2;
    while (fs.existsSync(file)) file = path.join(dir, slug(name) + '-' + n++ + '.' + ext);
    fs.writeFileSync(file, buf);
    return file;
  }
  const need = (p) => { if (!p.configured) throw new Error(p.name + ' is not set up (no API key in .env)'); };
  const guarded = (fn) => async (args) => { try { return await fn(args); } catch (e) { return fail('Failed: ' + (e && e.message ? e.message : e)); } };

  const tools = [
    tool('tell_owner', 'Send Fahad a Telegram message right now, without ending your turn: a progress update on a long job ("halfway: 3 of 6 pages done"), something important you found, or a question you need answered before you can continue. Your final reply is sent automatically at the end, so do not repeat it here.',
      { text: z.string().min(1) },
      guarded(async ({ text }) => { await tg.send(chat(), text); return ok('sent'); })),

    tool('request_approval', 'Ask Fahad to approve something before you do it, with Allow / Deny buttons in Telegram; returns his answer. Use BEFORE anything public or hard to undo that the system does not already stop for: publishing or scheduling a post (Facebook, Instagram, Buffer, any page or group), sending a message to anyone other than Fahad, creating a new account, project or repository, spending money. Describe exactly what will happen (where, what text, which files).',
      { what: z.string().min(3).max(200).describe('one line, e.g. "Publish this post on the AgenticCore Estate Facebook page"'), details: z.string().max(1500).optional() },
      guarded(async ({ what, details }) => {
        if (!deps.approvals) return fail('approvals are not available');
        const r = await deps.approvals.request(chat(), what, details);
        return ok(r.allowed ? 'APPROVED by Fahad — go ahead.' : 'NOT approved (' + (r.note || 'denied') + '). Do not do it, and do not try another way; tell him what you would need.');
      })),

    tool('send_file', 'Send a file from the workspace to Fahad on Telegram (images show as photos, videos as videos, everything else as a document). Use after creating or downloading something he should see.',
      { path: z.string().describe('path inside the workspace, e.g. media/2026-10-09/flyer.png'), caption: z.string().optional() },
      guarded(async ({ path: p, caption }) => { await tg.sendFile(chat(), inWs(p), { caption }); return ok('sent ' + p); })),

    tool('speak', 'Send a voice message (Grok voice). ONLY when Fahad asks for voice / audio / "bol kar batao". language "ur" = Urdu voice (Naksh), "en" = English voice (Orion). Write the text the way it should be spoken: Urdu in Urdu script, no markdown, no links, short.',
      { text: z.string().min(1).max(3500), language: z.enum(['ur', 'en']) },
      guarded(async ({ text, language }) => {
        need(providers.xai);
        const mp3 = await providers.xai.speak({ text, lang: language });
        usage.addCall('xai-voice');
        await tg.sendFile(chat(), { bytes: mp3, name: 'voice.mp3' }, { kind: 'voice' });
        return ok('voice message sent');
      })),

    tool('ask_gpt', 'Ask OpenAI\'s newest GPT model (GPT-6, Extra High reasoning). Strong for social-media campaigns, ad copy, hooks, content calendars and a second opinion. Set web_search for anything current. Give it full context — it cannot see this conversation.',
      { prompt: z.string().min(1), system: z.string().optional(), web_search: z.boolean().optional() },
      guarded(async ({ prompt, system, web_search }) => {
        need(providers.openai);
        const r = await providers.openai.ask({ prompt, system, webSearch: Boolean(web_search) });
        usage.addCall('openai');
        return ok(withSources(r));
      })),

    tool('ask_gemini', 'Ask Google\'s newest Gemini model (high thinking) with Google Search grounding (on by default). Strong for research: markets, competitors, prices, news, local Pakistan information, long documents. Returns sources. Give it full context.',
      { prompt: z.string().min(1), system: z.string().optional(), google_search: z.boolean().optional() },
      guarded(async ({ prompt, system, google_search }) => {
        need(providers.gemini);
        const r = await providers.gemini.ask({ prompt, system, search: google_search !== false });
        usage.addCall('gemini');
        return ok(withSources(r));
      })),

    tool('ask_grok', 'Ask xAI\'s newest Grok model. Good for what is trending on X / social media right now (set live_search), bold creative angles, and a second opinion. Give it full context.',
      { prompt: z.string().min(1), system: z.string().optional(), live_search: z.boolean().optional() },
      guarded(async ({ prompt, system, live_search }) => {
        need(providers.xai);
        const r = await providers.xai.ask({ prompt, system, search: Boolean(live_search) });
        usage.addCall('xai');
        return ok(withSources(r));
      })),

    tool('generate_image', 'Create images and send them to Fahad. provider: "grok" (default, fast, strong for marketing visuals), "openai" (precise text and layout in the picture) or "both" to compare. Write a complete, specific prompt: subject, style, colours, composition, any exact text to show (spelt exactly). Never invent prices, phone numbers or logos.',
      { prompt: z.string().min(10), provider: z.enum(['grok', 'openai', 'both']).optional(), count: z.number().int().min(1).max(4).optional(), shape: z.enum(['square', 'portrait', 'landscape']).optional(), name: z.string().optional(), send: z.boolean().optional() },
      guarded(async ({ prompt, provider = 'grok', count = 1, shape = 'square', name = 'image', send = true }) => {
        const jobs = [];
        if (provider !== 'openai') { need(providers.xai); jobs.push(['grok', providers.xai.image({ prompt, n: count })]); }
        if (provider !== 'grok') {
          need(providers.openai);
          const size = shape === 'portrait' ? '1024x1536' : shape === 'landscape' ? '1536x1024' : '1024x1024';
          jobs.push(['openai', providers.openai.image({ prompt, size, n: count })]);
        }
        const files = [];
        for (const [who, p] of jobs) {
          const imgs = await p;
          usage.addCall(who + '-image');
          imgs.forEach((buf, i) => files.push(saveMedia(buf, name + '-' + who + (imgs.length > 1 ? '-' + (i + 1) : ''), who === 'openai' ? 'png' : 'jpg')));
        }
        if (send) for (const f of files) await tg.sendFile(chat(), f, { caption: path.basename(f) });
        return ok('Saved' + (send ? ' and sent' : '') + ':\n' + files.map((f) => path.relative(ws, f)).join('\n'));
      })),

    tool('generate_video', 'Create a short video with Grok and send it to Fahad. Takes a few minutes — tell him first with tell_owner. Write a full shot description (scene, camera movement, mood, any text). image_url = optional public picture URL to animate.',
      { prompt: z.string().min(10), seconds: z.number().int().min(4).max(15).optional(), shape: z.enum(['portrait', 'landscape', 'square']).optional(), image_url: z.string().url().optional(), name: z.string().optional() },
      guarded(async ({ prompt, seconds = 10, shape = 'portrait', image_url, name = 'video' }) => {
        need(providers.xai);
        const aspectRatio = shape === 'landscape' ? '16:9' : shape === 'square' ? '1:1' : '9:16';
        const buf = await providers.xai.video({ prompt, duration: seconds, aspectRatio, imageUrl: image_url });
        usage.addCall('xai-video');
        const f = saveMedia(buf, name, 'mp4');
        await tg.sendFile(chat(), f, { caption: path.basename(f) });
        return ok('Saved and sent: ' + path.relative(ws, f));
      })),

    tool('remember', 'Save a lasting fact or preference to long-term memory (memory/notes.md, loaded at the start of every conversation): decisions, preferences, account names, project facts. Never store passwords or keys.',
      { note: z.string().min(3).max(1000) },
      guarded(async ({ note }) => {
        if (/(sk-[a-z0-9]|xai-|AIza|ghp_|github_pat_|\d{8,}:[A-Za-z0-9_-]{30,})/i.test(note)) return fail('That looks like a key or token — not saved.');
        const f = path.join(ws, 'memory', 'notes.md');
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.appendFileSync(f, '- ' + dayKey() + ': ' + note.replace(/\s+/g, ' ').trim() + '\n');
        return ok('remembered');
      })),

    tool('schedule', 'Set a reminder or a scheduled job. kind "remind" sends Fahad the text at that time; kind "task" gives YOU the text as a job at that time, and you report back when done (e.g. a daily 9am check of open pull requests). when: "in 30m" / "in 2h" / "in 1d" or a date-time like "2026-10-10 09:00" (Pakistan time). every: optional repeat — "daily", "hourly", "weekly", "every 6h".',
      { when: z.string(), text: z.string().min(1), kind: z.enum(['remind', 'task']).optional(), every: z.string().optional() },
      guarded(async (a) => {
        const item = scheduler.add(Object.assign({}, a, { chatId: chat() }));
        return ok('Scheduled #' + item.id + ' (' + item.kind + ') for ' + new Date(item.at).toLocaleString('en-GB', { timeZone: 'Asia/Karachi' }) + ' PKT' + (item.everyMs ? ', repeating' : ''));
      })),

    tool('list_schedules', 'List reminders and scheduled jobs.', {},
      guarded(async () => {
        const l = scheduler.list();
        return ok(l.length ? l.map((x) => '#' + x.id + ' ' + x.kind + ' at ' + new Date(x.at).toLocaleString('en-GB', { timeZone: 'Asia/Karachi' }) + ' PKT' + (x.everyMs ? ' (repeats)' : '') + ': ' + x.text.slice(0, 120)).join('\n') : 'Nothing scheduled.');
      })),

    tool('cancel_schedule', 'Cancel a reminder or scheduled job by its id.', { id: z.string() },
      guarded(async ({ id }) => ok(scheduler.cancel(id.replace(/^#/, '')) ? 'cancelled' : 'no schedule with that id'))),

    tool('spending', 'How much has been spent (Claude per day against the daily cap, and calls to the other AIs).', {},
      guarded(async () => ok(usage.report())))
  ];

  return tools;
}

export function makeHqServer(deps) {
  return createSdkMcpServer({ name: 'hq', version: '1.0.0', tools: hqTools(deps) });
}
