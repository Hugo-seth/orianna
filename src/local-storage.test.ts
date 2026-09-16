import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createHash } from 'node:crypto'
import { CONTENT_STORAGE_KEY, SEED_CONTENT, recoverPlatformReceipt, setContentDeletedIdsReader } from './model.ts'
import type { ContentItem, PlatformReceipt } from './model.ts'
import {
  ASSETS_STORAGE_KEY, LocalStorageConflictError, createLocalStorageRepository,
  isLocalMediaReference, persistImage, readDocument, resolveImage, writeDocument,
} from './local-storage.ts'
import type { AssetsDocument, ContentDocument } from './local-storage.ts'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZXkAAAAASUVORK5CYII='
const bytes = Buffer.from(png.split(',')[1], 'base64')
const hash = createHash('sha256').update(bytes).digest('hex')
const media = `/api/media/${hash}.png`
const originalFetch = globalThis.fetch
const draft = (id = 'draft-1', changes: Partial<ContentItem> = {}): ContentItem => ({
  ...structuredClone(SEED_CONTENT[0]), id, title: 'Original draft', updatedAt: '2026-09-16T01:00:00Z', ...changes,
})
const envelope = (items: ContentItem[], deletedContentIds: string[] = []): ContentDocument => ({ version: 2, items, deletedContentIds })
const receipt: PlatformReceipt = { platform: 'weibo', id: '123', requestId: 'publish-1', url: 'https://weibo.com/1/123', publishedAt: '2026-09-16T02:00:00Z', account: { uid: '1', name: 'Test' } }
function fixture(legacyContent?: unknown, legacyAssets?: unknown) {
  const legacy = new Map<string, string>()
  if (legacyContent !== undefined) legacy.set(CONTENT_STORAGE_KEY, JSON.stringify(legacyContent))
  if (legacyAssets !== undefined) legacy.set(ASSETS_STORAGE_KEY, JSON.stringify(legacyAssets))
  const docs = new Map<string, { revision: number; value: unknown }>([
    ['content', { revision: 0, value: null }], ['assets', { revision: 0, value: null }], ['watermark', { revision: 0, value: null }],
  ])
  const files = new Map<string, { bytes: Uint8Array; mime: string }>()
  const requests: { path: string; method: string; options: RequestInit }[] = []
  let intercept: ((path: string, options: RequestInit) => Response | undefined | Promise<Response | undefined>) | undefined
  const fetcher = async (input: RequestInfo | URL, options: RequestInit = {}): Promise<Response> => {
    const path = String(input)
    requests.push({ path, method: options.method ?? 'GET', options })
    const intercepted = await intercept?.(path, options)
    if (intercepted) return intercepted
    if (path === '/api/media') {
      const body = new Uint8Array(options.body as Uint8Array)
      const digest = createHash('sha256').update(body).digest('hex')
      const mime = new Headers(options.headers).get('Content-Type')!
      const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[mime]
      const url = `/api/media/${digest}.${ext}`
      files.set(url, { bytes: body, mime })
      return Response.json({ url, id: digest, mime, size: body.byteLength })
    }
    if (path.startsWith('/api/media/')) {
      const file = files.get(path)
      return file ? new Response(file.bytes, { headers: { 'Content-Type': file.mime } }) : Response.json({ error: 'missing' }, { status: 404 })
    }
    const name = path.split('/').pop()!
    const current = docs.get(name)!
    if ((options.method ?? 'GET') === 'GET') return Response.json(current)
    const update = JSON.parse(options.body as string)
    if (current.revision !== update.expectedRevision) return Response.json({ error: 'conflict' }, { status: 409 })
    const next = { revision: current.revision + 1, value: update.value }
    docs.set(name, next)
    return Response.json(next)
  }
  globalThis.fetch = fetcher
  const storage = { getItem: (key: string) => legacy.get(key) ?? null, removeItem: (key: string) => { legacy.delete(key) } }
  return { legacy, docs, files, requests, storage, repository: createLocalStorageRepository({ storage }),
    intercept: (handler?: typeof intercept) => { intercept = handler } }
}

