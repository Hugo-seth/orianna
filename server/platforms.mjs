import { createHash, randomUUID } from 'node:crypto';
import { mkdir, chmod, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const NUMERIC_ID = /^\d{1,32}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const XHS_ID = /^[a-fA-F0-9]{24}$/;
const PLATFORM_RULES = {
  weibo: {
    label: '微博', accountId: NUMERIC_ID, postId: NUMERIC_ID,
    profileUrl: uid => `https://weibo.com/u/${uid}`,
    avatarDomains: ['sinaimg.cn', 'sinaimg.com', 'weibocdn.com'],
    postUrl: (url, id) => ['weibo.com', 'www.weibo.com'].includes(url.hostname) && url.pathname === `/detail/${id}`,
  },
  xiaohongshu: {
    label: '小红书', accountId: ACCOUNT_ID, postId: XHS_ID,
    profileUrl: uid => `https://www.xiaohongshu.com/user/profile/${uid}`,
    avatarDomains: ['xhscdn.com', 'xiaohongshu.com'],
    postUrl: (url, id) => ['xiaohongshu.com', 'www.xiaohongshu.com'].includes(url.hostname) && [`/explore/${id}`, `/discovery/item/${id}`].includes(url.pathname),
  },
  douyin: {
    label: '抖音', accountId: ACCOUNT_ID, postId: NUMERIC_ID,
    profileUrl: uid => `https://www.douyin.com/user/${uid}`,
    avatarDomains: ['douyinpic.com', 'douyincdn.com', 'byteimg.com', 'bytecdn.cn', 'ibyteimg.com', 'pstatp.com'],
    postUrl: (url, id) => ['douyin.com', 'www.douyin.com'].includes(url.hostname) && [`/note/${id}`, `/video/${id}`].includes(url.pathname),
  },
  bilibili: {
    label: 'B站', accountId: NUMERIC_ID, postId: NUMERIC_ID,
    profileUrl: uid => `https://space.bilibili.com/${uid}`,
    avatarDomains: ['hdslb.com', 'bilibili.com'],
    postUrl: (url, id) => (url.hostname === 't.bilibili.com' && url.pathname === `/${id}`) || (['bilibili.com', 'www.bilibili.com'].includes(url.hostname) && url.pathname === `/opus/${id}`),
  },
};

const MAX_BODY_BYTES = 18 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const SAFE_ERRORS = (label) => ({
  LOGIN_REQUIRED: [401, `请先在${label}专用窗口完成登录，再刷新连接状态。`],
  ACCOUNT_CHANGED: [409, `${label}专用窗口中的账号已变化，请刷新连接状态并确认发布账号后重试。`],
  CAPTCHA_REQUIRED: [409, `${label}要求安全验证，请在${label}专用窗口完成验证后重试。`],
  UI_CHANGED: [409, `${label}页面结构发生变化，暂时无法确认发布入口，请在专用窗口检查页面。`],
  BROWSER_UNAVAILABLE: [503, `无法启动${label}专用浏览器，请确认已安装 Chrome 后重试。`],
  CHROME_CONNECTION_REQUIRED: [503, '无法连接当前 Chrome。请先启动 Chrome，在 chrome://inspect/#remote-debugging 开启远程调试，再重试并在 Chrome 弹窗中允许连接。'],
  CHROME_TAB_CLOSE_FAILED: [503, '部分应用标签页未能关闭，请在 Chrome 中手动关闭。其他网页和网站登录状态会保留。'],
  BROWSER_CLOSED: [409, `${label}专用窗口已关闭，请重新打开登录窗口。`],
  PUBLISH_REJECTED: [422, `${label}未接受这次发布，请检查专用窗口中的提示后重试。`],
  IMAGE_UPLOAD_FAILED: [422, `图片上传未完成，请在${label}专用窗口检查后重试。`],
  VALIDATION_ERROR: [400, `${label}内容不符合发布要求，请检查文字和图片后重试。`],
  LOGIN_EXPIRED: [401, `${label}登录已过期，请重新连接账号。`],
  OPERATION_UNSUPPORTED: [501, `${label}当前页面不支持这项操作，请在平台官网检查可用功能。`],
  EDIT_MEMBERSHIP_REQUIRED: [403, '微博官网要求会员才能编辑原微博，当前账号无法修改文字。发布和删除不受此限制。'],
  TARGET_NOT_FOUND: [404, `未找到目标${label}内容，请先核对已发布记录。`],
  OPERATION_REJECTED: [422, `${label}未接受这项操作，请检查专用窗口中的提示。`],
  DRAFT_CHANGED: [409, '官网未发草稿已变化，请重新读取并确认后再清理。'],
  DRAFT_CLEAR_FAILED: [422, '官网未发草稿尚未完全清空，请重新读取后检查。'],
});

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.submitted = ['PUBLISH_UNCERTAIN', 'OPERATION_UNCERTAIN'].includes(code);
  }
}

function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

function fail(code, message, status = 400) {
  throw new ApiError(status, code, message);
}

function readJson(req) {
  const advertised = req.headers['content-length'];
  if (advertised !== undefined && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_BODY_BYTES)) {
    req.resume();
    return Promise.reject(new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大，最多支持 4 张、每张不超过 3 MB 的图片。'));
  }
  return new Promise((resolve, reject) => {
    let length = 0;
    let chunks = [];
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      chunks = [];
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        rejectOnce(new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大，最多支持 4 张、每张不超过 3 MB 的图片。'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => rejectOnce(new ApiError(400, 'INVALID_JSON', '请求读取失败，请重试。')));
    req.on('aborted', () => rejectOnce(new ApiError(400, 'INVALID_JSON', '请求已中断。')));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch {
        reject(new ApiError(400, 'INVALID_JSON', '请求必须是有效的 JSON 对象。'));
      }
    });
  });
}

