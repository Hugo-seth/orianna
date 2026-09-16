import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createDouyinAdapter, douyinAccount, confirmedDouyinPublication, isDouyinPublicationResponse, isDouyinImageCommit, douyinUploadedUris, douyinPictureState, douyinEditorText, douyinVerificationRequired } from './douyin-adapter.mjs';

const account = { uid: '1234567890123456789', name: '图文作者' };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=';
const input = { expectedAccountUid: account.uid, title: '今天的记录', body: '第一段\n#生活日常', images: [png, png] };
const response = (url, raw, method = 'POST') => ({ url: () => url, request: () => ({ method: () => method }), ok: () => true, text: async () => raw });

test('account accepts only authenticated public identity and preserves a large UID', () => {
  const result = douyinAccount('{"status_code":0,"user":{"uid":1234567890123456789,"nickname":"图文作者","sec_uid":"MS4wLjABAAAAabcd","secret":"not-returned","avatar_thumb":{"url_list":["https://example.com/avatar.png"]}}}');
  assert.deepEqual(result, { ...account, profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAabcd', avatarUrl: 'https://example.com/avatar.png' });
  assert.equal(douyinAccount({ status_code: 8, user: { uid: '42', nickname: 'a' } }), null);
  assert.equal(douyinAccount({ status_code: 0, user: { uid: 1234567890123456789, nickname: 'a' } }), null);
  assert.equal(douyinAccount({ status_code: 0, user: { uid: '42', nickname: '' } }), null);
  assert.equal(douyinAccount('not JSON'), null);
});

test('publication requires a successful official result with a precision-safe post ID', () => {
  const result = confirmedDouyinPublication('{"status_code":0,"aweme":{"aweme_id":9876543210123456789,"author":{"uid":"1234567890123456789"}}}', account, () => new Date('2026-09-14T00:00:00Z'));
  assert.deepEqual(result, { id: '9876543210123456789', url: 'https://www.douyin.com/note/9876543210123456789', publishedAt: '2026-09-14T00:00:00.000Z', account });
  assert.equal(confirmedDouyinPublication('{"status_code":0,"data":{"item_id":"91234567890"}}', account).id, '91234567890');
  assert.equal(confirmedDouyinPublication('{"status_code":0,"item_id":9876543210123456789}', account).id, '9876543210123456789');
  assert.throws(() => confirmedDouyinPublication('{"status_code":0,"item_id":"42","aweme":{"aweme_id":"43"}}', account), { code: 'PUBLISH_UNCERTAIN' });
  assert.throws(() => confirmedDouyinPublication('{"status_code":0}', account), { code: 'PUBLISH_UNCERTAIN' });
  assert.throws(() => confirmedDouyinPublication('{"status_code":1008,"aweme":{"aweme_id":"42"}}', account), { code: 'PUBLISH_REJECTED' });
  assert.throws(() => confirmedDouyinPublication('{"status_code":0,"aweme":{"aweme_id":"42","author":{"uid":"7"}}}', account), { code: 'PUBLISH_UNCERTAIN' });
  assert.throws(() => confirmedDouyinPublication('not JSON', account), { code: 'PUBLISH_UNCERTAIN' });
});

test('only the exact official native POST endpoints can provide a publication receipt', () => {
  assert.equal(isDouyinPublicationResponse(response('https://creator.douyin.com/web/api/media/aweme/create/?a=1', '')), true);
  assert.equal(isDouyinPublicationResponse(response('https://creator.douyin.com/web/api/media/aweme/create_v2/', '')), true);
  for (const url of ['https://creator.douyin.com.evil.test/web/api/media/aweme/create/', 'http://creator.douyin.com/web/api/media/aweme/create/', 'https://creator.douyin.com/web/api/media/aweme/draft/', 'https://creator.douyin.com/creator-micro/content/manage']) assert.equal(isDouyinPublicationResponse(response(url, '')), false);
  assert.equal(isDouyinPublicationResponse(response('https://creator.douyin.com/web/api/media/aweme/create/', '', 'GET')), false);
});

test('image commit parsing requires valid final ImageX results', () => {
  const url = 'https://imagex.bytedanceapi.com/?Action=CommitImageUpload&Version=2018-08-01';
  assert.equal(isDouyinImageCommit(response(url, '')), true);
  assert.equal(isDouyinImageCommit(response(url.replace('Commit', 'Apply'), '')), false);
  assert.equal(isDouyinImageCommit(response(url.replace('bytedanceapi.com', 'bytedanceapi.com.evil.test'), '')), false);
  assert.deepEqual(douyinUploadedUris('{"ResponseMetadata":{},"Result":{"Results":[{"Uri":"tos-cn-i-abc/first"},{"Uri":"tos-cn-i-abc/second"}]}}'), ['tos-cn-i-abc/first', 'tos-cn-i-abc/second']);
  assert.throws(() => douyinUploadedUris('{"ResponseMetadata":{"Error":{"Code":"Denied"}},"Result":{"Results":[{"Uri":"valid"}]}}'), { code: 'IMAGE_UPLOAD_FAILED' });
  assert.throws(() => douyinUploadedUris('{"Result":{"Results":[{"Uri":"javascript:bad"}]}}'), { code: 'IMAGE_UPLOAD_FAILED' });
});

class FixturePage extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.location = 'https://creator.douyin.com/creator-micro/content/upload'; this.events = []; this.title = ''; this.body = ''; this.files = []; this.accountReads = 0;
  }
  url() { return this.location; }
  async goto(url) { this.location = url; this.events.push('navigate'); }
  async evaluate() {
    this.accountReads += 1;
    const uid = this.options.accountUids?.[this.accountReads - 1] || account.uid;
    return JSON.stringify({ status_code: this.options.loggedOut ? 8 : 0, user: { uid, nickname: account.name } });
  }
  locator(selector) {
    if (selector === 'body') return { evaluate: async () => ({ count: this.options.existingImages || this.files.length, ready: this.files.length, sources: this.options.sources || this.files.map((_, i) => `blob:preview-${i}`), otherMedia: 0 }) };
    if (selector.includes('captcha')) return { count: async () => this.options.challenge ? 1 : 0 };
    if (selector.includes('type="file"')) return {
      count: async () => 1,
      setInputFiles: async (files) => {
        this.events.push('upload'); this.files = files; this.location = 'https://creator.douyin.com/creator-micro/content/post/image?enter_from=upload';
        this.emit('response', response('https://imagex.bytedanceapi.com/?Action=CommitImageUpload', this.options.uploadRejected ? '{"ResponseMetadata":{"Error":{}}}' : JSON.stringify({ Result: { Results: files.map((_, i) => ({ Uri: `tos-cn-i-test/image${i}` })) } })));
      },
    };
    const key = selector.includes('zone-container') ? 'body' : 'title';
    const locator = {
      first: () => locator,
      waitFor: async () => {},
      count: async () => this.options.ambiguousEditor ? 2 : 1,
      fill: async (value) => { this[key] = value; this.events.push(`fill-${key}`); },
      inputValue: async () => this.title,
      innerText: async () => this.body,
      evaluate: async callback => callback({ innerText: this.body, querySelectorAll: () => [] }),
      press: async () => {},
    };
    return locator;
  }
  getByText(name) {
    const locator = { first: () => locator, waitFor: async () => {}, count: async () => 1, isVisible: async () => name === '接收短信验证码' && Boolean(this.options.smsChallenge), click: async () => { this.events.push('open-image-tab'); } };
    return locator;
  }
  getByRole() {
    return { count: async () => 1, isVisible: async () => true, isEnabled: async () => true, click: async () => {
      this.events.push('publish-click');
      if (this.options.clickError) throw new Error('Native click failed');
      const result = response('https://creator.douyin.com/web/api/media/aweme/create/', this.options.publishRaw ?? '{"status_code":0,"aweme":{"aweme_id":"9876543210987654321"}}');
      const request = { method: () => 'POST', url: result.url, postData: () => 'original-native-body' };
      result.request = () => request;
      result.headerValue = async name => name === 'x-tt-verify-passport-decision' && this.options.verificationResponse ? 'opaque-native-decision' : null;
      this.emit('request', request);
      this.emit('response', result);
    } };
  }
}

