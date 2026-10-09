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
  const wrongKey = () => {
    if (/^sk-or-/.test(key)) throw new Error('this is an OpenRouter key (sk-or-…), not an OpenAI key. Make one at platform.openai.com → API keys and put it in .env as OPENAI_API_KEY');
  };
  async function candidates() {
    wrongKey();
    return (await listModels()).filter((m) => /^(gpt-\d|o\d)/.test(m.id) && !SKIP.test(m.id)).sort(newerFirst).map((m) => m.id);
  }
  async function model() {
    if (chosen) return chosen;
    chosen = (await candidates())[0] || 'gpt-5';
    return chosen;
  }
  const setModel = (id) => { chosen = id || cfg.openaiModel || null; };

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
    wrongKey();
    const m = await model();
    const base = { model: m, input: prompt };
    if (system) base.instructions = system;
    const tools = webSearch ? { tools: [{ type: 'web_search' }] } : {};
    const levels = [...new Set([cfg.openaiReasoning || 'xhigh', 'high'])];    // GPT-6: xhigh (Extra High), then high
    const variants = levels.map((lvl) => ({ label: lvl + ' reasoning' + (webSearch ? ' + web search' : ''), body: Object.assign({}, base, { reasoning: { effort: lvl } }, tools) }))
      .concat([webSearch && { label: 'web search', body: Object.assign({}, base, tools) }, { label: 'plain', body: base }].filter(Boolean));
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

  return { name: 'openai', configured: Boolean(key), listModels, candidates, model, setModel, ask, image };
}
