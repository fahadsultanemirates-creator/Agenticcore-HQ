// Google Gemini: research with Google Search grounding and high thinking.

import { http, tryVariants, newerFirst } from './http.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const SKIP = /lite|image|tts|embedding|aqa|vision|exp|learnlm|gemma|nano|live|audio/i;

export function makeGemini(cfg, fetchImpl = globalThis.fetch) {
  const key = cfg.geminiKey;
  const headers = { 'x-goog-api-key': key };
  let chosen = cfg.geminiModel || null;

  async function listModels() {
    const data = await http(fetchImpl, 'gemini', API + '/models?pageSize=200', { headers, timeoutMs: 20000 });
    return (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ id: String(m.name).replace(/^models\//, ''), created: 0 }));
  }
  // Newest "pro" model (e.g. gemini-3.8-pro), else the newest at all.
  async function candidates() {
    const list = (await listModels()).filter((m) => /^gemini-\d/.test(m.id) && !SKIP.test(m.id)).sort(newerFirst).map((m) => m.id);
    return list.filter((id) => /pro/.test(id)).concat(list.filter((id) => !/pro/.test(id)));   // pro models first
  }
  async function model() {
    if (chosen) return chosen;
    chosen = (await candidates())[0] || 'gemini-2.5-pro';
    return chosen;
  }
  const setModel = (id) => { chosen = id || cfg.geminiModel || null; };

  async function ask({ prompt, system, search = true }) {
    const m = await model();
    const base = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
    if (system) base.systemInstruction = { parts: [{ text: system }] };
    const tools = search ? { tools: [{ google_search: {} }] } : {};
    const variants = [
      { label: (cfg.geminiThinking || 'high') + ' thinking' + (search ? ' + Google Search' : ''), body: Object.assign({}, base, tools, { generationConfig: { thinkingConfig: { thinkingLevel: cfg.geminiThinking || 'high' } } }) },
      { label: search ? 'Google Search' : 'plain', body: Object.assign({}, base, tools) },
      search && { label: 'plain', body: base }
    ].filter(Boolean);
    const r = await tryVariants(variants, async (v) => {
      const data = await http(fetchImpl, 'gemini', API + '/models/' + encodeURIComponent(m) + ':generateContent', { method: 'POST', headers, body: v.body, timeoutMs: 600000 });
      const cand = (data.candidates || [])[0] || {};
      const text = ((cand.content && cand.content.parts) || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('\n').trim();
      const sources = (((cand.groundingMetadata || {}).groundingChunks) || []).map((c) => c.web).filter(Boolean)
        .map((w) => ({ title: w.title || w.uri, url: w.uri })).slice(0, 12);
      return { text, sources, usage: data.usageMetadata || null };
    });
    return Object.assign(r, { model: m });
  }

  return { name: 'gemini', configured: Boolean(key), listModels, candidates, model, setModel, ask };
}
