import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createCurrentChrome } from './current-chrome.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeBrowser(options = {}) {
  const browser = new EventEmitter();
  const context = new EventEmitter();
  const allPages = [];
  browser.connected = true;
  browser.closeCalls = 0;
  context.closeCalls = 0;
  context.newPageCalls = 0;
  context.addPage = (name = 'page') => {
    const page = new EventEmitter();
    page.name = name;
    page.closed = false;
    page.closeCalls = 0;
    page.isClosed = () => page.closed;
    page.close = async () => {
      page.closeCalls++;
      await page.beforeClose?.();
      if (page.closeFailure) throw new Error('/private/profile secret browser failure');
      page.closed = true;
      page.emit('close');
    };
    page.popup = (name = 'popup') => {
      const popup = context.addPage(name);
      page.emit('popup', popup);
      return popup;
    };
    allPages.push(page);
    context.emit('page', page);
    return page;
  };
  context.pages = () => allPages.filter(page => !page.closed);
  context.newPage = async () => {
    context.newPageCalls++;
    await options.beforeNewPage?.();
    return context.addPage(`app-${context.newPageCalls}`);
  };
  context.close = async () => { context.closeCalls++; throw new Error('Default context must not be closed'); };
  browser.contexts = () => options.noContext ? [] : [context];
  browser.isConnected = () => browser.connected;
  browser.disconnect = () => { browser.connected = false; browser.emit('disconnected'); };
  browser.close = async () => { browser.closeCalls++; await options.beforeBrowserClose?.(); browser.disconnect(); };
  browser.context = context;
  return browser;
}

function fixture(t, options = {}) {
  const calls = [];
  const browsers = [];
  const chromium = { async connectOverCDP(...args) {
    calls.push(args);
    await options.beforeConnect?.();
    if (options.connectFailure) throw new Error('/Users/private/Chrome secret details');
    const browser = fakeBrowser(options);
    browsers.push(browser);
    return browser;
  } };
  const provider = createCurrentChrome({ chromium, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  t.after(() => provider.close().catch(() => {}));
  return { provider, calls, browsers };
}

test('concurrent platforms and repeated acquire share one connection and one lease per platform', async (t) => {
  const gate = deferred();
  const f = fixture(t, { beforeConnect: () => gate.promise });
  const pending = Promise.all([f.provider.acquire('weibo'), f.provider.acquire('douyin'), f.provider.acquire('weibo')]);
  gate.resolve();
  const [weibo, douyin, again] = await pending;
  assert.equal(f.provider.mode, 'current-chrome');
  assert.equal(weibo, again);
  assert.notEqual(weibo, douyin);
  assert.equal(await f.provider.acquire('weibo'), weibo);
  assert.deepEqual(f.calls, [['chrome', { noDefaults: true, isLocal: true, timeout: 60_000 }]]);
  assert.equal(f.browsers[0].context.newPageCalls, 0);
  assert.equal(weibo.browser(), null);
});

test('leases see only their explicit new pages and recursively owned popups', async (t) => {
  const f = fixture(t);
  const weibo = await f.provider.acquire('weibo');
  const context = f.browsers[0].context;
  const original = context.addPage('user-existing-platform-tab');
  const douyin = await f.provider.acquire('douyin');
  assert.deepEqual(weibo.pages(), []);
  assert.deepEqual(douyin.pages(), []);
  const observed = [];
  weibo.on('page', page => observed.push(page));
  const account = await weibo.newPage();
  const otherAccount = await douyin.newPage();
  const login = account.popup('login');
  const nested = login.popup('nested-login');
  const userNew = context.addPage('user-new');
  const unrelated = original.popup('user-popup');
  assert.deepEqual(weibo.pages(), [account, login, nested]);
  assert.deepEqual(douyin.pages(), [otherAccount]);
  assert.deepEqual(observed, [account, login, nested]);
  await weibo.close();
  for (const page of [account, login, nested]) assert.equal(page.closeCalls, 1);
  for (const page of [otherAccount, original, userNew, unrelated]) assert.equal(page.closeCalls, 0);
  assert.equal(f.browsers[0].closeCalls, 0);
  assert.equal(context.closeCalls, 0);
  assert.deepEqual(weibo.pages(), []);
});

test('waitForEvent ignores context-wide pages and resolves only this lease popup', async (t) => {
  const f = fixture(t);
  const lease = await f.provider.acquire('weibo');
  const account = await lease.newPage();
  const context = f.browsers[0].context;
  let resolved = false;
  const waiting = lease.waitForEvent('page', { timeout: 1_000 }).then(page => { resolved = true; return page; });
  context.addPage('user-tab').popup('unrelated-popup');
  await Promise.resolve();
  assert.equal(resolved, false);
  const popup = account.popup('owned-login');
  assert.equal(await waiting, popup);
  await popup.close();
  assert.deepEqual(lease.pages(), [account]);
});

test('waitForEvent supports a predicate, times out, and cleans listeners when the lease closes', async (t) => {
  const f = fixture(t);
  const lease = await f.provider.acquire('weibo');
  const account = await lease.newPage();
  const waiting = lease.waitForEvent('page', { predicate: page => page.name === 'wanted', timeout: 1_000 });
  account.popup('ignored');
  const wanted = account.popup('wanted');
  assert.equal(await waiting, wanted);
  await assert.rejects(lease.waitForEvent('page', { timeout: 1 }), { name: 'TimeoutError' });
  const stoppedWait = assert.rejects(lease.waitForEvent('page', { timeout: 0 }), { code: 'CHROME_CONNECTION_REQUIRED' });
  await lease.close();
  await stoppedWait;
  assert.equal(account.listenerCount('popup'), 0);
  assert.equal(account.listenerCount('close'), 0);
});

test('last release detaches once, never closes default context or user pages, and permits a fresh connection', async (t) => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.provider.acquire('weibo'), f.provider.acquire('douyin')]);
  const browser = f.browsers[0];
  const user = browser.context.addPage('user');
  await a.newPage();
  await b.newPage();
  let closedA = 0, closedB = 0;
  a.on('close', () => closedA++);
  b.on('close', () => closedB++);
  await Promise.all([a.close(), a.close(), b.close(), b.close()]);
  assert.equal(closedA, 1);
  assert.equal(closedB, 1);
  assert.equal(browser.closeCalls, 1);
  assert.equal(browser.context.closeCalls, 0);
  assert.equal(user.closeCalls, 0);
  assert.notEqual(await f.provider.acquire('weibo'), a);
  assert.equal(f.calls.length, 2);
});

