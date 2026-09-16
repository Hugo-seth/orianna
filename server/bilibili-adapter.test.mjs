import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import {
  bilibiliAccount, bilibiliEditorState, bilibiliImageFiles, bilibiliPictureKey, bilibiliPicturesReady,
  bilibiliUploadedPicture, composeBilibiliText, confirmedBilibiliPublication,
  createBilibiliAdapter, isBilibiliResponse, waitForBilibiliPublication,
  bilibiliMutationTarget, bilibiliPublishedState, confirmedBilibiliMutation, isBilibiliMutationResponse, waitForBilibiliMutation,
  bilibiliReconcileCandidate,
  bilibiliPublicationTimestamp,
} from './bilibili-adapter.mjs';

const account = { uid: '12345', name: '测试账号' };
const state = { isLogin: true, mid: 12345, uname: account.name, face: 'https://i0.hdslb.com/bfs/face/test.jpg' };
const responseBody = '{"code":0,"data":{"dyn_id_str":"90071992547409939999","dyn_id":90071992547409939999,"dyn_type":2}}';
const makeResponse = (body = responseBody, pathname = '/x/dynamic/feed/create/dyn', method = 'POST', origin = 'https://api.bilibili.com') => ({
  url: () => origin + pathname, request: () => ({ method: () => method }), ok: () => true, text: async () => body,
});
const originalReceipt = { id: '90071992547409939999', url: 'https://t.bilibili.com/90071992547409939999', account, publishedAt: '2026-09-15T00:00:00.000Z' };
const mutationResponse = (operation, targetId = originalReceipt.id, body = '{"code":0,"data":{}}') => ({
  ...makeResponse(body, operation === 'update' ? '/x/dynamic/feed/edit/dyn' : '/x/dynamic/feed/operate/remove'),
  request: () => ({ method: () => 'POST', postData: () => JSON.stringify({ dyn_id_str: targetId }) }),
});

const attemptedAt = new Date(Date.now() - 120_000).toISOString();
const candidateText = '待确认标题\n\n待确认正文';
const candidatePicture = 'https://i0.hdslb.com/bfs/new_dyn/original.png';
const candidateInput = { title: '待确认标题', body: '待确认正文', images: ['data:image/png;base64,aGVsbG8='], expectedAccountUid: account.uid };
function reconcileItem(postId = originalReceipt.id) {
  return { id_str: postId, type: 'DYNAMIC_TYPE_DRAW', modules: {
    module_author: { mid: account.uid, name: account.name, pub_ts: Math.floor(Date.parse(attemptedAt) / 1000) + 3 },
    module_dynamic: { major: { opus: { title: '', summary: { text: candidateText, has_more: false, rich_text_nodes: [{ text: candidateText, type: 'RICH_TEXT_NODE_TYPE_TEXT' }] }, pics: [{ url: candidatePicture }] } } },
  } };
}
function reconcileFixture({ items = [reconcileItem()], pages, details, identities = [true], accountStates = [state, state], evaluateImages } = {}) {
  const calls = [];
  const page = new EventEmitter();
  let imageIndex = 0, accountIndex = 0, feedIndex = 0;
  page.url = () => 'https://t.bilibili.com/';
  page.isClosed = () => false;
  page.goto = page.click = page.fill = () => assert.fail('reconciliation must never navigate or submit');
  page.evaluate = async (callback, args) => {
    if (!args) { calls.push('account'); return accountStates[accountIndex++] || state; }
    if (args.originals) {
      calls.push('image');
      return evaluateImages ? evaluateImages(callback, args) : identities[imageIndex++];
    }
    if (args.detailId) { calls.push(`detail:${args.detailId}`); return details ? details[args.detailId] : { items: items.filter((item) => item.id_str === args.detailId) }; }
    calls.push(`feed:${args.offset}`);
    return pages ? pages[feedIndex++] : { items, hasMore: false, offset: '' };
  };
  return { page, calls, adapter: createBilibiliAdapter() };
}

test('B站 reconcile candidate requires exact author, complete plain text, image order and absolute time', () => {
  const options = { uid: account.uid, text: candidateText, imageCount: 1, imageKeys: ['/bfs/new_dyn/original.png'], attemptedAt };
  assert.equal(bilibiliReconcileCandidate(reconcileItem(), options).id, originalReceipt.id);
  for (const mutate of [
    (item) => { item.modules.module_author.mid = '999'; },
    (item) => { item.modules.module_author.pub_ts = Math.floor(Date.parse(attemptedAt) / 1000) - 1; },
    (item) => { item.modules.module_author.pub_ts = Math.floor(Date.parse(attemptedAt) / 1000) + 601; },
    (item) => { item.modules.module_author.pub_ts = '刚刚'; },
    (item) => { item.modules.module_dynamic.major.opus.summary.has_more = true; },
    (item) => { delete item.modules.module_dynamic.major.opus.summary.has_more; },
    (item) => { item.modules.module_dynamic.major.opus.title = '独立标题'; },
    (item) => { item.modules.module_dynamic.major.opus.summary.text += '其他内容'; },
    (item) => { item.modules.module_dynamic.major.opus.summary.rich_text_nodes[0].text = '不同正文'; },
    (item) => { item.modules.module_dynamic.major.opus.summary.rich_text_nodes[0].type = 'RICH_TEXT_NODE_TYPE_WEB'; },
    (item) => { item.modules.module_dynamic.major.opus.pics[0].url = 'https://i0.hdslb.com/bfs/new_dyn/other.png'; },
    (item) => { item.modules.module_dynamic.additional = {}; },
    (item) => { item.orig = {}; },
  ]) { const item = reconcileItem(); mutate(item); assert.equal(bilibiliReconcileCandidate(item, options), undefined); }
});

test('B站 reconcile confirms unique full detail and exact image identity with fresh final author', async () => {
  const { page, calls, adapter } = reconcileFixture();
  const result = await adapter.reconcilePublication(page, candidateInput, { attemptedAt });
  assert.equal(result.id, originalReceipt.id);
  assert.equal(result.publishedAt, new Date(reconcileItem().modules.module_author.pub_ts * 1000).toISOString());
  assert.deepEqual(result.account, account);
  assert.deepEqual(calls, ['account', 'feed:', `detail:${originalReceipt.id}`, 'image', 'account']);
});

test('B站 reconcile preserves uncertainty for different/unknown images, duplicate matches and unknown alternatives', async () => {
  const second = reconcileItem('90071992547409939998');
  for (const config of [
    { identities: [false] }, { identities: [undefined] },
    { items: [reconcileItem(), second], identities: [true, true] },
    { items: [reconcileItem(), second], identities: [true, undefined] },
    { items: [second, reconcileItem()], identities: [undefined, true] },
    { accountStates: [state, { ...state, mid: 999 }] },
  ]) { const { page, adapter } = reconcileFixture(config); assert.equal(await adapter.reconcilePublication(page, candidateInput, { attemptedAt }), undefined); }
  const { page, adapter } = reconcileFixture({ items: [reconcileItem(), second], identities: [false, true] });
  assert.equal((await adapter.reconcilePublication(page, candidateInput, { attemptedAt })).id, second.id_str);
});