function validateImage(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64) {
    fail('INVALID_IMAGE', '每张图片必须为不超过 3 MB 的 JPEG、PNG、GIF 或 WebP 文件。');
  }
  const match = /^data:image\/(jpeg|jpg|png|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) fail('INVALID_IMAGE', '图片格式无效，请重新上传 JPEG、PNG、GIF 或 WebP 文件。');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== match[2]) {
    fail('INVALID_IMAGE', '图片数据无效或超过 3 MB，请重新上传。');
  }
  const mime = match[1] === 'jpg' ? 'jpeg' : match[1];
  const valid = mime === 'jpeg' ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mime === 'png' ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mime === 'gif' ? bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
        : bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid) fail('INVALID_IMAGE', '图片内容与文件类型不匹配，请重新上传。');
  return `data:image/${mime};base64,${match[2]}`;
}

function validateText(value, platform) {
  const { label } = PLATFORM_RULES[platform];
  if (typeof value.title !== 'string' || typeof value.body !== 'string' || value.title.length > 1000 || value.body.length > 10000) {
    fail('VALIDATION_ERROR', '标题或正文过长，请缩短内容后重试。');
  }
  const title = value.title.trim();
  const body = value.body.trim();
  if ((!title && !body) || /\u0000/.test(title + body)) fail('VALIDATION_ERROR', `请输入有效的${label}标题或正文。`);
  if (platform === 'xiaohongshu' && (!title || Array.from(title).length > 20 || Array.from(body).length > 1000)) fail('VALIDATION_ERROR', '小红书图文需要 1–20 字标题，正文最多 1000 字。');
  if (platform === 'douyin' && (!title || Array.from(title).length > 30 || Array.from(body).length > 1000)) fail('VALIDATION_ERROR', '抖音图文需要 1–30 字标题，正文最多 1000 字。');
  if (platform === 'bilibili' && Array.from([title, body].filter(Boolean).join('\n\n')).length > 1000) fail('VALIDATION_ERROR', 'B站动态的标题与正文合计最多 1000 字。');
  return { title, body };
}

function validatePublish(value, platform) {
  const { label } = PLATFORM_RULES[platform];
  if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.requestId)) fail('VALIDATION_ERROR', '发布请求编号无效，请重新打开草稿。');
  if (typeof value.contentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.contentId)) fail('VALIDATION_ERROR', '内容编号无效，请重新打开草稿。');
  if (typeof value.expectedAccountUid !== 'string' || !PLATFORM_RULES[platform].accountId.test(value.expectedAccountUid)) fail('VALIDATION_ERROR', `请刷新${label}连接状态并确认发布账号后重试。`);
  const { title, body } = validateText(value, platform);
  if (!Array.isArray(value.images) || value.images.length > 4) fail('INVALID_IMAGE', `本控制台最多支持 4 张${label}图片。`);
  if (['xiaohongshu', 'douyin'].includes(platform) && value.images.length === 0) fail('INVALID_IMAGE', `${label}图文至少需要 1 张图片。`);
  const images = value.images.map(validateImage);
  if (platform === 'bilibili' && images.some(image => image.startsWith('data:image/webp;'))) fail('INVALID_IMAGE', 'B站动态支持 JPG、PNG、GIF 图片，请将 WebP 转为支持的格式后重新上传。');
  return { requestId: value.requestId, contentId: value.contentId, expectedAccountUid: value.expectedAccountUid, title, body, images };
}

function safeAccount(value, platform) {
  const rules = PLATFORM_RULES[platform];
  if (!value || typeof value.uid !== 'string' || !rules.accountId.test(value.uid) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 300) return undefined;
  const account = { uid: value.uid, name: value.name, profileUrl: rules.profileUrl(value.uid) };
  if (typeof value.avatarUrl === 'string' && value.avatarUrl.length < 2048) {
    try {
      const url = new URL(value.avatarUrl);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port && rules.avatarDomains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) account.avatarUrl = url.href;
    } catch { /* Ignore a malformed optional avatar. */ }
  }
  return account;
}

function validateLifecycle(value, platform, type) {
  const allowed = new Set(['requestId', 'contentId', 'publicationRequestId', 'expectedAccountUid', ...(type === 'update' ? ['title', 'body'] : [])]);
  if (Object.keys(value).some(key => !allowed.has(key))) fail('VALIDATION_ERROR', '操作只能引用服务器保存的发布记录，不能指定其他目标或替换图片。');
  if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.requestId) || typeof value.publicationRequestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.publicationRequestId)) fail('VALIDATION_ERROR', '操作编号或原发布编号无效，请刷新内容后重试。');
  if (typeof value.contentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.contentId)) fail('VALIDATION_ERROR', '内容编号无效，请刷新后重试。');
  if (typeof value.expectedAccountUid !== 'string' || !PLATFORM_RULES[platform].accountId.test(value.expectedAccountUid)) fail('VALIDATION_ERROR', '请恢复平台连接并确认操作账号。');
  const base = { type, requestId: value.requestId, contentId: value.contentId, publicationRequestId: value.publicationRequestId, expectedAccountUid: value.expectedAccountUid };
  if (type === 'delete') return base;
  const validated = validateText(value, platform);
  return { ...base, title: validated.title, body: validated.body };
}

function validateComposerDraftRequest(value, platform, clear) {
  const allowed = new Set(['expectedAccountUid', ...(clear ? ['fingerprint'] : [])]);
  if (Object.keys(value).some(key => !allowed.has(key)) || typeof value.expectedAccountUid !== 'string' || !PLATFORM_RULES[platform].accountId.test(value.expectedAccountUid)
    || (clear && (typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)))) fail('VALIDATION_ERROR', '请确认原账号，并使用刚读取的官网草稿摘要。');
  return { expectedAccountUid: value.expectedAccountUid, ...(clear ? { fingerprint: value.fingerprint } : {}) };
}

