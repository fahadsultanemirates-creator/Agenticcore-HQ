// npm run models — shows which GPT / Gemini / Grok models your keys can use
// and which one HQ picks automatically (set OPENAI_MODEL / GEMINI_MODEL /
// XAI_MODEL in .env to choose a different one).
import { loadEnvFile, readConfig } from '../src/config.js';
import { makeOpenAI } from '../src/providers/openai.js';
import { makeGemini } from '../src/providers/gemini.js';
import { makeXai } from '../src/providers/xai.js';

loadEnvFile();
const cfg = readConfig();
for (const p of [makeOpenAI(cfg), makeGemini(cfg), makeXai(cfg)]) {
  if (!p.configured) { console.log('\n' + p.name + ': no key set'); continue; }
  try {
    const list = await p.listModels();
    console.log('\n' + p.name + ' — using: ' + await p.model());
    console.log('  available: ' + list.map((m) => m.id).sort().join(', '));
  } catch (e) { console.log('\n' + p.name + ': ' + e.message); }
}
console.log('\nClaude: ' + cfg.model + ' (effort ' + cfg.effort + '), hard jobs: ' + cfg.modelHard);
