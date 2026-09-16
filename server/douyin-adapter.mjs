import { PlatformBrowserError, fail, hasChallenge, imageFiles, numericId, parseProviderJson, sameAccount, waitForPublication, waitUntil } from './platform-browser-helpers.mjs';
import { createHash } from 'node:crypto';

const ORIGIN = 'https://creator.douyin.com';
const UPLOAD_URL = `${ORIGIN}/creator-micro/content/upload`;
const MANAGE_URL = `${ORIGIN}/creator-micro/content/manage`;
const MANAGED_CARD = 'div[class^="video-card-"]:has(> div[class^="video-card-content-"])';
const TITLE = 'input[placeholder*="填写作品标题"]:visible, input[placeholder*="添加作品标题"]:visible';
const BODY = 'div.zone-container[contenteditable="true"]:visible';
const uploadCounts = new WeakMap();
const publishDiagnostics = new WeakMap();
const payloadHash = input => createHash('sha256').update(JSON.stringify([input.expectedAccountUid, input.title.trim(), input.body.trim(), input.images])).digest('hex');
const bodyHash = request => typeof request.postData?.() === 'string' ? createHash('sha256').update(request.postData()).digest('hex') : undefined;

export async function douyinVerificationRequired(response) {
  if (!isDouyinPublicationResponse(response)) return false;
  // The native client handles this header before attempting JSON decoding.
  // A verification response can legitimately be HTTP 200 with an empty body.
  return Boolean(await response.headerValue?.('x-tt-verify-passport-decision'));
}

export async function hasDouyinChallenge(page) {
  if (await hasChallenge(page)) return true;
  return page.getByText('接收短信验证码', { exact: true }).isVisible().catch(() => false);
}

// Observe only native publication traffic; never retain headers, cookies, request
// bodies or arbitrary provider messages. Keep the observer until page close so
// a response arriving after our foreground wait remains available to reconcile.
export function observeDouyinPublication(page) {
  if (publishDiagnostics.has(page)) return publishDiagnostics.get(page);
  const state = { requests: 0, responses: 0, failures: 0, responseMetadata: [], networkErrors: [] };
  publishDiagnostics.set(page, state);
  const matches = request => isDouyinPublicationResponse({ url: () => request.url(), request: () => request });
  const requests = new WeakMap();
  const onRequest = request => {
    if (!matches(request)) return;
    state.requests += 1;
    if (state.attempt) {
      state.attempt.bodyHash ||= bodyHash(request);
      requests.set(request, { attempt: state.attempt, hash: bodyHash(request) });
    }
  };
  const onFailed = request => {
    if (!matches(request)) return;
    state.failures += 1;
    const code = request.failure()?.errorText;
    const allowed = ['net::ERR_TIMED_OUT', 'net::ERR_CONNECTION_RESET', 'net::ERR_CONNECTION_CLOSED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_INTERNET_DISCONNECTED', 'net::ERR_ABORTED', 'net::ERR_FAILED'];
    state.networkErrors.push(allowed.includes(code) ? code : 'network-error');
    state.networkErrors = state.networkErrors.slice(-10);
  };
  const onResponse = async response => {
    if (!isDouyinPublicationResponse(response)) return;
    state.responses += 1;
    const entry = { path: new URL(response.url()).pathname, status: response.status?.() };
    state.responseMetadata.push(entry);
    state.responseMetadata = state.responseMetadata.slice(-10);
    try {
      entry.verificationRequired = await douyinVerificationRequired(response);
      if (entry.verificationRequired) { state.verificationRequired = true; return; }
      const raw = await response.text();
      entry.bodyBytes = Buffer.byteLength(raw);
      const value = parseProviderJson(raw);
      if (Number.isSafeInteger(value?.status_code)) entry.code = value.status_code;
      const id = numericId(value?.item_id || value?.aweme?.aweme_id || value?.data?.item_id);
      if (id) entry.id = id;
      const captured = requests.get(response.request());
      if (response.ok() && captured?.hash && captured.hash === captured.attempt.bodyHash) {
        const receipt = confirmedDouyinPublication(raw, captured.attempt.account);
        if (captured.attempt.receipt && captured.attempt.receipt.id !== receipt.id) captured.attempt.conflicting = true;
        else captured.attempt.receipt = receipt;
      }
    } catch { /* An unreadable response never proves success. */ }
  };
  const onClose = () => { page.off('request', onRequest); page.off('requestfailed', onFailed); page.off('response', onResponse); page.off('close', onClose); };
  page.on('request', onRequest); page.on('requestfailed', onFailed); page.on('response', onResponse); page.on('close', onClose);
  return state;
}

