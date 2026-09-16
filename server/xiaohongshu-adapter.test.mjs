import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { confirmedXiaohongshuMutation, confirmedXiaohongshuPublication, createXiaohongshuAdapter,
  isXiaohongshuDetailResponse, isXiaohongshuMutationResponse, isXiaohongshuPublishResponse,
  readXiaohongshuAccount, validateXiaohongshuInput, validateXiaohongshuMutation, xiaohongshuAccount,
  xiaohongshuDeleteGuardDom, xiaohongshuManagedNoteId, xiaohongshuOriginalDetail, xiaohongshuPictureState, xiaohongshuStructure } from './xiaohongshu-adapter.mjs';

const uid = 'a'.repeat(24), id = 'b'.repeat(24);
const account = { uid, name: '测试作者' };
const image = 'data:image/png;base64,YQ==';

function editorTextNode(text) {
  return { nodeType: 3, nodeName: '#text', nodeValue: text, textContent: text, childNodes: [] };
}

function editorElement(tag, children = [], attributes = {}) {
  const childNodes = children.map((child) => typeof child === 'string' ? editorTextNode(child) : child);
  const element = { nodeType: 1, nodeName: tag.toUpperCase(), tagName: tag.toUpperCase(), childNodes,
    children: childNodes.filter((child) => child.nodeType === 1),
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => Object.hasOwn(attributes, name),
    classList: { contains: (name) => (attributes.class || '').split(/\s+/).includes(name) } };
  for (const child of childNodes) { child.parentNode = element; child.parentElement = element; }
  Object.defineProperties(element, {
    firstChild: { get: () => childNodes[0] || null }, lastChild: { get: () => childNodes.at(-1) || null },
    textContent: { get: () => childNodes.map((child) => child.textContent || '').join('') },
    innerText: { get: () => assert.fail('editor readback must follow paragraph and hard-break DOM structure') },
    innerHTML: { get: () => assert.fail('editor readback must not serialize HTML') },
  });
  return element;
}

const editorParagraphs = (text) => editorElement('div', text.split('\n').map((line) => editorElement('p', line ? [line] : [])), { class: 'tiptap' });

test('Xiaohongshu account requires current user id and name, never returns credentials', () => {
  assert.deepEqual(xiaohongshuAccount({ userId: uid, userName: '测试作者', token: 'private' }), { ...account, profileUrl: `https://www.xiaohongshu.com/user/profile/${uid}` });
  for (const value of [{ userId: uid }, { nickname: '昵称' }, { userId: uid, nickname: '游客', guest: true }, { userId: '../wrong', nickname: '昵称' }]) assert.equal(xiaohongshuAccount(value), null);
});

test('identity reads are restricted to official domains', async () => {
  assert.equal(await readXiaohongshuAccount({ url: () => 'https://creator.xiaohongshu.com.evil.test/', evaluate() { throw new Error('must not evaluate'); } }), null);
});

test('main-site identity uses a fresh public response instead of stale page boot data', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ code: 0, data: { user_id: 'c'.repeat(24), nickname: '已切换账号', token: 'do-not-return', imageb: 'https://images.example/avatar.png' } }) };
    };
    const page = { url: () => 'https://www.xiaohongshu.com/explore', cachedAccount: account, evaluate: (callback, args) => callback(args) };
    const current = await readXiaohongshuAccount(page);
    assert.equal(current.uid, 'c'.repeat(24)); assert.equal(current.name, '已切换账号');
    assert.equal('token' in current, false);
    assert.equal(requests[0].url, 'https://edith.xiaohongshu.com/api/sns/web/v2/user/me');
    assert.equal(requests[0].options.credentials, 'include'); assert.equal(requests[0].options.cache, 'no-store');
    assert.ok(requests[0].options.signal instanceof AbortSignal);
  } finally { globalThis.fetch = previousFetch; }
});

test('expired, blocked and timed-out live identity reads cannot fall back to cached login', async () => {
  const previousFetch = globalThis.fetch;
  const page = { url: () => 'https://www.xiaohongshu.com/explore', cachedAccount: account, evaluate: (callback, args) => callback(args) };
  try {
    for (const implementation of [
      async () => ({ ok: false }),
      async () => ({ ok: true, json: async () => ({ code: -100, data: { user_id: uid, nickname: account.name } }) }),
      async () => ({ ok: true, json: async () => ({ code: 0, data: { user_id: uid, nickname: account.name, guest: true } }) }),
      async () => { throw new DOMException('expired', 'TimeoutError'); },
      async () => { throw new TypeError('CORS blocked'); },
    ]) {
      globalThis.fetch = implementation;
      assert.equal(await readXiaohongshuAccount(page), null);
    }
  } finally { globalThis.fetch = previousFetch; }
});

test('creator identity reads remain same-origin and bypass browser caches', async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, '/api/galaxy/user/my-info'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store');
      return { ok: true, json: async () => ({ code: 0, success: true, data: { userDetail: { id: uid, nickName: account.name, url: 'https://images.example/avatar.png' }, permissions: ['POST'], token: 'not-public' } }) };
    };
    const page = { url: () => 'https://creator.xiaohongshu.com/publish/publish', evaluate: (callback, args) => callback(args) };
    assert.deepEqual(await readXiaohongshuAccount(page), { uid, name: account.name, profileUrl: `https://www.xiaohongshu.com/user/profile/${uid}`, avatarUrl: 'https://images.example/avatar.png' });
  } finally { globalThis.fetch = previousFetch; }
});

test('creator nested identity is authoritative and cannot borrow missing fields from legacy metadata', async () => {
  const previousFetch = globalThis.fetch;
  const page = { url: () => 'https://creator.xiaohongshu.com/publish/publish', evaluate: (callback, args) => callback(args) };
  try {
    for (const detail of [null, { id: 'invalid', nickName: account.name }, { id: uid }, { id: uid, nickName: ' ' }, { id: uid, nickName: account.name, guest: true }]) {
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 0, success: true, data: { userDetail: detail, userId: uid, userName: account.name } }) });
      assert.equal(await readXiaohongshuAccount(page), null);
    }
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 0, data: { userId: uid, userName: account.name } }) });
    assert.equal((await readXiaohongshuAccount(page)).uid, uid);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 0, data: { userDetail: { id: 'c'.repeat(24), nickName: '切换后的账号' }, userId: uid, userName: account.name } }) });
    assert.equal((await readXiaohongshuAccount(page)).uid, 'c'.repeat(24));
  } finally { globalThis.fetch = previousFetch; }
});

test('Xiaohongshu validates title, body and required complete image set', () => {
  assert.equal(validateXiaohongshuInput({ title: ' 标题 ', body: ' 正文 ', images: [image] }).title, '标题');
  for (const payload of [{ title: 'x'.repeat(21), images: [image] }, { body: 'x'.repeat(1001), images: [image] }, { title: 'a\0b', images: [image] }]) assert.throws(() => validateXiaohongshuInput(payload), { code: 'PUBLISH_REJECTED' });
  assert.throws(() => validateXiaohongshuInput({ title: '标题', images: [] }), { code: 'IMAGE_UPLOAD_FAILED' });
  assert.throws(() => validateXiaohongshuInput({ title: '标题', images: Array(5).fill(image) }), { code: 'IMAGE_UPLOAD_FAILED' });
  assert.throws(() => validateXiaohongshuInput({ title: ' ', body: '正文', images: [image] }), { code: 'PUBLISH_REJECTED' });
  assert.equal(validateXiaohongshuInput({ title: '😀'.repeat(20), body: '😀'.repeat(1000), images: [image] }).title, '😀'.repeat(20));
});

test('native response requires exact origin, endpoint and POST method', () => {
  const response = (url, method = 'POST') => ({ url: () => url, request: () => ({ method: () => method }) });
  assert.equal(isXiaohongshuPublishResponse(response('https://edith.xiaohongshu.com/web_api/sns/v2/note')), true);
  for (const value of [response('https://edith.xiaohongshu.com.evil.test/web_api/sns/v2/note'), response('https://edith.xiaohongshu.com/web_api/sns/v2/note', 'GET'), response('https://edith.xiaohongshu.com/web_api/sns/v2/note/update')]) assert.equal(isXiaohongshuPublishResponse(value), false);
});

test('confirmed native note receipt has an explicit success indicator and id', () => {
  const receipt = confirmedXiaohongshuPublication(JSON.stringify({ success: true, code: 0, data: { id, user_id: uid } }), account, () => new Date('2026-09-14T00:00:00Z'));
  assert.deepEqual(receipt, { id, url: `https://www.xiaohongshu.com/explore/${id}`, publishedAt: '2026-09-14T00:00:00.000Z', account });
  for (const value of ['<html>', '{}', '{"code":0}', JSON.stringify({ code: 0, data: { id: '123' } }), JSON.stringify({ data: { id } }), JSON.stringify({ code: 0, data: { id, user_id: 'c'.repeat(24) } })]) assert.throws(() => confirmedXiaohongshuPublication(value, account), { code: 'PUBLISH_UNCERTAIN' });
  assert.throws(() => confirmedXiaohongshuPublication(JSON.stringify({ success: false, code: 0, data: { id } }), account), { code: 'PUBLISH_REJECTED' });
});

test('adapter connects through the creator session and rejects publish without checkpoint', async () => {
  const adapter = createXiaohongshuAdapter();
  assert.equal(adapter.defaultHeadless, true);
  assert.equal(adapter.homeUrl, 'https://creator.xiaohongshu.com/publish/publish?source=official&target=image');
  assert.equal(adapter.loginUrl, adapter.homeUrl);
  assert.equal(adapter.resumeUrl, 'https://creator.xiaohongshu.com/publish/publish?source=official&target=image');
  await assert.rejects(adapter.publish({}, { title: '标题', images: [image] }), { code: 'PUBLISH_REJECTED' });
  assert.equal(adapter.getLoginNotice({ url: () => 'https://www.xiaohongshu.com/website-login/error?error_code=300012&error_msg=do-not-forward' }), '小红书当前网络被官网限制，请切换可靠网络后重新连接（300012）。');
  assert.equal(adapter.getLoginNotice({ url: () => 'https://www.xiaohongshu.com/website-login/error?error_code=unknown&error_msg=do-not-forward' }), undefined);
});

test('Xiaohongshu connection migrates legacy main-site tabs to the creator session', async () => {
  const adapter = createXiaohongshuAdapter();
  const navigations = [];
  const page = {
    url: () => 'https://www.xiaohongshu.com/explore',
    goto: async (url, options) => navigations.push({ url, options }),
    evaluate: () => assert.fail('login must not depend on the blocked main-site identity endpoint'),
    locator: () => assert.fail('creator login is handled by the official creator page'),
  };
  assert.equal(await adapter.login(page), page);
  assert.deepEqual(navigations, [{ url: adapter.homeUrl, options: { waitUntil: 'domcontentloaded' } }]);
});

