// Shared helpers for the specialist providers (OpenAI, Gemini, xAI).

export class ProviderError extends Error {
  constructor(provider, status, detail) {
    super(provider + ' ' + status + (detail ? ': ' + String(detail).slice(0, 300) : ''));
    this.provider = provider; this.status = status;
  }
}

export async function http(fetchImpl, provider, url, { method = 'GET', headers = {}, body, timeoutMs = 120000, raw = false } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method, signal: ctrl.signal,
      headers: Object.assign(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}, headers),
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body)
    });
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = (j.error && (j.error.message || j.error)) || j.message || JSON.stringify(j); } catch { /* not json */ }
      throw new ProviderError(provider, res.status, detail);
    }
    return raw ? res : res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new ProviderError(provider, 'timeout', 'no answer within ' + Math.round(timeoutMs / 1000) + 's');
    throw e;
  } finally { clearTimeout(t); }
}

// Try the strongest request first; if the provider rejects a setting (400/404/422),
// fall back to simpler variants. Other errors (auth, rate limit, outage) stop at once.
export async function tryVariants(variants, run) {
  let lastErr;
  for (let i = 0; i < variants.length; i++) {
    try { return Object.assign(await run(variants[i]), { variant: variants[i].label || i }); }
    catch (e) {
      lastErr = e;
      if (!(e instanceof ProviderError) || ![400, 404, 422].includes(e.status)) throw e;
    }
  }
  throw lastErr;
}

// "gemini-3.8-pro" → [3, 8]; used to find the newest model in a family.
export function versionOf(id) {
  const m = String(id).match(/(\d+(?:\.\d+)*)/);
  return m ? m[1].split('.').map(Number).slice(0, 3) : [0];
}
// The minor part is compared as a decimal, the way model names are read:
// grok-4.7 is newer than grok-4.20 (4.7 > 4.2).
function versionNum(id) {
  const m = String(id).match(/(\d+)(?:\.(\d+))?/);
  return m ? Number(m[1]) + (m[2] ? Number('0.' + m[2]) : 0) : 0;
}
const UNSTABLE = /preview|exp|beta/i;
export function newerFirst(a, b) {
  const d = versionNum(b.id) - versionNum(a.id);
  if (d) return d;
  const u = (UNSTABLE.test(a.id) ? 1 : 0) - (UNSTABLE.test(b.id) ? 1 : 0);   // a stable release before its preview
  if (u) return u;
  return (b.created || 0) - (a.created || 0);
}
