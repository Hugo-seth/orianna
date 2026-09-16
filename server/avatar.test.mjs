import assert from 'node:assert/strict';
import test from 'node:test';
import { createAvatarHandler } from './avatar.mjs';

const source = 'https://tva4.sinaimg.cn/crop.0.0.100.100.180/avatar.jpg';
const jpeg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
const image = () => new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } });
async function request(handler, url = source, overrides = {}) {
  const req = { method: 'GET', url: `/api/platforms/weibo/avatar?url=${encodeURIComponent(url)}`, headers: { host: 'localhost:5173' }, ...overrides };
  const response = { status: 0, headers: {}, body: Buffer.alloc(0), writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = Buffer.from(body || ''); } };
  const handled = await handler(req, response);
  return { ...response, handled };
}

test('public Weibo avatars preserve exact image bytes without forwarding cookies and cache briefly', async () => {
  const calls = [];
  let stamp = 1000;
  const handler = createAvatarHandler({ now: () => stamp, fetchImpl: async (url, options) => { calls.push({ url, options }); return image(); } });
  const result = await request(handler);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, jpeg);
  assert.equal(result.headers['Content-Type'], 'image/jpeg');
  assert.equal(result.headers['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(calls[0].url, source);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(calls[0].options.headers), ['Accept']);
  await request(handler);
  assert.equal(calls.length, 1);
  stamp += 60_001;
  await request(handler);
  assert.equal(calls.length, 2);
});

test('only exact HTTPS Weibo avatar hosts are accepted; other routes, methods and origins cannot proxy requests', async () => {
  let calls = 0;
  const handler = createAvatarHandler({ fetchImpl: async () => { calls++; return image(); } });
  for (const url of ['http://tva4.sinaimg.cn/avatar.jpg', 'https://sinaimg.cn/avatar.jpg', 'https://wx1.sinaimg.cn/avatar.jpg', 'https://tva4.sinaimg.cn.evil.test/a.jpg', 'https://evil.tva4.sinaimg.cn/a.jpg', 'https://user:pass@tva4.sinaimg.cn/a.jpg', 'https://tva4.sinaimg.cn:8080/a.jpg', 'https://tva4.sinaimg.cn/a.jpg#x', 'file:///private/avatar.jpg', 'https://127.0.0.1/avatar.jpg']) {
    assert.equal((await request(handler, url)).status, 400);
  }
  assert.equal((await request(handler, source, { url: '/api/platforms/weibo/avatar?url=a&url=b' })).status, 400);
  assert.equal((await request(handler, source, { method: 'POST' })).status, 405);
  assert.equal((await request(handler, source, { headers: { host: 'evil.test' } })).status, 403);
  assert.equal((await request(handler, source, { headers: { host: 'localhost:5173', origin: 'https://evil.test' } })).status, 403);
  assert.equal((await request(handler, source, { url: '/api/platforms/weibo/account' })).handled, false);
  assert.equal(calls, 0);
  for (const host of ['tva1.sinaimg.cn', 'tva4.sinaimg.cn', 'tvax1.sinaimg.cn', 'tvax4.sinaimg.cn']) assert.equal((await request(handler, `https://${host}/avatar.jpg`)).status, 200);
});

test('non-images, mismatched image signatures, empty responses and redirects are rejected without caching', async () => {
  let reply;
  let calls = 0;
  const handler = createAvatarHandler({ fetchImpl: async () => { calls++; return reply(); } });
  for (const response of [
    () => new Response('<html>denied</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('<html>denied</html>', { headers: { 'Content-Type': 'image/jpeg' } }),
    () => new Response(jpeg, { headers: { 'Content-Type': 'image/svg+xml' } }),
    () => new Response(null, { headers: { 'Content-Type': 'image/jpeg' } }),
    () => new Response(null, { status: 302, headers: { Location: 'http://localhost/private' } }),
    () => { throw new Error('private upstream diagnostic'); },
  ]) {
    reply = response;
    const result = await request(handler);
    assert.equal(result.status, 502);
    assert.equal(result.body.includes('private'), false);
  }
  reply = image;
  assert.equal((await request(handler)).status, 200);
  assert.equal(calls, 7);
});

test('oversized Content-Length and streaming bodies are bounded to 256 KiB', async () => {
  let cancelled = false;
  let reply = () => new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(256 * 1024 + 1) } });
  const handler = createAvatarHandler({ fetchImpl: async () => reply() });
  assert.equal((await request(handler)).status, 502);
  reply = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'image/jpeg' } });
  assert.equal((await request(handler)).status, 502);
  assert.equal(cancelled, true);
});

test('concurrent requests share one download, failures can retry, and cache has a fixed entry bound', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = createAvatarHandler({ fetchImpl: async () => { calls++; await gate; return image(); } });
  const first = request(handler);
  const second = request(handler);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(calls, 1);
  for (let i = 0; i < 32; i++) await request(handler, `https://tva4.sinaimg.cn/${i}.jpg`);
  await request(handler);
  assert.equal(calls, 34);
});

test('download timeout produces an actionable failure and stops the request', async () => {
  let aborted = false;
  const handler = createAvatarHandler({ timeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(image()), 1000);
    signal.addEventListener('abort', () => { aborted = true; clearTimeout(timer); reject(signal.reason); }, { once: true });
  }) });
  assert.equal((await request(handler)).status, 502);
  assert.equal(aborted, true);
});