test('Xiaohongshu login preserves existing creator drafts and native login pages', async () => {
  const adapter = createXiaohongshuAdapter();
  for (const path of ['/publish/publish?target=image', '/login', '/new/home']) {
    const page = { url: () => `https://creator.xiaohongshu.com${path}`,
      goto: () => assert.fail('opening an existing creator tab must not reload its draft or login flow') };
    assert.equal(await adapter.login(page), page);
  }
});

class FixturePage extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.location = 'https://creator.xiaohongshu.com/publish/publish?source=official&target=image';
    this.title = ''; this.body = ''; this.files = []; this.events = []; this.accountReads = 0;
    this.root = { count: async () => 1, evaluate: async () => ({ count: this.options.existingMedia || this.files.length,
      ready: this.files.length, failed: Boolean(this.options.uploadFailed), sources: this.options.sources || this.files.map((_, i) => `blob:img-${i}`) }),
    locator: (selector) => {
      if (selector.includes('max_suffix')) return { count: async () => 0 };
      if (selector.includes('button.bg-red')) return { count: async () => 0 };
      if (selector.startsWith('xhs-publish-btn')) return this.button;
      return this.titleLocator;
    } };
    this.titleLocator = { count: async () => this.options.ambiguous ? 2 : 1, first: () => this.titleLocator,
      waitFor: async () => {}, fill: async (value) => { this.title = value; this.events.push('fill-title'); }, inputValue: async () => this.title,
      click: async () => {}, locator: () => this.root };
    this.bodyLocator = { count: async () => 1, fill: async (value) => { this.body = value; this.events.push('fill-body'); }, innerText: async () => this.body,
      evaluate: async (callback, args) => callback(this.options.bodyDom?.(this) || editorParagraphs(this.body), args) };
    this.button = { count: async () => 1, isEnabled: async () => true, isVisible: async () => true, getAttribute: async () => null,
      boundingBox: async () => ({ width: 120, height: 40 }), click: async () => {
        this.events.push('publish-click');
        if (this.options.clickError) throw new Error('click interrupted');
        this.emit('response', { url: () => 'https://edith.xiaohongshu.com/web_api/sns/v2/note', request: () => ({ method: () => 'POST' }),
          ok: () => true, text: async () => this.options.publishRaw || JSON.stringify({ code: 0, data: { id } }) });
      } };
    this.uploader = { first: () => this.uploader, waitFor: async () => {}, count: async () => 1, getAttribute: async () => 'image/*',
      setInputFiles: async (file) => { this.files.push(file); this.events.push('upload'); } };
    this.guideOpen = Boolean(options.imageGuide);
    this.guideButton = { count: async () => options.guideButtonCount ?? 1,
      innerText: async () => options.guideButtonText ?? '我知道了',
      isVisible: async () => !options.guideButtonHidden, isEnabled: async () => !options.guideButtonDisabled,
      click: async () => { this.events.push('dismiss-image-guide'); this.guideOpen = false; } };
    this.guide = { count: async () => options.guideCount ?? (this.guideOpen ? 1 : 0),
      waitFor: async ({ state, timeout }) => { assert.equal(state, 'hidden'); assert.equal(timeout, 3_000); assert.equal(this.guideOpen, false); },
      locator: (selector) => {
        if (selector === '.feature-guide__title') return { count: async () => options.guideTitleCount ?? 1,
          innerText: async () => options.guideTitle ?? '图片可以编辑啦，快来试试吧' };
        if (selector === 'button.feature-guide__btn') return this.guideButton;
        throw new Error(`Unexpected guide selector ${selector}`);
      } };
  }
  url() { return this.location; }
  async goto(url) { this.location = url; this.events.push('navigate'); }
  async evaluate() {
    this.accountReads++;
    return this.options.loggedOut ? null : { userId: this.options.accountUids?.[this.accountReads - 1] || uid, userName: account.name };
  }
  locator(selector) {
    if (selector === '.feature-guide[role="dialog"]:visible') return this.guide;
    if (selector === 'body') return this.root;
    if (selector.includes('captcha')) return { count: async () => this.options.challenge ? 1 : 0 };
    if (selector === '.img-preview-area .img-container') return { count: async () => this.options.existingMedia || this.files.length };
    if (selector === 'video, audio') return { count: async () => 0 };
    if (selector.startsWith('div.creator-tab')) {
      const tab = { count: async () => 1, click: async () => { this.events.push('image-tab'); }, filter: () => tab }; return tab;
    }
    if (selector.includes('input.upload-input') || selector.includes('.img-list input')) return this.uploader;
    if (selector.startsWith('div.d-input')) return this.titleLocator;
    if (selector.includes('contenteditable')) return this.bodyLocator;
    throw new Error(`Unexpected selector ${selector}`);
  }
}

const input = { title: '测试标题', body: '正文\n#话题', images: [image, image], expectedAccountUid: uid };

test('all pictures and exact text are verified before checkpoint and one native click', async () => {
  const page = new FixturePage();
  const result = await createXiaohongshuAdapter().publish(page, input, { beforeSubmit: async () => { page.events.push('checkpoint'); } });
  assert.equal(result.id, id);
  assert.deepEqual(page.events, ['upload', 'upload', 'fill-title', 'fill-body', 'checkpoint', 'publish-click']);
  assert.equal(page.accountReads, 5);
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(page.listenerCount('close'), 0);
});

test('native editor readback preserves paragraph and empty-paragraph newlines without layout text', async () => {
  const paragraph = (...children) => editorElement('p', children);
  const trailing = () => editorElement('br', [], { class: 'ProseMirror-trailingBreak' });
  for (const [body, children] of [
    ['单段正文', [paragraph('单段正文')]],
    ['第一段\n第二段', [paragraph('第一段'), paragraph('第二段')]],
    ['第一段\n\n第三段', [paragraph('第一段', editorElement('br'), editorElement('br'), '第三段')]],
    ['第一段\n\n第三段', [paragraph('第一段'), paragraph(), paragraph('第三段')]],
    ['第一段\n\n第三段', [paragraph('第一段'), paragraph(trailing()), paragraph('第三段')]],
    ['第一段\n第二段', [paragraph('第一段', trailing()), paragraph('第二段', trailing())]],
    ['', [paragraph(trailing())]],
  ]) {
    const page = new FixturePage({ bodyDom: () => editorElement('div', children, { class: 'tiptap' }) });
    const result = await createXiaohongshuAdapter().publish(page, { ...input, body }, checkpointEvent(page));
    assert.equal(result.id, id, body);
    assert.equal(page.events.filter((event) => event === 'checkpoint').length, 1, body);
    assert.equal(page.events.filter((event) => event === 'publish-click').length, 1, body);
  }
});

test('native editor readback refuses images and unknown content instead of dropping them', async () => {
  for (const tag of ['img', 'video', 'iframe', 'script', 'xhs-unknown-widget']) {
    const page = new FixturePage({ bodyDom: () => editorElement('div', [editorElement('p', [input.body, editorElement(tag)])], { class: 'tiptap' }) });
    await assert.rejects(createXiaohongshuAdapter().publish(page, input, checkpointEvent(page)), { code: 'UI_CHANGED' }, tag);
    assert.equal(page.events.includes('checkpoint'), false, tag);
    assert.equal(page.events.includes('publish-click'), false, tag);
    assert.equal(page.listenerCount('response'), 0, tag);
  }
});

test('native editor DOM readback catches altered text even when layout text still matches', async () => {
  const page = new FixturePage({ bodyDom: () => editorParagraphs('被页面改动的正文') });
  await assert.rejects(createXiaohongshuAdapter().publish(page, input, checkpointEvent(page)), { code: 'UI_CHANGED' });
  assert.equal(page.body, input.body);
  assert.equal(page.events.includes('checkpoint'), false);
  assert.equal(page.events.includes('publish-click'), false);
});

test('publish dismisses only the unique known image-editing guide before its checkpoint', async () => {
  const page = new FixturePage({ imageGuide: true });
  const result = await createXiaohongshuAdapter().publish(page, input, checkpointEvent(page));
  assert.equal(result.id, id);
  assert.equal(page.events.filter((event) => event === 'dismiss-image-guide').length, 1);
  assert.equal(page.guideOpen, false);
  assert.ok(page.events.indexOf('dismiss-image-guide') < page.events.indexOf('checkpoint'));
  assert.equal(page.events.filter((event) => event === 'publish-click').length, 1);
});

test('unknown, ambiguous and disabled guides are never acknowledged or submitted', async () => {
  for (const options of [
    { guideCount: 2 }, { guideTitleCount: 0 }, { guideTitleCount: 2 },
    { guideTitle: '另一项功能，点击我知道了继续' }, { guideTitle: '图片可以编辑啦，快来试试吧（其他操作）' },
    { guideButtonCount: 0 }, { guideButtonCount: 2 }, { guideButtonText: '确认发布' },
    { guideButtonHidden: true }, { guideButtonDisabled: true },
  ]) {
    const page = new FixturePage({ imageGuide: true, ...options });
    await assert.rejects(createXiaohongshuAdapter().publish(page, input, checkpointEvent(page)), { code: 'UI_CHANGED' });
    assert.equal(page.events.includes('dismiss-image-guide'), false, JSON.stringify(options));
    assert.equal(page.events.includes('checkpoint'), false, JSON.stringify(options));
    assert.equal(page.events.includes('publish-click'), false, JSON.stringify(options));
  }
});

test('wrong account, existing media, challenges and upload failures cannot submit', async () => {
  for (const [options, code] of [[{ accountUids: ['c'.repeat(24)] }, 'ACCOUNT_CHANGED'], [{ loggedOut: true }, 'LOGIN_REQUIRED'], [{ existingMedia: 1 }, 'IMAGE_UPLOAD_FAILED'], [{ challenge: true }, 'CAPTCHA_REQUIRED'], [{ uploadFailed: true }, 'IMAGE_UPLOAD_FAILED'], [{ ambiguous: true }, 'UI_CHANGED']]) {
    const page = new FixturePage(options);
    await assert.rejects(createXiaohongshuAdapter().publish(page, input, { beforeSubmit: async () => { page.events.push('checkpoint'); } }), { code });
    assert.equal(page.events.includes('checkpoint'), false);
    assert.equal(page.events.includes('publish-click'), false);
  }
});

