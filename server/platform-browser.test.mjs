import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { collectDiagnosticPage, createPlatformBrowser, publicAccount, publicLogin } from './platform-browser.mjs';
import { waitForPublication, waitUntil } from './platform-browser-helpers.mjs';

const account = { uid: 'a'.repeat(24), name: '测试账号', profileUrl: `https://www.xiaohongshu.com/user/profile/${'a'.repeat(24)}` };

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'fatiao-platform-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  const accountPages = [];
  let identity = options.account || null;
  let identityRead = options.readAccount;
  let publishOperation = options.publish || (async () => ({ id: 'b'.repeat(24), account }));
  const adapter = { id: 'xiaohongshu', name: '小红书', homeUrl: 'https://www.xiaohongshu.com/explore', defaultHeadless: true,
    ...(options.resumeUrl ? { resumeUrl: options.resumeUrl } : {}),
    ...(options.resumeHeadless !== undefined ? { resumeHeadless: options.resumeHeadless } : {}),
    ...(options.hasChallenge ? { hasChallenge: options.hasChallenge } : {}),
    ...(options.update ? { update: options.update } : {}),
    ...(options.delete ? { delete: options.delete } : {}),
    ...(options.reconcilePublication ? { reconcilePublication: options.reconcilePublication } : {}),
    ...(options.reconcileOperation ? { reconcileOperation: options.reconcileOperation } : {}),
    ...(options.inspectComposerDraft ? { inspectComposerDraft: options.inspectComposerDraft } : {}),
    ...(options.clearComposerDraft ? { clearComposerDraft: options.clearComposerDraft } : {}),
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    async readAccount(page) { accountPages.push(page); return identityRead ? identityRead(page) : identity; }, async login(page) { calls.push('login'); return page; },
    async getLoginQr() { return { kind: 'qr', image: 'data:image/png;base64,YQ==' }; },
    publish: (...args) => publishOperation(...args) };
  const contexts = [];
  function createContext() {
    const context = new EventEmitter();
    const pages = [];
    const addPage = (address = '') => {
      const page = { address, closed: false, isClosed() { return this.closed; }, url() { return this.address; },
        async goto(url) { this.address = url; calls.push(['goto', url]); }, async reload() { calls.push('reload'); },
        async close() { this.closed = true; calls.push(['page-close', this.address]); },
        ...(options.evaluate ? { evaluate: options.evaluate } : {}),
        ...(options.screenshot ? { screenshot: options.screenshot } : {}),
        locator: () => ({ count: async () => options.challenge ? 1 : 0 }),
        setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, async bringToFront() { calls.push('front'); } };
      pages.push(page); return page;
    };
    addPage();
    context.addPage = addPage;
    context.pages = () => pages.filter((candidate) => !candidate.closed);
    context.newPage = async () => { calls.push('new-page'); return addPage(); };
    context.close = async () => { calls.push('close'); pages.forEach((candidate) => { candidate.closed = true; }); context.emit('close'); };
    contexts.push(context); return context;
  }
  const chromium = { async launchPersistentContext(profile, launchOptions) {
    calls.push(['launch', profile, launchOptions]);
    await options.beforeLaunch?.(launchOptions);
    return createContext();
  } };
  const acquisitions = [];
  const currentChrome = options.currentChrome ? { async acquire(platform) {
    acquisitions.push(platform);
    if (options.acquireError) throw options.acquireError;
    return createContext();
  } } : undefined;
  const browser = createPlatformBrowser({ platform: 'xiaohongshu', dataDir, chromium, adapter, resumeTimeoutMs: 30, currentChrome, ...options.driver });
  t.after(() => browser.close());
  return { browser, calls, dataDir, contexts, acquisitions, accountPages, setAccount(value) { identity = value; }, setReadAccount(fn) { identityRead = fn; }, setPublish(fn) { publishOperation = fn; } };
}

test('current Chrome login, open and resume share one visible context without launching a browser', async t => {
  const f = await fixture(t, { currentChrome: true, account });
  assert.equal(f.browser.browserMode, 'current-chrome');
  for (const status of [await f.browser.login({ mode: 'qr' }), await f.browser.open(), await f.browser.resume()]) {
    assert.equal(status.connected, true);
    assert.equal(status.headless, false);
  }
  assert.deepEqual(f.acquisitions, ['xiaohongshu']);
  assert.equal(f.contexts.length, 1);
  assert.equal(f.calls.includes('close'), false);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'goto').length, 1);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'launch'), false);
});

test('current Chrome remembers its own connection and disconnect preserves the legacy profile', async t => {
  const f = await fixture(t, { currentChrome: true, account });
  const legacyProfile = path.join(f.dataDir, 'xiaohongshu-profile');
  const connectionDir = path.join(f.dataDir, 'xiaohongshu-chrome-connection');
  await mkdir(legacyProfile);
  await writeFile(path.join(legacyProfile, '.fatiao-session-saved'), '1\n');
  await writeFile(path.join(legacyProfile, 'preserved-cookie-data'), 'keep');
  assert.equal((await f.browser.status()).sessionSaved, false);
  assert.equal((await f.browser.resume()).sessionSaved, false);
  assert.deepEqual(f.acquisitions, []);
  await f.browser.login();
  assert.ok((await lstat(path.join(connectionDir, '.fatiao-session-saved'))).isFile());
  assert.equal((await f.browser.close()).sessionSaved, true);
  const resumed = await f.browser.resume();
  assert.equal(resumed.connected, true);
  assert.equal(resumed.headless, false);
  assert.deepEqual(f.acquisitions, ['xiaohongshu', 'xiaohongshu']);
  assert.equal((await f.browser.disconnect()).sessionSaved, false);
  await assert.rejects(lstat(connectionDir), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(legacyProfile, 'preserved-cookie-data'), 'utf8'), 'keep');
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'launch'), false);
});

test('current Chrome connection errors reach the caller without launching a fallback browser', async t => {
  const error = Object.assign(new Error('Chrome connection authorization required'), { code: 'CHROME_CONNECTION_REQUIRED' });
  const f = await fixture(t, { currentChrome: true, acquireError: error });
  await assert.rejects(f.browser.open(), failure => failure === error);
  assert.deepEqual(f.acquisitions, ['xiaohongshu']);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'launch'), false);
  assert.equal((await f.browser.status()).browserOpen, false);
});

test('closing the last current Chrome tab retains display identity across driver restart without authorizing publishing', async t => {
  const f = await fixture(t, { currentChrome: true, account: { ...account, token: 'PRIVATE_TOKEN', cookies: 'PRIVATE_COOKIES' } });
  const verified = await f.browser.open();
  assert.equal(verified.accountVerification, 'verified');
  f.contexts[0].pages()[0].closed = true;
  const acquisitions = f.acquisitions.length;
  const retained = await f.browser.status();
  assert.equal(retained.connected, false);
  assert.equal(retained.browserOpen, false);
  assert.equal(retained.publishReady, false);
  assert.equal(retained.sessionSaved, true);
  assert.equal(retained.accountVerification, 'required');
  assert.deepEqual(retained.account, account);
  assert.equal(f.acquisitions.length, acquisitions);
  const metadata = path.join(f.dataDir, 'xiaohongshu-chrome-connection', 'account.json');
  const bytes = await readFile(metadata, 'utf8');
  assert.deepEqual(JSON.parse(bytes), { version: 1, account });
  assert.doesNotMatch(bytes, /PRIVATE_|token|cookies/);
  assert.equal((await lstat(metadata)).mode & 0o777, 0o600);
  const restored = createPlatformBrowser({ platform: 'xiaohongshu', dataDir: f.dataDir,
    currentChrome: { acquire() { assert.fail('reading a bound account must not connect Chrome'); } } });
  const restartedStatus = await restored.status();
  assert.deepEqual(restartedStatus.account, account);
  assert.equal(restartedStatus.accountVerification, 'required');
  assert.equal(restartedStatus.publishReady, false);
  await restored.disconnect();
  const disconnected = await restored.status();
  assert.equal(disconnected.account, undefined);
  assert.equal(disconnected.sessionSaved, false);
  assert.equal(disconnected.accountVerification, undefined);
});

test('a cached shared Chrome account cannot publish after a closed tab restores an expired or changed login', async t => {
  for (const restoredAccount of [undefined, { ...account, uid: 'b'.repeat(24) }]) {
    const f = await fixture(t, { currentChrome: true, account, publish() { assert.fail('cached identity must not publish'); } });
    await f.browser.open();
    await f.browser.close();
    assert.deepEqual((await f.browser.status()).account, account);
    f.setAccount(restoredAccount);
    await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit() { assert.fail('must not create a checkpoint'); } }),
      { code: restoredAccount ? 'ACCOUNT_CHANGED' : 'LOGIN_REQUIRED' });
    assert.equal(f.acquisitions.length, 2);
  }
});

test('only explicit refresh reopens a closed shared Chrome tab to verify the binding', async t => {
  const f = await fixture(t, { currentChrome: true, account });
  await f.browser.open();
  await f.browser.close();
  assert.equal((await f.browser.status()).accountVerification, 'required');
  assert.equal(f.acquisitions.length, 1);
  const refreshed = await f.browser.refresh();
  assert.equal(refreshed.accountVerification, 'verified');
  assert.equal(refreshed.connected, true);
  assert.equal(refreshed.publishReady, true);
  assert.equal(f.acquisitions.length, 2);
});

test('status and refresh never launch a browser or create a profile', async (t) => {
  const { browser, calls, dataDir } = await fixture(t);
  assert.equal((await browser.status()).browserOpen, false);
  assert.equal((await browser.refresh()).sessionSaved, false);
  assert.deepEqual(calls, []);
  await assert.rejects(lstat(path.join(dataDir, 'xiaohongshu-profile')), { code: 'ENOENT' });
});

