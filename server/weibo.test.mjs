import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, stat, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWeiboHandler } from './weibo.mjs';

const ACCOUNT = { uid: '1234567890', name: '我的微博', avatarUrl: 'https://example.com/avatar.png' };
const NOW = Date.parse('2026-09-14T09:00:00.000Z');
const RECEIPT = { id: '5071234567890123', url: 'https://weibo.com/detail/5071234567890123', publishedAt: new Date(NOW).toISOString(), account: ACCOUNT };
const PAYLOAD = { requestId: 'request-00001', contentId: 'post-1', expectedAccountUid: ACCOUNT.uid, title: '测试标题', body: '我的第一条微博', images: [] };
const PNG = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')}`;

function fakeBrowser(overrides = {}) {
  const calls = [];
  let connected = false;
  let browserOpen = false;
  const state = () => ({ connected, browserOpen, ...(connected ? { account: ACCOUNT } : {}) });
  return {
    calls,
    async status() { calls.push(['status']); return state(); },
    async login() { calls.push(['login']); connected = true; browserOpen = true; return state(); },
    async close() { calls.push(['close']); browserOpen = false; return state(); },
    async disconnect() { calls.push(['disconnect']); connected = false; browserOpen = false; return state(); },
    async publish(value, hooks) { calls.push(['publish', value]); await hooks.beforeSubmit(); return RECEIPT; },
    ...overrides,
  };
}