test('checkpoint failure and account change before checkpoint prevent clicking', async () => {
  const page = new FixturePage();
  await assert.rejects(createXiaohongshuAdapter().publish(page, input, { beforeSubmit: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(page.events.includes('publish-click'), false);
  const changed = new FixturePage({ accountUids: [uid, uid, 'c'.repeat(24)] });
  await assert.rejects(createXiaohongshuAdapter().publish(changed, input, { beforeSubmit: async () => {} }), { code: 'ACCOUNT_CHANGED' });
  assert.equal(changed.events.includes('publish-click'), false);
});

async function prepareBeforeCheckpointFailure(adapter, page, payload = input) {
  const failure = new Error('fixture checkpoint did not persist');
  await assert.rejects(adapter.publish(page, payload, { beforeSubmit: async () => { throw failure; } }), (error) => error === failure);
  assert.equal(page.events.includes('publish-click'), false);
  assert.equal(page.files.length, payload.images.length);
  page.events.length = 0;
}

test('a safe retry reuses only the same page and payload preparation without uploading duplicates', async () => {
  const page = new FixturePage();
  const adapter = createXiaohongshuAdapter();
  await prepareBeforeCheckpointFailure(adapter, page);
  const result = await adapter.publish(page, input, checkpointEvent(page));
  assert.equal(result.id, id); assert.equal(page.files.length, 2);
  assert.equal(page.events.includes('upload'), false);
  assert.equal(page.events.filter((event) => event === 'checkpoint').length, 1);
  assert.equal(page.events.filter((event) => event === 'publish-click').length, 1);
});

test('prepared images cannot be reused for a changed title, body, bytes or image count', async () => {
  for (const change of [
    { title: '不同标题' }, { body: '不同正文' },
    { images: [image, 'data:image/png;base64,Yg=='] }, { images: [image] }, { images: [image, image, image] },
  ]) {
    const page = new FixturePage();
    const adapter = createXiaohongshuAdapter();
    await prepareBeforeCheckpointFailure(adapter, page);
    await assert.rejects(adapter.publish(page, { ...input, ...change }, checkpointEvent(page)), { code: 'IMAGE_UPLOAD_FAILED' });
    assert.equal(page.events.includes('upload'), false); assert.equal(page.files.length, 2);
    assert.equal(page.events.includes('checkpoint'), false); assert.equal(page.events.includes('publish-click'), false);
  }
});

test('prepared images require the unchanged ordered source list, full count and current text', async () => {
  for (const change of [
    (page) => { page.options.sources = ['blob:img-1', 'blob:img-0']; },
    (page) => { page.options.sources = ['blob:foreign-0', 'blob:foreign-1']; },
    (page) => { page.files.pop(); },
    (page) => { page.options.uploadFailed = true; },
    (page) => { page.title = '被改动的标题'; },
    (page) => { page.body = '被改动的正文'; },
  ]) {
    const page = new FixturePage();
    const adapter = createXiaohongshuAdapter();
    await prepareBeforeCheckpointFailure(adapter, page);
    change(page);
    const imageCount = page.files.length;
    await assert.rejects(adapter.publish(page, input, checkpointEvent(page)), { code: 'IMAGE_UPLOAD_FAILED' });
    assert.equal(page.files.length, imageCount); assert.equal(page.events.includes('upload'), false);
    assert.equal(page.events.includes('checkpoint'), false); assert.equal(page.events.includes('publish-click'), false);
  }
});

test('a preparation from another page cannot authorize reuse of existing media', async () => {
  const adapter = createXiaohongshuAdapter();
  const first = new FixturePage();
  await prepareBeforeCheckpointFailure(adapter, first);
  const other = new FixturePage();
  other.files = [...first.files]; other.title = first.title; other.body = first.body;
  await assert.rejects(adapter.publish(other, input, checkpointEvent(other)), { code: 'IMAGE_UPLOAD_FAILED' });
  assert.deepEqual(other.events, []); assert.equal(other.files.length, 2);
});

test('an uncertain native submission consumes its preparation and cannot be retried through media reuse', async () => {
  const page = new FixturePage({ clickError: true });
  const adapter = createXiaohongshuAdapter();
  await assert.rejects(adapter.publish(page, input, checkpointEvent(page)), { code: 'PUBLISH_UNCERTAIN' });
  assert.equal(page.events.filter((event) => event === 'publish-click').length, 1);
  page.options.clickError = false; page.events.length = 0;
  await assert.rejects(adapter.publish(page, input, checkpointEvent(page)), { code: 'IMAGE_UPLOAD_FAILED' });
  assert.equal(page.events.includes('upload'), false); assert.equal(page.files.length, 2);
  assert.equal(page.events.includes('checkpoint'), false); assert.equal(page.events.includes('publish-click'), false);
});

test('post-checkpoint edits and account changes freeze the attempt without clicking', async () => {
  for (const mutate of [(page) => { page.body = 'changed'; }, (page) => { page.options.sources = ['blob:img-1', 'blob:img-0']; }, (page) => { page.options.accountUids = Array(page.accountReads).fill(uid).concat('c'.repeat(24)); }]) {
    const page = new FixturePage();
    await assert.rejects(createXiaohongshuAdapter().publish(page, input, { beforeSubmit: async () => mutate(page) }), { code: 'PUBLISH_UNCERTAIN' });
    assert.equal(page.events.includes('publish-click'), false);
    assert.equal(page.listenerCount('response'), 0);
  }
});

test('unconfirmed, rejected and interrupted native responses never retry a click', async () => {
  for (const [options, code] of [[{ publishRaw: '{"code":0}' }, 'PUBLISH_UNCERTAIN'], [{ publishRaw: '{"code":-1}' }, 'PUBLISH_REJECTED'], [{ clickError: true }, 'PUBLISH_UNCERTAIN']]) {
    const page = new FixturePage(options);
    await assert.rejects(createXiaohongshuAdapter().publish(page, input, { beforeSubmit: async () => {} }), { code });
    assert.equal(page.events.filter((event) => event === 'publish-click').length, 1);
    assert.equal(page.listenerCount('response'), 0);
  }
});

// Advance only the short readiness polling timers. Native publication observers
// keep their real timers so these fixtures also exercise their normal cleanup.
function readinessClock(t) {
  const nativeSetTimeout = globalThis.setTimeout;
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay > 20) return nativeSetTimeout(callback, delay, ...args);
    now += Math.max(1, delay);
    queueMicrotask(() => callback(...args));
    return 0;
  });
}

class ReadyEntryPage extends FixturePage {
  constructor(options = {}) {
    super(options);
    this.tabReads = 0; this.uploaderReads = 0; this.acceptReads = 0; this.tabClicks = 0; this.entryTrace = [];
    this.imageTab = { filter: () => this.imageTab,
      count: async () => {
        this.tabReads++;
        this.options.onEntryRead?.(this);
        const count = this.options.tabCount?.(this) ?? 1;
        this.entryTrace.push({ type: 'tab', count });
        return count;
      },
      click: async () => { this.tabClicks++; this.events.push('image-tab'); this.options.onTabClick?.(this); } };
    this.entryUploader = { first: () => this.entryUploader, waitFor: async () => {},
      count: async () => {
        this.uploaderReads++;
        this.options.onEntryRead?.(this);
        const count = this.options.uploaderCount?.(this) ?? 1;
        this.entryTrace.push({ type: 'uploader', count });
        return count;
      },
      getAttribute: async (name) => {
        assert.equal(name, 'accept');
        this.acceptReads++;
        const accept = this.options.uploaderAccept?.(this) ?? 'image/*';
        this.entryTrace.push({ type: 'accept', accept });
        return accept;
      },
      setInputFiles: async (file) => {
        this.entryTrace.push({ type: 'upload', accountReads: this.accountReads, existingMedia: this.options.existingMedia || 0 });
        await this.uploader.setInputFiles(file);
      } };
  }
  locator(selector) {
    if (selector.startsWith('div.creator-tab')) return this.imageTab;
    if (selector.includes('input.upload-input')) {
      assert.equal(selector, 'div.upload-content:visible input.upload-input[type="file"]', 'select the visible upload container without requiring its native hidden file input to be visible');
      return this.entryUploader;
    }
    if (selector === 'video, audio') return { count: async () => this.options.existingVideo ? 1 : 0 };
    return super.locator(selector);
  }
  async evaluate(...args) {
    const result = await super.evaluate(...args);
    await this.options.onAccountRead?.(this, this.accountReads);
    return result;
  }
}

const readyAdapter = (publishReadyTimeoutMs = 20) => createXiaohongshuAdapter({ publishReadyTimeoutMs });
const checkpointEvent = (page) => ({ beforeSubmit: async () => { page.events.push('checkpoint'); } });
function noReadyUpload(page) {
  assert.deepEqual(page.files, []);
  assert.equal(page.events.includes('checkpoint'), false);
  assert.equal(page.events.includes('publish-click'), false);
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(page.listenerCount('close'), 0);
}

test('publish waits for a delayed image tab before uploading through its image input', async (t) => {
  readinessClock(t);
  const page = new ReadyEntryPage({ tabCount: (page) => page.tabReads < 2 ? 0 : 1,
    uploaderCount: (page) => page.tabClicks ? 1 : 0 });
  const result = await readyAdapter().publish(page, input, checkpointEvent(page));
  assert.equal(result.id, id); assert.equal(page.tabClicks, 1);
  assert.ok(page.entryTrace.some((entry) => entry.type === 'tab' && entry.count === 0));
  assert.deepEqual(page.events, ['image-tab', 'upload', 'upload', 'fill-title', 'fill-body', 'checkpoint', 'publish-click']);
  assert.equal(page.entryTrace.find((entry) => entry.type === 'upload').accountReads, 3);
});

test('an attached video input cannot outrun a delayed image tab', async (t) => {
  readinessClock(t);
  const page = new ReadyEntryPage({ tabCount: (page) => page.tabReads < 2 ? 0 : 1,
    uploaderAccept: (page) => page.tabClicks ? 'image/*' : 'video/*' });
  const result = await readyAdapter().publish(page, input, checkpointEvent(page));
  assert.equal(result.id, id); assert.equal(page.tabClicks, 1);
  assert.ok(page.entryTrace.some((entry) => entry.type === 'accept' && entry.accept === 'video/*'));
  assert.equal(page.events.indexOf('image-tab') < page.events.indexOf('upload'), true);
});

test('switching to image mode waits for its input to replace the video input exactly once', async (t) => {
  readinessClock(t);
  const page = new ReadyEntryPage({ onTabClick: (page) => { page.acceptReads = 0; },
    uploaderAccept: (page) => page.tabClicks && page.acceptReads > 1 ? 'image/*' : 'video/*' });
  const result = await readyAdapter().publish(page, input, checkpointEvent(page));
  assert.equal(result.id, id); assert.equal(page.tabClicks, 1);
  assert.ok(page.entryTrace.some((entry) => entry.type === 'accept' && entry.accept === 'video/*'));
  const uploadIndex = page.entryTrace.findIndex((entry) => entry.type === 'upload');
  assert.equal(page.entryTrace.slice(0, uploadIndex).filter((entry) => entry.type === 'accept').at(-1).accept, 'image/*');
  assert.equal(page.events.filter((event) => event === 'upload').length, 2);
});