test('B站 reconcile does not discard an otherwise matching candidate with unknown image URL or rich node', async () => {
  for (const mutate of [
    (item) => { item.modules.module_dynamic.major.opus.pics[0].url = 'https://i0.hdslb.com/unknown/picture.png'; },
    (item) => { item.modules.module_dynamic.major.opus.summary.rich_text_nodes[0].type = 'RICH_TEXT_NODE_TYPE_WEB'; },
    (item) => { item.modules.module_dynamic.major.opus.summary.paragraphs = [true]; item.modules.module_dynamic.major.opus.pics = []; },
  ]) {
    const unknown = reconcileItem('90071992547409939998'); mutate(unknown);
    const { page, adapter } = reconcileFixture({ items: [reconcileItem(), unknown] });
    assert.equal(await adapter.reconcilePublication(page, candidateInput, { attemptedAt }), undefined);
  }
});

test('B站 reconcile needs explicitly complete pagination and cannot stop at an old pinned post', async () => {
  const old = reconcileItem('90071992547409939997'); old.modules.module_author.pub_ts -= 3600;
  const { page, calls, adapter } = reconcileFixture({ pages: [{ items: [old], hasMore: true, offset: 'next' }, { items: [reconcileItem()], hasMore: false }] });
  assert.equal((await adapter.reconcilePublication(page, candidateInput, { attemptedAt })).id, originalReceipt.id);
  assert.ok(calls.includes('feed:next'));
  for (const pages of [
    [{ items: [reconcileItem()] }],
    [{ items: [reconcileItem()], hasMore: true, offset: '' }],
    [1, 2, 3].map((number) => ({ items: [reconcileItem()], hasMore: true, offset: String(number) })),
  ]) { const fixture = reconcileFixture({ pages }); assert.equal(await fixture.adapter.reconcilePublication(fixture.page, candidateInput, { attemptedAt }), undefined); assert.equal(fixture.calls.includes('image'), false); }
});

test('B站 reconcile rejects missing, truncated or mismatched details without native submission', async () => {
  for (const detail of [null, { items: [] }, { items: [reconcileItem('999')] }, { items: [(() => { const item = reconcileItem(); item.modules.module_dynamic.major.opus.summary.has_more = true; return item; })()] }]) {
    const { page, adapter } = reconcileFixture({ details: { [originalReceipt.id]: detail } });
    assert.equal(await adapter.reconcilePublication(page, candidateInput, { attemptedAt }), undefined);
  }
});

test('B站 reconciliation diagnostics identify the exact safe stopping stage without changing pending outcomes', async () => {
  const incomplete = reconcileItem(); delete incomplete.modules.module_dynamic.major.opus.summary.has_more;
  for (const [config, attempt, stage, reason] of [
    [{}, 'invalid', 'input', 'invalid-attempt'],
    [{ accountStates: [{ ...state, mid: 999 }] }, attemptedAt, 'account', 'account-mismatch'],
    [{ pages: [{ items: [reconcileItem()], hasMore: 1, offset: 'next' }] }, attemptedAt, 'feed', 'pagination-invalid'],
    [{ details: { [originalReceipt.id]: { items: [incomplete] } } }, attemptedAt, 'detail', 'detail-completeness-missing'],
    [{ identities: [undefined] }, attemptedAt, 'images', 'image-unverified'],
    [{ items: [] }, attemptedAt, 'feed', 'no-match'],
  ]) {
    const { page, adapter } = reconcileFixture(config);
    assert.equal(await adapter.reconcilePublication(page, candidateInput, { attemptedAt: attempt }), undefined);
    const report = (await adapter.diagnostics(page)).reconcile;
    assert.equal(report.stage, stage); assert.equal(report.reason, reason);
    assert.doesNotMatch(JSON.stringify(report), /待确认|data:image|12345|original\.png/);
  }
  const { page, adapter } = reconcileFixture();
  await adapter.reconcilePublication(page, candidateInput, { attemptedAt });
  const report = (await adapter.diagnostics(page)).reconcile;
  assert.equal(report.stage, 'complete'); assert.equal(report.reason, 'confirmed');
  assert.deepEqual([report.feedPages, report.feedItems, report.inWindow, report.details, report.matches], [1, 1, 1, 1, 1]);
});

test('B站 feed diagnostic distinguishes invalid ID from missing, nonnumeric and invalid timestamps', async () => {
  for (const [mutate, reason] of [
    [(item) => { item.id_str = 'not-a-post-id'; }, 'feed-id-invalid'],
    [(item) => { delete item.modules.module_author.pub_ts; }, 'feed-timestamp-missing'],
    [(item) => { item.modules.module_author.pub_ts = {}; }, 'feed-timestamp-type'],
    [(item) => { item.modules.module_author.pub_ts = 0; }, 'feed-timestamp-invalid'],
  ]) {
    const item = reconcileItem(); mutate(item);
    const { page, adapter } = reconcileFixture({ items: [item] });
    assert.equal(await adapter.reconcilePublication(page, candidateInput, { attemptedAt }), undefined);
    const report = (await adapter.diagnostics(page)).reconcile;
    assert.equal(report.reason, reason);
    assert.doesNotMatch(JSON.stringify(report), /private-time|not-a-post-id/);
  }
});

test('B站 pub_ts accepts canonical decimal integer strings and rejects coercive or unsafe representations', async () => {
  const seconds = reconcileItem().modules.module_author.pub_ts;
  assert.equal(bilibiliPublicationTimestamp(String(seconds)), seconds);
  assert.equal(bilibiliPublicationTimestamp(seconds), seconds);
  for (const invalid of ['', '0', '01', '-1', '+1', ' 123', '123 ', '1.0', '1e3', '0x10', '9007199254740992', Infinity, NaN, 1.5, true, {}, null]) assert.equal(bilibiliPublicationTimestamp(invalid), undefined);
  const item = reconcileItem(); item.modules.module_author.pub_ts = String(seconds);
  const detail = reconcileItem();
  const { page, adapter } = reconcileFixture({ items: [item], details: { [item.id_str]: { items: [detail] } } });
  const receipt = await adapter.reconcilePublication(page, candidateInput, { attemptedAt });
  assert.equal(receipt.id, originalReceipt.id);
  assert.equal(receipt.publishedAt, new Date(seconds * 1000).toISOString());
  assert.equal(receipt.account.uid, account.uid);
  const direct = bilibiliReconcileCandidate(item, { uid: account.uid, text: candidateText, imageCount: 1, imageKeys: ['/bfs/new_dyn/original.png'], attemptedAt });
  assert.equal(direct.id, originalReceipt.id);
});

test('B站 upload readiness requires the exact CSS preview to decode, not only a success tile', async () => {
  for (const [backgroundImage, decode, expected] of [
    ['none', true, 0],
    ['url("")', true, 0],
    ['url("https://untrusted.example/private.png")', true, 0],
    ['url("data:image/png;base64,aGVsbG8=")', false, 0],
    ['url("data:image/png;base64,aGVsbG8=")', true, 1],
  ]) {
    let requests = 0;
    const vm = { $options: { name: 'bili-dyn-publishing' }, content: { value: 'body' }, tools: { pic: { data: [{ img_src: candidatePicture }] } } };
    const element = { __vue__: vm, querySelectorAll: () => [{ classList: { contains: (name) => name === 'success' }, querySelector: (selector) => selector === '.bili-pics-uploader-item-preview__pic' ? {} : null }] };
    const root = { evaluate: async (callback, args) => runInNewContext(`(${callback.toString()})(element,args)`, {
      element, args, URL, setTimeout, clearTimeout, location: { origin: 'https://t.bilibili.com' }, getComputedStyle: () => ({ backgroundImage }),
      Image: class {
        naturalWidth = decode ? 100 : 0; naturalHeight = decode ? 100 : 0;
        set src(value) { if (value) { requests++; queueMicrotask(() => decode ? this.onload?.() : this.onerror?.()); } }
      },
    }) };
    const result = await bilibiliEditorState(root, { verifyPreviews: true });
    assert.equal(result.ready, expected); assert.equal(result.previewLoaded, expected); assert.equal(result.previewMissing, 1 - expected);
    if (!backgroundImage.startsWith('url("data:')) assert.equal(requests, 0);
    assert.doesNotMatch(JSON.stringify(result), /base64|untrusted/);
  }
});

