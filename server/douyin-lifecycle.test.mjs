import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createDouyinAdapter, confirmedDouyinLifecycle, douyinLifecycleTarget, douyinNativeRequestId, isDouyinLifecycleResponse } from './douyin-adapter.mjs';

const account = { uid: '1234567890123456789', name: '图文作者' };
const receipt = { id: '9876543210987654321', url: 'https://www.douyin.com/note/9876543210987654321', account, publishedAt: '2026-09-14T00:00:00.000Z' };
const input = { receipt, expectedAccountUid: account.uid, title: '修改后的标题', body: '修改后的正文\n仍保留原图。' };
const native = (path, { method = 'POST', raw = '{"status_code":0}', body = `item_id=${receipt.id}` } = {}) => ({
  url: () => `https://creator.douyin.com${path}`,
  request: () => ({ method: () => method, postData: () => body }),
  ok: () => true,
  text: async () => raw,
});

class LifecyclePage extends EventEmitter {
  constructor(options = {}) {
    super(); this.options = options; this.location = 'https://creator.douyin.com/creator-micro/content/upload'; this.events = []; this.reads = 0;
    this.title = '原始标题'; this.body = '原始正文'; this.pictureSources = ['https://example.test/original-1', 'https://example.test/original-2'];
    this.dialogTarget = { id: receipt.id, uid: account.uid };
    this.cardTarget = { index: 0, id: receipt.id, uid: account.uid, imageCount: 2 };
    this.mouse = { wheel: async () => {} };
  }
  url() { return this.location; }
  getByText() { return { isVisible: async () => false }; }
  async goto(url) {
    this.location = url; this.events.push('navigate');
    if (url.includes('/post/image')) this.emit('response', native(`/web/api/media/item/info/?item_id=${receipt.id}`, {
      method: 'GET', raw: JSON.stringify({ status_code: 0, aweme: { aweme_id: receipt.id, author: { uid: this.options.authorUid || account.uid }, images: [{ uri: 'first' }, { uri: 'second' }] } }),
    }));
  }
  async evaluate() {
    this.reads += 1;
    await this.options.onIdentity?.(this, this.reads);
    return { status_code: this.options.expired ? 8 : 0, user: { uid: this.options.accountUids?.[this.reads - 1] || account.uid, nickname: account.name } };
  }
  button(operation) {
    const value = {
      first: () => value, waitFor: async () => {}, count: async () => 1, isVisible: async () => true, isEnabled: async () => !this.options.disabled,
      click: async () => {
        this.events.push(`${operation}-click`);
        if (this.options.clickError) throw new Error('click failed');
        const path = operation === 'update' ? '/web/api/media/update/desc/' : '/web/api/media/aweme/delete/';
        this.emit('response', native(path, { raw: this.options.result || '{"status_code":0}' }));
      },
    };
    return value;
  }
  locator(selector) {
    if (selector === 'body') return { evaluate: async () => ({ count: 2, ready: 2, sources: [...this.pictureSources], otherMedia: 0 }) };
    if (selector.includes('captcha')) return { count: async () => this.options.challenge ? 1 : 0 };
    if (selector.includes('video-card-')) return { evaluateAll: async (callback) => callback([{ '__reactFiber$fixture': { memoizedProps: {}, return: { memoizedProps: { data: { aweme_id: this.cardTarget.id, author: { uid: this.cardTarget.uid }, images: Array.from({ length: this.cardTarget.imageCount }, () => ({})) } } } } }]), nth: () => this.card() };
    const field = selector.includes('zone-container') ? 'body' : 'title';
    const value = { first: () => value, waitFor: async () => {}, count: async () => 1, isEditable: async () => !this.options.readOnly,
      fill: async (text) => { this[field] = text; this.events.push(`fill-${field}`); }, press: async () => {}, inputValue: async () => this.title, innerText: async () => this.body,
      evaluate: async callback => callback({ innerText: this.body, querySelectorAll: () => [] }) };
    return value;
  }
  card() {
    return { hover: async () => { this.events.push('hover'); }, getByText: () => ({ count: async () => 1, isVisible: async () => true, click: async () => { this.events.push('open-delete'); } }) };
  }
  getByRole(role) {
    if (role !== 'dialog') return this.button('update');
    const value = { filter: () => value, count: async () => 1, evaluate: async (callback) => callback({ '__reactFiber$fixture': { memoizedProps: {}, return: { memoizedProps: { data: { aweme_id: this.dialogTarget.id, author: { uid: this.dialogTarget.uid } } } } } }), getByRole: () => this.button('delete') };
    return value;
  }
}

