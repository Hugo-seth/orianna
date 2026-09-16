import { EventEmitter } from 'node:events';

const connectionMessage = '请先打开 Chrome，在 chrome://inspect/#remote-debugging 开启远程调试，再允许本应用连接当前浏览器。';

function unavailable() {
  return Object.assign(new Error(connectionMessage), { code: 'CHROME_CONNECTION_REQUIRED' });
}

/** A single CDP connection, with a separate set of app-created tabs per platform. */
export function createCurrentChrome({ chromium, timeoutMs = 60_000 } = {}) {
  let connection;
  let connecting;
  let stopped = false;
  let closing;
  const detachments = new Set();
  const timeout = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 60_000;

  function disconnected(record) {
    if (record.disconnected) return;
    record.disconnected = true;
    if (connection === record) connection = undefined;
    for (const lease of record.leases.values()) lease.invalidate();
    record.leases.clear();
  }

  function detach(record) {
    if (record.detaching) return record.detaching;
    record.retiring = true;
    if (connection === record) connection = undefined;
    // For connectOverCDP, Browser.close disconnects this CDP client. Never call
    // the default BrowserContext.close or send CDP Browser.close ourselves.
    record.detaching = Promise.resolve().then(() => record.browser.close()).finally(() => {
      record.browser.off('disconnected', record.onDisconnected);
      disconnected(record);
    });
    detachments.add(record.detaching);
    record.detaching.then(() => detachments.delete(record.detaching), () => detachments.delete(record.detaching));
    return record.detaching;
  }

  async function getConnection() {
    if (stopped) throw unavailable();
    if (connection && !connection.retiring && !connection.disconnected && connection.browser.isConnected()) return connection;
    if (connecting) return connecting;
    const pending = (async () => {
      let browser;
      let record;
      try {
        const engine = chromium || (await import('playwright')).chromium;
        if (stopped) throw unavailable();
        browser = await engine.connectOverCDP('chrome', { noDefaults: true, isLocal: true, timeout });
        record = { browser, context: browser.contexts()[0], leases: new Map(), disconnected: false, retiring: false };
        record.onDisconnected = () => disconnected(record);
        browser.on('disconnected', record.onDisconnected);
        if (stopped || !record.context || !browser.isConnected()) throw unavailable();
        connection = record;
        return record;
      } catch {
        if (record) await detach(record).catch(() => {});
        else if (browser) await browser.close().catch(() => {});
        throw unavailable();
      }
    })();
    connecting = pending;
    try { return await pending; }
    finally { if (connecting === pending) connecting = undefined; }
  }

  function createLease(record, platform) {
    const events = new EventEmitter();
    const owned = new Set();
    const watchers = new Map();
    const pendingPages = new Set();
    const pageClosures = new Map();
    let state = 'open';
    let closePromise;
    let closeEmitted = false;

    function emitClose() {
      if (closeEmitted) return;
      closeEmitted = true;
      events.emit('close');
    }
    function unwatch(page) {
      const handlers = watchers.get(page);
      if (handlers) {
        page.off('popup', handlers.popup);
        page.off('close', handlers.close);
        watchers.delete(page);
      }
      owned.delete(page);
    }
    function invalidate() {
      state = 'disconnected';
      for (const page of owned) unwatch(page);
      emitClose();
    }
    function active() {
      return state === 'open' && !stopped && !record.retiring && !record.disconnected && record.browser.isConnected();
    }
    function closePage(page) {
      if (pageClosures.has(page)) return pageClosures.get(page);
      const pending = Promise.resolve().then(async () => {
        if (!page.isClosed()) await page.close();
      }).finally(() => unwatch(page));
      // A popup can arrive while close() is awaiting another page. Keep every
      // close promise observed immediately, then collect its result below.
      pending.catch(() => {});
      pageClosures.set(page, pending);
      return pending;
    }
    function adopt(page) {
      if (owned.has(page) || page.isClosed()) return;
      owned.add(page);
      const popup = (child) => {
        if (state === 'open' || state === 'closing') adopt(child);
      };
      const close = () => unwatch(page);
      watchers.set(page, { popup, close });
      page.on('popup', popup);
      page.on('close', close);
      if (state === 'closing') void closePage(page);
      else events.emit('page', page);
    }
    function newPage() {
      if (!active()) return Promise.reject(unavailable());
      const pending = Promise.resolve().then(() => record.context.newPage()).then(async (page) => {
        // It is still our new page if a concurrent close occurred while Chrome
        // was creating it. Clean it up without exposing it to the caller.
        if (!active()) {
          if (!record.disconnected && record.browser.isConnected()) await closePage(page);
          throw unavailable();
        }
        adopt(page);
        return page;
      }).catch(() => { throw unavailable(); });
      pendingPages.add(pending);
      pending.then(() => pendingPages.delete(pending), () => pendingPages.delete(pending));
      return pending;
    }
    function waitForEvent(event, options = {}) {
      if (event !== 'page') return Promise.reject(new Error('Unsupported current Chrome event.'));
      if (!active()) return Promise.reject(unavailable());
      const predicate = typeof options === 'function' ? options : options.predicate;
      const waitMs = typeof options === 'function' ? 30_000 : options.timeout ?? 30_000;
      return new Promise((resolve, reject) => {
        let timer;
        let settled = false;
        const cleanup = () => { clearTimeout(timer); events.off('page', onPage); events.off('close', onClose); };
        const finish = (callback, value) => { if (!settled) { settled = true; cleanup(); callback(value); } };
        const onClose = () => finish(reject, unavailable());
        const onPage = (page) => {
          Promise.resolve().then(() => predicate ? predicate(page) : true).then(matches => {
            if (matches) finish(resolve, page);
          }, () => finish(reject, unavailable()));
        };
        events.on('page', onPage);
        events.on('close', onClose);
        if (waitMs > 0) timer = setTimeout(() => finish(reject, Object.assign(new Error('等待 Chrome 新标签页超时。'), { name: 'TimeoutError' })), waitMs);
      });
    }
    function close() {
      if (closePromise) return closePromise;
      if (state === 'disconnected' || state === 'closed') return Promise.resolve();
      state = 'closing';
      closePromise = (async () => {
        await Promise.allSettled([...pendingPages]);
        for (const page of owned) void closePage(page);
        // Closing a page may synchronously expose a final owned popup. Drain
        // only these tracked closures, never context-wide pages or popups.
        let results = [];
        let seen = -1;
        while (seen !== pageClosures.size) {
          seen = pageClosures.size;
          results = await Promise.allSettled([...pageClosures.values()]);
        }
        state = 'closed';
        if (record.leases.get(platform) === lease) record.leases.delete(platform);
        emitClose();
        if (!record.leases.size) await detach(record).catch(() => {});
        if (results.some(result => result.status === 'rejected')) {
          throw Object.assign(new Error('部分应用标签页未能关闭，请在 Chrome 中手动关闭。'), { code: 'CHROME_TAB_CLOSE_FAILED' });
        }
      })();
      return closePromise;
    }
    const facade = {
      mode: 'current-chrome',
      pages: () => [...owned].filter(page => !page.isClosed()),
      newPage,
      on(event, listener) { events.on(event, listener); return facade; },
      off(event, listener) { events.off(event, listener); return facade; },
      waitForEvent,
      close,
      // Drivers must never reach the shared browser through close-error
      // fallbacks. The provider owns connection release, not an individual tab.
      browser: () => null,
    };
    const lease = { facade, active, close, invalidate };
    return lease;
  }

  async function acquire(platform) {
    const record = await getConnection();
    if (stopped || record.retiring || record.disconnected || !record.browser.isConnected()) throw unavailable();
    const existing = record.leases.get(platform);
    if (existing?.active()) return existing.facade;
    if (existing) { await existing.close(); return acquire(platform); }
    const lease = createLease(record, platform);
    record.leases.set(platform, lease);
    return lease.facade;
  }

  function close() {
    if (closing) return closing;
    stopped = true;
    closing = (async () => {
      await connecting?.catch(() => {});
      const record = connection;
      const results = record ? await Promise.allSettled([...record.leases.values()].map(lease => lease.close())) : [];
      if (record) await detach(record).catch(() => {});
      await Promise.allSettled([...detachments]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    })();
    return closing;
  }

  return { acquire, close, mode: 'current-chrome' };
}
