import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { ContentItem, PlatformId, PlatformPublication } from './model.ts';
import type { PlatformAccountState } from './platforms.ts';
import {
  PlatformRequestError, closePlatform, composePlatformText, disconnectPlatform,
  getPlatformAccount, getPlatformReceipts, hasBoundPlatformAccount, isPlatformAccountVerified, loginPlatform, openPlatform,
  platformResumeBlockReason, preparePlatformContent, preparePlatformReview, publishPlatform,
  refreshPlatform, requireConnectedPlatformAccount, requireReadyPlatformAccount, resumePlatform, validatePlatformPublish,
  getPlatformComposerDraft, clearPlatformComposerDraft,
  updatePlatformPublication, deletePlatformPublication, getContentDeletionStatus, validatePlatformUpdate,
} from './platforms.ts';

const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aScsAAAAASUVORK5CYII=', 'base64');
const png = `data:image/png;base64,${pngBytes.toString('base64')}`;
const mediaRef = (bytes: Uint8Array, extension = 'png') => `/api/media/${createHash('sha256').update(bytes).digest('hex')}.${extension}`;
const item = (platform: PlatformId = 'weibo', updates: Partial<ContentItem> = {}): ContentItem => ({
  id: 'draft-test', title: '生活记录', body: '#日常#\n正文', image: png, images: [png],
  platforms: [platform], status: 'draft', updatedAt: '2026-09-14T00:00:00.000Z', category: '日常', ...updates,
});
const account: PlatformAccountState = { mode: 'browser', connected: true, browserOpen: true, headless: true, publishReady: true, account: { uid: '123456', name: '测试用户', profileUrl: 'https://weibo.com/u/123456' } };

test('platform validation supports multiline text and checks selection without requiring exclusivity', () => {
  assert.equal(composePlatformText(' 标题 ', '\n#日常#\n正文 '), '标题\n\n#日常#\n正文');
  assert.deepEqual(validatePlatformPublish('weibo', item('weibo', { platforms: ['weibo', 'bilibili'] })), []);
  assert.match(validatePlatformPublish('douyin', item()).join(' '), /请先选择抖音图文/);
});

test('image notes need images, and Xiaohongshu counts up to 20 Unicode code points', () => {
  for (const platform of ['xiaohongshu', 'douyin'] as const) {
    assert.match(validatePlatformPublish(platform, item(platform, { images: [] })).join(' '), /至少一张/);
  }
  assert.match(validatePlatformPublish('xiaohongshu', item('xiaohongshu', { title: '' })).join(' '), /笔记标题/);
  assert.deepEqual(validatePlatformPublish('xiaohongshu', item('xiaohongshu', { title: '🌷'.repeat(20) })), []);
  assert.match(validatePlatformPublish('xiaohongshu', item('xiaohongshu', { title: '🌷'.repeat(20) + '字' })).join(' '), /最多 20/);
});

test('the console requires text for Weibo and Bilibili, and all platforms cap images', () => {
  assert.match(validatePlatformPublish('weibo', item('weibo', { title: '', body: '' })).join(' '), /标题或正文/);
  assert.match(validatePlatformPublish('bilibili', item('bilibili', { title: '', body: '' })).join(' '), /标题或正文/);
  assert.match(validatePlatformPublish('bilibili', item('bilibili', { title: '', body: '', images: [] })).join(' '), /标题或正文/);
  assert.match(validatePlatformPublish('weibo', item('weibo', { images: Array(5).fill(png) })).join(' '), /最多添加 4/);
});

test('Xiaohongshu and Douyin body and combined Bilibili text follow 1000 Unicode code point limits', () => {
  for (const platform of ['xiaohongshu', 'douyin'] as const) {
    assert.deepEqual(validatePlatformPublish(platform, item(platform, { body: '  ' + '🌷'.repeat(1000) + '  ' })), []);
    assert.match(validatePlatformPublish(platform, item(platform, { body: '🌷'.repeat(1000) + '字' })).join(' '), /正文最多 1000/);
  }
  assert.deepEqual(validatePlatformPublish('bilibili', item('bilibili', { title: '标题', body: '🌷'.repeat(996) })), []);
  assert.match(validatePlatformPublish('bilibili', item('bilibili', { title: '标题', body: '🌷'.repeat(996) + '字' })).join(' '), /合计最多 1000/);
});

test('Douyin requires a title and counts up to 30 Unicode code points', () => {
  assert.match(validatePlatformPublish('douyin', item('douyin', { title: ' ' })).join(' '), /需要填写标题/);
  assert.deepEqual(validatePlatformPublish('douyin', item('douyin', { title: '  ' + '🌷'.repeat(30) + '  ' })), []);
  assert.match(validatePlatformPublish('douyin', item('douyin', { title: '🌷'.repeat(30) + '字' })).join(' '), /最多 30/);
});