test('B站 feed diagnostics preserve status, provider code and fixed shape names without raw response content', async () => {
  for (const [response, outcome, expected] of [
    [{ ok: false, status: 403 }, 'http-error', { status: 403 }],
    [{ ok: true, status: 200, json: async () => ({ code: -352, message: 'private-token', data: { items: null, item: 'private-secret' } }) }, 'provider-error', { status: 200, code: -352, itemsShape: 'other', itemShape: 'other', hasMoreType: 'missing' }],
    [{ ok: true, status: 200, json: async () => ({ code: 0, data: { items: { secret: 'private' }, has_more: 1 } }) }, 'shape-error', { status: 200, code: 0, itemsShape: 'object', itemShape: 'missing', hasMoreType: 'number' }],
    [{ ok: true, status: 200, json: async () => { throw new Error('private-body'); } }, 'body-error', { status: 200 }],
  ]) {
    const { page, adapter } = reconcileFixture();
    const base = page.evaluate;
    page.evaluate = async (callback, args) => !args || args.originals ? base(callback, args) : runInNewContext(`(${callback.toString()})(args)`, {
      args, AbortController, setTimeout, clearTimeout, URL, URLSearchParams, fetch: async () => response,
    });
    assert.equal(await adapter.reconcilePublication(page, candidateInput, { attemptedAt }), undefined);
    const report = (await adapter.diagnostics(page)).reconcile;
    assert.equal(report.reason, 'feed-unavailable');
    assert.equal(report.requests[0].kind, 'feed'); assert.equal(report.requests[0].outcome, outcome);
    for (const [key, value] of Object.entries(expected)) assert.equal(report.requests[0][key], value);
    assert.doesNotMatch(JSON.stringify(report), /private|secret|message|csrf|https?:/);
  }
});

test('B站 failed image fetch diagnostics distinguish HTTP rejection and browser network restrictions', async () => {
  for (const [fetch, outcome] of [
    [async () => new Response('', { status: 403 }), 'http-error'],
    [async () => { throw new TypeError('private URL blocked by CORS'); }, 'network-error'],
  ]) {
    const { page, adapter } = reconcileFixture({ evaluateImages: async (callback, args) => runInNewContext(`(${callback.toString()})(args)`, {
      args, crypto: webcrypto, AbortController, setTimeout, clearTimeout, Uint8Array, Blob, atob, DataView, fetch,
    }) });
    assert.equal(await adapter.reconcilePublication(page, candidateInput, { attemptedAt }), undefined);
    const report = (await adapter.diagnostics(page)).reconcile;
    assert.equal(report.reason, 'image-unverified');
    assert.equal(report.requests.at(-1).outcome, outcome);
    assert.doesNotMatch(JSON.stringify(report), /private|URL|CORS/);
  }
});

test('B站 reconciliation image bytes use fixed public CDN GET without credentials or redirects', async () => {
  const requests = [];
  const { page, adapter } = reconcileFixture({ evaluateImages: async (callback, args) => runInNewContext(`(${callback.toString()})(args)`, {
    args, crypto: webcrypto, AbortController, setTimeout, clearTimeout, Uint8Array, Blob, atob,
    fetch: async (url, options) => { requests.push({ url, options }); return new Response(Buffer.from('hello')); },
    createImageBitmap: () => assert.fail('identical bytes need no decoding'),
  }) });
  assert.equal((await adapter.reconcilePublication(page, candidateInput, { attemptedAt })).id, originalReceipt.id);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, candidatePicture);
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.cache, 'no-store');
});

test('B站 image reconciliation never compares a single frame of unknown, GIF or APNG bytes', async () => {
  const pngChunk = (type, bytes = Buffer.alloc(0)) => { const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); return Buffer.concat([size, Buffer.from(type), bytes, Buffer.alloc(4)]); };
  const apng = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', Buffer.alloc(13)), pngChunk('acTL', Buffer.alloc(8)), pngChunk('IEND')]);
  for (const bytes of [Buffer.from('unknown'), Buffer.from('GIF89a'), apng]) {
    const input = { ...candidateInput, images: [`data:image/png;base64,${bytes.toString('base64')}`] };
    const { page, adapter } = reconcileFixture({ evaluateImages: async (callback, args) => runInNewContext(`(${callback.toString()})(args)`, {
      args, crypto: webcrypto, AbortController, setTimeout, clearTimeout, Uint8Array, Blob, atob, DataView,
      fetch: async () => new Response(Buffer.from('different bytes')),
      createImageBitmap: () => assert.fail('unverified static format must not be decoded'),
    }) });
    assert.equal(await adapter.reconcilePublication(page, input, { attemptedAt }), undefined);
  }
});

test('B站 static PNG pixel fallback requires equal dimensions and every decoded RGBA pixel', async () => {
  const chunk = (type, bytes = Buffer.alloc(0)) => { const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); return Buffer.concat([size, Buffer.from(type), bytes, Buffer.alloc(4)]); };
  const png = (marker) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', Buffer.alloc(13)), chunk('IDAT', Buffer.from([marker])), chunk('IEND')]);
  const original = png(1), actual = png(2);
  for (const mismatch of [false, 'pixel', 'dimensions']) {
    let decoded = 0, closed = 0;
    const input = { ...candidateInput, images: [`data:image/png;base64,${original.toString('base64')}`] };
    const { page, adapter } = reconcileFixture({ evaluateImages: async (callback, args) => runInNewContext(`(${callback.toString()})(args)`, {
      args, crypto: webcrypto, AbortController, setTimeout, clearTimeout, Uint8Array, Blob, atob, DataView,
      fetch: async () => new Response(actual),
      createImageBitmap: async () => { const index = decoded++; return { index, width: mismatch === 'dimensions' && index ? 2 : 1, height: 1, close: () => closed++ }; },
      OffscreenCanvas: class {
        getContext() { let bitmap; return { drawImage: (image) => { bitmap = image; }, getImageData: () => ({ data: new Uint8Array([mismatch === 'pixel' && bitmap.index ? 10 : 20, 30, 40, 255]) }) }; }
      },
    }) });
    const result = await adapter.reconcilePublication(page, input, { attemptedAt });
    assert.equal(result?.id, mismatch ? undefined : originalReceipt.id);
    assert.equal(decoded, 2); assert.equal(closed, 2);
  }
});

test('B站 reconciliation reads only fixed GET feed/detail endpoints and projects public post fields', async () => {
  const requests = [];
  const item = reconcileItem();
  item.csrf = 'private'; item.modules.module_dynamic.major.opus.summary.rich_text_nodes[0].secret = 'private';
  const { page, adapter } = reconcileFixture();
  const evaluate = page.evaluate;
  page.evaluate = async (callback, args) => {
    if (!args || args.originals) return evaluate(callback, args);
    return runInNewContext(`(${callback.toString()})(args)`, {
      args, AbortController, setTimeout, clearTimeout, URL, URLSearchParams,
      fetch: async (url, options) => {
        requests.push({ url: url.href, options });
        return { ok: true, json: async () => ({ code: 0, csrf: 'private', data: args.detailId ? { item } : { items: [item], has_more: false } }) };
      },
    });
  };
  assert.equal((await adapter.reconcilePublication(page, candidateInput, { attemptedAt })).id, originalReceipt.id);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://api.bilibili.com');
    assert.ok(['/x/polymer/web-dynamic/v1/feed/space', '/x/polymer/web-dynamic/v1/detail'].includes(url.pathname));
    assert.equal(request.options.method, 'GET'); assert.equal(request.options.credentials, 'include');
    assert.equal(request.options.cache, 'no-store'); assert.equal(request.options.redirect, 'error');
    assert.doesNotMatch(request.url, /csrf|private/);
  }
});

