import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createChromeAccountBinding } from './chrome-account-binding.mjs';

export class WeiboBrowserError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'WeiboBrowserError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new WeiboBrowserError(code, message); };
async function boundedPageRead(read, timeoutMs = 1_500) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(read), new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
const numericId = (value) => typeof value === 'string' && /^\d{1,32}$/.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;

/** Never expose the page's config, cookies, or tokens to the HTTP client. */
export function accountFromConfig(config) {
  if (config?.isNormal !== true || !config.user) return undefined;
  const uid = numericId(config.user.idstr) || numericId(config.user.id);
  const name = config.user.screen_name;
  if (!uid || typeof name !== 'string' || !name.trim() || name.length > 300) return undefined;
  const account = { uid, name, profileUrl: `https://weibo.com/u/${uid}` };
  try {
    const url = new URL(config.user.avatar_large || config.user.profile_image_url);
    if (url.protocol === 'https:' && !url.username && !url.password) account.avatarUrl = url.href;
  } catch { /* The avatar is optional. */ }
  return account;
}

export function composeWeiboText({ title = '', body = '' } = {}) {
  if (typeof title !== 'string' || typeof body !== 'string') fail('PUBLISH_REJECTED', '微博标题和正文必须是文字。');
  const text = [title.trim(), body.trim()].filter(Boolean).join('\n\n');
  if (!text || text.includes('\0')) fail('PUBLISH_REJECTED', '请输入有效的微博标题或正文。');
  return text;
}

export function imageFiles(images = []) {
  if (!Array.isArray(images) || images.length > 4) fail('IMAGE_UPLOAD_FAILED', '最多支持 4 张微博图片。');
  return images.map((image, index) => {
    const match = typeof image === 'string' && /^data:image\/(jpeg|jpg|png|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match || match[2].length % 4) fail('IMAGE_UPLOAD_FAILED', '图片格式无效，请重新选择图片。');
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > 3 * 1024 * 1024 || buffer.toString('base64') !== match[2]) fail('IMAGE_UPLOAD_FAILED', '图片无效或超过 3 MB。');
    const subtype = match[1] === 'jpg' ? 'jpeg' : match[1];
    return { name: `fatiao-${index + 1}.${subtype === 'jpeg' ? 'jpg' : subtype}`, mimeType: `image/${subtype}`, buffer };
  });
}

/** Preserve large JSON integer tokens without changing numbers inside strings. */
export function parseProviderJson(raw) {
  if (typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) throw new Error('Invalid provider response');
  let output = '';
  let inside = false;
  let escaped = false;
  for (let i = 0; i < raw.length;) {
    const char = raw[i];
    if (inside) {
      output += char;
      i++;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inside = false;
    } else if (char === '"') {
      inside = true;
      output += char;
      i++;
    } else if (char === '-' || /\d/.test(char)) {
      const token = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(i))?.[0];
      if (!token) throw new Error('Invalid provider JSON number');
      output += /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token)) ? JSON.stringify(token) : token;
      i += token.length;
    } else {
      output += char;
      i++;
    }
  }
  return JSON.parse(output);
}

export function confirmedPublication(raw, account, now = () => new Date()) {
  let response;
  try { response = parseProviderJson(raw); } catch { fail('PUBLISH_UNCERTAIN', '微博返回的发布结果无法解析，请先到微博确认，避免重复发布。'); }
  if (response?.data?.verify) fail('CAPTCHA_REQUIRED', '微博要求安全验证，请在专用窗口处理并确认发布结果。');
  if (!(Number(response?.ok) > 0) || response.error) fail('PUBLISH_REJECTED', '微博没有接受这次发布，请查看专用窗口中的提示。');
  const post = response.data;
  const id = numericId(post?.idstr) || numericId(post?.mid) || numericId(post?.id);
  if (!id) fail('PUBLISH_UNCERTAIN', '微博尚未返回可验证的发布编号，请先到微博确认，避免重复发布。');
  const author = numericId(post.user?.idstr) || numericId(post.user?.id);
  if (author && author !== account.uid) fail('PUBLISH_UNCERTAIN', '微博当前账号已变化，请先到微博确认发布账号和结果。');
  return { id, url: `https://weibo.com/detail/${id}`, publishedAt: now().toISOString(), account: { uid: account.uid, name: account.name } };
}

export function isPublishResponse(response, origin = 'https://weibo.com') {
  try {
    const url = new URL(response.url());
    return url.origin === new URL(origin).origin && url.pathname === '/ajax/statuses/update' && response.request().method() === 'POST';
  } catch { return false; }
}

export function operationTarget(input) {
  const receipt = input?.receipt;
  const id = numericId(receipt?.id);
  const uid = numericId(receipt?.account?.uid);
  if (!id || id === '0' || !uid || uid !== input.expectedAccountUid || receipt.url !== `https://weibo.com/detail/${id}`) fail('OPERATION_UNSUPPORTED', '未找到可核实的微博原文和发布账号，无法修改或删除。');
  return { id, uid, url: receipt.url };
}

export function postFromProvider(raw, target) {
  const post = parseProviderJson(raw);
  const id = numericId(post?.idstr) || numericId(post?.id);
  const uid = numericId(post?.user?.idstr) || numericId(post?.user?.id);
  if (!(Number(post?.ok) > 0) || post.error || id !== target.id || uid !== target.uid) fail('OPERATION_UNSUPPORTED', '微博原文不存在、账号不符或当前账号没有操作权限。');
  const picIds = Array.isArray(post.pic_ids) ? post.pic_ids : [];
  if (picIds.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{5,128}$/.test(id)) || new Set(picIds).size !== picIds.length) fail('OPERATION_UNSUPPORTED', '无法核实原微博的图片，已停止操作。');
  const mixed = post.mix_media_info?.items;
  if (Number.isInteger(post.pic_num) && post.pic_num !== picIds.length || !Array.isArray(post.pic_ids) && (Number(post.pic_num) > 0 || Object.keys(post.pic_infos || {}).length || Array.isArray(mixed) && mixed.some((item) => ['pic', 'image'].includes(item.type)))) fail('OPERATION_UNSUPPORTED', '无法核实原微博的图片，已停止操作。');
  const unsupportedMedia = Boolean(post.retweeted_status || post.blog_audio || post.is_paid || post.isMarkdown || post.is_markdown
    || post.page_info && !['pic', 'image'].includes(post.page_info.object_type)
    || Array.isArray(mixed) && mixed.some((item) => !['pic', 'image'].includes(item.type)));
  return { id, uid, mblogid: typeof post.mblogid === 'string' && /^[A-Za-z0-9]+$/.test(post.mblogid) ? post.mblogid : undefined, picIds, unsupportedMedia };
}

export function isPostOperationResponse(response, operation, targetId, origin = 'https://weibo.com') {
  try {
    const url = new URL(response.url());
    const expected = operation === 'update' ? '/ajax/statuses/modify' : operation === 'delete' ? '/ajax/statuses/destroy' : undefined;
    const request = response.request();
    if (!expected || url.origin !== new URL(origin).origin || url.pathname !== expected || request.method() !== 'POST') return false;
    const raw = request.postData();
    if (typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) return false;
    let payload;
    if (raw.trim().startsWith('{')) payload = parseProviderJson(raw);
    else payload = Object.fromEntries(new URLSearchParams(raw));
    return numericId(payload[operation === 'update' ? 'mid' : 'id']) === targetId;
  } catch { return false; }
}

export function confirmedPostOperation(raw, operation, target, account, now = () => new Date()) {
  let response;
  try { response = parseProviderJson(raw); }
  catch { fail('PUBLISH_UNCERTAIN', '无法解析微博操作回执，请先检查原文，避免重复操作。'); }
  if (response?.data?.verify) fail('CAPTCHA_REQUIRED', '微博要求安全验证，请在专用窗口检查操作结果。');
  if (!(Number(response?.ok) > 0) || response.error) fail('OPERATION_UNSUPPORTED', '微博未接受本次操作，请检查原文的编辑或删除权限。');
  const post = operation === 'update' ? response.data : response;
  const id = numericId(post?.idstr) || numericId(post?.id);
  const uid = numericId(post?.user?.idstr) || numericId(post?.user?.id);
  if (!['update', 'delete'].includes(operation) || id !== target.id || uid && uid !== target.uid || account.uid !== target.uid) fail('PUBLISH_UNCERTAIN', '微博操作回执的原文或账号不一致，请先检查原文。');
  if (operation === 'update' && (uid !== target.uid || target.picIds && JSON.stringify(post.pic_ids || []) !== JSON.stringify(target.picIds))) fail('PUBLISH_UNCERTAIN', '微博修改回执的账号或原图不一致，请先检查原文。');
  return { id: target.id, url: target.url, account: { uid: account.uid, name: account.name }, [operation === 'update' ? 'updatedAt' : 'deletedAt']: now().toISOString() };
}

