import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createXiaohongshuAdapter } from './xiaohongshu-adapter.mjs';
import { createDouyinAdapter } from './douyin-adapter.mjs';
import { createBilibiliAdapter } from './bilibili-adapter.mjs';
import { fail, hasChallenge, PlatformBrowserError } from './platform-browser-helpers.mjs';
import { createChromeAccountBinding } from './chrome-account-binding.mjs';

const factories = { xiaohongshu: createXiaohongshuAdapter, douyin: createDouyinAdapter, bilibili: createBilibiliAdapter };
const accountOrigins = {
  xiaohongshu: ['https://www.xiaohongshu.com', 'https://creator.xiaohongshu.com'],
  douyin: ['https://creator.douyin.com'],
  bilibili: ['https://t.bilibili.com'],
};

const diagnosticMessages = {
  ACCOUNT_CHANGED: '当前账号与确认账号不一致，操作已停止。',
  LOGIN_REQUIRED: '平台会话需要重新登录。',
  CAPTCHA_REQUIRED: '平台会话需要完成安全验证。',
  BROWSER_UNAVAILABLE: '平台专用浏览器或页面暂不可用。',
  BROWSER_CLOSED: '平台专用页面已关闭。',
  IMAGE_UPLOAD_FAILED: '平台图片上传或图片核对未完成。',
  UI_CHANGED: '平台页面结构或控件状态发生变化，操作已停止。',
  OPERATION_UNSUPPORTED: '平台未提供可确认的原帖操作入口。',
  PUBLISH_REJECTED: '平台操作未通过提交检查或未被接受。',
  PUBLISH_UNCERTAIN: '平台操作结果尚未确认，原请求保留，未自动重发。',
};
const diagnosticLabels = ['发布', '立即发布', '发布动态', '发送', '保存', '保存修改', '修改', '编辑', '删除', '确认删除', '确定', '确认', '取消', '返回', '关闭', '重试', '重新上传', '上传图片', '添加图片', '上传失败', '上传中', '发布失败', '发布成功', '保存成功', '登录', '扫码登录', '安全验证', '验证码', '图片', '图文', '动态', '下一步', '完成'];
const diagnosticDialogFlags = ['首次发布规范确认窗口', '安全验证窗口', '登录或验证窗口', '原生操作确认窗口', '原生动态编辑窗口'];
const diagnosticResponsePaths = new Set(['/x/dynamic/feed/create/dyn', '/x/dynamic/feed/create/submit_check', '/x/dynamic/feed/draw/upload_bfs',
  '/web/api/media/aweme/create/', '/web/api/media/aweme/create_v2/',
  '/x/dynamic/feed/edit/dyn', '/x/dynamic/feed/operate/remove', '/x/polymer/web-dynamic/v1/feed/space', '/x/polymer/web-dynamic/v1/detail']);
const reconcileDiagnosticStages = new Set(['input', 'account', 'feed', 'detail', 'images', 'final-account', 'complete']);
const reconcileDiagnosticReasons = new Set(['running', 'invalid-attempt', 'input-invalid', 'account-mismatch', 'feed-unavailable', 'feed-author-invalid',
  'feed-item-invalid', 'feed-id-invalid', 'feed-timestamp-missing', 'feed-timestamp-type', 'feed-timestamp-invalid', 'feed-item-changed', 'candidate-limit', 'pagination-invalid', 'pagination-incomplete', 'detail-unavailable', 'detail-identity-changed',
  'detail-text-missing', 'detail-text-truncated', 'detail-completeness-missing', 'detail-nodes-missing', 'detail-text-inconsistent', 'detail-pictures-invalid',
  'candidate-unrecognized', 'image-unverified', 'multiple-matches', 'no-match', 'final-account-mismatch', 'confirmed', 'unexpected-error']);
const reconcileDiagnosticOutcomes = new Set(['ok', 'http-error', 'provider-error', 'body-error', 'shape-error', 'network-error', 'timeout', 'page-error',
  'byte-match', 'pixel-match', 'pixel-mismatch', 'unsupported-format', 'size-limit', 'decode-error']);
const structureDiagnosticStages = new Set(['update_load_detail', 'update_verify_images', 'update_verify_text', 'update_submit', 'validation', 'identity', 'publish_navigation', 'wait_image_entry', 'select_image_tab', 'wait_image_uploader',
  'check_empty_editor', 'upload_images', 'find_composer', 'fill_text', 'confirm_before_checkpoint', 'confirm_after_checkpoint', 'native_submit', 'native_receipt']);
const structureDiagnosticClasses = new Set(['upload-input', 'creator-tab', 'd-input', 'tiptap', 'ql-editor', 'publish-page-publish-btn', 'bg-red', 'upload-content', 'img-list']);

/** This function is serialized into the page. It never reads input values or arbitrary page text. */
export function collectDiagnosticPage({ origin, labels }) {
  if (location.origin !== origin) return undefined;
  const allowed = new Set(labels);
  const result = [];
  const excluded = 'script,style,input,textarea,select,option,[contenteditable],[role="textbox"],[hidden],[aria-hidden="true"],[inert]';
  for (const element of [...document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="tab"],h1,h2,h3')].slice(0, 100)) {
    if (element.closest(excluded) || !element.getClientRects().length) continue;
    let hidden = false;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') { hidden = true; break; }
    }
    if (hidden) continue;
    // Text must equal a known static UI label; arbitrary errors, mirrored form
    // values, post titles, and article text are never returned to the server.
    const label = element.innerText?.trim();
    if (allowed.has(label) && !result.includes(label)) result.push(label);
    if (result.length >= 30) break;
  }
  return { labels: result };
}

