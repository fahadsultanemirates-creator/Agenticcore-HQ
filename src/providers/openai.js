// OpenAI: text (Responses API, high reasoning + web search) and images.

import { http, tryVariants, newerFirst } from './http.js';

const API = 'https://api.openai.com/v1';
const SKIP = /mini|nano|audio|realtime|transcribe|tts|image|search|embedding|moderation|instruct|codex|preview|dall-e|whisper|babbage|davinci|oss/i;

export function makeOpenAI(cfg, fetchImpl = globalThis.fetch) {
  const key = cfg.openaiKey;
  const auth = { Authorization: 'Bearer ' + key };
  let chosen = cfg.openaiModel || null;

  async function listModels() {
    const data = await http(fetchImpl, 'openai', API + '/models', { headers: auth, timeoutMs: 20000 });
    return (data.data || []).map((m) => ({ id: m.id, created: m.created || 0 }));
  }
  // Newest flagship text model (e.g. gpt-6 over gpt-5), unless OPENAI_MODEL is set.
  async function model() {
    if (chosen) return chosen;
    const list = (await listModels()).filter((m) => /^(gpt-\d|o\d)/.test(m.id) && !SKIP.test(m.id)).sort(newerFirst);
    chosen = (list[0] && list[0].id) || 'gpt-5';
    return chosen;
  }

  function textOf(data) {
    if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
    const parts = [];
    for (const item of data.output || []) for (const c of item.content || []) if (c.type === 'output_text' && c.text) parts.push(c.text);
    return parts.join('\n').trim();
  }
  function sourcesOf(data) {
    const out = [];
    for (const item of data.output || []) for (const c of item.content || []) for (const a of c.annotations || [])
      if (a.type === 'url_citation' && a.url && !out.some((s) => s.url === a.url)) out.push({ title: a.title || a.url, url: a.url });
    return out.slice(0, 12);
  }

  async function ask({ prompt, system, webSearch = false }) {
    const m = await model();
    const base = { model: m, input: prompt };
    if (system) base.instructions = system;
    const variants = [
      { label: 'high reasoning' + (webSearch ? ' + web search' : ''), body: Object.assign({}, base, { reasoning: { effort: 'high' } }, webSearch ? { tools: [{ type: 'web_search' }] } : {}) },
      webSearch && { label: 'web search', body: Object.assign({}, base, { tools: [{ type: 'web_search' }] }) },
      { label: 'plain', body: base }
    ].filter(Boolean);
    const r = await tryVariants(variants, async (v) => {
      const data = await http(fetchImpl, 'openai', API + '/responses', { method: 'POST', headers: auth, body: v.body, timeoutMs: 600000 });
      return { text: textOf(data), sources: sourcesOf(data), usage: data.usage || null };
    });
    return Object.assign(r, { model: m });
  }

  // size: 1024x1024 | 1024x1536 (portrait) | 1536x1024 (landscape)
  async function image({ prompt, size = '1024x1024', n = 1 }) {
    const data = await http(fetchImpl, 'openai', API + '/images/generations', {
      method: 'POST', headers: auth, timeoutMs: 300000,
      body: { model: cfg.openaiImageModel, prompt, size, n: Math.min(Math.max(n, 1), 4) }
    });
    return (data.data || []).map((d) => d.b64_json ? Buffer.from(d.b64_json, 'base64') : null).filter(Boolean);
  }

  return { name: 'openai', configured: Boolean(key), listModels, model, ask, image };
}
