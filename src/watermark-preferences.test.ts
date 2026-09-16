import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_WATERMARK_SETTINGS } from './watermark.ts'
import { createServerWatermarkPreferencesPersistence, createWatermarkPreferencesStore, parseWatermarkPreferences } from './watermark-preferences.ts'
import type { ServerWatermarkPreferencesDependencies, WatermarkPreferencesPersistence, WatermarkPreferencesRecord } from './watermark-preferences.ts'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZXkAAAAASUVORK5CYII='
const record = (changes: Partial<WatermarkPreferencesRecord['settings']> = {}): WatermarkPreferencesRecord => ({ version: 1, settings: { ...DEFAULT_WATERMARK_SETTINGS, ...changes }, assetUploadsEnabled: false })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure })
  return { promise, resolve, reject }
}
function fixture() {
  const reading = deferred<unknown>()
  const writes: { value: WatermarkPreferencesRecord; completion: ReturnType<typeof deferred<void>> }[] = []
  const persistence: WatermarkPreferencesPersistence = {
    read: () => reading.promise,
    write: value => {
      const completion = deferred<void>()
      writes.push({ value, completion })
      return completion.promise
    },
  }
  return { store: createWatermarkPreferencesStore(persistence), reading, writes }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

test('remembered settings allow unfinished edits and retain inactive icon data', () => {
  for (const changes of [{ text: '' }, { text: '   ' }, { mode: 'icon' as const, icon: '' }, { mode: 'auto' as const, icon: png, text: '🐱'.repeat(40) }]) {
    assert.deepEqual(parseWatermarkPreferences(record(changes)), record(changes))
  }
  const saved = record({ icon: png, position: 'random', opacity: 0.1, scale: 0.6, seed: Number.MAX_SAFE_INTEGER })
  saved.assetUploadsEnabled = true
  assert.deepEqual(parseWatermarkPreferences(saved), saved)
  assert.notEqual(parseWatermarkPreferences(saved).settings, saved.settings)
})

test('corrupt records, invalid ranges and unsupported icons are rejected in either mode', () => {
  for (const value of [null, [], {}, { ...record(), version: 2 }, { ...record(), assetUploadsEnabled: 'true' }]) {
    assert.throws(() => parseWatermarkPreferences(value), /格式无效/)
  }
  for (const changes of [
    { mode: 'unknown' }, { position: 'unknown' }, { text: 'a'.repeat(41) }, { text: 3 },
    { opacity: NaN }, { opacity: Infinity }, { opacity: 0.099 }, { opacity: 1.001 },
    { scale: 0.049 }, { scale: 0.601 }, { seed: -1 }, { seed: 1.5 }, { seed: Number.MAX_SAFE_INTEGER + 1 },
    { icon: 4 }, { icon: 'https://example.com/icon.png' }, { icon: 'data:image/svg+xml;base64,PHN2Zz4=' },
  ]) assert.throws(() => parseWatermarkPreferences({ ...record(), settings: { ...record().settings, ...changes } }))
  const largeIcon = `data:image/png;base64,${Buffer.alloc(1024 * 1024 + 1).toString('base64')}`
  assert.throws(() => parseWatermarkPreferences(record({ mode: 'auto', icon: largeIcon })), /1 MB/)
  assert.throws(() => parseWatermarkPreferences(record({ mode: 'icon', icon: largeIcon })), /1 MB/)
})

test('missing preferences load defaults without writing and repeated loads share the operation', async () => {
  const { store, reading, writes } = fixture()
  assert.equal(store.getSnapshot().ready, false)
  const load = store.load()
  assert.equal(store.load(), load)
  reading.resolve(undefined)
  await load
  assert.deepEqual(store.getSnapshot(), { settings: DEFAULT_WATERMARK_SETTINGS, assetUploadsEnabled: false, ready: true, saving: false, error: '' })
  assert.equal(writes.length, 0)
  store.updateSettings({ ...DEFAULT_WATERMARK_SETTINGS })
  store.setAssetUploadsEnabled(false)
  assert.equal(writes.length, 0)
})

test('stored icon and settings load together without emitting any automatic save', async () => {
  const { store, reading, writes } = fixture()
  const saved = { ...record({ mode: 'icon', icon: png, opacity: 0.43, seed: 42 }), assetUploadsEnabled: true }
  const loading = store.load()
  reading.resolve(saved)
  await loading
  assert.deepEqual(store.getSnapshot().settings, saved.settings)
  assert.equal(store.getSnapshot().assetUploadsEnabled, true)
  assert.equal(store.getSnapshot().error, '')
  assert.equal(writes.length, 0)
  saved.settings.icon = ''
  assert.equal(store.getSnapshot().settings.icon, png)
})

test('loading retired default text saves the replacement and preserves all other preferences', async () => {
  const { store, reading, writes } = fixture()
  const saved = { ...record({ text: '林间日常', mode: 'icon', icon: png, position: 'random', opacity: 0.43, scale: 0.31, seed: 42 }), assetUploadsEnabled: true }
  const expected = { ...saved, settings: { ...saved.settings, text: DEFAULT_WATERMARK_SETTINGS.text } }
  reading.resolve(saved)
  await store.load()
  assert.deepEqual(store.getSnapshot().settings, expected.settings)
  assert.equal(store.getSnapshot().assetUploadsEnabled, true)
  assert.equal(store.getSnapshot().saving, true)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].value, expected)
  assert.equal(saved.settings.text, '林间日常')
  writes[0].completion.resolve()
  await settle()
  assert.equal(store.getSnapshot().saving, false)

  const reloaded = fixture()
  reloaded.reading.resolve(writes[0].value)
  await reloaded.store.load()
  assert.deepEqual(reloaded.store.getSnapshot().settings, expected.settings)
  assert.equal(reloaded.writes.length, 0)
})

