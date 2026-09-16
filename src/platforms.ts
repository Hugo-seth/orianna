import type { ContentItem, PlatformId, PlatformPublication, PlatformReceipt } from './model';
import { isLocalMediaReference, resolveImage } from './local-storage.ts';

export interface PlatformAccountState {
  mode: 'browser';
  browserMode?: 'current-chrome' | 'isolated';
  connected: boolean;
  browserOpen: boolean;
  publishReady: boolean;
  account?: { uid: string; name: string; profileUrl: string; avatarUrl?: string };
  accountVerification?: 'required' | 'verified';
  sessionSaved?: boolean;
  headless?: boolean;
  login?: { kind: 'qr' | 'window'; image?: string; expiresAt?: string };
  message?: string;
}

export class PlatformRequestError extends Error {
  code: string;
  submitted?: boolean;
  constructor(message: string, code = 'REQUEST_FAILED', submitted?: boolean) {
    super(message);
    this.name = 'PlatformRequestError';
    this.code = code;
    this.submitted = submitted;
  }
}

const names: Record<PlatformId, string> = { xiaohongshu: '小红书', douyin: '抖音图文', weibo: '微博', bilibili: 'B站动态' };
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

async function request<T>(platform: PlatformId, path: string, options?: RequestInit): Promise<T> {
  return localRequest<T>(`/api/platforms/${platform}/${path}`, options, names[platform], ['resume', 'update', 'delete', 'reconcile', 'composer-draft', 'clear-composer-draft'].includes(path));
}

async function localRequest<T>(url: string, options?: RequestInit, label = '本地服务', versionedRoute = false): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Fatiao-Request': '1', ...options?.headers },
    });
  } catch {
    throw new PlatformRequestError('无法连接本地服务。请确认使用 npm run dev 启动了完整应用。', 'SERVER_UNAVAILABLE');
  }
  let result: unknown;
  try { result = await response.json(); }
  catch { throw new PlatformRequestError('平台服务未启动。请使用 npm run dev 启动完整应用。', 'SERVER_UNAVAILABLE'); }
  if (!response.ok) {
    const data = result && typeof result === 'object' ? result as { error?: string | { code?: string; message?: string; submitted?: boolean }; message?: string; code?: string; submitted?: boolean } : {};
    const detail = data.error && typeof data.error === 'object' ? data.error : data;
    if (versionedRoute && response.status === 404 && detail.code === 'NOT_FOUND') {
      throw new PlatformRequestError('本地服务版本尚未更新，请重启本地服务后重试；本次内容尚未发送。', 'SERVER_RESTART_REQUIRED', false);
    }
    const connectionHelp = detail.code === 'CHROME_CONNECTION_REQUIRED' ? '无法连接当前 Chrome。请先启动 Chrome，在 chrome://inspect/#remote-debugging 开启远程调试，再重试并在 Chrome 弹窗中允许连接。' : undefined;
    throw new PlatformRequestError(detail.message || connectionHelp || (typeof data.error === 'string' ? data.error : `${label}请求失败，请稍后重试。`), detail.code, typeof detail.submitted === 'boolean' ? detail.submitted : undefined);
  }
  return result as T;
}

const post = (platform: PlatformId, path: string, body: object = {}) => request<PlatformAccountState>(platform, path, { method: 'POST', body: JSON.stringify(body) });

export const getPlatformAccount = (platform: PlatformId) => request<PlatformAccountState>(platform, 'account');
export const getPlatformReceipts = (platform: PlatformId) => request<{ receipts: (PlatformReceipt & { contentId: string })[] }>(platform, 'receipts');
export const loginPlatform = (platform: PlatformId, mode: 'qr' | 'window' = 'qr') => post(platform, 'login', { mode });
export const openPlatform = (platform: PlatformId) => post(platform, 'open');
export const refreshPlatform = (platform: PlatformId) => post(platform, 'refresh');
export const resumePlatform = (platform: PlatformId) => post(platform, 'resume');
export const closePlatform = (platform: PlatformId) => post(platform, 'close');
export const disconnectPlatform = (platform: PlatformId) => post(platform, 'disconnect');