function diagnosticPath(platform, address, origins) {
  try {
    const url = new URL(address);
    if (url.username || url.password || !origins.has(url.origin)) return '[outside-platform]';
    const pathname = url.pathname;
    if (pathname === '/') return '/';
    if (platform === 'bilibili') {
      if (/^\/(?:opus\/)?[1-9]\d{0,31}\/?$/.test(pathname)) return pathname.startsWith('/opus/') ? '/opus/:id' : '/:id';
    } else if (platform === 'xiaohongshu') {
      if (/^\/(?:explore|user\/profile)\/[a-fA-F0-9]{24}\/?$/.test(pathname)) return pathname.startsWith('/explore/') ? '/explore/:id' : '/user/profile/:id';
      if (['/explore', '/publish/publish', '/publish/edit', '/manager/note', '/new/note-manager'].includes(pathname)) return pathname;
    } else if (platform === 'douyin' && /^\/creator-micro\/(?:content\/(?:manage|publish|post\/image|post\/video)|home|login)\/?$/.test(pathname)) return pathname;
    return '[unrecognized-path]';
  } catch { return '[unavailable]'; }
}

function safeAdapterDiagnostic(value) {
  if (!value || typeof value !== 'object') return undefined;
  const result = {};
  if (value.nativePublication && typeof value.nativePublication === 'object') {
    const native = {};
    for (const key of ['requests', 'responses', 'failures']) if (Number.isSafeInteger(value.nativePublication[key]) && value.nativePublication[key] >= 0 && value.nativePublication[key] <= 1000) native[key] = value.nativePublication[key];
    if (Array.isArray(value.nativePublication.networkErrors)) native.networkErrors = value.nativePublication.networkErrors.filter(code => ['net::ERR_TIMED_OUT', 'net::ERR_CONNECTION_RESET', 'net::ERR_CONNECTION_CLOSED', 'net::ERR_CONNECTION_REFUSED', 'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_INTERNET_DISCONNECTED', 'net::ERR_ABORTED', 'net::ERR_FAILED', 'network-error'].includes(code)).slice(-10);
    result.nativePublication = native;
  }
  if (value.editor && typeof value.editor === 'object') {
    const editor = {};
    for (const key of ['count', 'pictureCount', 'readyPictureCount', 'uploadedPictureCount', 'failedPictureCount', 'titleLength', 'bodyLength']) {
      if (Number.isSafeInteger(value.editor[key]) && value.editor[key] >= 0 && value.editor[key] <= 100_000) editor[key] = value.editor[key];
    }
    for (const key of ['previewLoadedPictureCount', 'previewMissingPictureCount']) {
      if (Number.isSafeInteger(value.editor[key]) && value.editor[key] >= 0 && value.editor[key] <= 1_000) editor[key] = value.editor[key];
    }
    for (const key of ['bodyHash', 'titleHash']) if (typeof value.editor[key] === 'string' && /^[a-f0-9]{64}$/.test(value.editor[key])) editor[key] = value.editor[key];
    for (const key of ['editorId', 'authorUid']) if (typeof value.editor[key] === 'string' && /^[1-9]\d{0,31}$/.test(value.editor[key])) editor[key] = value.editor[key];
    if (Object.keys(editor).length) result.editor = editor;
  }
  if (Array.isArray(value.dialogs)) result.dialogs = [...new Set(value.dialogs.filter(label => diagnosticLabels.includes(label) || diagnosticDialogFlags.includes(label)))].slice(0, 20);
  if (Array.isArray(value.responseMetadata)) {
    result.responseMetadata = value.responseMetadata.slice(-20).flatMap(item => {
      if (!item || typeof item !== 'object' || !diagnosticResponsePaths.has(item.path)) return [];
      const entry = { path: item.path };
      if (Number.isInteger(item.status) && item.status >= 100 && item.status <= 599) entry.status = item.status;
      if (Number.isSafeInteger(item.code) && Math.abs(item.code) < 1_000_000_000) entry.code = item.code;
      if (typeof item.id === 'string' && /^[1-9]\d{0,31}$/.test(item.id)) entry.id = item.id;
      if (typeof item.verificationRequired === 'boolean') entry.verificationRequired = item.verificationRequired;
      if (Number.isSafeInteger(item.bodyBytes) && item.bodyBytes >= 0 && item.bodyBytes <= 2 * 1024 * 1024) entry.bodyBytes = item.bodyBytes;
      return [entry];
    });
  }
  if (value.reconcile && typeof value.reconcile === 'object' && !Array.isArray(value.reconcile)) {
    const source = value.reconcile, reconcile = {};
    if (reconcileDiagnosticStages.has(source.stage)) reconcile.stage = source.stage;
    if (reconcileDiagnosticReasons.has(source.reason)) reconcile.reason = source.reason;
    for (const key of ['feedPages', 'feedItems', 'inWindow', 'details', 'matches']) {
      if (Number.isSafeInteger(source[key]) && source[key] >= 0 && source[key] <= 1_000) reconcile[key] = source[key];
    }
    if (Array.isArray(source.requests)) reconcile.requests = source.requests.slice(-24).flatMap(request => {
      if (!request || typeof request !== 'object' || !['feed', 'detail', 'image'].includes(request.kind) || !reconcileDiagnosticOutcomes.has(request.outcome)) return [];
      const entry = { kind: request.kind, outcome: request.outcome };
      if (Number.isInteger(request.status) && request.status >= 100 && request.status <= 599) entry.status = request.status;
      if (Number.isSafeInteger(request.code) && Math.abs(request.code) < 1_000_000_000) entry.code = request.code;
      if (Number.isSafeInteger(request.itemCount) && request.itemCount >= 0 && request.itemCount <= 100) entry.itemCount = request.itemCount;
      if (['boolean', 'number', 'string', 'missing', 'other'].includes(request.hasMoreType)) entry.hasMoreType = request.hasMoreType;
      if (typeof request.hasMore === 'boolean') entry.hasMore = request.hasMore;
      for (const key of ['itemShape', 'itemsShape']) if (['missing', 'object', 'array', 'other'].includes(request[key])) entry[key] = request[key];
      return [entry];
    });
    if (Object.keys(reconcile).length) result.reconcile = reconcile;
  }
  if (value.structure && typeof value.structure === 'object' && !Array.isArray(value.structure)) {
    const source = value.structure, structure = {};
    if (structureDiagnosticStages.has(source.stage)) structure.stage = source.stage;
    if (['loading', 'interactive', 'complete'].includes(source.readyState)) structure.readyState = source.readyState;
    if (source.counts && typeof source.counts === 'object') {
      const counts = {};
      for (const key of ['imageTab', 'titleInput', 'bodyEditor', 'fileInput', 'imageFileInput', 'videoFileInput', 'publishWidget', 'legacyPublishButton', 'previewImage']) {
        if (Number.isSafeInteger(source.counts[key]) && source.counts[key] >= 0 && source.counts[key] <= 1_000) counts[key] = source.counts[key];
      }
      structure.counts = counts;
    }
    if (Array.isArray(source.controls)) structure.controls = source.controls.slice(0, 20).flatMap(control => {
      if (!control || typeof control !== 'object' || !['file-input', 'title-input', 'body-editor', 'image-tab', 'publish-widget', 'legacy-publish-button'].includes(control.kind) ||
        !['input', 'textarea', 'div', 'span', 'button', 'xhs-publish-btn'].includes(control.tag)) return [];
      const entry = { kind: control.kind, tag: control.tag };
      for (const key of ['visible', 'disabled']) if (typeof control[key] === 'boolean') entry[key] = control[key];
      if (['image', 'video', 'mixed', 'none', 'other'].includes(control.accept)) entry.accept = control.accept;
      if (Array.isArray(control.knownClasses)) entry.knownClasses = [...new Set(control.knownClasses.filter(name => structureDiagnosticClasses.has(name)))];
      return [entry];
    });
    if (Object.keys(structure).length) result.structure = structure;
  }
  return Object.keys(result).length ? result : undefined;
}

