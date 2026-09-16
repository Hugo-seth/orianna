import { imageFiles, parseProviderJson } from './weibo-browser.mjs';
import { createHash } from 'node:crypto';

// Verified against the official dynamic-home bundle on 2026-09-14:
// https://s1.hdslb.com/bfs/static/2233-monorepo/dyn-home/static/js/index.27f5a8b3.js
// The website owns login, uploads, validation and the single native submission.
const HOME = 'https://t.bilibili.com/';
const API = 'https://api.bilibili.com';
const INPUT = '.bili-dyn-publishing__input [contenteditable="true"][placeholder="有什么想和大家分享的？"]';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const id = (value) => typeof value === 'string' && /^[1-9]\d{0,31}$/.test(value) ? value
  : Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mutationPath = (operation) => operation === 'update' ? '/x/dynamic/feed/edit/dyn' : '/x/dynamic/feed/operate/remove';
const nativeResponses = new WeakMap();
const reconciliationDiagnostics = new WeakMap();

function observeNativeResponses(page) {
  if (nativeResponses.has(page) || typeof page.on !== 'function') return;
  const history = [];
  nativeResponses.set(page, history);
  page.on('response', async (response) => {
    const paths = ['/x/dynamic/feed/create/dyn', '/x/dynamic/feed/create/submit_check', '/x/dynamic/feed/draw/upload_bfs'];
    const pathname = paths.find((entry) => isBilibiliResponse(response, entry));
    if (!pathname) return;
    const item = { at: new Date().toISOString(), pathname, method: 'POST', httpStatus: typeof response.status === 'function' ? response.status() : undefined };
    history.push(item);
    if (history.length > 20) history.shift();
    try {
      const result = parseProviderJson(await response.text());
      if (typeof result?.code === 'number') item.code = result.code;
      if (id(result?.data?.dyn_id_str)) item.dynamicId = id(result.data.dyn_id_str);
      if (id(result?.data?.dyn_id)) item.numericDynamicId = id(result.data.dyn_id);
      if (typeof result?.data?.dyn_type === 'number') item.dynamicType = result.data.dyn_type;
      if (typeof result?.data?.result === 'number') item.result = result.data.result;
    } catch { item.unreadableBody = true; }
  });
}

export function bilibiliPublicationTimestamp(value) {
  if (typeof value === 'string') {
    // The current official space feed serializes pub_ts as a decimal string.
    // Accept only its canonical integer representation, never coercive dates,
    // signs, whitespace, fractions, exponent notation or unsafe integers.
    if (!/^[1-9]\d{0,15}$/.test(value)) return undefined;
    value = Number(value);
  }
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function bilibiliReconcileCandidate(item, { uid, text, imageCount, imageKeys, attemptedAt }) {
  if (!item || !['DYNAMIC_TYPE_WORD', 'DYNAMIC_TYPE_DRAW'].includes(item.type) || item.orig) return undefined;
  const author = item.modules?.module_author;
  const postId = id(item.id_str);
  const timestamp = bilibiliPublicationTimestamp(author?.pub_ts);
  const attemptMs = Date.parse(attemptedAt);
  if (!postId || id(author?.mid) !== uid || !Number.isSafeInteger(timestamp) || timestamp <= 0 || !Number.isFinite(attemptMs)) return undefined;
  const publishedMs = timestamp * 1000;
  if (publishedMs < Math.floor(attemptMs / 1000) * 1000 || publishedMs > attemptMs + 10 * 60_000 || publishedMs > Date.now() + 60_000) return undefined;
  const dynamic = item.modules?.module_dynamic;
  if (!dynamic || dynamic.additional || dynamic.topic) return undefined;
  const opus = dynamic.major?.opus;
  const rich = opus ? opus.summary : dynamic.desc;
  if (!rich || typeof rich.text !== 'string' || rich.text !== text || rich.has_more === true || opus && rich.has_more !== false || rich.paragraphs?.length || opus?.title) return undefined;
  if (!Array.isArray(rich.rich_text_nodes) || rich.rich_text_nodes.some((node) => node?.type !== 'RICH_TEXT_NODE_TYPE_TEXT' || typeof node?.text !== 'string') || rich.rich_text_nodes.map((node) => node.text).join('') !== text) return undefined;
  const pictures = opus?.pics || dynamic.major?.draw?.items || [];
  if (!Array.isArray(pictures) || pictures.length !== imageCount) return undefined;
  if (imageCount) {
    if (!Array.isArray(imageKeys) || imageKeys.length !== imageCount) return undefined;
    const keys = pictures.map((picture) => bilibiliPictureKey(picture?.url || picture?.src));
    if (keys.some((key, index) => !key || key !== imageKeys[index])) return undefined;
  }
  return { id: postId, url: `${HOME}${postId}`, publishedAt: new Date(publishedMs).toISOString(), account: { uid, name: typeof author.name === 'string' && author.name.trim() ? author.name : '' } };
}

async function readReconcileFeed(page, uid, offset = '', detailId, record = () => {}) {
  let value;
  try { value = await page.evaluate(async ({ uid, offset, detailId }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7_000);
    const diagnostic = { kind: detailId ? 'detail' : 'feed', outcome: 'network-error' };
    const shape = (value) => value === undefined ? 'missing' : Array.isArray(value) ? 'array' : value && typeof value === 'object' ? 'object' : 'other';
    const stop = (outcome) => ({ diagnostic: { ...diagnostic, outcome } });
    let stage = 'network-error';
    try {
      const url = new URL(detailId ? 'https://api.bilibili.com/x/polymer/web-dynamic/v1/detail' : 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space');
      url.search = new URLSearchParams(detailId ? { id: detailId, timezone_offset: String(new Date().getTimezoneOffset()), preview: '1', gaia_source: 'main_web' } : { host_mid: uid, offset, timezone_offset: String(new Date().getTimezoneOffset()), platform: 'web' }).toString();
      const response = await fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (Number.isInteger(response.status)) diagnostic.status = response.status;
      if (!response.ok) return stop('http-error');
      stage = 'body-error';
      const result = await response.json();
      if (Number.isSafeInteger(result?.code)) diagnostic.code = result.code;
      diagnostic.itemsShape = shape(result?.data?.items);
      diagnostic.itemShape = shape(result?.data?.item);
      diagnostic.hasMoreType = result?.data?.has_more === undefined ? 'missing' : ['boolean', 'number', 'string'].includes(typeof result.data.has_more) ? typeof result.data.has_more : 'other';
      if (typeof result?.data?.has_more === 'boolean') diagnostic.hasMore = result.data.has_more;
      const source = detailId ? [result?.data?.item] : result?.data?.items;
      if (Array.isArray(source) && source.length <= 100) diagnostic.itemCount = source.length;
      if (result?.code !== 0) return stop('provider-error');
      if (!Array.isArray(source) || source.some((item) => !item) || source.length > 100) return stop('shape-error');
      stage = 'shape-error';
      // Return only public post content needed to identify the original request.
      const items = source.map((item) => {
        const author = item.modules?.module_author;
        const dynamic = item.modules?.module_dynamic;
        const selectText = (value) => value ? { text: value.text, has_more: value.has_more, paragraphs: value.paragraphs?.length ? [true] : undefined, rich_text_nodes: value.rich_text_nodes?.map((node) => ({ text: node.text, type: node.type })) } : undefined;
        const opus = dynamic?.major?.opus;
        return { id_str: item.id_str, type: item.type, orig: Boolean(item.orig), modules: {
          module_author: { mid: author?.mid, name: author?.name, pub_ts: author?.pub_ts },
          module_dynamic: { additional: Boolean(dynamic?.additional), topic: Boolean(dynamic?.topic), desc: selectText(dynamic?.desc), major: {
            opus: opus ? { title: opus.title, summary: selectText(opus.summary), pics: opus.pics?.map((picture) => ({ url: picture.url })) } : undefined,
            draw: dynamic?.major?.draw ? { items: dynamic.major.draw.items?.map((picture) => ({ src: picture.src })) } : undefined,
          } },
        } };
      });
      return { items, hasMore: result.data.has_more, offset: typeof result.data.offset === 'string' ? result.data.offset : '', diagnostic: { ...diagnostic, outcome: 'ok' } };
    } catch { return stop(controller.signal.aborted ? 'timeout' : stage); }
    finally { clearTimeout(timer); }
  }, { uid, offset, detailId }); }
  catch { value = { diagnostic: { kind: detailId ? 'detail' : 'feed', outcome: 'page-error' } }; }
  record(value?.diagnostic || { kind: detailId ? 'detail' : 'feed', outcome: value?.items ? 'ok' : 'shape-error' });
  return value;
}

async function verifyReconcileImages(page, inputImages, pictureUrls, record = () => {}) {
  const expected = bilibiliImageFiles(inputImages);
  if (expected.length !== pictureUrls.length || pictureUrls.some((url) => !bilibiliPictureKey(url))) return undefined;
  let value;
  try { value = await page.evaluate(async ({ originals, keys }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const diagnostic = { kind: 'image', outcome: 'byte-match' };
    let processing = 'network-error';
    const stop = (outcome, verified) => ({ verified, diagnostic: { ...diagnostic, outcome } });
    const digest = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
    const staticImage = (bytes) => {
      // Parse PNG chunks rather than trusting data-URL MIME or a CDN extension.
      const png = [137, 80, 78, 71, 13, 10, 26, 10];
      if (png.every((value, index) => bytes[index] === value)) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let position = 8, first = true;
        while (position + 12 <= bytes.length) {
          const length = view.getUint32(position);
          if (position + 12 + length > bytes.length) return false;
          const type = String.fromCharCode(...bytes.subarray(position + 4, position + 8));
          if (first && (type !== 'IHDR' || length !== 13) || type === 'acTL' || type === 'fcTL' || type === 'fdAT') return false;
          first = false;
          position += 12 + length;
          if (type === 'IEND') return length === 0 && position === bytes.length;
        }
        return false;
      }
      // JPEG/GIF and unknown formats retain the exact-byte path. A permissive
      // browser decoder can otherwise ignore extra images after the first one.
      return false;
    };
    const pixels = async (blob) => {
      const bitmap = await createImageBitmap(blob);
      try {
        if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 20_000_000) return null;
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        return { width: bitmap.width, height: bitmap.height, hash: await digest(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data) };
      } finally { bitmap.close(); }
    };
    try {
      for (let index = 0; index < originals.length; index++) {
        const original = Uint8Array.from(atob(originals[index].base64), (char) => char.charCodeAt(0));
        // Public original image only: fixed CDN host/path, no account cookies,
        // arbitrary URL, query parameters or redirect-following are permitted.
        const response = await fetch(`https://i0.hdslb.com${keys[index]}`, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
        if (Number.isInteger(response.status)) diagnostic.status = response.status;
        if (!response.ok) return stop('http-error');
        if (Number(response.headers.get('content-length')) > 15 * 1024 * 1024) return stop('size-limit');
        if (!response.body) return stop('body-error');
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 15 * 1024 * 1024) { await reader.cancel(); return stop('size-limit'); }
          chunks.push(next.value);
        }
        const blob = new Blob(chunks);
        const actual = new Uint8Array(await blob.arrayBuffer());
        if (await digest(actual) === await digest(original)) continue;
        // One decoded frame cannot establish GIF, APNG or unknown media identity.
        if (!staticImage(original) || !staticImage(actual)) return stop('unsupported-format');
        processing = 'decode-error';
        const actualPixels = await pixels(blob);
        const expectedPixels = await pixels(new Blob([original], { type: originals[index].mimeType }));
        if (!actualPixels || !expectedPixels) return stop('size-limit');
        if (actualPixels.width !== expectedPixels.width || actualPixels.height !== expectedPixels.height || actualPixels.hash !== expectedPixels.hash) return stop('pixel-mismatch', false);
        diagnostic.outcome = 'pixel-match';
        processing = 'network-error';
      }
      return stop(diagnostic.outcome, true);
    } catch { return stop(controller.signal.aborted ? 'timeout' : processing); }
    finally { clearTimeout(timer); }
  }, { originals: expected.map((file) => ({ base64: file.buffer.toString('base64'), mimeType: file.mimeType })), keys: pictureUrls.map(bilibiliPictureKey) }); }
  catch { value = { diagnostic: { kind: 'image', outcome: 'page-error' } }; }
  record(value?.diagnostic || { kind: 'image', outcome: value === true ? 'byte-match' : value === false ? 'pixel-mismatch' : 'shape-error' });
  return value && typeof value === 'object' ? value.verified : value;
}