test('account and session operations use platform endpoints with QR and window login modes', async (t) => {
  const calls: { url: string; options?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    return Response.json(account);
  });
  assert.deepEqual(await getPlatformAccount('weibo'), account);
  await loginPlatform('xiaohongshu');
  await loginPlatform('douyin', 'window');
  await openPlatform('bilibili');
  await refreshPlatform('weibo');
  await closePlatform('weibo');
  await disconnectPlatform('weibo');
  await getPlatformReceipts('bilibili');
  assert.deepEqual(calls.map(({ url }) => url), [
    '/api/platforms/weibo/account', '/api/platforms/xiaohongshu/login', '/api/platforms/douyin/login',
    '/api/platforms/bilibili/open', '/api/platforms/weibo/refresh', '/api/platforms/weibo/close',
    '/api/platforms/weibo/disconnect', '/api/platforms/bilibili/receipts',
  ]);
  assert.equal(calls[1].options?.body, '{"mode":"qr"}');
  assert.equal(calls[2].options?.body, '{"mode":"window"}');
  for (const { options } of calls.slice(1, 7)) {
    assert.equal(options?.method, 'POST');
    assert.equal(options?.credentials, 'same-origin');
    assert.equal((options?.headers as Record<string, string>)['X-Fatiao-Request'], '1');
  }
});

test('resume uses its own mutation endpoint and preserves the fresh account response', async (t) => {
  const calls: { url: string; options?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    return Response.json(account);
  });
  assert.deepEqual(await resumePlatform('weibo'), account);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/platforms/weibo/resume');
  assert.equal(calls[0].options?.method, 'POST');
  assert.equal(calls[0].options?.body, '{}');
  assert.equal(calls[0].options?.credentials, 'same-origin');
  assert.equal((calls[0].options?.headers as Record<string, string>)['X-Fatiao-Request'], '1');
});

test('a missing resume route reports an outdated local service without login or publish fallback', async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    calls.push(String(url));
    return Response.json({ error: { code: 'NOT_FOUND', message: '未找到这个接口' } }, { status: 404 });
  });
  for (const platform of ['weibo', 'xiaohongshu', 'douyin', 'bilibili'] as const) {
    await assert.rejects(resumePlatform(platform), {
      code: 'SERVER_RESTART_REQUIRED', submitted: false,
      message: '本地服务版本尚未更新，请重启本地服务后重试；本次内容尚未发送。',
    });
  }
  assert.deepEqual(calls, [
    '/api/platforms/weibo/resume', '/api/platforms/xiaohongshu/resume',
    '/api/platforms/douyin/resume', '/api/platforms/bilibili/resume',
  ]);
});

test('other missing resources, routes and non-404 errors retain their original meaning', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'ACCOUNT_NOT_FOUND', message: '账号不存在', submitted: false } }, { status: 404 }));
  await assert.rejects(resumePlatform('weibo'), { code: 'ACCOUNT_NOT_FOUND', message: '账号不存在', submitted: false });
  fetchMock.mock.mockImplementation(async () => Response.json({ error: { code: 'NOT_FOUND', message: '账号查询接口不存在' } }, { status: 404 }));
  await assert.rejects(getPlatformAccount('weibo'), { code: 'NOT_FOUND', message: '账号查询接口不存在', submitted: undefined });
  fetchMock.mock.mockImplementation(async () => Response.json({ error: { code: 'NOT_FOUND', message: '服务处理错误' } }, { status: 500 }));
  await assert.rejects(resumePlatform('weibo'), { code: 'NOT_FOUND', message: '服务处理错误', submitted: undefined });
  assert.equal(fetchMock.mock.callCount(), 3);
});

test('resume gate allows a closed saved session and connected accounts whose publisher needs another attempt', () => {
  const publication: PlatformPublication = { requestId: 'request-id', state: 'uncertain', expectedAccountUid: '123456' };
  const closed: PlatformAccountState = { mode: 'browser', connected: false, browserOpen: false, publishReady: false, sessionSaved: true };
  assert.equal(platformResumeBlockReason('weibo', closed), '');
  assert.equal(platformResumeBlockReason('weibo', closed, publication), '');
  assert.equal(platformResumeBlockReason('weibo', { ...account, publishReady: false }, publication), '');
  assert.equal(platformResumeBlockReason('weibo', account, publication), '');
});

test('resume gate blocks new or expired logins, missing old account IDs, published records and known account changes', () => {
  const disconnected: PlatformAccountState = { mode: 'browser', connected: false, browserOpen: false, publishReady: false };
  const publication: PlatformPublication = { requestId: 'request-id', state: 'uncertain', expectedAccountUid: '123456' };
  assert.match(platformResumeBlockReason('weibo'), /正在读取/);
  assert.match(platformResumeBlockReason('weibo', null), /正在读取/);
  assert.match(platformResumeBlockReason('weibo', disconnected), /请先登录微博/);
  assert.match(platformResumeBlockReason('weibo', { ...disconnected, browserOpen: true, sessionSaved: true }), /登录或验证/);
  assert.equal(platformResumeBlockReason('weibo', { ...disconnected, sessionSaved: true, login: { kind: 'qr' }, message: '扫码已过期' }), '扫码已过期');
  assert.match(platformResumeBlockReason('weibo', account, { ...publication, state: 'published' }), /已发布/);
  assert.match(platformResumeBlockReason('weibo', account, { ...publication, expectedAccountUid: undefined }), /缺少原账号/);
  assert.match(platformResumeBlockReason('weibo', account, { ...publication, expectedAccountUid: ' ' }), /缺少原账号/);
  assert.match(platformResumeBlockReason('weibo', account, { ...publication, expectedAccountUid: 'another-account' }), /与原发布账号不同/);
});