/** A retained account identifies the binding, not the current website login. */
export function hasBoundPlatformAccount(state?: PlatformAccountState | null): boolean {
  return Boolean(state?.account?.uid.trim() && (state.connected || state.sessionSaved));
}

/** Shared Chrome snapshots must explicitly confirm the account in an open tab. */
export function isPlatformAccountVerified(state?: PlatformAccountState | null): state is PlatformAccountState & { account: NonNullable<PlatformAccountState['account']> } {
  return Boolean(state?.connected && state.account?.uid.trim() && state.accountVerification !== 'required'
    && (state.browserMode !== 'current-chrome' || state.browserOpen && state.accountVerification === 'verified'));
}

export interface PlatformComposerDraft {
  account: { uid: string; name: string };
  draft: { actualUI: true; title: string; body: string; imageCount: number; fingerprint: string };
}

function validComposerDraft(value: PlatformComposerDraft | undefined, expectedAccountUid: string): value is PlatformComposerDraft {
  return Boolean(value && value.account?.uid === expectedAccountUid && typeof value.account.name === 'string'
    && value.draft?.actualUI === true && typeof value.draft.title === 'string' && typeof value.draft.body === 'string'
    && Number.isSafeInteger(value.draft.imageCount) && value.draft.imageCount >= 0 && typeof value.draft.fingerprint === 'string'
    && /^[a-f\d]{64}$/i.test(value.draft.fingerprint));
}

export async function getPlatformComposerDraft(platform: PlatformId, expectedAccountUid: string): Promise<PlatformComposerDraft> {
  if (!expectedAccountUid?.trim()) throw new PlatformRequestError('请先登录并核对官网编辑器账号。', 'VALIDATION_ERROR', false);
  const result = await request<PlatformComposerDraft>(platform, 'composer-draft', { method: 'POST', body: JSON.stringify({ expectedAccountUid }) });
  if (!validComposerDraft(result, expectedAccountUid)) throw new PlatformRequestError('未能读取与当前账号一致的官网实际草稿，请重新读取。', 'DRAFT_RESPONSE_INVALID', false);
  return result;
}

export async function clearPlatformComposerDraft(platform: PlatformId, expectedAccountUid: string, fingerprint: string): Promise<PlatformComposerDraft & { cleared: true }> {
  if (!expectedAccountUid?.trim() || !/^[a-f\d]{64}$/i.test(fingerprint)) throw new PlatformRequestError('请先重新读取官网草稿，再确认清理。', 'VALIDATION_ERROR', false);
  const result = await request<PlatformComposerDraft & { cleared: true }>(platform, 'clear-composer-draft', { method: 'POST', body: JSON.stringify({ expectedAccountUid, fingerprint }) });
  if (!validComposerDraft(result, expectedAccountUid) || result.cleared !== true || result.draft.title.trim() || result.draft.body.trim() || result.draft.imageCount !== 0) {
    throw new PlatformRequestError('尚未确认官网编辑器已清空，请重新读取实际草稿，不会自动再次清理。', 'DRAFT_CLEAR_UNCONFIRMED', false);
  }
  return result;
}

/** Allow a session recovery attempt; the returned state still needs fresh verification before publishing. */
export function platformResumeBlockReason(platform: PlatformId, state?: PlatformAccountState | null, publication?: PlatformPublication): string {
  const name = names[platform];
  if (publication?.state === 'published' || publication?.receipt) return `${name}已发布，请查看原文。`;
  if (publication && !publication.expectedAccountUid?.trim()) return `这条${name}发布记录缺少原账号信息，请先核对平台上的发布结果。`;
  if (!state) return `正在读取${name}账号状态，请稍候。`;
  const verified = isPlatformAccountVerified(state);
  if (verified && publication?.expectedAccountUid && state.account.uid !== publication.expectedAccountUid) {
    return `${name}当前账号与原发布账号不同，请切回原账号后重试。`;
  }
  if (!verified && (state.login || state.browserOpen)) return state.message || `请先完成${name}登录或验证，再重试。`;
  if (state.sessionSaved && !state.browserOpen) return '';
  if (verified) return '';
  return state.message || (state.browserMode === 'current-chrome' ? `请先连接 Chrome 中的${name}并核对账号。` : `请先登录${name}账号。`);
}

