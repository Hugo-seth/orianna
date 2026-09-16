import { fail, imageFiles, parseProviderJson, sameAccount, waitUntil, hasChallenge, waitForPublication, PlatformBrowserError } from './platform-browser-helpers.mjs';
import { createHash, randomUUID } from 'node:crypto';

const PUBLISH = 'https://creator.xiaohongshu.com/publish/publish?source=official&target=image';
// Connect through the same first-party session that publishes notes. The main
// site's unsigned user/me request can return 406 even for a signed-in account.
const HOME = PUBLISH;
const MANAGER = 'https://creator.xiaohongshu.com/new/note-manager';
const NATIVE_NOTE = '/web_api/sns/capa/postgw/note/';
const noteId = (value) => typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value) ? value : undefined;
const acceptsImages = (value) => typeof value === 'string' && /image|\.jpe?g|\.png|\.webp/i.test(value)
  && !/video|\.mp4|\.mov|\.webm|\.avi|\.m4v/i.test(value);

// DOM references: xpzouying/xiaohongshu-mcp aad2a3d (login.go/publish.go).
// Account fields, picture states and native POST path also checked against the
// official creator project-publish-vue.9eda55ca.js bundle on 2026-09-14.
export function xiaohongshuAccount(value) {
  if (!value || value.guest) return null;
  const uid = value.userId || value.user_id;
  const name = value.nickname || value.userName;
  if (!noteId(uid) || typeof name !== 'string' || !name.trim() || name.length > 300) return null;
  const account = { uid, name, profileUrl: `https://www.xiaohongshu.com/user/profile/${uid}` };
  try {
    const url = new URL(value.userAvatar || value.images || value.imageb);
    if (url.protocol === 'https:' && !url.username && !url.password) account.avatarUrl = url.href;
  } catch { /* An avatar is optional. */ }
  return account;
}

export async function readXiaohongshuAccount(page) {
  const origin = new URL(page.url()).origin;
  if (!['https://www.xiaohongshu.com', 'https://creator.xiaohongshu.com'].includes(origin)) return null;
  // The initial page state can outlive a logout or account switch in another
  // tab. Always check the current session through a fixed, read-only identity
  // endpoint. AiToEarn 9413d73 uses user/me without a signing service; if CORS,
  // verification or network policy rejects this browser read, fail closed.
  const mainSite = origin === 'https://www.xiaohongshu.com';
  try {
    return xiaohongshuAccount(await page.evaluate(async ({ url, credentials }) => {
      try {
        const response = await fetch(url, { credentials, cache: 'no-store', signal: AbortSignal.timeout(5_000) });
        if (!response.ok) return null;
        const result = await response.json();
        if (result.code !== 0 || result.success === false || !result.data || result.data.guest) return null;
        const value = result.data;
        // No raw response, Cookie, token or other session fields leave Chrome.
        // The creator my-info response verified on 2026-09-15 nests identity
        // under userDetail; permissions and other account metadata are ignored.
        if (value.userDetail !== undefined) return { userId: value.userDetail?.id, userName: value.userDetail?.nickName,
          userAvatar: value.userDetail?.url, guest: value.userDetail?.guest };
        return { userId: value.userId || value.user_id, userName: value.userName || value.nickname,
          userAvatar: value.userAvatar || value.imageb, guest: value.guest };
      } catch { return null; }
    }, { url: mainSite ? 'https://edith.xiaohongshu.com/api/sns/web/v2/user/me' : '/api/galaxy/user/my-info', credentials: mainSite ? 'include' : 'same-origin' }));
  } catch { return null; }
}

function validateText(input = {}) {
  const { title = '', body = '' } = input;
  if (typeof title !== 'string' || typeof body !== 'string' || title.includes('\0') || body.includes('\0')) fail('PUBLISH_REJECTED', '小红书标题和正文格式无效。');
  if (!title.trim()) fail('PUBLISH_REJECTED', '请填写小红书标题。');
  if (Array.from(title.trim()).length > 20 || Array.from(body.trim()).length > 1000) fail('PUBLISH_REJECTED', '小红书标题最多 20 字，正文最多 1000 字。');
  return { title: title.trim(), body: body.trim() };
}

export function validateXiaohongshuInput(input = {}) {
  const { title, body } = validateText(input);
  const files = imageFiles(input.images);
  if (!files.length) fail('IMAGE_UPLOAD_FAILED', '小红书图文至少需要 1 张图片。');
  return { title, body, files };
}

export function validateXiaohongshuMutation(input = {}, operation) {
  const receipt = input.receipt;
  if (!noteId(receipt?.id) || receipt.url !== `https://www.xiaohongshu.com/explore/${receipt.id}`
    || !noteId(receipt.account?.uid) || receipt.account.uid !== input.expectedAccountUid) fail('ACCOUNT_CHANGED', '小红书原帖回执或作者不一致，已停止操作。');
  if (Object.hasOwn(input, 'images')) fail('OPERATION_UNSUPPORTED', '修改小红书原帖仅支持标题和正文，原有图片会保留。');
  return { receipt, ...(operation === 'update' ? validateText(input) : {}) };
}

// Official note-manager 98.bd587c29.js and tracker[50977] from
// library-protobuf.24a38387.js, checked on 2026-09-15. Titles are not identifiers.
export function xiaohongshuManagedNoteId(impression) {
  try {
    const value = JSON.parse(impression);
    return value.event?.value?.pointId === 50977 ? noteId(value.noteTarget?.value?.noteId) : undefined;
  } catch { return undefined; }
}

export function isXiaohongshuDetailResponse(response, id) {
  try {
    const url = new URL(response.url());
    return url.origin === 'https://edith.xiaohongshu.com' && url.pathname === `${NATIVE_NOTE}detail`
      && url.searchParams.get('note_id') === id && url.searchParams.get('edit_mode') === '1' && response.request().method() === 'GET';
  } catch { return false; }
}

