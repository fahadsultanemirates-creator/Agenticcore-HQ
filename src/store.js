// Small JSON-file store under data/ (one file per kind). Writes are atomic
// (write to .tmp, then rename) so a crash never leaves half a file.

import fs from 'node:fs';
import path from 'node:path';

export function makeStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = (name) => path.join(dir, name + '.json');
  function read(name, fallback) {
    try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return structuredClone(fallback); }
  }
  function write(name, value) {
    const tmp = file(name) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
    fs.renameSync(tmp, file(name));
    return value;
  }
  function update(name, fallback, fn) { const v = read(name, fallback); const out = fn(v) ?? v; return write(name, out); }
  return { read, write, update, dir };
}