test('login uses an isolated private Chrome profile and returns only official QR data', async (t) => {
  const { browser, calls, dataDir } = await fixture(t);
  const status = await browser.login();
  assert.equal(status.headless, true);
  assert.equal(status.login.kind, 'qr');
  assert.equal(status.publishReady, false);
  const launch = calls.find((call) => Array.isArray(call) && call[0] === 'launch');
  assert.equal(launch[1], path.join(dataDir, 'xiaohongshu-profile'));
  assert.equal(launch[2].channel, 'chrome');
  assert.equal(launch[2].chromiumSandbox, true);
  assert.equal((await lstat(launch[1])).mode & 0o777, 0o700);
});

test('close retains the saved session, disconnect deletes only its profile', async (t) => {
  const { browser, dataDir, setAccount } = await fixture(t);
  await writeFile(path.join(dataDir, 'unrelated.txt'), 'keep');
  await browser.login(); setAccount(account);
  assert.equal((await browser.status()).connected, true);
  const status = await browser.close();
  assert.equal(status.sessionSaved, true);
  assert.equal(status.connected, false);
  assert.ok((await lstat(path.join(dataDir, 'xiaohongshu-profile'))).isDirectory());
  assert.equal((await browser.disconnect()).sessionSaved, false);
  assert.equal(await readFile(path.join(dataDir, 'unrelated.txt'), 'utf8'), 'keep');
});

test('open explicitly switches the same profile to a visible owned browser', async (t) => {
  const { browser, calls } = await fixture(t);
  await browser.login();
  const status = await browser.open();
  const launches = calls.filter((call) => Array.isArray(call) && call[0] === 'launch');
  assert.equal(status.headless, false);
  assert.equal(launches.length, 2);
  assert.equal(launches[0][1], launches[1][1]);
  assert.equal(launches[1][2].headless, false);
  assert.ok(launches.every(([, , options]) => options.chromiumSandbox === true));
  assert.ok(calls.indexOf('close') < calls.indexOf(launches[1]));
});

test('explicit window login overrides background default and refresh preserves a live draft', async (t) => {
  const { browser, calls, setAccount } = await fixture(t);
  const status = await browser.login({ mode: 'window' });
  assert.equal(status.headless, false);
  assert.equal(calls.find((call) => Array.isArray(call) && call[0] === 'launch')[2].headless, false);
  assert.equal(calls.find((call) => Array.isArray(call) && call[0] === 'launch')[2].chromiumSandbox, true);
  setAccount(account);
  assert.equal((await browser.refresh()).connected, true);
  assert.equal(calls.includes('reload'), false);
  setAccount(null);
  await browser.refresh();
  assert.equal(calls.includes('reload'), true);
});

test('missing Chrome falls back to bundled Chromium with the sandbox in both login modes', async t => {
  for (const mode of ['qr', 'window']) await t.test(mode, async t => {
    const f = await fixture(t, { beforeLaunch(options) {
      if (options.channel === 'chrome') throw new Error('Chromium distribution chrome is not found');
    } });
    await f.browser.login({ mode });
    const launches = f.calls.filter(call => Array.isArray(call) && call[0] === 'launch');
    assert.equal(launches.length, 2);
    assert.equal(launches[0][1], launches[1][1]);
    assert.equal(launches[0][2].channel, 'chrome');
    assert.equal(launches[1][2].channel, undefined);
    for (const [, , options] of launches) {
      assert.equal(options.headless, mode === 'qr');
      assert.equal(options.chromiumSandbox, true);
      assert.equal(options.args.some(arg => /^--no-sandbox(?:=|$)/.test(arg)), false);
    }
  });
});

test('sandbox launch failures do not retry another engine or disable the sandbox', async t => {
  for (const mode of ['qr', 'window']) await t.test(mode, async t => {
    const f = await fixture(t, { beforeLaunch() { throw new Error('No usable sandbox!'); } });
    await assert.rejects(f.browser.login({ mode }), { code: 'BROWSER_UNAVAILABLE' });
    const launches = f.calls.filter(call => Array.isArray(call) && call[0] === 'launch');
    assert.equal(launches.length, 1);
    assert.equal(launches[0][2].channel, 'chrome');
    assert.equal(launches[0][2].chromiumSandbox, true);
    assert.equal(launches[0][2].headless, mode === 'qr');
    assert.equal((await f.browser.status()).browserOpen, false);
  });
});

test('mode changes and closes wait for an active publish', async (t) => {
  const f = await fixture(t, { account });
  await f.browser.login();
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  f.setPublish(async (_page, _input, hooks) => {
    await hooks.beforeSubmit(); entered();
    await new Promise((resolve) => { release = resolve; });
    return { id: 'b'.repeat(24), account };
  });
  const publishing = f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => {} });
  await started;
  const opening = f.browser.open();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.includes('close'), false);
  release(); await publishing; await opening;
  assert.equal(f.calls.includes('close'), true);
});

test('publish rejects missing checkpoint and mismatching current account', async (t) => {
  const { browser } = await fixture(t, { account });
  await browser.login();
  await assert.rejects(browser.publish({ expectedAccountUid: account.uid }), { code: 'PUBLISH_REJECTED' });
  await assert.rejects(browser.publish({ expectedAccountUid: 'other' }, { beforeSubmit() {} }), { code: 'ACCOUNT_CHANGED' });
});

test('resume and publish never open a browser when no session was saved', async (t) => {
  const { browser, calls, dataDir } = await fixture(t);
  const status = await browser.resume();
  assert.equal(status.connected, false);
  assert.equal(status.sessionSaved, false);
  assert.equal(status.browserOpen, false);
  await assert.rejects(browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit() { assert.fail('must not submit'); } }), { code: 'LOGIN_REQUIRED' });
  assert.deepEqual(calls, []);
  await assert.rejects(lstat(path.join(dataDir, 'xiaohongshu-profile')), { code: 'ENOENT' });
});

test('a previously visible saved session resumes once in the background with a fresh account', async (t) => {
  const { browser, calls } = await fixture(t, { account });
  await browser.open();
  await browser.close();
  calls.length = 0;
  const status = await browser.resume();
  assert.equal(status.connected, true);
  assert.equal(status.publishReady, true);
  assert.equal(status.headless, true);
  assert.equal(status.account.uid, account.uid);
  const launches = calls.filter((call) => Array.isArray(call) && call[0] === 'launch');
  assert.equal(launches.length, 1);
  assert.equal(launches[0][2].headless, true);
  assert.equal(launches[0][2].chromiumSandbox, true);
  assert.equal(calls.includes('front'), false);
  assert.equal(calls.includes('login'), false);
});

test('platforms requiring interactive verification resume visibly and keep their existing challenge tab', async t => {
  const f = await fixture(t, { account, resumeHeadless: false, hasChallenge: async () => true });
  await f.browser.open(); await f.browser.close(); f.calls.length = 0;
  const status = await f.browser.resume();
  assert.equal(status.headless, false);
  assert.equal(status.connected, true);
  assert.equal(status.publishReady, false);
  assert.equal(f.calls.find(call => Array.isArray(call) && call[0] === 'launch')[2].headless, false);
  f.calls.length = 0;
  await f.browser.open();
  assert.equal(f.calls.includes('close'), false, 'opening verification must not destroy its pending native request');
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'goto'), false);
});

test('resume uses a creator recovery URL only when opening a new background context', async (t) => {
  const resumeUrl = 'https://creator.xiaohongshu.com/publish/publish?source=official&target=image';
  const f = await fixture(t, { account, resumeUrl });
  await f.browser.open();
  const visiblePage = f.contexts[0].pages()[0];
  const originalUrl = visiblePage.url();
  f.calls.length = 0;
  await f.browser.resume();
  assert.equal(visiblePage.url(), originalUrl);
  assert.deepEqual(f.calls, []);
  await f.browser.close(); f.calls.length = 0;
  const restored = await f.browser.resume();
  assert.equal(restored.connected, true); assert.equal(restored.headless, true);
  assert.deepEqual(f.calls.filter((call) => Array.isArray(call) && call[0] === 'goto'), [['goto', resumeUrl]]);
  assert.equal(f.contexts.at(-1).pages()[0].url(), resumeUrl);
  assert.equal(f.calls.includes('front'), false);
});

test('publish resumes a closed session and passes one checkpoint to one native attempt', async (t) => {
  let attempts = 0, checkpoints = 0;
  const f = await fixture(t, { account, publish: async (_page, payload, hooks) => {
    attempts++;
    assert.equal(payload.expectedAccountUid, account.uid);
    await hooks.beforeSubmit();
    return { id: 'b'.repeat(24), account };
  } });
  await f.browser.login(); await f.browser.close();
  await f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => { checkpoints++; } });
  assert.equal(attempts, 1); assert.equal(checkpoints, 1);
  assert.equal((await f.browser.status()).headless, true);
});

test('a different restored account or expired login stops before the publish checkpoint', async (t) => {
  const f = await fixture(t, { account, publish() { assert.fail('must not publish'); } });
  await f.browser.login(); await f.browser.close();
  const other = { ...account, uid: 'c'.repeat(24), name: '另一个账号' };
  f.setAccount(other);
  const status = await f.browser.resume();
  assert.equal(status.account.uid, other.uid);
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit() { assert.fail('must not submit'); } }), { code: 'ACCOUNT_CHANGED' });
  await f.browser.close(); f.setAccount(null);
  assert.equal((await f.browser.resume()).connected, false);
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit() { assert.fail('must not submit'); } }), { code: 'LOGIN_REQUIRED' });
});

test('resume keeps an existing visible session without navigating, reopening, or focusing it', async (t) => {
  const f = await fixture(t, { account });
  await f.browser.open(); f.calls.length = 0;
  const current = f.contexts[0].pages()[0];
  const status = await f.browser.resume();
  assert.equal(status.connected, true);
  assert.equal(status.headless, false);
  assert.equal(f.accountPages.at(-1), current);
  assert.deepEqual(f.calls, []);
});

test('GET and refresh recover an existing supported tab after the old handle closes', async (t) => {
  const f = await fixture(t, { account });
  await f.browser.open();
  const context = f.contexts[0]; const previous = context.pages()[0];
  context.addPage('https://creator.xiaohongshu.com.evil.test/');
  const replacement = context.addPage('https://creator.xiaohongshu.com/publish/publish');
  previous.closed = true;
  f.calls.length = 0;
  assert.equal((await f.browser.status()).connected, true);
  assert.equal(f.accountPages.at(-1), replacement);
  assert.equal((await f.browser.refresh()).connected, true);
  assert.equal(f.accountPages.at(-1), replacement);
  assert.deepEqual(f.calls, []);
});

