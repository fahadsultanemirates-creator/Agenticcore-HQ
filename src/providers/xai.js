// xAI (Grok): chat, images, video, voice (text-to-speech) and voice notes
// (speech-to-text). Endpoints as used by the AgenticCore Telegram bots:
// /v1/chat/completions, /v1/images/generations, /v1/videos/generations + /v1/videos/{id},
// /v1/tts (mp3), /v1/stt (multipart "file").

import { http, tryVariants, newerFirst } from './http.js';
import { devanagariToUrdu } from './urdu-script.js';

const API = 'https://api.x.ai/v1';
const SKIP = /imagine|image|video|vision|mini|tts|stt|embed|beta|non-reasoning|fast|code/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeXai(cfg, fetchImpl = globalThis.fetch) {
  const key = cfg.xaiKey;
  const auth = { Authorization: 'Bearer ' + key };
  let chosen = cfg.xaiModel || null;

  async function listModels() {
    const data = await http(fetchImpl, 'xai', API + '/models', { headers: auth, timeoutMs: 20000 });
    return (data.data || []).map((m) => ({ id: m.id, created: m.created || 0 }));
  }
  // Newest Grok text model (e.g. grok-4.7), unless XAI_MODEL is set.
  async function candidates() {
    return (await listModels()).filter((m) => /^grok-\d/.test(m.id) && !SKIP.test(m.id)).sort(newerFirst).map((m) => m.id);
  }
  async function model() {
    if (chosen) return chosen;
    chosen = (await candidates())[0] || 'grok-4';
    return chosen;
  }
  const setModel = (id) => { chosen = id || cfg.xaiModel || null; };

  async function ask({ prompt, system, search = false }) {
    const m = await model();
    const messages = (system ? [{ role: 'system', content: system }] : []).concat([{ role: 'user', content: prompt }]);
    const base = { model: m, messages };
    const variants = [
      { label: (cfg.xaiReasoning || 'high') + ' reasoning' + (search ? ' + live search' : ''), body: Object.assign({}, base, { reasoning_effort: cfg.xaiReasoning || 'high' }, search ? { search_parameters: { mode: 'auto', return_citations: true } } : {}) },
      search && { label: 'live search', body: Object.assign({}, base, { search_parameters: { mode: 'auto', return_citations: true } }) },
      { label: 'plain', body: base }
    ].filter(Boolean);
    const r = await tryVariants(variants, async (v) => {
      const data = await http(fetchImpl, 'xai', API + '/chat/completions', { method: 'POST', headers: auth, body: v.body, timeoutMs: 600000 });
      const msg = ((data.choices || [])[0] || {}).message || {};
      const sources = (data.citations || []).map((u) => (typeof u === 'string' ? { title: u, url: u } : u)).slice(0, 12);
      return { text: String(msg.content || '').trim(), sources, usage: data.usage || null };
    });
    return Object.assign(r, { model: m });
  }

  async function image({ prompt, n = 1 }) {
    const data = await http(fetchImpl, 'xai', API + '/images/generations', {
      method: 'POST', headers: auth, timeoutMs: 300000,
      body: { model: cfg.xaiImageModel, prompt, n: Math.min(Math.max(n, 1), 4), response_format: 'b64_json' }
    });
    return (data.data || []).map((d) => d.b64_json ? Buffer.from(d.b64_json, 'base64') : null).filter(Boolean);
  }

  // Video: submit, then poll until done (or give up after maxWaitMs). imageUrl = optional starting picture.
  async function video({ prompt, duration = 10, aspectRatio = '9:16', resolution = '720p', imageUrl, maxWaitMs = 15 * 60000, pollMs = 10000 }) {
    const body = { model: cfg.xaiVideoModel, prompt, duration, aspect_ratio: aspectRatio, resolution };
    if (imageUrl) body.image = imageUrl;
    const job = await http(fetchImpl, 'xai', API + '/videos/generations', { method: 'POST', headers: auth, body, timeoutMs: 120000 });
    if (!job || !job.request_id) throw new Error('xai video: no request id');
    const until = Date.now() + maxWaitMs;
    while (Date.now() < until) {
      await sleep(pollMs);
      const st = await http(fetchImpl, 'xai', API + '/videos/' + encodeURIComponent(job.request_id), { headers: auth, timeoutMs: 60000 });
      if (st.status === 'done' && st.video && st.video.url) {
        const res = await http(fetchImpl, 'xai', st.video.url, { raw: true, timeoutMs: 300000 });
        return Buffer.from(await res.arrayBuffer());
      }
      if (st.status === 'failed' || st.status === 'expired') throw new Error('xai video ' + st.status + (st.error ? ': ' + st.error : ''));
    }
    throw new Error('xai video: still rendering after ' + Math.round(maxWaitMs / 60000) + ' minutes');
  }

  // Text → mp3. lang 'ur' uses the Urdu voice (naksh), anything else the English voice (orion).
  async function speak({ text, lang = 'en' }) {
    const ur = lang === 'ur';
    const res = await http(fetchImpl, 'xai', API + '/tts', {
      method: 'POST', headers: auth, raw: true, timeoutMs: 120000,
      body: { text: String(text).slice(0, 4000), language: ur ? 'auto' : 'en', voice_id: ur ? cfg.voiceUr : cfg.voiceEn, output_format: { codec: 'mp3' } }
    });
    return Buffer.from(await res.arrayBuffer());
  }

  // Voice note → text (Urdu comes back in Urdu script).
  async function transcribe(bytes, filename = 'voice.ogg') {
    const form = new FormData();
    form.set('file', new Blob([bytes]), filename);
    const data = await http(fetchImpl, 'xai', API + '/stt', { method: 'POST', headers: auth, body: form, timeoutMs: 120000 });
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text) throw new Error('xai stt: empty transcript');
    return devanagariToUrdu(text);
  }

  return { name: 'xai', configured: Boolean(key), listModels, candidates, model, setModel, ask, image, video, speak, transcribe };
}