test('B站 diagnostics contain only body hash, counters, fixed flags and safe response metadata', async () => {
  const { page, vm, adapter } = fixture();
  await adapter.readAccount(page);
  vm.content.value = 'private-body'; vm.title = 'private-title';
  page.evaluate = async () => ['首次发布规范确认窗口'];
  page.emit('response', { ...makeResponse('{"code":0,"message":"private-token","data":{"dyn_id_str":"12345","csrf":"secret"}}', '/x/dynamic/feed/create/dyn?csrf=secret'), status: () => 200 });
  await new Promise((resolve) => setImmediate(resolve));
  const report = await adapter.diagnostics(page);
  assert.equal(report.editor.bodyLength, 12);
  assert.match(report.editor.bodyHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.dialogs, ['首次发布规范确认窗口']);
  assert.deepEqual(report.responseMetadata, [{ path: '/x/dynamic/feed/create/dyn', status: 200, code: 0, id: '12345' }]);
  assert.doesNotMatch(JSON.stringify(report), /private|csrf|secret|\?/);
});

test('B站 mutation target requires trusted original ID, URL and exact owner', () => {
  const input = { receipt: originalReceipt, expectedAccountUid: account.uid };
  assert.equal(bilibiliMutationTarget(input).id, originalReceipt.id);
  for (const change of [{ expectedAccountUid: '999' }, { receipt: { ...originalReceipt, url: 'https://evil.example/' } }, { receipt: { ...originalReceipt, url: 'https://t.bilibili.com/999' } }, { receipt: { ...originalReceipt, id: 'invalid' } }]) assert.throws(() => bilibiliMutationTarget({ ...input, ...change }), { code: 'PUBLISH_REJECTED' });
});

test('B站 mutation replies bind to exact edit/delete native POST target and preserve original receipt', () => {
  const target = bilibiliMutationTarget({ receipt: originalReceipt, expectedAccountUid: account.uid });
  for (const operation of ['update', 'delete']) {
    assert.equal(isBilibiliMutationResponse(mutationResponse(operation), operation, target.id), true);
    assert.equal(isBilibiliMutationResponse(mutationResponse(operation, '999'), operation, target.id), false);
    assert.equal(isBilibiliMutationResponse(mutationResponse(operation === 'update' ? 'delete' : 'update'), operation, target.id), false);
    assert.equal(isBilibiliMutationResponse(makeResponse(), operation, target.id), false);
    const receipt = confirmedBilibiliMutation('{"code":0,"data":{}}', operation, target, () => new Date('2026-09-15T01:00:00Z'));
    assert.equal(receipt.id, originalReceipt.id);
    assert.equal(receipt.url, originalReceipt.url);
    assert.equal(receipt.publishedAt, originalReceipt.publishedAt);
    assert.equal(receipt[operation === 'update' ? 'updatedAt' : 'deletedAt'], '2026-09-15T01:00:00.000Z');
    assert.throws(() => confirmedBilibiliMutation('{"code":0,"data":{"dyn_id_str":"999"}}', operation, target), { code: 'PUBLISH_UNCERTAIN' });
    assert.throws(() => confirmedBilibiliMutation('{"code":-101}', operation, target), { code: 'PUBLISH_REJECTED' });
    assert.throws(() => confirmedBilibiliMutation('{}', operation, target), { code: 'PUBLISH_UNCERTAIN' });
  }
});

test('B站 mutation waiter never accepts another post and cleans up a stalled body', async () => {
  const page = new EventEmitter();
  const watcher = waitForBilibiliMutation(page, 'delete', originalReceipt.id, 10);
  page.emit('response', mutationResponse('delete', '999'));
  page.emit('response', { ...mutationResponse('delete'), text: () => new Promise(() => {}) });
  await assert.rejects(watcher.promise, { code: 'PUBLISH_UNCERTAIN' });
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(page.listenerCount('close'), 0);
});

test('B站 identity requires official logged-in state and only returns public fields', () => {
  assert.deepEqual(bilibiliAccount({ ...state, csrf: 'never-return' }), { ...account, profileUrl: 'https://space.bilibili.com/12345', avatarUrl: state.face });
  for (const input of [null, { ...state, isLogin: false }, { ...state, mid: '0' }, { ...state, mid: 9e20 }, { ...state, uname: '' }]) assert.equal(bilibiliAccount(input), null);
  assert.equal(bilibiliAccount({ ...state, face: 'https://evil.example/avatar.jpg' }).avatarUrl, undefined);
  assert.equal(bilibiliAccount({ ...state, face: undefined }).avatarUrl, undefined);
});

function navPage(fetchResponse, timerOptions = {}) {
  const requests = [];
  const selected = [];
  const page = {
    isClosed: () => false,
    url: () => 'https://t.bilibili.com/',
    evaluate: async (callback) => {
      const result = await runInNewContext(`(${callback.toString()})()`, {
        AbortController, setTimeout, clearTimeout, ...timerOptions,
        // Deliberately stale bootstrap identity: the network result must win.
        window: { __BiliUser__: { isLogin: true, cache: { data: state } } },
        fetch: async (url, options) => { requests.push({ url, options }); return fetchResponse(options); },
      });
      selected.push(result);
      return result;
    },
  };
  return { page, requests, selected };
}

test('B站 reads current nav identity with credentials and no cache, ignoring stale boot account', async () => {
  const { page, requests, selected } = navPage(async () => ({ ok: true, json: async () => ({ code: 0, data: { ...state, mid: 999, uname: '新账号', csrf: 'private', wbi_img: { key: 'private' } } }) }));
  const actual = await createBilibiliAdapter().readAccount(page);
  assert.equal(actual.uid, '999');
  assert.equal(actual.name, '新账号');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.bilibili.com/x/web-interface/nav');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(requests[0].options.redirect, 'error');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(selected[0]).sort(), ['face', 'isLogin', 'mid', 'uname']);
});

test('B站 expired, blocked or unavailable nav responses never fall back to logged-in boot cache', async () => {
  const failures = [
    async () => ({ ok: true, json: async () => ({ code: -101, data: state }) }),
    async () => ({ ok: true, json: async () => ({ code: 0, data: { ...state, isLogin: false } }) }),
    async () => ({ ok: true, json: async () => ({ code: 0, data: { ...state, isLogin: 'true' } }) }),
    async () => ({ ok: false, json: async () => ({ code: 0, data: state }) }),
    async () => ({ ok: true, json: async () => { throw new Error('HTML challenge'); } }),
    async () => { throw new Error('network unavailable'); },
  ];
  for (const failure of failures) {
    const { page } = navPage(failure);
    assert.equal(await createBilibiliAdapter().readAccount(page), null);
  }
});