test('connection loss invalidates every lease without closing any page and next acquire reconnects', async (t) => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.provider.acquire('weibo'), f.provider.acquire('douyin')]);
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  const failedWait = assert.rejects(a.waitForEvent('page', { timeout: 0 }), { code: 'CHROME_CONNECTION_REQUIRED' });
  let closes = 0;
  a.on('close', () => closes++);
  b.on('close', () => closes++);
  f.browsers[0].disconnect();
  await failedWait;
  assert.equal(closes, 2);
  assert.deepEqual(a.pages(), []);
  assert.deepEqual(b.pages(), []);
  await assert.rejects(a.newPage(), { code: 'CHROME_CONNECTION_REQUIRED' });
  await Promise.all([a.close(), b.close()]);
  assert.equal(pageA.closeCalls, 0);
  assert.equal(pageB.closeCalls, 0);
  assert.equal(f.browsers[0].closeCalls, 0);
  const replacement = await f.provider.acquire('weibo');
  assert.notEqual(replacement, a);
  assert.equal(f.calls.length, 2);
});

test('connection failure exposes stable setup guidance without private underlying details and can retry', async (t) => {
  const options = { connectFailure: true, timeoutMs: 123 };
  const f = fixture(t, options);
  await assert.rejects(f.provider.acquire('weibo'), error => {
    assert.equal(error.code, 'CHROME_CONNECTION_REQUIRED');
    assert.match(error.message, /chrome:\/\/inspect\/#remote-debugging/);
    assert.doesNotMatch(error.message, /Users|secret|private/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(f.calls[0][1].timeout, 123);
  options.connectFailure = false;
  await f.provider.acquire('weibo');
  assert.equal(f.calls.length, 2);
});

test('a connection without a default context is detached and reported as setup required', async (t) => {
  const f = fixture(t, { noContext: true });
  await assert.rejects(f.provider.acquire('weibo'), { code: 'CHROME_CONNECTION_REQUIRED' });
  assert.equal(f.browsers[0].closeCalls, 1);
});

test('closing during an in-flight newPage closes that page before releasing the connection', async (t) => {
  const gate = deferred();
  const f = fixture(t, { beforeNewPage: () => gate.promise });
  const lease = await f.provider.acquire('weibo');
  const created = assert.rejects(lease.newPage(), { code: 'CHROME_CONNECTION_REQUIRED' });
  const close = lease.close();
  gate.resolve();
  await Promise.all([created, close]);
  assert.equal(f.browsers[0].context.newPageCalls, 1);
  assert.deepEqual(f.browsers[0].context.pages(), []);
  assert.equal(f.browsers[0].closeCalls, 1);
  assert.deepEqual(lease.pages(), []);
});

test('popups created while an owned page is closing are also cleaned, but unrelated pages are untouched', async (t) => {
  const f = fixture(t);
  const lease = await f.provider.acquire('weibo');
  const page = await lease.newPage();
  let finalPopup;
  const user = f.browsers[0].context.addPage('user');
  let userPopup;
  page.beforeClose = () => { finalPopup = page.popup('late-owned'); userPopup = user.popup('late-user'); };
  await lease.close();
  assert.equal(finalPopup.closeCalls, 1);
  assert.equal(userPopup.closeCalls, 0);
  assert.equal(user.closeCalls, 0);
});

test('provider close waits for an in-flight connection then detaches it without creating tabs', async (t) => {
  const gate = deferred();
  const f = fixture(t, { beforeConnect: () => gate.promise });
  const acquiring = assert.rejects(f.provider.acquire('weibo'), { code: 'CHROME_CONNECTION_REQUIRED' });
  const closing = f.provider.close();
  gate.resolve();
  await Promise.all([acquiring, closing]);
  assert.equal(f.browsers[0].closeCalls, 1);
  assert.equal(f.browsers[0].context.newPageCalls, 0);
  await assert.rejects(f.provider.acquire('douyin'), { code: 'CHROME_CONNECTION_REQUIRED' });
  await f.provider.close();
  assert.equal(f.browsers[0].closeCalls, 1);
});

test('provider shutdown closes every owned page while leaving user tabs and browser process intact', async (t) => {
  const f = fixture(t);
  const [a, b] = await Promise.all([f.provider.acquire('weibo'), f.provider.acquire('bilibili')]);
  const ownA = await a.newPage();
  const ownB = await b.newPage();
  const user = f.browsers[0].context.addPage('user');
  await Promise.all([f.provider.close(), f.provider.close()]);
  assert.equal(ownA.closeCalls, 1);
  assert.equal(ownB.closeCalls, 1);
  assert.equal(user.closeCalls, 0);
  assert.equal(f.browsers[0].context.closeCalls, 0);
  assert.equal(f.browsers[0].closeCalls, 1);
});

test('a tab close failure still cleans other owned tabs, detaches safely, and never escalates to context close', async (t) => {
  const f = fixture(t);
  const lease = await f.provider.acquire('weibo');
  const failed = await lease.newPage();
  const other = await lease.newPage();
  const user = f.browsers[0].context.addPage('user');
  failed.closeFailure = true;
  await assert.rejects(lease.close(), error => {
    assert.equal(error.code, 'CHROME_TAB_CLOSE_FAILED');
    assert.doesNotMatch(error.message, /private|secret/);
    return true;
  });
  assert.equal(other.closeCalls, 1);
  assert.equal(user.closeCalls, 0);
  assert.equal(f.browsers[0].context.closeCalls, 0);
  assert.equal(f.browsers[0].closeCalls, 1);
  assert.equal(lease.browser(), null);
});

test('acquire during a lease close waits and returns a fresh lease, never the retiring one', async (t) => {
  const f = fixture(t);
  const lease = await f.provider.acquire('weibo');
  const page = await lease.newPage();
  const gate = deferred();
  page.beforeClose = () => gate.promise;
  const closing = lease.close();
  const acquiring = f.provider.acquire('weibo');
  gate.resolve();
  const [, fresh] = await Promise.all([closing, acquiring]);
  assert.notEqual(fresh, lease);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(fresh.pages(), []);
});

test('provider shutdown also waits for a last-lease detach already in progress', async (t) => {
  const gate = deferred();
  const detaching = deferred();
  const f = fixture(t, { beforeBrowserClose: () => { detaching.resolve(); return gate.promise; } });
  const lease = await f.provider.acquire('weibo');
  const releasing = lease.close();
  await detaching.promise;
  let finished = false;
  const shutdown = f.provider.close().then(() => { finished = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(finished, false);
  gate.resolve();
  await Promise.all([releasing, shutdown]);
  assert.equal(finished, true);
  assert.equal(f.browsers[0].closeCalls, 1);
});