afterEach(() => { globalThis.fetch = originalFetch; setContentDeletedIdsReader() })

test('migration uploads shared pixels once, preserves exact bytes and only then clears old keys', async () => {
  const f = fixture([draft('a', { image: png, images: [png, png] })], [png])
  await f.repository.initializeLocalStorage()
  assert.equal(f.files.size, 1)
  assert.equal(f.requests.filter(request => request.path === '/api/media').length, 1)
  assert.deepEqual(Buffer.from(f.files.get(media)!.bytes), bytes)
  assert.deepEqual(f.repository.loadContent()[0].images, [media, media])
  assert.deepEqual(f.repository.loadAssets(), [media])
  assert.equal(f.legacy.size, 0)
  assert.equal((f.docs.get('content')!.value as ContentDocument).migrationSources!.length, 1)
  assert.equal((f.docs.get('assets')!.value as AssetsDocument).migrationSources!.length, 1)
})

test('inaccessible server never seeds or clears legacy content', async () => {
  const f = fixture([draft()], [png])
  const before = new Map(f.legacy)
  f.intercept(path => path.endsWith('/assets') ? Response.json({ error: 'disk unavailable' }, { status: 503 }) : undefined)
  await assert.rejects(f.repository.initializeLocalStorage(), /disk unavailable/)
  assert.deepEqual(f.legacy, before)
  assert.equal(f.requests.some(request => request.method === 'PUT'), false)
  assert.deepEqual(f.repository.loadContent(), [])
  assert.deepEqual(await f.repository.readStoredContent(), { ok: false })
})

test('malformed legacy data fails closed before any write', async () => {
  const f = fixture([draft()], [])
  f.legacy.set(ASSETS_STORAGE_KEY, '{broken')
  await assert.rejects(f.repository.initializeLocalStorage(), /旧素材/)
  assert.equal(f.requests.length, 0)
  assert.equal(f.legacy.size, 2)
})

test('partial migration failure retains originals and source receipts prevent later resurrection', async () => {
  const f = fixture([draft('retired', { image: png, images: [png] })], [png])
  const before = new Map(f.legacy)
  f.intercept((path, options) => path.endsWith('/assets') && options.method === 'PUT' ? Response.json({ error: 'disk full' }, { status: 507 }) : undefined)
  await assert.rejects(f.repository.initializeLocalStorage(), /disk full/)
  assert.deepEqual(f.legacy, before)
  const current = f.docs.get('content')!
  current.revision += 1
  current.value = { ...(current.value as ContentDocument), items: [], deletedContentIds: ['retired'] }
  f.intercept()
  await f.repository.initializeLocalStorage()
  assert.deepEqual(f.repository.loadContent(), [])
  assert.equal(f.legacy.size, 0)
  assert.deepEqual((f.docs.get('content')!.value as ContentDocument).deletedContentIds, ['retired'])
})

test('legacy edits during migration are retained and included on retry', async () => {
  const f = fixture([draft()], [])
  let edited = false
  f.intercept((path, options) => {
    if (!edited && path.endsWith('/assets') && options.method === 'PUT') {
      edited = true
      f.legacy.set(CONTENT_STORAGE_KEY, JSON.stringify([draft('draft-1', { title: 'Latest edit', updatedAt: '2026-09-16T03:00:00Z' })]))
    }
  })
  await assert.rejects(f.repository.initializeLocalStorage(), /发生变化/)
  assert.equal(f.legacy.size, 2)
  await f.repository.initializeLocalStorage()
  assert.equal(f.repository.loadContent()[0].title, 'Latest edit')
  assert.equal(f.legacy.size, 0)
})