test('read-only account verification allows unavailable publishers on all platforms', () => {
  for (const platform of ['xiaohongshu', 'douyin', 'weibo', 'bilibili'] as const) {
    const unready = { ...account, publishReady: false };
    assert.deepEqual(requireConnectedPlatformAccount(platform, unready, account.account!.uid), account.account);
    assert.throws(() => requireReadyPlatformAccount(platform, unready, account.account!.uid), { code: 'PUBLISH_NOT_READY', submitted: false });
  }
});

test('closed shared Chrome bindings can resume but cannot authorize publishing or result checks', () => {
  const closed: PlatformAccountState = {
    ...account, browserMode: 'current-chrome', connected: false, browserOpen: false,
    sessionSaved: true, publishReady: false, accountVerification: 'required',
  };
  for (const platform of ['xiaohongshu', 'douyin', 'weibo', 'bilibili'] as const) {
    assert.equal(hasBoundPlatformAccount(closed), true);
    assert.equal(isPlatformAccountVerified(closed), false);
    assert.equal(platformResumeBlockReason(platform, closed), '');
    assert.throws(() => requireConnectedPlatformAccount(platform, closed, account.account!.uid), { code: 'LOGIN_REQUIRED', submitted: false });
    assert.throws(() => requireReadyPlatformAccount(platform, closed, account.account!.uid), { code: 'LOGIN_REQUIRED', submitted: false });
    for (const snapshot of [
      { ...closed, connected: true, browserOpen: true, publishReady: true },
      { ...closed, connected: true, browserOpen: true, accountVerification: undefined },
      { ...closed, connected: true, accountVerification: 'verified' as const },
    ]) {
      assert.equal(isPlatformAccountVerified(snapshot), false);
      assert.throws(() => requireConnectedPlatformAccount(platform, snapshot), { code: 'LOGIN_REQUIRED', submitted: false });
    }
    const fresh: PlatformAccountState = { ...closed, connected: true, browserOpen: true, publishReady: true, accountVerification: 'verified' };
    assert.equal(isPlatformAccountVerified(fresh), true);
    assert.deepEqual(requireReadyPlatformAccount(platform, fresh, account.account!.uid), account.account);
    assert.throws(() => requireConnectedPlatformAccount(platform, fresh, 'another-account'), { code: 'ACCOUNT_CHANGED', submitted: false });
  }
  assert.equal(hasBoundPlatformAccount({ ...closed, account: undefined, sessionSaved: false }), false);
});

test('read-only account verification still rejects missing sessions and different original accounts', () => {
  for (const state of [undefined, null, { ...account, connected: false }, { ...account, account: undefined }, { ...account, account: { ...account.account!, uid: ' ' } }]) {
    assert.throws(() => requireConnectedPlatformAccount('weibo', state, '123456'), { code: 'LOGIN_REQUIRED', submitted: false });
  }
  assert.throws(() => requireConnectedPlatformAccount('weibo', { ...account, publishReady: false }, 'other-uid'), { code: 'ACCOUNT_CHANGED', submitted: false });
});

test('fresh readiness verification rejects expired sessions, account changes and unready publishers without submission', () => {
  assert.deepEqual(requireReadyPlatformAccount('weibo', account, '123456'), account.account);
  assert.deepEqual(requireReadyPlatformAccount('weibo', account), account.account);
  assert.throws(() => requireReadyPlatformAccount('weibo', undefined), { code: 'LOGIN_REQUIRED', submitted: false });
  assert.throws(() => requireReadyPlatformAccount('weibo', { ...account, connected: false }), { code: 'LOGIN_REQUIRED', submitted: false });
  assert.throws(() => requireReadyPlatformAccount('weibo', { ...account, account: undefined }), { code: 'LOGIN_REQUIRED', submitted: false });
  assert.throws(() => requireReadyPlatformAccount('weibo', account, 'another-account'), { code: 'ACCOUNT_CHANGED', submitted: false });
  assert.throws(() => requireReadyPlatformAccount('weibo', { ...account, publishReady: false }), { code: 'PUBLISH_NOT_READY', submitted: false });
  assert.throws(() => requireReadyPlatformAccount('weibo', { ...account, connected: false, browserOpen: false, sessionSaved: true }), { code: 'LOGIN_REQUIRED', submitted: false });
});

test('preparation downloads media without credentials and returns an independent stable payload', async (t) => {
  const calls: { url: string; options?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    return new Response(pngBytes, { headers: { 'Content-Type': 'image/png' } });
  });
  const original = item('weibo', { images: ['https://images.example/photo.png', png], image: 'https://images.example/photo.png' });
  const prepared = await preparePlatformContent(original);
  assert.notEqual(prepared, original);
  assert.deepEqual(prepared.images, [png, png]);
  assert.equal(prepared.image, png);
  assert.equal(original.images[0], 'https://images.example/photo.png');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options?.credentials, 'omit');
  assert.ok(calls[0].options?.signal instanceof AbortSignal);
});