test('an original live editor remains stable when another platform tab appears', async (t) => {
  const f = await fixture(t, { account });
  await f.browser.open();
  const context = f.contexts[0], original = context.pages()[0];
  context.addPage('https://creator.xiaohongshu.com/publish/publish');
  f.calls.length = 0;
  await f.browser.status(); await f.browser.resume();
  assert.equal(f.accountPages.at(-1), original);
  assert.deepEqual(f.calls, []);
});

test('unsupported live tabs are preserved and never count as a connected account', async (t) => {
  const f = await fixture(t, { account });
  await f.browser.open();
  const current = f.contexts[0].pages()[0]; current.address = 'https://creator.xiaohongshu.com.evil.test/';
  f.calls.length = 0; f.accountPages.length = 0;
  const status = await f.browser.resume();
  assert.equal(status.connected, false);
  assert.equal(status.browserOpen, true);
  assert.equal(current.closed, false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.accountPages, []);
});

test('status leaves an empty owned context alone; resume replaces only that empty context in headless mode', async (t) => {
  const f = await fixture(t, { account });
  await f.browser.open();
  f.contexts[0].pages()[0].closed = true;
  f.calls.length = 0;
  assert.equal((await f.browser.status()).browserOpen, false);
  assert.equal((await f.browser.refresh()).connected, false);
  assert.deepEqual(f.calls, []);
  const status = await f.browser.resume();
  assert.equal(status.connected, true); assert.equal(status.headless, true);
  assert.equal(f.calls[0], 'close');
  assert.equal(f.calls.filter((call) => Array.isArray(call) && call[0] === 'launch').length, 1);
  assert.equal(f.calls.includes('front'), false);
});

test('concurrent resume requests share one launch and one result', async (t) => {
  const f = await fixture(t, { account });
  await f.browser.login(); await f.browser.close(); f.calls.length = 0;
  const first = f.browser.resume(), second = f.browser.resume(), third = f.browser.resume();
  assert.equal(first, second); assert.equal(second, third);
  const results = await Promise.all([first, second, third]);
  assert.ok(results.every((result) => result.connected && result.account.uid === account.uid));
  assert.equal(f.calls.filter((call) => Array.isArray(call) && call[0] === 'launch').length, 1);
});

test('a slow identity probe is bounded and its late result cannot publish', async (t) => {
  const f = await fixture(t, { account, publish() { assert.fail('must not publish'); }, driver: { resumeTimeoutMs: 15 } });
  await f.browser.login(); await f.browser.close();
  let resolveProbe;
  f.setReadAccount(() => new Promise((resolve) => { resolveProbe = resolve; }));
  const start = Date.now();
  const state = await f.browser.resume();
  assert.equal(state.connected, false);
  assert.ok(Date.now() - start < 300);
  resolveProbe(account);
  f.setReadAccount(() => null);
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit() { assert.fail('must not submit'); } }), { code: 'LOGIN_REQUIRED' });
});

test('visible safety verification is returned as not ready and cannot enter publish', async (t) => {
  const options = { account, challenge: false, publish() { assert.fail('must not publish'); } };
  const f = await fixture(t, options);
  await f.browser.open(); options.challenge = true; f.calls.length = 0;
  const status = await f.browser.resume();
  assert.equal(status.connected, true); assert.equal(status.publishReady, false);
  assert.equal(status.message, '当前会话需要安全验证，请打开专用窗口完成后再继续。');
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit() { assert.fail('must not submit'); } }), { code: 'CAPTCHA_REQUIRED' });
  assert.deepEqual(f.calls, []);
});

test('an uncertain native attempt is not automatically resumed or retried', async (t) => {
  let attempts = 0, checkpoints = 0;
  const f = await fixture(t, { account, publish: async (_page, _payload, hooks) => {
    attempts++; await hooks.beforeSubmit();
    const error = new Error('result unknown'); error.code = 'PUBLISH_UNCERTAIN'; error.submitted = true; throw error;
  } });
  await f.browser.login(); await f.browser.close(); f.calls.length = 0;
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => { checkpoints++; } }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
  assert.equal(attempts, 1); assert.equal(checkpoints, 1);
  assert.equal(f.calls.filter((call) => Array.isArray(call) && call[0] === 'launch').length, 1);
});

const originalReceipt = {
  platform: 'xiaohongshu', id: 'b'.repeat(24), url: `https://www.xiaohongshu.com/explore/${'b'.repeat(24)}`,
  account, publishedAt: '2026-09-14T10:00:00.000Z', requestId: 'original-publication',
};
const mutationInput = () => ({ receipt: structuredClone(originalReceipt), expectedAccountUid: account.uid, title: '修改后的标题', body: '修改后的正文' });
const mutationReceipt = (operation) => ({ ...structuredClone(originalReceipt), [operation === 'update' ? 'updatedAt' : 'deletedAt']: '2026-09-15T10:00:00.000Z' });