function isBilibiliDocument(value) {
  try { const url = new URL(value); return url.origin === 'https://t.bilibili.com' || url.origin === 'https://www.bilibili.com' && /^\/opus\/[1-9]\d*\/?$/.test(url.pathname); }
  catch { return false; }
}

export function bilibiliMutationTarget(input) {
  const receipt = input?.receipt;
  const targetId = id(receipt?.id);
  const uid = id(receipt?.account?.uid);
  let url;
  try { url = new URL(receipt?.url); } catch { /* Rejected below. */ }
  if (!targetId || !uid || uid !== input.expectedAccountUid || !url || url.username || url.password
    || !(url.origin === 'https://t.bilibili.com' && url.pathname === `/${targetId}` || url.origin === 'https://www.bilibili.com' && url.pathname === `/opus/${targetId}`)) fail('PUBLISH_REJECTED', 'B站原动态回执或账号信息无效，已停止操作。');
  return { id: targetId, uid, receipt };
}

export function isBilibiliMutationResponse(response, operation, targetId) {
  if (!['update', 'delete'].includes(operation) || !isBilibiliResponse(response, mutationPath(operation))) return false;
  try {
    const data = parseProviderJson(response.request().postData());
    return typeof data.dyn_id_str === 'string' && data.dyn_id_str === targetId;
  } catch { return false; }
}

export function confirmedBilibiliMutation(raw, operation, target, now = () => new Date()) {
  let result;
  try { result = parseProviderJson(raw); } catch { fail('PUBLISH_UNCERTAIN', 'B站操作回执无法解析，请先到原动态核对结果。'); }
  if (result?.code !== 0) fail(typeof result?.code === 'number' ? 'PUBLISH_REJECTED' : 'PUBLISH_UNCERTAIN', 'B站未确认本次动态操作成功，请先核对原动态。');
  const returnedId = result.data?.dyn_id_str;
  if (returnedId !== undefined && returnedId !== target.id) fail('PUBLISH_UNCERTAIN', 'B站操作回执与原动态编号不同，请先核对结果。');
  const returnedAuthor = result.data?.uid;
  if (returnedAuthor !== undefined && id(returnedAuthor) !== target.uid) fail('PUBLISH_UNCERTAIN', 'B站操作回执与原动态作者不同，请先核对结果。');
  // Delete returns code zero without an ID. The watcher must bind success to
  // the original ID in the website's actual POST body before calling this.
  return { ...target.receipt, [operation === 'update' ? 'updatedAt' : 'deletedAt']: now().toISOString() };
}

export function waitForBilibiliMutation(page, operation, targetId, timeoutMs = 30_000) {
  let done = false, reading = false, timer, resolveWait, rejectWait;
  const uncertain = () => Object.assign(new Error('B站动态操作结果尚未确认，请先核对原动态，避免重复操作。'), { code: 'PUBLISH_UNCERTAIN' });
  const dispose = () => { clearTimeout(timer); page.off('response', onResponse); page.off('close', onClose); };
  const finish = (error, result) => { if (done) return; done = true; dispose(); error ? rejectWait(error) : resolveWait(result); };
  const onClose = () => finish(uncertain());
  const onResponse = async (response) => {
    if (done || reading || !isBilibiliMutationResponse(response, operation, targetId)) return;
    reading = true;
    try { if (!response.ok()) throw uncertain(); finish(null, await response.text()); }
    catch { finish(uncertain()); }
  };
  const promise = new Promise((resolve, reject) => {
    resolveWait = resolve; rejectWait = reject;
    page.on('response', onResponse); page.on('close', onClose);
    timer = setTimeout(() => finish(uncertain()), timeoutMs);
  });
  promise.catch(() => {});
  return { promise, cancel: () => finish(uncertain()) };
}