// DOM workflow: social-auto-upload 0012d2c (douyin_uploader/main.py).
// Response fields: AiToEarn 9413d73 (electron/plat/douyin/index.ts).
// Preview structure additionally checked against the official content bundle,
// chunk 231.db7a4650.js, on 2026-09-14. No upstream runtime code is used.
export function douyinAccount(raw) {
  let value;
  try { value = typeof raw === 'string' ? parseProviderJson(raw) : raw; } catch { return null; }
  const user = value?.user;
  const uid = numericId(user?.uid);
  if (value?.status_code !== 0 || !uid || typeof user?.nickname !== 'string' || !user.nickname.trim() || user.nickname.length > 300) return null;
  const account = { uid, name: user.nickname, profileUrl: 'https://www.douyin.com/user/self' };
  if (typeof user.sec_uid === 'string' && /^[A-Za-z0-9_-]{8,200}$/.test(user.sec_uid)) account.profileUrl = `https://www.douyin.com/user/${user.sec_uid}`;
  try {
    const url = new URL(user.avatar_thumb?.url_list?.[0]);
    if (url.protocol === 'https:' && !url.username && !url.password) account.avatarUrl = url.href;
  } catch { /* Avatar is optional. */ }
  return account;
}

export function isDouyinPublicationResponse(response) {
  try {
    const url = new URL(response.url());
    return url.origin === ORIGIN && ['/web/api/media/aweme/create/', '/web/api/media/aweme/create_v2/'].includes(url.pathname) && response.request().method() === 'POST';
  } catch { return false; }
}

export function confirmedDouyinPublication(raw, account, now = () => new Date()) {
  let value;
  try { value = parseProviderJson(raw); } catch { fail('PUBLISH_UNCERTAIN', '抖音发布回执无法解析，请先在官网确认结果。'); }
  if (value?.status_code !== 0) fail('PUBLISH_REJECTED', '抖音未接受这次发布，请查看专用窗口中的提示。');
  const post = value.aweme || value.data?.aweme;
  // The official image create_v2 bundle reads item_id from the root response.
  const ids = [post?.aweme_id, value.item_id, value.data?.item_id].filter(id => id !== undefined).map(numericId);
  const id = ids[0];
  if (!id) fail('PUBLISH_UNCERTAIN', '抖音未返回可核实的作品编号，请先在官网确认，避免重复发布。');
  if (ids.some(other => other !== id)) fail('PUBLISH_UNCERTAIN', '抖音回执中的作品编号不一致，请先在官网核实。');
  const author = numericId(post?.author?.uid);
  if (author && author !== account.uid) fail('PUBLISH_UNCERTAIN', '抖音回执中的作者发生变化，请在官网核实账号和发布结果。');
  return { id, url: `https://www.douyin.com/note/${id}`, publishedAt: now().toISOString(), account: { uid: account.uid, name: account.name } };
}

export function isDouyinImageCommit(response) {
  try {
    const url = new URL(response.url());
    return url.origin === 'https://imagex.bytedanceapi.com' && url.searchParams.get('Action') === 'CommitImageUpload' && response.request().method() === 'POST';
  } catch { return false; }
}

export function douyinUploadedUris(raw) {
  const value = parseProviderJson(raw);
  const images = value?.Result?.Results;
  if (value?.ResponseMetadata?.Error || !Array.isArray(images) || !images.length) fail('IMAGE_UPLOAD_FAILED', '抖音图片上传没有返回有效回执。');
  const uris = images.map((image) => image?.Uri);
  if (uris.some((uri) => typeof uri !== 'string' || !/^[A-Za-z0-9_./-]{5,300}$/.test(uri))) fail('IMAGE_UPLOAD_FAILED', '抖音返回了无法确认的图片编号。');
  return uris;
}

