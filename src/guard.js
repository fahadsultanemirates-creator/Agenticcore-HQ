// What the boss may do on its own, what needs Fahad's ✅ in Telegram, and what
// is never allowed. Reading, searching, planning and working inside the
// workspace run freely; anything that publishes, deletes, merges, deploys or
// touches live data waits for approval. Keys are never readable.

import path from 'node:path';

const FREE = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent', 'NotebookRead',
  'BashOutput', 'KillShell', 'TaskOutput', 'TaskStop', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'Skill', 'ToolSearch']);
const WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL = new Set(['Bash', 'PowerShell']);

// Never: printing keys or the environment.
const SECRET = [
  /(^|[\\/\s"'])\.env(\b|$)/i,
  /\b(printenv|Get-ChildItem\s+env:|gci\s+env:|dir\s+env:|ls\s+env:)/i,
  /\$env:[A-Z_]*(KEY|TOKEN|SECRET)/i,
  /\$\{?[A-Z_]*(API_KEY|_TOKEN|SECRET)\b/,
  /\benv\s*(\||$)/m,
  /^\s*set\s*$/im
];

// Needs approval: publish / delete / merge / deploy / live data / system changes.
const RISKY = [
  [/\bgit\s+push\b/i, 'push code to GitHub'],
  [/\bgit\s+(reset\s+--hard|clean\s+-\w*f|branch\s+-D|rebase\b|filter-branch)/i, 'rewrite or discard git history'],
  [/\bgh\s+pr\s+(merge|close)\b/i, 'merge or close a pull request'],
  [/\bgh\s+(repo\s+(delete|edit|archive|rename)|release\s+(create|delete)|secret\s|variable\s|workflow\s+run|run\s+(rerun|cancel))/i, 'change GitHub settings or releases'],
  [/\bgh\s+api\b[^\n]*(-X|--method)\s*(DELETE|PUT|PATCH|POST)/i, 'change something through the GitHub API'],
  [/\brm\s+-\w*r\w*f|\brm\s+-\w*f\w*r|\brm\s+-r\b/i, 'delete files'],
  [/\bRemove-Item\b[^\n]*-Recurse|\b(rd|rmdir)\s+\/s|\bdel\s+\/[sfq]/i, 'delete files'],
  [/\b(format|diskpart)\b\s+[a-z]:|\b(shutdown|Restart-Computer|Stop-Computer)\b/i, 'shut down or format the server'],
  [/\b(reg\s+(delete|add)|Set-ExecutionPolicy|net\s+user|netsh|New-NetFirewallRule|sc\s+(delete|config))\b/i, 'change Windows settings'],
  [/\bnpm\s+publish\b|\bnpx\s+netlify\b[^\n]*--prod|\bnetlify\s+(deploy\b[^\n]*--prod|env:(set|unset|import)|sites:delete)/i, 'publish or deploy live'],
  [/\bsupabase\s+(db\s+(push|reset)|migration\s+(up|repair)|projects\s+delete|secrets\s+(set|unset)|functions\s+deploy)/i, 'change the live database or Supabase settings'],
  [/\b(drop|truncate|alter)\s+(table|schema|database|policy|function)\b|\bdelete\s+from\b|\bupdate\s+\w+\s+set\b|\binsert\s+into\b|\bgrant\b|\brevoke\b/i, 'change live data (SQL)'],
  [/\bcurl\b[^\n]*(-X|--request)\s*(DELETE|PUT|PATCH)/i, 'change something through an API'],
  [/\b(Invoke-RestMethod|Invoke-WebRequest|irm|iwr)\b[^\n]*-Method\s+(Delete|Put|Patch)/i, 'change something through an API']
];

const inside = (file, dir) => {
  const rel = path.relative(path.resolve(dir), path.resolve(dir, String(file || '')));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// → { decision: 'allow' | 'ask' | 'deny', reason }
export function classify(toolName, input = {}, { workspace }) {
  if (toolName.startsWith('mcp__hq__')) return { decision: 'allow' };
  if (FREE.has(toolName)) {
    const p = input.file_path || input.path || input.notebook_path || '';
    if (toolName === 'Read' && /(^|[\\/])\.env$/i.test(String(p))) return { decision: 'deny', reason: 'keys are private' };
    return { decision: 'allow' };
  }
  if (WRITE.has(toolName)) {
    const p = input.file_path || input.notebook_path || '';
    if (/(^|[\\/])\.env$/i.test(String(p))) return { decision: 'deny', reason: 'keys are private' };
    return inside(p, workspace) ? { decision: 'allow' } : { decision: 'ask', reason: 'change a file outside the workspace: ' + p };
  }
  if (SHELL.has(toolName)) {
    const cmd = String(input.command || '');
    if (SECRET.some((re) => re.test(cmd))) return { decision: 'deny', reason: 'keys and environment variables are private' };
    for (const [re, why] of RISKY) if (re.test(cmd)) return { decision: 'ask', reason: why };
    return { decision: 'allow' };
  }
  return { decision: 'allow' };
}

// The Claude process (and every command it runs) gets only what it needs:
// the other providers' keys and the Telegram token stay in this process.
const PASS = /^(PATH|PATHEXT|SYSTEMROOT|SystemRoot|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|USERNAME|USERDOMAIN|COMPUTERNAME|LANG|LC_ALL|TZ|TERM|SHELL|NODE_OPTIONS|CLAUDE_CODE_GIT_BASH_PATH|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|GIT_[A-Z_]+)$/i;
export function childEnv(env = process.env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (PASS.test(k)) out[k] = v;
  return Object.assign(out, extra);
}