function safeComposerDraftResponse(value, platform, expectedAccountUid, clear) {
  const account = safeAccount(value?.account, platform);
  const draft = value?.draft;
  if (!account || account.uid !== expectedAccountUid) fail('ACCOUNT_CHANGED', '官网草稿账号与确认账号不同，请重新读取。', 409);
  if (!draft || draft.actualUI !== true || typeof draft.title !== 'string' || draft.title.length > 1000 || typeof draft.body !== 'string' || draft.body.length > 10000 || /\u0000/.test(draft.title + draft.body)
    || !Number.isInteger(draft.imageCount) || draft.imageCount < 0 || draft.imageCount > 100 || typeof draft.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(draft.fingerprint)) fail('UI_CHANGED', '无法完整确认官网当前草稿，请重新读取。', 409);
  if (clear && (value.cleared !== true || draft.title.trim() || draft.body.trim() || draft.imageCount !== 0)) fail('DRAFT_CLEAR_FAILED', '官网未发草稿尚未完全清空，请重新读取后检查。', 422);
  return { ...(clear ? { cleared: true } : {}), account, draft: { actualUI: true, title: draft.title, body: draft.body, imageCount: draft.imageCount, fingerprint: draft.fingerprint } };
}

function safeStatus(value, platform, browserMode) {
  const { label } = PLATFORM_RULES[platform];
  const account = safeAccount(value?.account, platform);
  const connected = value?.connected === true && Boolean(account) && !(browserMode === 'current-chrome' && (value?.accountVerification === 'required' || value?.browserOpen !== true));
  const accountVerification = browserMode === 'current-chrome' && account && ['required', 'verified'].includes(value?.accountVerification)
    ? connected && value?.browserOpen === true ? 'verified' : 'required' : undefined;
  const login = safeLogin(value?.login);
  let message = safeStatusMessage(value?.message, label) || (!connected ? (login?.kind === 'qr' ? (login.image ? `使用${label} App 扫码登录。` : '登录二维码暂不可用，请刷新二维码或打开专用窗口继续。') : value?.browserOpen ? `请在${label}专用窗口完成登录，再刷新连接状态。` : `连接${label}，扫码或手动登录你的账号。`) : undefined);
  if (browserMode === 'current-chrome') {
    // Only translate already-allowlisted product copy, never arbitrary page text.
    message = message?.replaceAll('专用浏览器', 'Chrome 标签页').replaceAll('专用窗口', 'Chrome 标签页');
    if (!value?.browserOpen) message = accountVerification === 'required'
      ? '账号已绑定，发布时会重新打开标签页并核对登录状态。'
      : '点击连接，在当前 Chrome 中打开平台标签页并核对账号。';
    else if (connected && value?.publishReady !== false) message = '已连接当前 Chrome，发布前会再次核对登录账号。';
  }
  return {
    mode: 'browser', platform, connected, browserOpen: value?.browserOpen === true,
    ...(browserMode === 'current-chrome' ? { browserMode } : {}),
    ...(accountVerification ? { accountVerification } : {}),
    publishReady: connected && accountVerification !== 'required' && value?.publishReady !== false,
    sessionSaved: value?.sessionSaved === true,
    headless: value?.headless === true,
    ...(account ? { account } : {}),
    ...(!connected && login ? { login } : {}),
    ...(message ? { message } : {}),
  };
}

function safeStatusMessage(value, label) {
  // Status messages are local product copy. Never forward arbitrary browser text,
  // thrown errors, HTML, URLs, or session details as a status message.
  const messages = new Set([
    '本机保留了专用会话，点击连接恢复并检查登录状态。',
    `请连接${label}并完成登录。`,
    '已连接，发布将在后台专用浏览器执行。',
    '已连接，发布将在专用窗口执行。',
    `请用${label} App 扫码；如需安全验证，请打开专用窗口。`,
    '当前页面需要在官网继续操作，请打开专用窗口完成登录或验证。',
    '当前会话需要安全验证，请打开专用窗口完成后再继续。',
    '专用窗口中没有可用的平台页面，请打开平台官网后刷新连接状态。',
    '请在专用窗口扫码或手动登录，再刷新连接状态。',
    `已清除本应用的${label}会话，下次需要重新登录。`,
    `${label}专用窗口未连接，请重新打开登录窗口。`,
    `请在${label}专用窗口完成登录。`,
    `请在${label}专用窗口扫码或手动登录，完成后刷新连接状态。`,
    `暂时无法确认${label}账号，请等待专用窗口加载完成后刷新状态。`,
    `${label}专用窗口已关闭，登录信息保存在本机专用配置目录。`,
    `${label}专用浏览器已关闭，登录信息保存在本机专用配置目录。`,
    `${label}专用浏览器未连接，请恢复会话或重新登录。`,
    `未找到已保存的${label}会话，请先登录账号。`,
    `${label}需要安全验证，请打开专用窗口完成后重试。`,
    `${label}登录已过期或尚未完成，请重新登录后发布。`,
    `暂时无法核实${label}当前账号，请稍后重试恢复会话。`,
    `已断开${label}账号并清除本应用保存的登录信息。`,
    `${label}二维码已失效或暂不可用，请刷新二维码，或打开专用窗口处理。`,
    `${label}二维码状态已变化，请在手机端完成确认，或打开专用窗口处理。`,
    `正在等待${label}二维码加载；若一直未出现，请打开专用窗口登录。`,
    `${label}二维码状态已变化，请刷新连接状态。`,
    `请用${label} App 扫描二维码并确认登录。`,
    `暂时无法读取${label}二维码，请刷新或打开专用窗口登录。`,
    `${label}正在加载登录页；若需要验证，请打开专用窗口。`,
    '请扫码登录；如果二维码未出现，可刷新或打开专用窗口。',
    `暂时无法确认${label}账号，请等待页面加载完成后刷新状态。`,
    '小红书当前网络被官网限制，请切换可靠网络后重新连接（300012）。',
  ]);
  return typeof value === 'string' && messages.has(value) ? value : undefined;
}