for (const operation of ['update', 'delete']) {
  test(`${operation} rejects unsupported capability before launching or checking the checkpoint`, async (t) => {
    const f = await fixture(t, { account });
    await assert.rejects(f.browser[operation](mutationInput()), { code: 'OPERATION_UNSUPPORTED' });
    assert.deepEqual(f.calls, []);
    await assert.rejects(lstat(path.join(f.dataDir, 'xiaohongshu-profile')), { code: 'ENOENT' });
  });

  test(`${operation} rejects missing checkpoint and invalid original receipts before launch`, async (t) => {
    const f = await fixture(t, { account, [operation]() { assert.fail('must not invoke adapter'); } });
    await assert.rejects(f.browser[operation](mutationInput()), { code: 'PUBLISH_REJECTED' });
    const invalidInputs = [
      undefined,
      {},
      { ...mutationInput(), receipt: null },
      { ...mutationInput(), receipt: { ...originalReceipt, id: 'invalid-id' } },
      { ...mutationInput(), receipt: { ...originalReceipt, id: 123 } },
      { ...mutationInput(), receipt: { ...originalReceipt, url: undefined } },
      { ...mutationInput(), receipt: { ...originalReceipt, account: null } },
      { ...mutationInput(), receipt: { ...originalReceipt, account: { ...account, uid: 'c'.repeat(24) } } },
      { ...mutationInput(), expectedAccountUid: undefined },
    ];
    for (const input of invalidInputs) {
      await assert.rejects(f.browser[operation](input, { beforeSubmit() { assert.fail('must not checkpoint'); } }), { code: 'ACCOUNT_CHANGED' });
    }
    assert.deepEqual(f.calls, []);
    await assert.rejects(lstat(path.join(f.dataDir, 'xiaohongshu-profile')), { code: 'ENOENT' });
  });

  test(`${operation} stops before the adapter when no saved session exists`, async (t) => {
    const f = await fixture(t, { [operation]() { assert.fail('must not invoke adapter'); } });
    await assert.rejects(f.browser[operation](mutationInput(), { beforeSubmit() { assert.fail('must not checkpoint'); } }), { code: 'LOGIN_REQUIRED' });
    assert.deepEqual(f.calls, []);
  });

  test(`${operation} freshly checks the resumed account and rejects expired or changed identity`, async (t) => {
    const f = await fixture(t, { account, [operation]() { assert.fail('must not invoke adapter'); } });
    await f.browser.login(); await f.browser.close(); f.calls.length = 0;
    f.setAccount({ ...account, uid: 'c'.repeat(24) });
    const hooks = { beforeSubmit() { assert.fail('must not checkpoint'); } };
    await assert.rejects(f.browser[operation](mutationInput(), hooks), { code: 'ACCOUNT_CHANGED' });
    const launches = f.calls.filter((call) => Array.isArray(call) && call[0] === 'launch');
    assert.equal(launches.length, 1); assert.equal(launches[0][2].headless, true);
    assert.equal(f.calls.includes('front'), false);
    await f.browser.close(); f.setAccount(null);
    await assert.rejects(f.browser[operation](mutationInput(), hooks), { code: 'LOGIN_REQUIRED' });
  });

  test(`${operation} stops before the adapter when the current session requires verification`, async (t) => {
    const options = { account, challenge: false, [operation]() { assert.fail('must not invoke adapter'); } };
    const f = await fixture(t, options);
    await f.browser.login(); options.challenge = true;
    await assert.rejects(f.browser[operation](mutationInput(), { beforeSubmit() { assert.fail('must not checkpoint'); } }), { code: 'CAPTCHA_REQUIRED' });
  });

  test(`${operation} resumes once, submits once, and serializes close until the adapter completes`, async (t) => {
    let attempts = 0, checkpoints = 0, release, entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const input = mutationInput(), result = mutationReceipt(operation);
    const f = await fixture(t, { account, [operation]: async (page, payload, hooks) => {
      attempts++;
      assert.equal(page, f.contexts.at(-1).pages().at(-1));
      assert.notEqual(page, f.contexts.at(-1).pages()[0]); assert.equal(payload, input);
      await hooks.beforeSubmit(); entered();
      await new Promise((resolve) => { release = resolve; });
      return result;
    } });
    await f.browser.login(); await f.browser.close(); f.calls.length = 0;
    const pending = f.browser[operation](input, { beforeSubmit: async () => { checkpoints++; } });
    await started;
    const closing = f.browser.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.includes('close'), false);
    release(); assert.equal(await pending, result); await closing;
    assert.equal(attempts, 1); assert.equal(checkpoints, 1);
    assert.equal(f.calls.filter((call) => Array.isArray(call) && call[0] === 'launch').length, 1);
    assert.equal(f.calls.filter((call) => call === 'close').length, 1);
  });

  test(`${operation} uses and closes its own operation tab while preserving an existing visible draft`, async (t) => {
    let operationPage;
    const f = await fixture(t, { account, [operation]: async (page, _input, hooks) => {
      operationPage = page;
      await page.goto(`https://creator.xiaohongshu.com/new/note-manager?operation=${operation}`);
      await hooks.beforeSubmit(); return mutationReceipt(operation);
    } });
    await f.browser.open();
    const original = f.contexts[0].pages()[0];
    original.address = 'https://creator.xiaohongshu.com/publish/publish?draft=preserve';
    f.calls.length = 0;
    await f.browser[operation](mutationInput(), { beforeSubmit: async () => {} });
    assert.notEqual(operationPage, original); assert.equal(operationPage.closed, true);
    assert.equal(original.closed, false);
    assert.equal(original.url(), 'https://creator.xiaohongshu.com/publish/publish?draft=preserve');
    assert.deepEqual(f.contexts[0].pages(), [original]);
    assert.equal(f.calls.filter((call) => call === 'new-page').length, 1);
    assert.equal(f.calls.includes('front'), false); assert.equal(f.calls.includes('close'), false);
    assert.equal((await f.browser.status()).headless, false);
  });

  test(`${operation} checkpoint failure prevents the final native action`, async (t) => {
    let attempts = 0, finalActions = 0, checkpoints = 0, operationPage;
    const storageError = Object.assign(new Error('checkpoint storage failed'), { code: 'CHECKPOINT_FAILED' });
    const f = await fixture(t, { account, [operation]: async (page, _input, hooks) => {
      operationPage = page; attempts++; await hooks.beforeSubmit(); finalActions++;
      return mutationReceipt(operation);
    } });
    await f.browser.login();
    await assert.rejects(f.browser[operation](mutationInput(), { beforeSubmit: async () => { checkpoints++; throw storageError; } }), (error) => {
      assert.equal(error, storageError); assert.notEqual(error.submitted, true); return true;
    });
    assert.equal(attempts, 1); assert.equal(checkpoints, 1); assert.equal(finalActions, 0);
    assert.equal(operationPage.closed, true); assert.equal(f.contexts[0].pages().length, 1);
  });

  test(`${operation} closes an operation tab whose initial navigation fails and releases the queue`, async (t) => {
    let operationPage;
    const navigationError = new Error('operation page could not load');
    const f = await fixture(t, { account, [operation]() { assert.fail('must not invoke adapter'); } });
    await f.browser.login();
    const context = f.contexts[0], originalPage = context.pages()[0], newPage = context.newPage;
    context.newPage = async () => {
      operationPage = await newPage();
      operationPage.goto = async () => { throw navigationError; };
      return operationPage;
    };
    await assert.rejects(f.browser[operation](mutationInput(), { beforeSubmit() { assert.fail('must not checkpoint'); } }), (error) => {
      assert.equal(error, navigationError); assert.notEqual(error.submitted, true); return true;
    });
    assert.equal(operationPage.closed, true); assert.deepEqual(context.pages(), [originalPage]);
    assert.equal((await f.browser.status()).account.uid, account.uid);
  });

  test(`${operation} rejects a second checkpoint without repeating the native action`, async (t) => {
    let checkpoints = 0, finalActions = 0;
    const f = await fixture(t, { account, [operation]: async (_page, _input, hooks) => {
      await hooks.beforeSubmit(); finalActions++;
      await hooks.beforeSubmit(); finalActions++;
      return mutationReceipt(operation);
    } });
    await f.browser.login();
    await assert.rejects(f.browser[operation](mutationInput(), { beforeSubmit: async () => { checkpoints++; } }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
    assert.equal(checkpoints, 1); assert.equal(finalActions, 1);
  });

  test(`${operation} rejects overlapping checkpoint calls before the first checkpoint resolves`, async (t) => {
    let checkpoints = 0;
    const f = await fixture(t, { account, [operation]: async (_page, _input, hooks) => {
      const outcomes = await Promise.allSettled([hooks.beforeSubmit(), hooks.beforeSubmit()]);
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
      if (rejected) throw rejected.reason;
      return mutationReceipt(operation);
    } });
    await f.browser.login();
    await assert.rejects(f.browser[operation](mutationInput(), { beforeSubmit: async () => {
      checkpoints++; await new Promise((resolve) => setImmediate(resolve));
    } }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
    assert.equal(checkpoints, 1);
  });

  test(`${operation} never accepts a success result without the required checkpoint`, async (t) => {
    const f = await fixture(t, { account, [operation]: async () => mutationReceipt(operation) });
    await f.browser.login();
    await assert.rejects(f.browser[operation](mutationInput(), { beforeSubmit() { assert.fail('adapter omitted the checkpoint'); } }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
  });

  test(`${operation} reports unknown or mismatched receipts and timestamps as uncertain without retry`, async (t) => {
    const timestamp = operation === 'update' ? 'updatedAt' : 'deletedAt';
    const otherTimestamp = operation === 'update' ? 'deletedAt' : 'updatedAt';
    const valid = mutationReceipt(operation);
    const invalidResults = [
      undefined,
      { ...valid, id: 'c'.repeat(24) },
      { ...valid, url: `${valid.url}?different=1` },
      { ...valid, account: { ...account, uid: 'c'.repeat(24) } },
      { ...valid, account: null },
      { ...valid, [timestamp]: undefined },
      { ...valid, [timestamp]: undefined, [otherTimestamp]: '2026-09-15T10:00:00.000Z' },
      { ...valid, [timestamp]: 1_789_466_400_000 },
      { ...valid, [timestamp]: 'not a timestamp' },
    ];
    let result, attempts = 0, checkpoints = 0;
    const f = await fixture(t, { account, [operation]: async (_page, _input, hooks) => {
      attempts++; await hooks.beforeSubmit(); return result;
    } });
    await f.browser.login();
    for (result of invalidResults) {
      await assert.rejects(f.browser[operation](mutationInput(), { beforeSubmit: async () => { checkpoints++; } }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
    }
    assert.equal(attempts, invalidResults.length); assert.equal(checkpoints, invalidResults.length);
  });

  test(`${operation} preserves adapter error details and submission state after the checkpoint`, async (t) => {
    let attempts = 0, checkpoints = 0;
    const nativeError = Object.assign(new Error('native response unavailable'), { code: 'NATIVE_TIMEOUT' });
    const f = await fixture(t, { account, [operation]: async (_page, _input, hooks) => {
      attempts++; await hooks.beforeSubmit(); throw nativeError;
    } });
    await f.browser.login();
    await assert.rejects(f.browser[operation](mutationInput(), { beforeSubmit: async () => { checkpoints++; } }), (error) => {
      assert.equal(error.cause, nativeError); assert.equal(error.message, nativeError.message);
      assert.equal(error.code, 'NATIVE_TIMEOUT'); assert.equal(error.submitted, true); return true;
    });
    assert.equal(attempts, 1); assert.equal(checkpoints, 1);
  });

  test(`${operation} retains submission uncertainty for primitive and frozen adapter errors`, async (t) => {
    let thrown;
    const f = await fixture(t, { account, [operation]: async (_page, _input, hooks) => {
      await hooks.beforeSubmit(); throw thrown;
    } });
    await f.browser.login();
    for (thrown of ['native transport failed', Object.freeze(new Error('native transport failed'))]) {
      await assert.rejects(f.browser[operation](mutationInput(), { beforeSubmit: async () => {} }), (error) => {
        assert.equal(error.submitted, true); assert.equal(error.cause, thrown);
        assert.equal(error.code, 'PUBLISH_UNCERTAIN'); assert.notEqual(error.name, 'TypeError'); return true;
      });
    }
  });
}

test('profile and configured data directory symlinks are rejected for login and deletion', async (t) => {
  const { browser, dataDir } = await fixture(t);
  const other = await mkdtemp(path.join(await realpath(os.tmpdir()), 'fatiao-untouched-test-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  await writeFile(path.join(other, 'keep'), 'present');
  await symlink(other, path.join(dataDir, 'xiaohongshu-profile'));
  await assert.rejects(browser.login(), { code: 'BROWSER_UNAVAILABLE' });
  await assert.rejects(browser.disconnect(), { code: 'BROWSER_UNAVAILABLE' });
  assert.equal(await readFile(path.join(other, 'keep'), 'utf8'), 'present');
  await rm(path.join(dataDir, 'xiaohongshu-profile'));
  await symlink(other, path.join(dataDir, 'linked-data'));
  const nested = createPlatformBrowser({ platform: 'xiaohongshu', dataDir: path.join(dataDir, 'linked-data') });
  await assert.rejects(nested.status(), { code: 'BROWSER_UNAVAILABLE' });
});

test('public status rejects token objects and remote/SVG QR links', () => {
  assert.deepEqual(publicAccount({ ...account, cookie: 'SECRET', token: 'SECRET', avatarUrl: 'https://images.example/test.png' }),
    { ...account, avatarUrl: 'https://images.example/test.png' });
  assert.equal(publicAccount({ ...account, profileUrl: 'javascript:alert(1)' }), undefined);
  for (const image of ['https://example.org/qr.png', 'data:image/svg+xml;base64,YQ==', 'data:text/html;base64,YQ==']) assert.deepEqual(publicLogin({ kind: 'qr', image }), { kind: 'window' });
  assert.deepEqual(publicLogin({ kind: 'qr', expiresAt: '2026-09-14T12:00:00Z' }), { kind: 'qr', expiresAt: '2026-09-14T12:00:00Z' });
});

test('publication observer accepts only a matched successful response and cleans listeners', async () => {
  const page = new EventEmitter();
  const waiter = waitForPublication(page, (response) => response.matches, { timeoutMs: 50 });
  page.emit('response', { matches: false });
  page.emit('response', { matches: true, ok: () => true, text: async () => '{"code":0}' });
  assert.equal(await waiter.promise, '{"code":0}');
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(page.listenerCount('close'), 0);
  waiter.cancel();
});

test('publication timeout and close are uncertain; polling is bounded', async () => {
  const page = new EventEmitter();
  const timeout = waitForPublication(page, () => true, { timeoutMs: 1 });
  await assert.rejects(timeout.promise, { code: 'PUBLISH_UNCERTAIN' });
  const closed = waitForPublication(page, () => true, { timeoutMs: 50 });
  page.emit('close');
  await assert.rejects(closed.promise, { code: 'PUBLISH_UNCERTAIN' });
  assert.equal(await waitUntil(async () => false, 1), false);
  assert.equal(await waitUntil(async () => 'ready', 1), 'ready');
});

test('isolated Chrome resumes a saved local fixture session in the background', { skip: process.env.FATIAO_RESUME_DOM_TEST !== '1' }, async () => {
  const { createServer } = await import('node:http');
  const { chromium } = await import('playwright');
  const dataDir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'fatiao-resume-dom-'));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ path: request.url, method: request.method });
    if (request.url === '/login') {
      // This is a synthetic local test session, never a real platform credential.
      response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'fixture_session=local-test; Path=/; Max-Age=600; HttpOnly; SameSite=Lax' });
      response.end('<!doctype html><title>Local session fixture</title><p>Signed in locally</p>');
    } else if (request.url === '/identity') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(request.headers.cookie?.includes('fixture_session=local-test') ? { account } : { account: null }));
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>Local session fixture</title><p>Session verification</p>');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const launches = [];
  let attempts = 0, checkpoints = 0;
  const adapter = {
    id: 'xiaohongshu', name: '本地验收', defaultHeadless: true, homeUrl: `${origin}/`, loginUrl: `${origin}/login`,
    async login(page) { await page.goto(`${origin}/login`); return page; },
    async readAccount(page) { return page.evaluate(async () => (await (await fetch('/identity', { credentials: 'same-origin', cache: 'no-store' })).json()).account); },
    async publish(_page, _input, hooks) { attempts++; await hooks.beforeSubmit(); return { id: 'b'.repeat(24), account }; },
  };
  const browser = createPlatformBrowser({ platform: 'xiaohongshu', dataDir, adapter, resumeTimeoutMs: 2_000, chromium: {
    async launchPersistentContext(profile, options) {
      launches.push({ profile, headless: options.headless });
      const context = await chromium.launchPersistentContext(profile, { ...options, args: [...options.args, '--enable-automation'], serviceWorkers: 'block' });
      try {
        const session = await context.newCDPSession(context.pages()[0] || await context.newPage());
        try {
          const { arguments: args } = await session.send('Browser.getBrowserCommandLine');
          assert.equal(args.some(arg => /^--no-sandbox(?:=|$)/.test(arg)), false);
        } finally { await session.detach(); }
      } catch (error) { await context.close(); throw error; }
      // Allow only the local fixture server, including subresource requests.
      await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      return context;
    },
  } });
  try {
    assert.equal((await browser.status()).browserOpen, false);
    assert.equal(launches.length, 0);
    assert.equal((await browser.login()).account.uid, account.uid);
    await browser.close();
    const loginRequests = requests.filter((request) => request.path === '/login').length;
    const restored = await browser.resume();
    assert.equal(restored.account.uid, account.uid); assert.equal(restored.headless, true); assert.equal(restored.publishReady, true);
    assert.equal(launches.length, 2); assert.equal(launches[1].headless, true); assert.equal(launches[1].profile, launches[0].profile);
    assert.equal(requests.filter((request) => request.path === '/login').length, loginRequests);
    await browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => { checkpoints++; } });
    assert.equal(attempts, 1); assert.equal(checkpoints, 1);
    assert.equal(requests.some((request) => request.method === 'POST'), false);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

const reconciledReceipt = { id: 'b'.repeat(24), url: `https://www.xiaohongshu.com/explore/${'b'.repeat(24)}`, publishedAt: '2026-09-15T12:00:00.000Z', account };
const reconcileInput = () => ({ requestId: 'original-publish-request', contentId: 'original-content', expectedAccountUid: account.uid, title: '原始标题', body: '原始正文', images: ['unchanged-image'] });
const reconcileOptions = { attemptedAt: '2026-09-15T11:59:59.000Z' };
test('operation reconciliation owns a read-only tab and preserves the live draft on success and failure', async (t) => {
  for (const throws of [false, true]) {
    let inspected;
    const f = await fixture(t, { account, update() { assert.fail('must not update'); }, delete() { assert.fail('must not delete'); },
      reconcileOperation: async (page, input, options) => {
        inspected = page; assert.equal(options.beforeSubmit, undefined);
        if (throws) throw new Error('read failed');
        return { ...input.receipt, updatedAt: '2026-09-15T00:00:00Z' };
      } });
    await f.browser.open();
    const original = f.contexts[0].pages()[0], originalUrl = original.url();
    const pending = f.browser.reconcileOperation({ receipt: reconciledReceipt, expectedAccountUid: account.uid }, { operation: 'update', ...reconcileOptions });
    if (throws) await assert.rejects(pending, /read failed/);
    else assert.equal((await pending).id, reconciledReceipt.id);
    assert.notEqual(inspected, original); assert.equal(inspected.closed, true);
    assert.equal(original.closed, false); assert.equal(original.url(), originalUrl);
  }
});

test('read-only reconciliation is optional and unavailable adapters expose no retry method', async (t) => {
  const f = await fixture(t);
  assert.equal(f.browser.reconcilePublication, undefined);
  assert.deepEqual(f.calls, []);
});

test('read-only reconciliation resumes the original account and never publishes, clicks, or changes its editor', async (t) => {
  let reconciliations = 0, inspectedPage;
  const input = reconcileInput();
  const f = await fixture(t, { account, publish() { assert.fail('a pending request must never be published again'); },
    reconcilePublication: async (page, payload, options) => {
      inspectedPage = page; reconciliations++;
      assert.deepEqual(payload, input); assert.deepEqual(options, reconcileOptions);
      assert.equal(options.beforeSubmit, undefined);
      payload.body = 'adapter cannot mutate the source'; payload.images.push('another-image');
      return reconciledReceipt;
    },
  });
  await f.browser.open();
  const original = f.contexts[0].pages()[0], originalUrl = original.url();
  f.calls.length = 0;
  assert.equal(await f.browser.reconcilePublication(input, reconcileOptions), reconciledReceipt);
  assert.equal(reconciliations, 1); assert.equal(inspectedPage, original);
  assert.equal(original.url(), originalUrl); assert.equal(original.closed, false);
  assert.deepEqual(input, reconcileInput()); assert.deepEqual(f.calls, []);
  await assert.rejects(lstat(path.join(f.dataDir, 'xiaohongshu-operation-error.json')), { code: 'ENOENT' });
  await f.browser.close(); f.calls.length = 0;
  assert.equal(await f.browser.reconcilePublication(input, reconcileOptions), reconciledReceipt);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'launch').length, 1);
  assert.equal(f.calls.find(call => Array.isArray(call) && call[0] === 'launch')[2].headless, true);
  assert.equal(f.calls.includes('front'), false); assert.equal(f.calls.includes('login'), false);
});

test('reconciliation is serialized with close and releases its queue after uncertainty', async (t) => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { account, reconcilePublication: async () => { entered(); await gate; return undefined; } });
  await f.browser.login(); f.calls.length = 0;
  const pending = f.browser.reconcilePublication(reconcileInput(), reconcileOptions);
  const failure = assert.rejects(pending, { code: 'PUBLISH_UNCERTAIN', submitted: true });
  await started;
  const closing = f.browser.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.includes('close'), false);
  release(); await failure; await closing;
  assert.equal(f.calls.includes('close'), true);
  assert.equal((await f.browser.status()).browserOpen, false);
});