function normalizeEditorBody(value) {
  // The creator serializes an empty paragraph as a tab-only line, then drops
  // that placeholder when loading the editor again.
  return value.replace(/\r\n/g, '\n').replace(/^[\t ]+$/gm, '');
}

function nativeSuccess(raw, code) {
  let value;
  try { value = parseProviderJson(raw); } catch { fail(code, '小红书未返回可验证的原帖操作回执，请到官网核实。'); }
  if (!value || value.success !== true || (value.code !== undefined && value.code !== 0)
    || (value.result !== undefined && value.result !== 0)) fail(code, '小红书未明确接受此次原帖操作，请到官网核实。');
  return value;
}

export function xiaohongshuOriginalDetail(raw, receipt) {
  const data = nativeSuccess(raw, 'OPERATION_UNSUPPORTED').data;
  if (!data || data.type !== 'normal' || typeof data.title !== 'string' || typeof data.desc !== 'string'
    || !Array.isArray(data.images_list) || !data.images_list.length || data.images_list.length > 18
    || [data.id, data.note_id].some((id) => id !== undefined && id !== receipt.id)
    || [data.user_id, data.author_id, data.user?.user_id].some((uid) => uid !== undefined && uid !== receipt.account.uid)) fail('OPERATION_UNSUPPORTED', '小红书原帖详情或图文类型未能核实，已停止修改。');
  const images = data.images_list.map((image) => ({ id: image?.fileid, source: image?.url }));
  if (images.some((image) => typeof image.id !== 'string' || !image.id || typeof image.source !== 'string' || !image.source)
    || new Set(images.map((image) => image.id)).size !== images.length) fail('OPERATION_UNSUPPORTED', '小红书原图信息不完整，无法确认保留图片。');
  for (const image of images) {
    try {
      const url = new URL(image.source);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid image URL');
      image.source = url.href;
    } catch { fail('OPERATION_UNSUPPORTED', '小红书原图地址无法核实，已停止修改。'); }
  }
  return { title: data.title.trim(), body: normalizeEditorBody(data.desc).trim(), images };
}

export function isXiaohongshuMutationResponse(response, operation, receipt, expected) {
  try {
    const url = new URL(response.url()), request = response.request();
    if (url.origin !== 'https://edith.xiaohongshu.com' || url.pathname !== `${NATIVE_NOTE}${operation}`
      || request.method() !== (operation === 'update' ? 'PUT' : 'POST')) return false;
    const payload = JSON.parse(request.postData());
    if (operation === 'delete') return payload.note_id === receipt.id;
    return payload.common?.note_id === receipt.id && payload.common?.type === 'normal'
      && payload.common?.title === expected.title && typeof payload.common?.desc === 'string' && normalizeEditorBody(payload.common.desc) === normalizeEditorBody(expected.body)
      && JSON.stringify(payload.image_info?.images?.map((image) => image.file_id)) === JSON.stringify(expected.imageIds);
  } catch { return false; }
}

export function confirmedXiaohongshuMutation(raw, operation, receipt, now = () => new Date()) {
  const data = nativeSuccess(raw, 'PUBLISH_UNCERTAIN').data;
  if ([data?.id, data?.note_id].some((id) => id !== undefined && id !== receipt.id)
    || [data?.user_id, data?.author_id, data?.user?.user_id].some((uid) => uid !== undefined && uid !== receipt.account.uid)) fail('PUBLISH_UNCERTAIN', '小红书原帖操作回执不一致，请到官网核实。');
  return { ...receipt, [operation === 'update' ? 'updatedAt' : 'deletedAt']: now().toISOString() };
}

export function isXiaohongshuPublishResponse(response) {
  try {
    const url = new URL(response.url());
    return url.origin === 'https://edith.xiaohongshu.com' && url.pathname === '/web_api/sns/v2/note' && response.request().method() === 'POST';
  } catch { return false; }
}

export function confirmedXiaohongshuPublication(raw, account, now = () => new Date()) {
  let response;
  try { response = parseProviderJson(raw); } catch { fail('PUBLISH_UNCERTAIN', '小红书回执无法解析，请先在官网核实发布结果。'); }
  if (response?.success === false || (response?.code !== undefined && response.code !== 0) || (response?.result !== undefined && response.result !== 0)) fail('PUBLISH_REJECTED', '小红书未接受此次发布，请查看专用窗口的提示。');
  if (response?.success !== true && response?.code !== 0 && response?.result !== 0) fail('PUBLISH_UNCERTAIN', '小红书未返回明确的成功回执，请先在官网核实结果。');
  const id = noteId(response?.data?.id) || noteId(response?.data?.note_id);
  if (!id) fail('PUBLISH_UNCERTAIN', '小红书尚未返回笔记编号，请先在官网核实结果，避免重复发布。');
  const author = response.data.user_id || response.data.user?.user_id;
  if (author && author !== account.uid) fail('PUBLISH_UNCERTAIN', '小红书回执账号不一致，请先在官网核实结果。');
  return { id, url: `https://www.xiaohongshu.com/explore/${id}`, publishedAt: now().toISOString(), account: { uid: account.uid, name: account.name } };
}

export async function xiaohongshuPictureState(root, { editing = false } = {}) {
  return root.evaluate((element, { editing = false } = {}) => {
    const tiles = [...element.querySelectorAll('.img-preview-area .img-container')];
    const states = tiles.map((tile) => {
      const img = tile.querySelector('img');
      const mask = tile.querySelector('.mask.hover-mask:not(.prerender)');
      const source = img?.currentSrc || img?.src || '';
      const loaded = Boolean(img?.complete && img.naturalWidth > 0 && img.getBoundingClientRect().width > 0);
      // Current official creator exposes completed images through a preview,
      // its normal edit/delete controls and no uploading/failed state.
      const failed = /上传失败|重新上传/.test(tile.innerText) || Boolean(tile.querySelector('.upload-failed'));
      const ready = loaded && !failed && (editing || Boolean(mask?.querySelector('.close-btn')) && !tile.querySelector('.mask:not(.hover-mask), .prerender'));
      const fileId = tile.__vueParentComponent?.props?.img?.fileId;
      return { source, ready, failed, fileId: typeof fileId === 'string' && fileId.length <= 256 ? fileId : undefined };
    });
    const list = editing ? element.querySelector('.img-list')?.__vueParentComponent?.props?.state?.imgList?.value : undefined;
    const ids = Array.isArray(list) && list.length === tiles.length && list.every(item => typeof item?.fileId === 'string') ? list.map(item => item.fileId) : states.length && states.every(state => state.fileId) ? states.map(state => state.fileId) : undefined;
    return { count: tiles.length, ready: states.filter((state) => state.ready).length, failed: states.some((state) => state.failed), sources: states.map((state) => state.source), ...(ids ? { fileIds: ids } : {}) };
  }, { editing });
}

