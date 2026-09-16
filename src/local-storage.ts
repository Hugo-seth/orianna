import {
  CONTENT_STORAGE_KEY, SEED_CONTENT, createContentEnvelope, getPublications, isContentDeletionLocked,
  parseContentEnvelope, reconcileContentSnapshots, setContentDeletedIdsReader,
} from './model.ts'
import type { ContentItem, StoredEnvelope } from './model.ts'

export const ASSETS_STORAGE_KEY = 'fatiao-assets'
export type LocalDocumentName = 'content' | 'assets' | 'watermark'
export interface LocalDocument<T> { revision: number; value: T | null }
export interface ContentDocument extends StoredEnvelope { migrationSources?: string[] }
export interface AssetsDocument { images: string[]; migrationSources?: string[] }
const MEDIA_PATTERN = /^\/api\/media\/([a-f0-9]{64})\.(png|jpg|webp|gif)$/
const MIME_EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const MAX_MEDIA_BYTES = 12 * 1024 * 1024
const MAX_CAS_ATTEMPTS = 8
const clone = <T,>(value: T): T => structuredClone(value)
const message = (error: unknown) => error instanceof Error ? error.message : '本地存储操作失败，请重试。'

export class LocalStorageConflictError extends Error {
  constructor() { super('数据已在其他窗口更新，请重试。'); this.name = 'LocalStorageConflictError' }
}
export function isLocalMediaReference(source: string): boolean { return MEDIA_PATTERN.test(source) }

async function checkResponse(response: Response): Promise<Response> {
  if (response.status === 409) throw new LocalStorageConflictError()
  if (!response.ok) {
    let detail = ''
    try {
      const body = await response.json() as { error?: unknown; message?: unknown }
      const nested = body.error && typeof body.error === 'object' && 'message' in body.error ? body.error.message : undefined
      detail = typeof body.message === 'string' ? body.message : typeof nested === 'string' ? nested : typeof body.error === 'string' ? body.error : ''
    } catch { /* Preserve a useful error for non-JSON proxy responses. */ }
    throw new Error(detail || `本地存储服务请求失败（${response.status}），请确认服务正常运行后重试。`)
  }
  return response
}

/** Starts the request immediately, including keepalive writes used while leaving the page. */
export async function requestDocument<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  headers.set('X-Fatiao-Request', '1')
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(30_000), ...options, headers })
  await checkResponse(response)
  return await response.json() as T
}
function validateDocument<T>(document: LocalDocument<T>): LocalDocument<T> {
  if (!document || !Number.isSafeInteger(document.revision) || document.revision < 0 || !('value' in document)) {
    throw new Error('本地数据库返回了无效的数据，原有内容未修改。')
  }
  return document
}
export async function readDocument<T>(name: LocalDocumentName): Promise<LocalDocument<T>> {
  return validateDocument(await requestDocument<LocalDocument<T>>(`/api/local-data/${name}`))
}
export async function writeDocument<T>(name: LocalDocumentName, update: { expectedRevision: number; value: T }, options: { keepalive?: boolean } = {}): Promise<LocalDocument<T>> {
  return validateDocument(await requestDocument<LocalDocument<T>>(`/api/local-data/${name}`, {
    method: 'PUT', body: JSON.stringify(update), keepalive: options.keepalive,
  }))
}
async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
function decodeImage(source: string): { bytes: Uint8Array; mime: string } {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(source)
  if (!match || match[2].length % 4 !== 0) throw new Error('图片数据格式无效，原有内容未修改。')
  if (match[2].length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4) throw new Error('图片超过本地文件存储的 12 MB 限制。')
  const binary = atob(match[2])
  if (binary.length > MAX_MEDIA_BYTES) throw new Error('图片超过本地文件存储的 12 MB 限制。')
  return { mime: match[1], bytes: Uint8Array.from(binary, char => char.charCodeAt(0)) }
}
function isRemoteImage(source: string): boolean {
  try { const url = new URL(source); return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password } catch { return false }
}