async function fixture(t, { browser = fakeBrowser(), env } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'fatiao-weibo-test-'));
  let handler;
  const server = createServer(async (req, res) => {
    if (!await handler(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  env = { ...env, APP_ORIGIN: base };
  handler = createWeiboHandler({ dataDir, browser, now: () => NOW, env });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    await rm(`${dataDir}.backup`, { recursive: true, force: true });
  });
  return {
    browser, dataDir,
    restart(replacement = browser) { handler = createWeiboHandler({ dataDir, browser: replacement, now: () => NOW, env }); },
    async request(route, { method = 'GET', body, headers = {}, raw } = {}) {
      const response = await fetch(`${base}${route}`, {
        method,
        ...(method === 'POST' ? { headers: { Origin: base, 'Content-Type': 'application/json', 'x-fatiao-request': '1', ...headers }, body: raw ?? JSON.stringify(body ?? {}) } : { headers }),
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
    },
    publish(payload = PAYLOAD) { return this.request('/api/weibo/publish', { method: 'POST', body: payload }); },
  };
}

test('account, login, refresh, close and disconnect expose only safe browser state', async (t) => {
  const app = await fixture(t);
  let result = await app.request('/api/weibo/account');
  assert.equal(result.body.mode, 'browser');
  assert.equal(result.body.connected, false);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  result = await app.request('/api/weibo/login', { method: 'POST' });
  assert.equal(result.body.publishReady, true);
  assert.equal(result.body.account.name, ACCOUNT.name);
  assert.equal(result.body.account.profileUrl, 'https://weibo.com/u/1234567890');
  result = await app.request('/api/weibo/refresh', { method: 'POST' });
  assert.equal(result.body.connected, true);
  result = await app.request('/api/weibo/close', { method: 'POST' });
  assert.equal(result.body.browserOpen, false);
  assert.equal(result.body.connected, true);
  result = await app.request('/api/weibo/disconnect', { method: 'POST' });
  assert.equal(result.body.connected, false);
  assert.deepEqual(app.browser.calls.map(([method]) => method), ['status', 'login', 'status', 'close', 'disconnect']);
});

test('mutations require configured origin, custom header and JSON content type', async (t) => {
  const app = await fixture(t);
  for (const headers of [{ Origin: 'https://attacker.example' }, { Origin: 'null' }, { Origin: '' }, { 'x-fatiao-request': '' }]) {
    const result = await app.request('/api/weibo/login', { method: 'POST', headers });
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, 'FORBIDDEN_ORIGIN');
  }
  assert.equal((await app.request('/api/weibo/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await app.request('/api/weibo/login')).status, 405);
  assert.equal((await app.request('/api/weibo/nonexistent')).status, 404);
  assert.equal((await app.request('/not-the-connector')).status, 404);
  assert.equal(app.browser.calls.length, 0);
});

test('malformed, non-object and oversized JSON are rejected without browser effects', async (t) => {
  const app = await fixture(t);
  for (const raw of ['{', '[]', 'null', '"text"', '']) {
    const result = await app.request('/api/weibo/publish', { method: 'POST', raw });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'INVALID_JSON');
  }
  const result = await app.request('/api/weibo/publish', { method: 'POST', raw: 'x'.repeat(18 * 1024 * 1024 + 1) });
  assert.equal(result.status, 413);
  assert.equal(result.body.error.code, 'BODY_TOO_LARGE');
  assert.equal(app.browser.calls.length, 0);
});

test('publish validates identifiers, content, count, image data and size before browser access', async (t) => {
  const app = await fixture(t);
  const invalid = [
    { requestId: 'short' }, { requestId: '../../secret' }, { contentId: '' },
    { expectedAccountUid: undefined }, { expectedAccountUid: 12345 }, { expectedAccountUid: 'other-account' },
    { title: ' ', body: ' ' }, { title: null }, { body: 'x'.repeat(10001) },
    { images: 'https://example.com/pic.png' }, { images: Array(5).fill(PNG) },
    { images: ['https://example.com/pic.png'] }, { images: ['data:image/svg+xml;base64,AAAA'] },
    { images: ['data:image/png;base64,aGVsbG8='] }, { images: ['data:image/png;base64,!!!!'] },
    { images: [`data:image/png;base64,${Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64')}`] },
  ];
  for (const change of invalid) assert.equal((await app.publish({ ...PAYLOAD, ...change })).status, 400);
  assert.equal(app.browser.calls.length, 0);
});

test('text and optional images reach driver; checkpoint is durable before Submit; success is private', async (t) => {
  let app;
  const browser = fakeBrowser({ async publish(value, hooks) {
    this.calls.push(['publish', value]);
    await assert.rejects(readFile(path.join(app.dataDir, 'weibo-publish-ledger.json')), { code: 'ENOENT' });
    await hooks.beforeSubmit();
    const pending = JSON.parse(await readFile(path.join(app.dataDir, 'weibo-publish-ledger.json'), 'utf8'));
    assert.equal(pending.records[PAYLOAD.requestId].state, 'pending');
    return { ...RECEIPT, cookies: 'NEVER_EXPOSE' };
  } });
  app = await fixture(t, { browser });
  const result = await app.publish({ ...PAYLOAD, title: '  测试标题 ', body: '\n我的第一条微博\n', images: [PNG] });
  assert.equal(result.status, 200);
  assert.equal(result.body.requestId, PAYLOAD.requestId);
  assert.equal(result.body.id, RECEIPT.id);
  assert.equal(JSON.stringify(result.body).includes('NEVER_EXPOSE'), false);
  assert.deepEqual(browser.calls[0][1], { expectedAccountUid: ACCOUNT.uid, title: PAYLOAD.title, body: PAYLOAD.body, images: [PNG] });
  const content = await readFile(path.join(app.dataDir, 'weibo-publish-ledger.json'), 'utf8');
  assert.equal(content.includes(PAYLOAD.body), false);
  assert.equal(content.includes(PNG), false);
  assert.equal((await stat(app.dataDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(app.dataDir, 'weibo-publish-ledger.json'))).mode & 0o777, 0o600);
  const receipts = await app.request('/api/weibo/receipts');
  assert.equal(receipts.body.receipts.length, 1);
  assert.equal(receipts.body.receipts[0].contentId, PAYLOAD.contentId);
});

test('JPEG, GIF and WebP uploads are accepted without fetching external images', async (t) => {
  const app = await fixture(t);
  const images = [
    `data:image/jpg;base64,${Buffer.from([255, 216, 255, 0]).toString('base64')}`,
    `data:image/gif;base64,${Buffer.from('GIF89a').toString('base64')}`,
    `data:image/webp;base64,${Buffer.from('RIFF0000WEBP').toString('base64')}`,
  ];
  const result = await app.publish({ ...PAYLOAD, images });
  assert.equal(result.status, 200);
  assert.equal(app.browser.calls[0][1].images[0].startsWith('data:image/jpeg;'), true);
});

test('same request is coalesced concurrently, survives restart and cannot change payload', async (t) => {
  let resume;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  const browser = fakeBrowser({ async publish(value, hooks) {
    this.calls.push(['publish', value]);
    started();
    await gate;
    await hooks.beforeSubmit();
    return RECEIPT;
  } });
  const app = await fixture(t, { browser });
  const first = app.publish();
  await ready;
  const second = app.publish();
  const conflict = await app.publish({ ...PAYLOAD, body: '变更内容' });
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  const busy = await app.publish({ ...PAYLOAD, requestId: 'request-other', contentId: 'post-2' });
  assert.equal(busy.body.error.code, 'PUBLISH_BUSY');
  assert.equal((await app.request('/api/weibo/disconnect', { method: 'POST' })).body.error.code, 'PUBLISH_BUSY');
  resume();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body);
  assert.equal(browser.calls.length, 1);
  app.restart();
  assert.deepEqual((await app.publish()).body, a.body);
  assert.equal(browser.calls.length, 1);
  assert.equal((await app.publish({ ...PAYLOAD, title: '改变标题' })).body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await app.publish({ ...PAYLOAD, expectedAccountUid: '99887766' })).body.error.code, 'IDEMPOTENCY_CONFLICT');
  await app.request('/api/weibo/disconnect', { method: 'POST' });
  assert.equal((await app.request('/api/weibo/receipts')).body.receipts.length, 1);
});

test('driver failures before checkpoint are safe to retry and never reveal raw errors', async (t) => {
  let attempts = 0;
  const browser = fakeBrowser({ async publish(value, hooks) {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('cookies=SECRET_AUTH'), { code: 'LOGIN_REQUIRED' });
    await hooks.beforeSubmit();
    return RECEIPT;
  } });
  const app = await fixture(t, { browser });
  const first = await app.publish();
  assert.equal(first.status, 401);
  assert.equal(first.body.error.code, 'LOGIN_REQUIRED');
  assert.equal(JSON.stringify(first.body).includes('SECRET_AUTH'), false);
  assert.equal((await app.request('/api/weibo/receipts')).body.receipts.length, 0);
  assert.equal((await app.publish()).status, 200);
  assert.equal(attempts, 2);
});

test('lost response after checkpoint remains uncertain across restart and blocks a new key for same content', async (t) => {
  let attempts = 0;
  const browser = fakeBrowser({ async publish(value, hooks) {
    attempts += 1;
    await hooks.beforeSubmit();
    throw Object.assign(new Error('Navigation timeout private details'), { code: 'UI_CHANGED', submitted: true });
  } });
  const app = await fixture(t, { browser });
  const first = await app.publish();
  assert.equal(first.status, 409);
  assert.equal(first.body.error.code, 'PUBLISH_UNCERTAIN');
  assert.equal((await app.publish()).body.error.code, 'PUBLISH_UNCERTAIN');
  app.restart();
  assert.equal((await app.publish({ ...PAYLOAD, requestId: 'request-new-id', body: '编辑也不能绕过确认' })).body.error.code, 'PUBLISH_UNCERTAIN');
  assert.equal((await app.request('/api/weibo/receipts')).body.receipts.length, 0);
  assert.equal(attempts, 1);
});

test('invalid or missing browser receipt never becomes published', async (t) => {
  const browser = fakeBrowser({ async publish(value, hooks) { await hooks.beforeSubmit(); return { ...RECEIPT, id: undefined }; } });
  const app = await fixture(t, { browser });
  assert.equal((await app.publish()).body.error.code, 'PUBLISH_UNCERTAIN');
  assert.equal((await app.request('/api/weibo/receipts')).body.receipts.length, 0);
  app.restart();
  assert.equal((await app.publish()).body.error.code, 'PUBLISH_UNCERTAIN');
});

test('corrupt ledger fails closed before any browser action', async (t) => {
  const app = await fixture(t);
  await writeFile(path.join(app.dataDir, 'weibo-publish-ledger.json'), '{broken');
  assert.equal((await app.publish()).body.error.code, 'STORAGE_ERROR');
  assert.equal(app.browser.calls.length, 0);
});

test('failed checkpoint persistence prevents submitting and remains a known storage error', async (t) => {
  let reachedSubmit = false;
  let app;
  const browser = fakeBrowser({ async publish(value, hooks) {
    await rename(app.dataDir, `${app.dataDir}.backup`);
    await writeFile(app.dataDir, 'blocks directory creation');
    await hooks.beforeSubmit();
    reachedSubmit = true;
    return RECEIPT;
  } });
  app = await fixture(t, { browser });
  const result = await app.publish();
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'STORAGE_ERROR');
  assert.equal(reachedSubmit, false);
});

