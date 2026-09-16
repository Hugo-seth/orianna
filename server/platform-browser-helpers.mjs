import { imageFiles as decodeImages, parseProviderJson } from './weibo-browser.mjs';

export { parseProviderJson };
export class PlatformBrowserError extends Error {
  constructor(code, message, options) { super(message, options); this.name = 'PlatformBrowserError'; this.code = code; }
}
export const fail = (code, message) => { throw new PlatformBrowserError(code, message); };
export const numericId = (value) => typeof value === 'string' && /^[1-9]\d{0,31}$/.test(value) ? value
  : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;

export function imageFiles(images) {
  try { return decodeImages(images); }
  catch { fail('IMAGE_UPLOAD_FAILED', '请选择有效图片，最多 4 张，每张不超过 3 MB。'); }
}

export async function sameAccount(page, readAccount, uid, name) {
  const account = await readAccount(page);
  if (!account) fail('LOGIN_REQUIRED', `请先登录${name}并刷新连接状态。`);
  if (account.uid !== uid) fail('ACCOUNT_CHANGED', `${name}当前账号与确认的账号不同，请刷新后重新确认。`);
  return account;
}

export async function waitUntil(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return false;
}

export async function hasChallenge(page) {
  return page.locator('iframe[src*="captcha"]:visible, iframe[src*="geetest"]:visible, [class*="geetest_panel"]:visible, #captcha_container:visible, [class*="captcha-verify"]:visible')
    .count().then((count) => count > 0).catch(() => false);
}

/** Observe the site's request; this helper never issues a publishing request. */
export function waitForPublication(page, predicate, { timeoutMs = 30_000, responseError } = {}) {
  let timer, resolveWait, rejectWait;
  let finished = false, reading = false;
  const dispose = () => { clearTimeout(timer); page.off('response', onResponse); page.off('close', onClose); };
  const reject = (message, code = 'PUBLISH_UNCERTAIN') => {
    if (finished) return;
    finished = true; dispose(); rejectWait(new PlatformBrowserError(code, message));
  };
  const onClose = () => reject('平台窗口已关闭，请先到平台核实发布结果，避免重复发布。');
  const onResponse = async (response) => {
    if (finished || reading || !predicate(response)) return;
    reading = true;
    try {
      if (!response.ok()) return reject('平台发布响应异常，请先到平台核实结果，避免重复发布。');
      const error = await responseError?.(response);
      if (error instanceof PlatformBrowserError) return reject(error.message, error.code);
      const raw = await response.text();
      if (finished) return;
      finished = true; dispose(); resolveWait(raw);
    } catch { reject('平台发布回执无法读取，请先到平台核实结果，避免重复发布。'); }
  };
  const promise = new Promise((resolve, rejectPromise) => {
    resolveWait = resolve; rejectWait = rejectPromise;
    page.on('response', onResponse); page.on('close', onClose);
    timer = setTimeout(() => reject('等待平台发布回执超时，请先核实结果，避免重复发布。'), timeoutMs);
  });
  promise.catch(() => {});
  return { promise, cancel: () => reject('发布操作已中断，请先到平台核实结果。') };
}