/** Read-only result checks need a freshly connected account with the original UID. */
export function requireConnectedPlatformAccount(platform: PlatformId, state?: PlatformAccountState | null, expectedUid?: string): NonNullable<PlatformAccountState['account']> {
  const name = names[platform];
  if (!isPlatformAccountVerified(state)) {
    throw new PlatformRequestError(state?.message || (state?.browserMode === 'current-chrome' ? `请先连接 Chrome 中的${name}并完成登录或验证。` : `请先完成${name}登录或验证。`), 'LOGIN_REQUIRED', false);
  }
  if (expectedUid !== undefined && state.account.uid !== expectedUid) {
    throw new PlatformRequestError(`${name}当前账号与已确认账号不同，请切回原账号后重试。`, 'ACCOUNT_CHANGED', false);
  }
  return state.account;
}

/** New publishing also requires an available native publisher. */
export function requireReadyPlatformAccount(platform: PlatformId, state?: PlatformAccountState | null, expectedUid?: string): NonNullable<PlatformAccountState['account']> {
  const account = requireConnectedPlatformAccount(platform, state, expectedUid);
  if (!state?.publishReady) {
    throw new PlatformRequestError(state?.message || `${names[platform]}发布页面尚未准备好，请稍后重试或打开专用窗口检查。`, 'PUBLISH_NOT_READY', false);
  }
  return account;
}

export function composePlatformText(title: string, body: string): string {
  return [title.trim(), body.trim()].filter(Boolean).join('\n\n');
}

/** Match the current console API limits, which may be narrower than platform limits. */
export function validatePlatformPublish(platform: PlatformId, item: Pick<ContentItem, 'title' | 'body' | 'images' | 'platforms'>): string[] {
  const errors: string[] = [];
  if (platform === 'bilibili' && item.images.some(image => /^data:image\/webp[;,]/i.test(image))) errors.push('B站动态请使用 JPG、PNG 或 GIF，WebP 请转换后上传。');
  if (!item.platforms.includes(platform)) errors.push(`请先选择${names[platform]}发布平台。`);
  if (!composePlatformText(item.title, item.body)) errors.push('当前控制台发布需填写标题或正文。');
  if (item.title.length > 1000 || item.body.length > 10000) errors.push('标题或正文过长，请缩短内容后重试。');
  if (/\u0000/.test(item.title + item.body)) errors.push('标题或正文包含无效字符，请重新输入。');
  if (item.images.length > 4) errors.push('当前控制台每条内容最多添加 4 张图片。');
  if ((platform === 'xiaohongshu' || platform === 'douyin') && item.images.length === 0) errors.push(`${names[platform]}需要至少一张图片。`);
  if (platform === 'xiaohongshu') {
    if (!item.title.trim()) errors.push('请填写小红书笔记标题。');
    if (Array.from(item.title.trim()).length > 20) errors.push('当前控制台小红书标题最多 20 个字符。');
    if (Array.from(item.body.trim()).length > 1000) errors.push('当前控制台小红书正文最多 1000 个字符。');
  }
  if (platform === 'douyin') {
    if (!item.title.trim()) errors.push('当前控制台抖音图文发布需要填写标题。');
    if (Array.from(item.title.trim()).length > 30) errors.push('当前控制台抖音图文标题最多 30 个字符。');
    if (Array.from(item.body.trim()).length > 1000) errors.push('当前控制台抖音图文正文最多 1000 个字符。');
  }
  if (platform === 'bilibili' && Array.from(composePlatformText(item.title, item.body)).length > 1000) errors.push('当前控制台B站动态标题与正文合计最多 1000 个字符。');
  return errors;
}

