import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlatformsHandler } from './platforms.mjs';

const PLATFORMS = ['weibo', 'xiaohongshu', 'douyin', 'bilibili'];
const NOW = Date.parse('2026-09-14T09:00:00.000Z');
const PNG = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')}`;
const ACCOUNTS = {
  weibo: { uid: '1234567890', name: '我的微博', avatarUrl: 'https://tvax1.sinaimg.cn/avatar.png' },
  xiaohongshu: { uid: '65b123456789012345678901', name: '我的小红书', avatarUrl: 'https://sns-avatar-qc.xhscdn.com/avatar.png' },
  douyin: { uid: 'MS4wLjABAAAA_test-user-123', name: '我的抖音', avatarUrl: 'https://p3-pc.douyinpic.com/avatar.png' },
  bilibili: { uid: '12345678', name: '我的B站', avatarUrl: 'https://i0.hdslb.com/bfs/face/avatar.png' },
};
const IDS = { weibo: '5071234567890123', xiaohongshu: '66b123456789012345678901', douyin: '7410123456789012345', bilibili: '1123456789012345678' };
const URLS = { weibo: `https://weibo.com/detail/${IDS.weibo}`, xiaohongshu: `https://www.xiaohongshu.com/explore/${IDS.xiaohongshu}`, douyin: `https://www.douyin.com/note/${IDS.douyin}`, bilibili: `https://t.bilibili.com/${IDS.bilibili}` };
const receipt = platform => ({ id: IDS[platform], url: URLS[platform], publishedAt: new Date(NOW).toISOString(), account: ACCOUNTS[platform] });
const payload = (platform, overrides = {}) => ({ requestId: 'request-00001', contentId: 'post-1', expectedAccountUid: ACCOUNTS[platform].uid, title: '图文标题', body: '测试内容', images: [PNG], ...overrides });

function fakeBrowser(platform, overrides = {}) {
  const calls = [];
  const state = () => ({ mode: 'browser', connected: true, browserOpen: true, publishReady: true, sessionSaved: true, headless: true, account: ACCOUNTS[platform] });
  return {
    calls,
    async status() { calls.push(['status']); return state(); },
    async login(options) { calls.push(['login', options]); return state(); },
    async open() { calls.push(['open']); return { ...state(), headless: false }; },
    async resume() { calls.push(['resume']); return state(); },
    async refresh() { calls.push(['refresh']); return state(); },
    async close() { calls.push(['close']); return { ...state(), connected: false, browserOpen: false, publishReady: false }; },
    async disconnect() { calls.push(['disconnect']); return { ...state(), connected: false, browserOpen: false, publishReady: false, sessionSaved: false }; },
    async publish(value, hooks) { calls.push(['publish', value]); await hooks.beforeSubmit(); return receipt(platform); },
    async update(value, hooks) { calls.push(['update', value]); await hooks.beforeSubmit(); return { ...value.receipt, updatedAt: new Date(NOW).toISOString() }; },
    async delete(value, hooks) { calls.push(['delete', value]); await hooks.beforeSubmit(); return { ...value.receipt, deletedAt: new Date(NOW).toISOString() }; },
    ...overrides,
  };
}

async function fixture(t, { overrides = {} } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'fatiao-platforms-test-'));
  const browsers = Object.fromEntries(PLATFORMS.map(platform => [platform, fakeBrowser(platform, overrides[platform])]));
  let handler;
  const server = createServer(async (req, res) => {
    if (!await handler(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const restart = () => { handler = createPlatformsHandler({ env: { APP_ORIGIN: origin }, dataDir, browsers, now: () => NOW }); };
  restart();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    await rm(`${dataDir}.backup`, { recursive: true, force: true });
  });
  const request = (route, { method = 'GET', body, headers = {}, raw } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}${route}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Fatiao-Request': '1', ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : undefined }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(method === 'POST' ? raw ?? JSON.stringify(body ?? {}) : undefined);
  });
  return { dataDir, browsers, restart, request,
    publish: (platform, value = payload(platform), legacy = false) => request(legacy ? '/api/weibo/publish' : `/api/platforms/${platform}/publish`, { method: 'POST', body: value }),
    mutate: (platform, type, change = {}, legacy = false) => request(legacy ? `/api/weibo/${type}` : `/api/platforms/${platform}/${type}`, { method: 'POST', body: { requestId: `${type}-request-00001`, contentId: 'post-1', publicationRequestId: 'request-00001', expectedAccountUid: ACCOUNTS[platform].uid, ...(type === 'update' ? { title: '更新标题', body: '更新正文' } : {}), ...change } }),
    reconcile: (platform, operation, change = {}, legacy = false) => request(legacy ? '/api/weibo/reconcile' : `/api/platforms/${platform}/reconcile`, { method: 'POST', body: { operation, ...(operation === 'publish' ? payload(platform) : { requestId: `${operation}-request-00001`, contentId: 'post-1', publicationRequestId: 'request-00001', expectedAccountUid: ACCOUNTS[platform].uid, ...(operation === 'update' ? { title: '更新标题', body: '更新正文' } : {}) }), ...change } }),
    deletionStatus: (contentId = 'post-1') => request(`/api/content/${contentId}/deletion-status`),
  };
}

test('a native verification challenge stays pending, remains actionable, and reconciles without publishing again', async t => {
  let verified = false;
  const app = await fixture(t, { overrides: { douyin: {
    async publish(input, hooks) { this.calls.push(['publish']); await hooks.beforeSubmit(); throw Object.assign(new Error('private provider message'), { code: 'CAPTCHA_REQUIRED', submitted: true }); },
    async reconcilePublication() { this.calls.push(['reconcile']); if (!verified) throw Object.assign(new Error('private'), { code: 'CAPTCHA_REQUIRED', submitted: true }); return receipt('douyin'); },
  } } });
  for (const result of [await app.publish('douyin'), await app.reconcile('douyin', 'publish')]) {
    assert.equal(result.body.error.code, 'CAPTCHA_REQUIRED');
    assert.equal(result.body.error.submitted, true);
    assert.match(result.body.error.message, /核对同一发布请求/);
    assert.doesNotMatch(result.body.error.message, /private/);
  }
  const ledger = JSON.parse(await readFile(path.join(app.dataDir, 'douyin-publish-ledger.json'), 'utf8'));
  assert.equal(ledger.records['request-00001'].state, 'pending');
  assert.equal((await app.deletionStatus()).body.canDelete, false);
  verified = true;
  assert.equal((await app.reconcile('douyin', 'publish')).body.id, IDS.douyin);
  assert.equal(app.browsers.douyin.calls.filter(([method]) => method === 'publish').length, 1);
});

test('all platform account routes expose bounded public identity and connection fields', async t => {
  const app = await fixture(t);
  for (const platform of PLATFORMS) {
    const result = await app.request(`/api/platforms/${platform}/account`);
    assert.equal(result.status, 200);
    assert.equal(result.body.platform, platform);
    assert.equal(result.body.account.uid, ACCOUNTS[platform].uid);
    assert.equal(result.body.account.avatarUrl, ACCOUNTS[platform].avatarUrl);
    assert.equal(result.body.sessionSaved, true);
    assert.equal(result.body.headless, true);
    assert.equal(result.body.publishReady, true);
    assert.equal(result.headers['cache-control'], 'no-store');
  }
  assert.equal((await app.request('/api/platforms/douyin/account')).body.account.profileUrl, `https://www.douyin.com/user/${ACCOUNTS.douyin.uid}`);
});

test('current Chrome account and connection actions expose shared mode without claiming to clear website login', async t => {
  const overrides = Object.fromEntries(PLATFORMS.map(platform => {
    const state = (connected = true, sessionSaved = true) => ({ connected, browserOpen: connected, headless: false, publishReady: connected, sessionSaved,
      ...(sessionSaved ? { account: ACCOUNTS[platform], accountVerification: connected ? 'verified' : 'required' } : {}) });
    return [platform, {
      browserMode: 'current-chrome',
      async status() { return { ...state(), message: '已连接，发布将在后台专用浏览器执行。' }; },
      async login() { return state(); },
      async open() { return state(); },
      async close() { return { ...state(false), message: '微博专用浏览器已关闭，登录信息保存在本机专用配置目录。' }; },
      async disconnect() { return { ...state(false, false), message: '已断开微博账号并清除本应用保存的登录信息。' }; },
    }];
  }));
  const app = await fixture(t, { overrides });
  for (const platform of PLATFORMS) {
    for (const action of ['account', 'login', 'open', 'close', 'disconnect']) {
      const result = await app.request(`/api/platforms/${platform}/${action}`, { method: action === 'account' ? 'GET' : 'POST' });
      assert.equal(result.status, 200);
      assert.equal(result.body.browserMode, 'current-chrome');
      assert.equal(result.body.headless, false);
      assert.doesNotMatch(result.body.message, /专用|清除|配置目录/);
      const connected = !['close', 'disconnect'].includes(action);
      assert.equal(result.body.connected, connected);
      assert.equal(result.body.browserOpen, connected);
      assert.equal(result.body.sessionSaved, action !== 'disconnect');
      assert.equal(result.body.accountVerification, connected ? 'verified' : action === 'close' ? 'required' : undefined);
      assert.equal(result.body.message, connected
        ? '已连接当前 Chrome，发布前会再次核对登录账号。'
        : action === 'close' ? '账号已绑定，发布时会重新打开标签页并核对登录状态。'
          : '点击连接，在当前 Chrome 中打开平台标签页并核对账号。');
    }
  }
  assert.equal((await app.request('/api/weibo/account')).body.browserMode, 'current-chrome');
});