test('loading custom watermark text does not change or save it', async () => {
  for (const text of ['我的摄影作品', '林间日常摄影', ' 林间日常 ', '']) {
    const { store, reading, writes } = fixture()
    const saved = record({ text })
    reading.resolve(saved)
    await store.load()
    assert.deepEqual(store.getSnapshot().settings, saved.settings)
    assert.equal(writes.length, 0)
  }
})

test('retired default migration failures keep the replacement usable and retry the queued preferences', async () => {
  const { store, reading, writes } = fixture()
  reading.resolve(record({ text: '林间日常' }))
  await store.load()
  writes[0].completion.reject(new Error('保存失败'))
  await settle()
  assert.equal(store.getSnapshot().settings.text, DEFAULT_WATERMARK_SETTINGS.text)
  assert.match(store.getSnapshot().error, /尚未保存/)
  store.retrySave()
  assert.equal(writes.length, 2)
  assert.equal(writes[1].value.settings.text, DEFAULT_WATERMARK_SETTINGS.text)
  writes[1].completion.resolve()
  await settle()
  assert.equal(store.getSnapshot().error, '')
  assert.equal(store.getSnapshot().saving, false)
})

test('rapid edits serialize and coalesce to the newest complete record', async () => {
  const { store, reading, writes } = fixture()
  reading.resolve(undefined)
  await store.load()
  store.updateSettings({ ...DEFAULT_WATERMARK_SETTINGS, icon: png, mode: 'icon' })
  assert.equal(writes.length, 1)
  assert.equal(store.getSnapshot().saving, true)
  store.updateSettings({ ...store.getSnapshot().settings, opacity: 0.5 })
  store.updateSettings({ ...store.getSnapshot().settings, scale: 0.33 })
  store.setAssetUploadsEnabled(true)
  assert.equal(writes.length, 1)
  writes[0].completion.resolve()
  await settle()
  assert.equal(writes.length, 2)
  assert.deepEqual(writes[1].value, { version: 1, settings: store.getSnapshot().settings, assetUploadsEnabled: true })
  assert.equal(store.getSnapshot().saving, true)
  assert.equal(writes[0].value.settings.opacity, DEFAULT_WATERMARK_SETTINGS.opacity)
  writes[1].completion.resolve()
  await settle()
  assert.equal(store.getSnapshot().saving, false)
  assert.equal(store.getSnapshot().error, '')
})