test('B站 current identity timeout aborts stalled response bodies and clears its timer', async () => {
  let expire, timeoutMs, cleared = false;
  const { page } = navPage(async ({ signal }) => ({
    ok: true,
    json: () => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      queueMicrotask(expire);
    }),
  }), {
    setTimeout: (callback, ms) => { expire = callback; timeoutMs = ms; return 1; },
    clearTimeout: (timer) => { assert.equal(timer, 1); cleared = true; },
  });
  assert.equal(await createBilibiliAdapter().readAccount(page), null);
  assert.equal(timeoutMs, 5_000);
  assert.equal(cleared, true);
});

test('B站 original dynamic text preserves title/body and never enters article conversion', () => {
  assert.equal(composeBilibiliText({ title: ' 标题 ', body: ' 原生动态\n#话题# ' }), '标题\n\n原生动态\n#话题#');
  assert.equal(composeBilibiliText({ body: '中'.repeat(1000) }).length, 1000);
  assert.equal(Array.from(composeBilibiliText({ body: '😀'.repeat(1000) })).length, 1000);
  for (const input of [{}, { body: ' ' }, { body: '\0' }, { body: 'x\u200by' }, { body: '中'.repeat(1001) }, { body: '😀'.repeat(1001) }]) assert.throws(() => composeBilibiliText(input), { code: 'PUBLISH_REJECTED' });
});

test('B站 uploads accept four PNG/JPEG/GIF images up to 3 MB each', () => {
  const image = 'data:image/png;base64,aGVsbG8=';
  assert.equal(bilibiliImageFiles(Array(4).fill(image)).length, 4);
  for (const input of [Array(5).fill(image), ['data:image/webp;base64,aGVsbG8='], ['data:image/png;base64,abc'], ['https://example.com/a.jpg'], [`data:image/png;base64,${Buffer.alloc(3 * 1024 * 1024 + 1).toString('base64')}`]]) assert.throws(() => bilibiliImageFiles(input), { code: 'IMAGE_UPLOAD_FAILED' });
});

test('B站 native response matching excludes comments, edits, check-only, and untrusted origins', () => {
  assert.equal(isBilibiliResponse(makeResponse(), '/x/dynamic/feed/create/dyn'), true);
  for (const response of [makeResponse('', '/x/dynamic/feed/edit/dyn'), makeResponse('', '/x/dynamic/feed/create/submit_check'), makeResponse('', '/x/v2/reply/add'), makeResponse('', '/x/dynamic/feed/create/dyn', 'GET'), makeResponse('', '/x/dynamic/feed/create/dyn', 'POST', 'https://api.bilibili.com.evil.example')]) assert.equal(isBilibiliResponse(response, '/x/dynamic/feed/create/dyn'), false);
});

test('B站 receipt requires code zero and exact dynamic ID, not a toast or numeric fallback', () => {
  assert.deepEqual(confirmedBilibiliPublication(responseBody, account, () => new Date('2026-09-14T00:00:00Z')), { id: '90071992547409939999', url: 'https://t.bilibili.com/90071992547409939999', publishedAt: '2026-09-14T00:00:00.000Z', account });
  for (const body of ['{}', 'not-json', '{"code":0,"data":{}}', '{"code":0,"data":{"dyn_id":12345}}', '{"code":0,"data":{"dyn_id_str":"12345","dyn_type":1}}', '{"code":0,"data":{"dyn_id_str":"12345","fake_card":{"extend":{"uid":"999"}}}}']) assert.throws(() => confirmedBilibiliPublication(body, account), { code: 'PUBLISH_UNCERTAIN' });
  assert.throws(() => confirmedBilibiliPublication('{"code":-101,"message":"sensitive details"}', account), { code: 'PUBLISH_REJECTED' });
});

test('B站 image success needs official upload response and all ordered successful native tiles', () => {
  const key = '/bfs/new_dyn/image123.png';
  assert.equal(bilibiliUploadedPicture(JSON.stringify({ code: 0, data: { image_url: 'https://i0.hdslb.com' + key, image_width: 100, image_height: 100 } })), key);
  assert.equal(bilibiliPictureKey('https://evil.example/bfs/new_dyn/image123.png'), undefined);
  assert.throws(() => bilibiliUploadedPicture('{"code":0,"data":{"image_url":"https://i0.hdslb.com/bfs/new_dyn/a.png"}}'), { code: 'IMAGE_UPLOAD_FAILED' });
  const editor = { count: 2, ready: 2, pictures: ['https://i0.hdslb.com' + key, 'https://i0.hdslb.com/bfs/new_dyn/second.png'] };
  assert.equal(bilibiliPicturesReady(editor, [key, '/bfs/new_dyn/second.png']), true);
  assert.equal(bilibiliPicturesReady(editor, ['/bfs/new_dyn/second.png', key]), false);
  assert.equal(bilibiliPicturesReady({ ...editor, failed: true }, [key, '/bfs/new_dyn/second.png']), false);
  assert.equal(bilibiliPicturesReady({ ...editor, ready: 1 }, [key, '/bfs/new_dyn/second.png']), false);
});

test('B站 receipt watcher times out even if body stalls and removes all listeners', async () => {
  const page = new EventEmitter();
  const watcher = waitForBilibiliPublication(page, 10);
  page.emit('response', { ...makeResponse(), text: () => new Promise(() => {}) });
  await assert.rejects(watcher.promise, { code: 'PUBLISH_UNCERTAIN' });
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(page.listenerCount('close'), 0);
});

test('B站 receipt watcher ignores submit-check then accepts one actual publication', async () => {
  const page = new EventEmitter();
  const watcher = waitForBilibiliPublication(page, 100);
  page.emit('response', makeResponse('{"code":0}', '/x/dynamic/feed/create/submit_check'));
  page.emit('response', makeResponse());
  assert.equal(await watcher.promise, responseBody);
  assert.equal(page.listenerCount('response'), 0);
});

function fixture() {
  const page = new EventEmitter();
  page.accountState = { ...state };
  page.events = [];
  const vm = { $options: { name: 'bili-dyn-publishing' }, content: { value: '' }, title: '', editInfo: { active: false }, timingSettingActive: false, topic: { id: 0 }, tools: { pic: { data: [] } }, onlyfansOption: { value: 0 }, visibleOption: { value: 0 } };
  const element = { __vue__: vm, querySelectorAll: () => [] };
  const zero = { count: async () => 0, first() { return this; }, waitFor: async () => {} };
  const input = { count: async () => 1, click: async () => {}, fill: async (text) => { vm.content.value = text; page.events.push('fill'); }, press: async (key) => { if (key === 'Backspace') { vm.content.value = ''; page.events.push('fill'); } else if (key === 'Enter') vm.content.value += '\n'; } };
  page.keyboard = { insertText: async (text) => { vm.content.value += text; } };
  const title = { count: async () => 1, fill: async (text) => { vm.title = text; } };
  const button = { count: async () => 1, filter() { return this; }, getAttribute: async () => 'bili-dyn-publishing__action launcher', isVisible: async () => true, click: async () => { page.events.push('submit'); page.emit('response', makeResponse()); } };
  const root = {
    count: async () => 1, first() { return this; }, waitFor: async () => {},
    evaluate: (callback) => callback(element),
    locator: (selector) => selector.startsWith('xpath') ? zero : selector.includes('[contenteditable') ? input : selector.includes('__action.launcher') ? button : selector.includes('__title__input') ? title : zero,
  };
  page.isClosed = () => false;
  page.url = () => 'https://t.bilibili.com/';
  page.evaluate = async () => page.accountState;
  page.locator = (selector) => selector === '.bili-dyn-publishing:visible' ? root : zero;
  return { page, vm, root, adapter: createBilibiliAdapter() };
}

