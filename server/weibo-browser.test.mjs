import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { accountFromConfig, composeWeiboText, confirmedPostOperation, confirmedPublication, createWeiboBrowser, deletionReconciliationEvidence, imageFiles, installNativeDeleteReceiptObserver, isImageUploadResponse, isPostOperationResponse, isPublishResponse, isWeiboLoginPage, observeNativeDeleteResponses, operationTarget, parseProviderJson, pictureState, postFromProvider, readQrLogin, readReconciliationDetail, uploadedPictureIds, waitForPublication } from './weibo-browser.mjs';

const account = { uid: '1234567890', name: '我的微博' };
const config = { isNormal: true, user: { idstr: account.uid, screen_name: account.name, avatar_large: 'https://tvax1.sinaimg.cn/avatar.jpg' } };
const receiptBody = '{"ok":1,"data":{"id":90071992547409931234,"user":{"idstr":"1234567890"}}}';
const makeResponse = (body = receiptBody, url = 'https://weibo.com/ajax/statuses/update', method = 'POST') => ({ url: () => url, request: () => ({ method: () => method }), ok: () => true, text: async () => body });
const originalReceipt = { id: '90071992547409931234', url: 'https://weibo.com/detail/90071992547409931234', account, publishedAt: '2026-09-15T00:00:00.000Z' };
const originalPost = { ok: 1, idstr: originalReceipt.id, mblogid: 'AbCd1234', user: { idstr: account.uid }, pic_ids: ['originalimage1', 'originalimage2'], pic_num: 2 };
const makeOperationResponse = (operation, body, id = originalReceipt.id) => ({ ...makeResponse(body, `https://weibo.com/ajax/statuses/${operation === 'update' ? 'modify' : 'destroy'}`), request: () => ({ method: () => 'POST', postData: () => operation === 'update' ? `mid=${id}&content=updated` : JSON.stringify({ id }) }) });

test('native management targets must be the original receipt and original account', () => {
  const input = { receipt: originalReceipt, expectedAccountUid: account.uid };
  const target = operationTarget(input);
  assert.equal(target.id, originalReceipt.id);
  assert.throws(() => operationTarget({ ...input, expectedAccountUid: '999' }), { code: 'OPERATION_UNSUPPORTED' });
  assert.throws(() => operationTarget({ ...input, receipt: { ...originalReceipt, url: 'https://evil.example/post' } }), { code: 'OPERATION_UNSUPPORTED' });
  assert.throws(() => postFromProvider(JSON.stringify({ ...originalPost, user: { idstr: '999' } }), target), { code: 'OPERATION_UNSUPPORTED' });
  assert.throws(() => postFromProvider(JSON.stringify({ ...originalPost, pic_ids: undefined }), target), { code: 'OPERATION_UNSUPPORTED' });
  assert.equal(postFromProvider(JSON.stringify({ ...originalPost, blog_audio: { id: 1 } }), target).unsupportedMedia, true);
  assert.deepEqual(postFromProvider(JSON.stringify(originalPost), target).picIds, originalPost.pic_ids);
});

test('management receipt watcher pins the operation endpoint, request method and original target', () => {
  assert.equal(isPostOperationResponse(makeOperationResponse('update', '{}'), 'update', originalReceipt.id), true);
  assert.equal(isPostOperationResponse(makeOperationResponse('delete', '{}'), 'delete', originalReceipt.id), true);
  assert.equal(isPostOperationResponse(makeOperationResponse('update', '{}', '999'), 'update', originalReceipt.id), false);
  assert.equal(isPostOperationResponse(makeResponse(), 'update', originalReceipt.id), false);
  assert.equal(isPostOperationResponse(makeOperationResponse('update', '{}'), 'delete', originalReceipt.id), false);
  assert.equal(isPostOperationResponse({ ...makeOperationResponse('delete', '{}'), url: () => 'https://evil.example/ajax/statuses/destroy' }, 'delete', originalReceipt.id), false);
  assert.equal(isPostOperationResponse({ ...makeOperationResponse('delete', '{}'), request: () => ({ method: () => 'GET' }) }, 'delete', originalReceipt.id), false);
});

test('native update/delete success requires the same original ID and update preserves all original images', () => {
  const target = { ...operationTarget({ receipt: originalReceipt, expectedAccountUid: account.uid }), picIds: originalPost.pic_ids };
  const now = () => new Date('2026-09-15T01:02:03Z');
  const edited = confirmedPostOperation(JSON.stringify({ ok: 1, data: originalPost }), 'update', target, account, now);
  assert.equal(edited.id, originalReceipt.id);
  assert.equal(edited.updatedAt, '2026-09-15T01:02:03.000Z');
  const deleted = confirmedPostOperation(JSON.stringify({ ok: 1, idstr: originalReceipt.id }), 'delete', target, account, now);
  assert.equal(deleted.deletedAt, '2026-09-15T01:02:03.000Z');
  assert.throws(() => confirmedPostOperation(JSON.stringify({ ok: 1, data: { ...originalPost, pic_ids: [] } }), 'update', target, account), { code: 'PUBLISH_UNCERTAIN' });
  assert.throws(() => confirmedPostOperation(JSON.stringify({ ok: 1, idstr: '999' }), 'delete', target, account), { code: 'PUBLISH_UNCERTAIN' });
  assert.throws(() => confirmedPostOperation('{"ok":1}', 'delete', target, account), { code: 'PUBLISH_UNCERTAIN' });
  assert.throws(() => confirmedPostOperation('{"ok":0}', 'update', target, account), { code: 'OPERATION_UNSUPPORTED' });
  assert.throws(() => confirmedPostOperation('{"ok":1,"data":{"verify":{}}}', 'update', target, account), { code: 'CAPTCHA_REQUIRED' });
});

test('account requires current confirmed login and safe numeric identity', () => {
  assert.equal(accountFromConfig({ ...config, isNormal: false }), undefined);
  assert.equal(accountFromConfig({ login: true, user: config.user }), undefined);
  assert.equal(accountFromConfig({ isNormal: true, user: { id: 9007199254740992, screen_name: 'unsafe' } }), undefined);
  assert.equal(accountFromConfig({ isNormal: true, user: { ...config.user, idstr: 'script:bad' } }), undefined);
  assert.deepEqual(accountFromConfig(config), { ...account, profileUrl: 'https://weibo.com/u/1234567890', avatarUrl: 'https://tvax1.sinaimg.cn/avatar.jpg' });
  assert.equal(accountFromConfig({ ...config, user: { ...config.user, avatar_large: 'javascript:alert(1)' } }).avatarUrl, undefined);
});

test('own-account text supports title + body without a link or 140-character cap', () => {
  const body = '自己的内容。'.repeat(100);
  assert.equal(composeWeiboText({ title: ' 标题 ', body: ` ${body} ` }), `标题\n\n${body}`);
  assert.equal(composeWeiboText({ body: '只有正文' }), '只有正文');
  assert.throws(() => composeWeiboText({ title: ' ', body: '' }), { code: 'PUBLISH_REJECTED' });
});

test('image files preserve every selected image and reject malformed input', () => {
  const source = 'data:image/png;base64,aGVsbG8=';
  const files = imageFiles([source, source]);
  assert.equal(files.length, 2);
  assert.equal(files[1].name, 'fatiao-2.png');
  assert.equal(files[0].buffer.toString(), 'hello');
  assert.throws(() => imageFiles([source, source, source, source, source]), { code: 'IMAGE_UPLOAD_FAILED' });
  assert.throws(() => imageFiles(['https://example.com/image.png']), { code: 'IMAGE_UPLOAD_FAILED' });
  assert.throws(() => imageFiles(['data:image/png;base64,abc']), { code: 'IMAGE_UPLOAD_FAILED' });
});

test('provider JSON preserves large integer IDs and quoted text exactly', () => {
  const value = parseProviderJson('{"id":90071992547409931234,"count":4,"text":"99999999999999999999 and \\\"id\\\": 90071992547409931235","ratio":1.5}');
  assert.equal(value.id, '90071992547409931234');
  assert.equal(value.count, 4);
  assert.equal(value.ratio, 1.5);
  assert.equal(value.text, '99999999999999999999 and \\"id\\": 90071992547409931235'.replaceAll('\\"', '"'));
  assert.throws(() => parseProviderJson('{"id":notJSON}'));
});

test('success needs positive provider result and a real ID, and challenges never count as success', () => {
  assert.deepEqual(confirmedPublication(receiptBody, account, () => new Date('2026-09-14T00:00:00Z')), {
    id: '90071992547409931234', url: 'https://weibo.com/detail/90071992547409931234', publishedAt: '2026-09-14T00:00:00.000Z', account,
  });
  assert.equal(confirmedPublication('{"ok":1,"data":{"idstr":"90071992547409931235","id":90071992547409931234}}', account).id, '90071992547409931235');
  assert.throws(() => confirmedPublication('{"ok":1,"data":{}}', account), { code: 'PUBLISH_UNCERTAIN' });
  assert.throws(() => confirmedPublication('{"ok":1,"data":{"verify":{"url":"verify"},"idstr":"123"}}', account), { code: 'CAPTCHA_REQUIRED' });
  assert.throws(() => confirmedPublication('{"ok":0,"msg":"blocked"}', account), { code: 'PUBLISH_REJECTED' });
  assert.throws(() => confirmedPublication('{"ok":1,"error":"blocked","data":{"idstr":"123"}}', account), { code: 'PUBLISH_REJECTED' });
  assert.throws(() => confirmedPublication('{"ok":1,"data":{"idstr":"123","user":{"idstr":"999"}}}', account), { code: 'PUBLISH_UNCERTAIN' });
});

test('receipt watcher only accepts the official native POST endpoint', () => {
  assert.equal(isPublishResponse(makeResponse()), true);
  assert.equal(isPublishResponse(makeResponse('', 'https://weibo.com/ajax/statuses/update', 'GET')), false);
  assert.equal(isPublishResponse(makeResponse('', 'https://evil.example/ajax/statuses/update')), false);
  assert.equal(isPublishResponse(makeResponse('', 'https://weibo.com/ajax/statuses/repost')), false);
});

test('receipt deadline includes an incomplete response body and removes listeners', async () => {
  const page = new EventEmitter();
  const watcher = waitForPublication(page, 'https://weibo.com', 10);
  page.emit('response', { ...makeResponse(), text: () => new Promise(() => {}) });
  await assert.rejects(watcher.promise, { code: 'PUBLISH_UNCERTAIN' });
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(page.listenerCount('close'), 0);
});

test('a lost response body becomes typed uncertainty and disposes both listeners', async () => {
  const page = new EventEmitter();
  const watcher = waitForPublication(page, 'https://weibo.com');
  page.emit('response', { ...makeResponse(), text: async () => { throw new Error('Target closed: secret transport details'); } });
  await assert.rejects(watcher.promise, (error) => error.code === 'PUBLISH_UNCERTAIN' && !error.message.includes('secret'));
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(page.listenerCount('close'), 0);
});

test('read-only reconciliation pins the GET response origin, resource and unique target ID', async () => {
  const targetId = originalReceipt.id;
  const canonical = `https://weibo.com/ajax/statuses/show?id=${targetId}&isGetLongText=true`;
  const calls = [];
  let responseUrl = canonical;
  let redirected = false;
  let pageOrigin = 'https://weibo.com';
  const page = { evaluate: (callback, argument) => runInNewContext(`(${callback.toString()})(argument)`, {
    argument, location: { origin: pageOrigin }, URL, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { url: responseUrl, redirected, status: 404, text: async () => '{"ok":0,"message":"微博不存在"}' };
    },
  }) };
  const result = await readReconciliationDetail(page, targetId);
  assert.equal(result.targetId, targetId);
  assert.equal(result.httpStatus, 404);
  assert.equal(calls[0].url, `/ajax/statuses/show?id=${targetId}&isGetLongText=true`);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.cache, 'no-store');
  for (const url of [canonical.replace('weibo.com', 'evil.example'), canonical.replace('/show?', '/destroy?'), canonical.replace(targetId, '999'), `${canonical}&id=${targetId}`]) {
    responseUrl = url;
    assert.equal(await readReconciliationDetail(page, targetId), undefined);
  }
  responseUrl = canonical;
  redirected = true;
  assert.equal(await readReconciliationDetail(page, targetId), undefined);
  pageOrigin = 'https://evil.example';
  const count = calls.length;
  assert.equal(await readReconciliationDetail(page, targetId), undefined);
  assert.equal(calls.length, count);
});