export function publicAccount(value) {
  if (!value || typeof value.uid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.uid)
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 300) return undefined;
  const account = { uid: value.uid, name: value.name };
  for (const field of ['profileUrl', 'avatarUrl']) {
    try {
      const url = new URL(value[field]);
      if (url.protocol === 'https:' && !url.username && !url.password) account[field] = url.href;
    } catch { /* Only optional public URLs are copied. */ }
  }
  return account.profileUrl ? account : undefined;
}

export function publicLogin(value) {
  if (value?.kind === 'qr' && !value.image) return { kind: 'qr', ...(typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt)) ? { expiresAt: value.expiresAt } : {}) };
  if (value?.kind !== 'qr' || typeof value.image !== 'string' || value.image.length > 1_500_000
    || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.image)) return { kind: 'window' };
  const login = { kind: 'qr', image: value.image };
  if (typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt))) login.expiresAt = value.expiresAt;
  return login;
}

function publicComposerDraft(value) {
  if (!value || typeof value.title !== 'string' || value.title.length > 1000 || typeof value.body !== 'string' || value.body.length > 10000 || /\u0000/.test(value.title + value.body)
    || !Number.isInteger(value.imageCount) || value.imageCount < 0 || value.imageCount > 100 || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)) {
    fail('UI_CHANGED', '无法完整确认官网未发草稿，已停止操作。');
  }
  return { actualUI: true, title: value.title, body: value.body, imageCount: value.imageCount, fingerprint: value.fingerprint };
}