export function bilibiliAccount(state) {
  const uid = id(state?.mid);
  if (state?.isLogin !== true || !uid || typeof state.uname !== 'string' || !state.uname.trim() || state.uname.length > 300) return null;
  const account = { uid, name: state.uname, profileUrl: `https://space.bilibili.com/${uid}` };
  try {
    if (typeof state.face !== 'string' || !state.face.trim()) return account;
    const url = new URL(state.face.startsWith('//') ? `https:${state.face}` : state.face);
    if (url.protocol === 'https:' && /(^|\.)hdslb\.com$/.test(url.hostname) && !url.username && !url.password) account.avatarUrl = url.href;
  } catch { /* Optional public avatar. */ }
  return account;
}

export function composeBilibiliText({ title = '', body = '' } = {}) {
  if (typeof title !== 'string' || typeof body !== 'string') fail('PUBLISH_REJECTED', 'B站动态标题和正文必须是文字。');
  const text = [title.trim(), body.trim()].filter(Boolean).join('\n\n');
  if (!text || /[\0\u200b]/.test(text)) fail('PUBLISH_REJECTED', '请输入有效的B站动态正文，不支持空字符或零宽空格。');
  // Native publishing offers an article conversion above this boundary. Do not
  // enter that flow: this connector publishes ordinary dynamics only.
  if (Array.from(text).length > 1_000) fail('PUBLISH_REJECTED', 'B站动态标题与正文合计最多 1000 个字符。');
  return text;
}

export function bilibiliImageFiles(images = []) {
  let files;
  try { files = imageFiles(images); }
  catch (error) { fail(error.code || 'IMAGE_UPLOAD_FAILED', error.message.replaceAll('微博', 'B站动态')); }
  if (files.some((file) => !['image/png', 'image/jpeg', 'image/gif'].includes(file.mimeType))) fail('IMAGE_UPLOAD_FAILED', 'B站动态图片仅支持 PNG、JPEG 和 GIF。');
  return files;
}

export function isBilibiliResponse(response, pathname) {
  try { const url = new URL(response.url()); return url.origin === API && url.pathname === pathname && response.request().method() === 'POST'; }
  catch { return false; }
}

export function bilibiliPictureKey(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !/(^|\.)hdslb\.com$/.test(url.hostname) || url.username || url.password || !/^\/bfs\/new_dyn\/[A-Za-z0-9_-]+\.(png|jpe?g|gif)$/i.test(url.pathname)) return undefined;
    return url.pathname;
  } catch { return undefined; }
}

export function bilibiliUploadedPicture(raw) {
  let response;
  try { response = parseProviderJson(raw); } catch { fail('IMAGE_UPLOAD_FAILED', 'B站图片上传回执无法解析。'); }
  const picture = response?.data;
  const key = bilibiliPictureKey(picture?.image_url);
  if (response?.code !== 0 || !key || !Number.isFinite(picture.image_width) || picture.image_width <= 0 || !Number.isFinite(picture.image_height) || picture.image_height <= 0) fail('IMAGE_UPLOAD_FAILED', 'B站未确认图片上传成功。');
  return key;
}

export function confirmedBilibiliPublication(raw, account, now = () => new Date()) {
  let response;
  try { response = parseProviderJson(raw); } catch { fail('PUBLISH_UNCERTAIN', 'B站返回的发布结果无法解析，请先到B站确认，避免重复发布。'); }
  if (typeof response?.code !== 'number') fail('PUBLISH_UNCERTAIN', 'B站未返回可确认的发布状态，请先到B站确认。');
  if (response.code !== 0) fail('PUBLISH_REJECTED', 'B站没有接受这次发布，请查看专用窗口中的提示。');
  const dynId = id(response.data?.dyn_id_str);
  if (!dynId || (response.data?.result !== undefined && response.data.result !== 0)) fail('PUBLISH_UNCERTAIN', 'B站尚未返回可验证的动态编号，请先到B站确认，避免重复发布。');
  if (response.data?.dyn_type === 1) fail('PUBLISH_UNCERTAIN', 'B站返回了转发动态的回执，请先到B站确认发布结果。');
  const author = id(response.data?.uid) || id(response.data?.fake_card?.extend?.uid);
  if (author && author !== account.uid) fail('PUBLISH_UNCERTAIN', 'B站发布账号与确认账号不同，请先到B站核对。');
  return { id: dynId, url: `${HOME}${dynId}`, publishedAt: now().toISOString(), account: { uid: account.uid, name: account.name } };
}

export function waitForBilibiliPublication(page, timeoutMs = 30_000) {
  let resolveWait, rejectWait, timer, done = false, reading = false;
  const dispose = () => { clearTimeout(timer); page.off('response', onResponse); page.off('close', onClose); };
  const finish = (error, value) => { if (done) return; done = true; dispose(); error ? rejectWait(error) : resolveWait(value); };
  const uncertain = (message) => Object.assign(new Error(message), { code: 'PUBLISH_UNCERTAIN' });
  const onClose = () => finish(uncertain('B站窗口已关闭，无法确认发布结果。'));
  const onResponse = async (response) => {
    if (done || reading || !isBilibiliResponse(response, '/x/dynamic/feed/create/dyn')) return;
    reading = true;
    try {
      if (!response.ok()) throw uncertain('B站发布请求返回异常，请先到B站检查结果。');
      finish(null, await response.text());
    } catch { finish(uncertain('B站发布回执读取失败，请先到B站确认，避免重复发布。')); }
  };
  const promise = new Promise((resolve, reject) => {
    resolveWait = resolve; rejectWait = reject;
    page.on('response', onResponse); page.on('close', onClose);
    timer = setTimeout(() => finish(uncertain('等待B站动态回执超时，请先到B站确认，避免重复发布。')), timeoutMs);
  });
  promise.catch(() => {});
  return { promise, cancel: () => finish(uncertain('B站发布操作已中断，请先确认结果。')) };
}

async function challenge(page) {
  return page.locator('iframe[src*="captcha"]:visible, iframe[src*="geetest"]:visible, .geetest_panel:visible, .bili-mini-mask:visible').count().then((count) => count > 0);
}

async function findComposer(page) {
  const root = page.locator('.bili-dyn-publishing:visible');
  await root.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  if (await root.count() !== 1 || await root.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " bili-dyn-edit ")]').count()) fail('UI_CHANGED', '未找到唯一的新建B站动态编辑区，请在专用窗口打开动态首页。');
  const input = root.locator(`${INPUT}:visible`);
  const button = root.locator('.bili-dyn-publishing__action.launcher:visible').filter({ hasText: /^\s*发布\s*$/ });
  if (await input.count() !== 1 || await button.count() !== 1) fail('UI_CHANGED', 'B站原生动态编辑器发生变化，已停止操作。');
  return { root, input, button, title: root.locator('input.bili-dyn-publishing__title__input') };
}

async function fillNativeText(page, composer, text) {
  // B站's rich textarea maintains text nodes and handles Enter itself. Native
  // bulk fill with newlines can insert browser <div> nodes the editor rejects.
  await composer.input.click();
  await composer.input.press('ControlOrMeta+A');
  await composer.input.press('Backspace');
  const clearDeadline = Date.now() + 3_000;
  while ((await bilibiliEditorState(composer.root))?.body !== '' && Date.now() < clearDeadline) await delay(50);
  for (const [index, line] of text.split('\n').entries()) {
    if (index) await composer.input.press('Enter');
    if (line) await page.keyboard.insertText(line);
    await delay(20);
  }
  const deadline = Date.now() + 3_000;
  while ((await bilibiliEditorState(composer.root))?.body !== text && Date.now() < deadline) await delay(50);
}