test('detail failures, generic deletion UI and unverified author-deletion messages never fabricate a deletion receipt', () => {
  const target = { id: originalReceipt.id, uid: account.uid };
  for (const body of [
    { ok: 0, error_code: 20101, message: '此微博不存在' },
    { ok: 0, error_code: 27004 },
    { ok: 0, deleted: true, message: '抱歉，此微博已被删除。' },
    { ok: 0, message: '此微博已被作者删除。' },
    { ok: 0, message: '原文没有找到' },
    { ...originalPost, message: '此微博已被作者删除。' },
    { ok: 0, idstr: '999', message: '此微博已被作者删除。' },
    { ok: 0, data: { message: '此微博已被作者删除。' } },
    { ok: 0, verify: {}, message: '此微博已被作者删除。' },
  ]) assert.equal(deletionReconciliationEvidence({ raw: JSON.stringify(body), httpStatus: 200, targetId: target.id }, target).confirmed, false);
  const privateResult = deletionReconciliationEvidence({ raw: '{"ok":0,"error_code":20101,"message":"token=secret credential raw"}', httpStatus: 200, targetId: target.id }, target);
  assert.equal(privateResult.providerMessage, undefined);
  assert.equal(privateResult.errorCode, '20101');
  assert.equal(JSON.stringify(privateResult).includes('secret'), false);
  assert.equal(deletionReconciliationEvidence({ raw: '{}', httpStatus: 200, targetId: '999' }, target).reason, 'unreadable_response');
  assert.equal(deletionReconciliationEvidence({ raw: '<html>此微博已被作者删除。</html>', httpStatus: 200, targetId: target.id }, target).reason, 'unreadable_response');
});

test('the exact official 20101/not-found pair confirms the original is absent, not the deletion actor', () => {
  const target = { id: originalReceipt.id, uid: account.uid };
  const observed = { ok: 0, error_code: 20101, message: '该微博不存在' };
  const classify = (body = observed, httpStatus = 200, targetId = target.id) => deletionReconciliationEvidence({ raw: JSON.stringify(body), httpStatus, targetId }, target);
  assert.deepEqual(classify(), { confirmed: true, reason: 'original_no_longer_exists', httpStatus: 200, providerMessage: '该微博不存在', errorCode: '20101', observedState: 'provider_reports_not_found' });
  for (const [body, status, targetId] of [
    [observed, 404],
    [observed, 403],
    [observed, 500],
    [{ ...observed, error_code: 20112 }],
    [{ ...observed, message: '由于作者隐私设置，你没有权限查看此微博' }],
    [{ ...observed, message: '该微博不存在或没有权限' }],
    [{ ...observed, idstr: '999' }],
    [{ ...observed, data: originalPost }],
    [{ ...observed, ok: 1 }],
    [observed, 200, '999'],
  ]) {
    const evidence = classify(body, status, targetId);
    assert.equal(evidence.confirmed, false);
    assert.equal(evidence.observedState, undefined);
  }
});

function nativeDeleteObserverHarness({ bridge, fetch: fetchImplementation, handoffTimeout = 100, enqueue = queueMicrotask } = {}) {
  const requests = [];
  const messages = [];
  const events = [];
  class NativeXHR {
    constructor() { this.onloadend = null; this.onload = null; this.onreadystatechange = null; this.readyState = 0; this.responseType = ''; }
    open(...args) { this.openArgs = args; this.readyState = 1; return 'native-open'; }
    send(...args) { if (this.sendError) throw this.sendError; requests.push({ xhr: this, args }); return 'native-send'; }
    finish({ status = 200, url = 'https://weibo.com/ajax/statuses/destroy', body = JSON.stringify({ ok: 1, idstr: originalReceipt.id }) } = {}) {
      this.readyState = 4; this.status = status; this.responseURL = url; this.responseText = body;
      const event = { type: 'loadend', marker: 1 };
      (this.onloadend || this.onreadystatechange)?.call(this, event);
      return event;
    }
  }
  const nativeOpen = NativeXHR.prototype.open;
  const nativeSend = NativeXHR.prototype.send;
  const sandbox = {
    location: { origin: 'https://weibo.com', href: originalReceipt.url }, XMLHttpRequest: NativeXHR,
    URL, URLSearchParams, Request, Reflect, WeakMap, Set, Object, Number, JSON, Promise, setTimeout, clearTimeout, queueMicrotask: enqueue,
    fetch: fetchImplementation || (async () => { throw new Error('unexpected fetch'); }),
    bridge: async (value) => { messages.push(value); return bridge ? bridge(value) : true; },
  };
  const nativeFetch = sandbox.fetch;
  sandbox.argument = { origin: 'https://weibo.com', targetId: originalReceipt.id, accountUid: account.uid, bindingName: 'bridge', controlName: 'control', nonce: 'operation-nonce', handoffTimeout };
  runInNewContext(`(${observeNativeDeleteResponses.toString()})(argument)`, sandbox);
  return { sandbox, NativeXHR, requests, messages, events, nativeOpen, nativeSend, nativeFetch, arm: () => sandbox.control.arm(), dispose: () => sandbox.control.dispose() };
}

const flushObserver = () => new Promise((resolve) => setImmediate(resolve));

test('native XHR hands off a minimal exact success before the website can immediately navigate', async () => {
  let acknowledge;
  const harness = nativeDeleteObserverHarness({ bridge: (value) => value.phase === 'receipt' ? new Promise((resolve) => { acknowledge = resolve; }) : true });
  const { sandbox, NativeXHR, requests, messages, events } = harness;
  harness.arm();
  const xhr = new NativeXHR();
  assert.equal(xhr.open('POST', '/ajax/statuses/destroy', true), 'native-open');
  let receivedEvent;
  const original = function (event) { assert.equal(this, xhr); receivedEvent = event; events.push('website-navigates'); sandbox.location.origin = 'null'; };
  xhr.onloadend = original;
  assert.equal(xhr.send(JSON.stringify({ id: originalReceipt.id })), 'native-send');
  const event = xhr.finish({ body: JSON.stringify({ ok: 1, idstr: originalReceipt.id, text: 'private content', cookie: 'private credential' }) });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].receipt.idstr, originalReceipt.id);
  assert.equal(JSON.stringify(messages).includes('private'), false);
  assert.deepEqual(events, []);
  assert.equal(requests.length, 1);
  acknowledge(true);
  await flushObserver();
  assert.deepEqual(events, ['website-navigates']);
  assert.equal(receivedEvent, event);
  assert.equal(xhr.onloadend, original);
  assert.equal(messages[1].phase, 'released');
  assert.equal(requests.length, 1);
  harness.dispose();
  assert.equal(NativeXHR.prototype.open, harness.nativeOpen);
  assert.equal(NativeXHR.prototype.send, harness.nativeSend);
  assert.equal(sandbox.fetch, harness.nativeFetch);
});

test('native observer rejects mismatched requests, duplicate IDs and unsupported XHR callback models without changing their handlers', () => {
  for (const scenario of ['unarmed', 'wrong-target', 'duplicate-form-id', 'duplicate-json-id', 'wrong-method', 'foreign-origin', 'wrong-endpoint', 'sync', 'sync-zero', 'sync-null', 'sync-empty', 'mixed-handlers']) {
    const harness = nativeDeleteObserverHarness();
    if (scenario !== 'unarmed') harness.arm();
    const xhr = new harness.NativeXHR();
    const handler = () => harness.events.push('original');
    xhr.onloadend = handler;
    if (scenario === 'mixed-handlers') xhr.onreadystatechange = () => {};
    const async = scenario === 'sync-zero' ? 0 : scenario === 'sync-null' ? null : scenario === 'sync-empty' ? '' : scenario !== 'sync';
    xhr.open(scenario === 'wrong-method' ? 'GET' : 'POST', scenario === 'foreign-origin' ? 'https://evil.example/ajax/statuses/destroy' : scenario === 'wrong-endpoint' ? '/ajax/statuses/update' : '/ajax/statuses/destroy', async);
    xhr.send(scenario === 'wrong-target' ? '{"id":"999"}' : scenario === 'duplicate-form-id' ? `id=${originalReceipt.id}&id=${originalReceipt.id}` : scenario === 'duplicate-json-id' ? `{"id":"999","id":"${originalReceipt.id}"}` : JSON.stringify({ id: originalReceipt.id }));
    assert.equal(xhr.onloadend, handler, scenario);
    xhr.finish();
    assert.equal(harness.messages.length, 0, scenario);
    assert.deepEqual(harness.events, ['original']);
    assert.equal(harness.requests.length, 1);
    harness.dispose();
  }
});

test('native observer never confirms HTTP errors, other authors, response redirects, missing IDs or conflicting error bodies', () => {
  for (const reply of [
    { status: 500 }, { status: 0 }, { url: 'https://passport.weibo.com/ajax/statuses/destroy' },
    { body: '<html>deleted</html>' }, { body: '{"ok":1}' }, { body: '{"ok":1,"idstr":"999"}' },
    { body: JSON.stringify({ ok: 0, idstr: originalReceipt.id }) },
    { body: JSON.stringify({ ok: 1, idstr: originalReceipt.id, error_code: 20101 }) },
    { body: JSON.stringify({ ok: 1, idstr: originalReceipt.id, data: { verify: {} } }) },
    { body: JSON.stringify({ ok: 1, idstr: originalReceipt.id, user: { idstr: '999' } }) },
  ]) {
    const harness = nativeDeleteObserverHarness();
    harness.arm();
    const xhr = new harness.NativeXHR();
    xhr.onloadend = () => harness.events.push('original');
    xhr.open('POST', '/ajax/statuses/destroy');
    xhr.send(`id=${originalReceipt.id}`);
    xhr.finish(reply);
    assert.equal(harness.messages.length, 0, JSON.stringify(reply));
    assert.deepEqual(harness.events, ['original']);
    assert.equal(harness.requests.length, 1);
    harness.dispose();
  }
});

test('XHR bridge rejection and timeout release the original completion once without another send', async () => {
  for (const outcome of ['reject', 'timeout']) {
    const harness = nativeDeleteObserverHarness({ handoffTimeout: 5, bridge: (value) => value.phase !== 'receipt' ? true : outcome === 'reject' ? Promise.reject(new Error('bridge closed')) : new Promise(() => {}) });
    harness.arm();
    const xhr = new harness.NativeXHR();
    xhr.open('POST', '/ajax/statuses/destroy');
    xhr.onloadend = () => harness.events.push('original');
    xhr.send(JSON.stringify({ id: originalReceipt.id }));
    xhr.finish();
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.deepEqual(harness.events, ['original']);
    assert.equal(harness.requests.length, 1);
    harness.dispose();
  }
});

test('XHR reuse, website handler replacement, send errors and cleanup never attribute a stale response or overwrite later code', () => {
  for (const scenario of ['reuse', 'handler-replaced', 'send-error', 'prototype-replaced']) {
    const harness = nativeDeleteObserverHarness();
    harness.arm();
    const xhr = new harness.NativeXHR();
    const original = () => harness.events.push('original');
    xhr.onloadend = original;
    xhr.open('POST', '/ajax/statuses/destroy');
    if (scenario === 'send-error') xhr.sendError = new Error('native send error');
    if (scenario === 'send-error') {
      assert.throws(() => xhr.send(`id=${originalReceipt.id}`), /native send error/);
      assert.equal(xhr.onloadend, original);
    } else {
      xhr.send(`id=${originalReceipt.id}`);
      if (scenario === 'reuse') xhr.open('POST', '/ajax/statuses/update');
      if (scenario === 'handler-replaced') xhr.onloadend = () => harness.events.push('replacement');
      if (scenario !== 'prototype-replaced') xhr.finish();
    }
    const newerSend = () => 'newer code';
    if (scenario === 'prototype-replaced') harness.NativeXHR.prototype.send = newerSend;
    harness.dispose();
    assert.equal(harness.messages.length, 0);
    if (scenario === 'handler-replaced') assert.deepEqual(harness.events, ['replacement']);
    if (scenario === 'prototype-replaced') assert.equal(harness.NativeXHR.prototype.send, newerSend);
  }
});

test('legacy XHR ready-state handlers pass intermediate events through and defer only the terminal event', async () => {
  const harness = nativeDeleteObserverHarness();
  harness.arm();
  const xhr = new harness.NativeXHR();
  delete xhr.onloadend;
  xhr.open('POST', '/ajax/statuses/destroy');
  xhr.onreadystatechange = function () { harness.events.push(this.readyState); };
  xhr.send(`id=${originalReceipt.id}`);
  xhr.readyState = 3;
  xhr.onreadystatechange({ type: 'readystatechange' });
  assert.deepEqual(harness.events, [3]);
  xhr.finish();
  await flushObserver();
  assert.deepEqual(harness.events, [3, 4]);
  assert.equal(harness.messages.filter((value) => value.phase === 'receipt').length, 1);
  harness.dispose();
});