async function findComposer(page) {
  const title = page.locator('div.d-input input:visible');
  const body = page.locator('div[role="textbox"][contenteditable="true"]:visible, div.tiptap[contenteditable="true"]:visible, div.ql-editor[contenteditable="true"]:visible');
  await title.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
  if (await title.count() !== 1 || await body.count() !== 1) fail('UI_CHANGED', '未找到唯一的小红书图文编辑器，请打开专用窗口检查。');
  const root = title.locator('xpath=ancestor::*[.//*[contains(concat(" ",normalize-space(@class)," ")," img-preview-area ")] and (.//xhs-publish-btn or .//*[contains(concat(" ",normalize-space(@class)," ")," publish-page-publish-btn ")])][1]');
  if (await root.count() !== 1 || await root.locator('div.d-input input:visible').count() !== 1) fail('UI_CHANGED', '小红书图文发布区域不明确，已停止操作。');
  const widgets = root.locator('xhs-publish-btn:not([is-publish="false"]):visible');
  const legacy = root.locator('.publish-page-publish-btn button.bg-red:visible');
  const button = await widgets.count() ? widgets : legacy;
  if (await button.count() !== 1) fail('UI_CHANGED', '未找到唯一的小红书原生发布按钮。');
  return { root, title, body, button, widget: await widgets.count() === 1 };
}

export function xiaohongshuEditableText(element) {
  const inlineTags = new Set(['SPAN', 'A', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'CODE']);
  const inline = (node) => {
    if (node.nodeType === 3) return node.nodeValue ?? node.textContent ?? '';
    if (node.nodeType !== 1) return node.nodeType === 8 ? '' : undefined;
    if (node.tagName === 'BR') return node.classList?.contains('ProseMirror-trailingBreak') ? '' : '\n';
    if (!inlineTags.has(node.tagName)) return undefined;
    const parts = [...node.childNodes].map(inline);
    return parts.includes(undefined) ? undefined : parts.join('');
  };
  const children = [...element.childNodes];
  const hasParagraphs = children.some((node) => node.nodeType === 1 && node.tagName === 'P');
  const parts = [];
  for (const node of children) {
    if (hasParagraphs && node.nodeType === 3 && !(node.nodeValue ?? '').trim()) continue;
    if (node.nodeType === 1 && node.tagName === 'P') {
      const content = [...node.childNodes].map(inline);
      if (content.includes(undefined)) return undefined;
      parts.push(content.join(''));
    } else {
      if (hasParagraphs && node.nodeType !== 8) return undefined;
      const content = inline(node);
      if (content === undefined) return undefined;
      parts.push(content);
    }
  }
  return parts.join(hasParagraphs ? '\n' : '').replace(/\r\n/g, '\n').trim();
}

const editableText = async (locator) => {
  const value = await locator.evaluate(xiaohongshuEditableText);
  if (typeof value !== 'string') fail('UI_CHANGED', '小红书正文结构包含未支持的换行或媒体，已停止操作。');
  return value;
};

export async function dismissXiaohongshuImageGuide(page) {
  const guide = page.locator('.feature-guide[role="dialog"]:visible');
  const count = await guide.count();
  if (!count) return;
  const heading = guide.locator('.feature-guide__title');
  if (count !== 1 || await heading.count() !== 1 || (await heading.innerText()).trim() !== '图片可以编辑啦，快来试试吧')
    fail('UI_CHANGED', '小红书出现未识别的教学提示，已停止操作。');
  const close = guide.locator('button.feature-guide__btn');
  if (await close.count() !== 1 || (await close.innerText()).trim() !== '我知道了' || !await close.isVisible() || !await close.isEnabled())
    fail('UI_CHANGED', '小红书图片教学提示无法安全关闭。');
  await close.click({ timeout: 3_000 });
  await guide.waitFor({ state: 'hidden', timeout: 3_000 });
}

/** Safe static layout evidence; no input value, post text, HTML or URL leaves the page. */
export function xiaohongshuStructure({ stage }) {
  const find = (selector) => [...document.querySelectorAll(selector)];
  const visible = (element) => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const accept = (element) => {
    const value = element.getAttribute('accept') || '';
    const image = /image|\.jpe?g|\.png|\.webp/i.test(value), video = /video|\.mp4|\.mov|\.webm|\.avi|\.m4v/i.test(value);
    return image && video ? 'mixed' : image ? 'image' : video ? 'video' : value ? 'other' : 'none';
  };
  const groups = [
    ['image-tab', find('div.creator-tab').filter((element) => element.innerText?.trim() === '上传图文')],
    ['title-input', find('div.d-input input')],
    ['body-editor', find('div[role="textbox"][contenteditable="true"], div.tiptap[contenteditable="true"], div.ql-editor[contenteditable="true"]')],
    ['file-input', find('input[type="file"]')],
    ['publish-widget', find('xhs-publish-btn')],
    ['legacy-publish-button', find('.publish-page-publish-btn button.bg-red')],
  ];
  const counts = {
    imageTab: groups[0][1].filter(visible).length, titleInput: groups[1][1].filter(visible).length,
    bodyEditor: groups[2][1].filter(visible).length, fileInput: groups[3][1].length,
    imageFileInput: groups[3][1].filter((element) => accept(element) === 'image').length,
    videoFileInput: groups[3][1].filter((element) => accept(element) === 'video').length,
    publishWidget: groups[4][1].filter(visible).length, legacyPublishButton: groups[5][1].filter(visible).length,
    previewImage: find('.img-preview-area .img-container').length,
  };
  const knownClasses = ['upload-input', 'creator-tab', 'd-input', 'tiptap', 'ql-editor', 'publish-page-publish-btn', 'bg-red', 'upload-content', 'img-list'];
  const tags = ['input', 'textarea', 'div', 'span', 'button', 'xhs-publish-btn'];
  const controls = [];
  for (const [kind, elements] of groups) {
    for (const element of elements) {
      const tag = element.tagName.toLowerCase();
      if (!tags.includes(tag)) continue;
      controls.push({ kind, tag, visible: visible(element), disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'
        || element.getAttribute('submit-disabled') === 'true'), accept: accept(element),
      knownClasses: knownClasses.filter((name) => element.closest(`.${name}`)) });
      if (controls.length === 20) break;
    }
    if (controls.length === 20) break;
  }
  return { stage, readyState: ['loading', 'interactive', 'complete'].includes(document.readyState) ? document.readyState : 'loading',
    counts: Object.fromEntries(Object.entries(counts).map(([name, count]) => [name, Math.min(1000, count)])), controls };
}