test('migration merges metadata without losing newer drafts, confirmed receipts or tombstones', async () => {
  const f = fixture(envelope([draft('existing'), draft('deleted'), draft('new')], ['old-deletion']), [])
  const published = draft('existing', { platformPublications: { weibo: { requestId: receipt.requestId, state: 'published', receipt } } })
  f.docs.set('content', { revision: 4, value: envelope([published, draft('server-only')], ['deleted']) })
  await f.repository.initializeLocalStorage()
  const stored = f.docs.get('content')!.value as ContentDocument
  assert.deepEqual(new Set(stored.items.map(item => item.id)), new Set(['existing', 'server-only', 'new']))
  assert.equal(stored.items.find(item => item.id === 'existing')!.platformPublications!.weibo!.receipt!.id, receipt.id)
  assert.deepEqual(new Set(stored.deletedContentIds), new Set(['deleted', 'old-deletion']))
})

test('first use is seeded once but an explicitly empty library stays empty', async () => {
  const first = fixture()
  await first.repository.initializeLocalStorage()
  assert.deepEqual(first.repository.loadContent(), SEED_CONTENT)
  const writes = first.requests.filter(request => request.method === 'PUT').length
  await first.repository.initializeLocalStorage()
  assert.equal(first.requests.filter(request => request.method === 'PUT').length, writes)
  const empty = fixture([], [])
  await empty.repository.initializeLocalStorage()
  assert.deepEqual(empty.repository.loadContent(), [])
})

test('assets CAS retries merge concurrent uploads and deduplicate canonical images', async () => {
  const f = fixture([], ['https://example.com/old.png'])
  await f.repository.initializeLocalStorage()
  let collided = false
  f.intercept((path, options) => {
    if (!collided && path.endsWith('/assets') && options.method === 'PUT') {
      collided = true
      const current = f.docs.get('assets')!
      current.revision += 1
      current.value = { ...(current.value as AssetsDocument), images: ['https://example.com/concurrent.png'] }
    }
  })
  const saved = await f.repository.saveAssets([png, png])
  assert.deepEqual(saved, [media, 'https://example.com/concurrent.png'])
  assert.deepEqual(f.repository.loadAssets(), saved)
  assert.equal(collided, true)
})

test('content save waits for durable acknowledgement and updates cache to canonical file references', async () => {
  const f = fixture([draft()], [])
  await f.repository.initializeLocalStorage()
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const start = new Promise<void>(resolve => { started = resolve })
  f.intercept(async (path, options) => {
    if (path.endsWith('/content') && options.method === 'PUT') { started(); await blocked }
  })
  let settled = false
  const save = f.repository.saveContent([draft('draft-1', { image: png, images: [png] })]).then(result => { settled = true; return result })
  await start
  assert.equal(settled, false)
  assert.notEqual(f.repository.loadContent()[0].image, media)
  release()
  assert.equal(await save, true)
  assert.equal(f.repository.loadContent()[0].image, media)
})

test('content CAS retry preserves a concurrent new draft and newer authored version', async () => {
  const f = fixture([draft()], [])
  await f.repository.initializeLocalStorage()
  let collided = false
  f.intercept((path, options) => {
    if (!collided && path.endsWith('/content') && options.method === 'PUT') {
      collided = true
      const current = f.docs.get('content')!
      current.revision += 1
      current.value = { ...(current.value as ContentDocument), items: [draft('draft-1', { title: 'Newer from another tab', updatedAt: '2026-09-16T04:00:00Z' }), draft('concurrent-new')] }
    }
  })
  assert.equal(await f.repository.saveContent([draft('draft-1', { title: 'Stale edit' })]), true)
  assert.deepEqual(f.repository.loadContent().map(item => item.id), ['draft-1', 'concurrent-new'])
  assert.equal(f.repository.loadContent()[0].title, 'Newer from another tab')
})