test('preparation resolves canonical local media into the exact reviewed bytes', async t => {
  const reference = mediaRef(pngBytes);
  const calls: { url: string; options?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    return new Response(pngBytes, { headers: { 'Content-Type': 'image/png' } });
  });
  const original = item('weibo', { image: reference, images: [reference, png] });
  const prepared = await preparePlatformReview('weibo', original);
  assert.deepEqual(prepared.images, [png, png]);
  assert.equal(prepared.image, png);
  assert.deepEqual(original.images, [reference, png]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, reference);
  assert.equal(calls[0].options?.credentials, 'same-origin');
  assert.equal(calls[0].options?.redirect, 'error');
  assert.ok(calls[0].options?.signal instanceof AbortSignal);
});

test('local references hydrate the exact pending publish snapshot for publish and reconciliation', async t => {
  const reference = mediaRef(pngBytes);
  const receipt = { id: '123456789', platform: 'weibo', requestId: 'request-id', url: 'https://weibo.com/detail/123456789', publishedAt: '2026-09-14T00:00:00.000Z', account: account.account };
  const calls: { url: string; options?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    return String(url) === reference ? new Response(pngBytes, { headers: { 'Content-Type': 'image/png' } }) : Response.json(receipt);
  });
  const stored = item('weibo', { image: reference, images: [reference] });
  for (const reconcileOnly of [false, true]) {
    assert.deepEqual(await publishPlatform('weibo', stored, 'request-id', '123456', { reconcileOnly }), receipt);
    const lastCall = calls[calls.length - 1];
    assert.equal(lastCall.url, `/api/platforms/weibo/${reconcileOnly ? 'reconcile' : 'publish'}`);
    assert.deepEqual(JSON.parse(String(lastCall.options?.body)), {
      requestId: 'request-id', contentId: stored.id, title: stored.title, body: stored.body, images: [png], expectedAccountUid: '123456',
      ...(reconcileOnly ? { operation: 'publish' } : {}),
    });
  }
  assert.deepEqual(stored.images, [reference]);
  assert.deepEqual(calls.map(call => call.url), [reference, '/api/platforms/weibo/publish', reference, '/api/platforms/weibo/reconcile']);
});

test('missing, corrupted, and mismatched local files cannot submit a pending snapshot', async t => {
  const reference = mediaRef(pngBytes);
  const corrupted = Buffer.from(pngBytes);
  corrupted[corrupted.length - 1] ^= 1;
  const calls: string[] = [];
  let response = () => new Response(null, { status: 404 });
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => { calls.push(String(url)); return response(); });
  for (const nextResponse of [
    () => new Response(null, { status: 404 }),
    () => new Response(corrupted, { headers: { 'Content-Type': 'image/png' } }),
    () => new Response(pngBytes, { headers: { 'Content-Type': 'image/jpeg' } }),
  ]) {
    response = nextResponse;
    await assert.rejects(preparePlatformContent(item('weibo', { images: [reference] })), { code: 'IMAGE_FETCH', submitted: false });
    await assert.rejects(publishPlatform('weibo', item('weibo', { images: [reference] }), 'request-id', '123456'), { code: 'IMAGE_FETCH', submitted: false });
  }
  assert.equal(calls.length, 6);
  assert.ok(calls.every(url => url === reference));
});

test('hydrating local media does not change the captured title, body, content ID or images', async t => {
  const reference = mediaRef(pngBytes);
  const stored = item('weibo', { image: reference, images: [reference] });
  const original = structuredClone(stored);
  let payload: unknown;
  t.mock.method(globalThis, 'fetch', async (url: string | URL, options?: RequestInit) => {
    if (String(url) === reference) {
      stored.id = 'changed-draft'; stored.title = '改动标题'; stored.body = '改动正文'; stored.images.splice(0);
      return new Response(pngBytes, { headers: { 'Content-Type': 'image/png' } });
    }
    payload = JSON.parse(String(options?.body));
    return Response.json({ id: '123456789', platform: 'weibo', requestId: 'request-id', url: 'https://weibo.com/detail/123456789', publishedAt: '2026-09-14T00:00:00.000Z', account: account.account });
  });
  await publishPlatform('weibo', stored, 'request-id', '123456');
  assert.deepEqual(payload, { requestId: 'request-id', contentId: original.id, title: original.title, body: original.body, images: [png], expectedAccountUid: '123456' });
});

test('local files still obey the publish size limit even when disk storage accepts larger files', async t => {
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 1);
  pngBytes.copy(bytes);
  const reference = mediaRef(bytes);
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    calls.push(String(url));
    return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
  });
  await assert.rejects(preparePlatformContent(item('weibo', { images: [reference] })), { code: 'IMAGE_SIZE', submitted: false });
  await assert.rejects(publishPlatform('weibo', item('weibo', { images: [reference] }), 'request-id', '123456'), { code: 'IMAGE_SIZE', submitted: false });
  assert.deepEqual(calls, [reference, reference]);
});