test('a late read cannot replace newer edits and saves after becoming ready', async () => {
  const { store, reading, writes } = fixture()
  const loading = store.load()
  store.updateSettings({ ...DEFAULT_WATERMARK_SETTINGS, text: '新的文字' })
  store.setAssetUploadsEnabled(true)
  assert.equal(writes.length, 0)
  reading.resolve(record({ text: '旧的文字' }))
  await loading
  assert.equal(store.getSnapshot().settings.text, '新的文字')
  assert.equal(store.getSnapshot().assetUploadsEnabled, true)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].value.settings.text, '新的文字')
  writes[0].completion.resolve()
  await settle()
})

test('load failure leaves defaults usable and writes only after explicit retry', async () => {
  for (const failure of [new DOMException('disabled', 'SecurityError'), new Error('本地存储被其他标签页占用')]) {
    const { store, reading, writes } = fixture()
    const loading = store.load()
    reading.reject(failure)
    await loading
    assert.equal(store.getSnapshot().ready, true)
    assert.match(store.getSnapshot().error, /无法读取.*重试保存/)
    assert.equal(writes.length, 0)
    store.retrySave()
    assert.equal(writes.length, 1)
    writes[0].completion.resolve()
    await settle()
    assert.equal(store.getSnapshot().error, '')
  }
})

test('corrupt saved records are reported without overwriting the original record', async () => {
  const { store, reading, writes } = fixture()
  reading.resolve({ ...record(), settings: { ...record().settings, opacity: 5 } })
  await store.load()
  assert.equal(store.getSnapshot().ready, true)
  assert.deepEqual(store.getSnapshot().settings, DEFAULT_WATERMARK_SETTINGS)
  assert.match(store.getSnapshot().error, /无法读取.*透明度/)
  assert.equal(writes.length, 0)
})

test('failed save keeps current icon/settings in memory and retry saves the latest snapshot', async () => {
  const { store, reading, writes } = fixture()
  reading.resolve(undefined)
  await store.load()
  store.updateSettings({ ...DEFAULT_WATERMARK_SETTINGS, mode: 'icon', icon: png })
  writes[0].completion.reject(new DOMException('quota', 'QuotaExceededError'))
  await settle()
  assert.equal(store.getSnapshot().settings.icon, png)
  assert.equal(store.getSnapshot().saving, false)
  assert.match(store.getSnapshot().error, /尚未保存.*空间不足/)
  store.retrySave()
  assert.equal(writes.length, 2)
  assert.deepEqual(writes[1].value.settings, store.getSnapshot().settings)
  writes[1].completion.resolve()
  await settle()
  assert.equal(store.getSnapshot().error, '')
})

test('failed obsolete writes do not stop newer settings from saving', async () => {
  const { store, reading, writes } = fixture()
  reading.resolve(undefined)
  await store.load()
  store.updateSettings({ ...DEFAULT_WATERMARK_SETTINGS, text: 'first' })
  store.updateSettings({ ...DEFAULT_WATERMARK_SETTINGS, text: 'latest' })
  writes[0].completion.reject(new Error('older write failed'))
  await settle()
  assert.equal(writes.length, 2)
  assert.equal(writes[1].value.settings.text, 'latest')
  assert.equal(store.getSnapshot().saving, true)
  assert.equal(store.getSnapshot().error, '')
  writes[1].completion.resolve()
  await settle()
  assert.equal(store.getSnapshot().saving, false)
})

test('pagehide flush creates the newest write immediately and ignores stale completions', async () => {
  const { store, reading, writes } = fixture()
  reading.resolve(undefined)
  await store.load()
  store.updateSettings({ ...DEFAULT_WATERMARK_SETTINGS, text: 'first' })
  store.updateSettings({ ...DEFAULT_WATERMARK_SETTINGS, text: 'before reload', icon: png })
  store.setAssetUploadsEnabled(true)
  store.flushPending()
  assert.equal(writes.length, 2)
  assert.equal(writes[1].value.settings.text, 'before reload')
  assert.equal(writes[1].value.settings.icon, png)
  assert.equal(writes[1].value.assetUploadsEnabled, true)
  store.flushPending()
  assert.equal(writes.length, 2)
  writes[1].completion.resolve()
  await settle()
  assert.equal(store.getSnapshot().saving, false)
  writes[0].completion.reject(new Error('stale completion'))
  await settle()
  assert.equal(store.getSnapshot().error, '')
  assert.equal(writes.length, 2)
})