/** Read only the exact official detail resource; never follow an auth redirect. */
export async function readReconciliationDetail(page, targetId, origin = 'https://weibo.com') {
  return page.evaluate(async ({ id, expectedOrigin }) => {
    if (location.origin !== expectedOrigin) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`/ajax/statuses/show?id=${encodeURIComponent(id)}&isGetLongText=true`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal });
      const url = new URL(response.url);
      if (response.redirected || url.origin !== expectedOrigin || url.pathname !== '/ajax/statuses/show' || url.searchParams.getAll('id').length !== 1 || url.searchParams.get('id') !== id || location.origin !== expectedOrigin) return undefined;
      const raw = await response.text();
      return raw.length <= 2 * 1024 * 1024 ? { raw, httpStatus: response.status, targetId: id } : undefined;
    } finally { clearTimeout(timer); }
  }, { id: targetId, expectedOrigin: origin });
}

export function deletionReconciliationEvidence(result, target) {
  const evidence = { confirmed: false, reason: 'unreadable_response' };
  if (!result || result.targetId !== target.id) return evidence;
  if (Number.isInteger(result.httpStatus) && result.httpStatus >= 100 && result.httpStatus <= 599) evidence.httpStatus = result.httpStatus;
  let body;
  try { body = parseProviderJson(result.raw); } catch { return evidence; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return evidence;
  // Diagnostics retain only a bounded Chinese status sentence. Arbitrary
  // provider payloads, English/token strings and account data are not logged.
  const message = typeof body.message === 'string' ? body.message.trim() : undefined;
  if (message && message.length <= 240 && /^[\p{Script=Han}\s，。！？、：；（）“”‘’,.!?]+$/u.test(message)) evidence.providerMessage = message;
  const errorCode = numericId(body.error_code) || numericId(body.errno);
  if (errorCode) evidence.errorCode = errorCode;
  if (![200, 404, 410].includes(result.httpStatus) || body.ok !== 0 && body.ok !== '0' || body.verify || body.data?.verify) return { ...evidence, reason: 'not_a_detail_failure' };
  if (body.user || body.data || body.text || body.text_raw || body.pic_ids || body.retweeted_status) return { ...evidence, reason: 'post_or_unrecognized_data_present' };
  for (const field of ['id', 'idstr', 'mid']) {
    if (Object.hasOwn(body, field) && numericId(body[field]) !== target.id) return { ...evidence, reason: 'different_target' };
  }
  // After a recorded delete attempt, the same author's authenticated lookup
  // can confirm that this exact original no longer exists. This establishes
  // the current state, without attributing who removed it or inventing a POST receipt.
  if (result.httpStatus === 200 && errorCode === '20101' && message === '该微博不存在') {
    return { ...evidence, confirmed: true, observedState: 'provider_reports_not_found', reason: 'original_no_longer_exists' };
  }
  // The official Detail component displays root `message` for many different
  // failures. A code, deleted flag, inaccessible post or generic "已删除" is
  // never proof that the original is absent. Other response combinations
  // retain uncertainty until their semantics can be verified.
  return { ...evidence, reason: 'no_verified_author_deletion_evidence' };
}

/** Installed only in the owned operation tab, before the official app boots. */
export function observeNativeDeleteResponses({ origin, targetId, accountUid, bindingName, controlName, nonce, handoffTimeout = 2_000 }) {
  if (location.origin !== origin || globalThis.top && globalThis.top !== globalThis || globalThis[controlName]) return;
  let armed = false;
  let claimed = false;
  const requestRecords = new WeakMap();
  const activeHandlers = new Set();
  const matchesUrl = (value) => {
    try { const url = new URL(value, location.href); return url.origin === origin && url.pathname === '/ajax/statuses/destroy'; }
    catch { return false; }
  };
  const matchesBody = (body) => {
    if (typeof body !== 'string' || body.length > 16_384) return false;
    if (body.trim().startsWith('{')) {
      // The native destroy call has one `id` field. Parse no unsafe integer
      // and reject duplicate fields rather than accepting JSON's last value.
      const match = /^\s*\{\s*"id"\s*:\s*(?:"(\d{1,32})"|(\d{1,32}))\s*\}\s*$/.exec(body);
      return Boolean(match && (match[1] || match[2]) === targetId);
    }
    const form = new URLSearchParams(body);
    return form.getAll('id').length === 1 && form.get('id') === targetId;
  };
  const receiptFrom = (status, responseUrl, raw) => {
    if (!Number.isInteger(status) || status < 200 || status >= 300 || !matchesUrl(responseUrl) || typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) return undefined;
    let body;
    try { body = JSON.parse(raw); } catch { return undefined; }
    if (!body || !['number', 'string'].includes(typeof body.ok) || !Number.isFinite(Number(body.ok)) || !(Number(body.ok) > 0) || body.idstr !== targetId
      || body.error || body.verify || body.data?.verify || body.error_code && body.error_code !== '0' || body.errno && body.errno !== '0') return undefined;
    const author = body.user?.idstr || (Number.isSafeInteger(body.user?.id) ? String(body.user.id) : undefined);
    if (body.user && author !== accountUid) return undefined;
    return { nonce, phase: 'receipt', method: 'POST', url: `${origin}/ajax/statuses/destroy`, targetId, httpStatus: status, receipt: { ok: Number(body.ok), idstr: targetId, ...(author ? { user: { idstr: author } } : {}) } };
  };
  const handoff = async (receipt) => {
    if (!receipt || !armed) return false;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(globalThis[bindingName](receipt)).then((accepted) => accepted === true, () => false),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), handoffTimeout); }),
      ]);
    } catch { return false; }
    finally { clearTimeout(timer); }
  };
  const released = () => {
    try { void Promise.resolve(globalThis[bindingName]({ nonce, phase: 'released' })).catch(() => {}); } catch { /* Browser teardown can remove the binding. */ }
  };

  const prototype = globalThis.XMLHttpRequest?.prototype;
  const nativeOpen = prototype?.open;
  const nativeSend = prototype?.send;
  function observedOpen(method, url, async = true) {
    const result = Reflect.apply(nativeOpen, this, arguments);
    requestRecords.set(this, { eligible: typeof method === 'string' && method.toUpperCase() === 'POST' && typeof url === 'string' && matchesUrl(url) && async === true });
    return result;
  }
  function observedSend(body) {
    const xhr = this;
    const record = requestRecords.get(xhr);
    let installed;
    const property = typeof xhr.onloadend === 'function' && !xhr.onload && !xhr.onreadystatechange ? 'onloadend'
      : !('onloadend' in xhr) && !xhr.onload && typeof xhr.onreadystatechange === 'function' ? 'onreadystatechange' : undefined;
    if (armed && !claimed && record?.eligible && matchesBody(body) && property) {
      claimed = true;
      const original = xhr[property];
      const tracked = { xhr, property, original };
      function terminalHandler(...args) {
        if (property === 'onreadystatechange' && xhr.readyState !== 4) return Reflect.apply(original, xhr, args);
        let receipt;
        try {
          if (requestRecords.get(xhr) === record && xhr.readyState === 4 && (!xhr.responseType || xhr.responseType === 'text')) receipt = receiptFrom(xhr.status, xhr.responseURL, xhr.responseText);
        } catch { /* Inaccessible/aborted XHR data never establishes success. */ }
        const invoke = () => {
          if (xhr[property] === terminalHandler) xhr[property] = original;
          activeHandlers.delete(tracked);
          try { return Reflect.apply(original, xhr, args); }
          finally { if (receipt) released(); }
        };
        if (!receipt) return invoke();
        // Axios' known completion handler reads responseText and settles its
        // Promise synchronously. Copy and hand off before it can navigate.
        void handoff(receipt).then(() => { queueMicrotask(invoke); });
      }
      tracked.wrapper = terminalHandler;
      activeHandlers.add(tracked);
      xhr[property] = terminalHandler;
      installed = tracked;
    }
    try { return Reflect.apply(nativeSend, xhr, arguments); }
    catch (error) {
      if (installed) {
        if (xhr[installed.property] === installed.wrapper) xhr[installed.property] = installed.original;
        activeHandlers.delete(installed);
        requestRecords.delete(xhr);
      }
      throw error;
    }
  }
  if (prototype && typeof nativeOpen === 'function' && typeof nativeSend === 'function') {
    prototype.open = observedOpen;
    prototype.send = observedSend;
  }

  const nativeFetch = globalThis.fetch;
  function observedFetch(input, init) {
    const eligibleAtSend = armed && !claimed;
    let info;
    try {
      const request = typeof Request === 'function' && input instanceof Request ? input : undefined;
      const method = init?.method ?? request?.method ?? 'GET';
      const url = request?.url ?? (typeof input === 'string' ? input : undefined);
      if (eligibleAtSend && typeof method === 'string' && method.toUpperCase() === 'POST' && matchesUrl(url)) {
        info = Object.hasOwn(init || {}, 'body') ? init.body : request ? request.clone().text().catch(() => undefined) : undefined;
      }
    } catch { /* Do not alter native errors or body consumption. */ }
    const result = Reflect.apply(nativeFetch, this, arguments);
    return result.then(async (response) => {
      if (!eligibleAtSend || !armed || claimed || !matchesBody(await Promise.resolve(info).catch(() => undefined))) return response;
      claimed = true;
      let receipt;
      try { if (!response.redirected) receipt = receiptFrom(response.status, response.url, await response.clone().text()); } catch { /* Original response remains untouched. */ }
      if (receipt) {
        await handoff(receipt);
        // Return the very same Response. The website keeps its own body,
        // status, headers and normal response parsing/error behavior.
        // Let the caller receive its Response in the current microtask turn
        // before allowing the owned tab to be cleaned up.
        setTimeout(released, 0);
      }
      return response;
    });
  }
  if (typeof nativeFetch === 'function') globalThis.fetch = observedFetch;
  Object.defineProperty(globalThis, controlName, { configurable: true, value: {
    arm() { armed = true; return true; },
    dispose() {
      armed = false;
      if (prototype?.open === observedOpen) prototype.open = nativeOpen;
      if (prototype?.send === observedSend) prototype.send = nativeSend;
      if (globalThis.fetch === observedFetch) globalThis.fetch = nativeFetch;
      for (const { xhr, property, original, wrapper } of activeHandlers) if (xhr[property] === wrapper) xhr[property] = original;
      activeHandlers.clear();
      delete globalThis[controlName];
    },
  } });
}