test('reconciliation cannot use a changed account, expired session, or challenge to release a pending request', async (t) => {
  for (const condition of ['account-changed', 'expired', 'challenge']) {
    const f = await fixture(t, { account, challenge: condition === 'challenge',
      reconcilePublication() { assert.fail('must not inspect under an unverified account'); },
      publish() { assert.fail('must not publish'); },
    });
    await f.browser.login();
    if (condition === 'account-changed') f.setAccount({ ...account, uid: 'c'.repeat(24) });
    if (condition === 'expired') f.setAccount(null);
    await assert.rejects(f.browser.reconcilePublication(reconcileInput(), reconcileOptions), { code: condition === 'challenge' ? 'CAPTCHA_REQUIRED' : 'PUBLISH_UNCERTAIN', submitted: true });
  }
});

test('invalid reconciliation timestamps stop before browser recovery and keep uncertainty', async (t) => {
  const f = await fixture(t, { reconcilePublication() { assert.fail('must not reconcile'); } });
  for (const options of [{}, { attemptedAt: 'invalid' }, { attemptedAt: 1 }]) {
    await assert.rejects(f.browser.reconcilePublication(reconcileInput(), options), { code: 'PUBLISH_UNCERTAIN', submitted: true });
  }
  assert.deepEqual(f.calls, []);
  await assert.rejects(lstat(path.join(f.dataDir, 'xiaohongshu-profile')), { code: 'ENOENT' });
});

test('missing, malformed, and failed read-only evidence never falls back to a native submission', async (t) => {
  let evidence, attempts = 0;
  const f = await fixture(t, { account, publish() { assert.fail('must not publish'); }, reconcilePublication: async () => {
    attempts++;
    if (evidence instanceof Error || typeof evidence === 'string') throw evidence;
    return evidence;
  } });
  await f.browser.login();
  const values = [undefined, {}, { ...reconciledReceipt, account: { ...account, uid: 'other' } }, { ...reconciledReceipt, publishedAt: 'invalid' },
    Object.freeze(Object.assign(new Error('native read failed'), { code: 'LOGIN_REQUIRED', submitted: false })), 'native primitive failure'];
  for (evidence of values) await assert.rejects(f.browser.reconcilePublication(reconcileInput(), reconcileOptions), { code: 'PUBLISH_UNCERTAIN', submitted: true });
  assert.equal(attempts, values.length);
});