/** Read only the selected content and public editor state, never session data. */
export async function bilibiliEditorState(root, { verifyPreviews = false } = {}) {
  return root.evaluate(async (element, { verifyPreviews = false } = {}) => {
    const vm = element.__vue__;
    if (vm?.$options?.name !== 'bili-dyn-publishing') return null;
    const tiles = [...element.querySelectorAll('.bili-pics-uploader__item')];
    const readyTiles = tiles.filter((tile) => tile.classList.contains('success') && tile.querySelector('.bili-pics-uploader-item-preview__pic') && !tile.querySelector('.bili-pics-uploader-item-error, .bili-pics-uploader-item-skeleton'));
    const loaded = verifyPreviews ? await Promise.all(readyTiles.map(async (tile) => {
      try {
        const css = getComputedStyle(tile.querySelector('.bili-pics-uploader-item-preview__pic')).backgroundImage;
        if (typeof css !== 'string' || !css.startsWith('url(') || !css.endsWith(')')) return false;
        let source = css.slice(4, -1).trim();
        if ((source.startsWith('"') && source.endsWith('"')) || (source.startsWith("'") && source.endsWith("'"))) source = source.slice(1, -1);
        if (!source || source.includes('\\') || source.length > 5 * 1024 * 1024) return false;
        const url = new URL(source);
        const allowed = /^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(source)
          || url.protocol === 'blob:' && url.origin === location.origin
          || url.protocol === 'https:' && /(^|\.)hdslb\.com$/.test(url.hostname) && !url.username && !url.password && url.pathname.startsWith('/bfs/');
        if (!allowed) return false;
        // The official preview is a CSS background div. Its existence and
        // SUCCESS class do not prove that the exact displayed image decoded.
        return await new Promise((resolve) => {
          const preview = new Image();
          const finish = (value) => { clearTimeout(timer); preview.onload = preview.onerror = null; preview.src = ''; resolve(value); };
          const timer = setTimeout(() => finish(false), 2_000);
          preview.onload = () => finish(preview.naturalWidth > 0 && preview.naturalHeight > 0);
          preview.onerror = () => finish(false);
          preview.src = source;
        });
      } catch { return false; }
    })) : undefined;
    const ready = loaded ? loaded.filter(Boolean).length : readyTiles.length;
    return {
      body: vm.content?.value,
      title: vm.title,
      editorId: vm.editInfo?.data?.id,
      authorUid: vm.user?.mid,
      editConfirmation: vm.editInfo?.config?.toast || '是否确认发布编辑内容？',
      editing: vm.editInfo?.active === true,
      initializing: vm.loadingState?.init === true,
      publishing: vm.loadingState?.publish === true,
      forwarding: vm.editInfo?.data?.forward === true,
      scheduled: vm.timingSettingActive === true,
      overLimit: vm.hint?.heedful === true,
      attachments: Boolean(vm.attachment || vm.attachCard || vm.topic?.id || vm.onlyfansOption?.value || vm.visibleOption?.value),
      pictures: (vm.tools?.pic?.data || []).map((picture) => picture?.img_src || null),
      uploading: tiles.some((tile) => tile.classList.contains('loading')) || (vm.tools?.pic?.data || []).some((picture) => picture?.status === 'LOADING'),
      uploaderMin: element.querySelector?.('.bili-pics-uploader')?.__vue__?.minAmount,
      count: tiles.length,
      ready,
      ...(loaded ? { previewLoaded: ready, previewMissing: tiles.length - ready } : {}),
      failed: tiles.some((tile) => tile.classList.contains('error')),
    };
  }, { verifyPreviews });
}

/** Selected public original-post fields from the official dyn-item/opus view. */
export async function bilibiliPublishedState(root) {
  return root.evaluate((element) => {
    const vm = element.__vue__;
    const data = vm?.$props?.data || vm?.data;
    if (!data) return null;
    let kind, author, menu, pictures, unsupportedMedia = false;
    if (element.classList.contains('bili-dyn-item') && vm.$options?.name === 'dyn-item') {
      kind = 'card'; author = data.modules?.module_author;
      menu = vm.more?.list;
      pictures = data.modules?.module_dynamic?.major?.opus?.pics?.map((picture) => picture.url) || [];
      if (data.modules?.module_dynamic?.major?.draw?.items?.length) return null;
      if (!['DYNAMIC_TYPE_WORD', 'DYNAMIC_TYPE_DRAW'].includes(data.type)) return null;
    } else if ((element.classList.contains('bili-opus-view') || element.classList.contains('bili-opus-view-wrap')) && Array.isArray(data.modules)) {
      kind = 'opus'; author = data.modules.find((item) => item.module_type === 'MODULE_TYPE_AUTHOR')?.module_author;
      if (String(author?.mid) !== String(data.basic?.uid)) return null;
      // OpusMore exposes the exact rendered menu, after the website transforms
      // its server-provided three_point_items. This is read-only public UI data.
      const more = element.querySelector('.opus-more')?.__vue__;
      menu = more?.options;
      const top = data.modules.find((item) => item.module_type === 'MODULE_TYPE_TOP')?.module_top;
      pictures = top?.display?.type === 1 ? (top.display.album?.pics || []).map((picture) => picture.url) : [];
      for (const paragraph of data.modules.find((item) => item.module_type === 'MODULE_TYPE_CONTENT')?.module_content?.paragraphs || []) {
        if (paragraph.para_type === 2) {
          const next = (paragraph.pic?.pics || []).map((picture) => picture.url);
          if (pictures.length && next.length && JSON.stringify(pictures) !== JSON.stringify(next)) unsupportedMedia = true;
          pictures = next;
        }
      }
    } else return null;
    return {
      kind, id: data.id_str, uid: author?.mid, editable: data.basic?.editable === true,
      pictures, unsupportedMedia,
      actions: (menu || []).filter((item) => ['THREE_POINT_EDIT', 'THREE_POINT_DELETE'].includes(item.value)).map((item) => ({
        type: item.value, label: item.label, jumpUrl: item.jump_url,
        modal: item.modal ? { title: item.modal.title, content: item.modal.content, confirm: item.modal.confirm } : undefined,
      })),
    };
  });
}

async function findPublishedRoot(page, target) {
  const roots = page.locator('.bili-dyn-item:visible, .bili-opus-view:visible, .bili-opus-view-wrap:visible');
  await roots.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  const found = [];
  const count = await roots.count();
  if (count > 100) fail('UI_CHANGED', 'B站动态页面内容不明确，已停止操作。');
  for (let index = 0; index < count; index++) {
    const root = roots.nth(index);
    const state = await bilibiliPublishedState(root);
    if (state?.id === target.id) found.push({ root, state });
  }
  if (found.length !== 1) fail('UI_CHANGED', '未找到唯一的B站原动态，请打开原动态核对。');
  if (id(found[0].state.uid) !== target.uid) fail('ACCOUNT_CHANGED', 'B站原动态作者与确认账号不一致，已停止操作。');
  return found[0];
}

async function originalAction(page, original, operation) {
  if (await page.locator('.bili-modal[role="dialog"]:visible, .bili-dyn-edit:visible').count()) fail('UI_CHANGED', 'B站页面已有待处理的编辑或确认窗口，请先关闭后重试。');
  const type = operation === 'update' ? 'THREE_POINT_EDIT' : 'THREE_POINT_DELETE';
  const matches = original.state.actions.filter((action) => action.type === type);
  if (matches.length !== 1 || typeof matches[0].label !== 'string' || !matches[0].label.trim() || matches[0].jumpUrl || operation === 'update' && !original.state.editable) fail('OPERATION_UNSUPPORTED', operation === 'update' ? 'B站当前不支持在原生动态编辑器中修改这条动态。' : 'B站当前未提供这条动态的原生删除入口。');
  const action = matches[0];
  const hover = original.root.locator(original.state.kind === 'opus' ? '.opus-more:visible' : '.bili-dyn-more__btn:visible');
  if (await hover.count() !== 1) fail('UI_CHANGED', 'B站原动态菜单不明确，已停止操作。');
  await hover.hover();
  const selector = original.state.kind === 'opus' ? '.opus-more__cascader' : '.bili-dyn-more__cascader';
  const item = original.root.locator(`${selector} .bili-cascader-options__item:not(.is-disabled):visible`).filter({ hasText: action.label });
  if (await item.count() !== 1 || (await item.locator('.bili-cascader-options__item-label').innerText()).trim() !== action.label.trim()) fail('UI_CHANGED', 'B站原动态操作菜单发生变化，已停止操作。');
  return { item, action };
}

