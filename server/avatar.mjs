const ROUTE = '/api/platforms/weibo/avatar';
const MAX_BYTES = 256 * 1024;
const MAX_CACHE_ENTRIES = 32;
const CACHE_MS = 60_000;
const AVATAR_HOST = /^(?:tva[1-4]|tvax[1-4])\.sinaimg\.cn$/;
const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function avatarUrl(source) {
  const url = new URL(source);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !AVATAR_HOST.test(url.hostname)) throw new Error('Invalid avatar URL');
  return url.href;
}

function validSignature(bytes, mime) {
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  return bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}

/** Public Weibo avatar bytes only; no cookies, browser session, or local file access. */
export function createAvatarHandler({ env = process.env, fetchImpl = fetch, now = Date.now, timeoutMs = 5000 } = {}) {
  const origin = new URL(env.APP_ORIGIN || 'http://localhost:5173');
  const cache = new Map();
  const pending = new Map();
  const error = (res, status, message) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: { code: 'AVATAR_UNAVAILABLE', message } }));
  };
  async function download(url) {
    const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'image/jpeg,image/png,image/gif,image/webp' } });
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const rejectResponse = async () => { await response.body?.cancel().catch(() => {}); throw new Error('Invalid avatar response'); };
    if (!response.ok || !MIME_TYPES.has(mime) || !response.body) return rejectResponse();
    const length = response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) return rejectResponse();
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) throw new Error('Avatar too large');
        chunks.push(value);
      }
    } catch (cause) { await reader.cancel().catch(() => {}); throw cause; }
    finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks, total);
    if (!bytes.length || !validSignature(bytes, mime)) throw new Error('Invalid avatar image');
    const image = { bytes, mime, expiresAt: now() + CACHE_MS };
    while (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(url, image);
    return image;
  }
  return async (req, res) => {
    const requestUrl = new URL(req.url, origin);
    if (requestUrl.pathname !== ROUTE) return false;
    if (req.headers.host !== origin.host || req.headers.origin && req.headers.origin !== origin.origin) {
      error(res, 403, '不允许从此来源读取头像。'); return true;
    }
    if (req.method !== 'GET') { error(res, 405, '此接口仅支持读取头像。'); return true; }
    let url;
    try {
      if (requestUrl.searchParams.getAll('url').length !== 1 || [...requestUrl.searchParams.keys()].some(key => key !== 'url')) throw new Error();
      const source = requestUrl.searchParams.get('url');
      if (!source || source.length > 2048) throw new Error();
      url = avatarUrl(source);
    } catch { error(res, 400, '头像地址无效。'); return true; }
    try {
      for (const [key, value] of cache) if (value.expiresAt <= now()) cache.delete(key);
      let image = cache.get(url);
      if (!image) {
        if (!pending.has(url)) {
          if (pending.size >= 8) { error(res, 429, '头像正在加载，请稍后重试。'); return true; }
          const job = download(url).finally(() => pending.delete(url));
          pending.set(url, job);
        }
        image = await pending.get(url);
      }
      res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.bytes.length, 'Cache-Control': 'private, max-age=60', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' });
      res.end(image.bytes);
    } catch { error(res, 502, '头像暂时无法加载。'); }
    return true;
  };
}
