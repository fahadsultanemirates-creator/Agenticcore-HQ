// OpenAI / Gemini / xAI with a fake fetch: newest-model choice, full-power
// request first with fallback, voices, speech-to-text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { makeOpenAI } from '../src/providers/openai.js';
import { makeGemini } from '../src/providers/gemini.js';
import { makeXai } from '../src/providers/xai.js';
import { versionOf } from '../src/providers/http.js';

const cfg = readConfig({ OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x' });
const json = (status, body) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new TextEncoder().encode('AUDIO').buffer });

function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opts = {}) => {
    const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
    calls.push({ url, method: opts.method || 'GET', body, headers: opts.headers });
    for (const [match, handler] of routes) if (url.includes(match)) return handler(body, calls);
    return json(404, { error: { message: 'no route ' + url } });
  };
  f.calls = calls;
  return f;
}

test('version parsing picks the newest family member', () => {
  assert.deepEqual(versionOf('gemini-3.8-pro'), [3, 8]);
  assert.deepEqual(versionOf('gpt-6'), [6]);
  assert.deepEqual(versionOf('grok-4-0709'), [4]);
});

test('OpenAI: newest flagship model, Extra High reasoning + web search, sources', async () => {
  const f = fakeFetch([
    ['/models', () => json(200, { data: [{ id: 'gpt-5', created: 1 }, { id: 'gpt-6', created: 3 }, { id: 'gpt-6-mini', created: 4 }, { id: 'gpt-image-1', created: 5 }, { id: 'gpt-4o', created: 2 }] })],
    ['/responses', () => json(200, { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Campaign plan', annotations: [{ type: 'url_citation', url: 'https://a.pk', title: 'A' }] }] }] })]
  ]);
  const o = makeOpenAI(cfg, f);
  assert.equal(await o.model(), 'gpt-6');
  const r = await o.ask({ prompt: 'plan', system: 'be brief', webSearch: true });
  assert.equal(r.text, 'Campaign plan');
  assert.deepEqual(r.sources, [{ title: 'A', url: 'https://a.pk' }]);
  const sent = f.calls.find((c) => c.url.endsWith('/responses')).body;
  assert.deepEqual(sent.reasoning, { effort: 'xhigh' });   // GPT-6 Extra High
  assert.deepEqual(sent.tools, [{ type: 'web_search' }]);
  assert.equal(sent.instructions, 'be brief');
});

test('OpenAI: a rejected setting falls back to a simpler request; auth errors stop', async () => {
  let n = 0;
  const f = fakeFetch([['/responses', (body) => { n++; return body.reasoning ? json(400, { error: { message: 'reasoning not supported' } }) : json(200, { output_text: 'ok' }); }]]);
  const o = makeOpenAI(Object.assign({}, cfg, { openaiModel: 'gpt-x' }), f);
  const r = await o.ask({ prompt: 'p', webSearch: true });
  assert.equal(r.text, 'ok'); assert.equal(r.variant, 'web search'); assert.equal(n, 3);   // xhigh, high, then without reasoning
  const tried = [];
  const steps = makeOpenAI(Object.assign({}, cfg, { openaiModel: 'gpt-x' }), fakeFetch([['/responses', (b) => { tried.push(b.reasoning && b.reasoning.effort); return b.reasoning && b.reasoning.effort === 'xhigh' ? json(400, { error: { message: 'unsupported value' } }) : json(200, { output_text: 'deep' }); }]]));
  assert.equal((await steps.ask({ prompt: 'p' })).variant, 'high reasoning');
  assert.deepEqual(tried, ['xhigh', 'high']);
  const bad = makeOpenAI(Object.assign({}, cfg, { openaiModel: 'gpt-x' }), fakeFetch([['/responses', () => json(401, { error: { message: 'bad key' } })]]));
  await assert.rejects(bad.ask({ prompt: 'p' }), /openai 401: bad key/);
});

test('Gemini: newest pro model, high thinking + Google Search, grounded sources', async () => {
  const f = fakeFetch([
    ['/models?', () => json(200, { models: [
      { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] }] })],
    [':generateContent', () => json(200, { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'DHA prices rose' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://z.com', title: 'Zameen' } }] } }] })]
  ]);
  const g = makeGemini(cfg, f);
  assert.equal(await g.model(), 'gemini-3.8-pro');
  const r = await g.ask({ prompt: 'DHA prices?' });
  assert.equal(r.text, 'DHA prices rose');
  assert.deepEqual(r.sources, [{ title: 'Zameen', url: 'https://z.com' }]);
  const sent = f.calls.find((c) => c.url.includes(':generateContent'));
  assert.ok(sent.url.includes('/models/gemini-3.8-pro:generateContent'));
  assert.deepEqual(sent.body.tools, [{ google_search: {} }]);
  assert.equal(sent.body.generationConfig.thinkingConfig.thinkingLevel, 'high');
  assert.equal(sent.headers['x-goog-api-key'], 'g');
});

test('xAI: newest Grok, Urdu voice = naksh, English voice = orion, voice notes in Urdu script', async () => {
  const f = fakeFetch([
    ['/models', () => json(200, { data: [{ id: 'grok-4' }, { id: 'grok-4.7' }, { id: 'grok-imagine-image-2.0' }, { id: 'grok-3-mini' }] })],
    ['/tts', () => json(200, {})],
    ['/stt', () => json(200, { text: 'मेरा घर जोहर टाउन में है' })]
  ]);
  const x = makeXai(cfg, f);
  assert.equal(await x.model(), 'grok-4.7');
  await x.speak({ text: 'السلام علیکم', lang: 'ur' });
  await x.speak({ text: 'Hello', lang: 'en' });
  const tts = f.calls.filter((c) => c.url.endsWith('/tts')).map((c) => c.body);
  assert.equal(tts[0].voice_id, 'naksh'); assert.equal(tts[0].language, 'auto');
  assert.equal(tts[1].voice_id, 'orion'); assert.equal(tts[1].language, 'en');
  assert.equal(await x.transcribe(Buffer.from('x')), 'میرا گھر جوہر ٹاؤن میں ہے');
});

test('xAI video: submit, poll until done, download', async () => {
  let polls = 0;
  const f = fakeFetch([
    ['/videos/generations', () => json(200, { request_id: 'r1' })],
    ['/videos/r1', () => json(200, ++polls < 2 ? { status: 'pending' } : { status: 'done', video: { url: 'https://cdn.x.ai/v.mp4' } })],
    ['cdn.x.ai', () => json(200, {})]
  ]);
  const buf = await makeXai(cfg, f).video({ prompt: 'drone shot of a house', pollMs: 1 });
  assert.equal(buf.toString(), 'AUDIO');
  assert.equal(polls, 2);
});
