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

// A key pasted on a model line by mistake must never be used or shown as a model name.
const LOOKS_LIKE_KEY = /^(sk-|xai-|AIza|ghp_|github_pat_)|^\d{6,}:/;

export function readConfig(env = process.env) {
  const e = (k, d = '') => String(env[k] ?? d).trim() || d;
  const m = (k, d = '') => (LOOKS_LIKE_KEY.test(e(k)) ? d : e(k, d));
  const workspace = e('HQ_WORKSPACE', path.join(ROOT, 'workspace'));
  return {
    telegramToken: e('TELEGRAM_BOT_TOKEN'),
    ownerId: e('TELEGRAM_OWNER_ID'),
    anthropicKey: e('ANTHROPIC_API_KEY'),
    // Gemini edition (scripts/lite-gemini.ps1): the Claude engine talks to a local gateway that
    // translates to Gemini. Model names are the gateway's aliases (gemini-main, gemini-scout, ...).
    engine: e('HQ_ENGINE', 'claude'),
    baseUrl: e('ANTHROPIC_BASE_URL'),
    fastModel: e('HQ_FAST_MODEL'),
    // Extra Gemini keys named in .env as GEMINI_KEY_<NAME>; /key <name> switches between them.
    geminiKeys: Object.keys(env).filter((k) => /^GEMINI_KEY_[A-Za-z0-9_]+$/.test(k) && String(env[k]).trim()).map((k) => k.slice(11).toLowerCase()),
    name: e('HQ_NAME', 'AgenticCore HQ'),
    lite: e('HQ_LITE') === '1',          // the cost-effective edition (scripts/lite.ps1)
    // Outreach edition (scripts/lite.ps1 -Edition outreach): lead sheet, email batches, daily jobs.
    outreach: e('HQ_OUTREACH') === '1',
    managerNoBrowser: e('HQ_MANAGER_NO_BROWSER') === '1',   // the manager must hand browsing to the scout
    outreachAccounts: e('OUTREACH_EMAIL_ACCOUNTS').split(/[,;\s]+/).filter(Boolean),
    outreachEmailCap: num(env.OUTREACH_EMAIL_PER_ACCOUNT, 8),
    outreachTimes: { research: e('OUTREACH_RESEARCH_TIME', '03:00'), report: e('OUTREACH_REPORT_TIME', '10:00'), evening: e('OUTREACH_EVENING_TIME', '20:30') },
    model: e('HQ_MODEL', 'claude-opus-5-5'),
    // Specialist sub-agents: same model as the boss unless set; effort from each specialist unless set.
    helperModel: m('HQ_HELPER_MODEL', e('HQ_MODEL', 'claude-opus-5-5')),
    helperEffort: EFFORTS.includes(e('HQ_HELPER_EFFORT')) ? e('HQ_HELPER_EFFORT') : '',
    // Scout (Lite only): cheap helper for browsing, reading pages, collecting and formatting.
    scoutModel: m('HQ_SCOUT_MODEL', 'claude-haiku-5-5'),
    scoutEffort: EFFORTS.includes(e('HQ_SCOUT_EFFORT')) ? e('HQ_SCOUT_EFFORT') : 'low',
    modelHard: e('HQ_MODEL_HARD', 'claude-fable-5-1'),
    effort: EFFORTS.includes(e('HQ_EFFORT')) ? e('HQ_EFFORT') : 'max',
    openaiKey: e('OPENAI_API_KEY'), openaiModel: m('OPENAI_MODEL'), openaiImageModel: m('OPENAI_IMAGE_MODEL', 'gpt-image-1'),
    geminiKey: e('GEMINI_API_KEY'), geminiModel: m('GEMINI_MODEL'),
    xaiKey: e('XAI_API_KEY'), xaiModel: m('XAI_MODEL'),
    xaiImageModel: m('XAI_IMAGE_MODEL', 'grok-imagine-image-2.0'), xaiVideoModel: m('XAI_VIDEO_MODEL', 'grok-imagine-video-1.5'),
    openaiReasoning: e('OPENAI_REASONING', 'xhigh'), geminiThinking: e('GEMINI_THINKING', 'high'), xaiReasoning: e('XAI_REASONING', 'high'),
    voiceUr: e('VOICE_UR', 'naksh'), voiceEn: e('VOICE_EN', 'orion'),
    ghToken: e('GH_TOKEN'),
    netlifyToken: e('NETLIFY_TOKEN'),
    supabase: [1, 2, 3].map((n) => ({ n, token: e('SUPABASE_TOKEN_' + n), label: e('SUPABASE_LABEL_' + n) })).filter((a) => a.token),
    // The AgenticCore Edge window (scripts/stage2.ps1); HQ_BROWSER_CDP=off turns the browser tools off.
    browserCdp: e('HQ_BROWSER_CDP', 'http://127.0.0.1:9222') === 'off' ? '' : e('HQ_BROWSER_CDP', 'http://127.0.0.1:9222'),
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
