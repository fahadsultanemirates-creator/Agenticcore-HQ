// "Allow / Deny" buttons in Telegram for risky actions. A request that gets no
// answer within the timeout is denied, and the boss is told why. "Allow all (this job)"
// also lets the rest of the same job's browser clicks through without asking again.

import crypto from 'node:crypto';
import { buttons } from './telegram.js';

export function makeApprovals(tg, { timeoutMs = 15 * 60000 } = {}) {
  const pending = new Map(); // id → { resolve, timer, chatId, messageId }

  async function request(chatId, what, detail, { allowAll = false } = {}) {
    const id = crypto.randomBytes(4).toString('hex');
    const text = '🔐 Approval needed: ' + what + (detail ? '\n\n' + String(detail).slice(0, 1500) : '') + '\n\nAllow this? Tap a button, or reply yes / no' + (allowAll ? ' / yes all.' : '.');
    const rows = [[['✅ Allow', 'ok:' + id], ['❌ Deny', 'no:' + id]]];
    if (allowAll) rows.push([['✅ Allow all (this job)', 'al:' + id]]);
    const msg = await tg.send(chatId, text, buttons(rows));
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(id, false, 'no answer within ' + Math.round(timeoutMs / 60000) + ' minutes'), timeoutMs);
      pending.set(id, { resolve, timer, chatId, messageId: msg && msg.message_id });
    });
  }

  function finish(id, allowed, note, all = false) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimeout(p.timer);
    if (p.messageId) tg.clearButtons(p.chatId, p.messageId);
    if (!allowed && note) tg.send(p.chatId, '⌛ Approval timed out (' + note + ') — I did not do it.').catch(() => null);
    p.resolve({ allowed, note, all: allowed && all });
    return true;
  }

  // callback data "ok:<id>" / "no:<id>" → true when it matched a waiting request
  function handle(data) {
    const m = /^(ok|no|al):([0-9a-f]{8})$/.exec(String(data || ''));
    if (!m) return null;
    const allowed = m[1] !== 'no';
    return finish(m[2], allowed, undefined, m[1] === 'al') ? (m[1] === 'al' ? 'Allowed for the rest of this job' : allowed ? 'Allowed' : 'Denied') : 'Already answered';
  }

  // A typed "yes" / "no" answers the newest waiting request (in case the buttons are not visible).
  function answerLatest(allowed, all = false) {
    const ids = [...pending.keys()];
    return ids.length ? finish(ids[ids.length - 1], allowed, undefined, all) : false;
  }

  function cancelAll() { for (const id of [...pending.keys()]) finish(id, false); }

  return { request, handle, answerLatest, cancelAll, get waiting() { return pending.size; } };
}