test('cached current Chrome identity stays display-only until verified even when readiness flags are inconsistent', async t => {
  let reportedConnected = false;
  const app = await fixture(t, { overrides: Object.fromEntries(PLATFORMS.map(platform => [platform, {
    browserMode: 'current-chrome',
    async status() { return {
      connected: reportedConnected, browserOpen: false, sessionSaved: true, publishReady: true, accountVerification: 'required',
      account: { ...ACCOUNTS[platform], avatarUrl: 'https://attacker.invalid/SECRET', cookie: 'SECRET' },
      message: 'raw browser SECRET', cookies: 'SECRET',
    }; },
  }])) });
  for (reportedConnected of [false, true]) {
    for (const platform of PLATFORMS) {
      const result = await app.request(`/api/platforms/${platform}/account`);
      assert.equal(result.status, 200);
      assert.equal(result.body.account.uid, ACCOUNTS[platform].uid);
      assert.equal(result.body.account.name, ACCOUNTS[platform].name);
      assert.equal(result.body.accountVerification, 'required');
      assert.equal(result.body.connected, false);
      assert.equal(result.body.publishReady, false);
      assert.equal(result.body.browserOpen, false);
      assert.equal(result.body.sessionSaved, true);
      assert.equal(result.body.message, '账号已绑定，发布时会重新打开标签页并核对登录状态。');
      assert.doesNotMatch(JSON.stringify(result.body), /SECRET|attacker/);
    }
  }
});

test('account verification accepts only supported states and never makes a malformed account connected', async t => {
  let state = { connected: false, browserOpen: false, account: ACCOUNTS.weibo };
  const app = await fixture(t, { overrides: { weibo: { browserMode: 'current-chrome', async status() { return state; } } } });
  for (const accountVerification of ['SECRET', 'VERIFIED', true, {}, ['verified'], null]) {
    state = { ...state, accountVerification };
    const result = await app.request('/api/weibo/account');
    assert.equal(result.body.accountVerification, undefined);
    assert.equal(result.body.connected, false);
    assert.equal(result.body.publishReady, false);
    assert.doesNotMatch(JSON.stringify(result.body), /SECRET|VERIFIED/);
  }
  state = { connected: true, publishReady: true, browserOpen: true, accountVerification: 'verified', account: { uid: 'invalid', name: 'SECRET' } };
  const invalid = await app.request('/api/weibo/account');
  assert.equal(invalid.body.account, undefined);
  assert.equal(invalid.body.accountVerification, undefined);
  assert.equal(invalid.body.connected, false);
  assert.equal(invalid.body.publishReady, false);
});