export async function douyinPictureState(page, { editable = true } = {}) {
  return page.locator('body').evaluate((root, requireControls = true) => {
    // The native image editor uses a preview and an upload overlay until the
    // upload promise resolves; its delete/operator controls appear afterwards.
    const cards = [...root.querySelectorAll('div[class^="container"]')].filter((card) => [...card.children].some((child) => /^img-/.test(child.className || '')));
    const ready = cards.filter((card) => {
      const preview = [...card.children].find((child) => /^img-/.test(child.className || ''));
      if (!preview || !preview.getBoundingClientRect().width || card.querySelector('[class^="upload-"], [class^="reload-"], [role="progressbar"]')) return false;
      if (requireControls && (!card.querySelector('img[class^="del-"]') || !card.querySelector('[class^="operator-button-"]'))) return false;
      const image = preview.tagName === 'IMG' ? preview : preview.querySelector('img');
      if (image) return image.complete && image.naturalWidth > 0;
      return /url\(["']?(?:https:|blob:|data:image\/)/.test(getComputedStyle(preview).backgroundImage);
    });
    const sources = cards.map((card) => {
      const preview = [...card.children].find((child) => /^img-/.test(child.className || ''));
      const image = preview?.tagName === 'IMG' ? preview : preview?.querySelector('img');
      return image ? image.currentSrc || image.src : preview ? getComputedStyle(preview).backgroundImage : '';
    });
    return { count: cards.length, ready: ready.length, sources, otherMedia: root.querySelectorAll('video, audio').length };
  }, editable);
}

function validate(input, hooks) {
  if (typeof hooks?.beforeSubmit !== 'function') fail('PUBLISH_REJECTED', '发布检查点缺失，已停止操作。');
  if (typeof input?.title !== 'string' || !input.title.trim() || [...input.title.trim()].length > 30 || typeof input.body !== 'string' || Array.from(input.body.trim()).length > 1000 || /\0/.test(input.title + input.body)) fail('PUBLISH_REJECTED', '抖音图文需要 1–30 字标题，正文最多 1000 字。');
  const files = imageFiles(input.images);
  if (!files.length) fail('IMAGE_UPLOAD_FAILED', '抖音图文至少需要 1 张图片。');
  return { title: input.title.trim(), body: input.body.trim(), files };
}

async function readAccount(page) {
  try {
    if (new URL(page.url()).origin !== ORIGIN) return null;
    // Only a same-origin read of public identity. The browser keeps all session
    // cookies; neither the frontend nor this adapter receives credentials.
    const raw = await page.evaluate(async () => {
      const response = await fetch('/web/api/media/user/info/', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8_000) });
      if (!response.ok) return null;
      // Modern Chrome supplies the original JSON number token to a reviver.
      // Without that support unsafe numeric IDs fail closed instead of rounding.
      const value = JSON.parse(await response.text(), (key, entry, context) => key === 'uid' && typeof entry === 'number'
        ? context?.source || (Number.isSafeInteger(entry) ? String(entry) : null) : entry);
      const user = value?.user;
      if (!user || value.status_code !== 0) return null;
      return { status_code: value.status_code, user: { uid: user.uid, nickname: user.nickname, sec_uid: user.sec_uid,
        avatar_thumb: { url_list: [user.avatar_thumb?.url_list?.[0]] } } };
    });
    return douyinAccount(raw);
  } catch { return null; }
}

async function ensureNoChallenge(page) {
  if (await hasDouyinChallenge(page)) fail('CAPTCHA_REQUIRED', '请在抖音专用窗口手动完成安全验证。');
}

async function composer(page) {
  const title = page.locator(TITLE);
  await title.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  const body = page.locator(BODY);
  const button = page.getByRole('button', { name: '发布', exact: true });
  if (await title.count() !== 1 || await body.count() !== 1 || await button.count() !== 1) fail('UI_CHANGED', '未找到唯一的抖音图文编辑器，请检查专用窗口。');
  return { title, body, button };
}