test('failed publish writes a private bounded diagnostic with fixed error text and no request data', async (t) => {
  const secret = 'RAW_SECRET_DO_NOT_SAVE';
  let diagnosticCalls = 0;
  const failure = Object.assign(new Error(`native ${secret} https://example.test/?token=${secret}`), { code: 'UI_CHANGED' });
  const f = await fixture(t, { account,
    evaluate: async (_fn, args) => {
      assert.equal(args.origin, 'https://creator.xiaohongshu.com');
      return { labels: ['发布', secret, '保存', '发布'], body: secret, cookies: secret };
    },
    diagnostics: async () => { diagnosticCalls++; return {
      rawResponse: secret, cookies: secret,
      editor: { count: 1, pictureCount: 2, bodyLength: 34, bodyHash: 'a'.repeat(64), body: secret, editorId: '123456' },
      dialogs: ['确认', '首次发布规范确认窗口', secret],
      responseMetadata: [{ path: '/x/dynamic/feed/create/dyn', status: 200, code: -400, id: '123456', raw: secret }, { path: `/x/polymer/secret?token=${secret}`, status: 200 }],
    }; },
    publish: async (_page, _input, hooks) => { await hooks.beforeSubmit(); throw failure; },
  });
  await f.browser.login();
  f.contexts[0].pages()[0].address = `https://creator.xiaohongshu.com/publish/publish?token=${secret}#${secret}`;
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid, title: secret, body: secret, images: [secret] }, { beforeSubmit: async () => {} }), error => error === failure);
  const file = path.join(f.dataDir, 'xiaohongshu-operation-error.json');
  const raw = await readFile(file, 'utf8'), diagnostic = JSON.parse(raw);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.equal((await lstat(f.dataDir)).mode & 0o777, 0o700);
  assert.equal(diagnostic.stage, 'confirm_publication'); assert.equal(diagnostic.submitted, true);
  assert.equal(diagnostic.code, 'UI_CHANGED'); assert.equal(diagnostic.path, '/publish/publish');
  assert.deepEqual(diagnostic.page, { visibleText: '发布\n保存' });
  assert.deepEqual(diagnostic.adapter.editor, { count: 1, pictureCount: 2, bodyLength: 34, bodyHash: 'a'.repeat(64), editorId: '123456' });
  assert.deepEqual(diagnostic.adapter.dialogs, ['确认', '首次发布规范确认窗口']);
  assert.deepEqual(diagnostic.adapter.responseMetadata, [{ path: '/x/dynamic/feed/create/dyn', status: 200, code: -400, id: '123456' }]);
  assert.equal(diagnosticCalls, 1); assert.equal(raw.includes(secret), false); assert.equal(raw.includes('token='), false);
  assert.equal(raw.includes('rawResponse'), false); assert.equal(raw.includes('cookies'), false); assert.ok(raw.length < 4_000);
});

test('native lifecycle errors are diagnosed before closing only the failed temporary tab', async (t) => {
  const secret = 'RAW_NATIVE_STACK_AND_INPUT';
  let failedPage;
  const nativeError = new Error(`native input ${secret} https://example.test/?password=${secret}`);
  const f = await fixture(t, { account, evaluate: async () => ({ labels: ['取消', secret] }), update: async (page, _input, hooks) => {
    failedPage = page; await hooks.beforeSubmit();
    page.address = `https://www.xiaohongshu.com/explore/${'b'.repeat(24)}?password=${secret}`;
    throw nativeError;
  } });
  await f.browser.login();
  const original = f.contexts[0].pages()[0];
  await assert.rejects(f.browser.update(mutationInput(), { beforeSubmit: async () => {} }), error => error.cause === nativeError && error.submitted === true);
  const raw = await readFile(path.join(f.dataDir, 'xiaohongshu-operation-error.json'), 'utf8'), diagnostic = JSON.parse(raw);
  assert.equal(diagnostic.operation, 'update'); assert.equal(diagnostic.stage, 'confirm_operation');
  assert.equal(diagnostic.code, 'NATIVE_OPERATION_FAILED'); assert.equal(diagnostic.path, '/explore/:id');
  assert.deepEqual(diagnostic.page, { visibleText: '取消' }); assert.equal(raw.includes(secret), false);
  assert.equal(failedPage.closed, true); assert.equal(original.closed, false);
});

test('diagnostics normalize unknown path segments and never read an outside-platform page', async (t) => {
  let reads = 0;
  const f = await fixture(t, { account, evaluate: async () => { reads++; return { labels: ['发布'] }; }, publish: async page => {
    page.address = 'https://www.xiaohongshu.com/token/PRIVATE_PATH_TOKEN?secret=PRIVATE_QUERY';
    throw new Error('do not persist raw native error');
  } });
  await f.browser.login();
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => {} }));
  let raw = await readFile(path.join(f.dataDir, 'xiaohongshu-operation-error.json'), 'utf8');
  assert.equal(JSON.parse(raw).path, '[unrecognized-path]'); assert.equal(raw.includes('PRIVATE'), false);
  f.contexts[0].pages()[0].address = 'https://www.xiaohongshu.com/explore';
  f.setPublish(async page => { page.address = 'https://outside.example.test/private'; throw new Error('native failure'); });
  const before = reads;
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => {} }));
  raw = await readFile(path.join(f.dataDir, 'xiaohongshu-operation-error.json'), 'utf8');
  assert.equal(JSON.parse(raw).path, '[outside-platform]'); assert.equal(reads, before); assert.equal(JSON.parse(raw).page, undefined);
});

test('early failures create diagnostics without launching a browser, and diagnostics never replace the original error', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.browser.publish({ title: 'private title' }), { code: 'PUBLISH_REJECTED' });
  const file = path.join(f.dataDir, 'xiaohongshu-operation-error.json');
  assert.equal(JSON.parse(await readFile(file, 'utf8')).stage, 'validate_input');
  assert.deepEqual(f.calls, []);
  await rm(file);
  const outside = path.join(f.dataDir, 'keep-this-file');
  await writeFile(outside, 'original content'); await symlink(outside, file);
  await assert.rejects(f.browser.publish({}), { code: 'PUBLISH_REJECTED' });
  assert.equal(await readFile(outside, 'utf8'), 'original content'); assert.equal((await lstat(file)).isSymbolicLink(), true);
});

test('successful publishing and lifecycle actions do not collect or write diagnostics', async (t) => {
  const f = await fixture(t, { account, evaluate() { assert.fail('success must not inspect diagnostic DOM'); }, diagnostics() { assert.fail('success must not collect metadata'); },
    publish: async (_page, _input, hooks) => { await hooks.beforeSubmit(); return reconciledReceipt; },
    delete: async (_page, _input, hooks) => { await hooks.beforeSubmit(); return mutationReceipt('delete'); },
  });
  await f.browser.login();
  await f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => {} });
  await f.browser.delete(mutationInput(), { beforeSubmit: async () => {} });
  await assert.rejects(lstat(path.join(f.dataDir, 'xiaohongshu-operation-error.json')), { code: 'ENOENT' });
});

test('visible diagnostic labels exclude editors, hidden ancestors, reflected input, and arbitrary error text', (t) => {
  const previous = Object.fromEntries(['location', 'document', 'getComputedStyle'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  const element = (text, options = {}) => ({ innerText: text, parentElement: options.parent || null, style: options.style || {},
    get value() { assert.fail('form values must never be read'); },
    closest() { return options.excluded ? this : null; }, getClientRects() { return options.invisible ? [] : [{}]; } });
  const hiddenParent = element('', { style: { display: 'none' } });
  const candidates = [element('发布'), element('保存'), element('RAW_POST_BODY'), element('phone 13800000000'), element('原始服务器错误 token=SECRET'),
    element('取消', { excluded: true }), element('删除', { parent: hiddenParent }), element('确认', { invisible: true }), element('发布')];
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://t.bilibili.com' } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelectorAll: () => candidates } });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: node => node.style });
  assert.deepEqual(collectDiagnosticPage({ origin: 'https://t.bilibili.com', labels: ['发布', '保存', '取消', '删除', '确认'] }), { labels: ['发布', '保存'] });
  assert.equal(collectDiagnosticPage({ origin: 'https://outside.example.test', labels: ['发布'] }), undefined);
});

test('throwing diagnostic error getters never replace publish errors or lose reconciliation uncertainty', async (t) => {
  const poisoned = {};
  Object.defineProperties(poisoned, {
    code: { get() { throw new Error('poisoned diagnostic code getter'); } },
    submitted: { get() { throw new Error('poisoned diagnostic submission getter'); } },
  });
  const f = await fixture(t, { account,
    publish: async () => { throw poisoned; },
    reconcilePublication: async () => { throw poisoned; },
    update: async (_page, _input, hooks) => { await hooks.beforeSubmit(); throw poisoned; },
  });
  await f.browser.login();
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => {} }), error => error === poisoned);
  await assert.rejects(f.browser.reconcilePublication(reconcileInput(), reconcileOptions), error => error.code === 'PUBLISH_UNCERTAIN' && error.submitted === true && error.cause === poisoned);
  await assert.rejects(f.browser.update(mutationInput(), { beforeSubmit: async () => {} }), error => error.code === 'PUBLISH_UNCERTAIN' && error.submitted === true && error.cause === poisoned);
  assert.equal((await f.browser.status()).connected, true);
});

test('reconciliation diagnostics retain only fixed stage reasons and bounded structural request metadata', async (t) => {
  const secret = 'PRIVATE_RECONCILIATION_BODY_TOKEN';
  const metadata = { stage: 'feed', reason: 'feed-unavailable', feedPages: 1, feedItems: 0, inWindow: 0, details: 0, matches: 0,
    body: secret, account: secret, url: `https://api.bilibili.com/?token=${secret}`,
    requests: [
      { kind: 'feed', outcome: 'provider-error', status: 200, code: -101, itemCount: 0, hasMoreType: 'missing', itemShape: 'missing', itemsShape: 'missing', rawResponse: secret, headers: { cookie: secret } },
      { kind: 'detail', outcome: 'ok', status: 200, code: 0, itemCount: 1, hasMoreType: 'boolean', hasMore: false, itemShape: 'object', itemsShape: 'array', query: secret },
      { kind: 'image', outcome: 'pixel-mismatch', status: 200, value: secret },
    ],
  };
  const f = await fixture(t, { account, evaluate: async () => ({ labels: [] }), diagnostics: async () => ({ reconcile: metadata }), reconcilePublication: async () => undefined });
  await f.browser.login();
  await assert.rejects(f.browser.reconcilePublication(reconcileInput(), reconcileOptions), { code: 'PUBLISH_UNCERTAIN', submitted: true });
  const raw = await readFile(path.join(f.dataDir, 'xiaohongshu-operation-error.json'), 'utf8');
  assert.deepEqual(JSON.parse(raw).adapter.reconcile, {
    stage: 'feed', reason: 'feed-unavailable', feedPages: 1, feedItems: 0, inWindow: 0, details: 0, matches: 0,
    requests: [
      { kind: 'feed', outcome: 'provider-error', status: 200, code: -101, itemCount: 0, hasMoreType: 'missing', itemShape: 'missing', itemsShape: 'missing' },
      { kind: 'detail', outcome: 'ok', status: 200, code: 0, itemCount: 1, hasMoreType: 'boolean', hasMore: false, itemShape: 'object', itemsShape: 'array' },
      { kind: 'image', outcome: 'pixel-mismatch', status: 200 },
    ],
  });
  assert.equal(raw.includes(secret), false); assert.equal(raw.includes('rawResponse'), false); assert.equal(raw.includes('headers'), false);
});