function safeLogin(value) {
  if (value?.kind === 'window') return { kind: 'window' };
  if (value?.kind !== 'qr') return undefined;
  // Only a bounded raster image generated by the owned login browser reaches UI.
  let image;
  if (value.image !== undefined) {
    try { image = validateImage(value.image); } catch { return { kind: 'qr' }; }
  }
  const expiresAt = typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt)) ? new Date(value.expiresAt).toISOString() : undefined;
  return { kind: 'qr', ...(image ? { image } : {}), ...(expiresAt ? { expiresAt } : {}) };
}

function safeOperation(value) {
  if (!value || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.requestId) || !['update', 'delete'].includes(value.type)) throw new Error('Invalid saved lifecycle operation.');
  if (value.type === 'delete') return { requestId: value.requestId, type: value.type };
  if (typeof value.title !== 'string' || typeof value.body !== 'string' || value.title.length > 1000 || value.body.length > 10000 || /\u0000/.test(value.title + value.body)) throw new Error('Invalid saved lifecycle content.');
  return { requestId: value.requestId, type: value.type, title: value.title, body: value.body };
}

function safeReceipt(value, payload, now, platform, lifecycle = false) {
  const { label, postId, postUrl } = PLATFORM_RULES[platform];
  const account = safeAccount(value?.account, platform);
  if (!account || typeof value?.id !== 'string' || !postId.test(value.id)) fail('PUBLISH_UNCERTAIN', `尚未取得可验证的${label}发布结果，请先到${label}确认，避免重复发布。`, 409);
  if (payload.expectedAccountUid && account.uid !== payload.expectedAccountUid) fail('PUBLISH_UNCERTAIN', `发布结果中的账号与确认的账号不符，请先到${label}检查，避免重复发布。`, 409);
  let url;
  try { url = new URL(value.url); } catch { /* Validated below. */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !postUrl(url, value.id)) {
    fail('PUBLISH_UNCERTAIN', `尚未取得可验证的${label}发布链接，请先到${label}确认，避免重复发布。`, 409);
  }
  // A receipt is a public permalink, not the website's session-bearing URL.
  url.search = '';
  const stamp = value.publishedAt === undefined ? now() : Date.parse(value.publishedAt);
  if (!Number.isFinite(stamp)) fail('PUBLISH_UNCERTAIN', `${label}发布结果不完整，请先到${label}确认，避免重复发布。`, 409);
  const receipt = { platform, id: value.id, url: url.href, publishedAt: new Date(stamp).toISOString(), account: { uid: account.uid, name: account.name }, requestId: payload.requestId };
  if (lifecycle) {
    for (const field of ['updatedAt', 'deletedAt']) {
      if (value[field] === undefined) continue;
      if (typeof value[field] !== 'string' || !Number.isFinite(Date.parse(value[field]))) throw new Error('Invalid saved lifecycle timestamp.');
      receipt[field] = new Date(value[field]).toISOString();
    }
    if (value.lastOperation !== undefined) receipt.lastOperation = safeOperation(value.lastOperation);
  }
  return receipt;
}

function mappedBrowserError(error, platform, browserMode) {
  const { label } = PLATFORM_RULES[platform];
  const errors = SAFE_ERRORS(label);
  const known = Object.hasOwn(errors, error?.code) ? errors[error.code] : undefined;
  if (known) {
    const message = browserMode === 'current-chrome' ? known[1].replaceAll('专用窗口', 'Chrome 标签页').replaceAll('专用浏览器', 'Chrome 连接') : known[1];
    return new ApiError(known[0], error.code, message);
  }
  return new ApiError(503, 'BROWSER_ERROR', `${label}${browserMode === 'current-chrome' ? ' Chrome 标签页' : '专用浏览器'}操作未完成，请检查窗口后重试。`);
}