test('deletion creates durable tombstones and stale saves cannot resurrect them', async () => {
  const f = fixture([draft()], [])
  await f.repository.initializeLocalStorage()
  assert.equal(await f.repository.saveContent([]), true)
  assert.deepEqual((f.docs.get('content')!.value as ContentDocument).deletedContentIds, ['draft-1'])
  assert.equal(await f.repository.saveContent([draft()]), false)
  assert.match(f.repository.getLocalStorageError()!, /已删除/)
  assert.deepEqual(f.repository.loadContent(), [])
})

test('application tombstone reader protects receipt recovery independently of cleared browser storage', async () => {
  const f = fixture(envelope([], ['draft-1']), [])
  const app = createLocalStorageRepository({ storage: f.storage, installTombstoneReader: true })
  await app.initializeLocalStorage()
  const item = draft()
  assert.deepEqual(recoverPlatformReceipt(item, receipt), item)
})

test('protected publication records cannot be removed and disk failure keeps previous cache', async () => {
  const protectedItem = draft('protected', { platformPublications: { weibo: { requestId: 'p', state: 'pending' } } })
  const f = fixture([protectedItem], [])
  await f.repository.initializeLocalStorage()
  assert.equal(await f.repository.saveContent([]), false)
  const previous = f.repository.loadContent()
  f.intercept((path, options) => options.method === 'PUT' ? Response.json({ error: 'disk full' }, { status: 507 }) : undefined)
  assert.equal(await f.repository.saveContent([...previous, draft('added')]), false)
  assert.deepEqual(f.repository.loadContent(), previous)
  assert.match(f.repository.getLocalStorageError()!, /disk full/)
})

test('missing durable documents after initialization fail closed instead of reseeding', async () => {
  const f = fixture([], [])
  await f.repository.initializeLocalStorage()
  f.docs.set('content', { revision: 0, value: null })
  assert.deepEqual(await f.repository.readStoredContent(), { ok: false })
  assert.equal(await f.repository.saveContent([draft()]), false)
  assert.equal(f.docs.get('content')!.value, null)
})

test('media helper validates exact hashes and MIME and leaves remote images unproxied', async () => {
  const f = fixture()
  assert.equal(await persistImage(png), media)
  assert.equal(await resolveImage(media), png)
  const count = f.requests.length
  assert.equal(await persistImage('https://example.com/a.jpg'), 'https://example.com/a.jpg')
  assert.equal(await resolveImage('https://example.com/a.jpg'), 'https://example.com/a.jpg')
  assert.equal(f.requests.length, count)
  const last = f.requests.find(request => request.path === media)!
  assert.equal(last.options.redirect, 'error')
  assert.equal(last.options.credentials, 'same-origin')
  f.files.get(media)!.bytes = Uint8Array.of(1, 2, 3)
  await assert.rejects(resolveImage(media), /校验失败/)
  f.files.get(media)!.mime = 'text/html'
  await assert.rejects(resolveImage(media), /类型校验失败/)
  assert.equal(isLocalMediaReference(`/api/media/${hash}.png?x=1`), false)
  assert.equal(isLocalMediaReference(`/api/media/${hash.toUpperCase()}.png`), false)
  await assert.rejects(persistImage('/api/media/../secret'), /格式无效/)
})

test('invalid upload acknowledgement cannot enter durable metadata', async () => {
  const f = fixture()
  f.intercept(path => path === '/api/media' ? Response.json({ url: '/api/media/wrong.png', mime: 'image/png', size: bytes.length }) : undefined)
  await assert.rejects(persistImage(png), /校验未通过/)
})

test('document writes attach CSRF header and support keepalive with explicit CAS conflicts', async () => {
  const f = fixture()
  const result = await writeDocument('watermark', { expectedRevision: 0, value: { version: 1 } }, { keepalive: true })
  assert.equal(result.revision, 1)
  const request = f.requests.at(-1)!
  assert.equal(new Headers(request.options.headers).get('X-Fatiao-Request'), '1')
  assert.equal(new Headers(request.options.headers).get('Content-Type'), 'application/json')
  assert.equal(request.options.keepalive, true)
  await assert.rejects(writeDocument('watermark', { expectedRevision: 0, value: {} }), LocalStorageConflictError)
  assert.deepEqual(await readDocument('watermark'), result)
})