/** Runs in the owned operation tab. Only DOM state and input events are used. */
export function xiaohongshuDeleteGuardDom({ action, key, id, title }) {
  if (action !== 'install') {
    const guard = globalThis[key];
    if (!guard) return { valid: false, accepted: false };
    if (action === 'dispose') { guard.dispose(); delete globalThis[key]; return { valid: false, accepted: guard.accepted }; }
    return guard.check(action === 'arm');
  }
  const visible = (element) => Boolean(element?.isConnected && element.getBoundingClientRect().width > 0
    && element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== 'hidden');
  const rowId = (element) => {
    try {
      const value = JSON.parse(element.getAttribute('data-impression'));
      return value.event?.value?.pointId === 50977 ? value.noteTarget?.value?.noteId : null;
    } catch { return null; }
  };
  const rows = [...document.querySelectorAll('.note-card[data-impression]')].filter((row) => visible(row) && rowId(row) === id);
  if (rows.length !== 1 || [...document.querySelectorAll('.modal-container')].some(visible)) return { valid: false, accepted: false };
  const row = rows[0], entry = row.querySelector('.note-card__action-btn--del:not(.note-card__action-btn--disabled)');
  if (!entry) return { valid: false, accepted: false };
  let invalid = false, entered = false, modal, finalButton, armed = false, accepted = false;
  const expectedText = `删除后将无法恢复，确定要删除《${title.slice(0, 10) || '无笔记标题'}》这篇笔记吗`;
  const observe = (records) => {
    if (accepted || invalid) return;
    if (modal && records.some((record) => (record.type === 'childList' && (modal.contains(record.target)
        || [...record.removedNodes].some((node) => node === modal || node.contains?.(modal))))
      || (record.type === 'characterData' && modal.contains(record.target.parentElement))
      || (record.type === 'attributes' && (record.target === modal || record.target.contains(modal))
        && (record.attributeName === 'hidden'
          || (record.attributeName === 'style' && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(`${record.oldValue};${record.target.getAttribute('style')}`))
          || (record.attributeName === 'class' && /(?:^|[\s-])(?:leave|hidden)(?:[\s-]|$)/.test(`${record.oldValue} ${record.target.getAttribute('class')}`))
          || (record.attributeName === 'aria-hidden' && (record.oldValue === 'true' || record.target.getAttribute('aria-hidden') === 'true')))))) invalid = true;
    sync();
  };
  const observer = new MutationObserver(observe);
  const sync = () => {
    if (invalid) return false;
    if (!row.isConnected || rowId(row) !== id || !entry.isConnected || !row.contains(entry)) { invalid = true; return false; }
    if (!entered) return true;
    const shown = [...document.querySelectorAll('.modal-container')].filter(visible);
    if (!modal && shown.length === 0) return false;
    if (shown.length !== 1 || (modal && shown[0] !== modal)) { invalid = true; return false; }
    const candidate = shown[0], buttons = [...candidate.querySelectorAll('.modal-footer .confirm-button')];
    if (candidate.querySelector('.modal-title')?.innerText.trim() !== '删除笔记' || !candidate.innerText.includes(expectedText)
      || buttons.length !== 1 || buttons[0].innerText.trim() !== '确定' || !visible(buttons[0])) { invalid = true; return false; }
    if (!modal) { modal = candidate; finalButton = buttons[0]; }
    if (buttons[0] !== finalButton || !modal.contains(finalButton)) { invalid = true; return false; }
    return true;
  };
  const stop = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const onClick = (event) => {
    observe(observer.takeRecords());
    if (accepted) { stop(event); return; }
    if (!entered && !invalid && entry.contains(event.target) && sync()) { entered = true; return; }
    // A title is never a target lock. Even an identical replacement dialog or
    // a reordered card must fail before the native click handler can run.
    if (entered && armed && finalButton?.contains(event.target) && sync()) { accepted = true; return; }
    invalid = true; stop(event);
  };
  const onKey = (event) => {
    if (accepted) return;
    invalid = true;
    if (['Enter', ' ', 'Spacebar'].includes(event.key)) stop(event);
  };
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeOldValue: true, characterData: true });
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  const guard = {
    get accepted() { return accepted; },
    check(arm) {
      observe(observer.takeRecords());
      const valid = !invalid && sync();
      if (arm && valid && entered && modal) armed = true;
      return { valid: valid && (!entered || Boolean(modal)), accepted };
    },
    dispose() { observer.disconnect(); document.removeEventListener('click', onClick, true); document.removeEventListener('keydown', onKey, true); },
  };
  globalThis[key] = guard;
  return { valid: true, accepted: false };
}