test('fetch observer reads a clone and returns the exact original response after handoff without resending', async () => {
  const calls = [];
  let acknowledge;
  let cloneReads = 0;
  const response = { status: 200, url: 'https://weibo.com/ajax/statuses/destroy', redirected: false, bodyUsed: false, clone: () => ({ text: async () => { cloneReads++; return JSON.stringify({ ok: 1, idstr: originalReceipt.id }); } }) };
  const harness = nativeDeleteObserverHarness({ bridge: (value) => value.phase === 'receipt' ? new Promise((resolve) => { acknowledge = resolve; }) : true, fetch: async (...args) => { calls.push(args); return response; } });
  harness.arm();
  const init = { method: 'POST', body: JSON.stringify({ id: originalReceipt.id }), headers: { 'X-Example': 'preserved' }, credentials: 'same-origin' };
  let delivered = false;
  const pending = harness.sandbox.fetch('/ajax/statuses/destroy', init).then((value) => { delivered = true; return value; });
  await flushObserver();
  assert.equal(delivered, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], init);
  assert.equal(cloneReads, 1);
  assert.equal(response.bodyUsed, false);
  acknowledge(true);
  assert.equal(await pending, response);
  assert.equal(calls.length, 1);
  harness.dispose();
});

test('a website completion exception still releases the already captured receipt and never resends', async () => {
  const errors = [];
  const harness = nativeDeleteObserverHarness({ enqueue: (callback) => { try { callback(); } catch (error) { errors.push(error); } } });
  harness.arm();
  const xhr = new harness.NativeXHR();
  xhr.open('POST', '/ajax/statuses/destroy');
  xhr.onloadend = () => { throw new Error('website completion failed'); };
  xhr.send(`id=${originalReceipt.id}`);
  xhr.finish();
  await flushObserver();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'website completion failed');
  assert.deepEqual(harness.messages.map((value) => value.phase), ['receipt', 'released']);
  assert.equal(harness.requests.length, 1);
  harness.dispose();
});

test('fetch Request inspection preserves the input body and clone failures preserve the original response', async () => {
  for (const scenario of ['request-body', 'clone-failure']) {
    let calls = 0;
    const response = { status: 200, url: 'https://weibo.com/ajax/statuses/destroy', redirected: false, clone: () => ({ text: async () => {
      if (scenario === 'clone-failure') throw new Error('body unavailable');
      return JSON.stringify({ ok: 1, idstr: originalReceipt.id });
    } }) };
    const harness = nativeDeleteObserverHarness({ fetch: async () => { calls++; return response; } });
    harness.arm();
    const body = JSON.stringify({ id: originalReceipt.id });
    const request = new Request('https://weibo.com/ajax/statuses/destroy', { method: 'POST', body });
    assert.equal(await harness.sandbox.fetch(request), response);
    assert.equal(request.bodyUsed, false);
    assert.equal(await request.text(), body);
    assert.equal(calls, 1);
    assert.equal(harness.messages.filter((value) => value.phase === 'receipt').length, scenario === 'request-body' ? 1 : 0);
    harness.dispose();
  }
});

test('image upload accepts only grounded upload endpoints and confirmed provider PIDs', () => {
  assert.equal(isImageUploadResponse(makeResponse('', 'https://picupload.weibo.com/interface/upload.php')), true);
  assert.equal(isImageUploadResponse(makeResponse('', 'https://image.api.weibo.com/interface/pic_upload.php')), true);
  assert.equal(isImageUploadResponse(makeResponse('', 'https://evil.example/interface/upload.php')), false);
  assert.deepEqual(uploadedPictureIds('{"ret":true,"pic":{"pid":"image12345"}}'), ['image12345']);
  assert.deepEqual(uploadedPictureIds('{"code":"A00006","data":{"pics":{"pic_1":{"pid":"image12345"},"pic_2":{"pid":"image23456"}}}}'), ['image12345', 'image23456']);
  assert.throws(() => uploadedPictureIds('{"ret":false,"pic":{"pid":"image12345"}}'), { code: 'IMAGE_UPLOAD_FAILED' });
  assert.throws(() => uploadedPictureIds('{"code":"A00001","data":{"pics":{}}}'), { code: 'IMAGE_UPLOAD_FAILED' });
});

test('ready picture validation excludes add tiles, upload overlays and loaded error placeholders', async () => {
  const preview = { complete: true, naturalWidth: 100, getBoundingClientRect: () => ({ width: 100 }), src: 'https://wx1.sinaimg.cn/large/image12345.jpg' };
  let loading = false;
  const tile = { querySelector: (selector) => selector === '[title="删除"]' ? {} : selector.includes('img.woo-picture-img') ? preview : loading ? {} : null };
  const element = { querySelectorAll: () => [{ querySelector: () => null }, tile] };
  const root = { evaluate: (callback, ids) => callback(element, ids) };
  assert.deepEqual(await pictureState(root, ['image12345']), { count: 1, ready: 1 });
  loading = true;
  assert.deepEqual(await pictureState(root, ['image12345']), { count: 1, ready: 0 });
  loading = false;
  preview.src = 'data:image/svg+xml,error-placeholder';
  assert.deepEqual(await pictureState(root, ['image12345']), { count: 1, ready: 0 });
  preview.src = 'blob:https://weibo.com/local-only';
  assert.deepEqual(await pictureState(root, ['image12345']), { count: 1, ready: 0 });
  preview.src = 'https://wx1.sinaimg.cn/large/wrongimage.jpg';
  assert.deepEqual(await pictureState(root, ['image12345']), { count: 1, ready: 0 });
});

class CountLocator {
  constructor(count = 0) { this.total = count; }
  async count() { return this.total; }
  async isVisible() { return this.total > 0; }
  first() { return this; }
  async waitFor() {}
}

class FakePage extends EventEmitter {
  constructor() {
    super();
    this.config = structuredClone(config);
    this.currentUrl = 'about:blank';
    this.closed = false;
    this.events = [];
    this.value = '';
    this.media = 0;
    this.editorCount = 1;
    this.frontCount = 0;
    this.gotoCount = 0;
    this.waits = [];
    this.challenge = false;
    this.button = {
      count: async () => 1, isVisible: async () => true, isEnabled: async () => true,
      click: async () => {
        this.events.push('click');
        this.emit('response', makeResponse('', 'https://weibo.com/ajax/statuses/repost'));
        this.emit('response', makeResponse(this.response || receiptBody));
      },
    };
    this.root = {
      count: async () => 1,
      getByRole: () => this.button,
      evaluate: async (_callback, pids = []) => ({ count: this.media, ready: pids.length === this.media ? this.media : 0 }),
      locator: (selector) => new CountLocator(selector === 'textarea:visible' ? 1 : 0),
    };
    this.textarea = {
      count: async () => this.editorCount, first: () => ({ waitFor: async () => {} }),
      locator: () => this.root,
      fill: async (text) => { this.value = text; this.events.push('fill'); },
      inputValue: async () => this.value,
    };
  }
  url() { return this.currentUrl; }
  isClosed() { return this.closed; }
  async goto(url, options) { this.currentUrl = url; this.gotoCount++; this.lastGotoOptions = options; if (this.onGoto) await this.onGoto(); }
  async waitForFunction(_callback, _arg, options) { this.waits.push(options); if (this.onWait) await this.onWait(); }
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  async bringToFront() { this.frontCount++; }
  async close() { this.closed = true; this.emit('close'); }
  async exposeBinding(name, callback) { this.bindings ??= new Map(); this.bindings.set(name, callback); }
  async addInitScript(callback, argument) { this.initScript = { callback, argument }; }
  mainFrame() { return this; }
  async evaluate(callback, fresh) {
    if (typeof fresh === 'string' && fresh.startsWith('__fatiaoDeleteObserver_')) {
      if (callback.toString().includes('arm()')) { this.events.push('observer-armed'); return this.observerArmAllowed !== false; }
      if (callback.toString().includes('dispose()')) { this.events.push('observer-disposed'); return; }
    }
    if (callback.toString().includes('/ajax/statuses/show')) {
      this.events.push('reconciliation-read');
      this.reconciliationArgument = fresh;
      if (this.onReconciliationRead) await this.onReconciliationRead();
      return this.reconciliationResult;
    }
    if (callback.toString().includes('$CONFIG')) {
      this.events.push(fresh ? 'fresh-identity' : 'identity');
      if (fresh && this.onFresh) await this.onFresh();
      return fresh && Object.hasOwn(this, 'freshConfig') ? this.freshConfig : this.config;
    }
    return undefined;
  }
  getByRole() { return new CountLocator(); }
  locator(selector) { return selector.startsWith('textarea') ? this.textarea : new CountLocator(selector.includes('captcha') && this.challenge ? 1 : 0); }
}

class FakeContext extends EventEmitter {
  constructor() { super(); this.page = new FakePage(); this.closed = false; this.popups = []; }
  pages() { return this.closed ? [] : [this.page, ...this.popups]; }
  async newPage() { const created = new FakePage(); this.addPopup(created); return created; }
  async close() { for (const page of this.pages()) { page.closed = true; page.emit('close'); } this.closed = true; this.emit('close'); }
  async waitForEvent(event) { return new Promise((resolve) => this.once(event, resolve)); }
  addPopup(popup) { this.popups.push(popup); this.emit('page', popup); }
  browser() { return { isConnected: () => !this.closed, close: () => this.close() }; }
}

async function fixture(t, { onLaunch, currentChrome: useCurrentChrome = false, acquireError } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'fatiao-weibo-driver-'));
  const context = new FakeContext();
  const contexts = [context];
  const launches = [];
  const chromium = { launchPersistentContext: async (...args) => { launches.push(args); if (launches.length > 1) contexts.push(new FakeContext()); if (onLaunch) await onLaunch(contexts.at(-1), launches.length); return contexts.at(-1); } };
  const acquisitions = [];
  const currentChrome = useCurrentChrome ? { async acquire(platform) {
    acquisitions.push(platform);
    if (acquireError) throw acquireError;
    if (acquisitions.length > 1) contexts.push(new FakeContext());
    return contexts.at(-1);
  } } : undefined;
  const driver = createWeiboBrowser({ dataDir, chromium, currentChrome });
  t.after(async () => { await driver.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, context, contexts, page: context.page, launches, acquisitions, driver };
}

test('current Chrome login, open and resume reuse one visible Weibo context without launching a browser', async t => {
  const f = await fixture(t, { currentChrome: true });
  assert.equal(f.driver.browserMode, 'current-chrome');
  for (const status of [await f.driver.login({ mode: 'qr' }), await f.driver.open(), await f.driver.resume()]) {
    assert.equal(status.connected, true);
    assert.equal(status.headless, false);
  }
  assert.deepEqual(f.acquisitions, ['weibo']);
  assert.equal(f.contexts.length, 1);
  assert.equal(f.context.closed, false);
  assert.equal(f.page.gotoCount, 1);
  assert.deepEqual(f.launches, []);
});

test('current Chrome remembers its Weibo connection separately and disconnect preserves the legacy profile', async t => {
  const f = await fixture(t, { currentChrome: true });
  const legacyProfile = path.join(f.dataDir, 'weibo-profile');
  const connectionDir = path.join(f.dataDir, 'weibo-chrome-connection');
  await mkdir(legacyProfile);
  await writeFile(path.join(legacyProfile, 'preserved-cookie-data'), 'keep');
  assert.equal((await f.driver.status()).sessionSaved, false);
  assert.equal((await f.driver.resume()).sessionSaved, false);
  assert.deepEqual(f.acquisitions, []);
  await f.driver.login();
  assert.ok((await stat(path.join(connectionDir, '.fatiao-session-saved'))).isFile());
  assert.equal((await f.driver.close()).sessionSaved, true);
  const resumed = await f.driver.resume();
  assert.equal(resumed.connected, true);
  assert.equal(resumed.headless, false);
  assert.deepEqual(f.acquisitions, ['weibo', 'weibo']);
  assert.equal((await f.driver.disconnect()).sessionSaved, false);
  await assert.rejects(stat(connectionDir), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(legacyProfile, 'preserved-cookie-data'), 'utf8'), 'keep');
  assert.deepEqual(f.launches, []);
});