test('unchanged-version saves can release rejected pending publications and lifecycles', async () => {
  const pending = draft('pending', { platformPublications: { weibo: { requestId: 'pending-1', state: 'pending' } } })
  const published = draft('published', { platformPublications: { weibo: {
    requestId: receipt.requestId, state: 'published', receipt,
    lifecycle: { operation: 'update', requestId: 'edit-1', state: 'pending', title: 'Attempted edit' },
  } } })
  const f = fixture([pending, published], [])
  await f.repository.initializeLocalStorage()
  const released = f.repository.loadContent().map(item => item.id === 'pending'
    ? { ...item, platformPublications: {}, weiboRequestId: undefined, weiboPublishState: undefined }
    : { ...item, platformPublications: { weibo: { ...item.platformPublications!.weibo!, lifecycle: undefined } } })
  assert.equal(await f.repository.saveContent(released), true)
  assert.deepEqual(f.repository.loadContent()[0].platformPublications, {})
  assert.equal(f.repository.loadContent()[1].platformPublications!.weibo!.lifecycle, undefined)
  assert.equal(f.repository.loadContent()[1].platformPublications!.weibo!.receipt!.id, receipt.id)
})

test('concurrent changes make publication release fail visibly instead of silently restoring pending state', async () => {
  const pending = draft('pending', { platformPublications: { weibo: { requestId: 'pending-1', state: 'pending' } } })
  const f = fixture([pending], [])
  await f.repository.initializeLocalStorage()
  const remote = f.docs.get('content')!
  remote.revision += 1
  remote.value = { ...(remote.value as ContentDocument), items: [pending, draft('concurrent')] }
  assert.equal(await f.repository.saveContent([{ ...pending, platformPublications: {} }]), false)
  assert.match(f.repository.getLocalStorageError()!, /发布状态已在其他窗口更新/)
  assert.equal((f.docs.get('content')!.value as ContentDocument).items[0].platformPublications!.weibo!.requestId, 'pending-1')
})

test('an explicit same-version import can replace an ordinary draft with an older authored timestamp', async () => {
  const f = fixture([draft()], [])
  await f.repository.initializeLocalStorage()
  assert.equal(await f.repository.saveContent([draft('draft-1', { title: 'Restored backup', updatedAt: '2025-01-01T00:00:00Z' })]), true)
  assert.equal(f.repository.loadContent()[0].title, 'Restored backup')
})