/** A loopback-only, single-user HTTP connector; browser is an injected driver. */
function createPlatformHandler({ env, dataDir, browser, now, platform }) {
  const { label } = PLATFORM_RULES[platform];
  if (!browser || ['status', 'login', 'close', 'disconnect', 'publish'].some((method) => typeof browser[method] !== 'function')) throw new Error(`A complete ${platform} browser driver is required.`);
  const appOrigin = new URL(env.APP_ORIGIN || 'http://localhost:5173').origin;
  const ledgerPath = path.join(dataDir, `${platform}-publish-ledger.json`);
  let ledger;
  let operations;
  let loading;
  const inFlight = new Map();

  async function getLedger() {
    if (ledger) return ledger;
    if (!loading) loading = (async () => {
      try {
        const parsed = JSON.parse(await readFile(ledgerPath, 'utf8'));
        if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== 'object' || Array.isArray(parsed.records)) throw new Error();
        for (const [key, record] of Object.entries(parsed.records)) {
          if (!/^[A-Za-z0-9_-]{8,128}$/.test(key) || !record || !['pending', 'success'].includes(record.state) || typeof record.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.fingerprint) || typeof record.contentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.contentId)) throw new Error();
          if (record.state === 'success') record.receipt = safeReceipt(record.receipt, { requestId: key }, now, platform, true);
        }
        const savedOperations = parsed.operations ?? {};
        if (!savedOperations || typeof savedOperations !== 'object' || Array.isArray(savedOperations)) throw new Error();
        for (const [key, operation] of Object.entries(savedOperations)) {
          if (!/^[A-Za-z0-9_-]{8,128}$/.test(key) || Object.hasOwn(parsed.records, key) || !operation || !['pending', 'success'].includes(operation.state) || !['update', 'delete'].includes(operation.type) || typeof operation.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(operation.fingerprint) || typeof operation.contentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(operation.contentId) || typeof operation.publicationRequestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(operation.publicationRequestId)) throw new Error();
          const publication = parsed.records[operation.publicationRequestId];
          if (!publication || publication.contentId !== operation.contentId || publication.state !== 'success') throw new Error();
          if (operation.state === 'success') {
            const resultReceipt = safeReceipt(operation.result?.receipt, { requestId: operation.publicationRequestId }, now, platform, true);
            if (resultReceipt.id !== publication.receipt.id || resultReceipt.account.uid !== publication.receipt.account.uid) throw new Error();
            const detail = safeOperation(operation.result?.operation);
            if (detail.requestId !== key || detail.type !== operation.type || !resultReceipt[operation.type === 'delete' ? 'deletedAt' : 'updatedAt']) throw new Error();
            operation.result = { receipt: resultReceipt, operation: detail };
          }
        }
        ledger = { ...parsed.records };
        operations = { ...savedOperations };
      } catch (error) {
        if (error.code === 'ENOENT') { ledger = {}; operations = {}; }
        else throw new ApiError(503, 'STORAGE_ERROR', '无法读取本地发布记录。请保留 .data 目录并检查文件权限，暂勿重复发布。');
      }
      return ledger;
    })();
    try { return await loading; } finally { loading = undefined; }
  }

  async function saveLedger(next, nextOperations = operations) {
    const temporary = path.join(dataDir, `.${platform}-ledger-${randomUUID()}.tmp`);
    let file;
    try {
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      await chmod(dataDir, 0o700);
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(JSON.stringify({ version: 1, records: next, operations: nextOperations }));
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporary, ledgerPath);
      const directory = await open(dataDir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      ledger = next;
      operations = nextOperations;
    } catch {
      throw new ApiError(503, 'STORAGE_ERROR', '无法保存本地发布记录，请检查 .data 目录权限后重试。');
    } finally {
      await file?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }

  async function executePublish(payload, fingerprint, { reconcileOnly = false, continueOnly = false } = {}) {
    const needsVerification = () => {
      const error = new ApiError(409, 'CAPTCHA_REQUIRED', `${label}要求本人安全验证。请在专用窗口完成短信或其他验证，再点击“核对同一发布请求”，无需重新发布。`);
      error.submitted = true;
      return error;
    };
    const records = await getLedger();
    if (Object.hasOwn(operations, payload.requestId)) fail('IDEMPOTENCY_CONFLICT', '这个请求编号已用于其他操作，请重新打开草稿。', 409);
    const existing = Object.hasOwn(records, payload.requestId) ? records[payload.requestId] : undefined;
    if (existing && existing.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', '这个请求编号已用于其他内容，请重新打开草稿后再试。', 409);
    if (existing?.state === 'success') return existing.receipt;
    if (continueOnly) {
      if (existing?.state !== 'pending' || typeof browser.continuePublication !== 'function') fail('PUBLISH_UNCERTAIN', '没有可继续的原发布确认，请保留当前记录。', 409);
      const value = await browser.continuePublication(structuredClone(payload), { attemptedAt: existing.attemptedAt });
      const receipt = safeReceipt(value, payload, now, platform);
      await saveLedger({ ...ledger, [payload.requestId]: { ...existing, state: 'success', receipt } });
      return receipt;
    }
    if (reconcileOnly && !existing) fail('PUBLISH_UNCERTAIN', '服务器没有这次发布的提交记录，只读核对不会发起新发布。请保留内容并检查原操作状态。', 409);
    if (Object.values(records).some((record) => record.contentId === payload.contentId && record.state === 'success')) {
      fail('CONTENT_ALREADY_PUBLISHED', `这篇内容已经发布到${label}。如需再次发布，请先复制为一篇新内容。`, 409);
    }
    if (existing?.state === 'pending' && typeof browser.reconcilePublication === 'function' && typeof existing.attemptedAt === 'string' && Number.isFinite(Date.parse(existing.attemptedAt))) {
      // The exact original request may ask a driver for positive read-only proof.
      // This branch never calls publish and never clears an unconfirmed attempt.
      try {
        const value = await browser.reconcilePublication(structuredClone(payload), { attemptedAt: existing.attemptedAt });
        if (value) {
          const receipt = safeReceipt(value, payload, now, platform);
          await saveLedger({ ...ledger, [payload.requestId]: { ...existing, state: 'success', receipt, reconciledAt: new Date(now()).toISOString() } });
          return receipt;
        }
      } catch (error) {
        if (error?.code === 'CAPTCHA_REQUIRED') throw needsVerification();
        /* Missing evidence or persistence failure leaves the guard intact. */
      }
    }
    if (existing?.state === 'pending' || Object.values(records).some((record) => record.contentId === payload.contentId && record.state === 'pending')) {
      fail('PUBLISH_UNCERTAIN', `这篇内容已有一次待确认的发布。请先到${label}检查是否已发布，本控制台不会自动重发。`, 409);
    }
    let submitted = false;
    let checkpointStarted = false;
    try {
      const value = await browser.publish({ expectedAccountUid: payload.expectedAccountUid, title: payload.title, body: payload.body, images: payload.images }, {
        beforeSubmit: async () => {
          if (checkpointStarted) fail('PUBLISH_UNCERTAIN', `同一次发布不能重复提交，请先到${label}检查结果。`, 409);
          checkpointStarted = true;
          await saveLedger({ ...ledger, [payload.requestId]: { state: 'pending', fingerprint, contentId: payload.contentId, attemptedAt: new Date(now()).toISOString() } });
          submitted = true;
        },
      });
      // A driver must confirm the durable checkpoint before it clicks Publish.
      if (!submitted) fail('PUBLISH_UNCERTAIN', `浏览器未确认发布检查点，请先到${label}检查结果。`, 409);
      const receipt = safeReceipt(value, payload, now, platform);
      const next = { ...ledger, [payload.requestId]: { ...ledger[payload.requestId], state: 'success', receipt } };
      try { await saveLedger(next); } catch {
        // Keep the in-memory receipt; disk remains pending so a restart cannot resend.
        ledger = next;
        return { ...receipt, warning: { code: 'RECEIPT_NOT_SAVED', message: `${label}已发布，但本地记录保存失败。请保留这条${label}链接；重启后须人工确认，勿重复发布。` } };
      }
      return receipt;
    } catch (error) {
      if (submitted || error?.submitted === true || error?.code === 'PUBLISH_UNCERTAIN') {
        // A defensive fallback for an incorrectly implemented driver that submits
        // before calling the hook. The driver contract forbids this ordering.
        if (!submitted) {
          const next = { ...ledger, [payload.requestId]: { state: 'pending', fingerprint, contentId: payload.contentId, attemptedAt: new Date(now()).toISOString() } };
          try { await saveLedger(next); } catch { ledger = next; /* Keep a local guard even if storage is unavailable. */ }
        }
        if (error?.code === 'CAPTCHA_REQUIRED') throw needsVerification();
        fail('PUBLISH_UNCERTAIN', `已尝试提交，但暂时无法确认${label}结果。请先到${label}检查是否已发布，本控制台不会自动重发。`, 409);
      }
      if (error instanceof ApiError) throw error;
      throw mappedBrowserError(error, platform, browser.browserMode);
    }
  }

  async function publish(payload, options) {
    const fingerprint = createHash('sha256').update(JSON.stringify({ contentId: payload.contentId, expectedAccountUid: payload.expectedAccountUid, title: payload.title, body: payload.body, images: payload.images })).digest('hex');
    const running = inFlight.get(payload.requestId);
    if (running) {
      if (running.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', '同一发布请求的内容已变化，请等待当前发布结束。', 409);
      return running.promise;
    }
    if (inFlight.size) fail('PUBLISH_BUSY', `${label}正在处理另一条发布，请等待完成后重试。`, 409);
    const promise = executePublish(payload, fingerprint, options);
    inFlight.set(payload.requestId, { fingerprint, promise, contentId: payload.contentId, type: 'publish' });
    try { return await promise; } finally { inFlight.delete(payload.requestId); }
  }

  function confirmedLifecycleResult(value, original, payload) {
    const confirmed = safeReceipt({ ...value, publishedAt: original.publishedAt }, { requestId: original.requestId, expectedAccountUid: original.account.uid }, now, platform);
    if (confirmed.id !== original.id || confirmed.url !== original.url) fail('OPERATION_UNCERTAIN', '操作回执与原发布内容不一致，请先核实平台结果。', 409);
    const field = payload.type === 'delete' ? 'deletedAt' : 'updatedAt';
    const confirmedTime = typeof value[field] === 'string' ? Date.parse(value[field]) : NaN;
    if (!Number.isFinite(confirmedTime)) fail('OPERATION_UNCERTAIN', '平台没有返回可信的完成确认，请先核实操作结果。', 409);
    // Order confirmed mutations even when the platform clock is coarse.
    const stamp = Math.max(confirmedTime, now(), Date.parse(original.updatedAt || original.publishedAt) + 1);
    const operation = safeOperation({ requestId: payload.requestId, type: payload.type, ...(payload.type === 'update' ? { title: payload.title, body: payload.body } : {}) });
    return { receipt: { ...original, [field]: new Date(stamp).toISOString(), lastOperation: operation }, operation };
  }

  async function executeLifecycle(payload, fingerprint, { reconcileOnly = false, retryUpdate = false } = {}) {
    const records = await getLedger();
    if (Object.hasOwn(records, payload.requestId)) fail('IDEMPOTENCY_CONFLICT', '这个操作编号已用于发布，请为本次操作保留独立编号。', 409);
    const previous = Object.hasOwn(operations, payload.requestId) ? operations[payload.requestId] : undefined;
    if (previous && previous.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', '这个操作编号已用于其他内容，请等待原操作结果。', 409);
    if (previous?.state === 'success') return previous.result;
    if (retryUpdate && (platform !== 'xiaohongshu' || payload.type !== 'update' || previous?.state !== 'pending')) fail('OPERATION_UNCERTAIN', '没有可继续的原文修改操作。', 409);
    if (reconcileOnly && !previous) fail('OPERATION_UNCERTAIN', '服务器没有这次操作的提交记录，只读核对不会发起修改或删除。请保留内容并检查原操作状态。', 409);
    const publication = Object.hasOwn(records, payload.publicationRequestId) ? records[payload.publicationRequestId] : undefined;
    if (!publication || publication.contentId !== payload.contentId) fail('TARGET_NOT_FOUND', '服务器没有对应的已发布记录，请刷新内容后重试。', 404);
    if (publication.state !== 'success') fail('OPERATION_UNCERTAIN', '原发布结果尚未确认，暂不继续修改或删除。', 409);
    const original = safeReceipt(publication.receipt, { requestId: payload.publicationRequestId }, now, platform, true);
    if (original.account.uid !== payload.expectedAccountUid) fail('ACCOUNT_CHANGED', '确认的账号与原发布账号不一致，请连接原账号后重试。', 409);
    if (original.deletedAt) fail('CONTENT_ALREADY_DELETED', '这条平台内容已经确认删除，请刷新本地记录。', 409);
    if (previous?.state === 'pending' && typeof browser.reconcileOperation === 'function' && typeof previous.attemptedAt === 'string' && Number.isFinite(Date.parse(previous.attemptedAt))) {
      // Replaying the exact original operation may verify its result read-only.
      // No update/delete driver or submission hook is reachable from this branch.
      try {
        const value = await browser.reconcileOperation({ receipt: structuredClone(original), expectedAccountUid: payload.expectedAccountUid, ...(payload.type === 'update' ? { title: payload.title, body: payload.body } : {}) }, { operation: payload.type, attemptedAt: previous.attemptedAt });
        if (value) {
          const result = confirmedLifecycleResult(value, original, payload);
          await saveLedger({ ...ledger, [payload.publicationRequestId]: { ...publication, receipt: result.receipt } }, { ...operations, [payload.requestId]: { ...previous, state: 'success', result, reconciledAt: new Date(now()).toISOString() } });
          return result;
        }
      } catch { /* Without durable positive confirmation the operation stays pending. */ }
    }
    if (Object.entries(operations).some(([id, operation]) => operation.contentId === payload.contentId && operation.state === 'pending' && !(retryUpdate && id === payload.requestId))) fail('OPERATION_UNCERTAIN', '这篇内容还有一项待核实的操作，请先在平台官网确认，暂不继续修改或删除。', 409);
    if (typeof browser[payload.type] !== 'function') fail('OPERATION_UNSUPPORTED', `当前${label}连接器不支持这项操作。`, 501);
    let submitted = false;
    let checkpointStarted = false;
    const pendingRecord = () => ({ state: 'pending', type: payload.type, fingerprint, contentId: payload.contentId, publicationRequestId: payload.publicationRequestId, attemptedAt: new Date(now()).toISOString() });
    try {
      const value = await browser[payload.type]({ receipt: structuredClone(original), expectedAccountUid: payload.expectedAccountUid, ...(payload.type === 'update' ? { title: payload.title, body: payload.body } : {}) }, {
        beforeSubmit: async () => {
          if (checkpointStarted) fail('OPERATION_UNCERTAIN', '同一操作不能重复提交，请先检查平台结果。', 409);
          checkpointStarted = true;
          await saveLedger(ledger, { ...operations, [payload.requestId]: pendingRecord() });
          submitted = true;
        },
      });
      if (!submitted) fail('OPERATION_UNCERTAIN', '浏览器未确认操作检查点，请先核实平台结果。', 409);
      const result = confirmedLifecycleResult(value, original, payload);
      await saveLedger({ ...ledger, [payload.publicationRequestId]: { ...publication, receipt: result.receipt } }, { ...operations, [payload.requestId]: { ...pendingRecord(), state: 'success', result } });
      return result;
    } catch (error) {
      if (submitted || error?.submitted === true || ['PUBLISH_UNCERTAIN', 'OPERATION_UNCERTAIN'].includes(error?.code)) {
        if (!submitted) {
          const next = { ...operations, [payload.requestId]: pendingRecord() };
          try { await saveLedger(ledger, next); } catch { operations = next; }
        }
        fail('OPERATION_UNCERTAIN', '已尝试操作，但暂时无法确认平台结果。本控制台不会自动重试，请保留原内容并到平台核实。', 409);
      }
      if (error instanceof ApiError) throw error;
      throw mappedBrowserError(error, platform, browser.browserMode);
    }
  }

  async function mutate(payload, options) {
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const running = inFlight.get(payload.requestId);
    if (running) {
      if (running.type !== payload.type || running.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', '同一操作编号的内容已变化，请等待当前操作结束。', 409);
      return running.promise;
    }
    if (inFlight.size) fail('PUBLISH_BUSY', `${label}正在处理其他操作，请等待完成后重试。`, 409);
    const promise = executeLifecycle(payload, fingerprint, options);
    inFlight.set(payload.requestId, { fingerprint, promise, contentId: payload.contentId, type: payload.type });
    try { return await promise; } finally { inFlight.delete(payload.requestId); }
  }

  async function deletionStatus(contentId) {
    const records = await getLedger();
    const matching = Object.entries(records).filter(([, record]) => record.contentId === contentId);
    return {
      pending: matching.some(([, record]) => record.state === 'pending') || Object.values(operations).some(operation => operation.contentId === contentId && operation.state === 'pending') || [...inFlight.values()].some(operation => operation.contentId === contentId),
      publications: matching.filter(([, record]) => record.state === 'success').map(([publicationRequestId, record]) => ({ platform, publicationRequestId, receipt: safeReceipt(record.receipt, { requestId: publicationRequestId }, now, platform, true) })),
    };
  }

  const handler = async function platformHandler(req, res, action, legacy = false) {
    try {
      const getRoute = ['account', 'receipts'].includes(action);
      const postRoute = ['login', 'open', 'resume', 'refresh', 'close', 'disconnect', 'publish', 'continue-publish', 'update', 'retry-update', 'delete', 'reconcile', 'composer-draft', 'clear-composer-draft'].includes(action);
      if (!getRoute && !postRoute) fail('NOT_FOUND', `未找到这个${label}接口。`, 404);
      if ((getRoute && req.method !== 'GET') || (postRoute && req.method !== 'POST')) fail('METHOD_NOT_ALLOWED', '请求方法不受支持。', 405);
      let body;
      if (postRoute) {
        if (req.headers.origin !== appOrigin || req.headers['x-fatiao-request'] !== '1') fail('FORBIDDEN_ORIGIN', '请求来源无效，请从本地控制台操作。', 403);
        if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) fail('UNSUPPORTED_MEDIA_TYPE', '请求必须使用 application/json。', 415);
        body = await readJson(req);
      }
      if (action === 'account') {
        reply(res, 200, safeStatus(await browser.status(), platform, browser.browserMode));
      } else if (action === 'refresh') {
        reply(res, 200, safeStatus(await (browser.refresh ? browser.refresh() : browser.status()), platform, browser.browserMode));
      } else if (action === 'receipts') {
        const records = await getLedger();
        reply(res, 200, { receipts: Object.entries(records).filter(([, record]) => record.state === 'success').map(([requestId, record]) => ({ ...safeReceipt(record.receipt, { requestId }, now, platform, true), contentId: record.contentId })) });
      } else if (action === 'publish') {
        reply(res, 200, await publish(validatePublish(body, platform)));
      } else if (action === 'continue-publish') {
        reply(res, 200, await publish(validatePublish(body, platform), { continueOnly: true }));
      } else if (action === 'update' || action === 'delete') {
        reply(res, 200, await mutate(validateLifecycle(body, platform, action)));
      } else if (action === 'retry-update') {
        reply(res, 200, await mutate(validateLifecycle(body, platform, 'update'), { retryUpdate: true }));
      } else if (action === 'reconcile') {
        const { operation, ...originalPayload } = body;
        if (!['publish', 'update', 'delete'].includes(operation)) fail('VALIDATION_ERROR', '请指定要核对的原发布、修改或删除操作。');
        const result = operation === 'publish'
          ? await publish(validatePublish(originalPayload, platform), { reconcileOnly: true })
          : await mutate(validateLifecycle(originalPayload, platform, operation), { reconcileOnly: true });
        reply(res, 200, result);
      } else if (action === 'composer-draft' || action === 'clear-composer-draft') {
        if (inFlight.size) fail('PUBLISH_BUSY', `${label}正在处理其他操作，请等待完成后再检查官网草稿。`, 409);
        const clear = action === 'clear-composer-draft';
        const input = validateComposerDraftRequest(body, platform, clear);
        const method = clear ? 'clearComposerDraft' : 'inspectComposerDraft';
        if (typeof browser[method] !== 'function') fail('OPERATION_UNSUPPORTED', '此平台暂不支持检查或清理官网未发草稿。', 501);
        reply(res, 200, safeComposerDraftResponse(await browser[method](input), platform, input.expectedAccountUid, clear));
      } else {
        if (inFlight.size) fail('PUBLISH_BUSY', `${label}正在处理发布，请等待完成后再更改连接。`, 409);
        const method = action === 'open' && !browser.open ? 'login' : action;
        if (action === 'login' && body.mode !== undefined && !['qr', 'window'].includes(body.mode)) fail('VALIDATION_ERROR', '登录方式无效，请选择扫码或专用窗口。');
        if (action === 'resume' && typeof browser.resume !== 'function') fail('BROWSER_UNAVAILABLE', '当前连接器暂不支持后台恢复，请更新本地服务后重试。', 503);
        const result = await browser[method](action === 'login' ? { mode: body.mode ?? (legacy ? 'window' : 'qr') } : undefined);
        reply(res, 200, safeStatus(result || await browser.status(), platform, browser.browserMode));
      }
    } catch (error) {
      const safe = error instanceof ApiError ? error : mappedBrowserError(error, platform, browser.browserMode);
      reply(res, safe.status, { error: { code: safe.code, message: safe.message, submitted: safe.submitted } });
    }
    return true;
  };
  handler.deletionStatus = deletionStatus;
  return handler;
}

/** One dispatcher owns each platform ledger, including the legacy Weibo alias. */
export function createPlatformsHandler({ env = process.env, dataDir = path.resolve('.data'), browsers = {}, now = Date.now } = {}) {
  const origin = new URL(env.APP_ORIGIN || 'http://localhost:5173');
  if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.username || origin.password) {
    throw new Error('APP_ORIGIN must be a loopback HTTP origin.');
  }
  const handlers = new Map(Object.entries(browsers).map(([platform, browser]) => {
    if (!Object.hasOwn(PLATFORM_RULES, platform)) throw new Error(`Unknown platform: ${platform}`);
    return [platform, createPlatformHandler({ env, dataDir, browser, now, platform })];
  }));
  // Deletion checks include persisted platforms even if a driver was disabled.
  // These read-only ledger owners never open a browser or expose extra routes.
  const disabledDriver = Object.fromEntries(['status', 'login', 'close', 'disconnect', 'publish'].map(method => [method, async () => { throw new Error('Browser driver is not configured.'); }]));
  const ledgerReaders = Object.keys(PLATFORM_RULES).map(platform => handlers.get(platform) || createPlatformHandler({ env, dataDir, browser: disabledDriver, now, platform }));
  const handler = async (req, res) => {
    let pathname;
    try { pathname = new URL(req.url, origin).pathname; } catch { return false; }
    if (!pathname.startsWith('/api/platforms/') && !pathname.startsWith('/api/weibo/') && !pathname.startsWith('/api/content/')) return false;
    if (req.headers.host !== origin.host) {
      reply(res, 403, { error: { code: 'FORBIDDEN_HOST', message: '请求地址无效，请从本地控制台操作。', submitted: false } });
      return true;
    }
    const contentRoute = /^\/api\/content\/([A-Za-z0-9_-]{1,128})\/deletion-status$/.exec(pathname);
    if (contentRoute) {
      if (req.method !== 'GET') {
        reply(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '删除检查只支持读取。', submitted: false } });
        return true;
      }
      const contentId = contentRoute[1];
      try {
        const states = await Promise.all(ledgerReaders.map(reader => reader.deletionStatus(contentId)));
        const publications = states.flatMap(state => state.publications);
        const pending = states.some(state => state.pending);
        reply(res, 200, { contentId, canDelete: !pending && publications.every(publication => Boolean(publication.receipt.deletedAt)), publications, pending });
      } catch {
        reply(res, 503, { contentId, canDelete: false, pending: true, error: { code: 'STORAGE_ERROR', message: '无法完整核实各平台记录，请保留原内容并检查本地发布记录。', submitted: false } });
      }
      return true;
    }
    const match = /^\/api\/platforms\/([a-z]+)\/([a-z]+(?:-[a-z]+)*)$/.exec(pathname) || /^\/api\/(weibo)\/([a-z]+(?:-[a-z]+)*)$/.exec(pathname);
    if (!match || !handlers.has(match[1])) {
      reply(res, 404, { error: { code: 'NOT_FOUND', message: '未找到这个平台接口。', submitted: false } });
      return true;
    }
    return handlers.get(match[1])(req, res, match[2], pathname.startsWith('/api/weibo/'));
  };
  // The HTTP service owns browser shutdown. This dispatcher has no timers/jobs.
  handler.close = async () => {};
  return handler;
}
