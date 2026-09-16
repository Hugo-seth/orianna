import { DEFAULT_WATERMARK_SETTINGS, WATERMARK_POSITIONS, validateWatermarkImageSource } from './watermark.ts'
import type { WatermarkSettings } from './watermark.ts'
import { LocalStorageConflictError, persistImage, readDocument, resolveImage, writeDocument } from './local-storage.ts'

export const WATERMARK_PREFERENCES_DATABASE = 'fatiao-watermark-preferences'
export const WATERMARK_PREFERENCES_STORE = 'preferences'
export const WATERMARK_PREFERENCES_KEY = 'default'
const DATABASE_TIMEOUT_MS = 10_000
const MAX_ICON_BYTES = 1024 * 1024

export interface WatermarkPreferencesRecord {
  version: 1
  settings: WatermarkSettings
  assetUploadsEnabled: boolean
}

export interface WatermarkPreferencesSnapshot {
  settings: WatermarkSettings
  assetUploadsEnabled: boolean
  ready: boolean
  saving: boolean
  error: string
}

export interface WatermarkPreferencesPersistence {
  read(): Promise<unknown>
  write(record: WatermarkPreferencesRecord): Promise<void>
  /** Optional direct teardown write; never starts an image upload during page exit. */
  flush?(record: WatermarkPreferencesRecord): Promise<void> | undefined
  /** Explicit retries may refresh a revision after another window has saved changes. */
  prepareRetry?(): Promise<void>
  remove?(): Promise<void>
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Accepts unfinished edits, while keeping saved values bounded and safe to render. */
export function parseWatermarkPreferences(value: unknown): WatermarkPreferencesRecord {
  if (!object(value) || value.version !== 1 || typeof value.assetUploadsEnabled !== 'boolean' || !object(value.settings)) {
    throw new Error('本地水印设置格式无效，请重新设置后重试保存。')
  }
  const settings = value.settings
  if (settings.mode !== 'auto' && settings.mode !== 'icon') throw new Error('本地水印类型无效，请重新选择。')
  if (typeof settings.text !== 'string' || Array.from(settings.text).length > 40) throw new Error('水印文字最多 40 个字。')
  if (typeof settings.icon !== 'string') throw new Error('本地水印图标无效，请重新上传。')
  if (settings.icon) validateWatermarkImageSource(settings.icon, MAX_ICON_BYTES)
  if (settings.position !== 'random' && !WATERMARK_POSITIONS.some(position => position.value === settings.position)) {
    throw new Error('本地水印位置无效，请重新选择。')
  }
  if (typeof settings.opacity !== 'number' || !Number.isFinite(settings.opacity) || settings.opacity < 0.1 || settings.opacity > 1) {
    throw new Error('水印透明度应在 10% 至 100% 之间。')
  }
  if (typeof settings.scale !== 'number' || !Number.isFinite(settings.scale) || settings.scale < 0.05 || settings.scale > 0.6) {
    throw new Error('水印大小应在 5% 至 60% 之间。')
  }
  if (typeof settings.seed !== 'number' || !Number.isSafeInteger(settings.seed) || settings.seed < 0) {
    throw new Error('随机位置设置无效，请重新随机一次。')
  }
  return {
    version: 1,
    assetUploadsEnabled: value.assetUploadsEnabled,
    settings: {
      mode: settings.mode, text: settings.text, icon: settings.icon,
      position: settings.position as WatermarkSettings['position'],
      opacity: settings.opacity, scale: settings.scale, seed: settings.seed,
    },
  }
}

function storageError(error: unknown, action: 'read' | 'write'): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : ''
  const prefix = action === 'read' ? '无法读取本地水印设置，已暂用默认设置。' : '水印设置尚未保存到本地，当前设置仍可使用。'
  if (name === 'QuotaExceededError') return `${prefix}存储空间不足，请释放存储空间后重试保存。`
  if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'NotSupportedError') {
    return `${prefix}请允许此网站使用浏览器本地存储后重试保存。`
  }
  const detail = error instanceof Error && error.message ? `${error.message} ` : ''
  return `${prefix}${detail}请重试保存；仍失败时请检查本地服务和磁盘空间。`
}