test('lost local receipt save returns confirmed receipt and disk checkpoint prevents resend', async (t) => {
  let app;
  let attempts = 0;
  const browser = fakeBrowser({ async publish(value, hooks) {
    attempts += 1;
    await hooks.beforeSubmit();
    await rename(app.dataDir, `${app.dataDir}.backup`);
    await writeFile(app.dataDir, 'temporarily unavailable');
    return RECEIPT;
  } });
  app = await fixture(t, { browser });
  const result = await app.publish();
  assert.equal(result.status, 200);
  assert.equal(result.body.id, RECEIPT.id);
  assert.equal(result.body.warning.code, 'RECEIPT_NOT_SAVED');
  assert.equal((await app.publish()).body.id, RECEIPT.id);
  await rm(app.dataDir);
  await rename(`${app.dataDir}.backup`, app.dataDir);
  app.restart();
  assert.equal((await app.publish()).body.error.code, 'PUBLISH_UNCERTAIN');
  assert.equal(attempts, 1);
});

test('arbitrary browser failure and status fields cannot leak session data', async (t) => {
  const browser = fakeBrowser({
    async status() { return { connected: false, browserOpen: true, message: 'cookie=SECRET', cookies: 'SECRET' }; },
    async login() { throw new Error('cookie=SECRET'); },
  });
  const app = await fixture(t, { browser });
  const state = await app.request('/api/weibo/account');
  assert.equal(JSON.stringify(state.body).includes('SECRET'), false);
  const error = await app.request('/api/weibo/login', { method: 'POST' });
  assert.equal(error.body.error.code, 'BROWSER_ERROR');
  assert.equal(JSON.stringify(error.body).includes('SECRET'), false);
});