async function mutationDialog(page, expected) {
  const dialogs = page.locator('.bili-modal[role="dialog"]:visible');
  await dialogs.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  if (await dialogs.count() !== 1) fail('UI_CHANGED', 'B站操作确认窗口不明确，已停止操作。');
  const dialog = dialogs.first();
  const title = (await dialog.locator('.bili-modal__title').innerText()).trim();
  const content = (await dialog.locator('.bili-modal__content').innerText()).trim();
  const button = dialog.locator('button.bili-modal__button.confirm:visible');
  if (title !== expected.title || content !== expected.content || await button.count() !== 1 || (await button.innerText()).trim() !== expected.confirm) fail('UI_CHANGED', 'B站确认内容与原动态操作不一致，已停止操作。');
  return button;
}

export function bilibiliPicturesReady(state, expectedKeys = []) {
  if (!state || state.failed || state.count !== expectedKeys.length || state.ready !== expectedKeys.length || state.pictures.length !== expectedKeys.length) return false;
  const actual = state.pictures.map(bilibiliPictureKey);
  // Preserve order and duplicates: the user approved this exact image sequence.
  return actual.every((key, index) => key && key === expectedKeys[index]);
}

async function uploadImages(page, composer, files) {
  const uploaded = [];
  let uploadFailed = false;
  const onResponse = async (response) => {
    if (!isBilibiliResponse(response, '/x/dynamic/feed/draw/upload_bfs')) return;
    try {
      if (!response.ok()) throw new Error();
      uploaded.push(bilibiliUploadedPicture(await response.text()));
    } catch { uploadFailed = true; }
  };
  page.on('response', onResponse);
  try {
    // Official uploader creates a detached file input. Use its native chooser,
    // opened from the scoped image tool, instead of injecting a synthetic input.
    const existingAdd = composer.root.locator('.bili-pics-uploader__add:visible');
    const add = await existingAdd.count() === 1 ? existingAdd : composer.root.locator('.bili-dyn-publishing__tools__item.pic:visible');
    if (await add.count() !== 1) fail('UI_CHANGED', '未找到唯一的B站动态图片入口。');
    const chooserWait = page.waitForEvent('filechooser', { timeout: 8_000 });
    chooserWait.catch(() => {});
    await add.click();
    const chooser = await chooserWait;
    await chooser.setFiles(files);
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (page.isClosed()) fail('BROWSER_CLOSED', 'B站专用窗口已关闭。');
      const state = await bilibiliEditorState(composer.root, { verifyPreviews: true });
      if (state?.overLimit) fail('PUBLISH_REJECTED', 'B站编辑器提示字数超限，请缩短正文后重试。');
      if (uploadFailed || state?.failed) fail('IMAGE_UPLOAD_FAILED', 'B站图片上传失败，已停止发布。');
      if (uploaded.length === files.length && bilibiliPicturesReady(state, uploaded)) return uploaded;
      if (uploaded.length > files.length) fail('IMAGE_UPLOAD_FAILED', 'B站图片上传数量发生变化，已停止发布。');
      if (await challenge(page)) fail('CAPTCHA_REQUIRED', '请先在B站专用窗口完成登录或安全验证。');
      await delay(200);
    }
    fail('IMAGE_UPLOAD_FAILED', '未能确认所有B站图片已上传，已停止发布。');
  } finally { page.off('response', onResponse); }
}