test('reconciliation diagnostic whitelists reject arbitrary strings, invalid counts, and excessive requests', async (t) => {
  const secret = 'UNTRUSTED_DIAGNOSTIC_VALUE';
  let metadata = { stage: secret, reason: secret, feedPages: -1, feedItems: 1_001, inWindow: 1.5, details: Infinity, matches: '1', requests: [
    { kind: secret, outcome: 'ok' }, { kind: 'feed', outcome: secret },
    { kind: 'feed', outcome: 'shape-error', status: 600, code: Infinity, itemCount: 101, hasMoreType: secret, hasMore: 1, itemShape: secret, itemsShape: secret },
  ] };
  const f = await fixture(t, { account, evaluate: async () => ({ labels: [] }), diagnostics: async () => ({ reconcile: metadata }), reconcilePublication: async () => undefined });
  await f.browser.login();
  await assert.rejects(f.browser.reconcilePublication(reconcileInput(), reconcileOptions), { code: 'PUBLISH_UNCERTAIN' });
  const file = path.join(f.dataDir, 'xiaohongshu-operation-error.json');
  let raw = await readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(raw).adapter.reconcile, { requests: [{ kind: 'feed', outcome: 'shape-error' }] });
  assert.equal(raw.includes(secret), false);
  metadata = { stage: 'images', reason: 'image-unverified', feedPages: 1_000, feedItems: 1_000, requests: Array.from({ length: 30 }, (_, code) => ({ kind: 'image', outcome: 'decode-error', code, itemCount: 100 })) };
  await assert.rejects(f.browser.reconcilePublication(reconcileInput(), reconcileOptions), { code: 'PUBLISH_UNCERTAIN' });
  raw = await readFile(file, 'utf8');
  const stored = JSON.parse(raw).adapter.reconcile;
  assert.equal(stored.feedPages, 1_000); assert.equal(stored.feedItems, 1_000);
  assert.equal(stored.requests.length, 24); assert.equal(stored.requests[0].code, 6); assert.equal(stored.requests.at(-1).code, 29);
  assert.equal(stored.requests.every(request => request.itemCount === 100), true);
});

test('structural diagnostics retain only fixed editor kinds, stage, state and bounded counts', async (t) => {
  const secret = 'PRIVATE_EDITOR_TEXT_HTML_VALUE';
  const f = await fixture(t, { account, evaluate: async () => ({ labels: [] }), publish: async () => { throw Object.assign(new Error('native'), { code: 'UI_CHANGED' }); },
    diagnostics: async () => ({ structure: { stage: 'wait_image_uploader', readyState: 'interactive', html: secret, text: secret,
      counts: { imageTab: 1, titleInput: 0, fileInput: 2, imageFileInput: 1, videoFileInput: 1, previewImage: 0, raw: secret },
      controls: [
        { kind: 'file-input', tag: 'input', visible: false, disabled: false, accept: 'image', knownClasses: ['upload-input', secret, 'upload-input'], value: secret, html: secret },
        { kind: 'body-editor', tag: 'div', visible: true, disabled: false, knownClasses: ['tiptap', 'ql-editor'], text: secret, url: `https://example.test/?token=${secret}` },
      ],
    } }),
  });
  await f.browser.login();
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => {} }));
  const raw = await readFile(path.join(f.dataDir, 'xiaohongshu-operation-error.json'), 'utf8');
  assert.deepEqual(JSON.parse(raw).adapter.structure, {
    stage: 'wait_image_uploader', readyState: 'interactive', counts: { imageTab: 1, titleInput: 0, fileInput: 2, imageFileInput: 1, videoFileInput: 1, previewImage: 0 },
    controls: [
      { kind: 'file-input', tag: 'input', visible: false, disabled: false, accept: 'image', knownClasses: ['upload-input'] },
      { kind: 'body-editor', tag: 'div', visible: true, disabled: false, knownClasses: ['tiptap', 'ql-editor'] },
    ],
  });
  assert.equal(raw.includes(secret), false); assert.equal(raw.includes('token='), false);
});

test('structural diagnostics discard untrusted enums and enforce control and count limits', async (t) => {
  const secret = 'ARBITRARY_STRUCTURE_VALUE';
  let structure = { stage: secret, readyState: secret, counts: { imageTab: -1, titleInput: 1_001, fileInput: 0.5, imageFileInput: Infinity, bodyEditor: '1' }, controls: [
    { kind: secret, tag: 'input' }, { kind: 'title-input', tag: secret },
    { kind: 'title-input', tag: 'input', visible: 'yes', disabled: 1, accept: secret, knownClasses: [secret, 'd-input'] },
  ] };
  const f = await fixture(t, { account, evaluate: async () => ({ labels: [] }), diagnostics: async () => ({ structure }), publish: async () => { throw new Error('native failure'); } });
  await f.browser.login();
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => {} }));
  const file = path.join(f.dataDir, 'xiaohongshu-operation-error.json');
  let raw = await readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(raw).adapter.structure, { counts: {}, controls: [{ kind: 'title-input', tag: 'input', knownClasses: ['d-input'] }] });
  assert.equal(raw.includes(secret), false);
  structure = { stage: 'native_receipt', readyState: 'complete', counts: { previewImage: 1_000 }, controls: Array.from({ length: 25 }, () => ({ kind: 'publish-widget', tag: 'xhs-publish-btn', visible: true, disabled: false, accept: 'none', knownClasses: ['publish-page-publish-btn', 'bg-red'] })) };
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => {} }));
  raw = await readFile(file, 'utf8');
  assert.equal(JSON.parse(raw).adapter.structure.controls.length, 20);
  assert.equal(JSON.parse(raw).adapter.structure.counts.previewImage, 1_000);
});

const diagnosticPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
function debugScreenshotEnvironment(t, flag, nodeEnv = 'development') {
  const previous = { flag: process.env.FATIAO_DEBUG_SCREENSHOTS, nodeEnv: process.env.NODE_ENV };
  if (flag === undefined) delete process.env.FATIAO_DEBUG_SCREENSHOTS; else process.env.FATIAO_DEBUG_SCREENSHOTS = flag;
  process.env.NODE_ENV = nodeEnv;
  t.after(() => {
    if (previous.flag === undefined) delete process.env.FATIAO_DEBUG_SCREENSHOTS; else process.env.FATIAO_DEBUG_SCREENSHOTS = previous.flag;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
  });
}

test('failed operation screenshots require an exact explicit development flag', async (t) => {
  debugScreenshotEnvironment(t, undefined);
  let captures = 0;
  const f = await fixture(t, { account, screenshot: async () => { captures++; return diagnosticPng; }, publish: async () => { throw new Error('failure'); } });
  await f.browser.login();
  for (const flag of [undefined, '0', 'true']) {
    if (flag === undefined) delete process.env.FATIAO_DEBUG_SCREENSHOTS; else process.env.FATIAO_DEBUG_SCREENSHOTS = flag;
    await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => {} }));
  }
  process.env.FATIAO_DEBUG_SCREENSHOTS = '1'; process.env.NODE_ENV = 'production';
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => {} }));
  assert.equal(captures, 0);
  await assert.rejects(lstat(path.join(f.dataDir, 'xiaohongshu-operation-error.png')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(path.join(f.dataDir, 'xiaohongshu-operation-error.json'), 'utf8')).screenshotSaved, false);
});

test('opted-in failure screenshots are atomic private PNGs of the owned failed tab only', async (t) => {
  debugScreenshotEnvironment(t, '1');
  let capturedPage, options;
  const failure = new Error('native update failed');
  const f = await fixture(t, { account, screenshot: async function (value) { capturedPage = this; options = value; return diagnosticPng; },
    update: async (_page, _input, hooks) => { await hooks.beforeSubmit(); throw failure; },
  });
  await f.browser.login();
  const original = f.contexts[0].pages()[0];
  await assert.rejects(f.browser.update(mutationInput(), { beforeSubmit: async () => {} }), error => error.cause === failure && error.submitted === true);
  const file = path.join(f.dataDir, 'xiaohongshu-operation-error.png');
  assert.deepEqual(await readFile(file), diagnosticPng);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.equal((await lstat(file)).isFile(), true);
  assert.deepEqual(options, { type: 'png', fullPage: false, timeout: 3_000 });
  assert.notEqual(capturedPage, original); assert.equal(capturedPage.closed, true); assert.equal(original.closed, false);
  const json = JSON.parse(await readFile(path.join(f.dataDir, 'xiaohongshu-operation-error.json'), 'utf8'));
  assert.equal(json.screenshotSaved, true); assert.equal(json.operation, 'update');
  assert.equal(Object.hasOwn(json, 'screenshotUrl'), false);
  assert.equal((await readdir(f.dataDir)).some(name => name.endsWith('.tmp')), false);
});