test('a switched account is rejected before submitting and can be retried after review', async (t) => {
  let attempts = 0;
  const browser = fakeBrowser({ async publish(value, hooks) {
    assert.equal(value.expectedAccountUid, ACCOUNT.uid);
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('live identity differs'), { code: 'ACCOUNT_CHANGED' });
    await hooks.beforeSubmit();
    return RECEIPT;
  } });
  const app = await fixture(t, { browser });
  const first = await app.publish();
  assert.equal(first.status, 409);
  assert.equal(first.body.error.code, 'ACCOUNT_CHANGED');
  assert.equal((await app.request('/api/weibo/receipts')).body.receipts.length, 0);
  assert.equal((await app.publish()).status, 200);
});

test('a receipt for an unexpected account remains uncertain and cannot be retried', async (t) => {
  const browser = fakeBrowser({ async publish(value, hooks) {
    await hooks.beforeSubmit();
    return { ...RECEIPT, account: { ...ACCOUNT, uid: '99887766' } };
  } });
  const app = await fixture(t, { browser });
  assert.equal((await app.publish()).body.error.code, 'PUBLISH_UNCERTAIN');
  assert.equal((await app.request('/api/weibo/receipts')).body.receipts.length, 0);
  app.restart();
  assert.equal((await app.publish()).body.error.code, 'PUBLISH_UNCERTAIN');
});