test('updates after a flush remain newer than the flushed record', async () => {
  const { store, reading, writes } = fixture()
  reading.resolve(undefined)
  await store.load()
  store.updateSettings({ ...DEFAULT_WATERMARK_SETTINGS, text: 'first' })
  store.updateSettings({ ...DEFAULT_WATERMARK_SETTINGS, text: 'flush' })
  store.flushPending()
  store.updateSettings({ ...DEFAULT_WATERMARK_SETTINGS, text: 'after flush' })
  writes[0].completion.resolve()
  await settle()
  assert.equal(writes.length, 3)
  assert.equal(writes[2].value.settings.text, 'after flush')
  writes[1].completion.reject(new Error('flush failure'))
  await settle()
  assert.equal(store.getSnapshot().saving, true)
  assert.equal(store.getSnapshot().error, '')
  writes[2].completion.resolve()
  await settle()
  assert.equal(store.getSnapshot().saving, false)
})

test('pagehide also flushes the latest in-flight write when no job is pending', async () => {
  const { store, reading, writes } = fixture()
  reading.resolve(undefined)
  await store.load()
  store.setAssetUploadsEnabled(true)
  assert.equal(writes.length, 1)
  store.flushPending()
  assert.equal(writes.length, 2)
  assert.equal(writes[1].value.assetUploadsEnabled, true)
  store.flushPending()
  assert.equal(writes.length, 2)
  writes[0].completion.reject(new Error('navigation aborted original transaction'))
  await settle()
  assert.equal(store.getSnapshot().saving, true)
  assert.equal(store.getSnapshot().error, '')
  writes[1].completion.resolve()
  await settle()
  assert.equal(store.getSnapshot().saving, false)
  assert.equal(store.getSnapshot().error, '')
  store.flushPending()
  assert.equal(writes.length, 2)
})

const iconReference = `/api/media/${'a'.repeat(64)}.png`
const conflictError = new Error('conflict')
function serverFixture(initial: WatermarkPreferencesRecord | null = null, legacyValue?: WatermarkPreferencesRecord) {
  let document = { revision: initial ? 1 : 0, value: initial }
  const writes: { expectedRevision: number; value: WatermarkPreferencesRecord; keepalive: boolean }[] = []
  const uploads: string[] = []
  let legacyReads = 0
  let removals = 0
  const dependencies: ServerWatermarkPreferencesDependencies = {
    readDocument: async () => structuredClone(document),
    writeDocument: async (value, expectedRevision, options) => {
      writes.push({ expectedRevision, value: structuredClone(value), keepalive: options.keepalive })
      if (expectedRevision !== document.revision) throw conflictError
      document = { revision: document.revision + 1, value: structuredClone(value) }
      return structuredClone(document)
    },
    persistImage: async source => { uploads.push(source); return iconReference },
    resolveImage: async reference => { assert.equal(reference, iconReference); return png },
    isConflict: error => error === conflictError,
    legacy: {
      read: async () => { legacyReads++; return legacyValue },
      write: async () => { throw new Error('legacy writes must never occur') },
      remove: async () => { removals++; legacyValue = undefined },
    },
  }
  return {
    dependencies, writes, uploads,
    get document() { return document },
    set document(value) { document = value },
    get legacyReads() { return legacyReads },
    get removals() { return removals },
    get legacyValue() { return legacyValue },
  }
}

test('server persistence is empty by default and never writes defaults or an empty migration', async () => {
  const fixture = serverFixture()
  const persistence = createServerWatermarkPreferencesPersistence(fixture.dependencies)
  assert.equal(await persistence.read(), undefined)
  assert.equal(fixture.writes.length, 0)
  assert.equal(fixture.uploads.length, 0)
  assert.equal(fixture.removals, 0)
})