test('successful operations never take screenshots even with the development flag enabled', async (t) => {
  debugScreenshotEnvironment(t, '1');
  const f = await fixture(t, { account, screenshot() { assert.fail('success must not capture a screenshot'); },
    publish: async (_page, _input, hooks) => { await hooks.beforeSubmit(); return reconciledReceipt; },
    delete: async (_page, _input, hooks) => { await hooks.beforeSubmit(); return mutationReceipt('delete'); },
  });
  await f.browser.login();
  await f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => {} });
  await f.browser.delete(mutationInput(), { beforeSubmit: async () => {} });
  await assert.rejects(lstat(path.join(f.dataDir, 'xiaohongshu-operation-error.png')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(f.dataDir, 'xiaohongshu-operation-error.json')), { code: 'ENOENT' });
});

test('failed screenshot capture and unsafe destination links cannot change the original failure or another file', async (t) => {
  debugScreenshotEnvironment(t, '1');
  const originalError = new Error('original native failure');
  let screenshotFailure = true;
  const f = await fixture(t, { account, screenshot: async () => { if (screenshotFailure) throw new Error('screenshot failed'); return diagnosticPng; }, publish: async () => { throw originalError; } });
  await f.browser.login();
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => {} }), error => error === originalError);
  const pngFile = path.join(f.dataDir, 'xiaohongshu-operation-error.png'), jsonFile = path.join(f.dataDir, 'xiaohongshu-operation-error.json');
  assert.equal(JSON.parse(await readFile(jsonFile, 'utf8')).screenshotSaved, false);
  await assert.rejects(lstat(pngFile), { code: 'ENOENT' });
  const original = path.join(f.dataDir, 'keep-image');
  await writeFile(original, 'unrelated file'); await symlink(original, pngFile);
  screenshotFailure = false;
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => {} }), error => error === originalError);
  assert.equal(await readFile(original, 'utf8'), 'unrelated file'); assert.equal((await lstat(pngFile)).isSymbolicLink(), true);
  assert.equal(JSON.parse(await readFile(jsonFile, 'utf8')).screenshotSaved, false);
  assert.equal((await readdir(f.dataDir)).some(name => name.endsWith('.tmp')), false);
});

test('debug screenshots never save an outside-platform or navigated-away page', async (t) => {
  debugScreenshotEnvironment(t, '1');
  let captures = 0;
  const f = await fixture(t, { account, screenshot: async function () { captures++; this.address = 'https://outside.example.test/private'; return diagnosticPng; }, publish: async () => { throw new Error('failure'); } });
  await f.browser.login();
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => {} }));
  assert.equal(captures, 1);
  await assert.rejects(lstat(path.join(f.dataDir, 'xiaohongshu-operation-error.png')), { code: 'ENOENT' });
  await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => {} }));
  assert.equal(captures, 1);
  assert.equal(JSON.parse(await readFile(path.join(f.dataDir, 'xiaohongshu-operation-error.json'), 'utf8')).screenshotSaved, false);
});

test('reconciliation diagnostic reasons distinguish invalid feed identity and timestamp shapes without recording their values', async (t) => {
  let reason;
  const f = await fixture(t, { account, evaluate: async () => ({ labels: [] }), diagnostics: async () => ({ reconcile: { stage: 'feed', reason, timestamp: 'PRIVATE_RAW_TIMESTAMP', id: 'PRIVATE_RAW_ID' } }), reconcilePublication: async () => undefined });
  await f.browser.login();
  for (reason of ['feed-id-invalid', 'feed-timestamp-missing', 'feed-timestamp-type', 'feed-timestamp-invalid']) {
    await assert.rejects(f.browser.reconcilePublication(reconcileInput(), reconcileOptions), { code: 'PUBLISH_UNCERTAIN', submitted: true });
    const raw = await readFile(path.join(f.dataDir, 'xiaohongshu-operation-error.json'), 'utf8');
    assert.deepEqual(JSON.parse(raw).adapter.reconcile, { stage: 'feed', reason });
    assert.equal(raw.includes('PRIVATE_RAW'), false);
  }
});

test('picture preview diagnostics keep only bounded loaded and missing counts', async (t) => {
  let editor = { previewLoadedPictureCount: 1, previewMissingPictureCount: 0, previewUrls: ['PRIVATE_PREVIEW_URL'] };
  const f = await fixture(t, { account, evaluate: async () => ({ labels: [] }), diagnostics: async () => ({ editor }), publish: async () => { throw new Error('failed'); } });
  await f.browser.login();
  const read = async () => {
    await assert.rejects(f.browser.publish({ expectedAccountUid: account.uid }, { beforeSubmit: async () => {} }));
    return JSON.parse(await readFile(path.join(f.dataDir, 'xiaohongshu-operation-error.json'), 'utf8'));
  };
  assert.deepEqual((await read()).adapter.editor, { previewLoadedPictureCount: 1, previewMissingPictureCount: 0 });
  editor = { previewLoadedPictureCount: 1_000, previewMissingPictureCount: 1_000 };
  assert.deepEqual((await read()).adapter.editor, editor);
  for (const invalid of [-1, 1_001, 1.5, '1', Infinity]) {
    editor = { previewLoadedPictureCount: invalid, previewMissingPictureCount: invalid };
    assert.equal((await read()).adapter, undefined);
  }
});

test('composer draft inspection and clearing use the same original page and exact reviewed fingerprint', async (t) => {
  let draft = { title: '官网标题', body: '未发正文', imageCount: 1, fingerprint: 'a'.repeat(64), cookie: 'SECRET' };
  let inspectedPage, clearedPage;
  const f = await fixture(t, { account,
    inspectComposerDraft: async page => { inspectedPage = page; return draft; },
    clearComposerDraft: async (page, input) => { clearedPage = page; assert.deepEqual(input, { expectedAccountUid: account.uid, fingerprint: 'a'.repeat(64) }); draft = { title: '', body: '', imageCount: 0, fingerprint: 'b'.repeat(64) }; },
  });
  await f.browser.login(); f.calls.length = 0;
  const original = f.contexts[0].pages()[0];
  const review = await f.browser.inspectComposerDraft({ expectedAccountUid: account.uid });
  assert.deepEqual(review.draft, { actualUI: true, title: '官网标题', body: '未发正文', imageCount: 1, fingerprint: 'a'.repeat(64) });
  assert.equal(review.account.uid, account.uid);
  const result = await f.browser.clearComposerDraft({ expectedAccountUid: account.uid, fingerprint: review.draft.fingerprint });
  assert.equal(result.cleared, true); assert.equal(result.draft.body, ''); assert.equal(result.draft.imageCount, 0);
  assert.equal(inspectedPage, original); assert.equal(clearedPage, original);
  assert.deepEqual(f.calls, []);
});

test('composer draft clearing refuses an obsolete fingerprint before the adapter changes any UI', async (t) => {
  let clears = 0;
  const f = await fixture(t, { account,
    inspectComposerDraft: async () => ({ title: '新草稿', body: '已被修改', imageCount: 2, fingerprint: 'b'.repeat(64) }),
    clearComposerDraft: async () => { clears++; },
  });
  await f.browser.login();
  await assert.rejects(f.browser.clearComposerDraft({ expectedAccountUid: account.uid, fingerprint: 'a'.repeat(64) }), { code: 'DRAFT_CHANGED' });
  assert.equal(clears, 0);
});

test('composer draft operations expose only optional adapter capabilities and require the original account', async (t) => {
  const unsupported = await fixture(t, { account });
  assert.equal(unsupported.browser.inspectComposerDraft, undefined);
  assert.equal(unsupported.browser.clearComposerDraft, undefined);
  let inspected = 0, cleared = 0;
  const f = await fixture(t, { account,
    inspectComposerDraft: async () => { inspected++; return { title: '', body: '', imageCount: 0, fingerprint: 'a'.repeat(64) }; },
    clearComposerDraft: async () => { cleared++; },
  });
  await f.browser.login();
  await assert.rejects(f.browser.inspectComposerDraft({ expectedAccountUid: 'other-account' }), { code: 'ACCOUNT_CHANGED' });
  await assert.rejects(f.browser.clearComposerDraft({ expectedAccountUid: 'other-account', fingerprint: 'a'.repeat(64) }), { code: 'ACCOUNT_CHANGED' });
  assert.equal(inspected, 0); assert.equal(cleared, 0);
});

test('composer draft inspection resumes only saved sessions and never invokes login or publication', async (t) => {
  let inspected = 0;
  const f = await fixture(t, { account,
    inspectComposerDraft: async () => { inspected++; return { title: '', body: '草稿', imageCount: 0, fingerprint: 'a'.repeat(64) }; },
    publish: async () => { assert.fail('must not publish'); },
  });
  await assert.rejects(f.browser.inspectComposerDraft({ expectedAccountUid: account.uid }), { code: 'LOGIN_REQUIRED' });
  assert.equal(inspected, 0); assert.deepEqual(f.calls, []);
  await f.browser.open(); await f.browser.close(); f.calls.length = 0;
  const result = await f.browser.inspectComposerDraft({ expectedAccountUid: account.uid });
  assert.equal(result.draft.actualUI, true);
  assert.equal(inspected, 1);
  assert.equal(f.calls.includes('login'), false); assert.equal(f.calls.includes('front'), false);
  assert.equal(f.calls.find(call => Array.isArray(call) && call[0] === 'launch')[2].headless, true);
});

test('composer draft clearing stops if the account changes during review and never claims a partial clear succeeded', async (t) => {
  let f, accountChanges = true, cleared = 0;
  f = await fixture(t, { account,
    inspectComposerDraft: async () => { if (accountChanges) f.setAccount({ ...account, uid: 'c'.repeat(24) }); return { title: '', body: '未发内容', imageCount: 0, fingerprint: 'a'.repeat(64) }; },
    clearComposerDraft: async () => { cleared++; },
  });
  await f.browser.login();
  await assert.rejects(f.browser.clearComposerDraft({ expectedAccountUid: account.uid, fingerprint: 'a'.repeat(64) }), { code: 'ACCOUNT_CHANGED' });
  assert.equal(cleared, 0);
  accountChanges = false; f.setAccount(account);
  await assert.rejects(f.browser.clearComposerDraft({ expectedAccountUid: account.uid, fingerprint: 'a'.repeat(64) }), { code: 'DRAFT_CLEAR_FAILED' });
  assert.equal(cleared, 1);
});