export function createXiaohongshuAdapter({ mutationTimeoutMs = 12_000, publishReadyTimeoutMs = 15_000 } = {}) {
  const mutationWait = Number.isFinite(mutationTimeoutMs) ? Math.max(1, Math.min(30_000, mutationTimeoutMs)) : 12_000;
  const publishReadyWait = Number.isFinite(publishReadyTimeoutMs) ? Math.max(1, Math.min(30_000, publishReadyTimeoutMs)) : 15_000;
  const publishStages = new WeakMap();
  const publishReasons = new WeakMap();
  const preparedPages = new WeakMap();
  const publishStage = (page, stage) => publishStages.set(page, stage);
  const rejectPublication = (page, reason, code, message) => { publishReasons.set(page, reason); fail(code, message); };
  const emptyNativeMedia = async (page) => {
    if (await page.locator('.img-preview-area .img-container').count() || await page.locator('video, audio').count())
      fail('IMAGE_UPLOAD_FAILED', '小红书编辑器已有媒体，请在专用窗口清空后重新发布。');
  };
  async function prepareImageUploader(page) {
    const imageTab = page.locator('div.creator-tab:visible').filter({ hasText: /^上传图文$/ });
    // The native file input is intentionally hidden. Its upload container must
    // be visible so a parked input in an inactive media tab cannot be selected.
    const uploader = page.locator('div.upload-content:visible input.upload-input[type="file"]');
    publishStage(page, 'wait_image_entry');
    const entry = await waitUntil(async () => {
      // The failure snapshot has three creator-tab matches for "上传图文".
      // An already-ready, unique image input is a stronger mode signal
      // and needs no tab click at all (console failure snapshot 2026-09-15).
      if (await uploader.count() === 1 && acceptsImages(await uploader.getAttribute('accept'))) return 'uploader';
      const tabs = await imageTab.count();
      if (tabs === 1) return 'tab';
      return false;
    }, publishReadyWait);
    if (!entry) fail('UI_CHANGED', '小红书图文入口尚未加载完成，请稍后从控制台重试。');
    if (entry === 'tab') {
      // An existing draft may finish restoring while the entry mounts. Never
      // switch its media tab or upload until that state has been checked.
      await emptyNativeMedia(page);
      publishStage(page, 'select_image_tab');
      await imageTab.click();
    }
    publishStage(page, 'wait_image_uploader');
    const ready = await waitUntil(async () => await uploader.count() === 1 && acceptsImages(await uploader.getAttribute('accept')), publishReadyWait);
    if (!ready) fail('UI_CHANGED', '小红书图片上传控件尚未就绪，请稍后从控制台重试。');
    return uploader;
  }
  async function diagnostics(page) {
    const reason = publishReasons.get(page);
    try { return { structure: { ...await page.evaluate(xiaohongshuStructure, { stage: publishStages.get(page) || 'validation' }), ...(reason ? { reason } : {}) } }; }
    catch { return { structure: { stage: publishStages.get(page) || 'validation', ...(reason ? { reason } : {}) } }; }
  }
  async function checkMutationAccount(page, uid) {
    await sameAccount(page, readXiaohongshuAccount, uid, '小红书');
    if (await hasChallenge(page)) fail('CAPTCHA_REQUIRED', '请打开小红书专用窗口完成安全验证。');
  }
  async function managedNote(page, receipt) {
    await checkMutationAccount(page, receipt.account.uid);
    await page.goto(MANAGER, { waitUntil: 'domcontentloaded' });
    await checkMutationAccount(page, receipt.account.uid);
    const cards = page.locator('.note-card[data-impression]:visible');
    const row = await waitUntil(async () => {
      const values = await cards.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-impression')));
      const indexes = values.flatMap((value, index) => xiaohongshuManagedNoteId(value) === receipt.id ? [index] : []);
      if (indexes.length > 1) fail('UI_CHANGED', '小红书管理列表中原帖不唯一，已停止操作。');
      return indexes.length === 1 ? cards.nth(indexes[0]) : false;
    }, mutationWait);
    if (!row) fail('OPERATION_UNSUPPORTED', '当前小红书管理页未找到该原帖，暂时无法在控制台操作，请到官网核实。');
    await assertManagedNote(page, row, receipt);
    return row;
  }
  async function assertManagedNote(page, row, receipt) {
    const url = new URL(page.url());
    if (url.origin !== 'https://creator.xiaohongshu.com' || url.pathname !== '/new/note-manager'
      || await row.count() !== 1 || xiaohongshuManagedNoteId(await row.getAttribute('data-impression')) !== receipt.id) fail('UI_CHANGED', '小红书原帖管理区域发生变化，已停止操作。');
  }
  function assertEditRoute(page, id) {
    const url = new URL(page.url());
    if (url.origin !== 'https://creator.xiaohongshu.com' || url.pathname !== '/publish/update'
      || url.searchParams.get('id') !== id || url.searchParams.get('noteType') !== 'normal') fail('UI_CHANGED', '小红书当前页面不是已核对的原帖编辑页。');
  }
  async function reconcileOperation(page, input, { operation, attemptedAt } = {}) {
    if (operation !== 'update' || !Number.isFinite(Date.parse(attemptedAt)) || Date.parse(attemptedAt) > Date.now()) return undefined;
    const { receipt, title, body } = validateXiaohongshuMutation(input, 'update');
    await managedNote(page, receipt);
    const result = waitForPublication(page, response => isXiaohongshuDetailResponse(response, receipt.id), { timeoutMs: mutationWait });
    try {
      await page.goto(`https://creator.xiaohongshu.com/publish/update?id=${receipt.id}&noteType=normal`, { waitUntil: 'domcontentloaded' });
      const current = xiaohongshuOriginalDetail(await result.promise, receipt);
      assertEditRoute(page, receipt.id);
      await checkMutationAccount(page, receipt.account.uid);
      // Confirm the saved text from a fresh official detail response. Opening
      // the editor does not fill it, click submit, or repeat the pending edit.
      if (current.title !== title || current.body !== normalizeEditorBody(body)) fail('OPERATION_UNCERTAIN', '小红书官网当前文字尚未与本次修改一致，原请求继续保留。');
      return { ...receipt, updatedAt: new Date().toISOString() };
    } finally { result.cancel(); }
  }
  async function update(page, input, hooks = {}) {
    const { receipt, title, body } = validateXiaohongshuMutation(input, 'update');
    if (typeof hooks.beforeSubmit !== 'function') fail('PUBLISH_REJECTED', '修改检查点缺失，已停止操作。');
    await managedNote(page, receipt);
    publishStage(page, 'update_load_detail');
    const detailWaiter = waitForPublication(page, (response) => isXiaohongshuDetailResponse(response, receipt.id), { timeoutMs: mutationWait });
    let original;
    try {
      await page.goto(`https://creator.xiaohongshu.com/publish/update?id=${receipt.id}&noteType=normal`, { waitUntil: 'domcontentloaded' });
      original = xiaohongshuOriginalDetail(await detailWaiter.promise, receipt);
    } catch (error) {
      if (error?.code === 'OPERATION_UNSUPPORTED') throw error;
      fail('OPERATION_UNSUPPORTED', '小红书没有加载可验证的原帖详情，已停止修改。');
    } finally { detailWaiter.cancel(); }
    assertEditRoute(page, receipt.id);
    await checkMutationAccount(page, receipt.account.uid);
    const composer = await findComposer(page);
    let sources = original.images.map((image) => new URL(image.source, page.url()).href);
    const expectedImageIds = original.images.map(image => image.id);
    let bindFileIds = false;
    publishStage(page, 'update_verify_images');
    const ready = await waitUntil(async () => {
      const pictures = await xiaohongshuPictureState(composer.root, { editing: true });
      if (pictures.failed || pictures.count > sources.length) fail('IMAGE_UPLOAD_FAILED', '小红书原图状态异常，已停止修改。');
      const idsMatch = JSON.stringify(pictures.fileIds) === JSON.stringify(expectedImageIds);
      // The official edit page may render a transformed preview URL. It is
      // freshly bound to this note; preserve its ordered previews, and verify
      // the original file IDs again in the native update request receipt.
      const matched = pictures.count === sources.length && pictures.ready === sources.length && (!pictures.fileIds || idsMatch);
      if (matched) { bindFileIds = idsMatch; sources = pictures.sources; }
      return matched;
    }, mutationWait);
    if (!ready) fail('OPERATION_UNSUPPORTED', '小红书原图尚未完整载入，无法确认保留图片。');
    publishStage(page, 'update_verify_text');
    const actualTitle = await composer.title.inputValue();
    const actualBody = await editableText(composer.body);
    if (actualTitle !== original.title || actualBody !== original.body) {
      fail('UI_CHANGED', '小红书编辑器与原帖详情不一致，已停止修改。');
    }
    await composer.title.fill(title); await composer.body.fill(body); await composer.title.click();
    const confirm = async () => {
      // Identity reads can be slow. Check it before the final DOM readback so
      // an edit made while that request is in flight is still caught.
      await checkMutationAccount(page, receipt.account.uid);
      assertEditRoute(page, receipt.id);
      if (await composer.title.inputValue() !== title || await editableText(composer.body) !== body) fail('UI_CHANGED', '小红书修改文案发生变化，已停止提交。');
      const pictures = await xiaohongshuPictureState(composer.root, { editing: true });
      if (pictures.count !== sources.length || pictures.ready !== sources.length || pictures.failed
        || JSON.stringify(pictures.sources) !== JSON.stringify(sources) || bindFileIds && JSON.stringify(pictures.fileIds) !== JSON.stringify(expectedImageIds)) fail('IMAGE_UPLOAD_FAILED', '小红书原有图片发生变化，已停止修改。');
      if (!await composer.button.isVisible() || !await composer.button.isEnabled() || await composer.button.getAttribute('submit-disabled') === 'true'
        || await composer.button.getAttribute('aria-disabled') === 'true') fail('UI_CHANGED', '小红书原帖提交按钮未就绪。');
      if (await composer.root.locator('.title-container .max_suffix:visible, .edit-container .length-error:visible').count()) fail('PUBLISH_REJECTED', '小红书提示文案超出平台长度限制。');
    };
    await confirm();
    await hooks.beforeSubmit();
    publishStage(page, 'update_submit');
    const expected = { title, body, imageIds: expectedImageIds };
    const updateRoute = url => url.origin === 'https://edith.xiaohongshu.com' && url.pathname === `${NATIVE_NOTE}update`;
    const guard = async route => {
      const request = route.request();
      if (!isXiaohongshuMutationResponse({ url: () => request.url(), request: () => request }, 'update', receipt, expected)) return route.abort('blockedbyclient');
      return route.continue();
    };
    // Thumbnail URLs can change on the edit page. The native request must keep
    // the original ordered file IDs before it is allowed to reach the server.
    await page.route(updateRoute, guard);
    const result = waitForPublication(page, (response) => isXiaohongshuMutationResponse(response, 'update', receipt,
      { title, body, imageIds: original.images.map((image) => image.id) }), { timeoutMs: mutationWait });
    try {
      await confirm();
      const box = composer.widget ? await composer.button.boundingBox() : null;
      if (composer.widget && !box) fail('PUBLISH_UNCERTAIN', '小红书原帖提交区域发生变化。');
      // The edit widget contains one centered submit button; the new-note
      // widget's split draft/publish offset lands outside this button.
      await composer.button.click({ timeout: 8_000 });
      return confirmedXiaohongshuMutation(await result.promise, 'update', receipt);
    } catch (error) { throw submittedMutationError(error); }
    finally { result.cancel(); await page.unroute(updateRoute, guard); }
  }
  async function remove(page, input, hooks = {}) {
    const { receipt } = validateXiaohongshuMutation(input, 'delete');
    if (typeof hooks.beforeSubmit !== 'function') fail('PUBLISH_REJECTED', '删除检查点缺失，已停止操作。');
    const row = await managedNote(page, receipt);
    if (await page.locator('.modal-container:visible').count()) fail('UI_CHANGED', '小红书已有未关闭的操作确认框，已停止删除。');
    const title = (await row.locator('.note-card__title').innerText()).trim();
    const button = row.locator('.note-card__action-btn--del:not(.note-card__action-btn--disabled)');
    const key = `__fatiao_delete_${randomUUID().replaceAll('-', '')}`;
    const guard = (action) => page.evaluate(xiaohongshuDeleteGuardDom, { action, key, id: receipt.id, title });
    try {
      if (!(await guard('install')).valid) fail('UI_CHANGED', '小红书原帖删除入口无法锁定，已停止操作。');
      await row.hover();
      if (await button.count() !== 1 || !await button.isVisible() || !await button.isEnabled()) fail('OPERATION_UNSUPPORTED', '当前小红书原帖没有可用的删除入口。');
      await checkMutationAccount(page, receipt.account.uid);
      await assertManagedNote(page, row, receipt);
      await button.click();
      const modal = page.locator('.modal-container:visible');
      await modal.first().waitFor({ state: 'visible', timeout: mutationWait }).catch(() => {});
      const confirm = async () => {
        await checkMutationAccount(page, receipt.account.uid);
        await assertManagedNote(page, row, receipt);
        if (!(await guard('check')).valid) fail('UI_CHANGED', '小红书删除目标或确认框已变化，已停止操作。');
        if (await modal.count() !== 1 || (await modal.locator('.modal-title').innerText()).trim() !== '删除笔记'
          || !(await modal.innerText()).includes(`删除后将无法恢复，确定要删除《${title.slice(0, 10) || '无笔记标题'}》这篇笔记吗`)) fail('OPERATION_UNSUPPORTED', '小红书未显示可核对的原帖删除确认框，请到官网操作。');
        const finalButton = modal.locator('.modal-footer .confirm-button');
        if (await finalButton.count() !== 1 || (await finalButton.innerText()).trim() !== '确定' || !await finalButton.isVisible() || !await finalButton.isEnabled()) fail('UI_CHANGED', '小红书删除确认按钮未就绪。');
        return finalButton;
      };
      await confirm();
      await hooks.beforeSubmit();
      const result = waitForPublication(page, (response) => isXiaohongshuMutationResponse(response, 'delete', receipt), { timeoutMs: mutationWait });
      try {
        const finalButton = await confirm();
        if (!(await guard('arm')).valid) fail('PUBLISH_UNCERTAIN', '小红书删除确认目标已变化。');
        await finalButton.click({ timeout: 8_000 });
        if (!(await guard('check')).accepted) fail('PUBLISH_UNCERTAIN', '小红书原帖删除点击已被阻止，请核实原帖状态。');
        return confirmedXiaohongshuMutation(await result.promise, 'delete', receipt);
      } catch (error) { throw submittedMutationError(error); }
      finally { result.cancel(); }
    } finally { await guard('dispose').catch(() => {}); }
  }
  async function login(page) {
    // The creator redirects an expired session to its own official login UI.
    // Keep an existing creator page (including its unsent draft) intact, and
    // migrate legacy main-site connection tabs only after an explicit open.
    if (new URL(page.url()).origin !== 'https://creator.xiaohongshu.com')
      await page.goto(HOME, { waitUntil: 'domcontentloaded' });
    return page;
  }
  async function getLoginQr(page) {
    if (new URL(page.url()).origin !== 'https://www.xiaohongshu.com') return undefined;
    const qr = page.locator('.login-container .qrcode-img:visible');
    if (await qr.count() !== 1 || !await qr.evaluate((img) => img.complete && img.naturalWidth > 0)) return undefined;
    // A clipped image of the official QR only; no remote URL or Cookie reaches UI.
    return { kind: 'qr', image: `data:image/png;base64,${(await qr.screenshot({ type: 'png', timeout: 3_000 })).toString('base64')}` };
  }
  function getLoginNotice(page) {
    const url = new URL(page.url());
    if (url.origin === 'https://www.xiaohongshu.com' && url.pathname === '/website-login/error' && url.searchParams.get('error_code') === '300012')
      return '小红书当前网络被官网限制，请切换可靠网络后重新连接（300012）。';
    return undefined;
  }
  async function publish(page, input, hooks = {}) {
    publishStage(page, 'validation');
    publishReasons.delete(page);
    const { title, body, files } = validateXiaohongshuInput(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({ uid: input.expectedAccountUid, title, body,
      images: files.map((file) => createHash('sha256').update(file.buffer).digest('hex')) })).digest('hex');
    if (typeof hooks.beforeSubmit !== 'function') fail('PUBLISH_REJECTED', '发布检查点缺失，已停止操作。');
    publishStage(page, 'identity');
    const account = await sameAccount(page, readXiaohongshuAccount, input.expectedAccountUid, '小红书');
    if (await hasChallenge(page)) fail('CAPTCHA_REQUIRED', '请打开小红书专用窗口完成安全验证。');
    publishStage(page, 'publish_navigation');
    if (!page.url().startsWith('https://creator.xiaohongshu.com/publish/publish')) await page.goto(PUBLISH, { waitUntil: 'domcontentloaded' });
    await sameAccount(page, readXiaohongshuAccount, input.expectedAccountUid, '小红书');
    let root = page.locator('body');
    let composer;
    const existingMedia = await page.locator('.img-preview-area .img-container').count() || await page.locator('video, audio').count();
    const readBody = async (locator) => {
      try { return await editableText(locator); }
      catch { rejectPublication(page, 'body_structure_unsupported', 'UI_CHANGED', '小红书正文结构无法按原段落核对，已停止操作。'); }
    };
    if (existingMedia) {
      const saved = preparedPages.get(page);
      if (!saved || saved.fingerprint !== fingerprint) rejectPublication(page, 'existing_draft_unverified', 'IMAGE_UPLOAD_FAILED', '小红书已有未能确认属于本次内容的图片草稿，已停止上传。');
      composer = await findComposer(page);
      const current = await xiaohongshuPictureState(composer.root);
      if (current.count !== files.length || current.ready !== files.length || current.failed || JSON.stringify(current.sources) !== JSON.stringify(saved.sources)
        || await composer.title.inputValue() !== title || await readBody(composer.body) !== body)
        rejectPublication(page, 'existing_draft_changed', 'IMAGE_UPLOAD_FAILED', '小红书本次已填草稿发生变化，已停止复用。');
    } else {
      preparedPages.delete(page);
      const uploader = await prepareImageUploader(page);
      publishStage(page, 'check_empty_editor');
      await checkMutationAccount(page, input.expectedAccountUid);
      await emptyNativeMedia(page);
      if (await uploader.count() !== 1 || !acceptsImages(await uploader.getAttribute('accept'))) fail('UI_CHANGED', '小红书上传入口在账号核验期间发生变化，已停止上传。');
      publishStage(page, 'upload_images');
      await uploader.setInputFiles(files[0]);
      for (let index = 0; index < files.length; index++) {
        if (index) {
          const extra = page.locator('.img-list input[type="file"][multiple]');
          if (!await waitUntil(async () => await extra.count() === 1, publishReadyWait)) fail('IMAGE_UPLOAD_FAILED', '未找到小红书追加图片控件。');
          await extra.setInputFiles(files[index]);
        }
        const ready = await waitUntil(async () => {
          const pictures = await xiaohongshuPictureState(root);
          if (pictures.failed || pictures.count > index + 1) fail('IMAGE_UPLOAD_FAILED', '小红书图片上传失败或数量发生变化。');
          return pictures.count === index + 1 && pictures.ready === index + 1;
        }, 45_000);
        if (!ready) fail('IMAGE_UPLOAD_FAILED', '未能确认全部小红书图片已上传，请检查专用窗口。');
      }
    }
    try { await dismissXiaohongshuImageGuide(page); }
    catch { rejectPublication(page, 'image_guide_unrecognized', 'UI_CHANGED', '小红书图片教学提示无法安全关闭。'); }
    publishStage(page, 'find_composer');
    composer ||= await findComposer(page);
    root = composer.root;
    publishStage(page, 'fill_text');
    if (!existingMedia) { await composer.title.fill(title); await composer.body.fill(body); await composer.title.click(); }
    const pictures = await xiaohongshuPictureState(root);
    preparedPages.set(page, { fingerprint, sources: [...pictures.sources] });
    const confirm = async () => {
      await sameAccount(page, readXiaohongshuAccount, input.expectedAccountUid, '小红书');
      if (await hasChallenge(page)) fail('CAPTCHA_REQUIRED', '请打开小红书专用窗口完成安全验证。');
      try { await dismissXiaohongshuImageGuide(page); }
      catch { rejectPublication(page, 'image_guide_unrecognized', 'UI_CHANGED', '小红书图片教学提示无法安全关闭。'); }
      if (await composer.title.inputValue() !== title) rejectPublication(page, 'title_mismatch', 'UI_CHANGED', '小红书标题与本次内容不一致，已停止操作。');
      if (await readBody(composer.body) !== body) rejectPublication(page, 'body_mismatch', 'UI_CHANGED', '小红书正文未完整保留原段落换行，已停止操作。');
      const current = await xiaohongshuPictureState(root);
      if (current.count !== files.length || current.ready !== files.length || current.failed || JSON.stringify(current.sources) !== JSON.stringify(pictures.sources)) rejectPublication(page, 'images_changed', 'IMAGE_UPLOAD_FAILED', '小红书图片状态发生变化，已停止操作。');
      if (!await composer.button.isEnabled() || !await composer.button.isVisible() || await composer.button.getAttribute('submit-disabled') === 'true' || await composer.button.getAttribute('aria-disabled') === 'true') rejectPublication(page, 'submit_disabled', 'UI_CHANGED', '小红书发布按钮尚未就绪，请检查官网提示。');
      if (await root.locator('.title-container .max_suffix:visible, .edit-container .length-error:visible').count()) rejectPublication(page, 'text_over_limit', 'PUBLISH_REJECTED', '小红书提示文案超出平台长度限制。');
    };
    publishStage(page, 'confirm_before_checkpoint');
    await confirm();
    await hooks.beforeSubmit();
    preparedPages.delete(page);
    const receipt = waitForPublication(page, isXiaohongshuPublishResponse);
    try {
      publishStage(page, 'confirm_after_checkpoint');
      await confirm();
      const box = composer.widget ? await composer.button.boundingBox() : null;
      if (composer.widget && !box) fail('PUBLISH_UNCERTAIN', '小红书发布区域已变化，请先在官网核实结果。');
      publishStage(page, 'native_submit');
      await composer.button.click({ timeout: 8_000, ...(box ? { position: { x: box.width * 0.65, y: box.height / 2 } } : {}) });
      publishStage(page, 'native_receipt');
      return confirmedXiaohongshuPublication(await receipt.promise, account);
    } catch (error) {
      if (error?.code === 'PUBLISH_REJECTED' || error?.code === 'PUBLISH_UNCERTAIN') { error.submitted = true; throw error; }
      fail('PUBLISH_UNCERTAIN', '小红书提交结果尚未确认，请先在官网核实，避免重复发布。');
    } finally { receipt.cancel(); }
  }
  return { id: 'xiaohongshu', name: '小红书', homeUrl: HOME, loginUrl: HOME, resumeUrl: PUBLISH, defaultHeadless: true, readAccount: readXiaohongshuAccount, login, getLoginQr, getLoginNotice, publish, diagnostics, update, delete: remove, reconcileOperation };
}

function submittedMutationError(error) {
  const uncertain = new PlatformBrowserError('PUBLISH_UNCERTAIN', '小红书原帖操作结果尚未确认，请到官网核实后再继续。', { cause: error });
  uncertain.submitted = true;
  return uncertain;
}
