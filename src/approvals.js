// "Allow / Deny" buttons in Telegram for risky actions. A request that gets no
// answer within the timeout is denied, and the boss is told why.

import crypto from 'node:crypto';
import { buttons } from './telegram.js';

export function makeApprovals(tg, { timeoutMs = 15 * 60000 } = {}) {
  const pending = new Map(); // id → { resolve, timer, chatId, messageId }

  async function request(chatId, what, detail) {
    const id = crypto.randomBytes(4).toString('hex');
    const text = '🔐 Approval needed: ' + what + (detail ? '\n\n' + String(detail).slice(0, 1500) : '') + '\n\nAllow this? Tap a button, or reply yes / no.';
    const msg = await tg.send(chatId, text, buttons([[['✅ Allow', 'ok:' + id], ['❌ Deny', 'no:' + id]]]));
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(id, false, 'no answer within ' + Math.round(timeoutMs / 60000) + ' minutes'), timeoutMs);
      pending.set(id, { resolve, timer, chatId, messageId: msg && msg.message_id });
    });
  }

  function finish(id, allowed, note) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimeout(p.timer);
    if (p.messageId) tg.clearButtons(p.chatId, p.messageId);
    if (!allowed && note) tg.send(p.chatId, '⌛ Approval timed out (' + note + ') — I did not do it.').catch(() => null);
    p.resolve({ allowed, note });
    return true;
  }

  // callback data "ok:<id>" / "no:<id>" → true when it matched a waiting request
  function handle(data) {
    const m = /^(ok|no):([0-9a-f]{8})$/.exec(String(data || ''));
    if (!m) return null;
    return finish(m[2], m[1] === 'ok') ? (m[1] === 'ok' ? 'Allowed' : 'Denied') : 'Already answered';
  }

  // A typed "yes" / "no" answers the newest waiting request (in case the buttons are not visible).
  function answerLatest(allowed) {
    const ids = [...pending.keys()];
    return ids.length ? finish(ids[ids.length - 1], allowed) : false;
  }

  function cancelAll() { for (const id of [...pending.keys()]) finish(id, false); }

  return { request, handle, answerLatest, cancelAll, get waiting() { return pending.size; } };
}