function validatePreparedImage(source: string): string {
  if (!source.startsWith('data:')) throw new PlatformRequestError('图片尚未准备完成，请重新检查图片后发布。', 'IMAGE_NOT_PREPARED', false);
  if (source.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64) throw new PlatformRequestError('单张图片超过 3 MB，请压缩后重试。', 'IMAGE_SIZE', false);
  const match = /^data:image\/(jpeg|jpg|png|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(source);
  if (!match) throw new PlatformRequestError('请选择 JPG、PNG、GIF 或 WebP 图片。', 'IMAGE_TYPE', false);
  let bytes: string;
  try {
    bytes = atob(match[2]);
    if (!bytes.length || btoa(bytes) !== match[2]) throw new Error();
  } catch { throw new PlatformRequestError('图片数据无效，请重新上传图片。', 'IMAGE_READ', false); }
  if (bytes.length > MAX_IMAGE_BYTES) throw new PlatformRequestError('单张图片超过 3 MB，请压缩后重试。', 'IMAGE_SIZE', false);
  const mime = match[1].toLowerCase() === 'jpg' ? 'jpeg' : match[1].toLowerCase();
  const valid = mime === 'jpeg' ? bytes.startsWith('\xff\xd8\xff')
    : mime === 'png' ? bytes.startsWith('\x89PNG\r\n\x1a\n')
      : mime === 'gif' ? bytes.startsWith('GIF87a') || bytes.startsWith('GIF89a')
        : bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP';
  if (!valid) throw new PlatformRequestError('图片内容与文件类型不匹配，请重新上传。', 'IMAGE_TYPE', false);
  return `data:image/${mime};base64,${match[2]}`;
}

async function prepareLocalImage(source: string): Promise<string> {
  let resolved: string;
  try { resolved = await resolveImage(source); }
  catch (error) {
    throw new PlatformRequestError(error instanceof Error ? error.message : '无法读取本地图片，请确认素材文件仍然存在。', 'IMAGE_FETCH', false);
  }
  return validatePreparedImage(resolved);
}

async function prepareImage(source: string): Promise<string> {
  if (source.startsWith('data:')) return validatePreparedImage(source);
  if (isLocalMediaReference(source)) return prepareLocalImage(source);
  let url: URL;
  try {
    url = new URL(source);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch { throw new PlatformRequestError('图片链接无效，请重新上传图片。', 'IMAGE_URL', false); }
  let blob: Blob;
  try {
    // Fetch in the browser so the local server never becomes an arbitrary URL proxy.
    const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error();
    blob = await response.blob();
  } catch { throw new PlatformRequestError('无法读取远程图片，可能是图片网站不允许跨域访问。请下载后从本地上传。', 'IMAGE_FETCH', false); }
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(blob.type)) throw new PlatformRequestError('请选择 JPG、PNG、GIF 或 WebP 图片。', 'IMAGE_TYPE', false);
  if (blob.size > MAX_IMAGE_BYTES) throw new PlatformRequestError('单张图片超过 3 MB，请压缩后重试。', 'IMAGE_SIZE', false);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await blob.arrayBuffer()); }
  catch { throw new PlatformRequestError('图片读取失败，请重新上传。', 'IMAGE_READ', false); }
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return validatePreparedImage(`data:${blob.type};base64,${btoa(binary)}`);
}

/** Persist the returned snapshot with its request ID before calling publishPlatform. */
export async function preparePlatformContent(item: ContentItem): Promise<ContentItem> {
  if (item.images.length > 4) throw new PlatformRequestError('当前控制台每条内容最多添加 4 张图片。', 'IMAGE_COUNT', false);
  const images = await Promise.all(item.images.map(prepareImage));
  return { ...item, images, image: images[0] || '' };
}

/** A review must validate actual downloaded formats, not a remote URL's suffix. */
export async function preparePlatformReview(platform: PlatformId, item: ContentItem): Promise<ContentItem> {
  const prepared = await preparePlatformContent(item);
  const errors = validatePlatformPublish(platform, prepared);
  if (errors.length) throw new PlatformRequestError(errors.join(' '), 'VALIDATION_ERROR', false);
  return prepared;
}