test('official ace paragraph placeholders are interpreted as line breaks without leaking zero-width text', () => {
  const paragraph = text => ({ querySelectorAll: () => [
    { textContent: text, getAttribute: () => null }, { textContent: '\u200b', getAttribute: () => 'true' },
  ] });
  assert.equal(douyinEditorText({ querySelectorAll: () => [paragraph('第一段'), paragraph('第二段'), paragraph('#原话题')] }), '第一段\n\n第二段\n\n#原话题');
});

test('publisher checks the selected account, all image commits, and durable checkpoint before one native click', async () => {
  const page = new FixturePage();
  const result = await createDouyinAdapter().publish(page, input, { beforeSubmit: async () => { page.events.push('checkpoint'); } });
  assert.equal(result.id, '9876543210987654321');
  assert.deepEqual(page.events, ['open-image-tab', 'upload', 'fill-title', 'fill-body', 'checkpoint', 'publish-click']);
  assert.equal(page.files.length, 2);
  assert.equal(page.accountReads, 3);
  assert.equal(page.listenerCount('response'), 1, 'bounded late-receipt observer stays with the page');
  page.emit('close');
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(page.listenerCount('close'), 0);
});

test('mismatched accounts and challenges prevent uploading and clicking', async () => {
  for (const [options, code] of [[{ accountUids: ['5'] }, 'ACCOUNT_CHANGED'], [{ challenge: true }, 'CAPTCHA_REQUIRED'], [{ loggedOut: true }, 'LOGIN_REQUIRED']]) {
    const page = new FixturePage(options);
    await assert.rejects(createDouyinAdapter().publish(page, input, { beforeSubmit: async () => {} }), { code });
    assert.deepEqual(page.events, []);
  }
});