/** Local, per-platform persistent profiles. GET status never opens a browser. */
export function createPlatformBrowser({ platform, dataDir = path.resolve('.data'), chromium, currentChrome, headless, adapter: injectedAdapter, resumeTimeoutMs = 10_000 } = {}) {
  if (!Object.hasOwn(factories, platform)) fail('PLATFORM_UNSUPPORTED', '尚不支持此平台。');
  const adapter = injectedAdapter || factories[platform]();
  const supportedOrigins = new Set(accountOrigins[platform]);
  // Dependency-injected adapters can target a local deterministic fixture; this
  // does not widen any production platform's origin allowlist.
  if (injectedAdapter) supportedOrigins.add(new URL(adapter.homeUrl).origin);
  const baseDir = path.resolve(dataDir);
  // Shared Chrome owns its own login data. Only a connection marker belongs here.
  const profileDir = path.join(baseDir, `${platform}-${currentChrome ? 'chrome-connection' : 'profile'}`);
  const savedMarker = path.join(profileDir, '.fatiao-session-saved');
  const binding = currentChrome ? createChromeAccountBinding({ directory: profileDir, normalizeAccount: publicAccount }) : undefined;
  let context, page;
  let currentHeadless = currentChrome ? false : headless ?? adapter.defaultHeadless ?? false;
  let queue = Promise.resolve();
  let resumePromise;
  const resumeWait = Number.isFinite(resumeTimeoutMs) ? Math.max(1, Math.min(30_000, resumeTimeoutMs)) : 10_000;
  const serialized = (operation) => {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  };
  const statOrMissing = async (file) => {
    try { return await lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; return undefined; }
  };
  function livePages() {
    return context ? context.pages().filter((candidate) => !candidate.isClosed()) : [];
  }
  function supportsPage(candidate) {
    try { return !candidate.isClosed() && supportedOrigins.has(new URL(candidate.url()).origin); }
    catch { return false; }
  }
  function reconcilePage() {
    const live = livePages();
    // Keep a usable editing page stable. Only recover its reference when it has
    // closed or left this platform; observing tabs does not navigate or open one.
    if (!page || !live.includes(page) || !supportsPage(page)) page = live.find(supportsPage);
    return live;
  }
  async function probe(operation, deadline) {
    if (deadline === undefined) return operation();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    let timer;
    try {
      // The adapter reads public identity only. A late result is discarded and
      // cannot mark the session connected after this verification has timed out.
      return await Promise.race([Promise.resolve().then(operation), new Promise((resolve) => { timer = setTimeout(resolve, remaining); })]);
    } finally { clearTimeout(timer); }
  }
  async function ensureSafePath(create = false) {
    // Reject the configured data directory and profile themselves. System paths
    // such as macOS /tmp and /var are valid ancestors with canonical symlinks.
    for (const directory of [baseDir, profileDir]) {
      const stat = await statOrMissing(directory);
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('BROWSER_UNAVAILABLE', `${adapter.name}专用配置路径异常，未读写或删除登录信息。`);
    }
    if (create) {
      await mkdir(profileDir, { recursive: true, mode: 0o700 });
      await chmod(profileDir, 0o700);
    }
  }
  async function writeDiagnosticArtifact(extension, content) {
    const target = path.join(baseDir, `${platform}-operation-error.${extension}`);
    const temporary = path.join(baseDir, `.${platform}-operation-error-${randomUUID()}.tmp`);
    try {
      await ensureSafePath();
      await mkdir(baseDir, { recursive: true, mode: 0o700 });
      await chmod(baseDir, 0o700);
      const destination = await statOrMissing(target);
      if (destination && (!destination.isFile() || destination.isSymbolicLink())) return false;
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
      return true;
    } catch { return false; }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  async function operationDiagnostic(operation, trace, error, failedPage = page) {
    // Error messages can contain native call logs or provider responses, even
    // after an adapter wraps them. Only our fixed diagnostic vocabulary is saved.
    const code = typeof error?.code === 'string' && Object.hasOwn(diagnosticMessages, error.code) ? error.code : 'NATIVE_OPERATION_FAILED';
    const diagnostic = { at: new Date().toISOString(), platform, operation, stage: trace.stage,
      submitted: Boolean(trace.submitted || error?.submitted), code, message: diagnosticMessages[code] || '原生平台操作失败，未记录底层错误详情。', screenshotSaved: false };
    const origins = new Set([...supportedOrigins, ...(platform === 'bilibili' ? ['https://www.bilibili.com'] : [])]);
    try {
      if (failedPage && !failedPage.isClosed()) {
        const address = failedPage.url();
        diagnostic.path = diagnosticPath(platform, address, origins);
        const url = new URL(address);
        if (origins.has(url.origin)) {
          const deadline = Date.now() + 1_200;
          let snapshot;
          try { snapshot = await probe(() => failedPage.evaluate(collectDiagnosticPage, { origin: url.origin, labels: diagnosticLabels }), deadline); }
          catch { /* A DOM failure does not discard the adapter's safe response metadata. */ }
          if (snapshot && Array.isArray(snapshot.labels)) diagnostic.page = { visibleText: [...new Set(snapshot.labels.filter(label => diagnosticLabels.includes(label)))].slice(0, 30).join('\n') };
          if (typeof adapter.diagnostics === 'function' && origins.has(new URL(failedPage.url()).origin)) {
            const metadata = safeAdapterDiagnostic(await probe(() => adapter.diagnostics(failedPage), deadline));
            if (metadata) diagnostic.adapter = metadata;
          }
        }
      }
    } catch { /* A closed or navigating page may not have a readable snapshot. */ }
    // Screenshots may contain the user's content. They require a separate,
    // explicit development flag and stay private on disk with no serving route.
    if (process.env.NODE_ENV !== 'production' && process.env.FATIAO_DEBUG_SCREENSHOTS === '1') {
      try {
        await ensureSafePath();
        if (failedPage && !failedPage.isClosed() && typeof failedPage.screenshot === 'function') {
          const origin = new URL(failedPage.url()).origin;
          if (origins.has(origin)) {
            const bytes = await failedPage.screenshot({ type: 'png', fullPage: false, timeout: 3_000 });
            if (!failedPage.isClosed() && new URL(failedPage.url()).origin === origin && Buffer.isBuffer(bytes) && bytes.length <= 20 * 1024 * 1024 &&
              bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
              diagnostic.screenshotSaved = await writeDiagnosticArtifact('png', bytes);
            }
          }
        }
      } catch { /* A failed screenshot cannot change the original operation outcome. */ }
    }
    await writeDiagnosticArtifact('json', JSON.stringify(diagnostic, null, 2));
  }
  async function sessionSaved() {
    await ensureSafePath();
    const stat = await statOrMissing(savedMarker);
    return Boolean(stat?.isFile() && !stat.isSymbolicLink());
  }
  async function rememberSession(account) {
    await ensureSafePath();
    const stat = await statOrMissing(savedMarker);
    if (stat?.isSymbolicLink() || (stat && !stat.isFile())) fail('BROWSER_UNAVAILABLE', '登录状态标记异常。');
    if (!stat) await writeFile(savedMarker, '1\n', { mode: 0o600, flag: 'wx' });
    if (binding) await binding.save(account);
  }
  async function launch(visible = false, targetUrl = adapter.homeUrl) {
    await ensureSafePath(true);
    if (visible || currentChrome) currentHeadless = false;
    const options = { chromiumSandbox: true, headless: currentHeadless, viewport: currentHeadless ? { width: 1280, height: 900 } : null,
      acceptDownloads: false, args: ['--no-first-run', '--no-default-browser-check'] };
    let owned;
    try {
      if (currentChrome) owned = await currentChrome.acquire(platform);
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
      throw new PlatformBrowserError('BROWSER_UNAVAILABLE', `无法启动${adapter.name}专用浏览器，请安装 Chrome 或运行 npm run browser:install。`, { cause: error });
    }
    context = owned;
    owned.on('close', () => { if (context === owned) { context = undefined; page = undefined; } });
    try {
      page = owned.pages()[0] || await owned.newPage();
      page.setDefaultTimeout(8_000); page.setDefaultNavigationTimeout(30_000);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    }
    catch (error) {
      await close();
      if (error.code === 'CHROME_CONNECTION_REQUIRED') throw error;
      throw new PlatformBrowserError('BROWSER_UNAVAILABLE', `${adapter.name}官网加载失败，请检查网络后重新连接。`, { cause: error });
    }
  }
  async function readStatus({ deadline } = {}) {
    const saved = await sessionSaved();
    const remembered = saved && binding ? await binding.read() : undefined;
    const accountBinding = remembered ? { account: remembered, accountVerification: 'required' } : {};
    const live = reconcilePage();
    if (!page) return { mode: 'browser', connected: false, browserOpen: live.length > 0, publishReady: false, sessionSaved: saved, headless: currentHeadless, ...accountBinding,
      message: live.length ? '专用窗口中没有可用的平台页面，请打开平台官网后刷新连接状态。'
        : saved ? '本机保留了专用会话，点击连接恢复并检查登录状态。' : `请连接${adapter.name}并完成登录。` };
    const inspectedPage = page;
    let account;
    try { account = publicAccount(await probe(() => adapter.readAccount(inspectedPage), deadline)); } catch { /* A loading or expired page is disconnected. */ }
    let challenge;
    try { challenge = await probe(() => (adapter.hasChallenge || hasChallenge)(inspectedPage), deadline); } catch { /* An unreadable page is not publish-ready. */ }
    // Closing a page while its identity request is in flight must not produce a
    // connected result from an obsolete handle.
    if (inspectedPage.isClosed() || !supportsPage(inspectedPage) || page !== inspectedPage) account = undefined;
    if (account) {
      await rememberSession(account);
      if (inspectedPage.isClosed() || !supportsPage(inspectedPage) || page !== inspectedPage) return readStatus({ deadline });
      return { mode: 'browser', connected: true, browserOpen: true, publishReady: challenge === false, account, sessionSaved: true, headless: currentHeadless,
        ...(currentChrome ? { accountVerification: 'verified' } : {}),
        message: challenge !== false ? '当前会话需要安全验证，请打开专用窗口完成后再继续。'
          : currentHeadless ? '已连接，发布将在后台专用浏览器执行。' : '已连接，发布将在专用窗口执行。' };
    }
    let login = { kind: 'window' };
    let notice;
    try { login = publicLogin(await probe(() => adapter.getLoginQr?.(inspectedPage), deadline)); } catch { /* Visible fallback is always available. */ }
    try { notice = await probe(() => adapter.getLoginNotice?.(inspectedPage), deadline); } catch { /* A closed page has no notice. */ }
    return { mode: 'browser', connected: false, browserOpen: livePages().length > 0, publishReady: false, sessionSaved: saved, headless: currentHeadless, login, ...accountBinding,
      message: notice || (challenge ? '当前会话需要安全验证，请打开专用窗口完成后再继续。' : login.kind === 'qr' ? `请用${adapter.name} App 扫码；如需安全验证，请打开专用窗口。`
        : currentHeadless ? '当前页面需要在官网继续操作，请打开专用窗口完成登录或验证。' : '请在专用窗口扫码或手动登录，再刷新连接状态。') };
  }
  async function ensurePage() {
    reconcilePage();
    if (!context) await launch();
    else if (!page || page.isClosed()) {
      page = await context.newPage();
      page.setDefaultTimeout(8_000); page.setDefaultNavigationTimeout(30_000);
      await page.goto(adapter.homeUrl, { waitUntil: 'domcontentloaded' });
    }
  }
  async function login(options = {}) {
    if (options.mode === 'window') return open();
    await ensurePage();
    const status = await readStatus();
    if (!status.connected) {
      const next = await adapter.login(page);
      if (next && typeof next.isClosed === 'function') page = next;
    }
    if (!currentHeadless) await page.bringToFront();
    return readStatus();
  }
  async function close() {
    const owned = context;
    if (owned) await owned.close();
    context = undefined; page = undefined;
    return readStatus();
  }
  async function open() {
    // Serialized with publish, so a switch can never terminate an active submission.
    reconcilePage();
    const targetUrl = page && !page.isClosed() ? page.url() : adapter.homeUrl;
    if (context && currentHeadless) await close();
    if (!context) await launch(true, targetUrl);
    await ensurePage();
    await page.bringToFront();
    const status = await readStatus();
    if (!status.connected) {
      const next = await adapter.login(page);
      if (next && typeof next.isClosed === 'function') page = next;
      await page.bringToFront();
    }
    return readStatus();
  }
  async function refresh() {
    // Only an explicit shared-Chrome refresh may reopen a saved connection.
    // Background status reads never create a page.
    const current = await readStatus();
    if (currentChrome && !current.browserOpen && current.sessionSaved) return resume();
    if (current.connected) return current;
    if (context && page && !page.isClosed()) await page.reload({ waitUntil: 'domcontentloaded' });
    return readStatus();
  }
  async function resume() {
    let deadline = Date.now() + resumeWait;
    let status = await readStatus({ deadline });
    if (status.connected || !status.sessionSaved) return status;
    const live = reconcilePage();
    // Never disturb a live visible window, including a tab that has navigated
    // outside this platform. Only a genuinely empty owned context can restart.
    if (context && !live.length) await close();
    else if (context && !page) return status;
    if (!context) {
      currentHeadless = currentChrome ? false : adapter.resumeHeadless ?? true;
      // Recovery can start at a platform's creator origin so identity checks
      // use its current first-party session. Existing live pages stay untouched.
      await launch(false, adapter.resumeUrl || adapter.homeUrl);
      deadline = Date.now() + resumeWait;
    }
    do {
      status = await readStatus({ deadline });
      if (status.connected || !page || !livePages().length || Date.now() >= deadline) return status;
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
    } while (Date.now() < deadline);
    return status;
  }
  function requestResume() {
    // Concurrent HTTP requests share one recovery attempt and one fresh result.
    if (resumePromise) return resumePromise;
    const pending = serialized(resume);
    resumePromise = pending;
    const clear = () => { if (resumePromise === pending) resumePromise = undefined; };
    pending.then(clear, clear);
    return pending;
  }
  async function disconnect() {
    await close();
    await ensureSafePath();
    if (await statOrMissing(profileDir)) await rm(profileDir, { recursive: true, force: false });
    return { mode: 'browser', connected: false, browserOpen: false, publishReady: false, sessionSaved: false, headless: currentHeadless, message: `已清除本应用的${adapter.name}会话，下次需要重新登录。` };
  }
  async function publish(input, hooks = {}) {
    const trace = { stage: 'validate_input', submitted: false };
    try {
      if (typeof hooks.beforeSubmit !== 'function') fail('PUBLISH_REJECTED', '提交前记录缺失，已停止发布。');
      trace.stage = 'resume_session';
      const status = await resume();
      trace.stage = 'verify_account';
      if (!status.connected) fail('LOGIN_REQUIRED', `请先连接${adapter.name}并完成登录。`);
      if (status.account.uid !== input?.expectedAccountUid) fail('ACCOUNT_CHANGED', '发布账号已变化，请刷新账号并重新确认。');
      if (!status.publishReady) fail('CAPTCHA_REQUIRED', '请先在专用窗口完成安全验证，再继续发布。');
      trace.stage = 'prepare_publication';
      return await adapter.publish(page, input, { ...hooks, beforeSubmit: async () => {
        trace.stage = 'submit_checkpoint';
        await hooks.beforeSubmit();
        trace.submitted = true;
        trace.stage = 'confirm_publication';
      } });
    } catch (error) {
      await operationDiagnostic('publish', trace, error).catch(() => {});
      throw error;
    }
  }
  async function reconcilePublication(input, options = {}) {
    const trace = { stage: 'validate_reconciliation', submitted: true };
    try {
      if (typeof adapter.reconcilePublication !== 'function' || typeof input?.expectedAccountUid !== 'string' || !input.expectedAccountUid.trim()
        || typeof options.attemptedAt !== 'string' || !Number.isFinite(Date.parse(options.attemptedAt))) {
        fail('PUBLISH_UNCERTAIN', '原发布请求缺少可核对的信息，结果仍待确认。');
      }
      trace.stage = 'resume_session';
      const status = await resume();
      trace.stage = 'verify_account';
      if (!status.connected || status.account.uid !== input.expectedAccountUid) {
        fail('PUBLISH_UNCERTAIN', '尚未确认原发布账号的有效会话，发布结果仍待核对。');
      }
      if (!status.publishReady) fail('CAPTCHA_REQUIRED', '请在专用窗口完成安全验证，再核对同一发布请求。');
      trace.stage = 'read_publication_evidence';
      // No submit hook or publishing fallback is available on this path. The
      // adapter observes the original attempt on the stable, existing page.
      const result = await adapter.reconcilePublication(page, structuredClone(input), { attemptedAt: options.attemptedAt });
      if (!result || typeof result.id !== 'string' || !result.id || typeof result.url !== 'string' ||
        typeof result.publishedAt !== 'string' || !Number.isFinite(Date.parse(result.publishedAt)) || result.account?.uid !== input.expectedAccountUid) {
        fail('PUBLISH_UNCERTAIN', '未找到与原请求一致的确定发布证据，原请求继续保留。');
      }
      return result;
    } catch (error) {
      await operationDiagnostic('reconcile-publication', trace, error).catch(() => {});
      let requiresVerification = false;
      try { requiresVerification = error?.code === 'CAPTCHA_REQUIRED'; } catch { /* Preserve uncertainty for untrusted error getters. */ }
      if (requiresVerification) {
        const challenge = new PlatformBrowserError('CAPTCHA_REQUIRED', '请在专用窗口完成安全验证，再核对同一发布请求。');
        challenge.submitted = true;
        throw challenge;
      }
      const uncertain = new PlatformBrowserError('PUBLISH_UNCERTAIN', '原发布结果仍待确认，已保留同一请求，本次没有重新发布。', { cause: error });
      uncertain.submitted = true;
      throw uncertain;
    }
  }
  async function composerDraft(input, clear = false) {
    if (typeof adapter.inspectComposerDraft !== 'function' || (clear && typeof adapter.clearComposerDraft !== 'function')) fail('OPERATION_UNSUPPORTED', '此平台暂不支持检查或清理官网未发草稿。');
    if (typeof input?.expectedAccountUid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.expectedAccountUid)
      || (clear && (typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint)))) fail('VALIDATION_ERROR', '请先确认账号和当前官网草稿。');
    const status = await resume();
    if (!status.connected) fail('LOGIN_REQUIRED', '请先恢复原账号会话，再检查官网未发草稿。');
    if (status.account.uid !== input.expectedAccountUid) fail('ACCOUNT_CHANGED', '当前账号与确认账号不同，未触碰官网草稿。');
    if (!status.publishReady) fail('CAPTCHA_REQUIRED', '请先在专用窗口完成安全验证。');
    if (!page || !supportsPage(page)) fail('UI_CHANGED', '没有可检查的官网编辑页面，未触碰草稿。');
    const draftPage = page;
    const accountMatches = async () => {
      if (!supportsPage(draftPage) || !livePages().includes(draftPage)) fail('UI_CHANGED', '官网编辑页面已变化，请重新读取草稿。');
      const account = publicAccount(await adapter.readAccount(draftPage));
      if (!account || account.uid !== input.expectedAccountUid) fail('ACCOUNT_CHANGED', '检查期间账号发生变化，请重新确认账号和草稿。');
      return account;
    };
    const draft = publicComposerDraft(await adapter.inspectComposerDraft(draftPage));
    let account = await accountMatches();
    if (!clear) return { account, draft };
    if (draft.fingerprint !== input.fingerprint) fail('DRAFT_CHANGED', '官网未发草稿已变化，请重新读取并确认后再清理。');
    // The adapter rechecks the same fingerprint and account immediately before
    // native editor-only changes. No publication hook or ledger is involved.
    await adapter.clearComposerDraft(draftPage, { expectedAccountUid: input.expectedAccountUid, fingerprint: input.fingerprint });
    const cleared = publicComposerDraft(await adapter.inspectComposerDraft(draftPage));
    account = await accountMatches();
    if (cleared.title.trim() || cleared.body.trim() || cleared.imageCount !== 0) fail('DRAFT_CLEAR_FAILED', '官网未发草稿尚未完全清空，请重新读取后检查。');
    return { cleared: true, account, draft: cleared };
  }
  async function reconcileOperation(input, options = {}) {
    if (typeof adapter.reconcileOperation !== 'function' || !['update', 'delete'].includes(options.operation)
      || !Number.isFinite(Date.parse(options.attemptedAt))) return undefined;
    const status = await resume();
    if (!status.connected || !status.publishReady || status.account.uid !== input.expectedAccountUid
      || input.receipt?.account?.uid !== input.expectedAccountUid) fail('ACCOUNT_CHANGED', '请先恢复原发布账号，再核对操作结果。');
    let queryPage;
    try {
      queryPage = await context.newPage();
      queryPage.setDefaultTimeout(8_000); queryPage.setDefaultNavigationTimeout(30_000);
      await queryPage.goto(adapter.resumeUrl || adapter.homeUrl, { waitUntil: 'domcontentloaded' });
      // A separate read-only path has no submit hook and never calls update/delete.
      const result = await adapter.reconcileOperation(queryPage, structuredClone(input), options);
      const stamp = options.operation === 'update' ? result?.updatedAt : result?.deletedAt;
      if (!result || result.id !== input.receipt.id || result.url !== input.receipt.url
        || result.account?.uid !== input.expectedAccountUid || !Number.isFinite(Date.parse(stamp))) return undefined;
      return result;
    } catch (error) {
      await operationDiagnostic('reconcile-operation', { stage: 'read_operation_evidence', submitted: true }, error, queryPage || page).catch(() => {});
      throw error;
    } finally { await queryPage?.close().catch(() => {}); }
  }
  async function mutatePublication(operation, input, hooks = {}) {
    const trace = { stage: 'validate_input', submitted: false };
    let submitted = false, checkpointStarted = false, operationPage;
    try {
      if (typeof adapter[operation] !== 'function') fail('OPERATION_UNSUPPORTED', `当前${adapter.name}连接器尚不支持${operation === 'update' ? '修改已发内容' : '删除已发内容'}。`);
      if (typeof hooks.beforeSubmit !== 'function') fail('PUBLISH_REJECTED', '提交前记录缺失，已停止操作。');
      const receipt = input?.receipt;
      const validId = platform === 'xiaohongshu' ? /^[a-fA-F0-9]{24}$/ : /^[1-9]\d{0,31}$/;
      if (!receipt || typeof receipt.id !== 'string' || !validId.test(receipt.id) || typeof receipt.url !== 'string'
        || typeof receipt.account?.uid !== 'string' || receipt.account.uid !== input.expectedAccountUid) fail('ACCOUNT_CHANGED', '原帖回执或发布账号不一致，已停止操作。');
      trace.stage = 'resume_session';
      const status = await resume();
      trace.stage = 'verify_account';
      if (!status.connected) fail('LOGIN_REQUIRED', `请先连接${adapter.name}并完成登录。`);
      if (status.account.uid !== receipt.account.uid) fail('ACCOUNT_CHANGED', '当前账号与原帖账号不同，已停止操作。');
      if (!status.publishReady) fail('CAPTCHA_REQUIRED', '请先在专用窗口完成安全验证，再继续操作。');
      // Keep any native draft on the long-lived page intact. Lifecycle actions
      // share its authenticated context, but own only this temporary tab.
      trace.stage = 'open_operation_page';
      operationPage = await context.newPage();
      operationPage.setDefaultTimeout(8_000); operationPage.setDefaultNavigationTimeout(30_000);
      await operationPage.goto(adapter.resumeUrl || adapter.homeUrl, { waitUntil: 'domcontentloaded' });
      trace.stage = 'prepare_operation';
      const result = await adapter[operation](operationPage, input, { ...hooks, beforeSubmit: async () => {
        if (checkpointStarted) fail('PUBLISH_UNCERTAIN', '操作已进入提交阶段，不能重复提交。');
        checkpointStarted = true;
        trace.stage = 'submit_checkpoint';
        await hooks.beforeSubmit();
        submitted = true; trace.submitted = true;
        trace.stage = 'confirm_operation';
      } });
      const timestamp = operation === 'update' ? result?.updatedAt : result?.deletedAt;
      if (!submitted || result?.id !== receipt.id || result?.url !== receipt.url || result?.account?.uid !== receipt.account.uid
        || typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) {
        const error = new PlatformBrowserError('PUBLISH_UNCERTAIN', '平台未返回与原帖一致的操作回执，请先到官网核实结果。');
        error.submitted = true;
        throw error;
      }
      return result;
    } catch (error) {
      // Read the temporary failed page before closing it. Diagnostics never
      // inspect a successful operation or change the original error semantics.
      await operationDiagnostic(operation, trace, error, operationPage || page).catch(() => {});
      if (!submitted) throw error;
      let code = 'PUBLISH_UNCERTAIN', message = '平台操作结果尚未确认，请先在官网核实。';
      try {
        if (typeof error?.code === 'string') code = error.code;
        if (error instanceof Error && typeof error.message === 'string') message = error.message;
      } catch { /* Even hostile error getters cannot discard submission uncertainty. */ }
      const uncertain = new PlatformBrowserError(code, message, { cause: error });
      uncertain.submitted = true;
      throw uncertain;
    } finally {
      await operationPage?.close().catch(() => {});
    }
  }

  return { browserMode: currentChrome ? 'current-chrome' : 'isolated', status: () => serialized(readStatus), login: (options) => serialized(() => login(options)), open: () => serialized(open), refresh: () => serialized(refresh), resume: requestResume, close: () => serialized(close),
    disconnect: () => serialized(disconnect), publish: (input, hooks) => serialized(() => publish(input, hooks)),
    ...(typeof adapter.continuePublication === 'function' ? { continuePublication: (input, options) => serialized(async () => {
      const status = await resume();
      if (!status.connected || status.account.uid !== input.expectedAccountUid) fail('ACCOUNT_CHANGED', '请先连接原发布账号。');
      try { return await adapter.continuePublication(page, input, options); }
      catch (error) { await operationDiagnostic('continue-publication', { stage: 'continue_confirmation', submitted: true }, error).catch(() => {}); throw error; }
    }) } : {}),
    ...(typeof adapter.reconcilePublication === 'function' ? { reconcilePublication: (input, options) => serialized(() => reconcilePublication(input, options)) } : {}),
    ...(typeof adapter.reconcileOperation === 'function' ? { reconcileOperation: (input, options) => serialized(() => reconcileOperation(input, options)) } : {}),
    ...(typeof adapter.inspectComposerDraft === 'function' ? { inspectComposerDraft: input => serialized(() => composerDraft(input)) } : {}),
    ...(typeof adapter.inspectComposerDraft === 'function' && typeof adapter.clearComposerDraft === 'function' ? { clearComposerDraft: input => serialized(() => composerDraft(input, true)) } : {}),
    update: (input, hooks) => serialized(() => mutatePublication('update', input, hooks)), delete: (input, hooks) => serialized(() => mutatePublication('delete', input, hooks)) };
}
