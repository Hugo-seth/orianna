import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MEDIA_ROUTE = /^\/api\/media\/([a-f0-9]{64})\.(png|jpg|webp|gif)$/;
const MIME_BY_EXTENSION = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const EXTENSION_BY_MIME = Object.fromEntries(Object.entries(MIME_BY_EXTENSION).map(([extension, mime]) => [mime, extension]));
const POSITIONS = new Set(['random', 'top-left', 'top-center', 'top-right', 'middle-left', 'center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']);
const PLATFORMS = new Set(['xiaohongshu', 'douyin', 'weibo', 'bilibili']);

class StorageApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new StorageApiError(status, code, message); };
const invalid = message => fail(400, 'INVALID_DOCUMENT', message || '本地数据格式无效，请保留当前内容并重试。');
const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const stringList = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function knownFields(value, fields, nested = []) {
  if (!record(value) || Object.keys(value).some(key => !fields.includes(key)
    || (!nested.includes(key) && value[key] !== null && typeof value[key] === 'object'))) invalid('本地数据包含不支持的字段。');
}
function validateReceiptFields(value) {
  // Receipts recovered from the platform ledger also carry their local content ID.
  // Older browser snapshots preserve that field when merging the recovered receipt.
  knownFields(value, ['platform', 'id', 'url', 'publishedAt', 'account', 'requestId', 'updatedAt', 'deletedAt', 'lastOperation', 'contentId'], ['account', 'lastOperation']);
  if (value.contentId !== undefined && (typeof value.contentId !== 'string' || !value.contentId)) invalid('发布回执的本地内容编号无效。');
  knownFields(value.account, ['uid', 'name']);
  if (value.lastOperation !== undefined) knownFields(value.lastOperation, ['requestId', 'type', 'title', 'body']);
}
function validateContentFields(item) {
  knownFields(item, ['id', 'title', 'body', 'image', 'images', 'platforms', 'status', 'scheduledAt', 'publishedAt', 'updatedAt', 'category', 'views', 'likes', 'weiboReceipt', 'weiboRequestId', 'weiboPublishState', 'publishMode', 'platformPublications'], ['images', 'platforms', 'weiboReceipt', 'platformPublications']);
  if (item.weiboReceipt !== undefined) validateReceiptFields(item.weiboReceipt);
  if (item.platformPublications !== undefined) {
    if (!record(item.platformPublications)) invalid('发布记录格式无效。');
    for (const [platform, publication] of Object.entries(item.platformPublications)) {
      if (!PLATFORMS.has(platform)) invalid('发布平台无效。');
      knownFields(publication, ['requestId', 'state', 'expectedAccountUid', 'receipt', 'recoveredFromReceipt', 'lifecycle'], ['receipt', 'lifecycle']);
      if (publication.receipt !== undefined) validateReceiptFields(publication.receipt);
      if (publication.lifecycle !== undefined) knownFields(publication.lifecycle, ['operation', 'requestId', 'state', 'title', 'body']);
    }
  }
}
function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
  res.end(JSON.stringify(value));
}

async function readBody(req, limit) {
  const advertised = req.headers['content-length'];
  if (advertised !== undefined && (!/^\d+$/.test(advertised) || Number(advertised) > limit)) {
    req.resume();
    fail(413, 'BODY_TOO_LARGE', '保存内容过大，请减少单次上传的内容后重试。');
  }
  const chunks = [];
  let length = 0;
  // Keep draining oversized requests so an error response reaches the caller.
  let oversized = false;
  try {
    for await (const chunk of req) {
      length += chunk.length;
      if (length > limit) { oversized = true; chunks.length = 0; }
      if (!oversized) chunks.push(chunk);
    }
  } catch { fail(400, 'REQUEST_INTERRUPTED', '请求读取失败，请重试保存。'); }
  if (oversized) fail(413, 'BODY_TOO_LARGE', '保存内容过大，请减少单次上传的内容后重试。');
  return Buffer.concat(chunks);
}

function validateImage(bytes, mime) {
  const valid = mime === 'image/png' ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mime === 'image/gif' ? bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
        : mime === 'image/webp' && bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid) fail(400, 'INVALID_IMAGE', '图片内容与文件类型不匹配，请重新上传 PNG、JPG、WebP 或 GIF。');
}