test('switching to image mode waits for its delayed input to attach', async (t) => {
  readinessClock(t);
  const page = new ReadyEntryPage({ onTabClick: (page) => { page.uploaderReads = 0; },
    uploaderCount: (page) => page.tabClicks && page.uploaderReads > 1 ? 1 : 0 });
  const result = await readyAdapter().publish(page, input, checkpointEvent(page));
  assert.equal(result.id, id); assert.equal(page.tabClicks, 1);
  assert.ok(page.entryTrace.some((entry) => entry.type === 'uploader' && entry.count === 0));
  assert.equal(page.events.filter((event) => event === 'upload').length, 2);
});

test('a unique image input is usable while the image tab is absent', async (t) => {
  readinessClock(t);
  const page = new ReadyEntryPage({ tabCount: () => 0 });
  const result = await readyAdapter().publish(page, input, checkpointEvent(page));
  assert.equal(result.id, id); assert.equal(page.tabClicks, 0);
  assert.equal(page.events.filter((event) => event === 'publish-click').length, 1);
});

test('three overlapping image tab matches do not prevent using an already-ready image input', async (t) => {
  readinessClock(t);
  const page = new ReadyEntryPage({ tabCount: () => 3,
    onTabClick: () => assert.fail('an ambiguous image tab must never be clicked') });
  const result = await readyAdapter().publish(page, input, checkpointEvent(page));
  assert.equal(result.id, id); assert.equal(page.tabClicks, 0);
  assert.deepEqual(page.events, ['upload', 'upload', 'fill-title', 'fill-body', 'checkpoint', 'publish-click']);
  assert.equal(page.entryTrace.find((entry) => entry.type === 'upload').accountReads, 3);
});

test('non-ready image input requires a unique tab before switching media mode', async (t) => {
  readinessClock(t);
  for (const options of [
    { tabCount: () => 3, uploaderCount: () => 0 },
    { tabCount: () => 3, uploaderCount: () => 2 },
    { tabCount: () => 3, uploaderAccept: () => 'video/*' },
    { tabCount: () => 3, uploaderAccept: () => 'image/*,video/*' },
  ]) {
    const page = new ReadyEntryPage(options);
    await assert.rejects(readyAdapter(1).publish(page, input, checkpointEvent(page)), { code: 'UI_CHANGED' });
    assert.equal(page.tabClicks, 0); noReadyUpload(page);
  }
});

test('missing, ambiguous and non-image entries stop before any file upload', async (t) => {
  readinessClock(t);
  for (const options of [
    { tabCount: () => 0, uploaderCount: () => 0 },
    { tabCount: () => 2, uploaderCount: () => 0 },
    { tabCount: () => 0, uploaderCount: () => 2 },
    { tabCount: () => 0, uploaderAccept: () => 'video/*' },
    { tabCount: () => 0, uploaderAccept: () => 'image/*, video/*' },
    { uploaderCount: () => 0 },
    { uploaderCount: () => 2 },
    { uploaderAccept: () => 'video/*' },
    { uploaderAccept: () => 'image/*, video/*' },
    { uploaderAccept: () => '' },
    { uploaderAccept: () => 'application/pdf' },
  ]) {
    const page = new ReadyEntryPage(options);
    await assert.rejects(readyAdapter(1).publish(page, input, checkpointEvent(page)), { code: 'UI_CHANGED' });
    assert.ok(page.tabClicks <= 1); noReadyUpload(page);
  }
});

test('media or account changes during entry readiness block the first upload', async (t) => {
  readinessClock(t);
  for (const [mutate, code] of [
    [(page) => { page.options.existingMedia = 1; }, 'IMAGE_UPLOAD_FAILED'],
    [(page) => { page.options.existingVideo = true; }, 'IMAGE_UPLOAD_FAILED'],
    [(page) => { page.options.accountUids = Array(page.accountReads).fill(uid).concat('c'.repeat(24)); }, 'ACCOUNT_CHANGED'],
    [(page) => { page.options.loggedOut = true; }, 'LOGIN_REQUIRED'],
    [(page) => { page.options.challenge = true; }, 'CAPTCHA_REQUIRED'],
  ]) {
    const page = new ReadyEntryPage({ tabCount: (page) => page.tabReads < 2 ? 0 : 1,
      uploaderCount: (page) => page.tabClicks ? 1 : 0,
      onEntryRead: (page) => { if (page.tabReads === 2 && !page.didMutate) { page.didMutate = true; mutate(page); } } });
    await assert.rejects(readyAdapter().publish(page, input, checkpointEvent(page)), { code });
    assert.equal(page.didMutate, true); noReadyUpload(page);
  }
});

test('media appearing during the fresh pre-upload identity read is checked before uploading', async (t) => {
  readinessClock(t);
  const page = new ReadyEntryPage({ onAccountRead: (page, reads) => { if (reads === 3) page.options.existingMedia = 1; } });
  await assert.rejects(readyAdapter().publish(page, input, checkpointEvent(page)), { code: 'IMAGE_UPLOAD_FAILED' });
  assert.equal(page.accountReads, 3); noReadyUpload(page);
});

test('the image input is revalidated after the fresh identity read before the first upload', async (t) => {
  readinessClock(t);
  for (const mutate of [
    (page) => { page.options.uploaderCount = () => 0; },
    (page) => { page.options.uploaderCount = () => 2; },
    (page) => { page.options.uploaderAccept = () => 'video/*'; },
    (page) => { page.options.uploaderAccept = () => 'image/*,video/*'; },
  ]) {
    const page = new ReadyEntryPage({ onAccountRead: (page, reads) => { if (reads === 3) mutate(page); } });
    await assert.rejects(readyAdapter().publish(page, input, checkpointEvent(page)), { code: 'UI_CHANGED' });
    assert.equal(page.accountReads, 3); noReadyUpload(page);
  }
});

function structureFixture(selectorValues, stage = 'wait_image_uploader') {
  const document = { readyState: 'interactive', querySelectorAll: (selector) => selectorValues[selector] || [] };
  for (const key of ['URL', 'cookie', 'documentElement']) Object.defineProperty(document, key, { get: () => assert.fail(`diagnostics must not read document.${key}`) });
  const context = createContext({ document, getComputedStyle: (element) => element.style });
  const value = runInContext(`(${xiaohongshuStructure.toString()})(${JSON.stringify({ stage })})`, context);
  return JSON.parse(JSON.stringify(value));
}

function structureElement(tag, { accept = '', classes = [], visible = true, disabled = false, label } = {}) {
  const element = { tagName: tag.toUpperCase(), disabled,
    style: { display: visible ? 'block' : 'none', visibility: 'visible', opacity: '1' },
    getClientRects: () => visible ? [{}] : [],
    getAttribute: (name) => {
      assert.ok(['accept', 'aria-disabled', 'submit-disabled'].includes(name), `unexpected diagnostics attribute ${name}`);
      return name === 'accept' ? accept : null;
    }, closest: (selector) => classes.includes(selector.slice(1)) ? {} : null };
  for (const key of ['value', 'textContent', 'outerHTML', 'src', 'href']) Object.defineProperty(element, key, { get: () => assert.fail(`diagnostics must not read ${key}`) });
  Object.defineProperty(element, 'innerText', { get: () => label === undefined ? assert.fail('diagnostics must not read editor text') : label });
  return element;
}

test('static diagnostics report only bounded structural categories without content or credentials', () => {
  const value = structureFixture({
    'div.creator-tab': [structureElement('div', { label: '上传图文', classes: ['creator-tab', 'private-username'] })],
    'div.d-input input': [structureElement('input', { classes: ['d-input'] })],
    'div[role="textbox"][contenteditable="true"], div.tiptap[contenteditable="true"], div.ql-editor[contenteditable="true"]': [structureElement('div', { classes: ['tiptap'] })],
    'input[type="file"]': [
      structureElement('input', { accept: 'image/png', classes: ['upload-input', 'upload-content'], visible: false }),
      structureElement('input', { accept: '.mp4', classes: ['upload-input'] }),
      structureElement('input', { accept: 'image/*,video/*' }),
      structureElement('input', { accept: 'application/private-secret-type' }),
    ],
    'xhs-publish-btn': [structureElement('xhs-publish-btn', { disabled: true })],
    '.img-preview-area .img-container': [{}],
  });
  assert.equal(value.stage, 'wait_image_uploader'); assert.equal(value.readyState, 'interactive');
  assert.deepEqual(value.counts, { imageTab: 1, titleInput: 1, bodyEditor: 1, fileInput: 4,
    imageFileInput: 1, videoFileInput: 1, publishWidget: 1, legacyPublishButton: 0, previewImage: 1 });
  assert.deepEqual(value.controls.filter((entry) => entry.kind === 'file-input').map((entry) => entry.accept), ['image', 'video', 'mixed', 'other']);
  assert.equal(value.controls.find((entry) => entry.kind === 'publish-widget').disabled, true);
  for (const entry of value.controls) assert.deepEqual(Object.keys(entry).sort(), ['accept', 'disabled', 'kind', 'knownClasses', 'tag', 'visible']);
  assert.equal(JSON.stringify(value).includes('private'), false);
  assert.equal(JSON.stringify(value).includes('上传图文'), false);
});

test('static diagnostics cap control samples and counts for large pages', () => {
  const value = structureFixture({ 'input[type="file"]': Array.from({ length: 1002 }, () => structureElement('input', { accept: '.jpg' })) });
  assert.equal(value.counts.fileInput, 1000); assert.equal(value.counts.imageFileInput, 1000);
  assert.equal(value.controls.length, 20);
});

test('adapter diagnostics retain the bounded readiness stage if layout inspection fails', async (t) => {
  readinessClock(t);
  const adapter = readyAdapter(1);
  const page = new ReadyEntryPage({ tabCount: () => 0, uploaderAccept: () => 'video/*' });
  await assert.rejects(adapter.publish(page, input, checkpointEvent(page)), { code: 'UI_CHANGED' });
  page.evaluate = async (callback, args) => {
    assert.equal(callback, xiaohongshuStructure); assert.deepEqual(args, { stage: 'wait_image_entry' });
    throw new Error('browser closed with private-data');
  };
  assert.deepEqual(await adapter.diagnostics(page), { structure: { stage: 'wait_image_entry' } });
  noReadyUpload(page);
});