test('existing media and rejected uploads stop before checkpoint or submit', async () => {
  for (const options of [{ existingImages: 1 }, { uploadRejected: true }]) {
    const page = new FixturePage(options);
    await assert.rejects(createDouyinAdapter().publish(page, input, { beforeSubmit: async () => { page.events.push('checkpoint'); } }), { code: 'IMAGE_UPLOAD_FAILED' });
    assert.equal(page.events.includes('checkpoint'), false);
    assert.equal(page.events.includes('publish-click'), false);
    assert.equal(page.listenerCount('response'), 0);
  }
});

test('changed account or failed checkpoint cannot submit the native form', async () => {
  const changed = new FixturePage({ accountUids: [account.uid, '5'] });
  await assert.rejects(createDouyinAdapter().publish(changed, input, { beforeSubmit: async () => {} }), { code: 'ACCOUNT_CHANGED' });
  assert.equal(changed.events.includes('publish-click'), false);
  const failed = new FixturePage();
  await assert.rejects(createDouyinAdapter().publish(failed, input, { beforeSubmit: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(failed.events.includes('publish-click'), false);
});

test('changed text after checkpoint prevents a click and is uncertain', async () => {
  const page = new FixturePage();
  await assert.rejects(createDouyinAdapter().publish(page, input, { beforeSubmit: async () => { page.body = 'changed'; } }), { code: 'PUBLISH_UNCERTAIN' });
  assert.equal(page.events.includes('publish-click'), false);
});

test('edits made while final live identity is loading are read back before clicking', async () => {
  for (const mutate of [(page) => { page.body = 'changed while checking identity'; }, (page) => { page.options.sources = ['blob:preview-1', 'blob:preview-0']; }]) {
    const page = new FixturePage();
    const read = page.evaluate.bind(page);
    page.evaluate = async () => {
      const value = await read();
      if (page.accountReads === 3) {
        await new Promise((resolve) => setImmediate(resolve));
        mutate(page);
      }
      return value;
    };
    await assert.rejects(createDouyinAdapter().publish(page, input, { beforeSubmit: async () => {} }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
    assert.equal(page.events.includes('publish-click'), false);
  }
});

test('a failed native click is never retried and closes its foreground waiter', async () => {
  const page = new FixturePage({ clickError: true });
  await assert.rejects(createDouyinAdapter().publish(page, input, { beforeSubmit: async () => {} }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
  assert.equal(page.events.filter((event) => event === 'publish-click').length, 1);
  assert.equal(page.listenerCount('response'), 1);
  page.emit('close');
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(page.listenerCount('close'), 0);
});

test('HTTP 200 with empty body and native verification header requires manual verification, then reconciles the same native request', async () => {
  const page = new FixturePage({ verificationResponse: true, publishRaw: '' });
  const adapter = createDouyinAdapter();
  const attemptedAt = new Date().toISOString();
  await assert.rejects(adapter.publish(page, input, { beforeSubmit: async () => {} }), { code: 'CAPTCHA_REQUIRED', submitted: true });
  assert.equal(page.events.filter(event => event === 'publish-click').length, 1);
  assert.equal((await adapter.diagnostics(page)).responseMetadata[0].verificationRequired, true);
  await assert.rejects(adapter.reconcilePublication(page, input, { attemptedAt }), { code: 'CAPTCHA_REQUIRED' });
  const result = response('https://creator.douyin.com/web/api/media/aweme/create_v2/', '{"status_code":0,"item_id":"91234567890"}');
  const request = { method: () => 'POST', url: result.url, postData: () => 'original-native-body' };
  result.request = () => request;
  page.emit('request', request); page.emit('response', result);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await adapter.reconcilePublication(page, input, { attemptedAt })).id, '91234567890');
  assert.equal(await adapter.reconcilePublication(page, { ...input, body: 'different body' }, { attemptedAt }), undefined);
  assert.equal(await adapter.reconcilePublication(page, input, { attemptedAt: '2020-01-01T00:00:00Z' }), undefined);
  assert.equal(page.events.filter(event => event === 'publish-click').length, 1, 'reconciliation never clicks publish');
  page.emit('close');
  for (const event of ['request', 'response', 'requestfailed', 'close']) assert.equal(page.listenerCount(event), 0);
});

test('verification detection ignores unrelated endpoints and SMS prompts block publication before upload', async () => {
  const unrelated = response('https://creator.douyin.com/unrelated', ''); unrelated.headerValue = async () => 'opaque';
  assert.equal(await douyinVerificationRequired(unrelated), false);
  const page = new FixturePage({ smsChallenge: true });
  await assert.rejects(createDouyinAdapter().publish(page, input, { beforeSubmit: async () => {} }), { code: 'CAPTCHA_REQUIRED' });
  assert.deepEqual(page.events, []);
});

test('a late success for a changed native body or a conflicting ID cannot settle the pending original', async () => {
  for (const changed of ['body', 'id']) {
    const page = new FixturePage({ verificationResponse: true, publishRaw: '' });
    const adapter = createDouyinAdapter(), attemptedAt = new Date().toISOString();
    await assert.rejects(adapter.publish(page, input, { beforeSubmit: async () => {} }), { code: 'CAPTCHA_REQUIRED' });
    const emit = async (id, body) => {
      const result = response('https://creator.douyin.com/web/api/media/aweme/create_v2/', JSON.stringify({ status_code: 0, item_id: id }));
      const request = { method: () => 'POST', url: result.url, postData: () => body };
      result.request = () => request; page.emit('request', request); page.emit('response', result);
      await new Promise(resolve => setImmediate(resolve));
    };
    if (changed === 'body') await emit('91234567890', 'changed-native-body');
    else { await emit('91234567890', 'original-native-body'); await emit('91234567891', 'original-native-body'); }
    await assert.rejects(adapter.reconcilePublication(page, input, { attemptedAt }), { code: 'CAPTCHA_REQUIRED' });
    assert.equal(page.events.filter(event => event === 'publish-click').length, 1);
    page.emit('close');
  }
});

test('a successful-looking response without a post ID is uncertain and never retries', async () => {
  const page = new FixturePage({ publishRaw: '{"status_code":0}' });
  await assert.rejects(createDouyinAdapter().publish(page, input, { beforeSubmit: async () => {} }), { code: 'PUBLISH_UNCERTAIN' });
  assert.equal(page.events.filter((event) => event === 'publish-click').length, 1);
});

test('invalid content and missing checkpoint are rejected before browser access', async () => {
  const adapter = createDouyinAdapter();
  await assert.rejects(adapter.publish({}, input), { code: 'PUBLISH_REJECTED' });
  await assert.rejects(adapter.publish({}, { ...input, title: 'a'.repeat(31) }, { beforeSubmit: async () => {} }), { code: 'PUBLISH_REJECTED' });
  await assert.rejects(adapter.publish({}, { ...input, images: [] }, { beforeSubmit: async () => {} }), { code: 'IMAGE_UPLOAD_FAILED' });
});

test('reordered images after checkpoint and provider rejection retain submitted state', async () => {
  const page = new FixturePage();
  await assert.rejects(createDouyinAdapter().publish(page, input, { beforeSubmit: async () => { page.options.sources = ['blob:preview-1', 'blob:preview-0']; } }), { code: 'PUBLISH_UNCERTAIN', submitted: true });
  assert.equal(page.events.includes('publish-click'), false);
  const rejected = new FixturePage({ publishRaw: '{"status_code":1008}' });
  await assert.rejects(createDouyinAdapter().publish(rejected, input, { beforeSubmit: async () => {} }), { code: 'PUBLISH_REJECTED', submitted: true });
  assert.equal(rejected.events.filter((event) => event === 'publish-click').length, 1);
});

test('native image state requires successful controls, no upload overlay, and visible previews', async () => {
  const preview = { className: 'img-Sb1Kaq', tagName: 'IMG', complete: true, naturalWidth: 1, currentSrc: 'blob:test-image', getBoundingClientRect: () => ({ width: 79 }) };
  const card = (uploading = false, deletion = true) => ({ children: [preview], querySelector(selector) {
    if (selector.includes('upload-')) return uploading ? {} : null;
    if (selector.includes('del-')) return deletion ? {} : null;
    if (selector.includes('operator-button-')) return {};
    return null;
  } });
  const root = { querySelectorAll: (selector) => selector === 'video, audio' ? [] : [card(), card(true), card(false, false)] };
  const page = { locator: () => ({ evaluate: async (callback) => callback(root) }) };
  assert.deepEqual(await douyinPictureState(page), { count: 3, ready: 1, sources: ['blob:test-image', 'blob:test-image', 'blob:test-image'], otherMedia: 0 });
});

test('lazy-image preview wrappers use their decoded inner image for readiness and identity', async () => {
  const image = { complete: true, naturalWidth: 500, currentSrc: 'blob:actual-image' };
  const preview = { className: 'img-Sb1Kaq', tagName: 'DIV', querySelector: () => image, getBoundingClientRect: () => ({ width: 79 }) };
  const card = { children: [preview], querySelector: selector => selector.includes('upload-') ? null : {} };
  const root = { querySelectorAll: selector => selector === 'video, audio' ? [] : [card] };
  const page = { locator: () => ({ evaluate: async callback => callback(root) }) };
  assert.deepEqual(await douyinPictureState(page), { count: 1, ready: 1, sources: ['blob:actual-image'], otherMedia: 0 });
  image.complete = false;
  assert.equal((await douyinPictureState(page)).ready, 0);
});

test('isolated Chrome exercises native Douyin image DOM and confirms one checkpointed POST', { skip: process.env.FATIAO_PLATFORM_DOM_TEST !== '1', timeout: 90_000 }, async () => {
  const { chromium } = await import('playwright');
  const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const profile = await mkdtemp(join(tmpdir(), 'fatiao-douyin-dom-'));
  const archive = resolve('output/playwright');
  let context;
  let page;
  let checkpoint = false;
  const posts = [];
  const pageErrors = [];
  const intercepted = [];
  const fixture = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>抖音图文隔离验收</title>
    <style>body{font:16px sans-serif;padding:20px}input:not([type=file]),.zone-container{display:block;min-height:40px;width:400px;margin:12px 0;border:1px solid #ddd}.container-card{display:inline-block;width:79px;height:105px;margin:8px;position:relative}.img-fixture{width:79px;height:105px}.del-fixture{width:12px;height:12px}.upload-fixture{position:absolute;inset:0}</style>
    <button id="image-entry" type="button">发布图文</button>
    <div class="container-upload" hidden><input type="file" accept="image/png,image/jpeg" multiple></div>
    <div id="images"></div>
    <section id="form" hidden><input placeholder="填写作品标题，为作品获得更多流量"><div class="zone-container" contenteditable="true"></div><button id="publish" type="button">发布</button></section>
    <script>
      window.fixture = { files: [], checkpoint: false, publishClicks: 0 };
      const entry = document.querySelector('#image-entry');
      const uploader = document.querySelector('.container-upload');
      entry.addEventListener('click', () => { uploader.hidden = false; });
      uploader.querySelector('input').addEventListener('change', async (event) => {
        const files = [...event.target.files];
        window.fixture.files = files.map(file => ({name:file.name,size:file.size,type:file.type}));
        const cards = await Promise.all(files.map(async (file) => {
          const source = await new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(file); });
          const card = document.createElement('div'); card.className = 'container-card';
          const image = document.createElement('img'); image.className = 'img-fixture'; image.src = source; card.append(image);
          const overlay = document.createElement('div'); overlay.className = 'upload-fixture'; card.append(overlay);
          document.querySelector('#images').append(card);
          await image.decode();
          return card;
        }));
        const uploaded = await fetch('https://imagex.bytedanceapi.com/?Action=CommitImageUpload', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({count:files.length})});
        await uploaded.json();
        cards.forEach((card) => {
          card.querySelector('.upload-fixture').remove();
          const remove = document.createElement('img'); remove.className = 'del-fixture'; remove.src = cards[0].querySelector('img').src; card.append(remove);
          const controls = document.createElement('div'); controls.className = 'operator-button-fixture'; controls.textContent = '查看 替换'; card.append(controls);
        });
        history.pushState({}, '', '/creator-micro/content/post/image?enter_from=upload');
        entry.hidden = true; uploader.hidden = true; document.querySelector('#form').hidden = false;
      });
      document.querySelector('#publish').addEventListener('click', async () => {
        window.fixture.publishClicks += 1;
        await fetch('/web/api/media/aweme/create/', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:document.querySelector('#form input').value,text:document.querySelector('.zone-container').innerText,files:window.fixture.files,checkpoint:window.fixture.checkpoint})});
      });
    </script></html>`;
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, serviceWorkers: 'block', viewport: { width: 1100, height: 850 } });
    page = context.pages()[0] || await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    // Every request is fulfilled or aborted locally. There is no route.continue
    // and no possibility of this test submitting to the real platform.
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      intercepted.push({ method: request.method(), origin: url.origin, pathname: url.pathname });
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (url.origin === 'https://creator.douyin.com' && url.pathname === '/creator-micro/content/upload') return route.fulfill({ status: 200, contentType: 'text/html', body: fixture });
      if (url.origin === 'https://creator.douyin.com' && url.pathname === '/web/api/media/user/info/' && request.method() === 'GET') return route.fulfill({ contentType: 'application/json', body: '{"status_code":0,"user":{"uid":1234567890123456789,"nickname":"图文作者","secret":"must-not-return"}}' });
      if (url.origin === 'https://imagex.bytedanceapi.com' && url.searchParams.get('Action') === 'CommitImageUpload' && request.method() === 'POST') {
        assert.equal(request.postDataJSON().count, 2);
        return route.fulfill({ contentType: 'application/json', headers, body: '{"Result":{"Results":[{"Uri":"tos-cn-i-test/fixture-first"},{"Uri":"tos-cn-i-test/fixture-second"}]}}' });
      }
      if (url.origin === 'https://creator.douyin.com' && url.pathname === '/web/api/media/aweme/create/' && request.method() === 'POST') {
        assert.equal(checkpoint, true);
        posts.push(request.postDataJSON());
        return route.fulfill({ contentType: 'application/json', body: '{"status_code":0,"aweme":{"aweme_id":9876543210987654321,"author":{"uid":1234567890123456789}}}' });
      }
      return route.abort();
    });
    await page.goto('https://creator.douyin.com/creator-micro/content/upload', { waitUntil: 'domcontentloaded' });
    const adapter = createDouyinAdapter();
    assert.deepEqual(await adapter.readAccount(page), { ...account, profileUrl: 'https://www.douyin.com/user/self' });
    const result = await adapter.publish(page, input, { beforeSubmit: async () => {
      const state = await douyinPictureState(page);
      assert.equal(state.count, 2);
      assert.equal(state.ready, 2);
      assert.equal(await page.locator('#form input').inputValue(), input.title);
      assert.equal(await page.locator('.zone-container').innerText(), input.body);
      assert.equal(await page.evaluate(() => window.fixture.publishClicks), 0);
      checkpoint = true;
      await page.evaluate(() => { window.fixture.checkpoint = true; });
    } });
    assert.equal(result.id, '9876543210987654321');
    assert.equal(result.url, 'https://www.douyin.com/note/9876543210987654321');
    assert.deepEqual(result.account, account);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].title, input.title);
    assert.equal(posts[0].text, input.body);
    assert.equal(posts[0].checkpoint, true);
    assert.deepEqual(posts[0].files.map((file) => file.name), ['fatiao-1.png', 'fatiao-2.png']);
    assert.equal(posts[0].files.every((file) => file.size > 0 && file.type === 'image/png'), true);
    assert.equal(await page.evaluate(() => window.fixture.publishClicks), 1);
    assert.deepEqual(pageErrors, []);
    assert.equal(page.listenerCount('response'), 0);
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, 'douyin-dom-fixture.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), browser: 'isolated Chrome', intercepted, imageCount: posts[0].files.length, nativePostCount: posts.length, checkpoint: true, receipt: result, realPlatformRequest: false }, null, 2));
  } catch (error) {
    await mkdir(archive, { recursive: true });
    if (page && !page.isClosed()) await page.screenshot({ path: join(archive, 'douyin-dom-fixture-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    const leftovers = () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((line) => line.includes(`--user-data-dir=${profile}`));
    let remaining = leftovers();
    for (let i = 0; remaining.length && i < 10; i += 1) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      remaining = leftovers();
    }
    assert.deepEqual(remaining, [], 'The isolated fixture must not leave any Chrome process using its temporary profile.');
  }
});