export function createBilibiliAdapter() {
  async function readAccount(page) {
    observeNativeResponses(page);
    if (page.isClosed() || !isBilibiliDocument(page.url())) return null;
    try {
      const state = await page.evaluate(async () => {
        // Official BiliUser._getNav() uses this GET endpoint (bundle above,
        // rechecked 2026-09-15). Its boot cache can survive a login change in
        // another tab, so every identity check must use the current session.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        try {
          const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
            method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error', signal: controller.signal,
          });
          if (!response.ok) return null;
          const result = await response.json();
          if (result?.code !== 0 || result.data?.isLogin !== true) return null;
          const value = result.data;
          return { isLogin: true, mid: value.mid, uname: value.uname, face: value.face };
        } catch { return null; }
        finally { clearTimeout(timer); }
      });
      return bilibiliAccount(state);
    } catch { return null; }
  }

  async function getLoginQr(page) {
    if (page.isClosed() || new URL(page.url()).origin !== new URL(HOME).origin) return undefined;
    const qr = page.locator('img[alt="Scan me!"]:visible');
    if (await qr.count() !== 1) return undefined;
    // Crop the official QR element; do not return the login URL or token fields.
    const data = await qr.screenshot({ type: 'png', timeout: 3_000 });
    return { kind: 'qr', image: `data:image/png;base64,${data.toString('base64')}` };
  }

  async function login(page) {
    if (new URL(page.url()).origin !== new URL(HOME).origin) await page.goto(HOME, { waitUntil: 'domcontentloaded' });
    if (await readAccount(page) || await page.locator('img[alt="Scan me!"]:visible').count()) return page;
    const button = page.getByRole('button', { name: '登录', exact: true });
    await button.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    if (await button.count() === 1) await button.click();
    await page.locator('img[alt="Scan me!"]:visible').first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    return page;
  }

  async function publish(page, payload, { beforeSubmit } = {}) {
    observeNativeResponses(page);
    const text = composeBilibiliText(payload);
    const files = bilibiliImageFiles(payload.images);
    if (typeof beforeSubmit !== 'function') fail('PUBLISH_REJECTED', '发布检查点缺失，已停止操作。');
    const checkAccount = async () => {
      const account = await readAccount(page);
      if (!account) fail('LOGIN_REQUIRED', '请先在B站专用窗口完成登录。');
      if (account.uid !== payload.expectedAccountUid) fail('ACCOUNT_CHANGED', 'B站当前账号与确认的发布账号不同，请刷新账号后重新确认。');
      return account;
    };
    const account = await checkAccount();
    if (await challenge(page)) fail('CAPTCHA_REQUIRED', '请先在B站专用窗口完成登录或安全验证。');
    const composer = await findComposer(page);
    const initial = await bilibiliEditorState(composer.root, { verifyPreviews: true });
    if (!initial || initial.editing || initial.scheduled || initial.attachments) fail('UI_CHANGED', 'B站编辑区包含修改、定时、话题或附加卡片，请先打开空白的普通动态编辑器。');
    if (!bilibiliPicturesReady(initial, [])) fail('IMAGE_UPLOAD_FAILED', 'B站动态编辑框已有图片，请先在专用窗口清空图片。');
    if (await composer.title.count() > 1) fail('UI_CHANGED', 'B站动态标题输入框不明确。');
    if (await composer.title.count() === 1) await composer.title.fill('');
    await fillNativeText(page, composer, text);
    const uploaded = files.length ? await uploadImages(page, composer, files) : [];
    const validate = async () => {
      if (await challenge(page)) fail('CAPTCHA_REQUIRED', '请先在B站专用窗口完成安全验证。');
      const disabled = await composer.button.getAttribute('class').then((value) => /(^|\s)disabled(\s|$)/.test(value || ''));
      if (disabled || !await composer.button.isVisible()) fail('UI_CHANGED', 'B站动态发布按钮状态发生变化，已停止操作。');
      await checkAccount();
      // The identity GET can take seconds. Re-read the exact native content
      // after it completes, making this the final awaited check before click.
      const state = await bilibiliEditorState(composer.root, { verifyPreviews: true });
      if (state?.overLimit) fail('PUBLISH_REJECTED', 'B站编辑器提示字数超限，请缩短正文后重试。');
      if (!state || state.body !== text || state.title !== '' || state.editing || state.scheduled || state.attachments) fail('UI_CHANGED', 'B站动态内容或发布状态发生变化，已停止操作。');
      if (!bilibiliPicturesReady(state, uploaded)) fail('IMAGE_UPLOAD_FAILED', 'B站动态图片与确认内容不一致，已停止操作。');
    };
    await validate();
    await beforeSubmit();
    // After the durable boundary, every failure is uncertain; never retry a
    // native click automatically, including first-post agreement/challenge UI.
    let receipt;
    try {
      await validate();
      receipt = waitForBilibiliPublication(page);
      await composer.button.click({ timeout: 8_000 });
      await confirmSpecification(page, composer, validate);
      const publication = confirmedBilibiliPublication(await receipt.promise, account);
      const current = await readAccount(page);
      if (!current || current.uid !== account.uid) fail('PUBLISH_UNCERTAIN', 'B站发布后账号状态已变化，请先到B站核对结果。');
      return publication;
    } catch (error) {
      if (['PUBLISH_REJECTED', 'PUBLISH_UNCERTAIN'].includes(error.code)) throw error;
      fail('PUBLISH_UNCERTAIN', 'B站发布过程未能完成确认，请先到B站核对，避免重复发布。');
    } finally { receipt?.cancel(); }
  }

  async function confirmSpecification(page, composer, validate) {
    const popup = page.locator('.bili-dyn-specification-popup:visible');
    await popup.first().waitFor({ state: 'visible', timeout: 1_500 }).catch(() => {});
    if (!await popup.count()) return;
    if (await popup.count() !== 1) fail('PUBLISH_UNCERTAIN', 'B站发布规范确认窗口不唯一。');
    const linked = await composer.root.evaluate(element => element.__vue__?.specification?.visible === true);
    const source = await popup.locator('iframe').getAttribute('src');
    if (!linked || new URL(source, HOME).href !== 'https://t.bilibili.com/h5/dynamic/specification') fail('PUBLISH_UNCERTAIN', 'B站发布规范窗口未能与当前编辑器对应。');
    await validate();
    const confirm = popup.locator('.bili-dyn-specification-popup__btn').filter({ hasText: /^\s*确认并发送\s*$/ });
    if (await confirm.count() !== 1 || !await confirm.isEnabled()) fail('PUBLISH_UNCERTAIN', 'B站规范确认按钮未就绪。');
    await confirm.click({ timeout: 8_000 });
  }

  async function continuePublication(page, payload, { attemptedAt } = {}) {
    const recovered = await reconcilePublication(page, payload, { attemptedAt });
    if (recovered) return recovered;
    // Continuation is limited to the first-use gate, before the site's create
    // request. Already-agreed or unverified outcomes cannot be sent again.
    if (reconciliationDiagnostics.get(page)?.reason !== 'no-match') fail('PUBLISH_UNCERTAIN', '尚不能排除原请求已发布，请先核对结果。');
    const agreed = () => page.evaluate(() => document.cookie.split(';').some(part => { const [key, value] = part.trim().split('='); return key === 'dy_spec_agreed' && Number.parseInt(value, 10) === 1; }));
    if (await agreed()) fail('PUBLISH_UNCERTAIN', 'B站首次发布确认已完成，不能再次发送这个请求。');
    const composer = await findComposer(page);
    const text = composeBilibiliText(payload);
    const initial = await bilibiliEditorState(composer.root);
    if (!initial || initial.body !== text || initial.title !== '' || initial.editing || initial.scheduled || initial.attachments || initial.count !== payload.images.length) fail('PUBLISH_UNCERTAIN', '官网草稿与原发布请求不同，已停止继续。');
    if (initial.count && await verifyReconcileImages(page, payload.images, initial.pictures) !== true) fail('PUBLISH_UNCERTAIN', '未能核实官网草稿仍保留原请求图片，已停止继续。');
    const validate = async () => {
      const account = await readAccount(page);
      const current = await bilibiliEditorState(composer.root);
      if (account?.uid !== payload.expectedAccountUid || !current || current.body !== text || current.title !== '' || current.editing || current.scheduled || current.attachments || JSON.stringify(current.pictures) !== JSON.stringify(initial.pictures)) fail('PUBLISH_UNCERTAIN', '继续确认前账号或官网草稿发生变化。');
    };
    await validate();
    const watcher = waitForBilibiliPublication(page);
    try {
      if (!await page.locator('.bili-dyn-specification-popup:visible').count()) {
        if (await agreed()) fail('PUBLISH_UNCERTAIN', 'B站发布确认状态发生变化，已停止继续。');
        await composer.button.click({ timeout: 8_000 });
      }
      await confirmSpecification(page, composer, validate);
      const account = await readAccount(page);
      if (account?.uid !== payload.expectedAccountUid) fail('PUBLISH_UNCERTAIN', 'B站账号发生变化。');
      return confirmedBilibiliPublication(await watcher.promise, account);
    } finally { watcher.cancel(); }
  }

  async function diagnostics(page) {
    const result = { dialogs: [], responseMetadata: (nativeResponses.get(page) || []).map((entry) => ({
      path: entry.pathname, ...(Number.isInteger(entry.httpStatus) ? { status: entry.httpStatus } : {}),
      ...(typeof entry.code === 'number' ? { code: entry.code } : {}),
      ...(entry.dynamicId ? { id: entry.dynamicId } : {}),
    })) };
    const reconciliation = reconciliationDiagnostics.get(page);
    if (reconciliation) result.reconcile = { ...reconciliation, requests: reconciliation.requests.map((entry) => ({ ...entry })) };
    try {
      const roots = page.locator('.bili-dyn-publishing:visible');
      const count = await roots.count();
      result.editor = { count };
      if (count === 1) {
        const state = await bilibiliEditorState(roots.first(), { verifyPreviews: true });
        if (state) Object.assign(result.editor, {
          pictureCount: state.count, readyPictureCount: state.ready, failedPictureCount: state.failed ? 1 : 0,
          ...(Number.isInteger(state.previewLoaded) ? { previewLoadedPictureCount: state.previewLoaded, previewMissingPictureCount: state.previewMissing } : {}),
          titleLength: typeof state.title === 'string' ? Array.from(state.title).length : 0,
          bodyLength: typeof state.body === 'string' ? Array.from(state.body).length : 0,
          ...(typeof state.body === 'string' ? { bodyHash: createHash('sha256').update(state.body).digest('hex') } : {}),
          ...(id(state.editorId) ? { editorId: id(state.editorId) } : {}),
          ...(id(state.authorUid) ? { authorUid: id(state.authorUid) } : {}),
        });
      }
      // Fixed labels only; native modal text may contain personal post content.
      result.dialogs = await page.evaluate(() => {
        const flags = [
          ['.bili-dyn-specification-popup', '首次发布规范确认窗口'],
          ['iframe[src*="captcha"], iframe[src*="geetest"], .geetest_panel', '安全验证窗口'],
          ['.bili-mini-mask', '登录或验证窗口'],
          ['.bili-modal[role="dialog"]', '原生操作确认窗口'],
          ['.bili-dyn-edit', '原生动态编辑窗口'],
        ];
        return flags.filter(([selector]) => [...document.querySelectorAll(selector)].some((element) => {
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        })).map(([, label]) => label);
      });
    } catch { /* Partial diagnostics are still safe and useful after page loss. */ }
    return result;
  }

  async function reconcilePublication(page, input, { attemptedAt } = {}) {
    const trace = { stage: 'input', reason: 'running', feedPages: 0, feedItems: 0, inWindow: 0, details: 0, matches: 0, requests: [] };
    reconciliationDiagnostics.set(page, trace);
    const stop = (reason) => { trace.reason = reason; return undefined; };
    const record = (entry) => { if (trace.requests.length < 24) trace.requests.push(entry); };
    try {
    const attemptMs = Date.parse(attemptedAt);
    if (!Number.isFinite(attemptMs) || attemptMs > Date.now() + 60_000) return stop('invalid-attempt');
    const text = composeBilibiliText(input);
    const files = bilibiliImageFiles(input.images);
    trace.stage = 'account';
    const account = await readAccount(page);
    if (!account || account.uid !== input.expectedAccountUid) return stop('account-mismatch');
    const uid = account.uid;
    const candidates = new Map();
    const seenOffsets = new Set(['']);
    let offset = '', complete = false;
    // Pinned items invalidate early termination at the first old timestamp.
    // Only a bounded, explicitly complete space feed proves uniqueness.
    for (let number = 0; number < 3; number++) {
      trace.stage = 'feed'; trace.feedPages++;
      const feed = await readReconcileFeed(page, uid, offset, undefined, record);
      if (!feed || !Array.isArray(feed.items)) return stop('feed-unavailable');
      trace.feedItems += feed.items.length;
      for (const item of feed.items) {
        if (!['DYNAMIC_TYPE_WORD', 'DYNAMIC_TYPE_DRAW'].includes(item?.type) || item.orig) continue;
        const author = item.modules?.module_author;
        if (!id(author?.mid)) return stop('feed-author-invalid');
        if (id(author.mid) !== uid) continue;
        if (!id(item.id_str)) return stop('feed-id-invalid');
        if (author.pub_ts === undefined || author.pub_ts === null) return stop('feed-timestamp-missing');
        if (!['number', 'string'].includes(typeof author.pub_ts)) return stop('feed-timestamp-type');
        const seconds = bilibiliPublicationTimestamp(author.pub_ts);
        if (!seconds) return stop('feed-timestamp-invalid');
        const timestamp = seconds * 1000;
        if (timestamp < Math.floor(attemptMs / 1000) * 1000 || timestamp > attemptMs + 10 * 60_000 || timestamp > Date.now() + 60_000) continue;
        const existing = candidates.get(item.id_str);
        if (existing && JSON.stringify(existing) !== JSON.stringify(item)) return stop('feed-item-changed');
        candidates.set(item.id_str, item);
        trace.inWindow = candidates.size;
        if (candidates.size > 20) return stop('candidate-limit');
      }
      if (feed.hasMore === false) { complete = true; break; }
      if (feed.hasMore !== true || !feed.offset || seenOffsets.has(feed.offset)) return stop('pagination-invalid');
      seenOffsets.add(feed.offset); offset = feed.offset;
    }
    if (!complete) return stop('pagination-incomplete');
    const matches = [];
    for (const [postId, feedItem] of candidates) {
      trace.stage = 'detail'; trace.details++;
      const detail = await readReconcileFeed(page, uid, '', postId, record);
      if (!detail || detail.items?.length !== 1 || detail.items[0]?.id_str !== postId) return stop('detail-unavailable');
      const item = detail.items[0];
      if (!bilibiliPublicationTimestamp(item.modules?.module_author?.pub_ts) || bilibiliPublicationTimestamp(item.modules.module_author.pub_ts) !== bilibiliPublicationTimestamp(feedItem.modules.module_author.pub_ts) || id(item.modules?.module_author?.mid) !== uid) return stop('detail-identity-changed');
      const dynamic = item.modules?.module_dynamic;
      const rich = dynamic?.major?.opus ? dynamic.major.opus.summary : dynamic?.desc;
      // Incomplete details could hide another exact match; do not discard them.
      if (!rich) return stop('detail-text-missing');
      if (rich.has_more === true) return stop('detail-text-truncated');
      if (dynamic?.major?.opus && rich.has_more !== false) return stop('detail-completeness-missing');
      if (!Array.isArray(rich.rich_text_nodes)) return stop('detail-nodes-missing');
      if (typeof rich.text !== 'string' || rich.rich_text_nodes.some((node) => typeof node?.text !== 'string') || rich.rich_text_nodes.map((node) => node.text).join('') !== rich.text) return stop('detail-text-inconsistent');
      const pictures = dynamic?.major?.opus?.pics || dynamic?.major?.draw?.items || [];
      if (!Array.isArray(pictures)) return stop('detail-pictures-invalid');
      const urls = pictures.map((picture) => picture?.url || picture?.src);
      const keys = urls.map(bilibiliPictureKey);
      const receipt = bilibiliReconcileCandidate(item, { uid, text, imageCount: files.length, imageKeys: keys, attemptedAt });
      if (!receipt) {
        // Same visible text and count with an unrecognized URL/node/layout is
        // an unknown alternative, not proof that this is a different post.
        if (rich.text === text && (rich.paragraphs?.length || pictures.length === files.length)) return stop('candidate-unrecognized');
        continue;
      }
      trace.stage = 'images';
      const identity = !files.length ? true : await verifyReconcileImages(page, input.images, urls, record);
      if (identity !== true && identity !== false) return stop('image-unverified');
      if (identity) matches.push(receipt);
      trace.matches = matches.length;
      if (matches.length > 1) return stop('multiple-matches');
    }
    if (matches.length !== 1) return stop('no-match');
    trace.stage = 'final-account';
    const current = await readAccount(page);
    if (!current || current.uid !== uid) return stop('final-account-mismatch');
    trace.stage = 'complete'; trace.reason = 'confirmed';
    return { ...matches[0], account: { uid, name: current.name } };
    } catch { return stop(trace.stage === 'input' ? 'input-invalid' : 'unexpected-error'); }
  }

  async function composerDraft(page, expectedAccountUid) {
    if (page.isClosed() || page.url() !== HOME) fail('DRAFT_CHANGED', 'B站页面已离开专用的新动态编辑器，请重新核对草稿。');
    const account = await readAccount(page);
    if (!account || expectedAccountUid && account.uid !== expectedAccountUid) fail('ACCOUNT_CHANGED', 'B站当前账号与草稿确认账号不同，已停止清理。');
    if (await challenge(page) || await page.locator('.bili-modal[role="dialog"]:visible, .bili-dyn-specification-popup:visible, .bili-dyn-edit:visible').count()) fail('DRAFT_CHANGED', 'B站有待处理的验证或确认窗口，请先完成后重新核对草稿。');
    const composer = await findComposer(page);
    const state = await bilibiliEditorState(composer.root);
    if (!state || id(state.authorUid) !== account.uid || state.editing || state.editorId || state.forwarding || state.scheduled || state.attachments || state.initializing || state.publishing || state.uploading) fail('DRAFT_CHANGED', 'B站编辑器已变化或正在处理内容，请重新核对草稿。');
    if (typeof state.body !== 'string' || typeof state.title !== 'string' || state.body.length > 20_000 || state.title.length > 1_000 || !Number.isInteger(state.count) || state.count < 0 || state.count > 9 || state.pictures.length !== state.count || state.count && state.uploaderMin !== 0) fail('DRAFT_CHANGED', 'B站草稿结构暂时无法安全清理，请重新核对。');
    const keys = state.pictures.map(bilibiliPictureKey);
    if (keys.some((key) => !key)) fail('DRAFT_CHANGED', 'B站草稿图片尚未确定，已停止清理。');
    const values = { uid: account.uid, title: state.title, body: state.body, images: keys };
    const fingerprint = createHash('sha256').update(JSON.stringify(values)).digest('hex');
    return { composer, account, state, values, draft: { title: state.title, body: state.body, imageCount: state.count, fingerprint } };
  }

  async function inspectComposerDraft(page) {
    return (await composerDraft(page)).draft;
  }

  async function clearComposerDraft(page, input) {
    if (!input || !id(input.expectedAccountUid) || typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint)) fail('DRAFT_CHANGED', 'B站草稿确认信息无效，请重新核对。');
    let current = await composerDraft(page, input.expectedAccountUid);
    if (current.draft.fingerprint !== input.fingerprint) fail('DRAFT_CHANGED', 'B站草稿已在确认后发生变化，请重新核对后清理。');
    let changed = false;
    const check = async (values) => {
      const actual = await composerDraft(page, input.expectedAccountUid);
      if (JSON.stringify(actual.values) !== JSON.stringify(values)) fail('DRAFT_CHANGED', 'B站草稿在清理过程中发生变化，已停止操作，请重新核对。');
      return actual;
    };
    const settle = async (values) => {
      const deadline = Date.now() + 2_000;
      do {
        const actual = await composerDraft(page, input.expectedAccountUid);
        if (JSON.stringify(actual.values) === JSON.stringify(values)) return actual;
        // Only wait for this action's original snapshot. Any unrelated content
        // change must stop the sequence before another native action occurs.
        if (JSON.stringify(actual.values) !== JSON.stringify(current.values)) fail('DRAFT_CHANGED', 'B站草稿在清理过程中发生变化，已停止操作。');
        await delay(50);
      } while (Date.now() < deadline);
      fail('DRAFT_CLEAR_FAILED', 'B站尚未确认草稿清理完成，请重新核对编辑器。');
    };
    try {
      while (current.state.count) {
        current = await check(current.values);
        const tiles = current.composer.root.locator('.bili-pics-uploader__item');
        if (await tiles.count() !== current.state.count) fail('DRAFT_CHANGED', 'B站草稿图片数量已变化，请重新核对。');
        const tile = tiles.nth(current.state.count - 1);
        const remove = tile.locator('.bili-pics-uploader__item__remove');
        if (await remove.count() !== 1) fail('DRAFT_CHANGED', 'B站草稿图片移除入口不明确，已停止清理。');
        await tile.hover();
        // Recheck after hover and immediately before the exact remove control.
        current = await check(current.values);
        const expected = { ...current.values, images: current.values.images.slice(0, -1) };
        changed = true;
        await remove.click({ timeout: 3_000 });
        current = await settle(expected);
      }
      if (current.values.title) {
        current = await check(current.values);
        if (await current.composer.title.count() !== 1) fail('DRAFT_CHANGED', 'B站草稿标题输入框不明确，已停止清理。');
        const expected = { ...current.values, title: '' };
        changed = true;
        await current.composer.title.fill('');
        current = await settle(expected);
      }
      if (current.values.body) {
        current = await check(current.values);
        const expected = { ...current.values, body: '' };
        changed = true;
        await current.composer.input.click();
        await current.composer.input.press('ControlOrMeta+A');
        await current.composer.input.press('Backspace');
        current = await settle(expected);
      }
      // The native updated hook persists this account's local draft with a
      // 200 ms debounce. Allow that hook to finish; never write site storage.
      await delay(300);
      current = await check({ uid: input.expectedAccountUid, title: '', body: '', images: [] });
      return current.draft;
    } catch (error) {
      if (!changed) throw error;
      throw Object.assign(new Error('B站草稿清理未能完成确认，已停止后续操作，请重新核对编辑器。'), { code: 'DRAFT_CLEAR_FAILED' });
    }
  }

  async function mutate(page, input, { beforeSubmit } = {}, operation) {
    const target = bilibiliMutationTarget(input);
    const text = operation === 'update' ? composeBilibiliText(input) : undefined;
    if (typeof beforeSubmit !== 'function') fail('PUBLISH_REJECTED', '操作检查点缺失，已停止操作。');
    if (Object.hasOwn(input, 'images')) fail('PUBLISH_REJECTED', '修改B站动态仅支持文字，原有图片将保持不变。');
    const checkAccount = async () => {
      const account = await readAccount(page);
      if (!account) fail('LOGIN_REQUIRED', '请先连接B站原动态所属账号。');
      if (account.uid !== target.uid) fail('ACCOUNT_CHANGED', 'B站当前账号与原动态作者不同，已停止操作。');
      return account;
    };
    await checkAccount();
    await page.goto(`${HOME}${target.id}`, { waitUntil: 'domcontentloaded' });
    const checkLocation = () => {
      const url = new URL(page.url());
      if (!(url.origin === 'https://t.bilibili.com' && url.pathname === `/${target.id}` || url.origin === 'https://www.bilibili.com' && url.pathname === `/opus/${target.id}`)) fail('UI_CHANGED', 'B站页面已离开原动态，已停止操作。');
    };
    checkLocation();
    await checkAccount();
    if (await challenge(page)) fail('CAPTCHA_REQUIRED', '请先在B站完成安全验证。');
    const original = await findPublishedRoot(page, target);
    const { item, action } = await originalAction(page, original, operation);
    const originalKeys = original.state.pictures.map(bilibiliPictureKey);
    if (operation === 'update' && (original.state.unsupportedMedia || originalKeys.some((key) => !key))) fail('OPERATION_UNSUPPORTED', '这条B站动态的图片格式或分组无法安全保留，暂不支持修改。');
    const validateOriginal = async () => {
      checkLocation();
      if (await challenge(page)) fail('CAPTCHA_REQUIRED', '请先在B站完成安全验证。');
      await checkAccount();
      const state = await bilibiliPublishedState(original.root);
      if (!state || state.id !== target.id || id(state.uid) !== target.uid) fail('ACCOUNT_CHANGED', 'B站原动态身份发生变化，已停止操作。');
      if (operation === 'update' && (state.unsupportedMedia || JSON.stringify(state.pictures.map(bilibiliPictureKey)) !== JSON.stringify(originalKeys))) fail('UI_CHANGED', 'B站原动态图片已变化，请刷新内容后重试。');
    };
    let watcher, submitted = false;
    try {
      if (operation === 'delete') {
        await validateOriginal();
        // Journal before even opening the destructive action's confirmation.
        await beforeSubmit(); submitted = true;
        watcher = waitForBilibiliMutation(page, operation, target.id);
        await item.click({ timeout: 8_000 });
        const expected = { title: action.modal?.title || '删除动态', content: action.modal?.content || '确定要删除此条动态吗？', confirm: action.modal?.confirm || '删除' };
        await mutationDialog(page, expected);
        await validateOriginal();
        const button = await mutationDialog(page, expected);
        await button.click({ timeout: 8_000 });
      } else {
        // The edit menu only opens the native editor, as verified in the bundle.
        await item.click({ timeout: 8_000 });
        const root = page.locator('.bili-dyn-edit .bili-dyn-publishing:visible');
        await root.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
        if (await root.count() !== 1) fail('OPERATION_UNSUPPORTED', 'B站未打开唯一的原生动态编辑器。');
        const composer = { root, input: root.locator(`${INPUT}:visible`), title: root.locator('input.bili-dyn-publishing__title__input'), button: root.locator('.bili-dyn-publishing__action.launcher:visible').filter({ hasText: /^\s*发布\s*$/ }) };
        if (await composer.input.count() !== 1 || await composer.button.count() !== 1 || await composer.title.count() > 1) fail('UI_CHANGED', 'B站原动态编辑控件发生变化，已停止操作。');
        let initial = await bilibiliEditorState(root);
        const editorDeadline = Date.now() + 8_000;
        while ((!initial || initial.initializing || !initial.authorUid) && Date.now() < editorDeadline) {
          await delay(100);
          initial = await bilibiliEditorState(root);
        }
        if (!initial || initial.editorId !== target.id || id(initial.authorUid) !== target.uid || !initial.editing || initial.forwarding || initial.scheduled || initial.attachments || !bilibiliPicturesReady(initial, originalKeys)) fail('OPERATION_UNSUPPORTED', '这条B站动态无法只修改文字并完整保留原图。');
        if (await composer.title.count() === 1) await composer.title.fill('');
        await fillNativeText(page, composer, text);
        const validateEditor = async () => {
          await validateOriginal();
          // This is after the live identity GET and immediately before action.
          const state = await bilibiliEditorState(root);
          if (!state || state.editorId !== target.id || id(state.authorUid) !== target.uid || !state.editing || state.forwarding || state.scheduled || state.attachments || state.overLimit || state.body !== text || state.title !== '' || !bilibiliPicturesReady(state, originalKeys)) fail('UI_CHANGED', 'B站待修改内容、原图或动态身份发生变化，已停止操作。');
          return state;
        };
        await validateEditor();
        await beforeSubmit(); submitted = true;
        const current = await validateEditor();
        watcher = waitForBilibiliMutation(page, operation, target.id);
        await composer.button.click({ timeout: 8_000 });
        const expected = { title: '确认修改', content: current.editConfirmation, confirm: '确认修改' };
        await mutationDialog(page, expected);
        await validateEditor();
        const button = await mutationDialog(page, expected);
        await button.click({ timeout: 8_000 });
      }
      return confirmedBilibiliMutation(await watcher.promise, operation, target);
    } catch (error) {
      if (!submitted) throw error;
      throw Object.assign(new Error('B站动态操作结果尚未确认，请先核对原动态，避免重复操作。'), { code: 'PUBLISH_UNCERTAIN', submitted: true });
    } finally { watcher?.cancel(); }
  }

  return { id: 'bilibili', name: 'B站动态', homeUrl: HOME, loginUrl: HOME, defaultHeadless: false, readAccount, login, getLoginQr, publish, diagnostics, reconcilePublication, continuePublication, inspectComposerDraft, clearComposerDraft,
    update: (page, input, hooks) => mutate(page, input, hooks, 'update'), delete: (page, input, hooks) => mutate(page, input, hooks, 'delete') };
}