test('native picture checks reject incomplete images, uploading masks and failed tiles', async () => {
  const preview = { complete: true, naturalWidth: 1, currentSrc: 'blob:one', getBoundingClientRect: () => ({ width: 50 }) };
  const tile = (options = {}) => ({ innerText: options.failed ? '上传失败' : '', querySelector(selector) {
    if (selector === 'img') return { ...preview, complete: !options.incomplete };
    if (selector.startsWith('.mask.hover-mask')) return { querySelector: () => ({}) };
    if (selector.startsWith('.mask:not')) return options.uploading ? {} : null;
    return null;
  } });
  const root = { evaluate: async (callback) => callback({ querySelectorAll: () => [tile(), tile({ uploading: true }), tile({ incomplete: true }), tile({ failed: true })] }) };
  const state = await xiaohongshuPictureState(root);
  assert.equal(state.count, 4); assert.equal(state.ready, 1); assert.equal(state.failed, true);
});

const mutationReceipt = { id, url: `https://www.xiaohongshu.com/explore/${id}`, account,
  publishedAt: '2026-09-14T00:00:00.000Z', requestId: 'original-publication' };
const mutationInput = { receipt: mutationReceipt, expectedAccountUid: uid, title: '修改后的标题', body: '修改后的正文\n#话题' };
const originalDetail = { id, user_id: uid, type: 'normal', title: '原帖标题', desc: '原帖正文\n#原话题', images_list: [
  { fileid: 'original-file-one', url: 'https://sns-img.example/first.png' },
  { fileid: 'original-file-two', url: 'https://sns-img.example/second.png' },
] };
const nativeNoteUrl = (operation) => `https://edith.xiaohongshu.com/web_api/sns/capa/postgw/note/${operation}`;
const managementImpression = (target = id, pointId = 50977) => JSON.stringify({ event: { value: { pointId } }, noteTarget: { value: { noteId: target } } });
const mutationRequest = () => ({ common: { note_id: id, type: 'normal', title: mutationInput.title, desc: mutationInput.body },
  image_info: { images: originalDetail.images_list.map((image) => ({ file_id: image.fileid })) } });
function nativeMutationResponse({ operation = 'update', url = nativeNoteUrl(operation), method = operation === 'update' ? 'PUT' : 'POST',
  payload = operation === 'update' ? mutationRequest() : { note_id: id }, raw = '{"success":true,"code":0}', ok = true } = {}) {
  return { url: () => url, request: () => ({ method: () => method, postData: () => typeof payload === 'string' ? payload : JSON.stringify(payload) }),
    ok: () => ok, text: async () => raw };
}

test('mutation validation binds the original note and author and only permits text changes', () => {
  const value = validateXiaohongshuMutation({ ...mutationInput, title: ' 修改后的标题 ', body: ' 正文 ' }, 'update');
  assert.equal(value.receipt, mutationReceipt); assert.equal(value.title, '修改后的标题'); assert.equal(value.body, '正文');
  assert.deepEqual(validateXiaohongshuMutation({ receipt: mutationReceipt, expectedAccountUid: uid }, 'delete'), { receipt: mutationReceipt });
  for (const change of [{ receipt: null }, { receipt: { ...mutationReceipt, id: 'invalid' } },
    { receipt: { ...mutationReceipt, url: `${mutationReceipt.url}?other=1` } },
    { receipt: { ...mutationReceipt, url: `https://www.xiaohongshu.com.evil.test/explore/${id}` } },
    { receipt: { ...mutationReceipt, account: { ...account, uid: 'c'.repeat(24) } } }, { expectedAccountUid: 'c'.repeat(24) }]) {
    assert.throws(() => validateXiaohongshuMutation({ ...mutationInput, ...change }, 'update'), { code: 'ACCOUNT_CHANGED' });
  }
  for (const images of [undefined, [], [image]]) assert.throws(() => validateXiaohongshuMutation({ ...mutationInput, images }, 'update'), { code: 'OPERATION_UNSUPPORTED' });
  for (const change of [{ title: '' }, { title: '😀'.repeat(21) }, { body: '😀'.repeat(1001) }, { body: 'bad\0body' }, { title: 123 }]) {
    assert.throws(() => validateXiaohongshuMutation({ ...mutationInput, ...change }, 'update'), { code: 'PUBLISH_REJECTED' });
  }
});

test('managed note IDs come only from the exact native impression event and target fields', () => {
  assert.equal(xiaohongshuManagedNoteId(managementImpression()), id);
  for (const value of [undefined, null, '', '{', 'null', '{}', managementImpression('invalid'), managementImpression(id, 50978),
    managementImpression(id, '50977'), JSON.stringify({ event: { pointId: 50977 }, noteTarget: { value: { noteId: id } } }),
    JSON.stringify({ event: { value: { pointId: 50977 } }, noteTarget: { noteId: id }, title: id })]) {
    assert.equal(xiaohongshuManagedNoteId(value), undefined);
  }
});

test('original detail observation requires the exact official GET target and edit mode', () => {
  const url = `${nativeNoteUrl('detail')}?note_id=${id}&edit_mode=1`;
  const response = (change = {}) => nativeMutationResponse({ url, method: 'GET', ...change });
  assert.equal(isXiaohongshuDetailResponse(response(), id), true);
  for (const change of [{ method: 'POST' }, { url: url.replace('edith.xiaohongshu.com', 'edith.xiaohongshu.com.evil.test') },
    { url: url.replace(id, 'c'.repeat(24)) }, { url: url.replace('edit_mode=1', 'edit_mode=0') },
    { url: url.replace('&edit_mode=1', '') }, { url: url.replace('/detail?', '/detail/other?') }]) {
    assert.equal(isXiaohongshuDetailResponse(response(change), id), false);
  }
});

test('original detail requires confirmed normal content with an intact ordered image set', () => {
  const raw = (data) => JSON.stringify({ success: true, code: 0, data });
  assert.deepEqual(xiaohongshuOriginalDetail(raw({ ...originalDetail, desc: ' 原文\r\n第二行 ' }), mutationReceipt), {
    title: originalDetail.title, body: '原文\n第二行', images: originalDetail.images_list.map((image) => ({ id: image.fileid, source: image.url })),
  });
  for (const change of [{ type: 'video' }, { id: 'c'.repeat(24) }, { note_id: 'c'.repeat(24) }, { user_id: 'c'.repeat(24) },
    { author_id: 'c'.repeat(24) }, { user: { user_id: 'c'.repeat(24) } }, { title: null }, { desc: null },
    { images_list: [] }, { images_list: Array(19).fill(originalDetail.images_list[0]) },
    { images_list: [originalDetail.images_list[0], originalDetail.images_list[0]] },
    { images_list: [{ fileid: '', url: 'https://sns-img.example/one.png' }] }, { images_list: [{ fileid: 'one' }] }]) {
    assert.throws(() => xiaohongshuOriginalDetail(raw({ ...originalDetail, ...change }), mutationReceipt), { code: 'OPERATION_UNSUPPORTED' });
  }
  for (const body of ['<html>', '{}', JSON.stringify({ code: 0, data: originalDetail }), JSON.stringify({ success: false, code: 0, data: originalDetail })]) {
    assert.throws(() => xiaohongshuOriginalDetail(body, mutationReceipt), { code: 'OPERATION_UNSUPPORTED' });
  }
});

test('native update observation binds PUT, original ID, exact text and original file ID order', () => {
  const expected = { title: mutationInput.title, body: mutationInput.body, imageIds: originalDetail.images_list.map((image) => image.fileid) };
  assert.equal(isXiaohongshuMutationResponse(nativeMutationResponse(), 'update', mutationReceipt, expected), true);
  const valid = mutationRequest();
  const invalidPayloads = ['not-json', null, {}, { ...valid, common: { ...valid.common, note_id: 'c'.repeat(24) } },
    { ...valid, common: { ...valid.common, type: 'video' } }, { ...valid, common: { ...valid.common, title: `${mutationInput.title} changed` } },
    { ...valid, common: { ...valid.common, desc: `${mutationInput.body}\n` } },
    { ...valid, image_info: { images: [...valid.image_info.images].reverse() } },
    { ...valid, image_info: { images: [valid.image_info.images[0]] } },
    { ...valid, image_info: { images: [{ fileid: 'original-file-one' }, { fileid: 'original-file-two' }] } },
    { ...valid, image_info: { images: [...valid.image_info.images, { file_id: 'third' }] } }];
  for (const payload of invalidPayloads) assert.equal(isXiaohongshuMutationResponse(nativeMutationResponse({ payload }), 'update', mutationReceipt, expected), false);
  for (const change of [{ method: 'POST' }, { url: nativeNoteUrl('delete') },
    { url: nativeNoteUrl('update').replace('edith.xiaohongshu.com', 'edith.xiaohongshu.com.evil.test') }]) {
    assert.equal(isXiaohongshuMutationResponse(nativeMutationResponse(change), 'update', mutationReceipt, expected), false);
  }
});

test('native delete observation binds POST and the exact original target ID', () => {
  const response = (change = {}) => nativeMutationResponse({ operation: 'delete', ...change });
  assert.equal(isXiaohongshuMutationResponse(response(), 'delete', mutationReceipt), true);
  for (const change of [{ method: 'DELETE' }, { method: 'GET' }, { method: 'PUT' }, { url: nativeNoteUrl('update') },
    { url: nativeNoteUrl('delete').replace('edith.xiaohongshu.com', 'evil.test') }, { payload: { note_id: 'c'.repeat(24) } },
    { payload: { id } }, { payload: '{}' }, { payload: 'not-json' }]) {
    assert.equal(isXiaohongshuMutationResponse(response(change), 'delete', mutationReceipt), false);
  }
});

test('mutation receipts require explicit success and cannot substitute another note or author', () => {
  const now = () => new Date('2026-09-15T00:00:00.000Z');
  for (const operation of ['update', 'delete']) {
    const field = operation === 'update' ? 'updatedAt' : 'deletedAt';
    assert.deepEqual(confirmedXiaohongshuMutation('{"success":true,"code":0}', operation, mutationReceipt, now), { ...mutationReceipt, [field]: now().toISOString() });
    for (const raw of ['<html>', '{}', '{"code":0}', '{"result":0}', '{"success":false,"code":0}',
      '{"success":true,"code":-1}', '{"success":true,"result":-1}',
      ...[{ id: 'c'.repeat(24) }, { note_id: 'c'.repeat(24) }, { user_id: 'c'.repeat(24) }, { author_id: 'c'.repeat(24) },
        { user: { user_id: 'c'.repeat(24) } }].map((data) => JSON.stringify({ success: true, code: 0, data }))]) {
      assert.throws(() => confirmedXiaohongshuMutation(raw, operation, mutationReceipt, now), { code: 'PUBLISH_UNCERTAIN' });
    }
  }
});