function composerDraftFixture() {
  const f = fixture();
  f.vm.user = { mid: account.uid };
  f.vm.title = '原生未发标题'; f.vm.content.value = '原生未发正文';
  f.vm.tools.pic.data = [{ img_src: candidatePicture }, { img_src: 'https://i0.hdslb.com/bfs/new_dyn/second.png' }];
  f.uploader = { minAmount: 0 };
  const tile = { classList: { contains: (name) => name === 'success' }, querySelector: (selector) => selector === '.bili-pics-uploader-item-preview__pic' ? {} : null };
  f.root.evaluate = (callback, args) => callback({ __vue__: f.vm, querySelector: () => ({ __vue__: f.uploader }), querySelectorAll: () => f.vm.tools.pic.data.map(() => tile) }, args);
  const original = f.root.locator;
  f.root.locator = (selector) => selector === '.bili-pics-uploader__item' ? {
    count: async () => f.vm.tools.pic.data.length,
    nth: (index) => ({
      hover: async () => { f.onHover?.(); },
      locator: (selector) => { assert.equal(selector, '.bili-pics-uploader__item__remove'); return {
        count: async () => 1,
        click: async () => { f.page.events.push(`remove:${index}`); f.vm.tools.pic.data.splice(index, 1); f.onRemove?.(); },
      }; },
    }),
  } : original(selector);
  return f;
}

test('B站 composer review fingerprints actual UI and native clearing removes only the reviewed unpublished draft', async () => {
  const f = composerDraftFixture();
  const draft = await f.adapter.inspectComposerDraft(f.page);
  assert.equal(draft.title, '原生未发标题'); assert.equal(draft.body, '原生未发正文'); assert.equal(draft.imageCount, 2);
  assert.match(draft.fingerprint, /^[a-f0-9]{64}$/); assert.deepEqual(f.page.events, []);
  const cleared = await f.adapter.clearComposerDraft(f.page, { expectedAccountUid: account.uid, fingerprint: draft.fingerprint });
  assert.equal(cleared.title, ''); assert.equal(cleared.body, ''); assert.equal(cleared.imageCount, 0);
  assert.notEqual(cleared.fingerprint, draft.fingerprint);
  assert.deepEqual(f.page.events, ['remove:1', 'remove:0', 'fill']);
});

test('B站 composer clearing rejects changed account, text or images after review before any native action', async () => {
  for (const mutate of [
    (f) => { f.page.accountState.mid = 999; },
    (f) => { f.vm.content.value = 'changed'; },
    (f) => { f.vm.tools.pic.data[0].img_src = 'https://i0.hdslb.com/bfs/new_dyn/changed.png'; },
  ]) {
    const f = composerDraftFixture(); const draft = await f.adapter.inspectComposerDraft(f.page); mutate(f);
    await assert.rejects(f.adapter.clearComposerDraft(f.page, { expectedAccountUid: account.uid, fingerprint: draft.fingerprint }), (error) => ['DRAFT_CHANGED', 'ACCOUNT_CHANGED'].includes(error.code));
    assert.deepEqual(f.page.events, []);
  }
});

test('B站 composer clearing cannot act on edits, scheduled content, active uploads or minimum-image editors', async () => {
  for (const mutate of [
    (f) => { f.vm.editInfo.active = true; },
    (f) => { f.vm.editInfo.data = { id: originalReceipt.id }; },
    (f) => { f.vm.timingSettingActive = true; },
    (f) => { f.vm.loadingState = { publish: true }; },
    (f) => { f.vm.tools.pic.data[0].status = 'LOADING'; },
    (f) => { f.uploader.minAmount = 1; },
  ]) {
    const f = composerDraftFixture(); mutate(f);
    await assert.rejects(f.adapter.inspectComposerDraft(f.page), { code: 'DRAFT_CHANGED' });
    assert.deepEqual(f.page.events, []);
  }
});

test('B站 composer clearing rechecks after hover and stops after any partial-action drift', async () => {
  const before = composerDraftFixture(); const first = await before.adapter.inspectComposerDraft(before.page);
  before.onHover = () => { before.vm.content.value = 'changed during hover'; };
  await assert.rejects(before.adapter.clearComposerDraft(before.page, { expectedAccountUid: account.uid, fingerprint: first.fingerprint }), { code: 'DRAFT_CHANGED' });
  assert.deepEqual(before.page.events, []);
  const after = composerDraftFixture(); const second = await after.adapter.inspectComposerDraft(after.page);
  after.onRemove = () => { after.vm.content.value = 'changed after one image removal'; };
  await assert.rejects(after.adapter.clearComposerDraft(after.page, { expectedAccountUid: account.uid, fingerprint: second.fingerprint }), { code: 'DRAFT_CLEAR_FAILED' });
  assert.deepEqual(after.page.events, ['remove:1']);
});

test('B站 native click follows durable checkpoint and exact account verification', async () => {
  const { page, adapter } = fixture();
  const receipt = await adapter.publish(page, { title: '标题', body: '动态', images: [], expectedAccountUid: account.uid }, { beforeSubmit: async () => page.events.push('checkpoint') });
  assert.equal(receipt.id, '90071992547409939999');
  assert.deepEqual(page.events, ['fill', 'checkpoint', 'submit']);
});

test('B站 login loss, wrong account and pre-existing attachments stop before checkpoint', async () => {
  for (const scenario of ['logged-out', 'different-account', 'editing', 'scheduled', 'attachment']) {
    const { page, vm, adapter } = fixture();
    if (scenario === 'logged-out') page.accountState.isLogin = false;
    if (scenario === 'different-account') page.accountState.mid = 999;
    if (scenario === 'editing') vm.editInfo.active = true;
    if (scenario === 'scheduled') vm.timingSettingActive = true;
    if (scenario === 'attachment') vm.attachment = { id: 1 };
    await assert.rejects(adapter.publish(page, { body: '动态', images: [], expectedAccountUid: account.uid }, { beforeSubmit: async () => assert.fail('must not checkpoint') }));
    assert.equal(page.events.includes('submit'), false);
  }
});

test('B站 account or text mutation at durable checkpoint freezes publication without a click', async () => {
  for (const mutate of [(page) => { page.accountState.mid = 999; }, (_, vm) => { vm.content.value = 'changed'; }]) {
    const { page, vm, adapter } = fixture();
    await assert.rejects(adapter.publish(page, { body: '动态', images: [], expectedAccountUid: account.uid }, { beforeSubmit: async () => mutate(page, vm) }), { code: 'PUBLISH_UNCERTAIN' });
    assert.equal(page.events.includes('submit'), false);
  }
});

test('B站 rechecks body and images after the final identity network wait and never clicks changed content', async () => {
  for (const mutate of [(vm) => { vm.content.value = 'changed during nav'; }, (vm) => { vm.tools.pic.data.push({ img_src: 'https://i0.hdslb.com/bfs/new_dyn/unexpected.png' }); }]) {
    const { page, vm, adapter } = fixture();
    let checks = 0;
    page.evaluate = async () => {
      checks++;
      await Promise.resolve();
      if (checks === 3) mutate(vm);
      return page.accountState;
    };
    await assert.rejects(adapter.publish(page, { body: '动态', images: [], expectedAccountUid: account.uid }, { beforeSubmit: async () => page.events.push('checkpoint') }), { code: 'PUBLISH_UNCERTAIN' });
    assert.equal(checks, 3);
    assert.deepEqual(page.events, ['fill', 'checkpoint']);
  }
});