function validateImageReference(value, refs, { empty = false, localOnly = false } = {}) {
  if (typeof value !== 'string') invalid('图片引用无效。');
  if (empty && value === '') return;
  if (MEDIA_ROUTE.test(value)) { refs.add(value); return; }
  if (!localOnly && value.length <= 8192) {
    try {
      const url = new URL(value);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return;
    } catch { /* A source must be a URL or a canonical local media reference. */ }
  }
  invalid('图片必须先保存为本地文件，再保存素材或草稿。');
}

function validateDocument(kind, value) {
  const refs = new Set();
  if (!record(value)) invalid();
  if (value.migrationSources !== undefined && (!stringList(value.migrationSources) || value.migrationSources.length > 100000 || value.migrationSources.some(source => source.length < 1 || source.length > 1024) || new Set(value.migrationSources).size !== value.migrationSources.length)) invalid('旧数据迁移记录无效。');
  if (kind === 'assets') {
    knownFields(value, ['images', 'migrationSources'], ['images', 'migrationSources']);
    if (!stringList(value.images) || value.images.length > 100000) invalid('素材列表格式无效。');
    for (const image of value.images) validateImageReference(image, refs);
  } else if (kind === 'watermark') {
    knownFields(value, ['version', 'settings', 'assetUploadsEnabled', 'migrationSources'], ['settings', 'migrationSources']);
    const settings = value.settings;
    knownFields(settings, ['mode', 'text', 'icon', 'position', 'opacity', 'scale', 'seed']);
    if (value.version !== 1 || typeof value.assetUploadsEnabled !== 'boolean' || !record(settings)
      || !['auto', 'icon'].includes(settings.mode) || typeof settings.text !== 'string' || Array.from(settings.text).length > 40
      || !POSITIONS.has(settings.position) || !Number.isFinite(settings.opacity) || settings.opacity < 0.1 || settings.opacity > 1
      || !Number.isFinite(settings.scale) || settings.scale < 0.05 || settings.scale > 0.6
      || !Number.isSafeInteger(settings.seed) || settings.seed < 0) invalid('水印设置格式无效。');
    validateImageReference(settings.icon, refs, { empty: true, localOnly: true });
  } else {
    knownFields(value, ['version', 'items', 'deletedContentIds', 'migrationSources'], ['items', 'deletedContentIds', 'migrationSources']);
    if (value.version !== 2 || !Array.isArray(value.items) || value.items.length > 100000
      || !stringList(value.deletedContentIds) || value.deletedContentIds.some(id => !id) || new Set(value.deletedContentIds).size !== value.deletedContentIds.length) invalid('草稿列表格式无效。');
    const ids = new Set();
    const deleted = new Set(value.deletedContentIds);
    for (const item of value.items) {
      validateContentFields(item);
      if (!record(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id) || deleted.has(item.id)
        || typeof item.title !== 'string' || typeof item.body !== 'string' || typeof item.category !== 'string'
        || !['draft', 'scheduled', 'published'].includes(item.status) || !timestamp(item.updatedAt)
        || !stringList(item.platforms) || item.platforms.some(platform => !PLATFORMS.has(platform)) || new Set(item.platforms).size !== item.platforms.length
        || !stringList(item.images) || (item.scheduledAt !== undefined && !timestamp(item.scheduledAt)) || (item.publishedAt !== undefined && !timestamp(item.publishedAt))) invalid('草稿内容格式无效。');
      ids.add(item.id);
      validateImageReference(item.image, refs, { empty: true });
      for (const image of item.images) validateImageReference(image, refs);
    }
  }
  // Image validation is limited to the schema's image fields. A caption, title,
  // watermark label or account name remains plain text even if it resembles a URL.
  return refs;
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Storage path is not a directory.');
  await chmod(directory, 0o700);
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Owns only library.sqlite and immutable media files; platform login data is separate. */
export function createLocalStorageHandler({ env = process.env, dataDir = path.resolve('.data') } = {}) {
  const origin = new URL(env.APP_ORIGIN || 'http://localhost:5173');
  if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.username || origin.password) throw new Error('APP_ORIGIN must be a loopback HTTP origin.');
  const mediaDir = path.join(dataDir, 'media');
  const databasePath = path.join(dataDir, 'library.sqlite');
  let database;
  let initializing;
  let closed = false;
  const active = new Set();

  async function getDatabase() {
    if (closed) throw new Error('Local storage is closed.');
    if (database) return database;
    if (!initializing) initializing = (async () => {
      await privateDirectory(dataDir);
      await privateDirectory(mediaDir);
      try {
        const file = await open(databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        await file.close();
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (!(await lstat(databasePath)).isFile()) throw new Error('Database path is not a regular file.');
      await chmod(databasePath, 0o600);
      const db = new DatabaseSync(databasePath);
      try {
        db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
        const version = db.prepare('PRAGMA user_version').get().user_version;
        if (![0, 1].includes(version)) throw new Error('Unsupported library version.');
        if (version === 0 && db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().count !== 0) throw new Error('Unrecognized library schema.');
        if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Damaged library.');
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS documents (kind TEXT PRIMARY KEY CHECK (kind IN ('content', 'assets', 'watermark')), revision INTEGER NOT NULL CHECK (revision > 0), value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, extension TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL CHECK (size > 0));
          PRAGMA user_version = 1;
          COMMIT;`);
        await syncDirectory(dataDir);
        database = db;
        return db;
      } catch (error) { db.close(); throw error; }
    })().catch(error => { initializing = undefined; throw error; });
    return initializing;
  }

  async function readMedia(url, { bytes = false } = {}) {
    const match = MEDIA_ROUTE.exec(url);
    if (!match) fail(404, 'MEDIA_NOT_FOUND', '未找到本地图片。');
    const db = await getDatabase();
    const meta = db.prepare('SELECT * FROM media WHERE id = ?').get(match[1]);
    if (!meta || meta.extension !== match[2] || meta.mime !== MIME_BY_EXTENSION[match[2]]) fail(404, 'MEDIA_NOT_FOUND', '未找到本地图片，请从备份恢复图片目录。');
    let handle;
    try {
      handle = await open(path.join(mediaDir, `${match[1]}.${match[2]}`), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size !== meta.size) throw new Error('Media file changed.');
      const data = bytes ? await handle.readFile() : undefined;
      if (data && createHash('sha256').update(data).digest('hex') !== meta.id) throw new Error('Media hash mismatch.');
      return { ...meta, data };
    } catch (error) {
      if (error.code === 'ENOENT') fail(404, 'MEDIA_NOT_FOUND', '未找到本地图片，请从备份恢复图片目录。');
      throw error;
    } finally { await handle?.close(); }
  }

  async function saveMedia(bytes, mime) {
    validateImage(bytes, mime);
    const db = await getDatabase();
    const id = createHash('sha256').update(bytes).digest('hex');
    const extension = EXTENSION_BY_MIME[mime];
    const name = `${id}.${extension}`;
    const filePath = path.join(mediaDir, name);
    const temporary = path.join(mediaDir, `.${randomUUID()}.tmp`);
    let file;
    try {
      file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await file.writeFile(bytes);
      await file.sync();
      await file.close(); file = undefined;
      // link() atomically installs the completed file without replacing any
      // existing image. This also makes concurrent duplicate uploads harmless.
      try { await link(temporary, filePath); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const existing = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await existing.stat();
        if (!info.isFile() || info.size !== bytes.length || !(await existing.readFile()).equals(bytes)) throw new Error('Existing media is damaged.');
      } finally { await existing.close(); }
      await unlink(temporary);
      await syncDirectory(mediaDir);
      db.prepare('INSERT INTO media (id, extension, mime, size) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING').run(id, extension, mime, bytes.length);
      const stored = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
      if (stored.extension !== extension || stored.mime !== mime || stored.size !== bytes.length) throw new Error('Media metadata mismatch.');
      return { url: `/api/media/${name}`, id, mime, size: bytes.length };
    } finally {
      await file?.close();
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async function validateReferences(kind, value) {
    for (const ref of validateDocument(kind, value)) {
      const media = await readMedia(ref);
      if (kind === 'watermark' && ref === value.settings.icon && (media.size > 1024 * 1024 || media.mime === 'image/gif')) invalid('水印图标应为不超过 1 MB 的 PNG、JPG 或 WebP。');
    }
  }

  async function route(req, res) {
    // Match the raw canonical route; URL normalization must never turn an
    // encoded or traversal path into a different local file or API operation.
    const raw = req.url || '';
    if (!/^\/api\/(?:local-data|media)(?:[/?]|$)/.test(raw)) return false;
    try {
      if (req.headers.host !== origin.host) fail(403, 'FORBIDDEN_HOST', '请求地址无效，请从本地控制台操作。');
      const requestOrigin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      if ((requestOrigin !== undefined && requestOrigin !== origin.origin) || (site !== undefined && !['same-origin', 'none'].includes(site))) fail(403, 'FORBIDDEN_ORIGIN', '请求来源无效，请从本地控制台操作。');
      if (['POST', 'PUT'].includes(req.method) && (requestOrigin !== origin.origin || req.headers['x-fatiao-request'] !== '1')) fail(403, 'FORBIDDEN_ORIGIN', '请求来源无效，请从本地控制台操作。');
      const documentRoute = /^\/api\/local-data\/(content|assets|watermark)$/.exec(raw);
      const mediaRoute = MEDIA_ROUTE.exec(raw);
      if (raw === '/api/media') {
        if (req.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '上传图片只支持 POST。');
        const mime = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
        if (!Object.hasOwn(EXTENSION_BY_MIME, mime || '')) fail(415, 'UNSUPPORTED_MEDIA_TYPE', '请上传 PNG、JPG、WebP 或 GIF 图片。');
        reply(res, 200, await saveMedia(await readBody(req, MAX_IMAGE_BYTES), mime));
      } else if (mediaRoute) {
        if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'METHOD_NOT_ALLOWED', '本地图片只支持读取。');
        const media = await readMedia(raw, { bytes: req.method === 'GET' });
        res.writeHead(200, { 'Content-Type': media.mime, 'Content-Length': media.size, 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', ETag: `"${media.id}"` });
        res.end(media.data);
      } else if (documentRoute) {
        if (!['GET', 'PUT'].includes(req.method)) fail(405, 'METHOD_NOT_ALLOWED', '本地数据只支持读取和保存。');
        const kind = documentRoute[1];
        const db = await getDatabase();
        if (req.method === 'GET') {
          const saved = db.prepare('SELECT revision, value FROM documents WHERE kind = ?').get(kind);
          if (!saved) reply(res, 200, { revision: 0, value: null });
          else {
            let value;
            try { value = JSON.parse(saved.value); await validateReferences(kind, value); }
            catch { throw new Error('Stored document is damaged or references missing media.'); }
            reply(res, 200, { revision: saved.revision, value });
          }
        } else {
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'UNSUPPORTED_MEDIA_TYPE', '保存本地数据需要 JSON 格式。');
          let body;
          try { body = JSON.parse((await readBody(req, MAX_DOCUMENT_BYTES)).toString('utf8')); }
          catch (error) { if (error instanceof StorageApiError) throw error; invalid('保存请求不是有效的 JSON。'); }
          if (!record(body) || Object.keys(body).some(key => !['expectedRevision', 'value'].includes(key)) || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) invalid('保存版本无效，请刷新数据后重试。');
          await validateReferences(kind, body.value);
          db.exec('BEGIN IMMEDIATE');
          try {
            const previous = db.prepare('SELECT revision, value FROM documents WHERE kind = ?').get(kind);
            if (previous) {
              try { validateDocument(kind, JSON.parse(previous.value)); }
              catch { throw new Error('Existing document is damaged; preserve it for recovery.'); }
            }
            const revision = previous?.revision || 0;
            if (revision !== body.expectedRevision) fail(409, 'REVISION_CONFLICT', '本地数据已在其他页面更新，请读取最新内容后重试保存。');
            if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('Revision overflow.');
            db.prepare('INSERT INTO documents (kind, revision, value) VALUES (?, ?, ?) ON CONFLICT(kind) DO UPDATE SET revision = excluded.revision, value = excluded.value').run(kind, revision + 1, JSON.stringify(body.value));
            db.exec('COMMIT');
            reply(res, 200, { revision: revision + 1, value: body.value });
          } catch (error) { db.exec('ROLLBACK'); throw error; }
        }
      } else fail(404, 'NOT_FOUND', '本地存储接口或图片地址不存在。');
    } catch (error) {
      const safe = error instanceof StorageApiError ? error : new StorageApiError(503, 'STORAGE_ERROR', '本地文件或数据库暂时不可用，请保留当前编辑，检查磁盘空间及目录权限后重试。');
      // An early rejection may leave an advertised request body unread. Do not
      // reuse that connection for another API request.
      if (!req.complete && ['POST', 'PUT'].includes(req.method)) res.setHeader('Connection', 'close');
      if (!res.headersSent) reply(res, safe.status, { error: { code: safe.code, message: safe.message } });
      else res.end();
    }
    return true;
  }

  const handler = (req, res) => {
    const operation = route(req, res);
    active.add(operation);
    void operation.finally(() => active.delete(operation));
    return operation;
  };
  handler.close = async () => {
    await Promise.allSettled([...active]);
    closed = true;
    await initializing?.catch(() => {});
    database?.close();
    database = undefined;
  };
  return handler;
}