// Runs the production capture guard in a separate JS realm with a minimal DOM.
// Native handlers run only when the guard lets the synthetic input event pass.
class DeleteGuardFixture {
  constructor(page) {
    this.page = page; this.listeners = new Map(); this.observers = new Set(); this.modals = [];
    this.impressions = page?.rowImpressions || [managementImpression('c'.repeat(24)), managementImpression()];
    this.root = this.element('document');
    this.rows = this.impressions.map((_, index) => {
      const row = this.element(`row-${index}`), entry = this.element(`entry-${index}`), child = this.element(`entry-icon-${index}`);
      row.children.push(entry); entry.children.push(child); row.entry = entry; entry.child = child;
      row.getAttribute = () => this.impressions[index];
      row.querySelector = () => page?.options.noDelete ? null : entry;
      this.root.children.push(row);
      return row;
    });
    const document = { documentElement: this.root,
      querySelectorAll: (selector) => {
        if (selector === '.note-card[data-impression]') return this.rows.filter((row) => row.isConnected);
        if (selector === '.modal-container') return this.modals.filter((modal) => modal.isConnected);
        throw new Error(`Unexpected guard selector ${selector}`);
      },
      addEventListener: (name, callback) => { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); },
      removeEventListener: (name, callback) => this.listeners.get(name)?.delete(callback),
    };
    const fixture = this;
    this.realm = createContext({ document, getComputedStyle: () => ({ visibility: 'visible' }), MutationObserver: class {
      constructor(callback) { this.callback = callback; this.records = []; }
      observe() { fixture.observers.add(this); }
      disconnect() { fixture.observers.delete(this); this.records = []; }
      takeRecords() { return this.records.splice(0); }
    } });
    this.realm.guardFunction = runInContext(`(${xiaohongshuDeleteGuardDom.toString()})`, this.realm);
  }
  element(name) {
    const element = { name, isConnected: true, children: [], innerText: '', attributes: {},
      getAttribute: (name) => element.attributes[name] ?? null, getBoundingClientRect: () => ({ width: 100, height: 40 }),
      contains: (other) => element === other || element.children.some((child) => child.contains(other)) };
    return element;
  }
  evaluate(args) {
    this.realm.guardArguments = args;
    return structuredClone(runInContext('guardFunction(guardArguments)', this.realm));
  }
  guard(action) { return this.evaluate({ action, key: '__fixture_guard', id, title: originalDetail.title }); }
  record(record) { for (const observer of this.observers) observer.records.push(record); }
  showModal() {
    const options = this.page?.options || {};
    const modal = this.element('modal'), final = this.element('final'), heading = this.element('heading'), child = this.element('final-icon');
    final.children.push(child); final.child = child; modal.children.push(final, heading); modal.final = final;
    Object.defineProperty(modal, 'innerText', { get: () => options.dialogText ?? `删除后将无法恢复，确定要删除《${originalDetail.title.slice(0, 10)}》这篇笔记吗` });
    Object.defineProperty(heading, 'innerText', { get: () => options.dialogHeading ?? '删除笔记' });
    Object.defineProperty(final, 'innerText', { get: () => options.confirmLabel ?? '确定' });
    modal.querySelector = () => heading;
    modal.querySelectorAll = () => options.missingConfirm ? [] : [final];
    this.modals.push(modal); this.root.children.push(modal); this.modal = modal;
    this.record({ type: 'childList', target: this.root, addedNodes: [modal], removedNodes: [] });
    return modal;
  }
  replaceModal() {
    const previous = this.modal; previous.isConnected = false;
    this.modals = this.modals.filter((modal) => modal !== previous);
    this.root.children = this.root.children.filter((element) => element !== previous);
    const next = this.showModal();
    this.record({ type: 'childList', target: this.root, addedNodes: [next], removedNodes: [previous] });
    return next;
  }
  dispatch(name, target, key) {
    const event = { target, key, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.propagationStopped = true; } };
    for (const callback of this.listeners.get(name) || []) { callback(event); if (event.propagationStopped) break; }
    return event;
  }
  click(target) { return this.dispatch('click', target); }
  key(key) { return this.dispatch('keydown', this.root, key); }
  assertDisposed() {
    assert.equal([...this.listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0), 0);
    assert.equal(this.observers.size, 0);
    assert.equal(Object.keys(this.realm).some((key) => key.startsWith('__fatiao_delete_') || key === '__fixture_guard'), false);
  }
}

test('delete capture guard permits only the bound original entry and one armed final click', () => {
  const dom = new DeleteGuardFixture();
  assert.deepEqual(dom.guard('install'), { valid: true, accepted: false });
  assert.equal(dom.click(dom.rows[1].entry.child).defaultPrevented, false);
  dom.showModal();
  assert.deepEqual(dom.guard('check'), { valid: true, accepted: false });
  assert.deepEqual(dom.guard('arm'), { valid: true, accepted: false });
  assert.equal(dom.click(dom.modal.final.child).defaultPrevented, false);
  assert.equal(dom.guard('check').accepted, true);
  const duplicate = dom.click(dom.modal.final);
  assert.equal(duplicate.defaultPrevented, true); assert.equal(duplicate.propagationStopped, true);
  dom.guard('dispose'); dom.assertDisposed();
});

test('delete capture guard blocks an identically titled replacement modal or another row entry', () => {
  for (const tamper of [(dom) => dom.replaceModal(), (dom) => dom.click(dom.rows[0].entry)]) {
    const dom = new DeleteGuardFixture(); dom.guard('install'); dom.click(dom.rows[1].entry); dom.showModal();
    dom.guard('check'); dom.guard('arm'); tamper(dom);
    const final = dom.click(dom.modal.final);
    assert.equal(final.defaultPrevented, true); assert.equal(final.propagationStopped, true);
    assert.deepEqual(dom.guard('check'), { valid: false, accepted: false });
    dom.guard('dispose'); dom.assertDisposed();
  }
});

test('delete capture guard permanently disarms on Escape, other keys, cancel or early confirmation', () => {
  for (const tamper of [(dom) => dom.key('Escape'), (dom) => dom.key('Enter'), (dom) => dom.key(' '),
    (dom) => dom.key('a'), (dom) => dom.click(dom.element('cancel')), (dom) => dom.click(dom.modal.final)]) {
    const dom = new DeleteGuardFixture(); dom.guard('install'); dom.click(dom.rows[1].entry); dom.showModal(); dom.guard('check');
    tamper(dom);
    assert.deepEqual(dom.guard('arm'), { valid: false, accepted: false });
    assert.equal(dom.click(dom.modal.final).defaultPrevented, true);
    dom.guard('dispose'); dom.assertDisposed();
  }
});

test('delete capture guard rechecks original row identity synchronously at the final click', () => {
  const dom = new DeleteGuardFixture(); dom.guard('install'); dom.click(dom.rows[1].entry); dom.showModal(); dom.guard('check'); dom.guard('arm');
  dom.impressions.reverse();
  const final = dom.click(dom.modal.final);
  assert.equal(final.defaultPrevented, true); assert.equal(final.propagationStopped, true);
  dom.impressions.reverse();
  assert.deepEqual(dom.guard('check'), { valid: false, accepted: false });
  dom.guard('dispose'); dom.assertDisposed();
});

test('delete capture guard cannot become valid again after an observed original-row mismatch', () => {
  const dom = new DeleteGuardFixture(); dom.guard('install'); dom.click(dom.rows[1].entry); dom.showModal(); dom.guard('check');
  dom.impressions.reverse();
  assert.equal(dom.guard('check').valid, false);
  dom.impressions.reverse();
  assert.deepEqual(dom.guard('arm'), { valid: false, accepted: false });
  assert.equal(dom.click(dom.modal.final).defaultPrevented, true);
  dom.guard('dispose'); dom.assertDisposed();
});

test('delete capture guard drains pending DOM mutations before the native final handler runs', () => {
  for (const record of [(dom) => ({ type: 'childList', target: dom.root, addedNodes: [dom.modal], removedNodes: [dom.modal] }),
    (dom) => ({ type: 'childList', target: dom.modal, addedNodes: [], removedNodes: [] }),
    (dom) => ({ type: 'attributes', target: dom.modal, attributeName: 'style', oldValue: 'display: none' })]) {
    const dom = new DeleteGuardFixture(); dom.guard('install'); dom.click(dom.rows[1].entry); dom.showModal(); dom.guard('check'); dom.guard('arm');
    dom.record(record(dom));
    assert.equal(dom.click(dom.modal.final).defaultPrevented, true);
    assert.deepEqual(dom.guard('check'), { valid: false, accepted: false });
    dom.guard('dispose'); dom.assertDisposed();
  }
});

test('delete capture guard allows normal modal entrance classes and page overflow changes', () => {
  const dom = new DeleteGuardFixture(); dom.guard('install'); dom.click(dom.rows[1].entry); dom.showModal(); dom.guard('check');
  dom.modal.attributes.class = 'modal-container';
  dom.root.attributes.class = 'page';
  dom.root.attributes.style = 'overflow: hidden';
  dom.record({ type: 'attributes', target: dom.modal, attributeName: 'class', oldValue: 'modal-container fade-enter-active fade-enter-to' });
  dom.record({ type: 'attributes', target: dom.root, attributeName: 'class', oldValue: 'page fade-enter-active' });
  dom.record({ type: 'attributes', target: dom.root, attributeName: 'style', oldValue: 'overflow: auto' });
  assert.deepEqual(dom.guard('arm'), { valid: true, accepted: false });
  assert.equal(dom.click(dom.modal.final).defaultPrevented, false); assert.equal(dom.guard('check').accepted, true);
  dom.guard('dispose'); dom.assertDisposed();
});

test('delete capture guard permanently blocks hide-and-show mutations even after current DOM looks identical', () => {
  for (const [attributeName, oldValue, current] of [['style', 'display: none', 'display: block'],
    ['style', 'visibility: hidden', 'visibility: visible'], ['class', 'modal-leave-active', 'modal-container'],
    ['class', 'modal-container hidden', 'modal-container'], ['aria-hidden', 'true', 'false'], ['hidden', '', null]]) {
    for (const ancestor of [false, true]) {
      const dom = new DeleteGuardFixture(); dom.guard('install'); dom.click(dom.rows[1].entry); dom.showModal(); dom.guard('check'); dom.guard('arm');
      const target = ancestor ? dom.root : dom.modal;
      target.attributes[attributeName] = current;
      dom.record({ type: 'attributes', target, attributeName, oldValue });
      assert.equal(dom.click(dom.modal.final).defaultPrevented, true);
      assert.deepEqual(dom.guard('check'), { valid: false, accepted: false });
      dom.guard('dispose'); dom.assertDisposed();
    }
  }
});

