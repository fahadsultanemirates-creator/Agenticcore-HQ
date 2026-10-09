// Telegram Bot API over plain fetch. Long polling (getUpdates), so the VPS
// needs no public address, domain or certificate.

import fs from 'node:fs';
import path from 'node:path';

const LIMIT = 4000; // Telegram allows 4096 characters per message

// Long replies are split on paragraph / line / word boundaries.
export function chunkText(text, size = LIMIT) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  const out = [];
  let rest = s;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export function buttons(rows) {
  return { reply_markup: { inline_keyboard: rows.map((r) => r.map(([text, data]) => ({ text, callback_data: data }))) } };
}

const KIND = {
  photo: ['sendPhoto', 'photo'], video: ['sendVideo', 'video'], voice: ['sendVoice', 'voice'],
  audio: ['sendAudio', 'audio'], document: ['sendDocument', 'document']
};

export function kindForFile(name) {
  const ext = path.extname(String(name)).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return 'photo';
  if (['.mp4', '.mov', '.webm'].includes(ext)) return 'video';
  if (['.ogg', '.oga'].includes(ext)) return 'voice';
  if (['.mp3', '.m4a', '.wav'].includes(ext)) return 'audio';
  return 'document';
}

export function makeTelegram(token, fetchImpl = globalThis.fetch) {
  const base = 'https://api.telegram.org/bot' + token + '/';

  async function call(method, params, { timeoutMs = 60000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const body = params instanceof FormData ? params : JSON.stringify(params || {});
      const headers = params instanceof FormData ? {} : { 'Content-Type': 'application/json' };
      const res = await fetchImpl(base + method, { method: 'POST', headers, body, signal: ctrl.signal });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) { const e = new Error('telegram ' + method + ': ' + (data.description || res.status)); e.code = data.error_code || res.status; throw e; }
      return data.result;
    } finally { clearTimeout(t); }
  }

  async function send(chatId, text, extra = {}) {
    const parts = chunkText(text);
    let last = null;
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      last = await call('sendMessage', Object.assign({ chat_id: chatId, text: parts[i], link_preview_options: { is_disabled: true } }, isLast ? extra : {}));
    }
    return last;
  }

  // file: a path on disk or { bytes: Buffer, name: 'x.mp3' }
  async function sendFile(chatId, file, { kind, caption } = {}) {
    const name = typeof file === 'string' ? path.basename(file) : file.name;
    const bytes = typeof file === 'string' ? fs.readFileSync(file) : file.bytes;
    const k = kind || kindForFile(name);
    const [method, field] = KIND[k] || KIND.document;
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (caption) form.set('caption', String(caption).slice(0, 1000));
    form.set(field, new Blob([bytes]), name);
    try { return await call(method, form, { timeoutMs: 180000 }); }
    catch (e) {
      if (k === 'document') throw e;
      return sendFile(chatId, file, { kind: 'document', caption }); // e.g. a photo too large: send as a file instead
    }
  }

  async function download(fileId, maxBytes = 20 * 1024 * 1024) {
    const f = await call('getFile', { file_id: fileId });
    if (f.file_size && f.file_size > maxBytes) throw new Error('file too large');
    const res = await fetchImpl('https://api.telegram.org/file/bot' + token + '/' + f.file_path);
    if (!res.ok) throw new Error('download ' + res.status);
    return { bytes: Buffer.from(await res.arrayBuffer()), path: f.file_path };
  }

  return {
    call, send, sendFile, download,
    getUpdates: (offset, timeout = 50) => call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: (timeout + 15) * 1000 }),
    typing: (chatId, action = 'typing') => call('sendChatAction', { chat_id: chatId, action }).catch(() => null),
    answer: (id, text) => call('answerCallbackQuery', { callback_query_id: id, text: text || '' }).catch(() => null),
    clearButtons: (chatId, messageId) => call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => null),
    setCommands: (commands) => call('setMyCommands', { commands }).catch(() => null)
  };
}