test('local-looking noncanonical paths and remote URLs are never fetched during publish', async t => {
  const reference = mediaRef(pngBytes);
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected request'); });
  for (const source of [
    '/images/photo.png', `.${reference}`, `${reference}?v=1`, `${reference}#fragment`, reference.toUpperCase(),
    `/api/media/../media/${reference.split('/').pop()}`, reference.replace('.png', '.svg'),
    `//remote.example${reference}`, `https://remote.example${reference}`,
  ]) {
    await assert.rejects(publishPlatform('weibo', item('weibo', { images: [reference, source] }), 'request-id', '123456'), { code: 'IMAGE_NOT_PREPARED', submitted: false });
    if (!source.startsWith('https://')) await assert.rejects(preparePlatformContent(item('weibo', { images: [source] })), { code: 'IMAGE_URL', submitted: false });
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('local WebP is validated after hydration and cannot bypass the Bilibili format restriction', async t => {
  const webpBytes = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
  const reference = mediaRef(webpBytes, 'webp');
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    calls.push(String(url));
    return new Response(webpBytes, { headers: { 'Content-Type': 'image/webp' } });
  });
  const stored = item('bilibili', { image: reference, images: [reference] });
  const failure = { code: 'VALIDATION_ERROR', submitted: false, message: 'B站动态请使用 JPG、PNG 或 GIF，WebP 请转换后上传。' };
  await assert.rejects(preparePlatformReview('bilibili', stored), failure);
  await assert.rejects(publishPlatform('bilibili', stored, 'request-id', '123456'), failure);
  assert.deepEqual(calls, [reference, reference]);
});

test('Bilibili review rejects local and remote WebP without conversion or publishing', async (t) => {
  const webpBytes = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
  const webp = `data:image/webp;base64,${webpBytes.toString('base64')}`;
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    calls.push(String(url));
    return new Response(webpBytes, { headers: { 'Content-Type': 'image/webp' } });
  });
  const failure = { code: 'VALIDATION_ERROR', submitted: false, message: 'B站动态请使用 JPG、PNG 或 GIF，WebP 请转换后上传。' };
  await assert.rejects(preparePlatformReview('bilibili', item('bilibili', { images: [webp] })), failure);
  assert.equal(calls.length, 0);
  // The URL deliberately ends with .jpg: review must inspect the fetched media.
  await assert.rejects(preparePlatformReview('bilibili', item('bilibili', { images: ['https://images.example/photo.jpg'] })), failure);
  assert.deepEqual(calls, ['https://images.example/photo.jpg']);
  await assert.rejects(publishPlatform('bilibili', item('bilibili', { images: [webp] }), 'request-id', '123456'), failure);
  assert.equal(calls.length, 1);
  for (const platform of ['weibo', 'xiaohongshu', 'douyin'] as const) {
    const prepared = await preparePlatformReview(platform, item(platform, { images: [webp] }));
    assert.equal(prepared.images[0], webp);
  }
  assert.equal(calls.length, 1);
});

test('invalid, mismatched, oversized, or excessive images are rejected before submission', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected request'); });
  for (const source of ['file:///tmp/image.png', 'javascript:alert(1)', 'https://user:password@example.com/photo.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,YWJj', 'data:image/png;base64,@@@']) {
    await assert.rejects(preparePlatformContent(item('weibo', { images: [source] })), PlatformRequestError);
  }
  const large = Buffer.alloc(3 * 1024 * 1024 + 1);
  pngBytes.copy(large);
  await assert.rejects(preparePlatformContent(item('weibo', { images: [`data:image/png;base64,${large.toString('base64')}`] })), { code: 'IMAGE_SIZE' });
  await assert.rejects(preparePlatformContent(item('weibo', { images: Array(5).fill(png) })), { code: 'IMAGE_COUNT' });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('publish requires prepared images and a reviewed account, then posts the exact persisted content', async (t) => {
  const receipt = { id: '123456789', platform: 'weibo', requestId: 'request-id', url: 'https://weibo.com/detail/123456789', publishedAt: '2026-09-14T00:00:00.000Z', account: account.account };
  const calls: { url: string; options?: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    return Response.json(receipt);
  });
  await assert.rejects(publishPlatform('weibo', item('weibo', { images: ['https://images.example/photo.png'] }), 'request-id', '123456'), { code: 'IMAGE_NOT_PREPARED', submitted: false });
  await assert.rejects(publishPlatform('weibo', item(), 'request-id', ' '), { code: 'ACCOUNT_REQUIRED', submitted: false });
  await assert.rejects(publishPlatform('douyin', item(), 'request-id', '123456'), { code: 'VALIDATION_ERROR', submitted: false });
  assert.equal(calls.length, 0);
  const prepared = await preparePlatformContent(item());
  assert.deepEqual(await publishPlatform('weibo', prepared, 'request-id', '123456'), receipt);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/platforms/weibo/publish');
  assert.deepEqual(JSON.parse(String(calls[0].options?.body)), {
    requestId: 'request-id', contentId: prepared.id, title: prepared.title, body: prepared.body,
    images: [png], expectedAccountUid: '123456',
  });
});