test('current Chrome connection and tab cleanup errors return fixed guidance without leaking browser details', async t => {
  const cases = [
    ['open', 'CHROME_CONNECTION_REQUIRED', '无法连接当前 Chrome。请先启动 Chrome，在 chrome://inspect/#remote-debugging 开启远程调试，再重试并在 Chrome 弹窗中允许连接。'],
    ['close', 'CHROME_TAB_CLOSE_FAILED', '部分应用标签页未能关闭，请在 Chrome 中手动关闭。其他网页和网站登录状态会保留。'],
  ];
  const overrides = Object.fromEntries(PLATFORMS.map(platform => [platform, {
    browserMode: 'current-chrome',
    ...Object.fromEntries(cases.map(([action, code]) => [action, async () => { throw Object.assign(new Error('SECRET ws://localhost/private-browser-id'), { code }); }])),
  }]));
  const app = await fixture(t, { overrides });
  for (const platform of PLATFORMS) {
    for (const [action, code, message] of cases) {
      const result = await app.request(`/api/platforms/${platform}/${action}`, { method: 'POST' });
      assert.equal(result.status, 503);
      assert.deepEqual(result.body.error, { code, message, submitted: false });
      assert.doesNotMatch(JSON.stringify(result.body), /SECRET|private-browser-id|ws:\/\//);
    }
  }
});

test('drivers without a browser mode retain existing account responses and cannot spoof it through status data', async t => {
  const app = await fixture(t, { overrides: { weibo: {
    async status() { return { connected: true, account: ACCOUNTS.weibo, browserOpen: true, headless: true, browserMode: 'current-chrome', accountVerification: 'required', message: '已连接，发布将在后台专用浏览器执行。' }; },
  } } });
  for (const platform of PLATFORMS) {
    const result = await app.request(`/api/platforms/${platform}/account`);
    assert.equal(result.status, 200);
    assert.equal(Object.hasOwn(result.body, 'browserMode'), false);
    assert.equal(Object.hasOwn(result.body, 'accountVerification'), false);
    assert.equal(result.body.connected, true);
    assert.equal(result.body.headless, true);
  }
  assert.equal((await app.request('/api/weibo/account')).body.message, '已连接，发布将在后台专用浏览器执行。');
});

test('generic login defaults to QR; legacy login defaults to window and explicit open uses own driver', async t => {
  const app = await fixture(t);
  await app.request('/api/platforms/weibo/login', { method: 'POST' });
  await app.request('/api/weibo/login', { method: 'POST' });
  await app.request('/api/platforms/weibo/login', { method: 'POST', body: { mode: 'window' } });
  await app.request('/api/platforms/weibo/open', { method: 'POST' });
  await app.request('/api/platforms/weibo/refresh', { method: 'POST' });
  assert.deepEqual(app.browsers.weibo.calls, [['login', { mode: 'qr' }], ['login', { mode: 'window' }], ['login', { mode: 'window' }], ['open'], ['refresh']]);
  const result = await app.request('/api/platforms/weibo/login', { method: 'POST', body: { mode: '<script>' } });
  assert.equal(result.body.error.code, 'VALIDATION_ERROR');
  assert.equal(result.body.error.submitted, false);
  assert.equal(app.browsers.weibo.calls.length, 5);
});

test('QR status accepts raster data only, preserves absent images and strips all arbitrary fields', async t => {
  let login = { kind: 'qr', image: PNG, expiresAt: '2026-09-14T09:02:00Z', cookie: 'SECRET' };
  const app = await fixture(t, { overrides: { weibo: { async status() { return { connected: false, browserOpen: true, headless: true, login, message: 'cookie=SECRET', cookie: 'SECRET' }; } } } });
  let result = await app.request('/api/platforms/weibo/account');
  assert.deepEqual(result.body.login, { kind: 'qr', image: PNG, expiresAt: '2026-09-14T09:02:00.000Z' });
  assert.equal(JSON.stringify(result.body).includes('SECRET'), false);
  for (const image of ['https://attacker.invalid/session', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,aGVsbG8=', undefined]) {
    login = { kind: 'qr', image };
    result = await app.request('/api/platforms/weibo/account');
    assert.deepEqual(result.body.login, { kind: 'qr' });
  }
  login = { kind: 'window', image: PNG };
  assert.deepEqual((await app.request('/api/platforms/weibo/account')).body.login, { kind: 'window' });
});

test('publishReady false is preserved and driver messages are restricted to local product copy', async t => {
  const app = await fixture(t, { overrides: { douyin: { async status() { return { connected: true, publishReady: false, browserOpen: true, account: { ...ACCOUNTS.douyin, profileUrl: 'https://attacker.invalid', avatarUrl: 'https://douyinpic.com.attacker.invalid/secret' }, message: '已连接，发布将在后台专用浏览器执行。' }; } } } });
  const result = await app.request('/api/platforms/douyin/account');
  assert.equal(result.body.connected, true);
  assert.equal(result.body.publishReady, false);
  assert.equal(result.body.message, '已连接，发布将在后台专用浏览器执行。');
  assert.equal(result.body.account.avatarUrl, undefined);
  assert.equal(JSON.stringify(result.body).includes('attacker'), false);
});

test('every route rejects alien Host and mutations require Origin, header, method and JSON', async t => {
  const app = await fixture(t);
  for (const platform of PLATFORMS) {
    for (const action of ['account', 'receipts', 'login', 'publish']) {
      const result = await app.request(`/api/platforms/${platform}/${action}`, { method: ['login', 'publish'].includes(action) ? 'POST' : 'GET', headers: { Host: 'attacker.invalid' } });
      assert.equal(result.status, 403);
      assert.equal(result.body.error.code, 'FORBIDDEN_HOST');
      assert.equal(result.body.error.submitted, false);
    }
    assert.equal((await app.request(`/api/platforms/${platform}/login`, { method: 'POST', headers: { Origin: 'https://attacker.invalid' } })).body.error.code, 'FORBIDDEN_ORIGIN');
    assert.equal((await app.request(`/api/platforms/${platform}/login`, { method: 'POST', headers: { 'X-Fatiao-Request': '0' } })).status, 403);
    assert.equal((await app.request(`/api/platforms/${platform}/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await app.request(`/api/platforms/${platform}/publish`)).status, 405);
    assert.equal((await app.request(`/api/platforms/${platform}/login`, { method: 'POST', raw: '[]' })).status, 400);
    assert.equal(app.browsers[platform].calls.length, 0);
  }
  assert.equal((await app.request('/api/platforms/constructor/account')).status, 404);
  assert.equal((await app.request('/api/platforms/douyin/noop')).status, 404);
  assert.equal((await app.request('/api/platforms/weibo/publish/extra')).status, 404);
});

test('four-platform payload reaches its own driver and records a private durable checkpoint before submit', async t => {
  let app;
  const overrides = Object.fromEntries(PLATFORMS.map(platform => [platform, { async publish(value, hooks) {
    this.calls.push(['publish', value]);
    await hooks.beforeSubmit();
    const ledger = JSON.parse(await readFile(path.join(app.dataDir, `${platform}-publish-ledger.json`), 'utf8'));
    assert.equal(ledger.records['request-00001'].state, 'pending');
    return { ...receipt(platform), cookies: 'SECRET' };
  } }]));
  app = await fixture(t, { overrides });
  for (const platform of PLATFORMS) {
    const result = await app.publish(platform);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.platform, platform);
    assert.equal(result.body.id, IDS[platform]);
    const ledgerPath = path.join(app.dataDir, `${platform}-publish-ledger.json`);
    const text = await readFile(ledgerPath, 'utf8');
    assert.equal(text.includes('测试内容'), false);
    assert.equal(text.includes(PNG), false);
    assert.equal(text.includes('SECRET'), false);
    assert.equal((await stat(ledgerPath)).mode & 0o777, 0o600);
    assert.equal((await app.request(`/api/platforms/${platform}/receipts`)).body.receipts[0].contentId, 'post-1');
  }
  assert.equal((await stat(app.dataDir)).mode & 0o777, 0o700);
});

test('same request coalesces across legacy and new Weibo aliases, then survives restart', async t => {
  let release;
  let announce;
  const began = new Promise(resolve => { announce = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const app = await fixture(t, { overrides: { weibo: { async publish(value, hooks) { this.calls.push(['publish', value]); announce(); await gate; await hooks.beforeSubmit(); return receipt('weibo'); } } } });
  const first = app.publish('weibo');
  await began;
  const legacy = app.publish('weibo', payload('weibo'), true);
  assert.equal((await app.request('/api/weibo/disconnect', { method: 'POST' })).body.error.code, 'PUBLISH_BUSY');
  assert.equal((await app.publish('weibo', payload('weibo', { title: '变更' }), true)).body.error.code, 'IDEMPOTENCY_CONFLICT');
  release();
  const [a, b] = await Promise.all([first, legacy]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body);
  app.restart();
  assert.deepEqual((await app.publish('weibo', payload('weibo'), true)).body, a.body);
  assert.equal(app.browsers.weibo.calls.length, 1);
  assert.deepEqual((await app.request('/api/weibo/receipts')).body, (await app.request('/api/platforms/weibo/receipts')).body);
});

test('an existing version-one Weibo receipt needs no migration and preserves original request fingerprint', async t => {
  const app = await fixture(t);
  const value = payload('weibo');
  const fingerprint = createHash('sha256').update(JSON.stringify({ contentId: value.contentId, expectedAccountUid: value.expectedAccountUid, title: value.title, body: value.body, images: value.images })).digest('hex');
  await writeFile(path.join(app.dataDir, 'weibo-publish-ledger.json'), JSON.stringify({ version: 1, records: { [value.requestId]: { state: 'success', fingerprint, contentId: value.contentId, receipt: { ...receipt('weibo'), requestId: value.requestId } } } }));
  const result = await app.publish('weibo');
  assert.equal(result.status, 200);
  assert.equal(result.body.platform, 'weibo');
  assert.equal(app.browsers.weibo.calls.length, 0);
  assert.equal((await app.publish('weibo', value, true)).body.id, IDS.weibo);
});

test('an old Weibo pending entry blocks new alias and new request IDs without blocking other platforms', async t => {
  const app = await fixture(t);
  await writeFile(path.join(app.dataDir, 'weibo-publish-ledger.json'), JSON.stringify({ version: 1, records: { 'old-request-id': { state: 'pending', fingerprint: 'a'.repeat(64), contentId: 'post-1' } } }));
  const result = await app.publish('weibo');
  assert.equal(result.body.error.code, 'PUBLISH_UNCERTAIN');
  assert.equal(result.body.error.submitted, true);
  assert.equal(app.browsers.weibo.calls.length, 0);
  assert.equal((await app.publish('bilibili')).status, 200);
});

test('uncertain submission in every platform persists and cannot be retried under a fresh key', async t => {
  const app = await fixture(t, { overrides: Object.fromEntries(PLATFORMS.map(platform => [platform, { async publish(value, hooks) { this.calls.push(['publish']); await hooks.beforeSubmit(); throw Object.assign(new Error('SECRET'), { code: 'IMAGE_UPLOAD_FAILED' }); } }])) });
  for (const platform of PLATFORMS) {
    const result = await app.publish(platform);
    assert.equal(result.body.error.code, 'PUBLISH_UNCERTAIN');
    assert.equal(result.body.error.submitted, true);
    assert.equal(JSON.stringify(result.body).includes('SECRET'), false);
    app.restart();
    assert.equal((await app.publish(platform, payload(platform, { requestId: 'request-another' }))).body.error.code, 'PUBLISH_UNCERTAIN');
    assert.equal(app.browsers[platform].calls.length, 1);
  }
});

test('pre-submit driver errors are explicit, scrubbed and safely retryable', async t => {
  let attempts = 0;
  const app = await fixture(t, { overrides: { douyin: { async publish(value, hooks) { if (++attempts === 1) throw Object.assign(new Error('token=SECRET'), { code: 'ACCOUNT_CHANGED' }); await hooks.beforeSubmit(); return receipt('douyin'); } } } });
  const result = await app.publish('douyin');
  assert.equal(result.body.error.code, 'ACCOUNT_CHANGED');
  assert.equal(result.body.error.submitted, false);
  assert.equal(JSON.stringify(result.body).includes('SECRET'), false);
  assert.equal((await app.publish('douyin')).status, 200);
});

test('unknown driver codes cannot use object prototype properties or leak raw errors', async t => {
  const app = await fixture(t, { overrides: { douyin: { async status() { throw Object.assign(new Error('cookie=SECRET'), { code: 'constructor' }); } } } });
  const result = await app.request('/api/platforms/douyin/account');
  assert.equal(result.body.error.code, 'BROWSER_ERROR');
  assert.equal(result.body.error.submitted, false);
  assert.equal(JSON.stringify(result.body).includes('SECRET'), false);
});

test('each platform rejects receipt identity, ID and URL mismatches after checkpoint', async t => {
  for (const platform of PLATFORMS) {
    for (const change of [{ id: 'not-a-post-id' }, { url: URLS[platform] + '0' }, { url: URLS[platform].replace('.com', '.com.attacker.invalid') }, { account: { ...ACCOUNTS[platform], uid: platform === 'douyin' ? 'other-account' : '99999' } }]) {
      const app = await fixture(t, { overrides: { [platform]: { async publish(value, hooks) { await hooks.beforeSubmit(); return { ...receipt(platform), ...change }; } } } });
      const result = await app.publish(platform);
      assert.equal(result.body.error.code, 'PUBLISH_UNCERTAIN', `${platform}: ${JSON.stringify(result.body)}`);
      assert.equal((await app.request(`/api/platforms/${platform}/receipts`)).body.receipts.length, 0);
    }
  }
});

test('public receipts discard session-bearing query strings', async t => {
  const app = await fixture(t, { overrides: { douyin: { async publish(value, hooks) { await hooks.beforeSubmit(); return { ...receipt('douyin'), url: `${URLS.douyin}?token=SECRET` }; } } } });
  const result = await app.publish('douyin');
  assert.equal(result.status, 200);
  assert.equal(result.body.url, URLS.douyin);
  assert.equal(JSON.stringify(result.body).includes('SECRET'), false);
});

test('content-specific limits reject invalid requests before any browser operation', async t => {
  const app = await fixture(t);
  const invalid = [
    ['xiaohongshu', { images: [] }], ['xiaohongshu', { title: '' }], ['xiaohongshu', { title: '😀'.repeat(21) }], ['xiaohongshu', { title: '字'.repeat(21) }], ['xiaohongshu', { body: '字'.repeat(1001) }],
    ['douyin', { images: [] }], ['douyin', { title: '字'.repeat(31) }], ['douyin', { title: '' }], ['douyin', { body: '字'.repeat(1001) }], ['douyin', { expectedAccountUid: 'token/../../secret' }],
    ['bilibili', { title: '标题', body: '字'.repeat(997) }], ['bilibili', { images: [`data:image/webp;base64,${Buffer.from('RIFF0000WEBP').toString('base64')}`] }],
    ['weibo', { expectedAccountUid: 'not-numeric' }], ['weibo', { images: ['https://attacker.invalid/file.png'] }],
  ];
  for (const [platform, change] of invalid) {
    const result = await app.publish(platform, payload(platform, change));
    assert.equal(result.status, 400);
    assert.equal(result.body.error.submitted, false);
  }
  for (const platform of PLATFORMS) assert.equal(app.browsers[platform].calls.length, 0);
});


test('Unicode product limits count complete code points consistently across title and body', async t => {
  const app = await fixture(t);
  for (const [platform, change] of [
    ['xiaohongshu', { title: '😀'.repeat(20), body: '😀'.repeat(1000) }],
    ['douyin', { title: '😀'.repeat(30), body: '😀'.repeat(1000) }],
    ['bilibili', { title: '', body: '😀'.repeat(1000) }],
  ]) {
    const result = await app.publish(platform, payload(platform, change));
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
});

test('a driver cannot turn a missing or repeated checkpoint into a confirmed publication', async t => {
  for (const behavior of ['missing', 'repeated']) {
    const app = await fixture(t, { overrides: { weibo: { async publish(value, hooks) {
      this.calls.push(['publish']);
      if (behavior === 'repeated') { await hooks.beforeSubmit(); await hooks.beforeSubmit(); }
      return receipt('weibo');
    } } } });
    const result = await app.publish('weibo');
    assert.equal(result.body.error.code, 'PUBLISH_UNCERTAIN');
    assert.equal(result.body.error.submitted, true);
    app.restart();
    assert.equal((await app.publish('weibo')).body.error.code, 'PUBLISH_UNCERTAIN');
    assert.equal(app.browsers.weibo.calls.length, 1);
  }
});

test('a successful content ID blocks new request IDs, edited payloads and changed accounts until copied', async t => {
  const app = await fixture(t);
  for (const platform of PLATFORMS) {
    assert.equal((await app.publish(platform)).status, 200);
    app.restart();
    for (const change of [
      { requestId: 'request-new-key' },
      { requestId: 'request-edited-key', body: '旧标签页改过正文' },
      { requestId: 'request-account-key', expectedAccountUid: platform === 'douyin' ? 'different-sec-uid' : '99887766' },
    ]) {
      const result = await app.publish(platform, payload(platform, change));
      assert.equal(result.status, 409);
      assert.equal(result.body.error.code, 'CONTENT_ALREADY_PUBLISHED');
      assert.equal(result.body.error.submitted, false);
    }
    assert.equal(app.browsers[platform].calls.length, 1);
    assert.equal((await app.publish(platform, payload(platform, { requestId: 'request-copy-key', contentId: 'post-copy' }))).status, 200);
    assert.equal(app.browsers[platform].calls.length, 2);
  }
});

test('known Xiaohongshu network restriction is preserved without returning webpage error details', async t => {
  const notice = '小红书当前网络被官网限制，请切换可靠网络后重新连接（300012）。';
  const app = await fixture(t, { overrides: { xiaohongshu: { async status() { return { connected: false, browserOpen: true, message: notice, error_msg: 'private page data', request: 'SECRET' }; } } } });
  const result = await app.request('/api/platforms/xiaohongshu/account');
  assert.equal(result.body.message, notice);
  assert.equal(result.body.error_msg, undefined);
  assert.equal(result.body.request, undefined);
});

test('resume routes return fresh safe account state without publishing or falling back to login', async t => {
  const app = await fixture(t, { overrides: Object.fromEntries(PLATFORMS.map(platform => [platform, { async resume() {
    this.calls.push(['resume']);
    return { connected: true, browserOpen: true, publishReady: true, sessionSaved: true, headless: true, account: { ...ACCOUNTS[platform], cookie: 'SECRET' }, token: 'SECRET' };
  } }])) });
  for (const platform of PLATFORMS) {
    const result = await app.request(`/api/platforms/${platform}/resume`, { method: 'POST' });
    assert.equal(result.status, 200);
    assert.equal(result.body.platform, platform);
    assert.equal(result.body.account.uid, ACCOUNTS[platform].uid);
    assert.equal(result.body.connected, true);
    assert.equal(result.body.headless, true);
    assert.equal(result.body.sessionSaved, true);
    assert.equal(JSON.stringify(result.body).includes('SECRET'), false);
    assert.deepEqual(app.browsers[platform].calls, [['resume']]);
    await assert.rejects(readFile(path.join(app.dataDir, `${platform}-publish-ledger.json`)), { code: 'ENOENT' });
  }
  assert.equal((await app.request('/api/weibo/resume', { method: 'POST' })).body.account.uid, ACCOUNTS.weibo.uid);
  assert.deepEqual(app.browsers.weibo.calls, [['resume'], ['resume']]);
});

test('resume keeps disconnected or expired sessions disconnected and never initiates a login fallback', async t => {
  const app = await fixture(t, { overrides: Object.fromEntries(PLATFORMS.map(platform => [platform, { async resume() {
    this.calls.push(['resume']);
    return { connected: false, browserOpen: true, publishReady: false, sessionSaved: true, headless: true, login: { kind: 'window' } };
  } }])) });
  for (const platform of PLATFORMS) {
    const result = await app.request(`/api/platforms/${platform}/resume`, { method: 'POST' });
    assert.equal(result.status, 200);
    assert.equal(result.body.connected, false);
    assert.equal(result.body.publishReady, false);
    assert.equal(result.body.account, undefined);
    assert.deepEqual(app.browsers[platform].calls, [['resume']]);
  }
});

test('resume requires POST, configured Host and Origin, a request header and valid JSON', async t => {
  const app = await fixture(t);
  for (const platform of PLATFORMS) {
    const route = `/api/platforms/${platform}/resume`;
    const invalid = [
      { method: 'GET' },
      { headers: { Host: 'attacker.invalid' } },
      { headers: { Origin: 'https://attacker.invalid' } },
      { headers: { 'X-Fatiao-Request': '0' } },
      { headers: { 'Content-Type': 'text/plain' } },
      { raw: '[]' },
    ];
    for (const options of invalid) {
      const result = await app.request(route, { method: 'POST', ...options });
      assert.ok(result.status >= 400 && result.status < 500);
      assert.equal(result.body.error.submitted, false);
    }
    assert.deepEqual(app.browsers[platform].calls, []);
  }
});

test('GET account and receipts never call resume, login, open or publish', async t => {
  const app = await fixture(t);
  for (const platform of PLATFORMS) {
    assert.equal((await app.request(`/api/platforms/${platform}/account`)).status, 200);
    assert.equal((await app.request(`/api/platforms/${platform}/receipts`)).status, 200);
    assert.deepEqual(app.browsers[platform].calls, [['status']]);
  }
});

test('an in-flight publication blocks resume for its platform and legacy alias', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Map();
  const started = new Map(PLATFORMS.map(platform => [platform, new Promise(resolve => { ready.set(platform, resolve); })]));
  const app = await fixture(t, { overrides: Object.fromEntries(PLATFORMS.map(platform => [platform, { async publish(value, hooks) {
    this.calls.push(['publish']);
    ready.get(platform)();
    await gate;
    await hooks.beforeSubmit();
    return receipt(platform);
  } }])) });
  const publishing = PLATFORMS.map(platform => app.publish(platform));
  try {
    await Promise.all(started.values());
    for (const route of [...PLATFORMS.map(platform => `/api/platforms/${platform}/resume`), '/api/weibo/resume']) {
      const result = await app.request(route, { method: 'POST' });
      assert.equal(result.body.error.code, 'PUBLISH_BUSY');
      assert.equal(result.body.error.submitted, false);
    }
    for (const platform of PLATFORMS) assert.deepEqual(app.browsers[platform].calls, [['publish']]);
  } finally { release(); }
  for (const result of await Promise.all(publishing)) assert.equal(result.status, 200);
});

test('cached current Chrome identity cannot authorize publishing after the restored account changes', async t => {
  let nativeSubmissions = 0;
  const app = await fixture(t, { overrides: Object.fromEntries(PLATFORMS.map(platform => [platform, {
    browserMode: 'current-chrome',
    async status() { this.calls.push(['status']); return { connected: false, browserOpen: false, sessionSaved: true, account: ACCOUNTS[platform], accountVerification: 'required', publishReady: false }; },
    async resume() { this.calls.push(['resume']); return { connected: true, account: { ...ACCOUNTS[platform], uid: '99887766' } }; },
    async publish(value, hooks) {
      this.calls.push(['publish']);
      const restored = await this.resume();
      if (restored.account.uid !== value.expectedAccountUid) throw Object.assign(new Error('session token=SECRET'), { code: 'ACCOUNT_CHANGED' });
      await hooks.beforeSubmit();
      nativeSubmissions += 1;
      return receipt(platform);
    },
  }])) });
  for (const platform of PLATFORMS) {
    const status = await app.request(`/api/platforms/${platform}/account`);
    assert.equal(status.body.account.uid, ACCOUNTS[platform].uid);
    assert.equal(status.body.accountVerification, 'required');
    assert.equal(status.body.connected, false);
    assert.equal(status.body.publishReady, false);
    const result = await app.publish(platform);
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'ACCOUNT_CHANGED');
    assert.equal(result.body.error.submitted, false);
    assert.equal(JSON.stringify(result.body).includes('SECRET'), false);
    assert.deepEqual(app.browsers[platform].calls, [['status'], ['publish'], ['resume']]);
    await assert.rejects(readFile(path.join(app.dataDir, `${platform}-publish-ledger.json`)), { code: 'ENOENT' });
  }
  assert.equal(nativeSubmissions, 0);
});

test('an old driver without resume fails safely without opening its login window', async t => {
  const app = await fixture(t, { overrides: { weibo: { resume: undefined } } });
  const result = await app.request('/api/weibo/resume', { method: 'POST' });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'BROWSER_UNAVAILABLE');
  assert.equal(result.body.error.submitted, false);
  assert.deepEqual(app.browsers.weibo.calls, []);
});

test('resume preserves verification-required and unsupported-page notices without claiming publication readiness', async t => {
  let needsVerification = true;
  const app = await fixture(t, { overrides: { douyin: { async resume() {
    return needsVerification
      ? { connected: true, publishReady: false, browserOpen: true, account: ACCOUNTS.douyin, message: '当前会话需要安全验证，请打开专用窗口完成后再继续。' }
      : { connected: false, publishReady: false, browserOpen: true, message: '专用窗口中没有可用的平台页面，请打开平台官网后刷新连接状态。' };
  } } } });
  const blocked = await app.request('/api/platforms/douyin/resume', { method: 'POST' });
  assert.equal(blocked.body.connected, true);
  assert.equal(blocked.body.publishReady, false);
  assert.equal(blocked.body.message, '当前会话需要安全验证，请打开专用窗口完成后再继续。');
  needsVerification = false;
  const outside = await app.request('/api/platforms/douyin/resume', { method: 'POST' });
  assert.equal(outside.body.connected, false);
  assert.equal(outside.body.publishReady, false);
  assert.equal(outside.body.message, '专用窗口中没有可用的平台页面，请打开平台官网后刷新连接状态。');
});

test('confirmed four-platform updates preserve original IDs and images; deletion tombstones gate local removal', async t => {
  const app = await fixture(t);
  assert.equal((await app.deletionStatus()).body.canDelete, true);
  for (const platform of PLATFORMS) assert.equal((await app.publish(platform)).status, 200);
  assert.equal((await app.deletionStatus()).body.canDelete, false);
  for (const platform of PLATFORMS) {
    const original = (await app.request(`/api/platforms/${platform}/receipts`)).body.receipts[0];
    const updated = await app.mutate(platform, 'update', { title: '  更新标题  ', body: '\n更新正文\n' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.receipt.id, original.id);
    assert.equal(updated.body.receipt.requestId, original.requestId);
    assert.equal(updated.body.receipt.publishedAt, original.publishedAt);
    assert.ok(updated.body.receipt.updatedAt > original.publishedAt);
    assert.deepEqual(updated.body.operation, { requestId: 'update-request-00001', type: 'update', title: '更新标题', body: '更新正文' });
    assert.deepEqual(updated.body.receipt.lastOperation, updated.body.operation);
    const input = app.browsers[platform].calls.find(([method]) => method === 'update')[1];
    assert.equal(input.receipt.id, IDS[platform]);
    assert.equal(input.receipt.url, URLS[platform]);
    assert.equal(input.title, '更新标题');
    assert.equal(input.images, undefined);
    const second = await app.mutate(platform, 'update', { requestId: 'update-request-00002' });
    assert.ok(second.body.receipt.updatedAt > updated.body.receipt.updatedAt);
    const deleted = await app.mutate(platform, 'delete');
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.ok(deleted.body.receipt.deletedAt > second.body.receipt.updatedAt);
    assert.equal(deleted.body.receipt.id, original.id);
    assert.equal(deleted.body.receipt.publishedAt, original.publishedAt);
    app.restart();
    const rows = (await app.request(`/api/platforms/${platform}/receipts`)).body.receipts;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].deletedAt, deleted.body.receipt.deletedAt);
    assert.equal(rows[0].lastOperation.type, 'delete');
    assert.equal((await app.mutate(platform, 'update', { requestId: 'update-after-delete' })).body.error.code, 'CONTENT_ALREADY_DELETED');
    const status = await app.deletionStatus();
    assert.equal(status.body.publications.length, 4);
    assert.equal(status.body.canDelete, platform === 'bilibili');
    assert.equal(status.body.pending, false);
  }
});

test('lifecycle checkpoints are durable before native actions and retain the original publication', async t => {
  let app;
  const overrides = { weibo: { async update(value, hooks) {
    await hooks.beforeSubmit();
    const saved = JSON.parse(await readFile(path.join(app.dataDir, 'weibo-publish-ledger.json'), 'utf8'));
    assert.equal(saved.records['request-00001'].state, 'success');
    assert.equal(saved.records['request-00001'].receipt.updatedAt, undefined);
    assert.equal(saved.operations['update-request-00001'].state, 'pending');
    assert.equal(saved.operations['update-request-00001'].publicationRequestId, 'request-00001');
    assert.equal((await app.deletionStatus()).body.pending, true);
    return { ...value.receipt, updatedAt: new Date(NOW).toISOString() };
  } } };
  app = await fixture(t, { overrides });
  await app.publish('weibo');
  assert.equal((await app.mutate('weibo', 'update')).status, 200);
  const saved = JSON.parse(await readFile(path.join(app.dataDir, 'weibo-publish-ledger.json'), 'utf8'));
  assert.equal(saved.operations['update-request-00001'].state, 'success');
  assert.equal(saved.records['request-00001'].receipt.lastOperation.requestId, 'update-request-00001');
});

test('concurrent lifecycle aliases coalesce and old responses survive restart without repeating native actions', async t => {
  let release;
  let announce;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { announce = resolve; });
  const app = await fixture(t, { overrides: { weibo: { async update(value, hooks) {
    this.calls.push(['update']); announce(); await gate; await hooks.beforeSubmit(); return { ...value.receipt, updatedAt: new Date(NOW).toISOString() };
  } } } });
  await app.publish('weibo');
  const a = app.mutate('weibo', 'update');
  await began;
  const b = app.mutate('weibo', 'update', {}, true);
  try {
    assert.equal((await app.mutate('weibo', 'update', { body: '改变内容' })).body.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await app.mutate('weibo', 'delete')).body.error.code, 'PUBLISH_BUSY');
    assert.equal((await app.request('/api/weibo/resume', { method: 'POST' })).body.error.code, 'PUBLISH_BUSY');
    assert.equal((await app.deletionStatus()).body.pending, true);
  } finally { release(); }
  const [first, second] = await Promise.all([a, b]);
  assert.deepEqual(first.body, second.body);
  assert.equal(first.status, 200);
  app.restart();
  assert.deepEqual((await app.mutate('weibo', 'update')).body, first.body);
  assert.equal(app.browsers.weibo.calls.filter(([method]) => method === 'update').length, 1);
  const deleted = await app.mutate('weibo', 'delete');
  assert.equal(deleted.status, 200);
  app.restart();
  assert.deepEqual((await app.mutate('weibo', 'delete', {}, true)).body, deleted.body);
  assert.equal(app.browsers.weibo.calls.filter(([method]) => method === 'delete').length, 1);
  assert.deepEqual((await app.mutate('weibo', 'update')).body, first.body);
});

test('lifecycle cannot target client URLs, other content, other accounts or replace images', async t => {
  const app = await fixture(t);
  await app.publish('weibo');
  for (const change of [
    { receipt: receipt('weibo') }, { id: IDS.weibo }, { url: URLS.weibo }, { images: [PNG] },
    { contentId: 'different-post' }, { publicationRequestId: 'unknown-publication' },
    { expectedAccountUid: '99887766' }, { requestId: 'request-00001' },
  ]) {
    const result = await app.mutate('weibo', 'update', change);
    assert.ok(result.status >= 400 && result.status < 500);
    assert.equal(result.body.error.submitted, false);
  }
  assert.equal((await app.mutate('weibo', 'delete', { title: 'unexpected' })).body.error.code, 'VALIDATION_ERROR');
  assert.equal(app.browsers.weibo.calls.length, 1);
});

test('update and delete validate method, Host, Origin, request header and JSON before driver access', async t => {
  const app = await fixture(t);
  for (const platform of PLATFORMS) {
    for (const type of ['update', 'delete']) {
      const route = `/api/platforms/${platform}/${type}`;
      for (const options of [
        { method: 'GET' }, { headers: { Host: 'attacker.invalid' } },
        { headers: { Origin: 'https://attacker.invalid' } }, { headers: { 'X-Fatiao-Request': '0' } },
        { headers: { 'Content-Type': 'text/plain' } }, { raw: 'null' },
      ]) assert.ok((await app.request(route, { method: 'POST', ...options })).status >= 400);
    }
    assert.deepEqual(app.browsers[platform].calls, []);
  }
});

test('unsupported lifecycle operations remain retryable and never create a pending checkpoint', async t => {
  const app = await fixture(t, { overrides: { weibo: { async update() { this.calls.push(['update']); throw Object.assign(new Error('SECRET'), { code: 'OPERATION_UNSUPPORTED' }); } } } });
  await app.publish('weibo');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await app.mutate('weibo', 'update');
    assert.equal(result.status, 501);
    assert.equal(result.body.error.code, 'OPERATION_UNSUPPORTED');
    assert.equal(result.body.error.submitted, false);
    assert.equal(JSON.stringify(result.body).includes('SECRET'), false);
  }
  assert.equal((await app.deletionStatus()).body.pending, false);
  assert.deepEqual(JSON.parse(await readFile(path.join(app.dataDir, 'weibo-publish-ledger.json'), 'utf8')).operations, {});
});

test('unknown lifecycle results persist without a tombstone and block both fresh keys and local deletion', async t => {
  for (const type of ['update', 'delete']) {
    const app = await fixture(t, { overrides: { weibo: { async [type](value, hooks) {
      this.calls.push([type]); await hooks.beforeSubmit(); throw Object.assign(new Error('SECRET'), { code: 'OPERATION_REJECTED' });
    } } } });
    await app.publish('weibo');
    const result = await app.mutate('weibo', type);
    assert.equal(result.body.error.code, 'OPERATION_UNCERTAIN');
    assert.equal(result.body.error.submitted, true);
    app.restart();
    for (const action of ['update', 'delete']) {
      assert.equal((await app.mutate('weibo', action, { requestId: `${action}-another-key` })).body.error.code, 'OPERATION_UNCERTAIN');
    }
    assert.equal(app.browsers.weibo.calls.filter(([method]) => method === type).length, 1);
    const status = (await app.deletionStatus()).body;
    assert.equal(status.canDelete, false);
    assert.equal(status.pending, true);
    assert.equal(status.publications[0].receipt.deletedAt, undefined);
  }
});

test('lifecycle requires exact target identity and a trusted timestamp before acknowledging success', async t => {
  for (const type of ['update', 'delete']) {
    const field = type === 'delete' ? 'deletedAt' : 'updatedAt';
    for (const change of [
      { id: '9999999999', url: 'https://weibo.com/detail/9999999999' },
      { account: { ...ACCOUNTS.weibo, uid: '99999999' } },
      { [field]: undefined }, { [field]: 'not-a-time' },
    ]) {
      const app = await fixture(t, { overrides: { weibo: { async [type](value, hooks) { await hooks.beforeSubmit(); return { ...value.receipt, [field]: new Date(NOW).toISOString(), ...change }; } } } });
      await app.publish('weibo');
      assert.equal((await app.mutate('weibo', type)).body.error.code, 'OPERATION_UNCERTAIN');
      const records = (await app.request('/api/weibo/receipts')).body.receipts;
      assert.equal(records[0].deletedAt, undefined);
      assert.equal(records[0].updatedAt, undefined);
    }
  }
});

test('deletion-status is read-only, private by Host and fails closed on any corrupt platform ledger', async t => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/content/post-1/deletion-status', { method: 'POST' })).status, 405);
  assert.equal((await app.request('/api/content/post-1/deletion-status', { headers: { Host: 'attacker.invalid' } })).status, 403);
  await writeFile(path.join(app.dataDir, 'bilibili-publish-ledger.json'), '{broken');
  app.restart();
  const result = await app.deletionStatus();
  assert.equal(result.status, 503);
  assert.equal(result.body.canDelete, false);
  for (const platform of PLATFORMS) assert.deepEqual(app.browsers[platform].calls, []);
});

test('failed lifecycle checkpoint storage prevents the native click and keeps the original record', async t => {
  let app;
  let nativeClicks = 0;
  app = await fixture(t, { overrides: { weibo: { async delete(value, hooks) {
    await rename(app.dataDir, `${app.dataDir}.backup`);
    await writeFile(app.dataDir, 'blocks the directory');
    await hooks.beforeSubmit();
    nativeClicks += 1;
    return { ...value.receipt, deletedAt: new Date(NOW).toISOString() };
  } } } });
  await app.publish('weibo');
  const result = await app.mutate('weibo', 'delete');
  assert.equal(result.body.error.code, 'STORAGE_ERROR');
  assert.equal(result.body.error.submitted, false);
  assert.equal(nativeClicks, 0);
  const original = JSON.parse(await readFile(path.join(`${app.dataDir}.backup`, 'weibo-publish-ledger.json'), 'utf8'));
  assert.equal(original.records['request-00001'].receipt.deletedAt, undefined);
});

test('failed lifecycle success persistence leaves the durable pending guard and never authorizes local deletion', async t => {
  let app;
  let nativeClicks = 0;
  app = await fixture(t, { overrides: { weibo: { async delete(value, hooks) {
    await hooks.beforeSubmit();
    nativeClicks += 1;
    await rename(app.dataDir, `${app.dataDir}.backup`);
    await writeFile(app.dataDir, 'temporarily unavailable');
    return { ...value.receipt, deletedAt: new Date(NOW).toISOString() };
  } } } });
  await app.publish('weibo');
  const result = await app.mutate('weibo', 'delete');
  assert.equal(result.body.error.code, 'OPERATION_UNCERTAIN');
  assert.equal(result.body.error.submitted, true);
  assert.equal((await app.deletionStatus()).body.canDelete, false);
  await rm(app.dataDir);
  await rename(`${app.dataDir}.backup`, app.dataDir);
  app.restart();
  assert.equal((await app.mutate('weibo', 'delete')).body.error.code, 'OPERATION_UNCERTAIN');
  assert.equal((await app.deletionStatus()).body.canDelete, false);
  assert.equal(nativeClicks, 1);
});

test('a driver cannot skip its lifecycle checkpoint or mark initial publication as already deleted', async t => {
  const app = await fixture(t, { overrides: { weibo: {
    async publish(value, hooks) { await hooks.beforeSubmit(); return { ...receipt('weibo'), deletedAt: new Date(NOW).toISOString() }; },
    async delete(value) { this.calls.push(['delete']); return { ...value.receipt, deletedAt: new Date(NOW).toISOString() }; },
  } } });
  assert.equal((await app.publish('weibo')).body.deletedAt, undefined);
  assert.equal((await app.deletionStatus()).body.canDelete, false);
  assert.equal((await app.mutate('weibo', 'delete')).body.error.code, 'OPERATION_UNCERTAIN');
  app.restart();
  assert.equal((await app.mutate('weibo', 'delete')).body.error.code, 'OPERATION_UNCERTAIN');
  assert.equal(app.browsers.weibo.calls.filter(([method]) => method === 'delete').length, 1);
});

test('an exact pending publication replay can read-only reconcile a confirmed receipt without resubmitting', async t => {
  const app = await fixture(t, { overrides: { bilibili: {
    async publish(value, hooks) { this.calls.push(['publish']); await hooks.beforeSubmit(); throw Object.assign(new Error('response lost'), { submitted: true }); },
    async reconcilePublication(input, options) {
      this.calls.push(['reconcile', input, options]);
      return { ...receipt('bilibili'), cookie: 'SECRET', deletedAt: new Date(NOW).toISOString() };
    },
  } } });
  const first = await app.publish('bilibili');
  assert.equal(first.body.error.code, 'PUBLISH_UNCERTAIN');
  app.restart();
  const confirmed = await app.publish('bilibili');
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.id, IDS.bilibili);
  assert.equal(confirmed.body.requestId, 'request-00001');
  assert.equal(confirmed.body.deletedAt, undefined);
  assert.equal(JSON.stringify(confirmed.body).includes('SECRET'), false);
  assert.deepEqual(app.browsers.bilibili.calls[1], ['reconcile', payload('bilibili'), { attemptedAt: new Date(NOW).toISOString() }]);
  const saved = JSON.parse(await readFile(path.join(app.dataDir, 'bilibili-publish-ledger.json'), 'utf8'));
  assert.equal(saved.records['request-00001'].state, 'success');
  assert.equal(saved.records['request-00001'].reconciledAt, new Date(NOW).toISOString());
  assert.equal((await app.deletionStatus()).body.pending, false);
  assert.equal((await app.deletionStatus()).body.canDelete, false);
  app.restart();
  assert.deepEqual((await app.publish('bilibili')).body, confirmed.body);
  assert.equal(app.browsers.bilibili.calls.filter(([method]) => method === 'publish').length, 1);
  assert.equal(app.browsers.bilibili.calls.filter(([method]) => method === 'reconcile').length, 1);
});

test('a changed pending request or a fresh key cannot initiate publication reconciliation', async t => {
  const app = await fixture(t, { overrides: { bilibili: {
    async publish(value, hooks) { this.calls.push(['publish']); await hooks.beforeSubmit(); throw Object.assign(new Error('response lost'), { submitted: true }); },
    async reconcilePublication() { this.calls.push(['reconcile']); return receipt('bilibili'); },
  } } });
  await app.publish('bilibili');
  for (const change of [{ title: 'changed' }, { body: 'changed' }, { expectedAccountUid: '99887766' }, { images: [] }]) {
    const result = await app.publish('bilibili', payload('bilibili', change));
    assert.equal(result.body.error.code, 'IDEMPOTENCY_CONFLICT');
  }
  assert.equal((await app.publish('bilibili', payload('bilibili', { requestId: 'new-request-key' }))).body.error.code, 'PUBLISH_UNCERTAIN');
  await app.request('/api/platforms/bilibili/receipts');
  await app.deletionStatus();
  assert.deepEqual(app.browsers.bilibili.calls, [['publish']]);
});

test('missing, negative or invalid reconciliation evidence leaves the original publication pending', async t => {
  for (const evidence of [undefined, null, { ...receipt('bilibili'), id: undefined }, { ...receipt('bilibili'), account: { ...ACCOUNTS.bilibili, uid: '99887766' } }, new Error('SECRET')]) {
    const app = await fixture(t, { overrides: { bilibili: {
      async publish(value, hooks) { this.calls.push(['publish']); await hooks.beforeSubmit(); throw Object.assign(new Error('response lost'), { submitted: true }); },
      async reconcilePublication() { this.calls.push(['reconcile']); if (evidence instanceof Error) throw evidence; return evidence; },
    } } });
    await app.publish('bilibili');
    const result = await app.publish('bilibili');
    assert.equal(result.body.error.code, 'PUBLISH_UNCERTAIN');
    assert.equal(result.body.error.submitted, true);
    assert.equal(JSON.stringify(result.body).includes('SECRET'), false);
    const saved = JSON.parse(await readFile(path.join(app.dataDir, 'bilibili-publish-ledger.json'), 'utf8'));
    assert.equal(saved.records['request-00001'].state, 'pending');
    assert.equal((await app.deletionStatus()).body.pending, true);
    assert.equal(app.browsers.bilibili.calls.filter(([method]) => method === 'publish').length, 1);
  }
});

test('concurrent matching replays coalesce into a single read-only reconciliation', async t => {
  let release;
  let announce;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { announce = resolve; });
  const app = await fixture(t, { overrides: { bilibili: {
    async publish(value, hooks) { this.calls.push(['publish']); await hooks.beforeSubmit(); throw Object.assign(new Error('lost'), { submitted: true }); },
    async reconcilePublication() { this.calls.push(['reconcile']); announce(); await gate; return receipt('bilibili'); },
  } } });
  await app.publish('bilibili');
  const first = app.publish('bilibili');
  await began;
  const second = app.publish('bilibili');
  try { assert.equal((await app.request('/api/platforms/bilibili/disconnect', { method: 'POST' })).body.error.code, 'PUBLISH_BUSY'); }
  finally { release(); }
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body);
  assert.deepEqual(app.browsers.bilibili.calls, [['publish'], ['reconcile']]);
});

test('explicit Xiaohongshu edit retry keeps the same payload and checks success before resubmitting', async t => {
  for (const recovered of [false, true]) {
    let attempts = 0;
    const app = await fixture(t, { overrides: { xiaohongshu: {
      async update(value, hooks) { attempts++; await hooks.beforeSubmit(); if (attempts === 1) throw Object.assign(new Error('lost'), { submitted: true }); return { ...value.receipt, updatedAt: new Date(NOW).toISOString() }; },
      async reconcileOperation(input) { return recovered ? { ...input.receipt, updatedAt: new Date(NOW).toISOString() } : undefined; },
    } } });
    const body = { requestId: 'update-request-00001', contentId: 'post-1', publicationRequestId: 'request-00001', expectedAccountUid: ACCOUNTS.xiaohongshu.uid, title: '更新标题', body: '更新正文' };
    const retry = change => app.request('/api/platforms/xiaohongshu/retry-update', { method: 'POST', body: { ...body, ...change } });
    assert.equal((await retry()).body.error.code, 'OPERATION_UNCERTAIN');
    await app.publish('xiaohongshu'); await app.mutate('xiaohongshu', 'update');
    assert.equal((await retry({ body: 'changed' })).body.error.code, 'IDEMPOTENCY_CONFLICT');
    if (!recovered) { await app.reconcile('xiaohongshu', 'update'); assert.equal(attempts, 1); }
    assert.equal((await retry()).status, 200); assert.equal(attempts, recovered ? 1 : 2);
    assert.equal((await retry()).status, 200); assert.equal(attempts, recovered ? 1 : 2);
    assert.equal((await app.deletionStatus()).body.canDelete, false);
  }
});

test('exact pending update/delete replays reconcile read-only and persist the canonical operation result', async t => {
  for (const type of ['update', 'delete']) {
    const field = type === 'delete' ? 'deletedAt' : 'updatedAt';
    const app = await fixture(t, { overrides: { weibo: {
      async [type](value, hooks) { this.calls.push([type]); await hooks.beforeSubmit(); throw Object.assign(new Error('lost response'), { submitted: true }); },
      async reconcileOperation(input, options) { this.calls.push(['reconcile', input, options]); return { ...input.receipt, [field]: new Date(NOW).toISOString(), cookie: 'SECRET' }; },
    } } });
    await app.publish('weibo');
    assert.equal((await app.mutate('weibo', type)).body.error.code, 'OPERATION_UNCERTAIN');
    app.restart();
    const confirmed = await app.mutate('weibo', type, {}, true);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.receipt.id, IDS.weibo);
    assert.equal(confirmed.body.receipt.requestId, 'request-00001');
    assert.ok(confirmed.body.receipt[field] > confirmed.body.receipt.publishedAt);
    assert.equal(confirmed.body.operation.requestId, `${type}-request-00001`);
    assert.equal(confirmed.body.operation.type, type);
    assert.deepEqual(confirmed.body.receipt.lastOperation, confirmed.body.operation);
    assert.equal(JSON.stringify(confirmed.body).includes('SECRET'), false);
    const [, input, options] = app.browsers.weibo.calls.find(([method]) => method === 'reconcile');
    assert.equal(input.receipt.id, IDS.weibo);
    assert.equal(input.expectedAccountUid, ACCOUNTS.weibo.uid);
    assert.equal(input.title, type === 'update' ? '更新标题' : undefined);
    assert.deepEqual(options, { operation: type, attemptedAt: new Date(NOW).toISOString() });
    const status = (await app.deletionStatus()).body;
    assert.equal(status.pending, false);
    assert.equal(status.canDelete, type === 'delete');
    app.restart();
    assert.deepEqual((await app.mutate('weibo', type)).body, confirmed.body);
    assert.equal(app.browsers.weibo.calls.filter(([method]) => method === type).length, 1);
    assert.equal(app.browsers.weibo.calls.filter(([method]) => method === 'reconcile').length, 1);
  }
});

test('new operation keys or changed pending payloads never invoke read-only reconciliation or native mutation', async t => {
  const app = await fixture(t, { overrides: { weibo: {
    async update(value, hooks) { this.calls.push(['update']); await hooks.beforeSubmit(); throw Object.assign(new Error('lost'), { submitted: true }); },
    async reconcileOperation(input) { this.calls.push(['reconcile']); return { ...input.receipt, updatedAt: new Date(NOW).toISOString() }; },
  } } });
  await app.publish('weibo');
  await app.mutate('weibo', 'update');
  for (const change of [{ title: 'changed' }, { body: 'changed' }, { expectedAccountUid: '99887766' }, { publicationRequestId: 'changed-publication' }]) {
    assert.equal((await app.mutate('weibo', 'update', change)).body.error.code, 'IDEMPOTENCY_CONFLICT');
  }
  assert.equal((await app.mutate('weibo', 'update', { requestId: 'new-operation-key' })).body.error.code, 'OPERATION_UNCERTAIN');
  assert.equal((await app.mutate('weibo', 'delete', { requestId: 'update-request-00001' })).body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await app.mutate('weibo', 'delete')).body.error.code, 'OPERATION_UNCERTAIN');
  await app.request('/api/weibo/receipts');
  await app.deletionStatus();
  assert.equal(app.browsers.weibo.calls.filter(([method]) => method === 'reconcile').length, 0);
  assert.equal(app.browsers.weibo.calls.filter(([method]) => method === 'update').length, 1);
  assert.equal(app.browsers.weibo.calls.filter(([method]) => method === 'delete').length, 0);
});

test('negative or invalid operation reconciliation never acknowledges deletion or releases its pending guard', async t => {
  for (const evidence of [undefined, new Error('SECRET'), { id: '9999999', url: 'https://weibo.com/detail/9999999' }, { account: { uid: '99887766', name: '其他账号' } }, { deletedAt: undefined }]) {
    const app = await fixture(t, { overrides: { weibo: {
      async delete(value, hooks) { this.calls.push(['delete']); await hooks.beforeSubmit(); throw Object.assign(new Error('lost'), { submitted: true }); },
      async reconcileOperation(input) {
        this.calls.push(['reconcile']);
        if (evidence instanceof Error) throw evidence;
        return evidence === undefined ? undefined : { ...input.receipt, deletedAt: new Date(NOW).toISOString(), ...evidence };
      },
    } } });
    await app.publish('weibo');
    await app.mutate('weibo', 'delete');
    const result = await app.mutate('weibo', 'delete');
    assert.equal(result.body.error.code, 'OPERATION_UNCERTAIN');
    assert.equal(result.body.error.submitted, true);
    assert.equal(JSON.stringify(result.body).includes('SECRET'), false);
    const status = (await app.deletionStatus()).body;
    assert.equal(status.canDelete, false);
    assert.equal(status.pending, true);
    assert.equal(status.publications[0].receipt.deletedAt, undefined);
    assert.equal(app.browsers.weibo.calls.filter(([method]) => method === 'delete').length, 1);
  }
});

test('concurrent pending operation checks share one read-only reconciliation across legacy aliases', async t => {
  let release;
  let announce;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { announce = resolve; });
  const app = await fixture(t, { overrides: { weibo: {
    async delete(value, hooks) { this.calls.push(['delete']); await hooks.beforeSubmit(); throw Object.assign(new Error('lost'), { submitted: true }); },
    async reconcileOperation(input) { this.calls.push(['reconcile']); announce(); await gate; return { ...input.receipt, deletedAt: new Date(NOW).toISOString() }; },
  } } });
  await app.publish('weibo');
  await app.mutate('weibo', 'delete');
  const first = app.mutate('weibo', 'delete');
  await began;
  const second = app.mutate('weibo', 'delete', {}, true);
  try { assert.equal((await app.request('/api/weibo/disconnect', { method: 'POST' })).body.error.code, 'PUBLISH_BUSY'); }
  finally { release(); }
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body, b.body);
  assert.equal(app.browsers.weibo.calls.filter(([method]) => method === 'delete').length, 1);
  assert.equal(app.browsers.weibo.calls.filter(([method]) => method === 'reconcile').length, 1);
});

test('dedicated reconciliation route cannot issue a first native action when no server record exists', async t => {
  const app = await fixture(t);
  for (const platform of PLATFORMS) {
    for (const operation of ['publish', 'update', 'delete']) {
      const result = await app.reconcile(platform, operation);
      assert.equal(result.status, 409);
      assert.equal(result.body.error.code, operation === 'publish' ? 'PUBLISH_UNCERTAIN' : 'OPERATION_UNCERTAIN');
      assert.equal(result.body.error.submitted, true);
      assert.deepEqual(app.browsers[platform].calls, []);
      await assert.rejects(readFile(path.join(app.dataDir, `${platform}-publish-ledger.json`)), { code: 'ENOENT' });
    }
    await app.publish(platform);
    for (const operation of ['update', 'delete']) {
      assert.equal((await app.reconcile(platform, operation)).body.error.code, 'OPERATION_UNCERTAIN');
    }
    assert.equal(app.browsers[platform].calls.length, 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(app.dataDir, `${platform}-publish-ledger.json`), 'utf8')).operations, {});
  }
});

test('dedicated reconciliation reads confirmed or pending results using original fingerprints only', async t => {
  const app = await fixture(t, { overrides: { weibo: {
    async publish(value, hooks) { this.calls.push(['publish']); await hooks.beforeSubmit(); throw Object.assign(new Error('lost'), { submitted: true }); },
    async delete(value, hooks) { this.calls.push(['delete']); await hooks.beforeSubmit(); throw Object.assign(new Error('lost'), { submitted: true }); },
    async reconcilePublication(input) { this.calls.push(['reconcile-publication']); assert.equal(input.operation, undefined); return receipt('weibo'); },
    async reconcileOperation(input, { operation }) { this.calls.push(['reconcile-operation']); assert.equal(operation, 'delete'); return { ...input.receipt, deletedAt: new Date(NOW).toISOString() }; },
  } } });
  await app.publish('weibo');
  assert.equal((await app.reconcile('weibo', 'publish', { body: 'changed' })).body.error.code, 'IDEMPOTENCY_CONFLICT');
  const published = await app.reconcile('weibo', 'publish');
  assert.equal(published.status, 200);
  app.restart();
  assert.deepEqual((await app.reconcile('weibo', 'publish', {}, true)).body, published.body);
  await app.mutate('weibo', 'delete');
  const deleted = await app.reconcile('weibo', 'delete', {}, true);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.receipt.lastOperation.type, 'delete');
  app.restart();
  assert.deepEqual((await app.reconcile('weibo', 'delete')).body, deleted.body);
  assert.deepEqual(app.browsers.weibo.calls, [['publish'], ['reconcile-publication'], ['delete'], ['reconcile-operation']]);
});

test('dedicated reconciliation enforces source, method, JSON and allowed operation controls', async t => {
  const app = await fixture(t);
  for (const platform of PLATFORMS) {
    const route = `/api/platforms/${platform}/reconcile`;
    for (const options of [
      { method: 'GET' }, { headers: { Host: 'attacker.invalid' } }, { headers: { Origin: 'https://attacker.invalid' } },
      { headers: { 'X-Fatiao-Request': '0' } }, { headers: { 'Content-Type': 'text/plain' } },
      { raw: '[]' }, { body: { operation: 'login' } }, { body: { operation: 'constructor' } },
    ]) assert.ok((await app.request(route, { method: 'POST', ...options })).status >= 400);
    assert.deepEqual(app.browsers[platform].calls, []);
  }
});

test('composer draft API exposes only actual editor review and clears without touching publication records', async t => {
  let draft = { actualUI: true, title: '官网标题', body: '未发正文', imageCount: 1, fingerprint: 'a'.repeat(64) };
  const app = await fixture(t, { overrides: { bilibili: {
    async inspectComposerDraft(input) { this.calls.push(['inspect-draft', input]); return { account: { ...ACCOUNTS.bilibili, cookie: 'SECRET' }, draft: { ...draft, cookie: 'SECRET' }, token: 'SECRET' }; },
    async clearComposerDraft(input) { this.calls.push(['clear-draft', input]); if (input.fingerprint !== draft.fingerprint) throw Object.assign(new Error('changed'), { code: 'DRAFT_CHANGED' }); draft = { actualUI: true, title: '', body: '', imageCount: 0, fingerprint: 'b'.repeat(64) }; return { cleared: true, account: ACCOUNTS.bilibili, draft }; },
  } } });
  await app.publish('bilibili');
  const ledgerPath = path.join(app.dataDir, 'bilibili-publish-ledger.json');
  const before = await readFile(ledgerPath, 'utf8');
  const reviewed = await app.request('/api/platforms/bilibili/composer-draft', { method: 'POST', body: { expectedAccountUid: ACCOUNTS.bilibili.uid } });
  assert.equal(reviewed.status, 200);
  assert.deepEqual(reviewed.body.draft, draft);
  assert.equal(JSON.stringify(reviewed.body).includes('SECRET'), false);
  const cleared = await app.request('/api/platforms/bilibili/clear-composer-draft', { method: 'POST', body: { expectedAccountUid: ACCOUNTS.bilibili.uid, fingerprint: reviewed.body.draft.fingerprint } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.cleared, true);
  assert.equal(cleared.body.draft.body, '');
  assert.equal(cleared.body.draft.imageCount, 0);
  assert.equal(await readFile(ledgerPath, 'utf8'), before);
  assert.deepEqual(app.browsers.bilibili.calls.slice(1), [['inspect-draft', { expectedAccountUid: ACCOUNTS.bilibili.uid }], ['clear-draft', { expectedAccountUid: ACCOUNTS.bilibili.uid, fingerprint: 'a'.repeat(64) }]]);
});

test('composer draft routes reject unsupported platforms, bad origins and arbitrary clear targets', async t => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/platforms/weibo/composer-draft', { method: 'POST', body: { expectedAccountUid: ACCOUNTS.weibo.uid } })).body.error.code, 'OPERATION_UNSUPPORTED');
  for (const action of ['composer-draft', 'clear-composer-draft']) {
    const route = `/api/platforms/bilibili/${action}`;
    const valid = { expectedAccountUid: ACCOUNTS.bilibili.uid, ...(action === 'clear-composer-draft' ? { fingerprint: 'a'.repeat(64) } : {}) };
    for (const options of [{ method: 'GET' }, { headers: { Host: 'attacker.invalid' } }, { headers: { Origin: 'https://attacker.invalid' } }, { headers: { 'X-Fatiao-Request': '0' } }, { headers: { 'Content-Type': 'text/plain' } }, { raw: '[]' }, { body: { ...valid, receipt: receipt('bilibili') } }, { body: { ...valid, url: URLS.bilibili } }, { body: { ...valid, expectedAccountUid: 'wrong/uid' } }]) {
      const result = await app.request(route, { method: 'POST', body: valid, ...options });
      assert.ok(result.status >= 400);
      assert.equal(result.body.error.submitted, false);
    }
  }
  assert.equal((await app.request('/api/platforms/bilibili/clear-composer-draft', { method: 'POST', body: { expectedAccountUid: ACCOUNTS.bilibili.uid, fingerprint: 'invalid' } })).body.error.code, 'VALIDATION_ERROR');
  for (const platform of PLATFORMS) assert.deepEqual(app.browsers[platform].calls, []);
});

test('composer draft API never reports a different account, malformed review or partially cleared editor as success', async t => {
  const baseline = { actualUI: true, title: '', body: '', imageCount: 0, fingerprint: 'a'.repeat(64) };
  for (const value of [
    { cleared: true, account: { ...ACCOUNTS.bilibili, uid: '99887766' }, draft: baseline },
    { cleared: true, account: ACCOUNTS.bilibili, draft: { ...baseline, actualUI: false } },
    { cleared: true, account: ACCOUNTS.bilibili, draft: { ...baseline, fingerprint: '<script>' } },
    { cleared: true, account: ACCOUNTS.bilibili, draft: { ...baseline, body: '残留' } },
    { cleared: true, account: ACCOUNTS.bilibili, draft: { ...baseline, imageCount: 1 } },
    { account: ACCOUNTS.bilibili, draft: baseline },
  ]) {
    const app = await fixture(t, { overrides: { bilibili: { async clearComposerDraft() { return value; } } } });
    const result = await app.request('/api/platforms/bilibili/clear-composer-draft', { method: 'POST', body: { expectedAccountUid: ACCOUNTS.bilibili.uid, fingerprint: 'a'.repeat(64) } });
    assert.ok(result.status >= 400);
    assert.equal(result.body.error.submitted, false);
    await assert.rejects(readFile(path.join(app.dataDir, 'bilibili-publish-ledger.json')), { code: 'ENOENT' });
  }
});

test('publishing blocks both composer draft inspection and clearing until the operation completes', async t => {
  let release, announce;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { announce = resolve; });
  const app = await fixture(t, { overrides: { bilibili: {
    async publish(value, hooks) { announce(); await gate; await hooks.beforeSubmit(); return receipt('bilibili'); },
    async inspectComposerDraft() { assert.fail('must not inspect while publishing'); },
    async clearComposerDraft() { assert.fail('must not clear while publishing'); },
  } } });
  const publishing = app.publish('bilibili');
  await began;
  try {
    for (const action of ['composer-draft', 'clear-composer-draft']) {
      const result = await app.request(`/api/platforms/bilibili/${action}`, { method: 'POST', body: { expectedAccountUid: ACCOUNTS.bilibili.uid, ...(action === 'clear-composer-draft' ? { fingerprint: 'a'.repeat(64) } : {}) } });
      assert.equal(result.body.error.code, 'PUBLISH_BUSY');
    }
  } finally { release(); }
  assert.equal((await publishing).status, 200);
});

test('explicit first-use continuation requires the exact existing pending request and stores its receipt', async t => {
  let continued = 0;
  const app = await fixture(t, { overrides: { bilibili: {
    async publish(value, hooks) { await hooks.beforeSubmit(); throw Object.assign(new Error('first-use confirmation'), { submitted: true }); },
    async continuePublication() { continued++; return receipt('bilibili'); },
  } } });
  const route = '/api/platforms/bilibili/continue-publish';
  assert.equal((await app.request(route, { method: 'POST', body: payload('bilibili') })).status, 409);
  assert.equal(continued, 0);
  await app.publish('bilibili');
  assert.equal((await app.request(route, { method: 'POST', body: payload('bilibili', { body: 'different' }) })).body.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(continued, 0);
  assert.equal((await app.request(route, { method: 'POST', body: payload('bilibili') })).status, 200);
  assert.equal(continued, 1);
  assert.equal((await app.request(route, { method: 'POST', body: payload('bilibili') })).status, 200);
  assert.equal(continued, 1);
});