test('native lifecycle observers only accept exact official POST endpoint and request ID', () => {
  for (const operation of ['update', 'delete']) {
    const path = operation === 'update' ? '/web/api/media/update/desc/' : '/web/api/media/aweme/delete/';
    assert.equal(isDouyinLifecycleResponse(native(path), operation, receipt.id), true);
    assert.equal(isDouyinLifecycleResponse(native(path, { body: `item_id=7` }), operation, receipt.id), false);
    assert.equal(isDouyinLifecycleResponse(native(path, { method: 'GET' }), operation, receipt.id), false);
    const spoof = native(path); spoof.url = () => `https://creator.douyin.com.evil.test${path}`;
    assert.equal(isDouyinLifecycleResponse(spoof, operation, receipt.id), false);
  }
  assert.equal(isDouyinLifecycleResponse(native('/web/api/media/aweme/create/'), 'update', receipt.id), false);
  assert.equal(isDouyinLifecycleResponse(native('/web/api/media/aweme/update/'), 'update', receipt.id), false, 'privacy changes are not text modifications');
  assert.equal(douyinNativeRequestId(native('/any', { body: '{"item_id":9876543210987654321}' })), receipt.id);
  assert.equal(douyinNativeRequestId(native('/any', { body: `item_id=${receipt.id}&aweme_id=2` })), undefined);
  assert.equal(douyinNativeRequestId(native('/any', { body: `item_id=2&item_id=${receipt.id}` })), undefined);
  assert.equal(douyinNativeRequestId(native('/any', { body: '{bad' })), undefined);
});

test('verified lifecycle receipts preserve original identity and publication time', () => {
  for (const operation of ['update', 'delete']) {
    const field = operation === 'update' ? 'updatedAt' : 'deletedAt';
    assert.deepEqual(confirmedDouyinLifecycle('{"status_code":0}', receipt, operation, () => new Date('2026-09-15T00:00:00Z')), { ...receipt, [field]: '2026-09-15T00:00:00.000Z' });
    assert.throws(() => confirmedDouyinLifecycle('{"status_code":0,"item_id":"7"}', receipt, operation), { code: 'OPERATION_UNCERTAIN' });
    assert.throws(() => confirmedDouyinLifecycle('{"status_code":0,"aweme":{"author":{"uid":"7"}}}', receipt, operation), { code: 'OPERATION_UNCERTAIN' });
    assert.throws(() => confirmedDouyinLifecycle('{"status_code":8}', receipt, operation), { code: 'OPERATION_REJECTED' });
    assert.throws(() => confirmedDouyinLifecycle('invalid', receipt, operation), { code: 'OPERATION_UNCERTAIN' });
  }
});

test('modification requires a fresh official post detail with exact author and image media', () => {
  const data = { status_code: 0, aweme: { aweme_id: receipt.id, author: { uid: account.uid }, images: [{}] } };
  assert.equal(douyinLifecycleTarget(JSON.stringify(data), receipt).aweme_id, receipt.id);
  for (const [aweme, code] of [[{ ...data.aweme, aweme_id: '1' }, 'TARGET_NOT_FOUND'], [{ ...data.aweme, author: {} }, 'ACCOUNT_CHANGED'], [{ ...data.aweme, images: [] }, 'OPERATION_UNSUPPORTED']]) {
    assert.throws(() => douyinLifecycleTarget(JSON.stringify({ ...data, aweme }), receipt), { code });
  }
});

test('text modification preserves original images and uses one checkpointed native update', async () => {
  const page = new LifecyclePage();
  const result = await createDouyinAdapter().update(page, input, { beforeSubmit: async () => page.events.push('checkpoint') });
  assert.equal(result.id, receipt.id); assert.ok(result.updatedAt); assert.equal(result.publishedAt, receipt.publishedAt);
  assert.deepEqual(page.events, ['navigate', 'fill-title', 'fill-body', 'checkpoint', 'update-click']);
  assert.equal(page.reads, 3); assert.deepEqual(page.pictureSources, ['https://example.test/original-1', 'https://example.test/original-2']);
  assert.equal(page.listenerCount('response'), 0); assert.equal(page.listenerCount('close'), 0);
});

test('deletion uses the original managed card and its own explicit native confirmation', async () => {
  const page = new LifecyclePage();
  const result = await createDouyinAdapter().delete(page, input, { beforeSubmit: async () => page.events.push('checkpoint') });
  assert.equal(result.id, receipt.id); assert.ok(result.deletedAt);
  assert.deepEqual(page.events, ['navigate', 'hover', 'open-delete', 'checkpoint', 'delete-click']);
  assert.equal(page.reads, 4); assert.equal(page.listenerCount('response'), 0); assert.equal(page.listenerCount('close'), 0);
});

