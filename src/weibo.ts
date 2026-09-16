import type { ContentItem, WeiboReceipt } from './model';

export interface WeiboAccountState {
  mode: 'browser';
  connected: boolean;
  browserOpen: boolean;
  publishReady: boolean;
  account?: { uid: string; name: string; avatarUrl: string; profileUrl: string };
  message?: string;
}

export class WeiboRequestError extends Error {
  code: string;
  constructor(message: string, code = 'REQUEST_FAILED') { super(message); this.name = 'WeiboRequestError'; this.code = code; }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/weibo/${path}`, { ...options, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Fatiao-Request': '1', ...options?.headers } });
  } catch { throw new WeiboRequestError('无法连接本地服务。请确认使用 npm run dev 启动了完整应用。', 'SERVER_UNAVAILABLE'); }
  let result: unknown;
  try { result = await response.json(); } catch { throw new WeiboRequestError('微博服务未启动。请使用 npm run dev 启动完整应用。', 'SERVER_UNAVAILABLE'); }
  if (!response.ok) {
    const data = result as { error?: string | { code?: string; message?: string }; message?: string; code?: string };
    const detail = typeof data.error === 'object' ? data.error : data;
    throw new WeiboRequestError(detail.message || (typeof data.error === 'string' ? data.error : '微博请求失败，请稍后重试。'), detail.code);
  }
  return result as T;
}

export const getWeiboAccount = () => request<WeiboAccountState>('account');
export const loginWeibo = () => request<WeiboAccountState>('login', { method: 'POST', body: '{}' });
export const refreshWeibo = () => request<WeiboAccountState>('refresh', { method: 'POST', body: '{}' });
export const closeWeibo = () => request<WeiboAccountState>('close', { method: 'POST', body: '{}' });
export const disconnectWeibo = () => request<WeiboAccountState>('disconnect', { method: 'POST', body: '{}' });
export const getWeiboReceipts = () => request<{ receipts: (WeiboReceipt & { contentId: string })[] }>('receipts');

export function composeWeiboStatus(title: string, body: string) {
  return [title.trim(), body.trim()].filter(Boolean).join('\n\n');
}

export function validateWeiboPublish(item: Pick<ContentItem, 'title' | 'body' | 'images' | 'platforms'>): string[] {
  const errors: string[] = [];
  if (item.platforms.length !== 1 || item.platforms[0] !== 'weibo') errors.push('真实发布目前仅支持单独选择微博。');
  if (!composeWeiboStatus(item.title, item.body)) errors.push('请填写标题或正文。');
  if (item.images.length > 4) errors.push('当前控制台每条内容最多添加 4 张图片。');
  return errors;
}

/** Browser fetch avoids turning the local service into an arbitrary URL proxy. */
async function prepareImage(source: string): Promise<string> {
  let blob: Blob;
  if (source.startsWith('data:')) {
    if (!/^data:image\/(jpeg|png|gif|webp);base64,/i.test(source)) throw new WeiboRequestError('请选择 JPG、PNG、GIF 或 WebP 图片。', 'IMAGE_TYPE');
    blob = await (await fetch(source)).blob();
  } else {
    let url: URL;
    try { url = new URL(source); if (!['https:', 'http:'].includes(url.protocol)) throw new Error(); } catch { throw new WeiboRequestError('图片链接无效，请重新上传图片。', 'IMAGE_URL'); }
    try { const response = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(15000) }); if (!response.ok) throw new Error(); blob = await response.blob(); }
    catch { throw new WeiboRequestError('无法读取远程图片，可能是图片网站不允许跨域访问。请下载后从本地上传。', 'IMAGE_FETCH'); }
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(blob.type)) throw new WeiboRequestError('请选择 JPG、PNG、GIF 或 WebP 图片。', 'IMAGE_TYPE');
  }
  if (blob.size > 3 * 1024 * 1024) throw new WeiboRequestError('单张图片超过 3 MB，请压缩后重试。', 'IMAGE_SIZE');
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new WeiboRequestError('图片读取失败，请重新上传。', 'IMAGE_READ')); reader.readAsDataURL(blob); });
}

export async function publishWeibo(item: ContentItem, requestId: string, expectedAccountUid: string): Promise<WeiboReceipt> {
  const images = await Promise.all(item.images.map(prepareImage));
  return request<WeiboReceipt>('publish', { method: 'POST', body: JSON.stringify({ requestId, contentId: item.id, title: item.title, body: item.body, images, expectedAccountUid }) });
}