test('legacy icons migrate to a disk reference and release old bytes only after complete read-back verification', async () => {
  const legacy = { ...record({ mode: 'auto', icon: png, text: '保留停用图标', scale: 0.34 }), assetUploadsEnabled: true }
  const fixture = serverFixture(null, legacy)
  const persistence = createServerWatermarkPreferencesPersistence(fixture.dependencies)
  assert.deepEqual(await persistence.read(), legacy)
  assert.equal(fixture.document.value?.settings.icon, iconReference)
  assert.deepEqual(fixture.uploads, [png])
  assert.equal(fixture.removals, 1)
  assert.equal(fixture.legacyValue, undefined)
  assert.equal(fixture.writes[0].keepalive, true)
})

test('server settings are authoritative and icon bytes hydrate without reading legacy settings', async () => {
  const saved = record({ icon: iconReference, mode: 'icon', text: '磁盘设置' })
  const fixture = serverFixture(saved, record({ text: '旧设置' }))
  const persistence = createServerWatermarkPreferencesPersistence(fixture.dependencies)
  assert.deepEqual(await persistence.read(), { ...saved, settings: { ...saved.settings, icon: png } })
  assert.equal(fixture.legacyReads, 0)
  assert.equal(fixture.writes.length, 0)
  const writing = persistence.write(record({ icon: png, mode: 'icon', text: '新设置' }))
  assert.equal(fixture.writes.length, 1, 'cached icon metadata begins saving before yielding to the browser')
  await writing
  assert.equal(fixture.uploads.length, 0)
  assert.equal(fixture.writes[0].keepalive, true)
})

test('migration failures retain the legacy record and never report an unverified copy as migrated', async () => {
  for (const failAt of ['upload', 'write', 'verify', 'hydrate']) {
    const legacy = record({ icon: png })
    const fixture = serverFixture(null, legacy)
    const failure = async () => { throw new Error(failAt) }
    if (failAt === 'upload') fixture.dependencies.persistImage = failure
    if (failAt === 'write') fixture.dependencies.writeDocument = failure
    if (failAt === 'verify') {
      let reads = 0
      const original = fixture.dependencies.readDocument
      fixture.dependencies.readDocument = async () => ++reads > 1 ? failure() : original()
    }
    if (failAt === 'hydrate') fixture.dependencies.resolveImage = failure
    const persistence = createServerWatermarkPreferencesPersistence(fixture.dependencies)
    await assert.rejects(persistence.read(), new RegExp(failAt))
    assert.deepEqual(fixture.legacyValue, legacy)
    assert.equal(fixture.removals, 0)
  }
})

test('concurrent migration uses the committed server settings without overwriting them or removing a different legacy record', async () => {
  const fixture = serverFixture(null, record({ text: '当前浏览器的旧设置' }))
  const winner = record({ text: '其他浏览器已迁移' })
  fixture.dependencies.writeDocument = async () => {
    fixture.document = { revision: 1, value: winner }
    throw conflictError
  }
  const persistence = createServerWatermarkPreferencesPersistence(fixture.dependencies)
  assert.deepEqual(await persistence.read(), winner)
  assert.equal(fixture.removals, 0)
})

test('an uploaded icon remains unsaved until its file and metadata are durable; page exit never starts a second upload', async () => {
  const fixture = serverFixture()
  const upload = deferred<string>()
  fixture.dependencies.persistImage = () => { fixture.uploads.push(png); return upload.promise }
  const persistence = createServerWatermarkPreferencesPersistence(fixture.dependencies)
  const store = createWatermarkPreferencesStore(persistence)
  await store.load()
  store.updateSettings(record({ mode: 'icon', icon: png }).settings)
  assert.equal(store.getSnapshot().saving, true)
  assert.equal(fixture.uploads.length, 1)
  store.flushPending()
  assert.equal(fixture.uploads.length, 1)
  assert.equal(fixture.writes.length, 0)
  assert.equal(store.getSnapshot().saving, true)
  upload.resolve(iconReference)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(store.getSnapshot().saving, false)
  assert.equal(fixture.document.value?.settings.icon, iconReference)
})