/** Keeps one connection so a pagehide flush can create its final transaction synchronously. */
export function createIndexedDbWatermarkPreferencesPersistence(): WatermarkPreferencesPersistence {
  let database: IDBDatabase | null = null
  let opening: Promise<IDBDatabase> | null = null

  function open(): Promise<IDBDatabase> {
    if (database) return Promise.resolve(database)
    if (opening) return opening
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest
      let settled = false
      const timer = setTimeout(() => fail(new Error('读取本地存储超时，请关闭此网站的其他标签页后重试。')), DATABASE_TIMEOUT_MS)
      function fail(error: unknown) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
      try {
        if (!globalThis.indexedDB) throw new DOMException('当前浏览器不支持本地数据库。', 'NotSupportedError')
        request = globalThis.indexedDB.open(WATERMARK_PREFERENCES_DATABASE, 1)
      } catch (error) { fail(error); return }
      request.onblocked = () => fail(new Error('本地存储被其他标签页占用，请关闭此网站的其他标签页后重试。'))
      request.onerror = () => fail(request.error ?? new Error('无法打开本地存储。'))
      request.onupgradeneeded = () => {
        if (settled) { request.transaction?.abort(); return }
        if (!request.result.objectStoreNames.contains(WATERMARK_PREFERENCES_STORE)) request.result.createObjectStore(WATERMARK_PREFERENCES_STORE)
      }
      request.onsuccess = () => {
        if (settled) { request.result.close(); return }
        settled = true
        clearTimeout(timer)
        const connected = request.result
        database = connected
        const disconnected = () => {
          if (database === connected) { database = null; opening = null }
        }
        connected.onversionchange = () => { connected.close(); disconnected() }
        connected.onclose = disconnected
        resolve(connected)
      }
    }).finally(() => { opening = null })
    return opening
  }

  function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction
      let result: T
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { tx.abort() } catch { /* Transaction may already have completed. */ }
        reject(new Error('本地水印设置保存或读取超时，请重试。'))
      }, DATABASE_TIMEOUT_MS)
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
      try {
        if (mode === 'readwrite') {
          try { tx = db.transaction(WATERMARK_PREFERENCES_STORE, mode, { durability: 'strict' }) }
          catch (error) {
            // Older browsers may not accept transaction options.
            if (!(error instanceof TypeError)) throw error
            tx = db.transaction(WATERMARK_PREFERENCES_STORE, mode)
          }
        } else tx = db.transaction(WATERMARK_PREFERENCES_STORE, mode)
        tx.oncomplete = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(result) } }
        tx.onabort = () => fail(tx.error ?? new Error('本地存储操作已中断。'))
        tx.onerror = () => fail(tx.error ?? new Error('本地存储操作失败。'))
        const request = operation(tx.objectStore(WATERMARK_PREFERENCES_STORE))
        request.onsuccess = () => { result = request.result }
        request.onerror = () => fail(request.error ?? new Error('本地存储操作失败。'))
        // Do not wait for request event dispatch and automatic commit: the user may
        // reload immediately after this edit. Completion still confirms durability.
        if (mode === 'readwrite' && typeof tx.commit === 'function') tx.commit()
      } catch (error) {
        try { tx!.abort() } catch { /* No active transaction to abort. */ }
        fail(error)
      }
    })
  }

  return {
    read: () => open().then(db => transaction(db, 'readonly', store => store.get(WATERMARK_PREFERENCES_KEY))),
    write: record => {
      const value = parseWatermarkPreferences(record)
      const write = (db: IDBDatabase) => transaction(db, 'readwrite', store => store.put(value, WATERMARK_PREFERENCES_KEY)).then(() => undefined)
      return database ? write(database) : open().then(write)
    },
    remove: () => open().then(db => transaction(db, 'readwrite', store => store.delete(WATERMARK_PREFERENCES_KEY))).then(() => undefined),
  }
}