export function douyinEditorText(element) {
  const lines = [...element.querySelectorAll(':scope > .ace-line[data-node="true"]')];
  // The official editor represents a paragraph break with a data-enter leaf
  // containing a zero-width placeholder. innerText exposes that placeholder
  // and hides one of the original newlines; read the semantic leaves instead.
  const value = lines.length ? lines.map(line => [...line.querySelectorAll('[data-string="true"]')]
    .map(leaf => leaf.getAttribute('data-enter') === 'true' ? '\n' : leaf.textContent || '').join('')).join('\n') : element.innerText;
  return value.replace(/\r\n/g, '\n').trim();
}

async function contentMatches(editor, title, body) {
  return await editor.title.inputValue() === title && await editor.body.evaluate(douyinEditorText) === body;
}

function lifecycleInput(input, hooks, operation) {
  const receipt = input?.receipt;
  if (typeof hooks?.beforeSubmit !== 'function') fail('OPERATION_REJECTED', '操作检查点缺失，已停止操作。');
  if (!numericId(receipt?.id) || !numericId(receipt?.account?.uid) || receipt.account.uid !== input.expectedAccountUid) fail('ACCOUNT_CHANGED', '抖音原作品账号与确认的账号不同，已停止操作。');
  if (receipt.url !== `https://www.douyin.com/note/${receipt.id}` || receipt.deletedAt) fail('OPERATION_REJECTED', '抖音原作品回执无效或已经删除。');
  if (operation === 'update' && (typeof input.title !== 'string' || !input.title.trim() || [...input.title.trim()].length > 30 || typeof input.body !== 'string' || [...input.body.trim()].length > 1000 || /\0/.test(input.title + input.body))) fail('OPERATION_REJECTED', '抖音图文需要 1–30 字标题，正文最多 1000 字。');
  return receipt;
}

/** Read the ID from the request the native website already sent. */
export function douyinNativeRequestId(response) {
  try {
    const request = response.request();
    if (request.method() === 'GET') return numericId(new URL(response.url()).searchParams.get('item_id'));
    const raw = request.postData();
    if (typeof raw !== 'string' || raw.length > 2_000_000) return undefined;
    const isJson = raw.trim().startsWith('{');
    const value = isJson ? parseProviderJson(raw) : new URLSearchParams(raw);
    const ids = (isJson ? [value.item_id, value.aweme_id].filter((entry) => entry !== undefined) : [...value.getAll('item_id'), ...value.getAll('aweme_id')]).map(numericId);
    return ids.length && ids.every((id) => id && id === ids[0]) ? ids[0] : undefined;
  } catch { return undefined; }
}

export function isDouyinLifecycleResponse(response, operation, id) {
  try {
    const url = new URL(response.url());
    const path = operation === 'delete' ? '/web/api/media/aweme/delete/' : '/web/api/media/update/desc/';
    return url.origin === ORIGIN && url.pathname === path && response.request().method() === 'POST' && douyinNativeRequestId(response) === id;
  } catch { return false; }
}

export function confirmedDouyinLifecycle(raw, receipt, operation, now = () => new Date()) {
  let value;
  try { value = parseProviderJson(raw); } catch { fail('OPERATION_UNCERTAIN', '抖音操作回执无法解析，请先核实原作品。'); }
  if (value?.status_code !== 0) fail('OPERATION_REJECTED', '抖音未接受本次操作，请查看专用窗口的提示。');
  // These native endpoints can return only status_code. Their response is bound
  // to the exact native request ID above; any additional target fields must agree.
  const post = value.aweme || value.data?.aweme;
  const ids = [value.item_id, value.aweme_id, value.data?.item_id, post?.aweme_id].filter((entry) => entry !== undefined);
  if (ids.some((id) => numericId(id) !== receipt.id) || (post?.author?.uid !== undefined && numericId(post.author.uid) !== receipt.account.uid)) fail('OPERATION_UNCERTAIN', '抖音操作回执中的作品或作者不一致，请先核实原作品。');
  return { ...receipt, [operation === 'delete' ? 'deletedAt' : 'updatedAt']: now().toISOString() };
}