test('current Chrome connection errors reach the Weibo caller without launching a fallback browser', async t => {
  const error = Object.assign(new Error('Chrome connection authorization required'), { code: 'CHROME_CONNECTION_REQUIRED' });
  const f = await fixture(t, { currentChrome: true, acquireError: error });
  await assert.rejects(f.driver.open(), failure => failure === error);
  assert.deepEqual(f.acquisitions, ['weibo']);
  assert.deepEqual(f.launches, []);
  assert.equal((await f.driver.status()).browserOpen, false);
});

test('Weibo binding survives manual tab close and service restart while remaining unverified', async t => {
  const f = await fixture(t, { currentChrome: true });
  const verified = await f.driver.open();
  const identity = verified.account;
  assert.equal(verified.accountVerification, 'verified');
  f.page.closed = true;
  const saved = await f.driver.status();
  assert.equal(saved.connected, false);
  assert.equal(saved.browserOpen, false);
  assert.equal(saved.publishReady, false);
  assert.equal(saved.sessionSaved, true);
  assert.equal(saved.accountVerification, 'required');
  assert.deepEqual(saved.account, identity);
  assert.equal(f.acquisitions.length, 1);
  const metadata = path.join(f.dataDir, 'weibo-chrome-connection', 'account.json');
  assert.deepEqual(JSON.parse(await readFile(metadata, 'utf8')), { version: 1, account: identity });
  assert.equal((await stat(metadata)).mode & 0o777, 0o600);
  const restored = createWeiboBrowser({ dataDir: f.dataDir,
    currentChrome: { acquire() { assert.fail('GET status must not connect Chrome'); } } });
  const restarted = await restored.status();
  assert.deepEqual(restarted.account, identity);
  assert.equal(restarted.accountVerification, 'required');
  assert.equal(restarted.publishReady, false);
  const closed = await restored.close();
  assert.deepEqual(closed.account, identity);
  assert.equal(closed.accountVerification, 'required');
  const disconnected = await restored.disconnect();
  assert.equal(disconnected.account, undefined);
  assert.equal(disconnected.sessionSaved, false);
  assert.equal((await restored.status()).account, undefined);
});

test('Weibo cached identity cannot authorize a post after the browser login expires', async t => {
  const f = await fixture(t, { currentChrome: true });
  const verified = await f.driver.open();
  f.page.config = { isNormal: false };
  const status = await f.driver.status();
  assert.equal(status.connected, false);
  assert.deepEqual(status.account, verified.account);
  assert.equal(status.accountVerification, 'required');
  assert.equal(status.publishReady, false);
  await assert.rejects(f.driver.publish({ expectedAccountUid: account.uid, body: 'test', images: [] }, {
    beforeSubmit() { assert.fail('cached account must not reach the checkpoint'); },
  }), { code: 'LOGIN_REQUIRED' });
  assert.equal(f.page.events.includes('fill'), false);
  assert.equal(f.page.events.includes('click'), false);
});

test('explicit Weibo refresh verifies a retained binding while passive status never opens tabs', async t => {
  const f = await fixture(t, { currentChrome: true });
  await f.driver.open();
  await f.driver.close();
  assert.equal((await f.driver.status()).accountVerification, 'required');
  assert.equal(f.acquisitions.length, 1);
  const refreshed = await f.driver.refresh();
  assert.equal(refreshed.accountVerification, 'verified');
  assert.equal(refreshed.connected, true);
  assert.equal(refreshed.publishReady, true);
  assert.equal(f.acquisitions.length, 2);
});

test('shared Chrome security verification retains Weibo display identity without publication readiness', async t => {
  const f = await fixture(t, { currentChrome: true });
  const verified = await f.driver.open();
  f.page.challenge = true;
  const status = await f.driver.resume();
  assert.equal(status.connected, false);
  assert.equal(status.publishReady, false);
  assert.equal(status.accountVerification, 'required');
  assert.deepEqual(status.account, verified.account);
  assert.equal(status.sessionSaved, true);
});

test('a failed current Chrome tab cleanup never falls back to closing the user browser', async t => {
  const f = await fixture(t, { currentChrome: true });
  await f.driver.open();
  const closePages = f.context.close.bind(f.context);
  const error = new Error('Owned tab could not close');
  let browserCloses = 0;
  f.context.close = async () => { throw error; };
  f.context.browser = () => ({ isConnected: () => true, close: async () => { browserCloses++; } });
  try {
    await assert.rejects(f.driver.close(), failure => failure === error);
    assert.equal(browserCloses, 0);
  } finally {
    f.context.close = closePages;
  }
});

class FakeOperationPage extends FakePage {
  constructor(operation) {
    super();
    this.operation = operation;
    this.postRecord = structuredClone(originalPost);
    this.media = originalPost.pic_ids.length;
    this.menuVisible = false;
    this.menuAllowed = true;
    this.nativeAllowed = true;
    this.editorVisible = false;
    this.confirmVisible = false;
    this.finalButton = {
      count: async () => 1, isVisible: async () => true, isEnabled: async () => true,
      click: async () => {
        this.events.push(`native-${operation}`);
        const body = this.operationResponse || JSON.stringify(operation === 'update' ? { ok: 1, data: this.postRecord } : { ok: 1, idstr: this.postRecord.idstr });
        this.emit('response', makeOperationResponse(operation, body));
        if (operation === 'delete' && this.initScript) {
          const { bindingName, nonce } = this.initScript.argument;
          const bridge = this.bindings.get(bindingName);
          const source = { page: this, frame: this };
          const received = JSON.parse(body);
          if (await bridge(source, { nonce, phase: 'receipt', method: 'POST', url: 'https://weibo.com/ajax/statuses/destroy', targetId: originalReceipt.id, httpStatus: 200, receipt: received })) await bridge(source, { nonce, phase: 'released' });
        }
      },
    };
  }
  async evaluate(callback, value) {
    if (callback.toString().includes('/ajax/statuses/show')) { this.events.push('target-read'); if (this.onTargetRead) await this.onTargetRead(); return JSON.stringify(this.postRecord); }
    return super.evaluate(callback, value);
  }
  getByText(text) { return { text }; }
  locator(selector) {
    const page = this;
    const locator = (count, extra = {}) => ({ count: async () => typeof count === 'function' ? count() : count, first() { return this; }, waitFor: async () => {}, filter() { return this; }, ...extra });
    if (selector.startsWith('article')) return locator(1, {
      locator: () => locator(1, { click: async () => { page.events.push('more'); page.menuVisible = true; } }),
    });
    if (selector.startsWith('.woo-pop-item')) return locator(() => page.menuVisible && page.menuAllowed ? 1 : 0, {
      isEnabled: async () => true,
      filter({ has }) { assert.equal(has.text, page.operation === 'update' ? '编辑微博' : '删除'); return this; },
      click: async () => { page.events.push('menu'); if (page.onMenu) await page.onMenu(); if (page.nativeAllowed) { page.editorVisible = page.operation === 'update'; page.confirmVisible = page.operation === 'delete'; } },
    });
    if (selector === '.wbpro-layer:visible') return locator(() => page.editorVisible ? 1 : 0, {
      locator: (value) => value.startsWith('textarea') ? page.textarea : new CountLocator(),
      getByRole: () => page.finalButton,
      evaluate: page.root.evaluate,
    });
    if (selector === '.woo-dialog-main:visible') return locator(() => page.membershipRequired ? 1 : 0);
    if (selector.startsWith('.woo-dialog-main')) return locator(() => page.confirmVisible ? 1 : 0, { getByRole: () => page.finalButton });
    if (selector.startsWith('.wbpro-layer-tit-text') || selector.startsWith('.woo-dialog-title')) return locator(1);
    return super.locator(selector);
  }
}

async function operationFixture(t, operation) {
  const fixtureValue = await fixture(t);
  const operationPage = new FakeOperationPage(operation);
  fixtureValue.context.newPage = async () => { fixtureValue.context.addPopup(operationPage); return operationPage; };
  await fixtureValue.driver.login();
  return { ...fixtureValue, operationPage, input: { receipt: originalReceipt, expectedAccountUid: account.uid, title: '修改后的标题', body: '修改后的正文' } };
}

test('Node receipt bridge accepts only the armed operation nonce, owned main frame and minimal original success', async () => {
  const page = new FakePage();
  page.currentUrl = originalReceipt.url;
  const target = operationTarget({ receipt: originalReceipt, expectedAccountUid: account.uid });
  const observer = await installNativeDeleteReceiptObserver(page, target, account);
  const { bindingName, nonce } = page.initScript.argument;
  const bridge = page.bindings.get(bindingName);
  const source = { page, frame: page };
  const envelope = { nonce, phase: 'receipt', method: 'POST', url: 'https://weibo.com/ajax/statuses/destroy', targetId: originalReceipt.id, httpStatus: 200, receipt: { ok: 1, idstr: originalReceipt.id } };
  assert.equal(await bridge(source, envelope), false);
  assert.equal(await observer.arm(), true);
  for (const value of [
    { ...envelope, nonce: 'stale-operation' }, { ...envelope, method: 'GET' }, { ...envelope, targetId: '999' },
    { ...envelope, url: 'https://evil.example/ajax/statuses/destroy' }, { ...envelope, httpStatus: 500 },
    { ...envelope, receipt: { ok: 1, idstr: '999' } },
    { ...envelope, receipt: { ok: 1, idstr: originalReceipt.id, user: { idstr: '999' } } },
    { ...envelope, receipt: { ok: 1, idstr: originalReceipt.id, cookie: 'must-not-store' } },
    { ...envelope, receipt: { ok: 1, idstr: originalReceipt.id, error_code: 20101 } },
  ]) assert.equal(await bridge(source, value), false);
  assert.equal(await bridge({ page: new FakePage(), frame: page }, envelope), false);
  assert.equal(await bridge({ page, frame: new FakePage() }, envelope), false);
  assert.equal(observer.captured(), undefined);
  let released = false;
  observer.promise.then(() => { released = true; });
  assert.equal(await bridge(source, envelope), true);
  assert.equal(observer.captured(), JSON.stringify(envelope.receipt));
  assert.equal(released, false);
  assert.equal(await bridge(source, envelope), false);
  page.currentUrl = 'about:blank';
  assert.equal(await bridge(source, { nonce, phase: 'released' }), true);
  assert.equal(await observer.promise, JSON.stringify(envelope.receipt));
  await observer.dispose();
  assert.equal(await bridge(source, envelope), false);
});

test('waiting for website release is bounded and removes only its own navigation and close listeners', async () => {
  for (const scenario of ['timeout', 'navigation', 'closed']) {
    const page = new FakePage();
    page.currentUrl = originalReceipt.url;
    const existingCloseListener = () => {};
    page.on('close', existingCloseListener);
    const observer = await installNativeDeleteReceiptObserver(page, operationTarget({ receipt: originalReceipt, expectedAccountUid: account.uid }), account);
    const waiting = observer.waitForRelease(5);
    if (scenario === 'navigation') page.emit('framenavigated', page);
    if (scenario === 'closed') await page.close();
    await waiting;
    assert.equal(page.listenerCount('framenavigated'), 0);
    assert.equal(page.listenerCount('close'), 1);
    assert.equal(page.listeners('close')[0], existingCloseListener);
    await observer.dispose();
  }
});

test('native text update preserves the original ID/images, journals before one click and keeps the prior draft', async (t) => {
  const { driver, page, operationPage, input, dataDir } = await operationFixture(t, 'update');
  page.value = '用户已有草稿';
  const result = await driver.update(input, { beforeSubmit: async () => operationPage.events.push('checkpoint') });
  assert.equal(result.id, originalReceipt.id);
  assert.equal(result.url, originalReceipt.url);
  assert.ok(result.updatedAt);
  assert.equal(operationPage.value, '修改后的标题\n\n修改后的正文');
  assert.equal(operationPage.media, 2);
  assert.ok(operationPage.events.indexOf('checkpoint') < operationPage.events.indexOf('native-update'));
  assert.equal(operationPage.events.filter((event) => event === 'native-update').length, 1);
  assert.equal(operationPage.events.includes('click'), false);
  assert.equal(operationPage.closed, true);
  assert.equal(page.closed, false);
  assert.equal(page.value, '用户已有草稿');
  assert.equal((await driver.status()).connected, true);
  await assert.rejects(stat(path.join(dataDir, 'weibo-operation-error.json')), { code: 'ENOENT' });
});