type WatermarkDocument = { revision: number; value: WatermarkPreferencesRecord | null }
export interface ServerWatermarkPreferencesDependencies {
  readDocument(): Promise<WatermarkDocument>
  writeDocument(value: WatermarkPreferencesRecord, expectedRevision: number, options: { keepalive: boolean }): Promise<WatermarkDocument>
  persistImage(source: string): Promise<string>
  resolveImage(source: string): Promise<string>
  isConflict(error: unknown): boolean
  legacy: WatermarkPreferencesPersistence
}

const MEDIA_REFERENCE = /^\/api\/media\/[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/
function sameRecord(left: unknown, right: unknown): boolean {
  if (!object(left) || !object(right) || !object(left.settings) || !object(right.settings)) return left === right
  const leftSettings = left.settings
  const rightSettings = right.settings
  return left.version === right.version && left.assetUploadsEnabled === right.assetUploadsEnabled
    && ['mode', 'text', 'icon', 'position', 'opacity', 'scale', 'seed'].every(key => leftSettings[key] === rightSettings[key])
}

function defaultServerDependencies(): ServerWatermarkPreferencesDependencies {
  return {
    readDocument: () => readDocument<WatermarkPreferencesRecord>('watermark'),
    writeDocument: (value, expectedRevision, options) => writeDocument('watermark', { expectedRevision, value }, options),
    persistImage,
    resolveImage,
    isConflict: error => error instanceof LocalStorageConflictError,
    legacy: createIndexedDbWatermarkPreferencesPersistence(),
  }
}

/** SQLite stores the settings and a disk reference; the renderer continues receiving exact icon bytes. */
export function createServerWatermarkPreferencesPersistence(dependencies: ServerWatermarkPreferencesDependencies = defaultServerDependencies()): WatermarkPreferencesPersistence {
  let revision: number | null = null
  let conflict = false
  let sequence = 0
  const icons = new Map<string, string>()
  const uploading = new Map<string, Promise<string>>()
  const issued: { sequence: number; expectedRevision: number; value: WatermarkPreferencesRecord }[] = []
  const conflictError = () => new Error('其他窗口已更新水印设置。重新保存会使用当前设置，请确认当前设置后点击“重新保存”。')

  function accept(document: WatermarkDocument) {
    if (revision === null || document.revision > revision) revision = document.revision
  }
  async function hydrate(value: WatermarkPreferencesRecord): Promise<WatermarkPreferencesRecord> {
    if (!object(value) || !object(value.settings) || typeof value.settings.icon !== 'string') return parseWatermarkPreferences(value)
    const reference = value.settings.icon
    if (reference && !MEDIA_REFERENCE.test(reference)) throw new Error('本地水印图标文件引用无效。')
    const icon = reference ? await dependencies.resolveImage(reference) : ''
    const parsed = parseWatermarkPreferences({ ...value, settings: { ...value.settings, icon } })
    if (reference) icons.set(icon, reference)
    return parsed
  }
  function readyRecord(value: WatermarkPreferencesRecord): WatermarkPreferencesRecord | undefined {
    const parsed = parseWatermarkPreferences(value)
    if (!parsed.settings.icon) return parsed
    const icon = icons.get(parsed.settings.icon)
    return icon ? { ...parsed, settings: { ...parsed.settings, icon } } : undefined
  }
  async function prepare(value: WatermarkPreferencesRecord): Promise<WatermarkPreferencesRecord> {
    const parsed = parseWatermarkPreferences(value)
    const ready = readyRecord(parsed)
    if (ready) return ready
    const source = parsed.settings.icon
    let upload = uploading.get(source)
    if (!upload) {
      upload = dependencies.persistImage(source).then(reference => {
        if (!MEDIA_REFERENCE.test(reference)) throw new Error('本地服务返回了无效的水印图标文件引用。')
        icons.set(source, reference)
        return reference
      }).finally(() => uploading.delete(source))
      uploading.set(source, upload)
    }
    return { ...parsed, settings: { ...parsed.settings, icon: await upload } }
  }

  async function send(value: WatermarkPreferencesRecord, order: number, retries = 0): Promise<void> {
    if (revision === null) throw new Error('尚未成功读取本地水印设置，请重试保存。')
    if (conflict) throw conflictError()
    const expectedRevision = revision
    issued.push({ sequence: order, expectedRevision, value })
    if (issued.length > 64) issued.shift()
    try {
      // Metadata remains small after icons have been uploaded, so an immediate reload
      // can finish the request without keeping large image bytes in the browser.
      const saved = await dependencies.writeDocument(value, expectedRevision, { keepalive: true })
      if (!sameRecord(saved.value, value)) throw new Error('本地服务未确认水印设置已完整保存。')
      accept(saved)
    } catch (error) {
      if (!dependencies.isConflict(error)) throw error
      const current = await dependencies.readDocument()
      accept(current)
      if (sameRecord(current.value, value)) return
      // A page-exit flush may race this store's earlier request. Only retry over a
      // payload/revision that we ourselves issued, never an unrelated window's save.
      const own = [...issued].reverse().find(job => job.expectedRevision + 1 === current.revision && sameRecord(job.value, current.value))
      if (own && own.sequence > order) return
      if (own && own.sequence < order && retries < 2) return send(value, order, retries + 1)
      conflict = true
      throw conflictError()
    }
  }

  return {
    read: async () => {
      const current = await dependencies.readDocument()
      accept(current)
      if (current.value !== null) return hydrate(current.value)
      const legacy = await dependencies.legacy.read()
      if (legacy === undefined) return undefined
      const original = parseWatermarkPreferences(legacy)
      const persisted = await prepare(original)
      try {
        await dependencies.writeDocument(persisted, current.revision, { keepalive: true })
      } catch (error) {
        if (!dependencies.isConflict(error)) throw error
        // Another tab may have completed migration first. Its committed version wins.
        const winner = await dependencies.readDocument()
        accept(winner)
        if (winner.value === null) throw error
        return hydrate(winner.value)
      }
      const verified = await dependencies.readDocument()
      accept(verified)
      if (verified.value === null) throw new Error('水印设置迁移尚未完成，旧数据已保留。')
      const restored = await hydrate(verified.value)
      if (sameRecord(restored, original)) {
        // Only release old icon bytes after a read-back verifies the complete record.
        // A cleanup failure leaves a safe copy; it never invalidates the committed data.
        await dependencies.legacy.remove?.().catch(() => undefined)
      }
      return restored
    },
    write: value => {
      const order = ++sequence
      const ready = readyRecord(value)
      return ready ? send(ready, order) : prepare(value).then(prepared => send(prepared, order))
    },
    flush: value => {
      const ready = readyRecord(value)
      return ready ? send(ready, ++sequence) : undefined
    },
    prepareRetry: async () => {
      const current = await dependencies.readDocument()
      accept(current)
      conflict = false
    },
  }
}

type PendingSave = { record: WatermarkPreferencesRecord; attempt: number }

/** An external store makes edits synchronous and lets pending saves survive editor unmounts. */
export function createWatermarkPreferencesStore(persistence: WatermarkPreferencesPersistence = createServerWatermarkPreferencesPersistence()) {
  let snapshot: WatermarkPreferencesSnapshot = freeze({ settings: { ...DEFAULT_WATERMARK_SETTINGS }, assetUploadsEnabled: false, ready: false, saving: false, error: '' })
  const listeners = new Set<() => void>()
  let loadPromise: Promise<void> | null = null
  let edited = false
  let pending: PendingSave | null = null
  let writing = false
  let latestAttempt = 0
  let latestJob: PendingSave | null = null
  let flushedAttempt = 0

  function freeze(value: WatermarkPreferencesSnapshot): WatermarkPreferencesSnapshot {
    Object.freeze(value.settings)
    return Object.freeze(value)
  }
  function publish(next: WatermarkPreferencesSnapshot) {
    snapshot = freeze(next)
    listeners.forEach(listener => listener())
  }
  function record(): WatermarkPreferencesRecord {
    return { version: 1, settings: { ...snapshot.settings }, assetUploadsEnabled: snapshot.assetUploadsEnabled }
  }
  async function save(job: PendingSave, operation?: Promise<void>) {
    try {
      await (operation ?? persistence.write(job.record))
      if (job.attempt === latestAttempt) publish({ ...snapshot, saving: false, error: '' })
    } catch (error) {
      if (job.attempt === latestAttempt) publish({ ...snapshot, saving: false, error: storageError(error, 'write') })
    }
  }
  async function runQueue() {
    if (writing) return
    writing = true
    while (pending) {
      const job = pending
      pending = null
      await save(job)
    }
    writing = false
  }
  function requestSave() {
    if (!snapshot.ready) return
    pending = { record: record(), attempt: ++latestAttempt }
    latestJob = pending
    publish({ ...snapshot, saving: true, error: '' })
    void runQueue()
  }
  function change(next: WatermarkPreferencesRecord) {
    let parsed: WatermarkPreferencesRecord
    try { parsed = parseWatermarkPreferences(next) }
    catch (error) { publish({ ...snapshot, error: storageError(error, 'write') }); return }
    const unchanged = parsed.assetUploadsEnabled === snapshot.assetUploadsEnabled && Object.keys(parsed.settings).every(key => {
      const field = key as keyof WatermarkSettings
      return parsed.settings[field] === snapshot.settings[field]
    })
    if (unchanged) return
    edited = true
    publish({ ...snapshot, settings: parsed.settings, assetUploadsEnabled: parsed.assetUploadsEnabled })
    requestSave()
  }
  function load(): Promise<void> {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      try {
        const saved = await persistence.read()
        const loaded = saved === undefined ? null : parseWatermarkPreferences(saved)
        if (!edited && loaded) {
          // Replace only the retired built-in text; keep custom text and all other settings.
          const legacyDefault = loaded.settings.text === '林间日常'
          const settings = legacyDefault ? { ...loaded.settings, text: DEFAULT_WATERMARK_SETTINGS.text } : loaded.settings
          if (legacyDefault) edited = true
          publish({ ...snapshot, settings, assetUploadsEnabled: loaded.assetUploadsEnabled })
        }
      } catch (error) {
        publish({ ...snapshot, error: storageError(error, 'read') })
      } finally {
        publish({ ...snapshot, ready: true })
        if (edited) requestSave()
      }
    })()
    return loadPromise
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    load,
    updateSettings: (settings: WatermarkSettings) => change({ ...record(), settings }),
    setAssetUploadsEnabled: (assetUploadsEnabled: boolean) => change({ ...record(), assetUploadsEnabled }),
    replacePreferences: async (value: WatermarkPreferencesRecord): Promise<void> => {
      const parsed = parseWatermarkPreferences(value)
      await load()
      if (snapshot.error) await persistence.prepareRetry?.()
      edited = true
      publish({ ...snapshot, settings: parsed.settings, assetUploadsEnabled: parsed.assetUploadsEnabled })
      requestSave()
      await new Promise<void>((resolve, reject) => {
        const settled = () => {
          if (snapshot.saving) return
          listeners.delete(settled)
          if (snapshot.error) reject(new Error(snapshot.error))
          else resolve()
        }
        listeners.add(settled)
        settled()
      })
    },
    retrySave: () => {
      if (!persistence.prepareRetry) { requestSave(); return }
      void persistence.prepareRetry().then(requestSave, error => publish({ ...snapshot, saving: false, error: storageError(error, 'write') }))
    },
    flushPending: () => {
      if (!snapshot.saving || !latestJob || flushedAttempt === latestAttempt) return
      if (persistence.flush) {
        const operation = persistence.flush((pending ?? latestJob).record)
        // An icon upload is still running. Keep the unsaved state and its queued job.
        if (!operation) return
        const job = { record: (pending ?? latestJob).record, attempt: ++latestAttempt }
        pending = null
        latestJob = job
        flushedAttempt = job.attempt
        void save(job, operation)
        return
      }
      // An in-flight put can also be lost before its completion event on navigation.
      // Issue the current snapshot again; older completions cannot change its status.
      const job = pending ?? { record: latestJob.record, attempt: ++latestAttempt }
      pending = null
      latestJob = job
      flushedAttempt = job.attempt
      void save(job)
    },
  }
}