test('mismatched or malformed success receipts remain uncertain after submission', async (t) => {
  const good = { id: '123456789', platform: 'weibo', requestId: 'request-id', url: 'https://weibo.com/detail/123456789', publishedAt: '2026-09-14T00:00:00.000Z', account: { uid: '123456', name: '测试用户' } };
  let result: unknown = good;
  t.mock.method(globalThis, 'fetch', async () => Response.json(result));
  for (const change of [
    { platform: 'bilibili' }, { requestId: 'another-request' }, { account: { uid: 'wrong-account' } },
    { id: '' }, { id: 123456789 }, { publishedAt: 'invalid' },
    { url: 'http://weibo.com/detail/123456789' }, { url: 'https://weibo.com.evil.example/post' },
    { url: 'https://evil.example/weibo.com/post' }, { url: 'https://user:pass@weibo.com/post' },
  ]) {
    result = { ...good, ...change };
    await assert.rejects(publishPlatform('weibo', item(), 'request-id', '123456'), { code: 'PUBLISH_UNCERTAIN', submitted: true });
  }
  result = null;
  await assert.rejects(publishPlatform('weibo', item(), 'request-id', '123456'), { code: 'PUBLISH_UNCERTAIN', submitted: true });
  for (const [platform, url] of [
    ['weibo', 'https://weibo.com/detail/123456789'], ['xiaohongshu', 'https://www.xiaohongshu.com/explore/123456789'],
    ['douyin', 'https://www.douyin.com/note/123456789'], ['bilibili', 'https://t.bilibili.com/123456789'],
  ] as const) {
    result = { ...good, platform, url };
    assert.deepEqual(await publishPlatform(platform, item(platform), 'request-id', '123456'), result);
  }
});

test('structured server failures preserve uncertainty codes for safe retry handling', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'PUBLISH_UNCERTAIN', message: '发布结果待核对' } }, { status: 409 }));
  await assert.rejects(publishPlatform('weibo', item(), 'request-id', '123456'), { name: 'PlatformRequestError', code: 'PUBLISH_UNCERTAIN', message: '发布结果待核对' });
});

test('server submission certainty preserves explicit false and true without treating absent flags as false', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'PUBLISH_FAILED', message: '发布失败', submitted: false } }, { status: 409 }));
  await assert.rejects(publishPlatform('weibo', item(), 'request-id', '123456'), { code: 'PUBLISH_FAILED', submitted: false });
  fetchMock.mock.mockImplementation(async () => Response.json({ error: { code: 'PUBLISH_UNCERTAIN', message: '结果待核对', submitted: true } }, { status: 409 }));
  await assert.rejects(publishPlatform('weibo', item(), 'request-id', '123456'), { code: 'PUBLISH_UNCERTAIN', submitted: true });
  fetchMock.mock.mockImplementation(async () => Response.json({ error: { code: 'PUBLISH_FAILED', message: '结果待核对' } }, { status: 409 }));
  await assert.rejects(publishPlatform('weibo', item(), 'request-id', '123456'), { submitted: undefined });
  fetchMock.mock.mockImplementation(async () => { throw new Error('connection refused'); });
  await assert.rejects(publishPlatform('weibo', item(), 'request-id', '123456'), { code: 'SERVER_UNAVAILABLE', submitted: undefined });
});

test('network and malformed responses become actionable service errors', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('connection refused'); });
  await assert.rejects(getPlatformAccount('weibo'), { code: 'SERVER_UNAVAILABLE' });
  fetchMock.mock.mockImplementation(async () => new Response('<html>Unavailable</html>'));
  await assert.rejects(getPlatformAccount('weibo'), { code: 'SERVER_UNAVAILABLE' });
});

const originalPublication = (platform: PlatformId = 'weibo'): PlatformPublication => {
  const id = platform === 'xiaohongshu' ? '6078d9d3000000000101de89' : '123456789';
  const urls = { weibo: `https://weibo.com/detail/${id}`, xiaohongshu: `https://www.xiaohongshu.com/explore/${id}`, douyin: `https://www.douyin.com/note/${id}`, bilibili: `https://t.bilibili.com/${id}` };
  return { requestId: 'original-request', state: 'published', expectedAccountUid: '123456', receipt: {
    platform, id, url: urls[platform], requestId: 'original-request', account: { uid: '123456', name: '测试账号' }, publishedAt: '2026-09-15T01:00:00.000Z',
  } };
};