class MutationPage extends FixturePage {
  async route(matcher, guard) { this.updateGuard = guard; }
  async unroute() { this.updateGuard = undefined; }
  constructor(options = {}) {
    super(options);
    this.detail = structuredClone(options.detailData ?? originalDetail);
    this.rowImpressions = options.impressions || [managementImpression('c'.repeat(24)), managementImpression()];
    this.pictureSources = []; this.modalOpen = Boolean(options.existingModal); this.nativeRequests = [];
    this.root.evaluate = async () => ({ count: options.pictureCount ?? this.pictureSources.length,
      ready: options.pictureReady ?? this.pictureSources.length, failed: Boolean(options.pictureFailed), sources: [...this.pictureSources] });
    const rootLocator = this.root.locator;
    this.root.locator = (selector) => selector.includes('max_suffix') ? { count: async () => options.lengthError ? 1 : 0 } : rootLocator(selector);
    this.button.isEnabled = async () => !options.disabled;
    this.button.getAttribute = async (name) => name === 'submit-disabled' && options.disabled ? 'true' : null;
    this.button.click = async (options) => { assert.equal(options.position, undefined, 'the edit submit button is centered, unlike the new-note split widget'); return this.submitMutation('update'); };
    this.confirmButton = { count: async () => options.missingConfirm ? 0 : 1, innerText: async () => options.confirmLabel ?? '确定',
      isVisible: async () => true, isEnabled: async () => !options.disabled,
      click: async () => this.submitMutation('delete') };
    this.modal = { count: async () => options.modalCount ?? (this.modalOpen ? 1 : 0), first: () => this.modal,
      waitFor: async () => {}, innerText: async () => options.dialogText ?? `删除后将无法恢复，确定要删除《${originalDetail.title.slice(0, 10)}》这篇笔记吗`,
      locator: (selector) => {
        if (selector === '.modal-title') return { innerText: async () => options.dialogHeading ?? '删除笔记' };
        if (selector === '.modal-footer .confirm-button') return this.confirmButton;
        throw new Error(`Unexpected modal selector ${selector}`);
      } };
    this.rows = { evaluateAll: async (callback) => callback(this.rowImpressions.map((value) => ({ getAttribute: () => value }))),
      nth: (index) => this.row(index) };
  }
  row(index) {
    return { count: async () => this.rowImpressions[index] === undefined ? 0 : 1,
      getAttribute: async () => this.rowImpressions[index], hover: async () => { this.events.push(`hover-row-${index}`); },
      locator: (selector) => {
        if (selector === '.note-card__title') return { innerText: async () => originalDetail.title };
        if (selector.startsWith('.note-card__action-btn--del')) return { count: async () => this.options.noDelete ? 0 : 1,
          isVisible: async () => true, isEnabled: async () => !this.options.disabled,
          click: async () => {
            this.events.push(`open-delete-${index}`);
            if (this.guardDom?.click(this.guardDom.rows[index].entry).defaultPrevented) return;
            this.modalOpen = true; this.deleteTarget = xiaohongshuManagedNoteId(this.rowImpressions[index]); this.guardDom?.showModal();
          } };
        throw new Error(`Unexpected row selector ${selector}`);
      } };
  }
  locator(selector) {
    if (selector === '.note-card[data-impression]:visible') return this.rows;
    if (selector === '.modal-container:visible') return this.modal;
    return super.locator(selector);
  }
  async evaluate(...args) {
    if (args[0] === xiaohongshuDeleteGuardDom) {
      this.guardDom ||= new DeleteGuardFixture(this);
      return this.guardDom.evaluate(args[1]);
    }
    const result = await super.evaluate(...args);
    await this.options.onAccountRead?.(this, this.accountReads);
    return result;
  }
  async goto(url) {
    this.location = url;
    if (new URL(url).pathname === '/new/note-manager') { this.events.push('navigate-manager'); return; }
    this.events.push('navigate-update');
    this.location = this.options.editRoute || url;
    this.title = this.options.originalTitle ?? this.detail.title;
    this.body = this.options.originalBody ?? this.detail.desc;
    this.pictureSources = [...(this.options.previewSources ?? this.detail.images_list?.map((image) => image.url) ?? [])];
    if (this.options.noDetail) return;
    this.emit('response', nativeMutationResponse({ url: this.options.detailUrl ?? `${nativeNoteUrl('detail')}?note_id=${id}&edit_mode=1`,
      method: this.options.detailMethod ?? 'GET', ok: this.options.detailOk ?? true,
      raw: this.options.detailRaw ?? JSON.stringify({ success: true, code: 0, data: this.detail }) }));
  }
  async submitMutation(operation) {
    if (operation === 'delete') await this.options.beforeDeleteClick?.(this);
    if (operation === 'delete' && this.guardDom?.click(this.guardDom.modal.final).defaultPrevented) {
      this.events.push('blocked-delete-click'); return;
    }
    this.events.push(`${operation}-click`);
    if (this.options.clickError) throw new Error('native click interrupted');
    const payload = this.options.nativePayload ?? (operation === 'update' ? { common: { note_id: id, type: 'normal', title: this.title, desc: this.body },
      image_info: { images: this.detail.images_list.map((image) => ({ file_id: image.fileid })) } } : { note_id: this.deleteTarget });
    this.nativeRequests.push({ operation, payload });
    if (this.options.closeOnClick) { this.emit('close'); return; }
    if (this.options.noResponse) return;
    this.emit('response', nativeMutationResponse({ operation, payload, raw: this.options.mutationRaw ?? '{"success":true,"code":0}',
      method: this.options.nativeMethod ?? (operation === 'update' ? 'PUT' : 'POST'), url: this.options.nativeUrl ?? nativeNoteUrl(operation), ok: this.options.nativeOk ?? true }));
  }
}
const mutationAdapter = () => createXiaohongshuAdapter({ mutationTimeoutMs: 5 });
test('update reconciliation only reads the exact official original and never resubmits', async () => {
  for (const matches of [true, false]) {
    const page = new MutationPage({ detailData: { ...originalDetail, title: mutationInput.title,
      desc: matches ? mutationInput.body : originalDetail.desc } });
    const pending = mutationAdapter().reconcileOperation(page, mutationInput, { operation: 'update', attemptedAt: '2026-09-14T00:00:00Z' });
    if (matches) assert.ok((await pending).updatedAt);
    else await assert.rejects(pending, { code: 'OPERATION_UNCERTAIN' });
    assert.deepEqual(page.nativeRequests, []);
    assert.deepEqual(page.events, ['navigate-manager', 'navigate-update']);
    noMutationListeners(page);
  }
});
function noMutationListeners(page) {
  assert.equal(page.listenerCount('response'), 0); assert.equal(page.listenerCount('close'), 0);
  page.guardDom?.assertDisposed();
}

test('native update loads the bound original detail, preserves both images, and clicks once after checkpoint', async () => {
  const page = new MutationPage();
  const result = await mutationAdapter().update(page, mutationInput, { beforeSubmit: async () => {
    page.events.push('checkpoint'); assert.equal(page.nativeRequests.length, 0); assert.equal(page.files.length, 0);
    assert.deepEqual(page.pictureSources, originalDetail.images_list.map((image) => image.url));
  } });
  assert.equal(result.id, id); assert.equal(result.url, mutationReceipt.url); assert.equal(result.account.uid, uid);
  assert.ok(Number.isFinite(Date.parse(result.updatedAt))); assert.equal(result.publishedAt, mutationReceipt.publishedAt);
  assert.deepEqual(page.events, ['navigate-manager', 'navigate-update', 'fill-title', 'fill-body', 'checkpoint', 'update-click']);
  assert.deepEqual(page.nativeRequests, [{ operation: 'update', payload: mutationRequest() }]);
  assert.equal(page.accountReads, 5); assert.equal(page.files.length, 0); noMutationListeners(page);
});

test('native delete selects the exact original row and confirms once after checkpoint', async () => {
  const page = new MutationPage();
  const result = await mutationAdapter().delete(page, mutationInput, { beforeSubmit: async () => {
    page.events.push('checkpoint'); assert.equal(page.nativeRequests.length, 0);
  } });
  assert.equal(result.id, id); assert.equal(result.url, mutationReceipt.url); assert.equal(result.account.uid, uid);
  assert.ok(Number.isFinite(Date.parse(result.deletedAt))); assert.equal(result.publishedAt, mutationReceipt.publishedAt);
  assert.deepEqual(page.events, ['navigate-manager', 'hover-row-1', 'open-delete-1', 'checkpoint', 'delete-click']);
  assert.deepEqual(page.nativeRequests, [{ operation: 'delete', payload: { note_id: id } }]);
  assert.equal(page.accountReads, 5); assert.equal(page.files.length, 0); noMutationListeners(page);
});