export function douyinLifecycleTarget(raw, receipt) {
  let value;
  try { value = parseProviderJson(raw); } catch { fail('TARGET_NOT_FOUND', '无法核实抖音原作品，已停止操作。'); }
  const post = value?.aweme;
  if (value?.status_code !== 0 || numericId(post?.aweme_id) !== receipt.id) fail('TARGET_NOT_FOUND', '未找到可核实的抖音原作品，已停止操作。');
  if (numericId(post?.author?.uid) !== receipt.account.uid) fail('ACCOUNT_CHANGED', '抖音原作品作者与发布回执不同，已停止操作。');
  if (!Array.isArray(post.images) || !post.images.length) fail('OPERATION_UNSUPPORTED', '当前抖音作品不是可修改的图文。');
  return post;
}

async function managedCards(page) {
  return page.locator(MANAGED_CARD).evaluateAll((cards) => cards.map((card, index) => {
    // The official managed cards carry no DOM post ID. Read only the card's own
    // React item data; never invoke React handlers or copy session state.
    const key = Object.keys(card).find((name) => name.startsWith('__reactFiber$'));
    let fiber = key ? card[key] : null;
    for (let depth = 0; fiber && depth < 8; depth += 1, fiber = fiber.return) {
      const item = fiber.memoizedProps?.data;
      if (item && typeof item === 'object' && item.aweme_id !== undefined) return { index, id: item.aweme_id, uid: item.author?.uid, imageCount: Array.isArray(item.images) ? item.images.length : 0 };
    }
    return { index };
  }));
}

async function managedCard(page, receipt) {
  const cards = await managedCards(page);
  const matches = cards.filter((card) => numericId(card.id) === receipt.id);
  if (matches.length !== 1) return null;
  if (numericId(matches[0].uid) !== receipt.account.uid) fail('ACCOUNT_CHANGED', '抖音原作品作者与发布回执不同，已停止操作。');
  if (!matches[0].imageCount) fail('OPERATION_UNSUPPORTED', '当前抖音作品不是图文，已停止操作。');
  return page.locator(MANAGED_CARD).nth(matches[0].index);
}

async function deleteDialogMatches(dialog, receipt) {
  if (await dialog.count() !== 1) return false;
  const target = await dialog.evaluate((node) => {
    const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$'));
    let fiber = key ? node[key] : null;
    // A portal adds modal and transition parents between the DOM and card.
    for (let depth = 0; fiber && depth < 30; depth += 1, fiber = fiber.return) {
      const item = fiber.memoizedProps?.data;
      if (item?.aweme_id !== undefined) return { id: item.aweme_id, uid: item.author?.uid };
    }
    return null;
  });
  return numericId(target?.id) === receipt.id && numericId(target?.uid) === receipt.account.uid;
}

function operationFailure(error) {
  const failure = new PlatformBrowserError(error.code === 'PUBLISH_UNCERTAIN' ? 'OPERATION_UNCERTAIN' : error.code || 'OPERATION_UNCERTAIN', error.code ? error.message : '抖音操作已中断，请先核实原作品，避免重复操作。', { cause: error });
  failure.submitted = true;
  return failure;
}