/** A successful upload means the server durably stored these exact bytes under their content hash. */
export async function persistImage(source: string): Promise<string> {
  if (!source || isLocalMediaReference(source) || isRemoteImage(source)) return source
  const { bytes, mime } = decodeImage(source)
  const hash = await digest(bytes)
  const expected = `/api/media/${hash}.${MIME_EXTENSIONS[mime]}`
  const response = await requestDocument<{ url: string; id: string; mime: string; size: number }>('/api/media', {
    method: 'POST', headers: { 'Content-Type': mime }, body: bytes,
  })
  if (response.url !== expected || response.mime !== mime || response.size !== bytes.byteLength) {
    throw new Error('保存的图片校验未通过，原有内容未修改。')
  }
  return response.url
}
/** Resolve only canonical local files; never send an arbitrary URL through a media endpoint. */
export async function resolveImage(source: string): Promise<string> {
  const match = MEDIA_PATTERN.exec(source)
  if (!match) return source
  const response = await fetch(source, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000) })
  await checkResponse(response)
  const mime = Object.keys(MIME_EXTENSIONS).find(value => MIME_EXTENSIONS[value] === match[2])!
  if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== mime) throw new Error('本地图片类型校验失败。')
  const contentLength = response.headers.get('Content-Length')
  if (contentLength && Number(contentLength) > MAX_MEDIA_BYTES) throw new Error('本地图片超过 12 MB 限制。')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length > MAX_MEDIA_BYTES || await digest(bytes) !== match[1]) throw new Error('本地图片文件校验失败，请恢复完整备份后重试。')
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  return `data:${mime};base64,${btoa(binary)}`
}

function migrationSources(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(source => typeof source === 'string' && /^[a-f0-9]{64}$/.test(source))) throw new Error('本地数据库迁移记录无效。')
  return [...new Set(value)]
}
function contentDocument(value: unknown): ContentDocument | null {
  if (value === null) return null
  const parsed = parseContentEnvelope(value)
  if (!parsed) throw new Error('草稿数据格式无效，原有内容未修改。')
  const sources = migrationSources((value as ContentDocument).migrationSources)
  return { ...parsed, ...(sources.length ? { migrationSources: sources } : {}) }
}
function assetsDocument(value: unknown): AssetsDocument | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || !Array.isArray((value as AssetsDocument).images) ||
    !(value as AssetsDocument).images.every(image => typeof image === 'string')) throw new Error('素材库数据格式无效，原有内容未修改。')
  const sources = migrationSources((value as AssetsDocument).migrationSources)
  return { images: [...new Set((value as AssetsDocument).images)], ...(sources.length ? { migrationSources: sources } : {}) }
}
function parseLegacyContent(raw: string | null): StoredEnvelope | null {
  if (raw === null) return null
  let parsed: StoredEnvelope | undefined
  try { parsed = parseContentEnvelope(JSON.parse(raw)) } catch { /* Report instead of silently seeding over existing data. */ }
  if (!parsed) throw new Error('浏览器中的旧草稿数据无法读取，迁移已暂停，原有数据完整保留。')
  return parsed
}
function parseLegacyAssets(raw: string | null): string[] | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (Array.isArray(value) && value.every(image => typeof image === 'string')) return value
  } catch { /* Do not discard malformed legacy data. */ }
  throw new Error('浏览器中的旧素材数据无法读取，迁移已暂停，原有数据完整保留。')
}

