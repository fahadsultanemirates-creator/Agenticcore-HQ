// Outside tools the boss can use, each an MCP server started by the Claude
// engine: the browser (Playwright, connected to the AgenticCore Edge window
// on the VPS that Fahad logs into once), Netlify and Supabase (one server per
// Supabase account). Tokens go only to the server that needs them.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { childEnv } from './guard.js';

// Path of a package's command-line entry, run with this same Node.
export function binOf(pkg) {
  const dir = path.join(ROOT, 'node_modules', ...pkg.split('/'));
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const bin = typeof meta.bin === 'string' ? meta.bin : Object.values(meta.bin || {})[0];
  if (!bin) throw new Error(pkg + ' has no command');
  return path.join(dir, bin);
}

function server(pkg, args, env, resolve) {
  try {
    return { type: 'stdio', command: process.execPath, args: [resolve(pkg)].concat(args), env: childEnv(process.env, env) };
  } catch { return null; }   // package not installed yet: run scripts/update.ps1
}

// → { browser?, netlify?, supabase1?, supabase2?, supabase3? }
export function externalServers(cfg, resolve = binOf) {
  const out = {};
  if (cfg.browserCdp) {
    out.browser = server('@playwright/mcp', [
      '--cdp-endpoint', cfg.browserCdp,
      '--output-dir', path.join(cfg.workspace, 'browser'),
      '--image-responses', 'allow'
    ], {}, resolve);
  }
  if (cfg.netlifyToken) out.netlify = server('@netlify/mcp', [], { NETLIFY_PERSONAL_ACCESS_TOKEN: cfg.netlifyToken }, resolve);
  cfg.supabase.forEach((a) => {
    out['supabase' + a.n] = server('@supabase/mcp-server-supabase', ['--features', 'account,database,debugging,development,docs,functions,branching'], { SUPABASE_ACCESS_TOKEN: a.token }, resolve);
  });
  for (const k of Object.keys(out)) if (!out[k]) delete out[k];
  return out;
}

// What the boss is told about its accounts (labels only, never tokens).
export function accountsNote(cfg) {
  const lines = ['## Your connected accounts and tools'];
  lines.push(cfg.browserCdp
    ? '- Browser (mcp__browser__*): the AgenticCore Edge window on this VPS, where Fahad is logged in (Facebook and his pages, WhatsApp Web, Buffer, and other sites he added). It is his real logged-in browser.'
    : '- Browser: not set up.');
  lines.push(cfg.netlifyToken ? '- Netlify (mcp__netlify__*): his Netlify account.' : '- Netlify: not connected.');
  if (cfg.supabase.length) for (const a of cfg.supabase) lines.push('- Supabase account ' + a.n + ' (mcp__supabase' + a.n + '__*): ' + (a.label || 'no label') + '.');
  else lines.push('- Supabase: not connected.');
  lines.push('- GitHub: gh and git with his token (the repos he chose). ffmpeg is installed for video work.');
  return lines.join('\n');
}