export async function installNativeDeleteReceiptObserver(page, target, account, origin = 'https://weibo.com') {
  const nonce = randomUUID();
  const suffix = nonce.replaceAll('-', '');
  const bindingName = `__fatiaoDeleteReceipt_${suffix}`;
  const controlName = `__fatiaoDeleteObserver_${suffix}`;
  let armed = false;
  let captured;
  let capturedUrl;
  let wasReleased = false;
  let resolveReceipt;
  const promise = new Promise((resolve) => { resolveReceipt = resolve; });
  await page.exposeBinding(bindingName, (source, value) => {
    if (!armed || source.page !== page || source.frame !== page.mainFrame() || value?.nonce !== nonce) return false;
    if (value.phase === 'released') {
      if (captured) { wasReleased = true; resolveReceipt(captured); }
      return Boolean(captured);
    }
    try {
      if (captured || new URL(source.frame.url()).origin !== origin || value.phase !== 'receipt' || value.method !== 'POST'
        || value.url !== `${origin}/ajax/statuses/destroy` || value.targetId !== target.id || !Number.isInteger(value.httpStatus) || value.httpStatus < 200 || value.httpStatus >= 300) return false;
      const receipt = value.receipt;
      if (!receipt || receipt.idstr !== target.id || typeof receipt.ok !== 'number' || !Number.isFinite(receipt.ok) || receipt.ok <= 0
        || Object.keys(receipt).some((key) => !['ok', 'idstr', 'user'].includes(key))
        || receipt.user && (receipt.user.idstr !== target.uid || Object.keys(receipt.user).some((key) => key !== 'idstr'))) return false;
      const raw = JSON.stringify({ ok: receipt.ok, idstr: receipt.idstr, ...(receipt.user ? { user: { idstr: receipt.user.idstr } } : {}) });
      confirmedPostOperation(raw, 'delete', target, account);
      captured = raw;
      capturedUrl = source.frame.url();
      return true;
    } catch { return false; }
  });
  await page.addInitScript(observeNativeDeleteResponses, { origin, targetId: target.id, accountUid: account.uid, bindingName, controlName, nonce });
  return {
    promise,
    captured: () => captured,
    async waitForRelease(timeoutMs = 2_500) {
      const leftDocument = () => {
        try { return page.isClosed() || new URL(page.url()).origin !== origin || capturedUrl && page.url() !== capturedUrl; }
        catch { return true; }
      };
      if (wasReleased || leftDocument()) return;
      // A native network body can arrive before the website's completion
      // callback. Receiving evidence must not close the tab while that
      // callback is still waiting for the bridge acknowledgement.
      await new Promise((resolve) => {
        let timer;
        const done = () => { clearTimeout(timer); page.off('close', done); page.off('framenavigated', navigated); resolve(); };
        const navigated = (frame) => { if (frame === page.mainFrame()) done(); };
        page.on('close', done);
        page.on('framenavigated', navigated);
        timer = setTimeout(done, timeoutMs);
        promise.then(done);
        if (wasReleased || leftDocument()) done();
      });
    },
    async arm() {
      armed = true;
      const installed = await page.evaluate((name) => globalThis[name]?.arm() === true, controlName);
      if (!installed) armed = false;
      return installed;
    },
    async dispose() {
      armed = false;
      if (!page.isClosed()) await boundedPageRead(() => page.evaluate((name) => globalThis[name]?.dispose(), controlName)).catch(() => {});
    },
  };
}

export function isImageUploadResponse(response) {
  try {
    const url = new URL(response.url());
    return url.protocol === 'https:' && ['picupload.weibo.com', 'image.api.weibo.com'].includes(url.hostname)
      && ['/interface/upload.php', '/interface/pic_upload.php'].includes(url.pathname) && response.request().method() === 'POST';
  } catch { return false; }
}

export function uploadedPictureIds(raw) {
  const body = parseProviderJson(raw);
  const values = body.ret ? [body.pic?.pid] : body.ret !== false && body.code === 'A00006' ? Object.values(body.data?.pics || {}).map((picture) => picture?.pid) : [];
  const ids = values.filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{5,128}$/.test(id));
  if (body.error || !ids.length || ids.length !== values.length) fail('IMAGE_UPLOAD_FAILED', '微博未返回有效的图片上传编号。');
  return ids;
}

export async function pictureState(root, expectedPids = []) {
  return root.evaluate((element, pids) => {
    const tiles = [...element.querySelectorAll('[class*="_picbed_"]')].filter((tile) => tile.querySelector('[title="删除"]'));
    const ready = tiles.filter((tile) => {
      const preview = tile.querySelector('[class*="_pic_"] img.woo-picture-img');
      if (!preview?.complete || preview.naturalWidth <= 0 || preview.getBoundingClientRect().width <= 0
        || tile.querySelector('[class*="_loading_"], .woo-picture-error')) return false;
      try {
        const url = new URL(preview.currentSrc || preview.src);
        const imageId = url.pathname.split('/').pop().split('.')[0];
        return url.protocol === 'https:' && /(^|\.)sinaimg\.(cn|com)$/.test(url.hostname) && pids.includes(imageId);
      } catch { return false; }
    });
    return { count: tiles.length, ready: ready.length };
  }, expectedPids);
}