test('native delete uses its explicit confirmation and exact original receipt', async (t) => {
  const { driver, operationPage, input } = await operationFixture(t, 'delete');
  const result = await driver.delete(input, { beforeSubmit: async () => operationPage.events.push('checkpoint') });
  assert.equal(result.id, originalReceipt.id);
  assert.ok(result.deletedAt);
  assert.equal(operationPage.events.includes('fill'), false);
  assert.ok(operationPage.events.indexOf('checkpoint') < operationPage.events.indexOf('native-delete'));
  assert.equal(operationPage.events.filter((event) => event === 'native-delete').length, 1);
});

test('native deletion retains its proven receipt when success immediately navigates and destroys response or click completion', async (t) => {
  for (const scenario of ['response-body-lost', 'release-message-lost', 'click-completion-lost']) {
    await t.test(scenario, async (t) => {
      const { driver, operationPage, page, input } = await operationFixture(t, 'delete');
      page.value = 'existing native draft';
      operationPage.finalButton.click = async () => {
        operationPage.events.push('native-delete');
        assert.ok(operationPage.events.includes('observer-armed'));
        const { bindingName, nonce } = operationPage.initScript.argument;
        const bridge = operationPage.bindings.get(bindingName);
        const source = { page: operationPage, frame: operationPage };
        assert.equal(await bridge(source, { nonce, phase: 'receipt', method: 'POST', url: 'https://weibo.com/ajax/statuses/destroy', targetId: originalReceipt.id, httpStatus: 200, receipt: { ok: 1, idstr: originalReceipt.id } }), true);
        operationPage.currentUrl = 'about:blank';
        operationPage.emit('response', { ...makeOperationResponse('delete', ''), text: async () => { throw new Error('No resource with given identifier'); } });
        if (scenario !== 'release-message-lost') await bridge(source, { nonce, phase: 'released' });
        if (scenario === 'click-completion-lost') throw new Error('Execution context destroyed by native navigation');
      };
      const receipt = await driver.delete(input, { beforeSubmit: async () => operationPage.events.push('checkpoint') });
      assert.equal(receipt.id, originalReceipt.id);
      assert.ok(receipt.deletedAt);
      assert.equal(operationPage.events.filter((event) => event === 'native-delete').length, 1);
      assert.ok(operationPage.events.indexOf('checkpoint') < operationPage.events.indexOf('observer-armed'));
      assert.equal(operationPage.closed, true);
      assert.equal(page.closed, false);
      assert.equal(page.value, 'existing native draft');
      assert.equal(operationPage.listenerCount('response'), 0);
    });
  }
});

test('a captured receipt or early network response cannot close the live tab before the website completion is released', async (t) => {
  for (const scenario of ['ack-before-handler', 'network-before-observer']) {
    await t.test(scenario, async (t) => {
      const { driver, operationPage, input } = await operationFixture(t, 'delete');
      let nativeReached;
      let releaseWebsite;
      const started = new Promise((resolve) => { nativeReached = resolve; });
      operationPage.finalButton.click = async () => {
        operationPage.events.push('native-delete');
        const { bindingName, nonce } = operationPage.initScript.argument;
        const bridge = operationPage.bindings.get(bindingName);
        const source = { page: operationPage, frame: operationPage };
        const capture = () => bridge(source, { nonce, phase: 'receipt', method: 'POST', url: 'https://weibo.com/ajax/statuses/destroy', targetId: originalReceipt.id, httpStatus: 200, receipt: { ok: 1, idstr: originalReceipt.id } });
        if (scenario === 'ack-before-handler') assert.equal(await capture(), true);
        releaseWebsite = async () => {
          if (scenario === 'network-before-observer') assert.equal(await capture(), true);
          operationPage.events.push('website-handler');
          await bridge(source, { nonce, phase: 'released' });
        };
        operationPage.emit('response', makeOperationResponse('delete', JSON.stringify({ ok: 1, idstr: originalReceipt.id })));
        nativeReached();
      };
      let completed = false;
      const pending = driver.delete(input, { beforeSubmit: async () => {} }).then((value) => { completed = true; return value; });
      await started;
      await flushObserver();
      assert.equal(completed, false);
      assert.equal(operationPage.closed, false);
      assert.equal(operationPage.events.includes('observer-disposed'), false);
      await releaseWebsite();
      assert.equal((await pending).id, originalReceipt.id);
      assert.ok(operationPage.events.indexOf('website-handler') < operationPage.events.indexOf('observer-disposed'));
      assert.equal(operationPage.closed, true);
      assert.equal(operationPage.listenerCount('framenavigated'), 0);
      assert.equal(operationPage.listenerCount('response'), 0);
    });
  }
});

test('a missing delete observer stops before the native click and an invalid bridge receipt cannot recover failure', async (t) => {
  for (const scenario of ['missing-observer', 'invalid-receipt']) {
    await t.test(scenario, async (t) => {
      const { driver, operationPage, input } = await operationFixture(t, 'delete');
      if (scenario === 'missing-observer') operationPage.observerArmAllowed = false;
      else operationPage.finalButton.click = async () => {
        operationPage.events.push('native-delete');
        const { bindingName, nonce } = operationPage.initScript.argument;
        const bridge = operationPage.bindings.get(bindingName);
        assert.equal(await bridge({ page: operationPage, frame: operationPage }, { nonce, phase: 'receipt', method: 'POST', url: 'https://weibo.com/ajax/statuses/destroy', targetId: originalReceipt.id, httpStatus: 200, receipt: { ok: 1, idstr: '999' } }), false);
        operationPage.emit('response', { ...makeOperationResponse('delete', ''), text: async () => { throw new Error('lost'); } });
      };
      await assert.rejects(driver.delete(input, { beforeSubmit: async () => {} }), { code: 'PUBLISH_UNCERTAIN' });
      assert.equal(operationPage.events.filter((event) => event === 'native-delete').length, scenario === 'missing-observer' ? 0 : 1);
      assert.equal(operationPage.closed, true);
    });
  }
});

test('unsupported native edit/delete flows stop without a checkpoint or replacement publication', async (t) => {
  for (const operation of ['update', 'delete']) {
    for (const scenario of ['missing-menu', 'native-permission', 'foreign-author']) {
      await t.test(`${operation}/${scenario}`, async (t) => {
        const { driver, operationPage, input } = await operationFixture(t, operation);
        if (scenario === 'missing-menu') operationPage.menuAllowed = false;
        if (scenario === 'native-permission') operationPage.nativeAllowed = false;
        if (scenario === 'foreign-author') operationPage.postRecord.user.idstr = '9999999';
        await assert.rejects(driver[operation](input, { beforeSubmit: async () => assert.fail('must not checkpoint') }), { code: 'OPERATION_UNSUPPORTED' });
        assert.equal(operationPage.events.some((event) => event.startsWith('native-') || event === 'click'), false);
        assert.equal(operationPage.closed, true);
      });
    }
  }
});

test('text editing stops if original media changes, account changes or durable checkpoint fails', async (t) => {
  for (const scenario of ['images', 'account', 'checkpoint']) {
    await t.test(scenario, async (t) => {
      const { driver, operationPage, input } = await operationFixture(t, 'update');
      await assert.rejects(driver.update(input, { beforeSubmit: async () => {
        if (scenario === 'images') operationPage.media = 0;
        if (scenario === 'account') operationPage.freshConfig = { ...config, user: { ...config.user, idstr: '9999999' } };
        if (scenario === 'checkpoint') throw new Error('disk full');
      } }), scenario === 'checkpoint' ? /disk full/ : { code: 'PUBLISH_UNCERTAIN' });
      assert.equal(operationPage.events.includes('native-update'), false);
      assert.equal(operationPage.closed, true);
    });
  }
});

test('native operation response errors or a different target never become successful receipts', async (t) => {
  for (const operation of ['update', 'delete']) {
    await t.test(operation, async (t) => {
      const { driver, operationPage, input } = await operationFixture(t, operation);
      operationPage.operationResponse = JSON.stringify(operation === 'update' ? { ok: 1, data: { ...originalPost, idstr: '9999999' } } : { ok: 1, idstr: '9999999' });
      await assert.rejects(driver[operation](input, { beforeSubmit: async () => {} }), { code: 'PUBLISH_UNCERTAIN' });
      assert.equal(operationPage.events.filter((event) => event === `native-${operation}`).length, 1);
    });
  }
});

test('the native membership prompt returns a specific permission limit without submitting an edit', async (t) => {
  const { driver, operationPage, input } = await operationFixture(t, 'update');
  operationPage.nativeAllowed = false; operationPage.membershipRequired = true;
  await assert.rejects(driver.update(input, { beforeSubmit: async () => assert.fail('must not checkpoint') }), { code: 'EDIT_MEMBERSHIP_REQUIRED' });
  assert.equal(operationPage.events.includes('native-update'), false);
  assert.equal(operationPage.closed, true);
});

test('a navigation-stalled observer cleanup cannot keep a confirmed deletion pending forever', async (t) => {
  const { driver, operationPage, input } = await operationFixture(t, 'delete');
  const evaluate = operationPage.evaluate.bind(operationPage);
  operationPage.evaluate = (callback, argument) => callback.toString().includes('dispose()') ? new Promise(() => {}) : evaluate(callback, argument);
  const result = await driver.delete(input, { beforeSubmit: async () => {} });
  assert.equal(result.id, originalReceipt.id); assert.ok(result.deletedAt);
  assert.equal(operationPage.closed, true);
  assert.equal(operationPage.events.filter(event => event === 'native-delete').length, 1);
});

test('unsupported edit cleans up only popups opened by its owned operation tab', async (t) => {
  const { driver, context, page, operationPage, input } = await operationFixture(t, 'update');
  const unrelated = new FakePage();
  context.addPopup(unrelated);
  const membership = new FakePage();
  membership.currentUrl = 'https://vip.weibo.com/';
  operationPage.nativeAllowed = false;
  operationPage.onMenu = async () => { context.addPopup(membership); operationPage.emit('popup', membership); };
  await assert.rejects(driver.update(input, { beforeSubmit: async () => assert.fail('must not checkpoint') }), { code: 'OPERATION_UNSUPPORTED' });
  assert.equal(operationPage.closed, true);
  assert.equal(membership.closed, true);
  assert.equal(unrelated.closed, false);
  assert.equal(page.closed, false);
});