export interface LegacyStorage { getItem(key: string): string | null; removeItem(key: string): void }
/** Factory keeps repository state isolated for deterministic tests and for the application singleton. */
export function createLocalStorageRepository(options: { storage?: LegacyStorage; installTombstoneReader?: boolean } = {}) {
  let content: LocalDocument<ContentDocument> | undefined
  let assets: LocalDocument<AssetsDocument> | undefined
  let initialization: Promise<void> | undefined
  let initialized = false
  let lastError: string | null = null
  let queue: Promise<unknown> = Promise.resolve()
  const rememberError = (error: unknown) => { lastError = message(error) }
  const install = () => {
    if (options.installTombstoneReader) setContentDeletedIdsReader(() => content?.value?.deletedContentIds ?? [])
  }
  const exclusive = <T,>(action: () => Promise<T>): Promise<T> => {
    const result = queue.then(action, action)
    queue = result.catch(() => undefined)
    return result
  }
  function normalizer() {
    const uploads = new Map<string, Promise<string>>()
    return (image: string): Promise<string> => {
      if (!uploads.has(image)) uploads.set(image, persistImage(image))
      return uploads.get(image)!
    }
  }
  async function normalizeItems(items: ContentItem[], image = normalizer()): Promise<ContentItem[]> {
    const result: ContentItem[] = []
    for (const item of items) result.push({ ...clone(item), image: await image(item.image), images: await Promise.all(item.images.map(image)) })
    return result
  }
  async function readContentDocument(): Promise<LocalDocument<ContentDocument>> {
    const loaded = await readDocument<unknown>('content')
    return { revision: loaded.revision, value: contentDocument(loaded.value) }
  }
  async function readAssetsDocument(): Promise<LocalDocument<AssetsDocument>> {
    const loaded = await readDocument<unknown>('assets')
    return { revision: loaded.revision, value: assetsDocument(loaded.value) }
  }
  async function initialize(): Promise<void> {
    if (initialized) return
    if (initialization) return initialization
    initialization = (async () => {
      const storage = options.storage ?? globalThis.localStorage
      if (!storage) throw new Error('无法读取浏览器中的旧数据，迁移已暂停。')
      const contentRaw = storage.getItem(CONTENT_STORAGE_KEY)
      const assetsRaw = storage.getItem(ASSETS_STORAGE_KEY)
      const legacyContent = parseLegacyContent(contentRaw)
      const legacyAssets = parseLegacyAssets(assetsRaw)
      const contentSource = contentRaw === null ? undefined : await digest(new TextEncoder().encode(contentRaw))
      const assetsSource = assetsRaw === null ? undefined : await digest(new TextEncoder().encode(assetsRaw))
      // Read both first: a failed endpoint must never trigger an unrelated first-use seed write.
      const initial = await Promise.all([readContentDocument(), readAssetsDocument()])
      let latestContent = initial[0]
      let latestAssets = initial[1]
      const image = normalizer()
      let normalizedLegacy: ContentItem[] | undefined
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const current = latestContent.value
        if (current && (!contentSource || current.migrationSources?.includes(contentSource))) break
        let next: ContentDocument
        if (legacyContent) {
          normalizedLegacy ??= await normalizeItems(legacyContent.items, image)
          const deletedIds = new Set([...(current?.deletedContentIds ?? []), ...legacyContent.deletedContentIds])
          if (current?.items.some(item => deletedIds.has(item.id) && isContentDeletionLocked(item))) throw new Error('旧数据与本地数据库的发布记录存在冲突，迁移已暂停，原有数据完整保留。')
          const legacyIds = new Set(normalizedLegacy.map(item => item.id))
          const proposed = [...normalizedLegacy, ...(current?.items ?? []).filter(item => !legacyIds.has(item.id))]
          next = { version: 2, items: reconcileContentSnapshots(proposed, current?.items ?? [], deletedIds), deletedContentIds: [...deletedIds],
            migrationSources: [...new Set([...(current?.migrationSources ?? []), contentSource!])] }
        } else {
          next = { version: 2, items: clone(SEED_CONTENT), deletedContentIds: [] }
        }
        try { latestContent = await writeDocument('content', { expectedRevision: latestContent.revision, value: next }); break }
        catch (error) {
          if (!(error instanceof LocalStorageConflictError) || attempt === MAX_CAS_ATTEMPTS - 1) throw error
          latestContent = await readContentDocument()
        }
      }
      let normalizedAssets: string[] | undefined
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const current = latestAssets.value
        if (current && (!assetsSource || current.migrationSources?.includes(assetsSource))) break
        normalizedAssets ??= await Promise.all((legacyAssets ?? []).map(image))
        const next: AssetsDocument = { images: [...new Set([...(current?.images ?? []), ...normalizedAssets])],
          ...(assetsSource ? { migrationSources: [...new Set([...(current?.migrationSources ?? []), assetsSource])] } : {}) }
        try { latestAssets = await writeDocument('assets', { expectedRevision: latestAssets.revision, value: next }); break }
        catch (error) {
          if (!(error instanceof LocalStorageConflictError) || attempt === MAX_CAS_ATTEMPTS - 1) throw error
          latestAssets = await readAssetsDocument()
        }
      }
      // A fresh read checks the durable documents before releasing either old localStorage entry.
      const verified = await Promise.all([readContentDocument(), readAssetsDocument()])
      if (!verified[0].value || !verified[1].value ||
        (contentSource && !verified[0].value.migrationSources?.includes(contentSource)) ||
        (assetsSource && !verified[1].value.migrationSources?.includes(assetsSource))) throw new Error('本地数据迁移校验失败，浏览器原有数据完整保留。')
      // Another tab may have edited old data while migration was running. Never clear those edits.
      if (storage.getItem(CONTENT_STORAGE_KEY) !== contentRaw || storage.getItem(ASSETS_STORAGE_KEY) !== assetsRaw) {
        throw new Error('迁移期间浏览器中的旧数据发生变化，请重试以保存最新内容；原有数据完整保留。')
      }
      content = verified[0]; assets = verified[1]; install()
      if (contentRaw !== null) storage.removeItem(CONTENT_STORAGE_KEY)
      if (assetsRaw !== null) storage.removeItem(ASSETS_STORAGE_KEY)
      initialized = true
      lastError = null
    })().catch(error => { rememberError(error); throw error }).finally(() => { initialization = undefined })
    return initialization
  }
  async function readStoredContent(): Promise<{ ok: true; items: ContentItem[] | null } | { ok: false }> {
    try {
      await initialize()
      const latest = await readContentDocument()
      if (!latest.value) throw new Error('本地草稿记录丢失，已停止保存以保护当前内容。')
      content = latest; install(); lastError = null
      return { ok: true, items: clone(content.value!.items) }
    } catch (error) { rememberError(error); return { ok: false } }
  }
  async function saveContent(items: ContentItem[]): Promise<boolean> {
    const submitted = clone(items)
    const baselineSnapshot = content ? clone(content) : undefined
    return exclusive(async () => {
      try {
        await initialize()
        const baseline = baselineSnapshot ?? content!
        if (!createContentEnvelope(submitted, baseline.value)) throw new Error('草稿包含过期的发布记录或已删除内容，请刷新后重试。')
        const normalized = await normalizeItems(submitted)
        const baselineIds = new Set((baseline.value?.items ?? []).map(item => item.id))
        const submittedIds = new Set(normalized.map(item => item.id))
        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const latest = await readContentDocument()
          if (!latest.value) throw new Error('本地草稿记录丢失，已停止保存以保护当前内容。')
          const deleted = new Set(latest.value.deletedContentIds)
          if (normalized.some(item => deleted.has(item.id))) throw new Error('部分内容已在其他窗口删除，请刷新后重试。')
          // A version-identical write may deliberately release a rejected pending request/lifecycle.
          // Reconciliation would incorrectly restore that state from the old snapshot.
          let proposed = normalized
          if (latest.revision !== baseline.revision) {
            const previousById = new Map((baseline.value?.items ?? []).map(item => [item.id, item]))
            const releasesOperation = normalized.some(item => {
              const previous = getPublications(previousById.get(item.id))
              const next = getPublications(item)
              return Object.entries(previous).some(([platform, publication]) => {
                const candidate = next[platform as keyof typeof next]
                return !candidate || Boolean(publication?.lifecycle && !candidate.lifecycle)
              })
            })
            if (releasesOperation) throw new Error('发布状态已在其他窗口更新，请刷新后重试以确认操作结果。')
            proposed = [...normalized, ...latest.value.items.filter(item => !baselineIds.has(item.id) && !submittedIds.has(item.id))]
            proposed = reconcileContentSnapshots(proposed, latest.value.items, deleted)
          }
          const envelope = createContentEnvelope(proposed, latest.value)
          if (!envelope) throw new Error('发布记录已更新，请刷新后重试。')
          const next = { ...envelope, ...(latest.value.migrationSources ? { migrationSources: latest.value.migrationSources } : {}) }
          try {
            content = await writeDocument('content', { expectedRevision: latest.revision, value: next })
            install(); lastError = null
            return true
          } catch (error) { if (!(error instanceof LocalStorageConflictError) || attempt === MAX_CAS_ATTEMPTS - 1) throw error }
        }
        throw new LocalStorageConflictError()
      } catch (error) { rememberError(error); return false }
    })
  }
  async function refreshAssets(): Promise<string[]> {
    try {
      await initialize()
      assets = await readAssetsDocument()
      if (!assets.value) throw new Error('本地素材记录丢失，已停止保存以保护当前内容。')
      lastError = null
      return clone(assets.value.images)
    } catch (error) { rememberError(error); throw error }
  }
  async function saveAssets(imagesToAdd: string[]): Promise<string[]> {
    const images = [...imagesToAdd]
    return exclusive(async () => {
      try {
        await initialize()
        const normalized = await Promise.all(images.map(normalizer()))
        for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
          const latest = await readAssetsDocument()
          if (!latest.value) throw new Error('本地素材记录丢失，已停止保存以保护当前内容。')
          const next: AssetsDocument = { ...latest.value, images: [...new Set([...normalized, ...latest.value.images])] }
          try {
            assets = await writeDocument('assets', { expectedRevision: latest.revision, value: next })
            lastError = null
            return clone(assets.value!.images)
          } catch (error) { if (!(error instanceof LocalStorageConflictError) || attempt === MAX_CAS_ATTEMPTS - 1) throw error }
        }
        throw new LocalStorageConflictError()
      } catch (error) { rememberError(error); throw error }
    })
  }
  return { initializeLocalStorage: initialize, readStoredContent, saveContent, refreshAssets, saveAssets,
    loadContent: (): ContentItem[] => clone(content?.value?.items ?? []),
    loadAssets: (): string[] => clone(assets?.value?.images ?? []),
    getLocalStorageError: (): string | null => lastError }
}

const repository = createLocalStorageRepository({ installTombstoneReader: true })
export const { initializeLocalStorage, readStoredContent, saveContent, refreshAssets, saveAssets, loadContent, loadAssets, getLocalStorageError } = repository