export function waitForPublication(page, origin, timeoutMs = 30_000, matches = (response) => isPublishResponse(response, origin)) {
  let timer;
  let finished = false;
  let reading = false;
  let rejectWait;
  const dispose = () => { clearTimeout(timer); page.off('response', onResponse); page.off('close', onClose); };
  const onClose = () => {
    if (finished) return;
    finished = true;
    dispose();
    rejectWait(new WeiboBrowserError('PUBLISH_UNCERTAIN', '微博窗口已关闭，无法确认发布结果。'));
  };
  let resolveWait;
  const onResponse = async (response) => {
    if (finished || reading || !matches(response)) return;
    reading = true;
    try {
      if (!response.ok()) fail('PUBLISH_UNCERTAIN', '微博发布请求返回异常，请先到微博检查结果。');
      const raw = await response.text();
      if (finished) return;
      finished = true;
      dispose();
      resolveWait(raw);
    } catch (error) {
      if (finished) return;
      finished = true;
      dispose();
      rejectWait(error instanceof WeiboBrowserError ? error : new WeiboBrowserError('PUBLISH_UNCERTAIN', '微博回执在读取完成前失效，请先核对操作结果，避免重复操作。', { cause: error }));
    }
  };
  const promise = new Promise((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
    page.on('response', onResponse);
    page.on('close', onClose);
    timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      dispose();
      reject(new WeiboBrowserError('PUBLISH_UNCERTAIN', '等待微博发布回执超时，请先到微博确认，避免重复发布。'));
    }, timeoutMs);
  });
  // A failed click can precede awaiting the response; always consume rejections.
  promise.catch(() => {});
  return { promise, cancel() { if (!finished) { finished = true; dispose(); rejectWait(new WeiboBrowserError('PUBLISH_UNCERTAIN', '发布操作已中断。')); } } };
}

async function hasChallenge(page) {
  return page.locator('iframe[src*="captcha"], iframe[src*="geetest"], [class*="geetest_panel"], [id*="captcha"]:visible').count().then((count) => count > 0).catch(() => false);
}

async function findComposer(page) {
  const textarea = page.locator('textarea[placeholder="有什么新鲜事想分享给大家？"]:visible');
  await textarea.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
  if (await textarea.count() !== 1) fail('UI_CHANGED', '未找到唯一的微博编辑框，请在专用窗口打开首页的发微博编辑框。');
  // Select the smallest ancestor containing the official native Publish button.
  // This prevents accidentally clicking a comment/repost button elsewhere.
  const root = textarea.locator('xpath=ancestor::*[.//button[normalize-space(.)="发送" or normalize-space(.)="发布"] or .//*[@role="button"][normalize-space(.)="发送" or normalize-space(.)="发布"]][1]');
  if (await root.count() !== 1) fail('UI_CHANGED', '无法确认微博发布区域，请检查专用窗口。');
  const button = root.getByRole('button', { name: /^(发送|发布)$/, exact: true });
  if (await button.count() !== 1 || await root.locator('textarea:visible').count() !== 1) fail('UI_CHANGED', '微博发布区域不明确，已停止操作。');
  return { textarea, root, button };
}

export function isWeiboLoginPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'https://passport.weibo.com' && parsed.pathname === '/sso/signin';
  } catch { return false; }
}

// Grounded in the official login-LnJ2gZQP.js QRcode component and verified in
// the live anonymous login page. Capture only the rendered QR pixels; never
// return its URL, login response, page HTML, cookies, or entered form values.
const qrSelector = 'div.w-45.h-45.p-5 > img.w-full.h-full:visible';
const qrOverlaySelector = 'div.relative.border-2.border-line > div.w-full.h-full.absolute.bg-white95:visible';

export async function readQrLogin(loginPage) {
  if (!loginPage || loginPage.isClosed() || !isWeiboLoginPage(loginPage.url())) return undefined;
  try {
    const overlay = loginPage.locator(qrOverlaySelector);
    if (await overlay.count()) {
      // Both scan confirmation and expired/error codes cover the old image.
      // Do not show an old QR or infer authentication from a successful scan.
      const refreshLink = loginPage.getByRole('link', { name: '点击刷新', exact: true });
      return { login: { kind: 'qr' }, message: await refreshLink.isVisible()
        ? '微博二维码已失效或暂不可用，请刷新二维码，或打开专用窗口处理。'
        : '微博二维码状态已变化，请在手机端完成确认，或打开专用窗口处理。' };
    }
    const qr = loginPage.locator(qrSelector);
    if (await qr.count() !== 1 || !await qr.evaluate((element) => element.complete && element.naturalWidth > 0 && element.naturalHeight > 0)) {
      return { login: { kind: 'qr' }, message: '正在等待微博二维码加载；若一直未出现，请打开专用窗口登录。' };
    }
    const pixels = await qr.screenshot({ type: 'png', timeout: 3_000 });
    // Navigation or an expired-code overlay can race the screenshot.
    if (!isWeiboLoginPage(loginPage.url()) || await overlay.count()) return { login: { kind: 'qr' }, message: '微博二维码状态已变化，请刷新连接状态。' };
    return { login: { kind: 'qr', image: `data:image/png;base64,${pixels.toString('base64')}` }, message: '请用微博 App 扫描二维码并确认登录。' };
  } catch {
    return { login: { kind: 'qr' }, message: '暂时无法读取微博二维码，请刷新或打开专用窗口登录。' };
  }
}

/**
 * Personal account connector. Every mutation uses the official website.
 * The profile belongs only to this app: no CDP attachment, password collection,
 * token export, private API POST, stealth flags, or CAPTCHA handling.
 */
