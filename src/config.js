// Settings come from .env next to package.json (written by scripts/setup.ps1),
// which wins over anything already set on the server. Nothing secret is ever logged.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseEnv(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

export function loadEnvFile(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  const vals = parseEnv(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(vals)) if (v !== '') process.env[k] = v;   // the .env written by setup wins
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

export function readConfig(env = process.env) {
  const e = (k, d = '') => String(env[k] ?? d).trim() || d;
  const workspace = e('HQ_WORKSPACE', path.join(ROOT, 'workspace'));
  return {
    telegramToken: e('TELEGRAM_BOT_TOKEN'),
    ownerId: e('TELEGRAM_OWNER_ID'),
    anthropicKey: e('ANTHROPIC_API_KEY'),
    model: e('HQ_MODEL', 'claude-opus-5-5'),
    modelHard: e('HQ_MODEL_HARD', 'claude-fable-5-1'),
    effort: EFFORTS.includes(e('HQ_EFFORT')) ? e('HQ_EFFORT') : 'max',
    openaiKey: e('OPENAI_API_KEY'), openaiModel: e('OPENAI_MODEL'), openaiImageModel: e('OPENAI_IMAGE_MODEL', 'gpt-image-1'),
    geminiKey: e('GEMINI_API_KEY'), geminiModel: e('GEMINI_MODEL'),
    xaiKey: e('XAI_API_KEY'), xaiModel: e('XAI_MODEL'),
    xaiImageModel: e('XAI_IMAGE_MODEL', 'grok-imagine-image-2.0'), xaiVideoModel: e('XAI_VIDEO_MODEL', 'grok-imagine-video-1.5'),
    voiceUr: e('VOICE_UR', 'naksh'), voiceEn: e('VOICE_EN', 'orion'),
    ghToken: e('GH_TOKEN'),
    dailyBudget: num(env.DAILY_BUDGET_USD, 30),
    jobBudget: num(env.JOB_BUDGET_USD, 8),
    workspace,
    dataDir: e('HQ_DATA', path.join(ROOT, 'data')),
    logDir: e('HQ_LOGS', path.join(ROOT, 'logs'))
  };
}

export function missing(cfg) {
  const need = [];
  if (!cfg.telegramToken) need.push('TELEGRAM_BOT_TOKEN');
  if (!/^\d+$/.test(cfg.ownerId)) need.push('TELEGRAM_OWNER_ID');
  if (!cfg.anthropicKey) need.push('ANTHROPIC_API_KEY');
  return need;
}

export const EFFORT_LEVELS = EFFORTS;