test('B站 stricter native length validation cannot enter article conversion or submit', async () => {
  const { page, vm, adapter } = fixture();
  vm.hint = { heedful: true };
  await assert.rejects(adapter.publish(page, { body: '😀'.repeat(1000), images: [], expectedAccountUid: account.uid }, { beforeSubmit: async () => assert.fail('must not checkpoint') }), { code: 'PUBLISH_REJECTED' });
  assert.equal(page.events.includes('submit'), false);
});

test('B站 editor snapshot returns no arbitrary Vue state and requires original composer component', async () => {
  const { vm, root } = fixture();
  vm.sessionToken = 'do-not-return';
  assert.equal(Object.hasOwn(await bilibiliEditorState(root), 'sessionToken'), false);
  vm.$options.name = 'bili-dyn-forward-publishing';
  assert.equal(await bilibiliEditorState(root), null);
});

function mutationFixture(operation = 'update') {
  const { page, vm, adapter, root: composer } = fixture();
  let url = 'https://t.bilibili.com/', dialogOpen = false;
  const events = [];
  const imageUrl = 'https://i0.hdslb.com/bfs/new_dyn/original.png';
  const data = { id_str: originalReceipt.id, type: 'DYNAMIC_TYPE_DRAW', basic: { editable: true }, modules: { module_author: { mid: Number(account.uid) }, module_dynamic: { major: { opus: { pics: [] } } } } };
  const action = { value: operation === 'update' ? 'THREE_POINT_EDIT' : 'THREE_POINT_DELETE', label: operation === 'update' ? '编辑动态' : '删除', modal: undefined };
  const native = { $options: { name: 'dyn-item' }, data, more: { list: [action] } };
  const originalElement = { __vue__: native, classList: { contains: (name) => name === 'bili-dyn-item' } };
  const zero = { count: async () => 0 };
  const actionItem = {
    count: async () => 1, filter() { return this; },
    locator: () => ({ innerText: async () => action.label }),
    click: async () => { events.push('menu'); if (operation === 'delete') dialogOpen = true; },
  };
  const original = {
    evaluate: (callback) => callback(originalElement),
    locator: (selector) => selector.includes('__btn') ? { count: async () => 1, hover: async () => events.push('hover') } : actionItem,
  };
  const roots = { first() { return this; }, waitFor: async () => {}, count: async () => 1, nth: () => original };
  const oldComposerLocator = composer.locator;
  const launcher = { count: async () => 1, filter() { return this; }, click: async () => { events.push('launcher'); dialogOpen = true; } };
  composer.locator = (selector) => selector.includes('__action.launcher') ? launcher : oldComposerLocator(selector);
  vm.editInfo = { active: true, data: { id: originalReceipt.id, forward: false }, config: { toast: '' } };
  vm.user = { mid: Number(account.uid) };
  vm.content.value = '原文';
  let response = mutationResponse(operation);
  const confirm = {
    count: async () => 1,
    innerText: async () => operation === 'update' ? '确认修改' : action.modal?.confirm || '删除',
    click: async () => { events.push('confirm'); page.emit('response', response); },
  };
  const dialog = {
    count: async () => dialogOpen ? 1 : 0, first() { return this; }, waitFor: async () => {},
    locator: (selector) => selector.includes('__title') ? { innerText: async () => operation === 'update' ? '确认修改' : action.modal?.title || '删除动态' }
      : selector.includes('__content') ? { innerText: async () => operation === 'update' ? vm.editInfo.config.toast || '是否确认发布编辑内容？' : action.modal?.content || '确定要删除此条动态吗？' } : confirm,
  };
  page.url = () => url;
  page.goto = async (value) => { url = value; events.push('navigate'); };
  page.locator = (selector) => selector.startsWith('.bili-dyn-item:visible') ? roots
    : selector === '.bili-modal[role="dialog"]:visible' ? dialog
      : selector === '.bili-dyn-edit .bili-dyn-publishing:visible' ? composer : zero;
  let navCalls = 0;
  page.evaluate = async () => { navCalls++; events.push('identity'); return page.accountState; };
  const withPicture = () => {
    data.modules.module_dynamic.major.opus.pics = [{ url: imageUrl }];
    vm.tools.pic.data = [{ img_src: imageUrl }];
    composer.evaluate = (callback) => callback({ __vue__: vm, querySelectorAll: () => [{ classList: { contains: (name) => name === 'success' }, querySelector: (selector) => selector === '.bili-pics-uploader-item-preview__pic' ? {} : null }] });
  };
  return { page, vm, adapter, data, native, action, events, original, composer, withPicture, setResponse: (value) => { response = value; }, navCalls: () => navCalls };
}

test('B站 native original-post update preserves picture and ID, then confirms only after durable checkpoint', async () => {
  const f = mutationFixture('update');
  f.withPicture();
  const receipt = await f.adapter.update(f.page, { receipt: originalReceipt, expectedAccountUid: account.uid, title: '新标题', body: '新正文' }, { beforeSubmit: async () => f.events.push('checkpoint') });
  assert.equal(receipt.id, originalReceipt.id);
  assert.equal(receipt.url, originalReceipt.url);
  assert.ok(receipt.updatedAt);
  assert.deepEqual(f.vm.tools.pic.data.map((picture) => picture.img_src), ['https://i0.hdslb.com/bfs/new_dyn/original.png']);
  assert.equal(f.vm.content.value, '新标题\n\n新正文');
  assert.equal(f.events.filter((event) => event === 'launcher').length, 1);
  assert.equal(f.events.filter((event) => event === 'confirm').length, 1);
  assert.ok(f.events.indexOf('checkpoint') < f.events.indexOf('launcher'));
  assert.ok(f.events.lastIndexOf('identity') > f.events.indexOf('launcher'));
});

test('B站 native original-post delete binds author and confirms once after checkpoint', async () => {
  const f = mutationFixture('delete');
  const receipt = await f.adapter.delete(f.page, { receipt: originalReceipt, expectedAccountUid: account.uid }, { beforeSubmit: async () => f.events.push('checkpoint') });
  assert.equal(receipt.id, originalReceipt.id);
  assert.ok(receipt.deletedAt);
  assert.equal(f.events.filter((event) => event === 'confirm').length, 1);
  assert.ok(f.events.indexOf('checkpoint') < f.events.indexOf('menu'));
  assert.ok(f.events.lastIndexOf('identity') > f.events.indexOf('menu'));
});

test('B站 unavailable original editor, external editor link and author mismatch never submit', async () => {
  for (const scenario of ['not-editable', 'external-editor', 'wrong-author', 'missing-action']) {
    const f = mutationFixture('update');
    if (scenario === 'not-editable') f.data.basic.editable = false;
    if (scenario === 'external-editor') f.action.jump_url = 'https://member.bilibili.com/article/edit';
    if (scenario === 'wrong-author') f.data.modules.module_author.mid = 999;
    if (scenario === 'missing-action') f.native.more.list = [];
    await assert.rejects(f.adapter.update(f.page, { receipt: originalReceipt, expectedAccountUid: account.uid, body: '新正文' }, { beforeSubmit: async () => assert.fail('must not checkpoint') }), { code: scenario === 'wrong-author' ? 'ACCOUNT_CHANGED' : 'OPERATION_UNSUPPORTED' });
    assert.equal(f.events.includes('launcher'), false);
    assert.equal(f.events.includes('confirm'), false);
  }
});