export function createWeiboBrowser({ dataDir = path.resolve('.data'), chromium, currentChrome, headless = false, baseUrl = 'https://weibo.com' } = {}) {
  const origin = new URL(baseUrl).origin;
  const profileDir = path.join(path.resolve(dataDir), currentChrome ? 'weibo-chrome-connection' : 'weibo-profile');
  const savedMarker = path.join(profileDir, '.fatiao-session-saved');
  const binding = currentChrome ? createChromeAccountBinding({ directory: profileDir, normalizeAccount: value => accountFromConfig({ isNormal: true,
    user: { idstr: value?.uid, screen_name: value?.name, avatar_large: value?.avatarUrl } }) }) : undefined;
  let context;
  let page;
  let contextHeadless = false;
  let loginMode;
  let queue = Promise.resolve();
  const serialized = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };

  async function safeProfile() {
    await mkdir(path.dirname(profileDir), { recursive: true, mode: 0o700 });
    let stat;
    try { stat = await lstat(profileDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('BROWSER_UNAVAILABLE', '微博专用配置目录异常，请检查 .data/weibo-profile。');
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await chmod(profileDir, 0o700);
  }

  async function savedProfile() {
    try {
      const stat = await lstat(profileDir);
      // This is only saved browser data, never a claim that login is valid.
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      if (!currentChrome) return true;
      const marker = await lstat(savedMarker);
      return marker.isFile() && !marker.isSymbolicLink();
    } catch { return false; }
  }

  async function rememberSharedConnection(account) {
    if (!currentChrome) return;
    await safeProfile();
    try { await writeFile(savedMarker, '1\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST' || !await savedProfile()) throw error;
    }
    await binding.save(account);
  }

  async function labelWindow(ownedPage) {
    if (ownedPage.isClosed()) return;
    await ownedPage.evaluate(() => {
      if (!document.title.startsWith('发条 · 微博专用窗口')) document.title = `发条 · 微博专用窗口 | ${document.title}`;
    }).catch(() => {});
  }

  async function launch(background = headless, navigationTimeout = 30_000) {
    await safeProfile();
    if (currentChrome) background = false;
    const options = { chromiumSandbox: true, headless: background, viewport: background ? { width: 1280, height: 900 } : null, acceptDownloads: false, timeout: navigationTimeout, args: ['--no-first-run', '--no-default-browser-check'] };
    let owned;
    try {
      if (currentChrome) owned = await currentChrome.acquire('weibo');
      else {
        const engine = chromium || (await import('playwright')).chromium;
        try { owned = await engine.launchPersistentContext(profileDir, { ...options, channel: 'chrome' }); }
        catch (error) {
          if (!/executable.*(?:doesn.t exist|not found)|distribution.*not found|chrome.*(?:not installed|not found)/i.test(error.message)) throw error;
          owned = await engine.launchPersistentContext(profileDir, options);
        }
      }
    } catch (error) {
      if (error.code === 'CHROME_CONNECTION_REQUIRED') throw error;
      throw new WeiboBrowserError('BROWSER_UNAVAILABLE', '无法启动微博专用浏览器，请安装 Chrome，或运行 npx playwright install chromium。', { cause: error });
    }
    context = owned;
    contextHeadless = background;
    owned.on('close', () => { if (context === owned) { context = undefined; page = undefined; contextHeadless = false; loginMode = undefined; } });
    const watch = (ownedPage) => {
      ownedPage.on('domcontentloaded', () => { void labelWindow(ownedPage); });
      void labelWindow(ownedPage);
    };
    owned.on('page', watch);
    owned.pages().forEach(watch);
    try {
      page = owned.pages()[0] || await owned.newPage();
      page.setDefaultTimeout(8_000);
      page.setDefaultNavigationTimeout(30_000);
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
    }
    catch (error) {
      // A failed startup must not leave a new background Chrome behind. This
      // context was created here; existing user-owned app windows are untouched.
      if (context === owned) await close();
      if (error.code === 'CHROME_CONNECTION_REQUIRED') throw error;
      throw new WeiboBrowserError('BROWSER_UNAVAILABLE', '微博页面暂时无法打开，请稍后重试恢复会话。', { cause: error });
    }
  }

  const loginPage = () => context?.pages().find((item) => !item.isClosed() && isWeiboLoginPage(item.url()));

  function officialPage(candidate) {
    try { return candidate && !candidate.isClosed() && new URL(candidate.url()).origin === origin; }
    catch { return false; }
  }

  function reuseLivePage() {
    // Resolving a stale reference is purely local: no new tabs, navigation,
    // browser startup, or focus changes are allowed during status reads.
    if (!officialPage(page)) {
      const replacement = context?.pages().find(officialPage);
      if (replacement) page = replacement;
      else if (page?.isClosed()) page = undefined;
    }
    return page;
  }

  async function sessionHasChallenge() {
    for (const candidate of context?.pages() || []) {
      if (!candidate.isClosed() && await hasChallenge(candidate)) return true;
    }
    return false;
  }

  async function readStatus({ fresh = false } = {}) {
    reuseLivePage();
    const saved = await savedProfile();
    const remembered = saved && binding ? await binding.read() : undefined;
    const base = { connected: false, browserOpen: Boolean(context?.pages().some((item) => !item.isClosed())), sessionSaved: saved, headless: Boolean(context && contextHeadless),
      ...(currentChrome ? { publishReady: false } : {}),
      ...(remembered ? { account: remembered, accountVerification: 'required' } : {}) };
    if (!context || !page || page.isClosed()) return { ...base, message: '微博专用浏览器未连接，请恢复会话或重新登录。' };
    const disconnected = async (message) => {
      const qr = loginMode === 'qr' ? await readQrLogin(loginPage()) : undefined;
      return { ...base, ...(loginMode ? { login: { kind: loginMode } } : {}), message, ...qr };
    };
    try {
      if (new URL(page.url()).origin !== origin) return disconnected(contextHeadless ? '微博正在加载登录页；若需要验证，请打开专用窗口。' : '请在微博专用窗口完成登录。');
      // Current official app boot data uses isNormal + user, verified against
      // Weibo's public application bundle. Only select public identity fields.
      const inspectedPage = page;
      const config = await inspectedPage.evaluate(async (requireFresh) => {
        let value = window.$CONFIG;
        if (requireFresh) {
          // The official useEntry component loads this same config endpoint.
          // Re-reading boot data alone misses a changed/expired cookie session.
          // Request inside the page, retain only public identity fields, and
          // fail closed rather than falling back to the old window.$CONFIG.
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8_000);
          try {
            const response = await fetch('/ajax/getSpaConfig', { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: controller.signal });
            if (!response.ok) return undefined;
            const raw = await response.text();
            if (raw.length > 2 * 1024 * 1024) return undefined;
            value = JSON.parse(raw)?.data;
          } catch { return undefined; }
          finally { clearTimeout(timer); }
        }
        return { isNormal: value?.isNormal, user: value?.user ? { idstr: value.user.idstr, id: value.user.id, screen_name: value.user.screen_name, avatar_large: value.user.avatar_large, profile_image_url: value.user.profile_image_url } : undefined };
      }, fresh);
      let account = accountFromConfig(config);
      if (inspectedPage.isClosed() || !officialPage(inspectedPage) || page !== inspectedPage) account = undefined;
      if (fresh && config === undefined) return disconnected('暂时无法核实微博当前账号，请稍后重试恢复会话。');
      if (account) await rememberSharedConnection(account);
      if (account && (inspectedPage.isClosed() || !officialPage(inspectedPage) || page !== inspectedPage)) return readStatus({ fresh });
      return account ? { ...base, connected: true, sessionSaved: Boolean(currentChrome) || base.sessionSaved, account,
        ...(currentChrome ? { accountVerification: 'verified', publishReady: true } : {}) } : disconnected(contextHeadless ? '请扫码登录；如果二维码未出现，可刷新或打开专用窗口。' : '请在微博专用窗口扫码或手动登录，完成后刷新连接状态。');
    } catch { return disconnected('暂时无法确认微博账号，请等待页面加载完成后刷新状态。'); }
  }

  async function login({ mode = 'window' } = {}) {
    if (!['qr', 'window'].includes(mode)) fail('LOGIN_MODE_INVALID', '请选择扫码登录或专用窗口登录。');
    // An explicit window request can promote an app-owned background context.
    // A QR request never closes an already-visible window or its current work.
    if (context && contextHeadless && mode === 'window') await close();
    if (!context) await launch(mode === 'qr' || headless);
    else if (!page || page.isClosed()) { page = await context.newPage(); await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }); }
    loginMode = mode;
    if (!contextHeadless && mode === 'window') await page.bringToFront();
    let status = await readStatus();
    if (status.connected) return status;
    const existingPopup = loginPage();
    if (existingPopup) {
      if (!contextHeadless && mode === 'window') await existingPopup.bringToFront();
      return readStatus();
    }
    // A remembered session may have changed in a completed login popup.
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    status = await readStatus();
    if (status.connected) return status;
    const loginButton = page.getByRole('button', { name: '登录/注册', exact: true });
    // The official Vue app may mount after DOMContentLoaded. Give its login
    // entry a bounded opportunity to appear without failing an in-flight login.
    await loginButton.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => undefined);
    if (await loginButton.count() === 1 && await loginButton.isVisible()) {
      const popup = context.waitForEvent('page', { timeout: 8_000 }).catch(() => undefined);
      await loginButton.click();
      const loginPage = await popup;
      if (loginPage) {
        if (!contextHeadless && mode === 'window') await loginPage.bringToFront();
        await labelWindow(loginPage);
        if (mode === 'qr') await loginPage.locator(qrSelector).first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
      }
    }
    return readStatus();
  }

  async function open() {
    if (context && contextHeadless) await close();
    // Unlike the injectable default used in fixtures, open is always visible.
    if (!context) await launch(false);
    return login({ mode: 'window' });
  }

  async function refresh() {
    let status = await readStatus();
    if (currentChrome && !status.browserOpen && status.sessionSaved) return resume();
    if (!context) return status;
    if (status.connected) return status;
    const popup = loginPage();
    if (loginMode === 'qr' && popup) {
      const refreshLink = popup.getByRole('link', { name: '点击刷新', exact: true });
      if (await refreshLink.count() === 1 && await refreshLink.isVisible()) {
        await refreshLink.click();
        await popup.locator(qrSelector).first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
      }
    }
    if (page && !page.isClosed()) {
      // Explicit refresh lets the opener consume a completed login in its
      // popup, including redirects which did not reload the original page.
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      status = await readStatus();
      return status;
    }
    return readStatus();
  }

  async function resume() {
    let status = await readStatus();
    if (!context && !status.sessionSaved) return { ...status, message: '未找到已保存的微博会话，请先登录账号。' };
    if (context && !context.pages().some((item) => !item.isClosed())) {
      // There is no live tab to disrupt. A retained empty context can be
      // restarted headlessly using the same dedicated profile.
      await close();
      if (!await savedProfile()) return { ...await readStatus(), message: '未找到已保存的微博会话，请先登录账号。' };
    }
    if (!context) await launch(true, 12_000);
    reuseLivePage();
    const challengeStatus = async () => {
      const { account, ...current } = await readStatus();
      return { ...current, ...(currentChrome && account ? { account, accountVerification: 'required', publishReady: false } : {}),
        connected: false, message: '微博需要安全验证，请打开专用窗口完成后重试。' };
    };
    if (await sessionHasChallenge()) return challengeStatus();
    status = await readStatus();
    if (!status.connected && page && !page.isClosed()) {
      // The official visitor redirect and Vue boot data can settle after
      // DOMContentLoaded. Wait a bounded time; never click a login/publish
      // control, reload an existing page, or infer login from saved files.
      await page.waitForFunction(() => {
        const value = window.$CONFIG;
        return value?.isNormal === false || value?.isNormal === true && Boolean(value.user?.screen_name && (value.user.idstr || value.user.id));
      }, undefined, { timeout: 8_000 }).catch(() => {});
    }
    status = await readStatus({ fresh: true });
    if (await sessionHasChallenge()) return challengeStatus();
    if (status.connected) return status;
    if (status.message === '暂时无法核实微博当前账号，请稍后重试恢复会话。') return status;
    return { ...status, message: '微博登录已过期或尚未完成，请重新登录后发布。' };
  }

  async function close() {
    const owned = context;
    if (owned) {
      try { await owned.close(); }
      catch (error) {
        if (currentChrome) throw error;
        const browser = owned.browser();
        if (browser?.isConnected()) await browser.close();
        else if (context) throw error;
      }
    }
    context = undefined;
    page = undefined;
    contextHeadless = false;
    loginMode = undefined;
    return { ...await readStatus(), message: '微博专用浏览器已关闭，登录信息保存在本机专用配置目录。' };
  }

  async function disconnect() {
    await close();
    let stat;
    try { stat = await lstat(profileDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) fail('BROWSER_UNAVAILABLE', '微博专用目录异常，未删除任何文件。');
    if (stat) await rm(profileDir, { recursive: true, force: false });
    return { connected: false, browserOpen: false, headless: false, sessionSaved: false, message: '已断开微博账号并清除本应用保存的登录信息。' };
  }

  async function publish(input, hooks = {}) {
    const text = composeWeiboText(input);
    const files = imageFiles(input.images);
    if (typeof hooks.beforeSubmit !== 'function') fail('PUBLISH_REJECTED', '发布检查点缺失，已停止操作。');
    let status = await readStatus({ fresh: true });
    if (!status.connected) status = await resume();
    if (!status.connected && await sessionHasChallenge()) fail('CAPTCHA_REQUIRED', '请先在微博专用窗口完成安全验证。');
    if (!status.connected) fail(context ? 'LOGIN_REQUIRED' : 'BROWSER_CLOSED', '请先打开微博专用窗口并完成登录。');
    if (status.account.uid !== input.expectedAccountUid) fail('ACCOUNT_CHANGED', '微博当前账号与确认的发布账号不同，请刷新账号后重新确认。');
    const editorStatus = await readStatus();
    if (!editorStatus.connected || editorStatus.account.uid !== status.account.uid) fail('ACCOUNT_CHANGED', '微博页面的登录状态已变化，请刷新专用窗口后重新确认账号。');
    if (await hasChallenge(page)) fail('CAPTCHA_REQUIRED', '请先在微博专用窗口完成安全验证。');
    let composer = await findComposer(page);
    // An old website draft must never add unexpected media to this new post.
    if ((await pictureState(composer.root)).count || await composer.root.locator('video, audio').count()) fail('IMAGE_UPLOAD_FAILED', '微博编辑框已有图片或其他媒体，请先在专用窗口清空媒体，再从控制台发布。');
    await composer.textarea.fill(text);
    if (await composer.textarea.inputValue() !== text) fail('UI_CHANGED', '微博编辑框未完整保留正文，请检查专用窗口。');
    const uploadedPids = files.length ? await uploadImages(page, composer, files) : [];
    composer = await findComposer(page);
    if (await hasChallenge(page)) fail('CAPTCHA_REQUIRED', '请先在微博专用窗口完成安全验证。');
    const current = await readStatus({ fresh: true });
    if (!current.connected) fail('LOGIN_REQUIRED', '微博账号状态已变化，请刷新连接状态后重试。');
    if (current.account.uid !== input.expectedAccountUid) fail('ACCOUNT_CHANGED', '微博当前账号与确认的发布账号不同，请刷新账号后重新确认。');
    if (await composer.textarea.inputValue() !== text || !await composer.button.isEnabled() || !await composer.button.isVisible()) fail('UI_CHANGED', '微博内容或发布按钮状态发生变化，已停止操作。');
    const pictures = await pictureState(composer.root, uploadedPids);
    if (pictures.count !== files.length || pictures.ready !== files.length) fail('IMAGE_UPLOAD_FAILED', '微博图片状态发生变化，未能确认所有图片已就绪。');
    // The server must durably record uncertainty BEFORE any possible submission.
    await hooks.beforeSubmit();
    const finalIdentity = await readStatus({ fresh: true });
    if (!finalIdentity.connected || finalIdentity.account.uid !== input.expectedAccountUid) fail('PUBLISH_UNCERTAIN', '提交前微博账号状态发生变化，已停止操作，请先到微博确认。');
    // This content check follows the network identity read so edits made while
    // that request is pending cannot slip into the final native submission.
    if (await composer.textarea.inputValue() !== text) fail('PUBLISH_UNCERTAIN', '提交前微博正文发生变化，已停止操作，请先到微博确认。');
    const finalPictures = await pictureState(composer.root, uploadedPids);
    if (finalPictures.count !== files.length || finalPictures.ready !== files.length) fail('PUBLISH_UNCERTAIN', '提交前微博图片发生变化，已停止操作，请先到微博确认。');
    const receipt = waitForPublication(page, origin);
    try {
      await composer.button.click({ timeout: 8_000 });
      return confirmedPublication(await receipt.promise, status.account);
    } finally { receipt.cancel(); }
  }

  async function readTargetPost(target) {
    let raw;
    try {
      raw = await page.evaluate(async (id) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        try {
          // Detail.getWB uses this read-only native detail endpoint. Cookies
          // stay in the page; raw data is never sent to the console client.
          const response = await fetch(`/ajax/statuses/show?id=${encodeURIComponent(id)}&isGetLongText=true`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
          if (!response.ok) return undefined;
          const raw = await response.text();
          return raw.length <= 2 * 1024 * 1024 ? raw : undefined;
        } finally { clearTimeout(timer); }
      }, target.id);
    } catch { fail('OPERATION_UNSUPPORTED', '暂时无法核实微博原文，已停止修改或删除。'); }
    try { return postFromProvider(raw, target); }
    catch (error) {
      if (error instanceof WeiboBrowserError) throw error;
      fail('OPERATION_UNSUPPORTED', '暂时无法核实微博原文，已停止修改或删除。');
    }
  }

  function targetPageMatches(target) {
    try {
      const url = new URL(page.url());
      return !page.isClosed() && url.origin === origin && (url.pathname === `/detail/${target.id}` || target.mblogid && url.pathname === `/${target.uid}/${target.mblogid}`);
    } catch { return false; }
  }

  async function operationIdentity(target, uncertain = false) {
    const current = await readStatus({ fresh: true });
    if (!current.connected || current.account.uid !== target.uid || await sessionHasChallenge()) fail(uncertain ? 'PUBLISH_UNCERTAIN' : 'ACCOUNT_CHANGED', '微博账号状态已变化，已停止修改或删除，请重新确认账号。');
    return current.account;
  }

  async function preservedPictures(root, ids) {
    const state = await pictureState(root, ids);
    return state.count === ids.length && state.ready === ids.length && await root.locator('video, audio').count() === 0;
  }

  async function operationDiagnostic(operation, input, trace, error, failedPage) {
    // This file is deliberately local-only and written only after a failed
    // console-triggered action. No cookies, request bodies, entered form values,
    // tokens, raw provider responses, or URL queries are collected.
    const diagnostic = {
      at: new Date().toISOString(), operation, stage: trace.stage,
      code: error instanceof WeiboBrowserError ? error.code : 'NATIVE_OPERATION_FAILED',
      message: error instanceof WeiboBrowserError ? error.message : '原生微博操作失败，未记录底层错误详情。',
      targetId: numericId(input?.receipt?.id),
      imageFieldPresent: Object.hasOwn(input || {}, 'images'),
      ...(trace.post ? { post: trace.post } : {}),
    };
    try {
      if (failedPage && !failedPage.isClosed()) {
        const url = new URL(failedPage.url());
        diagnostic.path = url.origin === origin ? url.pathname.slice(0, 160) : '[outside-weibo]';
        if (url.origin === origin) diagnostic.page = await boundedPageRead(() => failedPage.evaluate(() => {
          const visible = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
          const elements = (selector) => [...document.querySelectorAll(selector)].filter(visible);
          let text = '';
          let visited = 0;
          const nodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          while (text.length < 2_000 && visited++ < 5_000 && nodes.nextNode()) {
            const element = nodes.currentNode.parentElement;
            if (!element || element.closest('script,style,input,textarea,[contenteditable]') || !visible(element)) continue;
            const value = nodes.currentNode.nodeValue.trim();
            if (value) text += `${value}\n`;
          }
          return {
            visibleText: text.slice(0, 2_000),
            articles: elements('article').slice(0, 4).map((element) => ({ className: String(element.className).slice(0, 200), moreCount: element.querySelectorAll('[title="更多"]').length })),
            targetArticleCount: elements('article[class*="_feed_"]').length,
            moreControlCount: elements('i.woo-font.woo-font--angleDown[title="更多"]').length,
            menuItems: elements('.woo-pop-item-main[role="button"]').slice(0, 12).map((element) => element.innerText.trim().slice(0, 120)),
            editorTitles: elements('.wbpro-layer-tit-text').slice(0, 4).map((element) => element.innerText.trim().slice(0, 80)),
            dialogTitles: elements('.woo-dialog-title').slice(0, 4).map((element) => element.innerText.trim().slice(0, 80)),
            textareaPlaceholders: elements('textarea').slice(0, 4).map((element) => (element.getAttribute('placeholder') || '').slice(0, 100)),
          };
        }));
      }
    } catch { /* A closed or navigating operation tab may have no DOM snapshot. */ }
    const directory = path.resolve(dataDir);
    const temporary = path.join(directory, `.weibo-operation-error-${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(diagnostic, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, path.join(directory, 'weibo-operation-error.json'));
    } catch { /* Diagnostics must never change the actual operation outcome. */ }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }

  async function tracedPostOperation(operation, input, hooks) {
    const trace = { stage: 'validate_input', recorded: false };
    try { return await postOperation(operation, input, hooks, trace); }
    catch (error) {
      if (!trace.recorded) await operationDiagnostic(operation, input, trace, error);
      throw error;
    }
  }

  async function reconcileOperation(input, { operation, attemptedAt } = {}) {
    const diagnostic = { at: new Date().toISOString(), operation: ['update', 'delete'].includes(operation) ? operation : 'invalid', stage: 'validate_input', targetId: numericId(input?.receipt?.id), confirmed: false };
    try {
      const target = operationTarget(input);
      const attemptTime = typeof attemptedAt === 'string' ? Date.parse(attemptedAt) : NaN;
      if (!['update', 'delete'].includes(operation) || !Number.isFinite(attemptTime) || attemptTime > Date.now()) fail('OPERATION_UNSUPPORTED', '未找到有效的待核对微博操作。');
      diagnostic.attemptedAt = new Date(attemptTime).toISOString();
      if (operation === 'update') {
        // The saved publication receipt has no original image PID witness.
        // Matching current text alone cannot establish a faithful text edit.
        diagnostic.reason = 'update_requires_original_media_evidence';
        return undefined;
      }
      diagnostic.stage = 'resume_session';
      const restored = await resume();
      if (!restored.connected) fail('LOGIN_REQUIRED', '请先恢复微博登录状态，再核对原操作结果。');
      if (restored.account.uid !== target.uid) fail('ACCOUNT_CHANGED', '微博当前账号与原文发布账号不同，无法核对原操作。');
      const queryPage = page;
      if (!officialPage(queryPage)) fail('PUBLISH_UNCERTAIN', '当前微博页面无法安全核对原操作。');
      // Reuse the live same-origin page for a GET only. No page navigation,
      // new tab, native menu, editor, checkpoint or mutation occurs here.
      diagnostic.stage = 'read_detail';
      const result = await readReconciliationDetail(queryPage, target.id, origin);
      diagnostic.stage = 'verify_account_after_read';
      const current = await operationIdentity(target, true);
      if (page !== queryPage || !officialPage(queryPage)) fail('PUBLISH_UNCERTAIN', '核对期间微博会话页面发生变化，请稍后再次核对。');
      diagnostic.stage = 'classify_evidence';
      const evidence = deletionReconciliationEvidence(result, target);
      Object.assign(diagnostic, evidence);
      if (!evidence.confirmed) return undefined;
      // This timestamp records confirmation time, not an inferred deletion
      // time. An unknown detail failure never reaches this receipt branch.
      return { id: target.id, url: target.url, account: { uid: current.uid, name: current.name }, deletedAt: new Date().toISOString() };
    } catch (error) {
      diagnostic.code = error instanceof WeiboBrowserError ? error.code : 'RECONCILIATION_READ_FAILED';
      throw error instanceof WeiboBrowserError ? error : new WeiboBrowserError('PUBLISH_UNCERTAIN', '暂时无法读取微博原文的核对证据，原操作仍待核对。', { cause: error });
    } finally {
      const directory = path.resolve(dataDir);
      const temporary = path.join(directory, `.weibo-reconciliation-${randomUUID()}.tmp`);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify(diagnostic, null, 2), { mode: 0o600, flag: 'wx' });
        await rename(temporary, path.join(directory, 'weibo-reconciliation.json'));
      } catch { /* Diagnostic failures cannot change the pending operation. */ }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
    }
  }

  async function postOperation(operation, input, hooks = {}, trace) {
    const target = operationTarget(input);
    const text = operation === 'update' ? composeWeiboText(input) : undefined;
    if (operation === 'update' && input.images !== undefined) fail('OPERATION_UNSUPPORTED', '修改微博仅支持更新文字并保留原图。');
    if (typeof hooks.beforeSubmit !== 'function') fail('OPERATION_UNSUPPORTED', '微博操作检查点缺失，已停止操作。');
    trace.stage = 'resume_session';
    const restored = await resume();
    if (!restored.connected) fail('LOGIN_REQUIRED', '请先恢复微博登录状态，再修改或删除原文。');
    if (restored.account.uid !== target.uid) fail('ACCOUNT_CHANGED', '微博当前账号与原文发布账号不同，已停止操作。');

    // Each management operation owns one dedicated detail tab, preserving any
    // existing website draft. Only this new tab is closed when it completes.
    trace.stage = 'create_operation_tab';
    const priorPage = page;
    const operationPage = await context.newPage();
    const ownedPopups = new Set();
    const watchPopup = (popup) => { ownedPopups.add(popup); popup.on('popup', watchPopup); };
    operationPage.on('popup', watchPopup);
    page = operationPage;
    operationPage.setDefaultTimeout(8_000);
    operationPage.setDefaultNavigationTimeout(12_000);
    let deleteObserver;
    try {
      if (operation === 'delete') {
        trace.stage = 'install_delete_receipt_observer';
        deleteObserver = await installNativeDeleteReceiptObserver(operationPage, target, restored.account, origin);
      }
      trace.stage = 'navigate_detail';
      await operationPage.goto(`${origin}/detail/${target.id}`, { waitUntil: 'domcontentloaded', timeout: 12_000 });
      trace.stage = 'read_original';
      const post = await readTargetPost(target);
      trace.post = { imageCount: post.picIds.length, unsupportedMedia: post.unsupportedMedia, hasCanonicalId: Boolean(post.mblogid) };
      const verifiedTarget = { ...target, ...post };
      trace.stage = 'verify_detail_route';
      if (!targetPageMatches(verifiedTarget)) fail('OPERATION_UNSUPPORTED', '微博页面已离开目标原文，已停止操作。');
      trace.stage = 'verify_account';
      const current = await operationIdentity(target);
      await operationPage.waitForFunction(() => {
        const value = window.$CONFIG;
        return value?.isNormal === false || value?.isNormal === true && Boolean(value.user?.screen_name && (value.user.idstr || value.user.id));
      }, undefined, { timeout: 8_000 }).catch(() => {});
      const editorAccount = await readStatus();
      if (!editorAccount.connected || editorAccount.account.uid !== target.uid) fail('ACCOUNT_CHANGED', '微博原文页面的账号状态不一致，请刷新专用窗口。');
      trace.stage = 'verify_supported_media';
      if (operation === 'update' && post.unsupportedMedia) fail('OPERATION_UNSUPPORTED', '当前仅支持修改普通文字或图片微博，其他内容请在微博官网编辑。');

      // These selectors come from Detail/FeedMorepop/ModalPublish and the Woo
      // components in the official bundle. A missing/ambiguous native control
      // is unsupported, never grounds for creating a replacement post.
      trace.stage = 'locate_article';
      const article = operationPage.locator('article[class*="_feed_"]:visible');
      await article.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
      if (await article.count() !== 1) fail('OPERATION_UNSUPPORTED', '未找到唯一的微博原文操作区，请在官网处理。');
      trace.stage = 'locate_more';
      const more = article.locator('i.woo-font.woo-font--angleDown[title="更多"]:visible');
      if (await more.count() !== 1) fail('OPERATION_UNSUPPORTED', '微博原文没有可用的编辑或删除菜单。');
      trace.stage = 'open_menu';
      await more.click();
      const label = operation === 'update' ? '编辑微博' : '删除';
      const menuItem = operationPage.locator('.woo-pop-item-main[role="button"]:visible').filter({ has: operationPage.getByText(label, { exact: true }) });
      trace.stage = 'locate_menu_item';
      await menuItem.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
      if (await menuItem.count() !== 1 || !await menuItem.isEnabled()) fail('OPERATION_UNSUPPORTED', '微博当前账号没有此原文的编辑或删除入口。');
      trace.stage = 'open_native_operation';
      await menuItem.click();

      let finalButton;
      let textarea;
      let editor;
      let confirmation;
      if (operation === 'update') {
        trace.stage = 'locate_editor';
        editor = operationPage.locator('.wbpro-layer:visible').filter({ has: operationPage.locator('.wbpro-layer-tit-text').filter({ hasText: /^编辑微博\s*$/ }) });
        await editor.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
        if (await editor.count() !== 1) {
          if (await operationPage.locator('.woo-dialog-main:visible').filter({ hasText: '微博会员可使用编辑微博功能，是否立即开通？' }).count()) fail('EDIT_MEMBERSHIP_REQUIRED', '微博官网要求会员才能编辑原微博，当前账号无法修改文字。');
          fail('OPERATION_UNSUPPORTED', '微博没有开放原文编辑，可能受到会员、额度或内容权限限制。');
        }
        trace.stage = 'verify_editor_controls';
        textarea = editor.locator('textarea[placeholder="有什么新鲜事想分享给大家？"]:visible');
        finalButton = editor.getByRole('button', { name: '发送', exact: true });
        if (await textarea.count() !== 1 || await finalButton.count() !== 1) fail('OPERATION_UNSUPPORTED', '无法确认微博的原生编辑区域，已停止修改。');
        // Wait only for the website's existing images to finish decoding.
        trace.stage = 'verify_original_images';
        const deadline = Date.now() + 8_000;
        while (!await preservedPictures(editor, post.picIds)) {
          if (Date.now() >= deadline) fail('OPERATION_UNSUPPORTED', '无法确认原图已完整保留，已停止修改。');
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        trace.stage = 'fill_updated_text';
        await textarea.fill(text);
      } else {
        trace.stage = 'locate_delete_confirmation';
        confirmation = operationPage.locator('.woo-dialog-main[role="alertdialog"][aria-hidden="false"]:visible').filter({ has: operationPage.locator('.woo-dialog-title').filter({ hasText: /^确定删除微博么？\s*$/ }) });
        await confirmation.first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
        if (await confirmation.count() !== 1) fail('OPERATION_UNSUPPORTED', '微博未显示明确的删除原文确认框，请在官网处理。');
        finalButton = confirmation.getByRole('button', { name: '确定', exact: true });
      }

      trace.stage = 'verify_original_unchanged';
      const latest = await readTargetPost(target);
      if (JSON.stringify(latest.picIds) !== JSON.stringify(post.picIds)) fail('OPERATION_UNSUPPORTED', '微博原文的图片已发生变化，请重新确认原文。');
      trace.stage = 'verify_final_account';
      await operationIdentity(target);
      const ready = async () => targetPageMatches(verifiedTarget) && await finalButton.count() === 1 && await finalButton.isVisible() && await finalButton.isEnabled()
        && (operation === 'update' ? await editor.count() === 1 && await textarea.inputValue() === text && await preservedPictures(editor, post.picIds) : await confirmation.count() === 1);
      if (!await ready()) fail('OPERATION_UNSUPPORTED', '微博原文或操作内容已变化，已停止操作。');
      trace.stage = 'checkpoint';
      await hooks.beforeSubmit();
      trace.stage = 'verify_before_submit';
      await operationIdentity(target, true);
      if (!await ready()) fail('PUBLISH_UNCERTAIN', '提交前微博操作内容已变化，请先检查原文。');
      if (deleteObserver) {
        trace.stage = 'arm_delete_receipt_observer';
        if (!await deleteObserver.arm() || !await ready()) fail('PUBLISH_UNCERTAIN', '提交前无法确认微博删除回执观察器，已停止删除，请先核对原文。');
      }
      const response = waitForPublication(operationPage, origin, 30_000, (result) => isPostOperationResponse(result, operation, target.id, origin));
      try {
        trace.stage = 'native_submit';
        try { await finalButton.click({ timeout: 8_000 }); }
        catch (error) {
          if (!deleteObserver?.captured()) throw error;
          // Navigation can also interrupt Playwright's click completion after
          // the native response has already been positively acknowledged.
        }
        trace.stage = 'confirm_native_receipt';
        const raw = deleteObserver ? await Promise.race([
          response.promise.catch((error) => { if (deleteObserver.captured()) return deleteObserver.captured(); throw error; }),
          deleteObserver.promise,
          ...(deleteObserver.captured() ? [Promise.resolve(deleteObserver.captured())] : []),
        ]) : await response.promise;
        const confirmed = confirmedPostOperation(raw, operation, verifiedTarget, current);
        await deleteObserver?.waitForRelease();
        return confirmed;
      } finally { response.cancel(); }
    } catch (error) {
      await operationDiagnostic(operation, input, trace, error, operationPage);
      trace.recorded = true;
      throw error;
    } finally {
      await deleteObserver?.dispose();
      page = priorPage && !priorPage.isClosed() ? priorPage : undefined;
      operationPage.off('popup', watchPopup);
      for (const popup of ownedPopups) {
        popup.off('popup', watchPopup);
        if (!popup.isClosed()) await popup.close().catch(() => {});
      }
      if (!operationPage.isClosed()) await operationPage.close().catch(() => {});
    }
  }

  return { browserMode: currentChrome ? 'current-chrome' : 'isolated', status: () => serialized(readStatus), login: (options) => serialized(() => login(options)), open: () => serialized(open), refresh: () => serialized(refresh), resume: () => serialized(resume), close: () => serialized(close), disconnect: () => serialized(disconnect), publish: (input, hooks) => serialized(() => publish(input, hooks)), update: (input, hooks) => serialized(() => tracedPostOperation('update', input, hooks)), delete: (input, hooks) => serialized(() => tracedPostOperation('delete', input, hooks)), reconcileOperation: (input, options) => serialized(() => reconcileOperation(input, options)) };
}

async function uploadImages(page, composer, files) {
  // This is deliberately conservative: never submit a text-only post when any
  // requested image cannot be verified as uploaded by the official website.
  const inputs = composer.root.locator('input[type="file"][accept*="image"]');
  if (await inputs.count() !== 1) fail('IMAGE_UPLOAD_FAILED', '未找到唯一的微博图片上传控件，请检查专用窗口中的图片入口。');
  const uploaded = new Set();
  let uploadError;
  const onResponse = async (response) => {
    try {
      if (!isImageUploadResponse(response)) return;
      if (!response.ok()) { uploadError = true; return; }
      for (const id of uploadedPictureIds(await response.text())) uploaded.add(id);
    } catch { uploadError = true; }
  };
  page.on('response', onResponse);
  try {
    await inputs.setInputFiles(files);
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (page.isClosed()) fail('BROWSER_CLOSED', '微博专用窗口已关闭。');
      if (uploadError) fail('IMAGE_UPLOAD_FAILED', '微博拒绝了图片上传，请检查专用窗口中的提示。');
      if (uploaded.size >= files.length) {
        const pictures = await pictureState(composer.root, [...uploaded]);
        if (pictures.count === files.length && pictures.ready === files.length) return [...uploaded];
      }
      if (await hasChallenge(page)) fail('CAPTCHA_REQUIRED', '图片上传需要安全验证，请在微博专用窗口处理。');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    fail('IMAGE_UPLOAD_FAILED', '未能确认所有图片已上传，已停止发布。请在微博专用窗口检查图片状态。');
  } finally { page.off('response', onResponse); }
}
