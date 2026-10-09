// Reminders and scheduled jobs. "remind" sends a message; "task" gives the
// boss a job at that time and it reports back when done. Times: an ISO date
// ("2026-10-10T09:00"), Pakistan time when no zone is given, or "in 30m / 2h / 1d".

import crypto from 'node:crypto';

const UNIT = { m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000, h: 3600000, hr: 3600000, hour: 3600000, hours: 3600000, d: 86400000, day: 86400000, days: 86400000 };

export function parseWhen(when, now = new Date()) {
  const s = String(when || '').trim().toLowerCase();
  const rel = /^in\s+(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(s);
  if (rel && UNIT[rel[2]]) return new Date(now.getTime() + Number(rel[1]) * UNIT[rel[2]]);
  const local = /^(\d{4}-\d{2}-\d{2})(?:[ t](\d{2}:\d{2})(?::(\d{2}))?)?$/.exec(s);   // no zone given: Pakistan time (UTC+5)
  if (local) {
    const d = new Date(local[1] + 'T' + (local[2] || '09:00') + ':' + (local[3] || '00') + '+05:00');
    return isNaN(d) ? null : d;
  }
  const d = new Date(when);
  return isNaN(d) ? null : d;
}

// "daily", "hourly", "weekly", "every 2h", "30m" → milliseconds
export function parseEvery(every) {
  const s = String(every || '').trim().toLowerCase().replace(/^every\s+/, '');
  if (!s) return 0;
  if (s === 'daily' || s === 'day') return UNIT.day;
  if (s === 'hourly' || s === 'hour') return UNIT.hour;
  if (s === 'weekly' || s === 'week') return 7 * UNIT.day;
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(s);
  return m && UNIT[m[2]] ? Number(m[1]) * UNIT[m[2]] : 0;
}

export function makeScheduler(store, { onDue, now = () => new Date() }) {
  const list = () => store.read('schedules', []);

  function add({ when, text, kind = 'remind', every, chatId }) {
    const at = parseWhen(when, now());
    if (!at) throw new Error('could not understand the time "' + when + '"');
    const everyMs = parseEvery(every);
    if (every && !everyMs) throw new Error('could not understand the repeat "' + every + '"');
    if (everyMs && everyMs < 15 * 60000) throw new Error('repeats must be at least 15 minutes apart');
    const item = { id: crypto.randomBytes(3).toString('hex'), at: at.toISOString(), everyMs, text: String(text).slice(0, 2000), kind: kind === 'task' ? 'task' : 'remind', chatId: String(chatId) };
    store.update('schedules', [], (l) => { l.push(item); });
    return item;
  }
  function cancel(id) { let found = false; store.update('schedules', [], (l) => l.filter((x) => (x.id === id ? (found = true, false) : true))); return found; }

  async function tick() {
    const t = now().getTime();
    const due = list().filter((x) => new Date(x.at).getTime() <= t);
    if (!due.length) return 0;
    store.update('schedules', [], (l) => l.flatMap((x) => {
      if (new Date(x.at).getTime() > t) return [x];
      if (!x.everyMs) return [];
      let next = new Date(x.at).getTime();
      while (next <= t) next += x.everyMs;
      return [Object.assign({}, x, { at: new Date(next).toISOString() })];
    }));
    for (const x of due) await onDue(x);
    return due.length;
  }

  return { add, cancel, list, tick };
}