/** Publishing only hydrates immutable local references; it never refetches remote media. */
export async function publishPlatform(platform: PlatformId, item: ContentItem, requestId: string, expectedAccountUid: string, options?: { reconcileOnly?: boolean; continueOnly?: boolean }): Promise<PlatformReceipt> {
  const snapshot = { ...item, images: [...item.images], platforms: [...item.platforms] };
  const errors = validatePlatformPublish(platform, snapshot);
  if (errors.length) throw new PlatformRequestError(errors.join(' '), 'VALIDATION_ERROR', false);
  if (!expectedAccountUid.trim()) throw new PlatformRequestError('请刷新连接状态并确认发布账号后重试。', 'ACCOUNT_REQUIRED', false);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId) || !/^[A-Za-z0-9_-]{1,128}$/.test(snapshot.id)) throw new PlatformRequestError('发布请求编号无效，请重新打开草稿。', 'VALIDATION_ERROR', false);
  // Reject every unprepared source before any media request. Local references
  // are bound to their SHA-256 bytes by resolveImage, preserving retry payloads.
  const sources = snapshot.images.map(source => isLocalMediaReference(source) ? source : validatePreparedImage(source));
  const images = await Promise.all(sources.map(source => isLocalMediaReference(source) ? prepareLocalImage(source) : source));
  const preparedErrors = validatePlatformPublish(platform, { ...snapshot, images });
  if (preparedErrors.length) throw new PlatformRequestError(preparedErrors.join(' '), 'VALIDATION_ERROR', false);
  const receipt = await request<PlatformReceipt>(platform, options?.continueOnly ? 'continue-publish' : options?.reconcileOnly ? 'reconcile' : 'publish', {
    method: 'POST',
    body: JSON.stringify({ requestId, contentId: snapshot.id, title: snapshot.title, body: snapshot.body, images, expectedAccountUid, ...(options?.reconcileOnly ? { operation: 'publish' } : {}) }),
  });
  const domains: Record<PlatformId, string> = { xiaohongshu: 'xiaohongshu.com', douyin: 'douyin.com', weibo: 'weibo.com', bilibili: 'bilibili.com' };
  let validUrl = false;
  if (receipt && typeof receipt.url === 'string') {
    try {
      const url = new URL(receipt.url);
      validUrl = url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
        && (url.hostname === domains[platform] || url.hostname.endsWith(`.${domains[platform]}`));
    } catch { /* A malformed success receipt cannot prove publication. */ }
  }
  if (!receipt || receipt.platform !== platform || receipt.requestId !== requestId || receipt.account?.uid !== expectedAccountUid
    || typeof receipt.id !== 'string' || !receipt.id.trim() || typeof receipt.publishedAt !== 'string'
    || !Number.isFinite(Date.parse(receipt.publishedAt)) || !validUrl) {
    throw new PlatformRequestError('服务返回的发布回执与本次内容或账号不符，请到平台核对结果。', 'PUBLISH_UNCERTAIN', true);
  }
  return receipt;
}

export interface PublicationOperation {
  requestId: string;
  type: 'update' | 'delete';
  title?: string;
  body?: string;
}

export interface PublicationOperationResult {
  receipt: PlatformReceipt;
  operation: PublicationOperation;
}

export interface ContentDeletionStatus {
  contentId: string;
  canDelete: boolean;
  pending: boolean;
  publications: { platform: PlatformId; publicationRequestId: string; receipt: PlatformReceipt }[];
}

const validStamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validRequestId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);