test('B站 account/content changes after durable mutation checkpoint never reach final confirmation', async () => {
  for (const operation of ['update', 'delete']) {
    const f = mutationFixture(operation);
    await assert.rejects(f.adapter[operation](f.page, { receipt: originalReceipt, expectedAccountUid: account.uid, body: '新正文' }, { beforeSubmit: async () => { f.page.accountState.mid = 999; } }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
    assert.equal(f.events.includes('confirm'), false);
  }
  const f = mutationFixture('update');
  f.withPicture();
  await assert.rejects(f.adapter.update(f.page, { receipt: originalReceipt, expectedAccountUid: account.uid, body: '新正文' }, { beforeSubmit: async () => { f.vm.tools.pic.data = []; } }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
  assert.equal(f.events.includes('confirm'), false);
});

test('B站 rereads edited text after final live identity wait before confirming update', async () => {
  const f = mutationFixture('update');
  let nav = 0;
  f.page.evaluate = async () => {
    nav++;
    await Promise.resolve();
    if (nav === 5) f.vm.content.value = 'changed while checking current account';
    return f.page.accountState;
  };
  await assert.rejects(f.adapter.update(f.page, { receipt: originalReceipt, expectedAccountUid: account.uid, body: '新正文' }, { beforeSubmit: async () => {} }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
  assert.equal(f.events.includes('launcher'), true);
  assert.equal(f.events.includes('confirm'), false);
});

test('B站 provider rejects mutation without reporting local success', async () => {
  const f = mutationFixture('delete');
  f.setResponse(mutationResponse('delete', originalReceipt.id, '{"code":-101}'));
  await assert.rejects(f.adapter.delete(f.page, { receipt: originalReceipt, expectedAccountUid: account.uid }, { beforeSubmit: async () => {} }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
  assert.equal(f.events.filter((event) => event === 'confirm').length, 1);
});

test('B站 opus public snapshot supports unnamed root and exact author/picture metadata', async () => {
  const item = { url: 'https://i0.hdslb.com/bfs/new_dyn/preserved.png' };
  const data = { id_str: originalReceipt.id, basic: { uid: Number(account.uid), editable: true }, modules: [
    { module_type: 'MODULE_TYPE_AUTHOR', module_author: { mid: Number(account.uid) } },
    { module_type: 'MODULE_TYPE_CONTENT', module_content: { paragraphs: [{ para_type: 2, pic: { pics: [item] } }] } },
  ] };
  const element = { __vue__: { $props: { data } }, classList: { contains: (value) => value === 'bili-opus-view-wrap' }, querySelector: () => ({ __vue__: { options: [{ value: 'THREE_POINT_EDIT', label: '编辑动态' }] } }) };
  const result = await bilibiliPublishedState({ evaluate: (callback) => callback(element) });
  assert.equal(result.id, originalReceipt.id);
  assert.equal(result.kind, 'opus');
  assert.deepEqual(result.pictures, [item.url]);
  data.modules[1].module_content.paragraphs.unshift({ para_type: 2, pic: { pics: [{ url: 'https://i0.hdslb.com/bfs/new_dyn/another.png' }] } });
  assert.equal((await bilibiliPublishedState({ evaluate: (callback) => callback(element) })).unsupportedMedia, true);
  data.basic.uid = 999;
  assert.equal(await bilibiliPublishedState({ evaluate: (callback) => callback(element) }), null);
});

// Real isolated Chrome verifies DOM scoping and detached native file chooser.
// Every request is intercepted; it never contacts B站 or publishes a real post.
test('B站 isolated DOM fixture publishes two images once after checkpoint', { skip: process.env.FATIAO_BILIBILI_DOM_TEST !== '1', timeout: 60_000 }, async (t) => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const events = [];
  let uploaded = 0, identityChecks = 0, submitted;
  const html = `<!doctype html><meta charset="utf-8"><style>[contenteditable]{min-height:60px;white-space:pre-wrap}.pic,.launcher,.bili-pics-uploader-item-preview__pic{display:block;width:100px;height:30px}</style>
    <button id="comment">发布</button>
    <div class="bili-dyn-publishing"><input class="bili-dyn-publishing__title__input">
      <div class="bili-dyn-publishing__input"><div contenteditable="true" placeholder="有什么想和大家分享的？"></div></div>
      <div class="bili-dyn-publishing__tools__item pic">图片</div><div class="pics"></div>
      <div class="bili-dyn-publishing__action launcher">发布</div></div>
    <script>
      window.__BiliUser__={isLogin:true,cache:{data:${JSON.stringify(state)}}};
      const root=document.querySelector('.bili-dyn-publishing');
      const vm=root.__vue__={$options:{name:'bili-dyn-publishing'},content:{value:''},title:'',editInfo:{active:false},timingSettingActive:false,topic:{id:0},tools:{pic:{data:[]}}};
      root.querySelector('input').oninput=e=>vm.title=e.target.value;
      root.querySelector('[contenteditable]').oninput=e=>{vm.content.value=e.target.innerText;};
      const input=document.createElement('input');input.type='file';input.multiple=true;
      input.onchange=async e=>{for(const file of e.target.files){const tile=document.createElement('div');tile.className='bili-pics-uploader__item loading';root.querySelector('.pics').append(tile);const result=await(await fetch('https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs',{method:'POST',body:file})).json();vm.tools.pic.data.push({img_src:result.data.image_url});tile.className='bili-pics-uploader__item success';tile.innerHTML='<div class="bili-pics-uploader-item-preview__pic"></div>';tile.firstChild.style.backgroundImage='url('+URL.createObjectURL(file)+')';}};
      root.querySelector('.pic').onclick=()=>input.click();
      root.querySelector('.launcher').onclick=()=>fetch('https://api.bilibili.com/x/dynamic/feed/create/dyn',{method:'POST',body:JSON.stringify({body:vm.content.value,pictures:vm.tools.pic.data})});
      document.querySelector('#comment').onclick=()=>{throw new Error('wrong publish button')};
    </script>`;
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.origin === 'https://t.bilibili.com' && url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.origin === 'https://api.bilibili.com' && url.pathname === '/x/web-interface/nav' && req.method() === 'GET') {
      identityChecks++;
      return route.fulfill({ headers: { 'Access-Control-Allow-Origin': 'https://t.bilibili.com', 'Access-Control-Allow-Credentials': 'true' }, contentType: 'application/json', body: JSON.stringify({ code: 0, data: state }) });
    }
    if (url.pathname === '/x/dynamic/feed/draw/upload_bfs') {
      events.push('upload'); uploaded++;
      return route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { image_url: `https://i0.hdslb.com/bfs/new_dyn/image${uploaded}.png`, image_width: 20, image_height: 20 } }) });
    }
    if (url.pathname === '/x/dynamic/feed/create/dyn') {
      events.push('submit'); submitted = JSON.parse(req.postData());
      return route.fulfill({ headers, contentType: 'application/json', body: responseBody });
    }
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto('https://t.bilibili.com/');
  const adapter = createBilibiliAdapter();
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const receipt = await adapter.publish(page, { body: '原生动态', images: [image, image], expectedAccountUid: account.uid }, { beforeSubmit: async () => events.push('checkpoint') }).catch(async (error) => {
    console.error('Fixture state:', await bilibiliEditorState(page.locator('.bili-dyn-publishing')), await page.locator('[contenteditable]').innerHTML());
    throw error;
  });
  assert.equal(receipt.id, '90071992547409939999');
  assert.equal(submitted.body, '原生动态');
  assert.equal(submitted.pictures.length, 2);
  assert.equal(identityChecks, 4);
  assert.deepEqual(events, ['upload', 'upload', 'checkpoint', 'submit']);
});