test('operation diagnostics are local-only private files with exact stage and no URL query or raw error', async (t) => {
  const { driver, operationPage, input, dataDir } = await operationFixture(t, 'update');
  operationPage.nativeAllowed = false;
  operationPage.onMenu = async () => { operationPage.currentUrl += '?sensitive_query=must-not-be-stored'; };
  await assert.rejects(driver.update(input, { beforeSubmit: async () => assert.fail('must not checkpoint') }), { code: 'OPERATION_UNSUPPORTED' });
  const file = path.join(dataDir, 'weibo-operation-error.json');
  const raw = await readFile(file, 'utf8');
  const diagnostic = JSON.parse(raw);
  assert.equal(diagnostic.stage, 'locate_editor');
  assert.equal(diagnostic.code, 'OPERATION_UNSUPPORTED');
  assert.equal(diagnostic.path, `/detail/${originalReceipt.id}`);
  assert.equal(diagnostic.imageFieldPresent, false);
  assert.equal(raw.includes('sensitive_query'), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('early operation errors also record their validation stage without reading an existing browser page', async (t) => {
  const { driver, dataDir, launches } = await fixture(t);
  await assert.rejects(driver.update({ receipt: originalReceipt, expectedAccountUid: account.uid, body: '正文', images: [] }, { beforeSubmit: async () => {} }), { code: 'OPERATION_UNSUPPORTED' });
  const diagnostic = JSON.parse(await readFile(path.join(dataDir, 'weibo-operation-error.json'), 'utf8'));
  assert.equal(diagnostic.stage, 'validate_input');
  assert.equal(diagnostic.imageFieldPresent, true);
  assert.equal(diagnostic.page, undefined);
  assert.equal(launches.length, 0);
});

test('console reconciliation reads the original target once without navigation, native actions or draft changes', async (t) => {
  const { driver, page, context, dataDir } = await fixture(t);
  await driver.login();
  page.value = '用户已有草稿';
  page.reconciliationResult = { raw: '{"ok":0,"error_code":20101,"message":"抱歉，此微博已被删除。","cookie":"must-not-be-logged"}', targetId: originalReceipt.id, httpStatus: 200 };
  const before = { goto: page.gotoCount, front: page.frontCount, tabs: context.pages().length };
  const result = await driver.reconcileOperation({ receipt: originalReceipt, expectedAccountUid: account.uid }, { operation: 'delete', attemptedAt: new Date(Date.now() - 1_000).toISOString(), beforeSubmit: () => assert.fail('read-only never checkpoints') });
  assert.equal(result, undefined);
  assert.equal(page.events.filter((event) => event === 'reconciliation-read').length, 1);
  assert.deepEqual(page.reconciliationArgument, { id: originalReceipt.id, expectedOrigin: 'https://weibo.com' });
  assert.equal(page.events.some((event) => ['click', 'fill', 'more', 'menu', 'native-delete', 'native-update'].includes(event)), false);
  assert.equal(page.gotoCount, before.goto);
  assert.equal(page.frontCount, before.front);
  assert.equal(context.pages().length, before.tabs);
  assert.equal(page.value, '用户已有草稿');
  assert.equal(page.closed, false);
  const file = path.join(dataDir, 'weibo-reconciliation.json');
  const raw = await readFile(file, 'utf8');
  const diagnostic = JSON.parse(raw);
  assert.equal(diagnostic.targetId, originalReceipt.id);
  assert.equal(diagnostic.providerMessage, '抱歉，此微博已被删除。');
  assert.equal(diagnostic.confirmed, false);
  assert.equal(diagnostic.stage, 'classify_evidence');
  assert.equal(raw.includes('must-not-be-logged'), false);
  assert.equal(raw.includes('cookie'), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('read-only reconciliation requires the same fresh account before and after its GET', async (t) => {
  for (const scenario of ['switched-before', 'expired-before', 'switched-during', 'expired-during', 'transport-error']) {
    await t.test(scenario, async (t) => {
      const { driver, page, dataDir } = await fixture(t);
      await driver.login();
      const switched = { ...config, user: { ...config.user, idstr: '999' } };
      if (scenario === 'switched-before') page.freshConfig = switched;
      if (scenario === 'expired-before') page.freshConfig = undefined;
      page.onReconciliationRead = async () => {
        if (scenario === 'switched-during') page.freshConfig = switched;
        if (scenario === 'expired-during') page.freshConfig = undefined;
        if (scenario === 'transport-error') throw new Error('private transport secret');
      };
      await assert.rejects(driver.reconcileOperation({ receipt: originalReceipt, expectedAccountUid: account.uid }, { operation: 'delete', attemptedAt: new Date(Date.now() - 1_000).toISOString() }), { code: scenario === 'switched-before' ? 'ACCOUNT_CHANGED' : scenario === 'expired-before' ? 'LOGIN_REQUIRED' : 'PUBLISH_UNCERTAIN' });
      assert.equal(page.events.filter((event) => event === 'reconciliation-read').length, scenario.endsWith('before') ? 0 : 1);
      assert.equal(page.events.includes('click'), false);
      assert.equal((await readFile(path.join(dataDir, 'weibo-reconciliation.json'), 'utf8')).includes('private transport secret'), false);
    });
  }
});

test('reconciliation rejects missing original context and never opens a browser for unsupported update proof', async (t) => {
  const { driver, launches, page } = await fixture(t);
  const input = { receipt: originalReceipt, expectedAccountUid: account.uid, title: '已匹配正文' };
  const options = { operation: 'delete', attemptedAt: new Date(Date.now() - 1_000).toISOString() };
  await assert.rejects(driver.reconcileOperation({ ...input, expectedAccountUid: '999' }, options), { code: 'OPERATION_UNSUPPORTED' });
  await assert.rejects(driver.reconcileOperation(input, { operation: 'delete' }), { code: 'OPERATION_UNSUPPORTED' });
  await assert.rejects(driver.reconcileOperation(input, { ...options, operation: 'publish' }), { code: 'OPERATION_UNSUPPORTED' });
  await assert.rejects(driver.reconcileOperation(input, { ...options, attemptedAt: new Date(Date.now() + 60_000).toISOString() }), { code: 'OPERATION_UNSUPPORTED' });
  assert.equal(await driver.reconcileOperation(input, { ...options, operation: 'update' }), undefined);
  await assert.rejects(driver.reconcileOperation(input, options), { code: 'LOGIN_REQUIRED' });
  assert.equal(launches.length, 0);
  assert.equal(page.events.includes('reconciliation-read'), false);
});

function qrPage() {
  const popup = new FakePage();
  popup.currentUrl = 'https://passport.weibo.com/sso/signin?entry=miniblog';
  popup.overlay = false;
  popup.canRefresh = false;
  popup.qrLoaded = true;
  popup.qrCount = 1;
  popup.captureCount = 0;
  popup.refreshCount = 0;
  popup.getByRole = () => ({
    count: async () => popup.canRefresh ? 1 : 0,
    isVisible: async () => popup.canRefresh,
    click: async () => { popup.refreshCount++; popup.overlay = false; popup.canRefresh = false; },
  });
  popup.locator = (selector) => selector.includes('bg-white95') ? { count: async () => popup.overlay ? 1 : 0 } : {
    count: async () => popup.qrCount,
    first() { return this; },
    waitFor: async () => {},
    evaluate: async () => popup.qrLoaded,
    screenshot: async () => { popup.captureCount++; if (popup.onCapture) popup.onCapture(); return Buffer.from('qr-pixels'); },
  };
  return popup;
}

test('status never launches Chrome or mistakes saved browser data for valid login', async (t) => {
  const { driver, launches, dataDir } = await fixture(t);
  assert.deepEqual(await driver.status(), { connected: false, browserOpen: false, sessionSaved: false, headless: false, message: '微博专用浏览器未连接，请恢复会话或重新登录。' });
  await mkdir(path.join(dataDir, 'weibo-profile'));
  const status = await driver.refresh();
  assert.equal(status.sessionSaved, true);
  assert.equal(status.connected, false);
  assert.equal(launches.length, 0);
});

test('resume without saved data does not launch Chrome or create a profile', async (t) => {
  const { driver, launches, dataDir } = await fixture(t);
  const result = await driver.resume();
  assert.equal(result.connected, false);
  assert.equal(result.sessionSaved, false);
  assert.match(result.message, /请先登录/);
  assert.equal(launches.length, 0);
  await assert.rejects(stat(path.join(dataDir, 'weibo-profile')), { code: 'ENOENT' });
});

test('resume opens saved profile headlessly and concurrent repeats reuse the same context', async (t) => {
  const { driver, launches, context, dataDir } = await fixture(t);
  await mkdir(path.join(dataDir, 'weibo-profile'));
  await writeFile(path.join(dataDir, 'weibo-profile', 'preserved-data'), 'saved');
  const results = await Promise.all([driver.resume(), driver.resume()]);
  assert.ok(results.every((result) => result.connected && result.headless));
  assert.equal(launches.length, 1);
  assert.equal(launches[0][0], path.join(dataDir, 'weibo-profile'));
  assert.equal(launches[0][1].headless, true);
  assert.equal(launches[0][1].timeout, 12_000);
  assert.equal(launches[0][1].chromiumSandbox, true);
  assert.equal(context.page.lastGotoOptions.timeout, 12_000);
  assert.equal(context.page.frontCount, 0);
  assert.equal(context.page.gotoCount, 1);
  assert.equal(await readFile(path.join(dataDir, 'weibo-profile', 'preserved-data'), 'utf8'), 'saved');
});

test('resume waits a bounded time for boot identity and does not trust expired saved data', async (t) => {
  const { driver, page, launches, dataDir } = await fixture(t);
  await mkdir(path.join(dataDir, 'weibo-profile'));
  page.config = undefined;
  page.onWait = async () => { page.config = structuredClone(config); };
  assert.equal((await driver.resume()).connected, true);
  assert.deepEqual(page.waits, [{ timeout: 8_000 }]);
  page.config = { isNormal: false };
  page.onWait = async () => { throw new Error('bounded timeout fixture'); };
  const expired = await driver.resume();
  assert.equal(expired.connected, false);
  assert.equal(expired.account, undefined);
  assert.match(expired.message, /已过期或尚未完成/);
  assert.equal(launches.length, 1);
  assert.equal(page.gotoCount, 1);
  assert.equal(page.frontCount, 0);
});

test('resume preserves an existing visible account page and native draft without navigation or focus', async (t) => {
  const { driver, page, context, launches } = await fixture(t);
  await driver.login();
  page.value = '尚未完成的用户草稿';
  const navigationCount = page.gotoCount;
  const fronts = page.frontCount;
  const status = await driver.resume();
  assert.equal(status.connected, true);
  assert.equal(status.headless, false);
  assert.equal(context.closed, false);
  assert.equal(launches.length, 1);
  assert.equal(page.gotoCount, navigationCount);
  assert.equal(page.frontCount, fronts);
  assert.equal(page.value, '尚未完成的用户草稿');
});

test('status, refresh and resume reuse a live same-origin tab when their stored page is stale', async (t) => {
  const { driver, page, context, launches } = await fixture(t);
  await driver.login();
  const foreign = new FakePage();
  foreign.currentUrl = 'https://weibo.com.evil.example/';
  context.addPopup(foreign);
  const replacement = new FakePage();
  replacement.currentUrl = 'https://weibo.com/';
  replacement.value = '另一标签页草稿';
  context.addPopup(replacement);
  page.closed = true;
  for (const action of ['status', 'refresh', 'resume']) {
    const status = await driver[action]();
    assert.equal(status.connected, true);
    assert.equal(status.account.uid, account.uid);
  }
  assert.equal(context.closed, false);
  assert.equal(launches.length, 1);
  assert.equal(replacement.gotoCount, 0);
  assert.equal(replacement.frontCount, 0);
  assert.equal(replacement.value, '另一标签页草稿');
  assert.equal(foreign.events.includes('identity'), false);
});

test('a remaining login popup is preserved, while status and refresh never revive an empty context', async (t) => {
  const { driver, page, context, launches } = await fixture(t);
  await driver.login();
  const popup = qrPage();
  context.addPopup(popup);
  page.closed = true;
  for (const action of ['status', 'refresh', 'resume']) assert.equal((await driver[action]()).connected, false);
  assert.equal(context.closed, false);
  assert.equal(popup.closed, false);
  assert.equal(popup.gotoCount, 0);
  assert.equal(popup.frontCount, 0);
  assert.equal(launches.length, 1);
  popup.closed = true;
  assert.equal((await driver.status()).browserOpen, false);
  assert.equal((await driver.refresh()).browserOpen, false);
  assert.equal(launches.length, 1);
  const restored = await driver.resume();
  assert.equal(context.closed, true);
  assert.equal(restored.connected, true);
  assert.equal(restored.headless, true);
  assert.equal(launches.length, 2);
});

test('resume exposes a security-verification state without exposing identity or clicking controls', async (t) => {
  const { driver, page, dataDir } = await fixture(t);
  await mkdir(path.join(dataDir, 'weibo-profile'));
  page.challenge = true;
  const result = await driver.resume();
  assert.equal(result.connected, false);
  assert.equal(result.account, undefined);
  assert.match(result.message, /安全验证/);
  assert.equal(page.events.includes('click'), false);
  assert.equal(page.frontCount, 0);
});

test('resume fetches uncached current identity and never falls back to stale boot data on a failed response', async (t) => {
  const { driver, page } = await fixture(t);
  await driver.login();
  const normalEvaluate = page.evaluate.bind(page);
  let fetchCount = 0;
  let responseOkay = true;
  let responseValue = { ...config, user: { ...config.user, idstr: '9999999', screen_name: '当前已切换的账号' } };
  page.evaluate = async (callback, fresh) => {
    if (!fresh) return normalEvaluate(callback, fresh);
    const oldWindow = globalThis.window;
    const oldFetch = globalThis.fetch;
    globalThis.window = { $CONFIG: page.config };
    globalThis.fetch = async (url, options) => {
      fetchCount++;
      assert.equal(url, '/ajax/getSpaConfig');
      assert.equal(options.method, 'GET');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      return { ok: responseOkay, text: async () => JSON.stringify({ data: responseValue }) };
    };
    try { return await callback(fresh); }
    finally {
      globalThis.fetch = oldFetch;
      if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    }
  };
  const switched = await driver.resume();
  assert.equal(switched.account.uid, '9999999');
  assert.equal(switched.account.name, '当前已切换的账号');
  assert.equal(page.config.user.idstr, account.uid);
  responseValue = { isNormal: false };
  assert.equal((await driver.resume()).connected, false);
  responseOkay = false;
  const failed = await driver.resume();
  assert.equal(failed.connected, false);
  assert.equal(failed.account, undefined);
  assert.match(failed.message, /暂时无法核实/);
  assert.equal(fetchCount, 3);
});

test('failed restore navigation closes only the newly started context and preserves saved files', async (t) => {
  const { driver, page, context, dataDir } = await fixture(t);
  await mkdir(path.join(dataDir, 'weibo-profile'));
  page.onGoto = async () => { throw new Error('navigation timeout'); };
  await assert.rejects(driver.resume(), { code: 'BROWSER_UNAVAILABLE' });
  assert.equal(context.closed, true);
  const status = await driver.status();
  assert.equal(status.browserOpen, false);
  assert.equal(status.sessionSaved, true);
});

test('publish automatically resumes a closed saved session before exactly one checkpoint and native click', async (t) => {
  const { driver, launches, contexts } = await fixture(t);
  await driver.login();
  await driver.close();
  let checkpoints = 0;
  const result = await driver.publish({ expectedAccountUid: account.uid, body: '恢复后发布的模拟内容', images: [] }, { beforeSubmit: async () => { checkpoints++; contexts.at(-1).page.events.push('checkpoint'); } });
  const restored = contexts.at(-1).page;
  assert.equal(launches.length, 2);
  assert.equal(launches[1][1].headless, true);
  assert.equal(restored.frontCount, 0);
  assert.equal(result.id, '90071992547409931234');
  assert.equal(checkpoints, 1);
  assert.equal(restored.events.filter((event) => event === 'click').length, 1);
  assert.ok(restored.events.indexOf('checkpoint') < restored.events.indexOf('click'));
});

test('publication reuses an existing visible session without bringing its window forward', async (t) => {
  const { driver, page, launches } = await fixture(t);
  await driver.login();
  const fronts = page.frontCount;
  await driver.publish({ expectedAccountUid: account.uid, body: '模拟发布', images: [] }, { beforeSubmit: async () => {} });
  assert.equal(page.frontCount, fronts);
  assert.equal(launches.length, 1);
  assert.equal(page.events.filter((event) => event === 'click').length, 1);
});

test('restored wrong account, expired login and failed checkpoint all stop before a native click', async (t) => {
  for (const scenario of ['account', 'expired', 'checkpoint']) {
    await t.test(scenario, async (t) => {
      const { driver, contexts } = await fixture(t, { onLaunch: (context, count) => {
        if (count !== 2) return;
        if (scenario === 'account') context.page.config.user.idstr = '9999999';
        if (scenario === 'expired') context.page.config = { isNormal: false };
      } });
      await driver.login();
      await driver.close();
      let checkpoints = 0;
      await assert.rejects(driver.publish({ expectedAccountUid: account.uid, body: '不应发出', images: [] }, { beforeSubmit: async () => { checkpoints++; throw new Error('disk full fixture'); } }), scenario === 'checkpoint' ? /disk full fixture/ : { code: scenario === 'account' ? 'ACCOUNT_CHANGED' : 'LOGIN_REQUIRED' });
      const restored = contexts.at(-1).page;
      assert.equal(restored.events.includes('click'), false);
      assert.equal(checkpoints, scenario === 'checkpoint' ? 1 : 0);
      if (scenario !== 'checkpoint') assert.equal(restored.events.includes('fill'), false);
    });
  }
});

test('a publication with no saved session fails without opening Chrome', async (t) => {
  const { driver, launches } = await fixture(t);
  await assert.rejects(driver.publish({ expectedAccountUid: account.uid, body: '无会话', images: [] }, { beforeSubmit: async () => assert.fail('must not checkpoint') }), { code: 'BROWSER_CLOSED' });
  assert.equal(launches.length, 0);
});

test('stale boot identity cannot authorize publishing after a session switch, expiration or verification failure', async (t) => {
  for (const scenario of ['switched', 'expired', 'unavailable', 'stale-editor']) {
    await t.test(scenario, async (t) => {
      const { driver, page } = await fixture(t);
      await driver.login();
      page.freshConfig = scenario === 'expired' ? { isNormal: false } : scenario === 'unavailable' ? undefined : { ...config, user: { ...config.user, idstr: '9999999' } };
      await assert.rejects(driver.publish({ expectedAccountUid: scenario === 'stale-editor' ? '9999999' : account.uid, body: '不应提交', images: [] }, { beforeSubmit: async () => assert.fail('must not checkpoint') }), { code: ['switched', 'stale-editor'].includes(scenario) ? 'ACCOUNT_CHANGED' : 'LOGIN_REQUIRED' });
      assert.equal(page.events.includes('fill'), false);
      assert.equal(page.events.includes('click'), false);
    });
  }
});

test('a session switch during editing or checkpoint prevents the only native click', async (t) => {
  for (const scenario of ['editing', 'checkpoint']) {
    await t.test(scenario, async (t) => {
      const { driver, page } = await fixture(t);
      await driver.login();
      let freshReads = 0;
      let checkpoints = 0;
      const switchAccount = () => { page.freshConfig = { ...config, user: { ...config.user, idstr: '9999999' } }; };
      page.onFresh = async () => { if (++freshReads === 2 && scenario === 'editing') switchAccount(); };
      await assert.rejects(driver.publish({ expectedAccountUid: account.uid, body: '不应提交', images: [] }, { beforeSubmit: async () => { checkpoints++; if (scenario === 'checkpoint') switchAccount(); } }), { code: scenario === 'editing' ? 'ACCOUNT_CHANGED' : 'PUBLISH_UNCERTAIN' });
      assert.equal(checkpoints, scenario === 'editing' ? 0 : 1);
      assert.equal(page.events.includes('click'), false);
    });
  }
});

test('content edited while the final identity request is pending cannot reach native submit', async (t) => {
  for (const scenario of ['text', 'media']) {
    await t.test(scenario, async (t) => {
      const { driver, page } = await fixture(t);
      await driver.login();
      let freshReads = 0;
      page.onFresh = async () => {
        if (++freshReads !== 3) return;
        if (scenario === 'text') page.value = '未经确认的新正文';
        else page.media = 1;
      };
      await assert.rejects(driver.publish({ expectedAccountUid: account.uid, body: '确认过的正文', images: [] }, { beforeSubmit: async () => {} }), { code: 'PUBLISH_UNCERTAIN' });
      assert.equal(page.events.includes('click'), false);
    });
  }
});

test('QR mode launches headless and only explicit open promotes the same saved profile to a window', async (t) => {
  const { driver, launches, context, contexts, dataDir, page } = await fixture(t);
  const status = await driver.login({ mode: 'qr' });
  assert.equal(status.connected, true);
  assert.equal(status.headless, true);
  assert.equal(status.sessionSaved, true);
  assert.equal(page.frontCount, 0);
  await writeFile(path.join(dataDir, 'weibo-profile', 'session-fixture'), 'preserve');
  const opened = await driver.open();
  assert.equal(context.closed, true);
  assert.equal(launches.length, 2);
  assert.equal(launches[0][1].headless, true);
  assert.equal(launches[1][1].headless, false);
  assert.ok(launches.every(([, options]) => options.chromiumSandbox === true));
  assert.equal(launches[0][0], launches[1][0]);
  assert.equal(opened.headless, false);
  assert.equal(contexts[1].page.frontCount, 1);
  assert.equal(await readFile(path.join(dataDir, 'weibo-profile', 'session-fixture'), 'utf8'), 'preserve');
  const closed = await driver.close();
  assert.equal(closed.sessionSaved, true);
  assert.equal(closed.headless, false);
});

test('requesting QR mode preserves an existing visible browser and its editor', async (t) => {
  const { driver, page, context, launches } = await fixture(t);
  await driver.login();
  page.value = '用户正在编辑的官网草稿';
  const navigationCount = page.gotoCount;
  const fronts = page.frontCount;
  const status = await driver.login({ mode: 'qr' });
  assert.equal(launches.length, 1);
  assert.equal(context.closed, false);
  assert.equal(status.headless, false);
  assert.equal(page.gotoCount, navigationCount);
  assert.equal(page.frontCount, fronts);
  assert.equal(page.value, '用户正在编辑的官网草稿');
  await assert.rejects(driver.login({ mode: 'unsupported' }), { code: 'LOGIN_MODE_INVALID' });
  assert.equal(launches.length, 1);
});

test('QR extraction is limited to the exact official signin page and returns only PNG pixels', async () => {
  assert.equal(isWeiboLoginPage('https://passport.weibo.com/sso/signin?entry=miniblog'), true);
  for (const url of ['https://passport.weibo.com.evil.example/sso/signin', 'http://passport.weibo.com/sso/signin', 'https://passport.weibo.com/visitor/visitor', 'bad-url']) assert.equal(isWeiboLoginPage(url), false);
  const popup = qrPage();
  const status = await readQrLogin(popup);
  assert.deepEqual(status.login, { kind: 'qr', image: `data:image/png;base64,${Buffer.from('qr-pixels').toString('base64')}` });
  assert.equal(popup.captureCount, 1);
  popup.currentUrl = 'https://evil.example/sso/signin';
  assert.equal(await readQrLogin(popup), undefined);
  assert.equal(popup.captureCount, 1);
});

test('expired, confirmed, unloaded, ambiguous and redirected QR images are never returned as scannable', async () => {
  const popup = qrPage();
  popup.overlay = true;
  popup.canRefresh = true;
  assert.equal((await readQrLogin(popup)).login.image, undefined);
  assert.match((await readQrLogin(popup)).message, /已失效/);
  popup.canRefresh = false;
  assert.match((await readQrLogin(popup)).message, /手机端完成确认/);
  assert.equal(popup.captureCount, 0);
  popup.overlay = false;
  popup.qrLoaded = false;
  assert.equal((await readQrLogin(popup)).login.image, undefined);
  popup.qrLoaded = true;
  popup.qrCount = 2;
  assert.equal((await readQrLogin(popup)).login.image, undefined);
  popup.qrCount = 1;
  popup.onCapture = () => { popup.currentUrl = 'https://weibo.com/'; };
  assert.equal((await readQrLogin(popup)).login.image, undefined);
});

test('QR login waits for the official popup and explicit refresh renews an expired QR', async (t) => {
  const { driver, page, context, launches } = await fixture(t);
  page.config = { isNormal: false };
  const popup = qrPage();
  const button = new CountLocator(1);
  button.click = async () => { context.addPopup(popup); };
  page.getByRole = () => button;
  const status = await driver.login({ mode: 'qr' });
  assert.equal(status.connected, false);
  assert.equal(status.headless, true);
  assert.ok(status.login.image.startsWith('data:image/png;base64,'));
  assert.equal(launches.length, 1);
  popup.overlay = true;
  popup.canRefresh = true;
  assert.equal((await driver.status()).login.image, undefined);
  const refreshed = await driver.refresh();
  assert.equal(popup.refreshCount, 1);
  assert.ok(refreshed.login.image);
  // A scan/redirect alone is insufficient; homepage identity must confirm it.
  popup.currentUrl = 'https://weibo.com/';
  assert.equal((await driver.status()).connected, false);
  page.onGoto = async () => { page.config = structuredClone(config); };
  const connected = await driver.refresh();
  assert.equal(connected.connected, true);
  assert.equal(connected.account.uid, account.uid);
  assert.equal(connected.login, undefined);
});

test('refresh leaves a connected native draft intact and closed QR contexts expose no stale image', async (t) => {
  const { driver, page, context } = await fixture(t);
  await driver.login({ mode: 'qr' });
  const navigationCount = page.gotoCount;
  page.value = '官网草稿';
  await driver.refresh();
  assert.equal(page.gotoCount, navigationCount);
  assert.equal(page.value, '官网草稿');
  await context.close();
  const status = await driver.status();
  assert.equal(status.browserOpen, false);
  assert.equal(status.headless, false);
  assert.equal(status.sessionSaved, true);
  assert.equal(status.login, undefined);
});

test('login launches only an isolated profile and closing clears readiness while keeping that profile', async (t) => {
  const { driver, launches, dataDir, context } = await fixture(t);
  assert.equal((await driver.status()).connected, false);
  assert.equal((await driver.login()).connected, true);
  assert.equal(launches[0][0], path.join(dataDir, 'weibo-profile'));
  assert.equal(launches[0][1].headless, false);
  assert.equal(launches[0][1].channel, 'chrome');
  assert.equal(launches[0][1].chromiumSandbox, true);
  assert.equal((await stat(launches[0][0])).mode & 0o777, 0o700);
  await driver.close();
  assert.equal(context.closed, true);
  assert.deepEqual((({ connected, browserOpen }) => ({ connected, browserOpen }))(await driver.status()), { connected: false, browserOpen: false });
  assert.equal((await stat(launches[0][0])).isDirectory(), true);
});

test('missing Chrome falls back to bundled Chromium with the sandbox in both login modes', async t => {
  for (const mode of ['qr', 'window']) await t.test(mode, async t => {
    const f = await fixture(t, { onLaunch(_context, attempt) {
      if (attempt === 1) throw new Error('Chromium distribution chrome is not found');
    } });
    await f.driver.login({ mode });
    assert.equal(f.launches.length, 2);
    assert.equal(f.launches[0][0], f.launches[1][0]);
    assert.equal(f.launches[0][1].channel, 'chrome');
    assert.equal(f.launches[1][1].channel, undefined);
    for (const [, options] of f.launches) {
      assert.equal(options.headless, mode === 'qr');
      assert.equal(options.chromiumSandbox, true);
      assert.equal(options.args.some(arg => /^--no-sandbox(?:=|$)/.test(arg)), false);
    }
  });
});

test('sandbox launch failures do not retry another engine or disable the sandbox', async t => {
  for (const mode of ['qr', 'window']) await t.test(mode, async t => {
    const f = await fixture(t, { onLaunch() { throw new Error('No usable sandbox!'); } });
    await assert.rejects(f.driver.login({ mode }), { code: 'BROWSER_UNAVAILABLE' });
    assert.equal(f.launches.length, 1);
    assert.equal(f.launches[0][1].channel, 'chrome');
    assert.equal(f.launches[0][1].chromiumSandbox, true);
    assert.equal(f.launches[0][1].headless, mode === 'qr');
    assert.equal((await f.driver.status()).browserOpen, false);
  });
});

test('disconnect deletes only its isolated profile and rejects symlinks', async (t) => {
  const { driver, dataDir } = await fixture(t);
  await driver.login();
  await writeFile(path.join(dataDir, 'keep-ledger.json'), 'keep');
  await driver.disconnect();
  await assert.rejects(stat(path.join(dataDir, 'weibo-profile')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(dataDir, 'keep-ledger.json'), 'utf8'), 'keep');
  const elsewhere = path.join(dataDir, 'daily-profile');
  await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, 'keep'), 'keep');
  await symlink(elsewhere, path.join(dataDir, 'weibo-profile'));
  await assert.rejects(driver.disconnect(), { code: 'BROWSER_UNAVAILABLE' });
  assert.equal(await readFile(path.join(elsewhere, 'keep'), 'utf8'), 'keep');
});

test('publish journals before clicking and waits for real provider receipt', async (t) => {
  const { driver, page } = await fixture(t);
  await driver.login({ mode: 'qr' });
  const receipt = await driver.publish({ expectedAccountUid: account.uid, title: '自己的标题', body: '自己登录后发布的正文', images: [] }, { beforeSubmit: async () => { page.events.push('checkpoint'); } });
  assert.equal(page.value, '自己的标题\n\n自己登录后发布的正文');
  assert.ok(page.events.indexOf('checkpoint') < page.events.indexOf('click'));
  assert.equal(receipt.id, '90071992547409931234');
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(page.frontCount, 0);
});

test('failed durable checkpoint and ambiguous editor never click publish', async (t) => {
  const { driver, page } = await fixture(t);
  await driver.login();
  await assert.rejects(driver.publish({ expectedAccountUid: account.uid, body: '正文', images: [] }, { beforeSubmit: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(page.events.includes('click'), false);
  page.editorCount = 2;
  await assert.rejects(driver.publish({ expectedAccountUid: account.uid, body: '正文', images: [] }, { beforeSubmit: async () => assert.fail('must not journal') }), { code: 'UI_CHANGED' });
  assert.equal(page.events.includes('click'), false);
});

test('login loss and existing media stop publication before journaling', async (t) => {
  const { driver, page } = await fixture(t);
  await driver.login();
  const input = { expectedAccountUid: account.uid, body: '正文', images: [] };
  const hook = { beforeSubmit: async () => assert.fail('must not journal') };
  page.media = 1;
  await assert.rejects(driver.publish(input, hook), { code: 'IMAGE_UPLOAD_FAILED' });
  page.media = 0;
  page.config = { isNormal: false };
  await assert.rejects(driver.publish(input, hook), { code: 'LOGIN_REQUIRED' });
  assert.equal(page.events.includes('click'), false);
});

test('account switch since user confirmation stops before changing the editor', async (t) => {
  const { driver, page } = await fixture(t);
  await driver.login();
  page.config.user.idstr = '999999999';
  await assert.rejects(driver.publish({ expectedAccountUid: account.uid, body: '正文', images: [] }, { beforeSubmit: async () => assert.fail('must not journal') }), { code: 'ACCOUNT_CHANGED' });
  assert.equal(page.events.includes('fill'), false);
  assert.equal(page.events.includes('click'), false);
});

test('multiple uploaded images are verified before the checkpoint and native click', async (t) => {
  const { driver, page } = await fixture(t);
  await driver.login();
  const originalLocator = page.root.locator;
  page.root.locator = (selector) => selector.startsWith('input[type="file"]') ? {
    count: async () => 1,
    setInputFiles: async (files) => {
      assert.equal(files.length, 2);
      page.media = 2;
      for (let index = 0; index < files.length; index++) page.emit('response', makeResponse(JSON.stringify({ ret: true, pic: { pid: `uploaded${index}` } }), 'https://picupload.weibo.com/interface/upload.php'));
    },
  } : originalLocator(selector);
  const result = await driver.publish({ expectedAccountUid: account.uid, body: '两张图片', images: ['data:image/png;base64,aGVsbG8=', 'data:image/png;base64,aGVsbG8='] }, { beforeSubmit: async () => { assert.equal(page.media, 2); page.events.push('checkpoint'); } });
  assert.equal(result.id, '90071992547409931234');
  assert.ok(page.events.indexOf('checkpoint') < page.events.indexOf('click'));
  assert.equal(page.listenerCount('response'), 0);
});

test('provider upload rejection stops without a submission checkpoint', async (t) => {
  const { driver, page } = await fixture(t);
  await driver.login();
  const originalLocator = page.root.locator;
  page.root.locator = (selector) => selector.startsWith('input[type="file"]') ? {
    count: async () => 1,
    setInputFiles: async () => { page.emit('response', makeResponse('{"ret":false}', 'https://picupload.weibo.com/interface/upload.php')); },
  } : originalLocator(selector);
  await assert.rejects(driver.publish({ expectedAccountUid: account.uid, body: '图片失败', images: ['data:image/png;base64,aGVsbG8='] }, { beforeSubmit: async () => assert.fail('must not journal') }), { code: 'IMAGE_UPLOAD_FAILED' });
  assert.equal(page.events.includes('click'), false);
  assert.equal(page.listenerCount('response'), 0);
});

test('unverified image input fails without silently publishing text only', async (t) => {
  const { driver, page } = await fixture(t);
  await driver.login();
  await assert.rejects(driver.publish({ expectedAccountUid: account.uid, body: '含图微博', images: ['data:image/png;base64,aGVsbG8='] }, { beforeSubmit: async () => assert.fail('must not journal') }), { code: 'IMAGE_UPLOAD_FAILED' });
  assert.equal(page.events.includes('click'), false);
});

test('browser operations are serialized behind an active publication', async (t) => {
  const { driver, context, page } = await fixture(t);
  await driver.login();
  let unblock;
  let reached;
  const entered = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { unblock = resolve; });
  const publishing = driver.publish({ expectedAccountUid: account.uid, body: '正文', images: [] }, { beforeSubmit: async () => { reached(); await gate; } });
  await entered;
  const closing = driver.close();
  assert.equal(context.closed, false);
  assert.equal(page.events.includes('click'), false);
  unblock();
  assert.equal((await publishing).id, '90071992547409931234');
  await closing;
  assert.equal(context.closed, true);
});

// Opt-in acceptance fixture: the real browser DOM and file input are exercised,
// but every page request is intercepted. It never contacts or posts to Weibo.
test('native DOM fixture publishes two verified photos through the real isolated driver', { skip: process.env.FATIAO_WEIBO_DOM_TEST !== '1', timeout: 60_000 }, async (t) => {
  const { chromium } = await import('playwright');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'fatiao-weibo-dom-'));
  const fixtureOrigin = 'https://weibo.fixture.test';
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=', 'base64');
  const events = [];
  let uploadCount = 0;
  let submitted;
  let ownedContext;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>微博 DOM 验收</title></head><body>
    <script>window.$CONFIG = ${JSON.stringify(config)};</script>
    <button id="unrelated">发送</button>
    <main id="composer">
      <textarea placeholder="有什么新鲜事想分享给大家？"></textarea>
      <div id="pictures"><div class="_picbed_fixture" title="添加">添加</div></div>
      <input type="file" accept="image/*, .jpg, .jpeg, .png" multiple hidden>
      <button type="button" id="send">发送</button>
    </main>
    <script>
      document.querySelector('input').addEventListener('change', async (event) => {
        for (const file of event.target.files) {
          const tile = document.createElement('div');
          tile.className = '_picbed_fixture';
          tile.innerHTML = '<button title="删除">删除</button><div class="_pic_fixture woo-picture-main"><img class="woo-picture-img" width="80" height="80"></div><div class="_loading_fixture">上传中</div>';
          document.querySelector('#pictures').append(tile);
          const result = await (await fetch('https://picupload.weibo.com/interface/upload.php', { method: 'POST', body: file })).json();
          const image = tile.querySelector('img');
          image.onload = () => tile.querySelector('._loading_fixture').remove();
          image.src = 'https://wx1.sinaimg.cn/large/' + result.pic.pid + '.png';
        }
      });
      document.querySelector('#send').addEventListener('click', () => fetch('/ajax/statuses/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: document.querySelector('textarea').value, images: [...document.querySelectorAll('img')].map(image => image.src) })
      }));
      document.querySelector('#unrelated').addEventListener('click', () => { throw new Error('Wrong composer button'); });
    </script>
  </body></html>`;
  const driver = createWeiboBrowser({ dataDir, baseUrl: fixtureOrigin, headless: true, chromium: {
    launchPersistentContext: async (profileDir, options) => {
      ownedContext = await chromium.launchPersistentContext(profileDir, { ...options, args: [...options.args, '--enable-automation'], headless: true, serviceWorkers: 'block' });
      try {
        const session = await ownedContext.newCDPSession(ownedContext.pages()[0] || await ownedContext.newPage());
        try {
          const { arguments: args } = await session.send('Browser.getBrowserCommandLine');
          assert.equal(args.some(arg => /^--no-sandbox(?:=|$)/.test(arg)), false);
        } finally { await session.detach(); }
      } catch (error) { await ownedContext.close(); throw error; }
      await ownedContext.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin === fixtureOrigin && url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
        if (url.origin === fixtureOrigin && url.pathname === '/ajax/getSpaConfig' && request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: config }) });
        if (url.hostname === 'picupload.weibo.com' && url.pathname === '/interface/upload.php') {
          const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': '*' };
          if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
          uploadCount++;
          events.push('upload');
          return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ ret: true, pic: { pid: `fixtureimage${uploadCount}` } }) });
        }
        if (url.hostname === 'wx1.sinaimg.cn') return route.fulfill({ status: 200, contentType: 'image/png', body: pixel });
        if (url.origin === fixtureOrigin && url.pathname === '/ajax/statuses/update' && request.method() === 'POST') {
          submitted = JSON.parse(request.postData());
          events.push('submit');
          return route.fulfill({ status: 200, contentType: 'application/json', body: receiptBody });
        }
        return route.abort();
      });
      return ownedContext;
    },
  } });
  t.after(async () => {
    await driver.close();
    if (ownedContext?.browser()?.isConnected()) await ownedContext.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  assert.equal((await driver.login()).connected, true);
  const receipt = await driver.publish({ expectedAccountUid: account.uid, title: '标题', body: '两张图的原生编辑器验收', images: [`data:image/png;base64,${pixel.toString('base64')}`, `data:image/png;base64,${pixel.toString('base64')}`] }, { beforeSubmit: async () => { events.push('checkpoint'); } });
  assert.equal(receipt.id, '90071992547409931234');
  assert.equal(uploadCount, 2);
  assert.equal(submitted.text, '标题\n\n两张图的原生编辑器验收');
  assert.equal(submitted.images.length, 2);
  assert.deepEqual(events, ['upload', 'upload', 'checkpoint', 'submit']);
});