for (const operation of ['update', 'delete']) {
  test(`${operation} rejects missing checkpoint before touching a platform page`, async () => {
    await assert.rejects(mutationAdapter()[operation]({}, mutationInput), { code: 'PUBLISH_REJECTED' });
  });

  test(`${operation} requires the current original author and a unique native management row`, async () => {
    for (const [options, code] of [[{ accountUids: ['c'.repeat(24)] }, 'ACCOUNT_CHANGED'], [{ loggedOut: true }, 'LOGIN_REQUIRED'],
      [{ challenge: true }, 'CAPTCHA_REQUIRED'], [{ impressions: [managementImpression('c'.repeat(24))] }, 'OPERATION_UNSUPPORTED'],
      [{ impressions: [managementImpression(), managementImpression()] }, 'UI_CHANGED'],
      [{ impressions: [managementImpression(id, 50978)] }, 'OPERATION_UNSUPPORTED'],
      [{ accountUids: [uid, 'c'.repeat(24)] }, 'ACCOUNT_CHANGED']]) {
      const page = new MutationPage(options);
      await assert.rejects(mutationAdapter()[operation](page, mutationInput, { beforeSubmit: async () => assert.fail('must not checkpoint') }), { code });
      assert.equal(page.events.includes(`${operation}-click`), false); assert.equal(page.files.length, 0); noMutationListeners(page);
    }
  });

  test(`${operation} checkpoint failure cannot click the irreversible native action`, async () => {
    const page = new MutationPage();
    const checkpointError = new Error('checkpoint storage unavailable');
    await assert.rejects(mutationAdapter()[operation](page, mutationInput, { beforeSubmit: async () => { throw checkpointError; } }), (error) => {
      assert.equal(error, checkpointError); assert.notEqual(error.submitted, true); return true;
    });
    assert.equal(page.events.includes(`${operation}-click`), false); noMutationListeners(page);
  });

  test(`${operation} post-checkpoint account changes retain submitted state and prevent clicking`, async () => {
    const page = new MutationPage();
    await assert.rejects(mutationAdapter()[operation](page, mutationInput, { beforeSubmit: async () => {
      page.options.accountUids = [uid, uid, uid, uid, 'c'.repeat(24)];
    } }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
    assert.equal(page.events.includes(`${operation}-click`), false); noMutationListeners(page);
  });

  test(`${operation} unconfirmed or mismatched native responses remain uncertain after one click`, async () => {
    for (const options of [{ mutationRaw: '{}' }, { mutationRaw: '{"code":0}' }, { mutationRaw: '{"success":false,"code":0}' },
      { mutationRaw: JSON.stringify({ success: true, code: 0, data: { note_id: 'c'.repeat(24) } }) },
      { nativePayload: operation === 'update' ? { ...mutationRequest(), common: { ...mutationRequest().common, note_id: 'c'.repeat(24) } } : { note_id: 'c'.repeat(24) } },
      { nativeMethod: 'GET' }, { nativeOk: false }, { clickError: true }, { noResponse: true }, { closeOnClick: true }]) {
      const page = new MutationPage(options);
      await assert.rejects(mutationAdapter()[operation](page, mutationInput, { beforeSubmit: async () => {} }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
      assert.equal(page.events.filter((event) => event === `${operation}-click`).length, 1); noMutationListeners(page);
    }
  });
}

test('update stops before checkpoint if original detail, editing route, text or images differ', async () => {
  for (const [options, code] of [[{ noDetail: true }, 'OPERATION_UNSUPPORTED'], [{ detailMethod: 'POST' }, 'OPERATION_UNSUPPORTED'],
    [{ detailUrl: `${nativeNoteUrl('detail')}?note_id=${'c'.repeat(24)}&edit_mode=1` }, 'OPERATION_UNSUPPORTED'],
    [{ detailRaw: '{"code":0}' }, 'OPERATION_UNSUPPORTED'], [{ detailData: { ...originalDetail, user_id: 'c'.repeat(24) } }, 'OPERATION_UNSUPPORTED'],
    [{ editRoute: `https://creator.xiaohongshu.com/publish/publish?id=${id}` }, 'UI_CHANGED'],
    [{ originalTitle: '另一篇标题' }, 'UI_CHANGED'], [{ originalBody: '另一篇正文' }, 'UI_CHANGED'],
    [{ pictureFailed: true }, 'IMAGE_UPLOAD_FAILED'], [{ pictureCount: 3 }, 'IMAGE_UPLOAD_FAILED'],
    [{ pictureReady: 1 }, 'OPERATION_UNSUPPORTED'], [{ disabled: true }, 'UI_CHANGED'], [{ lengthError: true }, 'PUBLISH_REJECTED'],
    [{ accountUids: [uid, uid, uid, 'c'.repeat(24)] }, 'ACCOUNT_CHANGED']]) {
    const page = new MutationPage(options);
    await assert.rejects(mutationAdapter().update(page, mutationInput, { beforeSubmit: async () => assert.fail('must not checkpoint') }), { code });
    assert.equal(page.events.includes('update-click'), false); assert.equal(page.files.length, 0); noMutationListeners(page);
  }
});

test('update rechecks text, image order and route after checkpoint and after the final identity read', async () => {
  for (const mutate of [(page) => { page.title = '被改动的标题'; }, (page) => { page.body = '被改动的正文'; },
    (page) => page.pictureSources.reverse(), (page) => page.pictureSources.pop(),
    (page) => { page.location = page.location.replace(id, 'c'.repeat(24)); }]) {
    const page = new MutationPage();
    await assert.rejects(mutationAdapter().update(page, mutationInput, { beforeSubmit: async () => mutate(page) }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
    assert.equal(page.events.includes('update-click'), false); noMutationListeners(page);
    const changedDuringIdentity = new MutationPage({ onAccountRead: (page, reads) => { if (reads === 5) mutate(page); } });
    await assert.rejects(mutationAdapter().update(changedDuringIdentity, mutationInput, { beforeSubmit: async () => {} }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
    assert.equal(changedDuringIdentity.events.includes('update-click'), false); noMutationListeners(changedDuringIdentity);
  }
});

test('delete requires an available native action and an unambiguous original-title confirmation', async () => {
  for (const [options, code] of [[{ existingModal: true }, 'UI_CHANGED'], [{ noDelete: true }, 'UI_CHANGED'],
    [{ disabled: true }, 'OPERATION_UNSUPPORTED'], [{ dialogHeading: '其他操作' }, 'UI_CHANGED'],
    [{ dialogText: '删除后将无法恢复，确定要删除《其他标题》这篇笔记吗' }, 'UI_CHANGED'],
    [{ modalCount: 2 }, 'UI_CHANGED'], [{ missingConfirm: true }, 'UI_CHANGED'], [{ confirmLabel: '删除全部' }, 'UI_CHANGED']]) {
    const page = new MutationPage(options);
    await assert.rejects(mutationAdapter().delete(page, mutationInput, { beforeSubmit: async () => assert.fail('must not checkpoint') }), { code });
    assert.equal(page.events.includes('delete-click'), false); noMutationListeners(page);
  }
});

test('delete rechecks the original row and confirmation after checkpoint before its only final click', async () => {
  for (const mutate of [(page) => { page.rowImpressions[1] = managementImpression('c'.repeat(24)); },
    (page) => { page.options.dialogText = '删除另一篇笔记'; }, (page) => { page.options.modalCount = 2; },
    (page) => { page.location = 'https://creator.xiaohongshu.com/publish/publish'; }]) {
    const page = new MutationPage();
    await assert.rejects(mutationAdapter().delete(page, mutationInput, { beforeSubmit: async () => mutate(page) }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
    assert.equal(page.events.includes('delete-click'), false); noMutationListeners(page);
  }
});

test('delete capture guard stops a same-title modal swap at the final click without issuing a native request', async () => {
  for (const tamper of [(page) => page.guardDom.replaceModal(), (page) => page.guardDom.click(page.guardDom.rows[0].entry),
    (page) => page.guardDom.key('Escape'), (page) => page.rowImpressions.reverse()]) {
    const page = new MutationPage({ beforeDeleteClick: tamper });
    await assert.rejects(mutationAdapter().delete(page, mutationInput, { beforeSubmit: async () => {} }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
    assert.equal(page.events.filter((event) => event === 'blocked-delete-click').length, 1);
    assert.equal(page.events.includes('delete-click'), false); assert.deepEqual(page.nativeRequests, []); noMutationListeners(page);
  }
});

test('isolated Chrome uses the real Xiaohongshu selectors and uploads two fixture images', { skip: process.env.FATIAO_PLATFORM_DOM_TEST !== '1' }, async () => {
  const { chromium } = await import('playwright');
  const { mkdtemp, realpath, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const profile = await mkdtemp(path.join(await realpath(os.tmpdir()), 'fatiao-xhs-dom-'));
  let browser;
  try {
    browser = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, serviceWorkers: 'block' });
    const page = browser.pages()[0] || await browser.newPage();
    const sent = [];
    const html = `<!doctype html><meta charset="utf-8"><style>.img-container img{width:60px;height:60px} xhs-publish-btn{display:inline-block;width:120px;height:40px;background:red} .mask{display:block} [contenteditable]{min-height:50px}</style>
      <section class="publish"><div class="upload-content"><div class="creator-tab">上传图文</div><input class="upload-input" type="file" accept="image/*"></div>
      <div class="img-list"><input type="file" multiple accept="image/*"><div class="img-preview-area"></div></div>
      <div class="d-input"><input placeholder="填写标题"></div><div role="textbox" contenteditable="true"></div><xhs-publish-btn is-publish="true">发布</xhs-publish-btn></section>
      <script>for(const input of document.querySelectorAll('input[type=file]'))input.addEventListener('change',()=>{for(const file of input.files){const tile=document.createElement('div');tile.className='img-container';const img=document.createElement('img');img.src=URL.createObjectURL(file);tile.append(img);const mask=document.createElement('div');mask.className='mask hover-mask';mask.innerHTML='<span class="close-btn">删除</span>';tile.append(mask);document.querySelector('.img-preview-area').append(tile)}});
      document.querySelector('xhs-publish-btn').addEventListener('click',()=>fetch('https://edith.xiaohongshu.com/web_api/sns/v2/note',{method:'POST',body:JSON.stringify({title:document.querySelector('.d-input input').value,body:document.querySelector('[contenteditable]').innerText,images:document.querySelectorAll('.img-container').length})}));</script>`;
    await page.route('**/*', async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (url.origin === 'https://creator.xiaohongshu.com' && url.pathname === '/publish/publish') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.origin === 'https://creator.xiaohongshu.com' && url.pathname === '/api/galaxy/user/my-info' && request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 0, success: true, data: { userDetail: { id: uid, nickName: account.name, url: 'https://images.example/avatar.png' }, permissions: ['POST'] } }) });
      if (url.href === 'https://edith.xiaohongshu.com/web_api/sns/v2/note' && request.method() === 'POST') {
        sent.push(JSON.parse(request.postData()));
        return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ code: 0, data: { id } }) });
      }
      return route.abort();
    });
    await page.goto('https://creator.xiaohongshu.com/publish/publish?source=official&target=image');
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=';
    let checkpoints = 0;
    const result = await createXiaohongshuAdapter().publish(page, { ...input, images: [png, png] }, { beforeSubmit: async () => { checkpoints++; assert.equal(sent.length, 0); } });
    assert.equal(result.id, id); assert.equal(checkpoints, 1);
    assert.deepEqual(sent, [{ title: input.title, body: input.body, images: 2 }]);
  } finally {
    await browser?.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('edit thumbnails may change URLs but native update with changed image IDs is blocked before transmission', async () => {
  const page = new MutationPage({ previewSources: originalDetail.images_list.map(image => `${image.url}?preview=small`) });
  let guard;
  page.route = async (matcher, handler) => { guard = handler; };
  await mutationAdapter().update(page, mutationInput, { beforeSubmit: async () => {} });
  for (const valid of [true, false]) {
    const payload = mutationRequest();
    if (!valid) payload.image_info.images[0].file_id = 'different-image';
    let continued = false, aborted = false;
    await guard({ request: () => ({ url: () => nativeNoteUrl('update'), method: () => 'PUT', postData: () => JSON.stringify(payload) }), continue: async () => { continued = true; }, abort: async () => { aborted = true; } });
    assert.equal(continued, valid); assert.equal(aborted, !valid);
  }
});

test('official blank-paragraph tab placeholders preserve the same editor body in details and update requests', () => {
  const detail = { ...originalDetail, desc: '第一段\n\t\n第二段' };
  const decoded = xiaohongshuOriginalDetail(JSON.stringify({ success: true, code: 0, data: detail }), mutationReceipt);
  assert.equal(decoded.body, '第一段\n\n第二段');
  const payload = mutationRequest();
  payload.common.desc = '第一段\n\t\n第二段';
  assert.equal(isXiaohongshuMutationResponse(nativeMutationResponse({ operation: 'update', payload }), 'update', mutationReceipt,
    { title: payload.common.title, body: '第一段\n\n第二段', imageIds: payload.image_info.images.map(image => image.file_id) }), true);
});