test('unrelated revision conflicts cannot silently overwrite another window; explicit retry refreshes the baseline', async () => {
  const fixture = serverFixture(record({ text: '开始' }))
  const persistence = createServerWatermarkPreferencesPersistence(fixture.dependencies)
  await persistence.read()
  const otherWindow = record({ text: '其他窗口的新设置' })
  fixture.document = { revision: 2, value: otherWindow }
  await assert.rejects(persistence.write(record({ text: '当前设置' })), /其他窗口/)
  assert.deepEqual(fixture.document.value, otherWindow)
  await assert.rejects(persistence.write(record({ text: '当前设置继续编辑' })), /其他窗口/)
  assert.equal(fixture.writes.length, 1)
  await persistence.prepareRetry?.()
  await persistence.write(record({ text: '明确重新保存' }))
  assert.equal(fixture.document.revision, 3)
  assert.equal(fixture.document.value?.settings.text, '明确重新保存')
})

test('a cached metadata flush may supersede an earlier request without letting its stale completion overwrite settings', async () => {
  for (const newerWins of [false, true]) {
    const fixture = serverFixture()
    const writes: { value: WatermarkPreferencesRecord; revision: number; completion: ReturnType<typeof deferred<{ revision: number; value: WatermarkPreferencesRecord }>> }[] = []
    fixture.dependencies.writeDocument = (value, revision, options) => {
      assert.equal(options.keepalive, true)
      const completion = deferred<{ revision: number; value: WatermarkPreferencesRecord }>()
      writes.push({ value, revision, completion })
      return completion.promise
    }
    const persistence = createServerWatermarkPreferencesPersistence(fixture.dependencies)
    await persistence.read()
    const first = persistence.write(record({ text: 'first' }))
    const flush = persistence.flush?.(record({ text: 'latest' }))
    assert.equal(writes.length, 2)
    const winner = newerWins ? writes[1] : writes[0]
    const loser = newerWins ? writes[0] : writes[1]
    fixture.document = { revision: 1, value: winner.value }
    winner.completion.resolve({ revision: 1, value: winner.value })
    loser.completion.reject(conflictError)
    await new Promise(resolve => setImmediate(resolve))
    if (!newerWins) {
      assert.equal(writes.length, 3)
      assert.equal(writes[2].revision, 1)
      fixture.document = { revision: 2, value: writes[2].value }
      writes[2].completion.resolve({ revision: 2, value: writes[2].value })
    }
    await Promise.all([first, flush])
    assert.equal(fixture.document.value?.settings.text, 'latest')
  }
})

test('failed initial reads cannot blindly overwrite server data', async () => {
  const fixture = serverFixture(record({ text: '已有数据' }))
  fixture.dependencies.readDocument = async () => { throw new Error('服务离线') }
  const persistence = createServerWatermarkPreferencesPersistence(fixture.dependencies)
  await assert.rejects(persistence.read(), /服务离线/)
  await assert.rejects(persistence.write(record()), /尚未成功读取/)
  assert.equal(fixture.writes.length, 0)
})

test('backup preference replacement awaits durable persistence and rejects failures while retaining imported edits', async () => {
  for (const fail of [false, true]) {
    const { store, reading, writes } = fixture()
    reading.resolve(undefined)
    await store.load()
    const imported = { ...record({ mode: 'icon', icon: png, text: '导入' }), assetUploadsEnabled: true }
    let completed = false
    const replacing = store.replacePreferences(imported).finally(() => { completed = true })
    await settle()
    assert.equal(completed, false)
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].value, imported)
    if (fail) {
      writes[0].completion.reject(new Error('磁盘写入失败'))
      await assert.rejects(replacing, /磁盘写入失败/)
      assert.match(store.getSnapshot().error, /磁盘写入失败/)
    } else {
      writes[0].completion.resolve()
      await replacing
      assert.equal(store.getSnapshot().error, '')
    }
    assert.deepEqual(store.getSnapshot().settings, imported.settings)
    assert.equal(store.getSnapshot().assetUploadsEnabled, true)
  }
})