test('lifecycle updates and deletes bind the original publication without sending a URL, post ID or media', async t => {
  const calls: { url: string; payload: Record<string, unknown> }[] = [];
  let publication = originalPublication();
  t.mock.method(globalThis, 'fetch', async (url: string | URL, options?: RequestInit) => {
    const payload = JSON.parse(String(options?.body)); calls.push({ url: String(url), payload });
    assert.equal(options?.method, 'POST'); assert.equal(options?.credentials, 'same-origin');
    const type = String(url).endsWith('/update') ? 'update' : 'delete';
    return Response.json({ receipt: { ...publication.receipt, [type === 'update' ? 'updatedAt' : 'deletedAt']: '2026-09-15T02:00:00.000Z' },
      operation: { requestId: payload.requestId, type, ...(type === 'update' ? { title: payload.title, body: payload.body } : {}) } });
  });
  for (const platform of ['weibo', 'xiaohongshu', 'douyin', 'bilibili'] as const) {
    publication = originalPublication(platform);
    const updated = await updatePlatformPublication(platform, item(platform), publication, 'update-request', ' 改后标题 ', ' 改后正文 ');
    assert.ok(updated.receipt.updatedAt);
    assert.deepEqual(calls.at(-1)?.payload, { requestId: 'update-request', contentId: item().id, publicationRequestId: 'original-request', expectedAccountUid: '123456', title: '改后标题', body: '改后正文' });
    const deleted = await deletePlatformPublication(platform, item(platform), publication, 'delete-request');
    assert.ok(deleted.receipt.deletedAt);
    assert.deepEqual(calls.at(-1)?.payload, { requestId: 'delete-request', contentId: item().id, publicationRequestId: 'original-request', expectedAccountUid: '123456' });
  }
  assert.equal(calls.length, 8);
});

test('invalid lifecycle targets and invalid text never send requests', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected'); });
  const original = originalPublication();
  for (const publication of [{ ...original, receipt: undefined }, { ...original, expectedAccountUid: 'other' }, { ...original, receipt: { ...original.receipt!, url: 'https://weibo.com.evil.example/detail/123456789' } }]) {
    await assert.rejects(deletePlatformPublication('weibo', item(), publication, 'delete-request'), { code: 'VALIDATION_ERROR', submitted: false });
  }
  await assert.rejects(updatePlatformPublication('weibo', item(), original, 'update-request', '', ''), { code: 'VALIDATION_ERROR', submitted: false });
  assert.match(validatePlatformUpdate('xiaohongshu', '标题', '字'.repeat(1001)).join(' '), /1000/);
  assert.deepEqual(validatePlatformUpdate('xiaohongshu', '标题', '正文'), []);
  await assert.rejects(deletePlatformPublication('weibo', item(), { ...original, receipt: { ...original.receipt!, deletedAt: '2026-09-15T02:00:00Z' } }, 'delete-request'), { code: 'PUBLICATION_DELETED', submitted: false });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('lifecycle malformed success cannot clear uncertainty or mark another post deleted', async t => {
  const original = originalPublication();
  const receipt = { ...original.receipt!, updatedAt: '2026-09-15T02:00:00Z' };
  const operation = { type: 'update', requestId: 'update-request', title: '改后标题', body: '正文' };
  let result: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(result));
  for (const value of [null, {}, { receipt, operation: { ...operation, requestId: 'old-request' } }, { receipt, operation: { ...operation, title: '其他文字' } },
    { receipt: { ...receipt, id: '99999999' }, operation }, { receipt: { ...receipt, updatedAt: undefined }, operation },
    { receipt: { ...receipt, account: { uid: 'other', name: '其他账号' } }, operation }]) {
    result = value;
    await assert.rejects(updatePlatformPublication('weibo', item(), original, 'update-request', '改后标题', '正文'), { code: 'OPERATION_UNCERTAIN', submitted: true });
  }
  result = { receipt, operation: { requestId: 'delete-request', type: 'delete' } };
  await assert.rejects(deletePlatformPublication('weibo', item(), original, 'delete-request'), { code: 'OPERATION_UNCERTAIN', submitted: true });
});

test('local deletion status requires matching content and confirmed deletion on every publication', async t => {
  const original = originalPublication();
  const publication = { platform: 'weibo', publicationRequestId: original.requestId, receipt: original.receipt };
  let response: unknown;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url: string | URL, options?: RequestInit) => {
    assert.equal(url, '/api/content/draft-test/deletion-status'); assert.equal(options?.method, undefined);
    return Response.json(response);
  });
  for (const value of [null, {}, { contentId: 'wrong', canDelete: true, pending: false, publications: [] },
    { contentId: item().id, canDelete: true, pending: true, publications: [] },
    { contentId: item().id, canDelete: true, pending: false, publications: [publication] }]) {
    response = value;
    await assert.rejects(getContentDeletionStatus(item().id), { code: 'DELETION_STATUS_INVALID', submitted: false });
  }
  response = { contentId: item().id, canDelete: false, pending: false, publications: [publication] };
  assert.deepEqual(await getContentDeletionStatus(item().id), response);
  response = { contentId: item().id, canDelete: true, pending: false, publications: [{ ...publication, receipt: { ...original.receipt, deletedAt: '2026-09-15T02:00:00Z' } }] };
  assert.deepEqual(await getContentDeletionStatus(item().id), response);
  const count = fetchMock.mock.callCount();
  await assert.rejects(getContentDeletionStatus('../other'), { code: 'VALIDATION_ERROR', submitted: false });
  assert.equal(fetchMock.mock.callCount(), count);
});