test('real SQLite migration preserves recovered receipt content IDs and pending state through failure and restart', async () => {
  const { createServer } = await import('node:http')
  const { mkdtemp, readFile, readdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createLocalStorageHandler } = await import('../server/local-storage.mjs')
  const dataDir = await mkdtemp(join(tmpdir(), 'fatiao-client-storage-'))
  let handler: ReturnType<typeof createLocalStorageHandler>
  let failAssetsOnce = true
  const server = createServer(async (req, res) => {
    if (failAssetsOnce && req.url === '/api/local-data/assets' && req.method === 'PUT') {
      failAssetsOnce = false
      req.resume()
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Injected migration failure after durable content write' } }))
      return
    }
    if (!await handler(req, res)) { res.writeHead(404); res.end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const origin = `http://127.0.0.1:${address.port}`
  handler = createLocalStorageHandler({ env: { APP_ORIGIN: origin }, dataDir })
  // Recovery spreads API receipts into both platform and legacy Weibo fields, including contentId.
  const recoveredReceipt = (contentId: string, changes: Partial<PlatformReceipt> = {}) => ({
    ...receipt, id: `remote-${contentId}`, requestId: `request-${contentId}`, contentId, ...changes,
  })
  const publishedReceipt = recoveredReceipt('recovered-published')
  const deletedReceipt = recoveredReceipt('recovered-deleted', {
    deletedAt: '2026-09-16T04:00:00Z',
    lastOperation: { type: 'delete', requestId: 'delete-recovered' },
  })
  const partialReceipt = recoveredReceipt('recovered-partial')
  const originalItems = [
    draft('integration', { image: png, images: [png] }),
    recoverPlatformReceipt(draft('recovered-published', { platforms: ['weibo'], image: png, images: [png] }), publishedReceipt),
    recoverPlatformReceipt(draft('recovered-deleted', { platforms: ['weibo'], image: png, images: [png] }), deletedReceipt),
    recoverPlatformReceipt(draft('recovered-partial', {
      platforms: ['weibo', 'bilibili'], image: png, images: [png],
      platformPublications: { bilibili: { requestId: 'partial-pending-request', expectedAccountUid: 'bili-1', state: 'uncertain' } },
    }), partialReceipt),
  ]
  const originalReceipts = [publishedReceipt, deletedReceipt, partialReceipt]
  const assertRecoveredRecords = (items: ContentItem[]) => {
    assert.deepEqual(items.map(item => item.id), originalItems.map(item => item.id))
    assert.deepEqual(items.map(item => item.status), ['draft', 'published', 'published', 'draft'])
    for (const expected of originalReceipts) {
      const item = items.find(value => value.id === expected.contentId)!
      assert.equal(JSON.stringify(item.platformPublications!.weibo!.receipt), JSON.stringify(expected))
      assert.equal(JSON.stringify(item.weiboReceipt), JSON.stringify(expected))
      assert.equal(item.platformPublications!.weibo!.requestId, expected.requestId)
      assert.equal(item.platformPublications!.weibo!.recoveredFromReceipt, true)
    }
    assert.deepEqual(items.find(item => item.id === 'recovered-partial')!.platformPublications!.bilibili, {
      requestId: 'partial-pending-request', expectedAccountUid: 'bili-1', state: 'uncertain',
    })
  }
  const f = fixture(envelope(originalItems, ['earlier-deletion']), [png])
  const originalLegacy = new Map(f.legacy)
  globalThis.fetch = (input, options = {}) => {
    const headers = new Headers(options.headers)
    headers.set('Origin', origin)
    return originalFetch(new URL(String(input), origin), { ...options, headers })
  }
  try {
    await assert.rejects(f.repository.initializeLocalStorage(), /Injected migration failure/)
    assert.deepEqual(f.legacy, originalLegacy)
    const partiallyMigrated = await readDocument<ContentDocument>('content')
    assertRecoveredRecords(partiallyMigrated.value!.items)
    assert.deepEqual(partiallyMigrated.value!.deletedContentIds, ['earlier-deletion'])
    await f.repository.initializeLocalStorage()
    assert.equal(f.legacy.size, 0)
    assertRecoveredRecords(f.repository.loadContent())
    assert.deepEqual(await readdir(join(dataDir, 'media')), [`${hash}.png`])
    assert.deepEqual(await readFile(join(dataDir, 'media', `${hash}.png`)), bytes)
    assert.equal(f.repository.loadContent()[0].image, media)
    assert.equal(await resolveImage(media), png)
    await handler.close()
    handler = createLocalStorageHandler({ env: { APP_ORIGIN: origin }, dataDir })
    const restarted = createLocalStorageRepository({ storage: f.storage })
    await restarted.initializeLocalStorage()
    assertRecoveredRecords(restarted.loadContent())
    assert.deepEqual(restarted.loadAssets(), [media])
    assert.equal(await restarted.saveContent(restarted.loadContent().filter(item => item.id !== 'integration')), true)
    const tombstone = await readDocument<ContentDocument>('content')
    assert.deepEqual(tombstone.value!.deletedContentIds, ['earlier-deletion', 'integration'])
    assert.deepEqual(tombstone.value!.items.map(item => item.id), ['recovered-published', 'recovered-deleted', 'recovered-partial'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await handler.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