test('invalid receipt, missing checkpoint and changed logged-in identities cannot mutate native UI', async () => {
  for (const operation of ['update', 'delete']) {
    const adapter = createDouyinAdapter();
    await assert.rejects(adapter[operation]({}, input), { code: 'OPERATION_REJECTED' });
    await assert.rejects(adapter[operation]({}, { ...input, receipt: { ...receipt, url: 'https://example.test/post' } }, { beforeSubmit: async () => {} }), { code: 'OPERATION_REJECTED' });
    await assert.rejects(adapter[operation]({}, { ...input, expectedAccountUid: '7' }, { beforeSubmit: async () => {} }), { code: 'ACCOUNT_CHANGED' });
    for (const [options, code] of [[{ accountUids: ['7'] }, 'ACCOUNT_CHANGED'], [{ challenge: true }, 'CAPTCHA_REQUIRED'], [{ expired: true }, 'LOGIN_REQUIRED']]) {
      const page = new LifecyclePage(options);
      await assert.rejects(adapter[operation](page, input, { beforeSubmit: async () => {} }), { code });
      assert.deepEqual(page.events, []);
    }
  }
});

test('unsupported native editing and mismatched authors stop before a checkpoint', async () => {
  for (const [options, code] of [[{ readOnly: true }, 'OPERATION_UNSUPPORTED'], [{ authorUid: '7' }, 'ACCOUNT_CHANGED'], [{ disabled: true }, 'OPERATION_UNSUPPORTED']]) {
    const page = new LifecyclePage(options);
    await assert.rejects(createDouyinAdapter().update(page, input, { beforeSubmit: async () => page.events.push('checkpoint') }), { code });
    assert.equal(page.events.includes('checkpoint'), false); assert.equal(page.events.includes('update-click'), false);
    assert.equal(page.listenerCount('response'), 0);
  }
});

test('changed text, image order or mid after checkpoint prevent modification', async () => {
  for (const mutate of [(page) => { page.body = 'changed'; }, (page) => page.pictureSources.reverse(), (page) => { page.location = page.location.replace(receipt.id, '7'); }]) {
    const page = new LifecyclePage();
    await assert.rejects(createDouyinAdapter().update(page, input, { beforeSubmit: async () => mutate(page) }), { submitted: true });
    assert.equal(page.events.includes('update-click'), false);
  }
});

test('edits made during final identity request are read back before submitting', async () => {
  const page = new LifecyclePage({ onIdentity: async (page, reads) => { if (reads === 3) page.body = 'changed while verifying account'; } });
  await assert.rejects(createDouyinAdapter().update(page, input, { beforeSubmit: async () => {} }), { submitted: true });
  assert.equal(page.events.includes('update-click'), false);
});

test('a deletion dialog belonging to another card never authorizes deleting it', async () => {
  const before = new LifecyclePage(); before.dialogTarget.id = '7';
  await assert.rejects(createDouyinAdapter().delete(before, input, { beforeSubmit: async () => before.events.push('checkpoint') }), { code: 'OPERATION_UNSUPPORTED' });
  assert.equal(before.events.includes('checkpoint'), false); assert.equal(before.events.includes('delete-click'), false);
  const after = new LifecyclePage();
  await assert.rejects(createDouyinAdapter().delete(after, input, { beforeSubmit: async () => { after.dialogTarget.id = '7'; } }), { code: 'OPERATION_UNCERTAIN', submitted: true });
  assert.equal(after.events.includes('delete-click'), false);
});

test('native lifecycle clicks are never retried after a failed click or provider rejection', async () => {
  for (const operation of ['update', 'delete']) for (const options of [{ clickError: true }, { result: '{"status_code":9}' }]) {
    const page = new LifecyclePage(options);
    await assert.rejects(createDouyinAdapter()[operation](page, input, { beforeSubmit: async () => {} }), { submitted: true });
    assert.equal(page.events.filter((event) => event === `${operation}-click`).length, 1);
    assert.equal(page.listenerCount('response'), 0); assert.equal(page.listenerCount('close'), 0);
  }
});

test('failed durable checkpoint never clicks update or delete', async () => {
  for (const operation of ['update', 'delete']) {
    const page = new LifecyclePage();
    await assert.rejects(createDouyinAdapter()[operation](page, input, { beforeSubmit: async () => { throw new Error('disk full'); } }), /disk full/);
    assert.equal(page.events.includes(`${operation}-click`), false);
  }
});