async function updateDouyin(page, input, hooks = {}) {
  const receipt = lifecycleInput(input, hooks, 'update');
  const title = input.title.trim(), body = input.body.trim();
  await sameAccount(page, readAccount, input.expectedAccountUid, '抖音');
  await ensureNoChallenge(page);
  // Official 3559.a1670b08 / 1060.a794b3e7 / 2990.00ee3215 bundles,
  // checked 2026-09-15: mid selects modification; iid selects an unpublished item.
  const detail = waitForPublication(page, (response) => {
    try { const url = new URL(response.url()); return url.origin === ORIGIN && url.pathname === '/web/api/media/item/info/' && response.request().method() === 'GET' && douyinNativeRequestId(response) === receipt.id; } catch { return false; }
  }, { timeoutMs: 20_000 });
  try {
    await page.goto(`${ORIGIN}/creator-micro/content/post/image?mid=${receipt.id}&enter_from=content_manage`, { waitUntil: 'domcontentloaded' });
    douyinLifecycleTarget(await detail.promise, receipt);
  } catch (error) {
    if (error.code === 'PUBLISH_UNCERTAIN') fail('TARGET_NOT_FOUND', '未能从抖音官网核实原作品，已停止修改。');
    throw error;
  } finally { detail.cancel(); }
  const titleField = page.locator(TITLE), bodyField = page.locator(BODY);
  const button = page.getByRole('button', { name: '提交修改', exact: true });
  await button.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  if (await titleField.count() !== 1 || await bodyField.count() !== 1 || await button.count() !== 1 || !await titleField.isEditable() || !await bodyField.isEditable()) fail('OPERATION_UNSUPPORTED', '抖音当前未开放此作品的文字修改，或修改次数已用完。');
  const editor = { title: titleField, body: bodyField, button };
  const pictures = await douyinPictureState(page, { editable: false });
  if (!pictures.count || pictures.ready !== pictures.count || pictures.otherMedia) fail('UI_CHANGED', '未能确认抖音原图已完整加载，已停止修改。');
  const sources = JSON.stringify(pictures.sources);
  await titleField.fill(title);
  await bodyField.fill(body);
  await bodyField.press('Escape');
  const verify = async () => {
    const url = new URL(page.url());
    if (url.origin !== ORIGIN || url.pathname !== '/creator-micro/content/post/image' || url.searchParams.get('mid') !== receipt.id || url.searchParams.has('iid')) fail('UI_CHANGED', '抖音编辑器中的原作品发生变化，已停止修改。');
    const current = await douyinPictureState(page, { editable: false });
    if (current.count !== pictures.count || current.ready !== pictures.ready || current.otherMedia || JSON.stringify(current.sources) !== sources || !await contentMatches(editor, title, body)) fail('UI_CHANGED', '抖音原图或修改内容发生变化，已停止修改。');
    if (!await button.isVisible() || !await button.isEnabled()) fail('OPERATION_UNSUPPORTED', '抖音当前不允许提交此修改。');
  };
  await sameAccount(page, readAccount, input.expectedAccountUid, '抖音');
  await ensureNoChallenge(page);
  await verify();
  await hooks.beforeSubmit();
  let result;
  try {
    await sameAccount(page, readAccount, input.expectedAccountUid, '抖音');
    await ensureNoChallenge(page);
    await verify();
    result = waitForPublication(page, (response) => isDouyinLifecycleResponse(response, 'update', receipt.id));
    await button.click({ timeout: 8_000 });
    return confirmedDouyinLifecycle(await result.promise, receipt, 'update');
  } catch (error) { throw operationFailure(error); }
  finally { result?.cancel(); }
}

async function deleteDouyin(page, input, hooks = {}) {
  const receipt = lifecycleInput(input, hooks, 'delete');
  await sameAccount(page, readAccount, input.expectedAccountUid, '抖音');
  await ensureNoChallenge(page);
  await page.goto(MANAGE_URL, { waitUntil: 'domcontentloaded' });
  let card = await waitUntil(() => managedCard(page, receipt), 15_000);
  // Load additional managed cards through the native page, never by issuing an API request.
  for (let step = 0; !card && step < 8; step += 1) {
    await page.mouse.wheel(0, 1100);
    card = await waitUntil(() => managedCard(page, receipt), 1_000);
  }
  if (!card) fail('TARGET_NOT_FOUND', '未在抖音作品管理中找到原图文；未删除任何内容。');
  await card.hover();
  const entry = card.getByText('删除作品', { exact: true });
  if (await entry.count() !== 1 || !await entry.isVisible()) fail('OPERATION_UNSUPPORTED', '抖音当前未开放此作品的删除操作。');
  await sameAccount(page, readAccount, input.expectedAccountUid, '抖音');
  await ensureNoChallenge(page);
  card = await managedCard(page, receipt);
  if (!card) fail('TARGET_NOT_FOUND', '抖音原作品卡片发生变化，已停止删除。');
  await card.getByText('删除作品', { exact: true }).click({ timeout: 8_000 });
  const dialog = page.getByRole('dialog').filter({ hasText: '确定要移除此作品吗' });
  const button = dialog.getByRole('button', { name: '确定', exact: true });
  await button.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  if (await dialog.count() !== 1 || await button.count() !== 1 || !await button.isEnabled() || !await deleteDialogMatches(dialog, receipt)) fail('OPERATION_UNSUPPORTED', '未找到抖音原作品的明确删除确认，已停止操作。');
  await sameAccount(page, readAccount, input.expectedAccountUid, '抖音');
  await ensureNoChallenge(page);
  if (!await managedCard(page, receipt)) fail('TARGET_NOT_FOUND', '抖音原作品卡片发生变化，已停止删除。');
  await hooks.beforeSubmit();
  let result;
  try {
    await sameAccount(page, readAccount, input.expectedAccountUid, '抖音');
    await ensureNoChallenge(page);
    const url = new URL(page.url());
    if (url.origin !== ORIGIN || url.pathname !== '/creator-micro/content/manage' || !await managedCard(page, receipt) || !await deleteDialogMatches(dialog, receipt) || !await button.isVisible() || !await button.isEnabled()) fail('OPERATION_UNCERTAIN', '抖音删除目标或确认窗口发生变化，请先核实原作品。');
    result = waitForPublication(page, (response) => isDouyinLifecycleResponse(response, 'delete', receipt.id));
    await button.click({ timeout: 8_000 });
    return confirmedDouyinLifecycle(await result.promise, receipt, 'delete');
  } catch (error) { throw operationFailure(error); }
  finally { result?.cancel(); }
}