test('explicit result checks only call the separate read-only reconciliation route, never fallback to a mutation', async t => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL, options?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(options?.body)) });
    return Response.json({ error: { code: 'NOT_FOUND', message: '接口不存在' } }, { status: 404 });
  });
  const original = originalPublication();
  await assert.rejects(publishPlatform('weibo', item(), 'publish-request', '123456', { reconcileOnly: true }), { code: 'SERVER_RESTART_REQUIRED', submitted: false });
  await assert.rejects(updatePlatformPublication('weibo', item(), original, 'update-request', '新标题', '新正文', { reconcileOnly: true }), { code: 'SERVER_RESTART_REQUIRED', submitted: false });
  await assert.rejects(deletePlatformPublication('weibo', item(), original, 'delete-request', { reconcileOnly: true }), { code: 'SERVER_RESTART_REQUIRED', submitted: false });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.url === '/api/platforms/weibo/reconcile'));
  assert.deepEqual(calls.map(call => call.body.operation), ['publish', 'update', 'delete']);
  assert.deepEqual(calls.map(call => call.body.requestId), ['publish-request', 'update-request', 'delete-request']);
});

const composerDraft = () => ({ account: { uid: '123456', name: '官网当前账号' }, draft: { actualUI: true as const, title: '官网旧标题', body: '尚未发布的实际正文', imageCount: 2, fingerprint: 'a'.repeat(64) } });
const emptyComposerDraft = () => ({ ...composerDraft(), cleared: true as const, draft: { ...composerDraft().draft, title: '', body: '', imageCount: 0, fingerprint: 'b'.repeat(64) } });

test('website draft inspection is explicit and returns actual UI content for the expected account', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    calls.push(url);
    assert.equal(options?.method, 'POST');
    assert.equal(options?.credentials, 'same-origin');
    assert.deepEqual(JSON.parse(String(options?.body)), { expectedAccountUid: '123456' });
    return Response.json(composerDraft());
  });
  assert.deepEqual(await getPlatformComposerDraft('bilibili', '123456'), composerDraft());
  assert.deepEqual(calls, ['/api/platforms/bilibili/composer-draft']);
});

test('website draft inspection rejects missing actual UI proof, changed accounts and invalid summaries', async t => {
  let value: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(value));
  const original = composerDraft();
  for (const invalid of [null, {}, { ...original, account: { uid: 'other', name: '其他账号' } },
    { ...original, draft: { ...original.draft, actualUI: false } }, { ...original, draft: { ...original.draft, title: null } },
    { ...original, draft: { ...original.draft, imageCount: -1 } }, { ...original, draft: { ...original.draft, imageCount: 0.5 } },
    { ...original, draft: { ...original.draft, fingerprint: 'invalid' } }]) {
    value = invalid;
    await assert.rejects(getPlatformComposerDraft('bilibili', '123456'), { code: 'DRAFT_RESPONSE_INVALID', submitted: false });
  }
});

test('website draft clearing only sends the reviewed account and exact opaque fingerprint', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    calls.push(url);
    assert.equal(options?.method, 'POST');
    assert.deepEqual(JSON.parse(String(options?.body)), { expectedAccountUid: '123456', fingerprint: 'a'.repeat(64) });
    return Response.json(emptyComposerDraft());
  });
  assert.deepEqual(await clearPlatformComposerDraft('bilibili', '123456', 'a'.repeat(64)), emptyComposerDraft());
  assert.deepEqual(calls, ['/api/platforms/bilibili/clear-composer-draft']);
});

test('draft clearing requires fresh review inputs and positive proof that the editor is empty', async t => {
  let calls = 0;
  let value: unknown;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json(value); });
  await assert.rejects(getPlatformComposerDraft('bilibili', ''), { code: 'VALIDATION_ERROR', submitted: false });
  await assert.rejects(clearPlatformComposerDraft('bilibili', '', 'a'.repeat(64)), { code: 'VALIDATION_ERROR', submitted: false });
  await assert.rejects(clearPlatformComposerDraft('bilibili', '123456', 'unreviewed'), { code: 'VALIDATION_ERROR', submitted: false });
  assert.equal(calls, 0);
  const empty = emptyComposerDraft();
  for (const invalid of [null, { ...empty, cleared: false }, { ...empty, account: { uid: 'other', name: '其他账号' } },
    { ...empty, draft: { ...empty.draft, title: '尚未清空' } }, { ...empty, draft: { ...empty.draft, body: '尚未清空' } },
    { ...empty, draft: { ...empty.draft, imageCount: 1 } }]) {
    value = invalid;
    await assert.rejects(clearPlatformComposerDraft('bilibili', '123456', 'a'.repeat(64)), { code: 'DRAFT_CLEAR_UNCONFIRMED', submitted: false });
  }
  assert.equal(calls, 6);
});

test('outdated servers cannot trigger a draft cleanup fallback or publishing', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    return Response.json({ error: { code: 'NOT_FOUND', message: 'route unavailable' } }, { status: 404 });
  });
  await assert.rejects(getPlatformComposerDraft('bilibili', '123456'), { code: 'SERVER_RESTART_REQUIRED', submitted: false });
  await assert.rejects(clearPlatformComposerDraft('bilibili', '123456', 'a'.repeat(64)), { code: 'SERVER_RESTART_REQUIRED', submitted: false });
  assert.deepEqual(calls, ['/api/platforms/bilibili/composer-draft', '/api/platforms/bilibili/clear-composer-draft']);
});