function validLifecycleReceipt(receipt: PlatformReceipt | undefined, platform: PlatformId): receipt is PlatformReceipt {
  if (!receipt || receipt.platform !== platform || !validRequestId(receipt.requestId) || !receipt.account?.uid || typeof receipt.account.name !== 'string'
    || !validStamp(receipt.publishedAt) || typeof receipt.id !== 'string') return false;
  try {
    const url = new URL(receipt.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return false;
    if (platform === 'xiaohongshu') return /^[a-f\d]{24}$/i.test(receipt.id) && ['xiaohongshu.com', 'www.xiaohongshu.com'].includes(url.hostname) && [`/explore/${receipt.id}`, `/discovery/item/${receipt.id}`].includes(url.pathname);
    if (!/^\d{1,32}$/.test(receipt.id)) return false;
    if (platform === 'weibo') return ['weibo.com', 'www.weibo.com'].includes(url.hostname) && url.pathname === `/detail/${receipt.id}`;
    if (platform === 'douyin') return ['douyin.com', 'www.douyin.com'].includes(url.hostname) && [`/note/${receipt.id}`, `/video/${receipt.id}`].includes(url.pathname);
    return url.hostname === 't.bilibili.com' && url.pathname === `/${receipt.id}` || ['bilibili.com', 'www.bilibili.com'].includes(url.hostname) && url.pathname === `/opus/${receipt.id}`;
  } catch { return false; }
}

export function validatePlatformUpdate(platform: PlatformId, title: string, body: string): string[] {
  // Text edits keep the website's existing media; no media is fetched or uploaded.
  return validatePlatformPublish(platform, { title, body, platforms: [platform], images: ['existing-platform-image'] });
}

async function mutatePublication(platform: PlatformId, item: ContentItem, publication: PlatformPublication, requestId: string,
  type: PublicationOperation['type'], title?: string, body?: string, options?: { reconcileOnly?: boolean; retryUpdate?: boolean }): Promise<PublicationOperationResult> {
  const original = publication.receipt;
  if (!validRequestId(requestId) || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) || !validLifecycleReceipt(original, platform)
    || publication.requestId !== original.requestId || publication.expectedAccountUid && publication.expectedAccountUid !== original.account.uid) {
    throw new PlatformRequestError('原发布回执或账号信息不完整，已停止操作。', 'VALIDATION_ERROR', false);
  }
  if (original.deletedAt) throw new PlatformRequestError('该平台原文已经删除。', 'PUBLICATION_DELETED', false);
  if (type === 'update') {
    const errors = validatePlatformUpdate(platform, title ?? '', body ?? '');
    if (errors.length) throw new PlatformRequestError(errors.join(' '), 'VALIDATION_ERROR', false);
  }
  const result = await request<PublicationOperationResult>(platform, options?.retryUpdate ? 'retry-update' : options?.reconcileOnly ? 'reconcile' : type, { method: 'POST', body: JSON.stringify({
    requestId, contentId: item.id, publicationRequestId: original.requestId, expectedAccountUid: original.account.uid,
    ...(type === 'update' ? { title: title!.trim(), body: body!.trim() } : {}),
    ...(options?.reconcileOnly ? { operation: type } : {}),
  }) });
  const receipt = result?.receipt;
  if (!validLifecycleReceipt(receipt, platform) || receipt.id !== original.id || receipt.requestId !== original.requestId
    || receipt.account.uid !== original.account.uid || receipt.url !== original.url || result.operation?.requestId !== requestId || result.operation.type !== type
    || !validStamp(type === 'update' ? receipt.updatedAt : receipt.deletedAt)
    || type === 'update' && (receipt.deletedAt || result.operation.title !== title!.trim() || result.operation.body !== body!.trim())) {
    throw new PlatformRequestError('未收到与原文及本次操作一致的确认回执，请保留记录并核对结果。', 'OPERATION_UNCERTAIN', true);
  }
  return result;
}

export const updatePlatformPublication = (platform: PlatformId, item: ContentItem, publication: PlatformPublication, requestId: string, title: string, body: string, options?: { reconcileOnly?: boolean; retryUpdate?: boolean }) =>
  mutatePublication(platform, item, publication, requestId, 'update', title, body, options);

export const deletePlatformPublication = (platform: PlatformId, item: ContentItem, publication: PlatformPublication, requestId: string, options?: { reconcileOnly?: boolean }) =>
  mutatePublication(platform, item, publication, requestId, 'delete', undefined, undefined, options);

export async function getContentDeletionStatus(contentId: string): Promise<ContentDeletionStatus> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(contentId)) throw new PlatformRequestError('内容编号无效，无法核对删除条件。', 'VALIDATION_ERROR', false);
  const result = await localRequest<ContentDeletionStatus>(`/api/content/${encodeURIComponent(contentId)}/deletion-status`, undefined, '删除状态', true);
  if (!result || result.contentId !== contentId || typeof result.canDelete !== 'boolean' || typeof result.pending !== 'boolean'
    || !Array.isArray(result.publications) || result.publications.some(value => !value || !Object.hasOwn(names, value.platform)
      || !validLifecycleReceipt(value.receipt, value.platform) || value.publicationRequestId !== value.receipt.requestId)
    || result.canDelete && (result.pending || result.publications.some(value => !validStamp(value.receipt.deletedAt)))) {
    throw new PlatformRequestError('服务未能确认所有平台原文均已删除，原数据已保留。', 'DELETION_STATUS_INVALID', false);
  }
  return result;
}