export function createDouyinAdapter() {
  async function publish(page, input, hooks = {}) {
    const { title, body, files } = validate(input, hooks);
    const account = await sameAccount(page, readAccount, input.expectedAccountUid, '抖音');
    await ensureNoChallenge(page);
    const previous = await douyinPictureState(page);
    if (previous.count || previous.otherMedia) fail('IMAGE_UPLOAD_FAILED', '抖音编辑器已有媒体，请先在专用窗口清空，再从控制台发布。');
    if (page.url() !== UPLOAD_URL) await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded' });
    const entry = page.getByText('发布图文', { exact: true });
    await entry.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    if (await entry.count() !== 1) fail('UI_CHANGED', '未找到唯一的抖音「发布图文」入口。');
    await entry.click();
    const uploadInput = page.locator('div[class^="container"] input[type="file"][accept*="image"]');
    if (await uploadInput.count() !== 1) fail('UI_CHANGED', '未找到唯一的抖音图文图片上传控件。');
    const oldImages = await douyinPictureState(page);
    if (oldImages.count || oldImages.otherMedia) fail('IMAGE_UPLOAD_FAILED', '抖音图文页面已有媒体，请先清空后重新发布。');
    const uris = new Set();
    uploadCounts.set(page, 0);
    let uploadError = false;
    const onUpload = async (response) => {
      if (!isDouyinImageCommit(response)) return;
      try {
        if (!response.ok()) { uploadError = true; return; }
        for (const uri of douyinUploadedUris(await response.text())) uris.add(uri);
        uploadCounts.set(page, uris.size);
      } catch { uploadError = true; }
    };
    page.on('response', onUpload);
    try {
      await uploadInput.setInputFiles(files);
      const ready = await waitUntil(async () => {
        await ensureNoChallenge(page);
        if (uploadError) fail('IMAGE_UPLOAD_FAILED', '抖音拒绝了图片上传，请查看专用窗口。');
        const state = await douyinPictureState(page);
        return uris.size === files.length && state.count === files.length && state.ready === files.length;
      }, 60_000);
      if (!ready) fail('IMAGE_UPLOAD_FAILED', '未能确认全部抖音图片上传完成，已停止发布。');
    } finally { page.off('response', onUpload); }
    const url = new URL(page.url());
    if (url.origin !== ORIGIN || url.pathname !== '/creator-micro/content/post/image') fail('UI_CHANGED', '抖音尚未进入图文发布页，已停止操作。');
    const uploadedSources = JSON.stringify((await douyinPictureState(page)).sources);
    const editor = await composer(page);
    await editor.title.fill(title);
    await editor.body.fill(body);
    await editor.body.press('Escape');
    if (!await contentMatches(editor, title, body)) fail('UI_CHANGED', '抖音编辑器未完整保留标题和正文。');
    await ensureNoChallenge(page);
    await sameAccount(page, readAccount, input.expectedAccountUid, '抖音');
    const checkPictures = async (uncertain = false) => {
      const state = await douyinPictureState(page);
      if (state.count !== files.length || state.ready !== files.length || JSON.stringify(state.sources) !== uploadedSources) fail(uncertain ? 'PUBLISH_UNCERTAIN' : 'IMAGE_UPLOAD_FAILED', '抖音图片状态或顺序发生变化，请先在官网核实。');
    };
    await checkPictures();
    if (!await editor.button.isVisible() || !await editor.button.isEnabled()) fail('UI_CHANGED', '抖音发布按钮尚不可用，请查看专用窗口中的提示。');
    const native = observeDouyinPublication(page);
    await hooks.beforeSubmit();
    native.attempt = { fingerprint: payloadHash(input), account, startedAt: Date.now() };
    let result;
    try {
      await sameAccount(page, readAccount, input.expectedAccountUid, '抖音');
      await ensureNoChallenge(page);
      // Identity may need a network round trip. Read back the native draft only
      // afterwards so an edit made during that wait cannot slip into the post.
      if (!await contentMatches(editor, title, body)) fail('PUBLISH_UNCERTAIN', '提交前抖音内容发生变化，请先在官网核实。');
      await checkPictures(true);
      // The official creator client uses a 45-second HTTP timeout. Waiting only
      // 30 seconds loses its eventual rejection/success while it still shows
      // "正在发布". Allow the native request to finish first.
      result = waitForPublication(page, isDouyinPublicationResponse, { timeoutMs: 65_000,
        responseError: async response => await douyinVerificationRequired(response)
          ? new PlatformBrowserError('CAPTCHA_REQUIRED', '抖音要求本人短信或其他安全验证，请在专用窗口完成后核对同一请求，无需重新发布。') : undefined });
      await editor.button.click({ timeout: 8_000 });
      return confirmedDouyinPublication(await result.promise, account);
    } catch (error) {
      const failure = new PlatformBrowserError(error.code || 'PUBLISH_UNCERTAIN', error.code ? error.message : '抖音提交操作已中断，请先在官网核实结果，避免重复发布。', { cause: error });
      failure.submitted = true;
      throw failure;
    } finally { result?.cancel(); }
  }
  return {
    id: 'douyin', name: '抖音图文', homeUrl: UPLOAD_URL, loginUrl: `${ORIGIN}/`, defaultHeadless: false, resumeHeadless: false,
    readAccount, hasChallenge: hasDouyinChallenge,
    async login(page) {
      if (!await readAccount(page)) await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
      return page;
    },
    publish,
    async reconcilePublication(page, input, { attemptedAt } = {}) {
      const attempt = publishDiagnostics.get(page)?.attempt;
      const timestamp = Date.parse(attemptedAt);
      if (!attempt || attempt.fingerprint !== payloadHash(input) || !Number.isFinite(timestamp) || attempt.startedAt < timestamp - 1000 || attempt.startedAt > timestamp + 120_000) return undefined;
      await sameAccount(page, readAccount, input.expectedAccountUid, '抖音');
      // Completing the website's verification may resend its own original
      // request. Only that same native body and a positive ID can settle it.
      if (attempt.receipt && !attempt.conflicting) return structuredClone(attempt.receipt);
      if (await hasDouyinChallenge(page) || publishDiagnostics.get(page)?.verificationRequired) fail('CAPTCHA_REQUIRED', '请先在抖音专用窗口完成本人安全验证，再核对同一请求。');
      return undefined;
    },
    async diagnostics(page) {
      const pictures = await douyinPictureState(page);
      const native = publishDiagnostics.get(page);
      return { editor: { pictureCount: pictures.count, readyPictureCount: pictures.ready, uploadedPictureCount: uploadCounts.get(page) || 0 },
        ...(native ? { nativePublication: { requests: native.requests, responses: native.responses, failures: native.failures, networkErrors: native.networkErrors }, responseMetadata: native.responseMetadata } : {}) };
    },
    update: updateDouyin,
    delete: deleteDouyin,
  };
}
