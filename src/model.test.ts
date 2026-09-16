import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import {
  CONTENT_STORAGE_KEY,
  SEED_CONTENT,
  loadContent,
  makeId,
  saveContent,
  validateContent,
  getPublications,
  isPublicationLocked,
  withPlatformReceipt,
  duplicateContent,
  readStoredContent,
  reconcileContentSnapshots,
  syncStoredContent,
  recoverPlatformReceipt,
  isContentDeletionLocked,
  stagePlatformLifecycle,
  parseContentImport,
} from './model.ts'
import type { ContentItem, PlatformId, PlatformReceipt } from './model.ts'

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
let stored: Map<string, string>

beforeEach(() => {
  stored = new Map()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    },
  })
})

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

const emptyContent: Pick<ContentItem, 'title' | 'body' | 'platforms' | 'images'> = {
  title: '',
  body: '',
  platforms: [],
  images: [],
}

const textContent: typeof emptyContent = {
  title: '窗边的一杯茶',
  body: '给下午留一段安静的时间。',
  platforms: ['weibo'],
  images: [],
}

test('a first visit returns demo content without sharing mutable seed arrays', () => {
  const loaded = loadContent()
  assert.deepEqual(loaded, SEED_CONTENT)
  loaded[0].title = 'edited title'
  loaded[0].images.push('https://example.com/new-image.jpg')
  loaded[0].platforms.splice(0)
  assert.deepEqual(loadContent(), SEED_CONTENT)
  assert.notEqual(loaded[0].title, SEED_CONTENT[0].title)
  assert.notDeepEqual(loaded[0].images, SEED_CONTENT[0].images)
  assert.notDeepEqual(loaded[0].platforms, SEED_CONTENT[0].platforms)
})

test('draft edits and optional scheduling fields survive a save and reload', () => {
  const edited: ContentItem[] = [{
    ...SEED_CONTENT[0],
    title: '持久保存的标题',
    body: '正文包含换行\n以及 #标签',
    platforms: ['weibo', 'bilibili'],
    status: 'scheduled',
    scheduledAt: '2026-09-16T10:00:00+08:00',
  }]
  assert.equal(saveContent(edited), true)
  assert.deepEqual(loadContent(), edited)
})

test('an intentionally empty saved library stays empty', () => {
  assert.equal(saveContent([]), true)
  assert.deepEqual(loadContent(), [])
})

test('malformed JSON recovers to demo content without overwriting the original value', () => {
  stored.set(CONTENT_STORAGE_KEY, '{broken JSON')
  assert.deepEqual(loadContent(), SEED_CONTENT)
  assert.equal(stored.get(CONTENT_STORAGE_KEY), '{broken JSON')
})

test('invalid saved structures recover safely instead of entering the UI', () => {
  const invalidValues = [
    null,
    { content: SEED_CONTENT },
    [null],
    [{ ...SEED_CONTENT[0], platforms: ['unsupported-platform'] }],
    [{ ...SEED_CONTENT[0], images: [12] }],
    [{ ...SEED_CONTENT[0], updatedAt: 'not a date' }],
    [{ ...SEED_CONTENT[0], scheduledAt: 'not a date' }],
    [{ ...SEED_CONTENT[0], views: -1 }],
  ]
  for (const invalid of invalidValues) {
    stored.set(CONTENT_STORAGE_KEY, JSON.stringify(invalid))
    assert.deepEqual(loadContent(), SEED_CONTENT)
  }
})

test('restricted browser storage is handled on both reads and writes', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('Storage access denied') },
  })
  assert.deepEqual(loadContent(), SEED_CONTENT)
  assert.equal(saveContent(SEED_CONTENT), false)
})

test('an environment without localStorage can still load the demo', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined })
  assert.deepEqual(loadContent(), SEED_CONTENT)
  assert.equal(saveContent(SEED_CONTENT), false)
})

test('a quota failure reports false and preserves the previously saved library', () => {
  assert.equal(saveContent(SEED_CONTENT), true)
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem() { throw new Error('QuotaExceededError') },
    },
  })
  assert.equal(saveContent([]), false)
  assert.deepEqual(loadContent(), SEED_CONTENT)
})

test('new posts receive nonempty distinct identifiers', () => {
  const ids = Array.from({ length: 100 }, makeId)
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0))
  assert.equal(new Set(ids).size, ids.length)
})

test('incomplete content can be saved as a draft', () => {
  assert.deepEqual(validateContent(emptyContent, 'draft'), [])
})

test('publishing reports title, content, and platform omissions together', () => {
  const errors = validateContent({ ...emptyContent, title: '  ', body: '\n ' }, 'publish')
  assert.equal(errors.length, 3)
  assert.ok(errors.some((error) => error.includes('标题')))
  assert.ok(errors.some((error) => error.includes('正文或图片')))
  assert.ok(errors.some((error) => error.includes('发布平台')))
})

test('text-only publishing is available for a supported text platform', () => {
  assert.deepEqual(validateContent(textContent, 'publish'), [])
})

test('unsupported platform identifiers cannot be published', () => {
  const errors = validateContent({ ...textContent, platforms: ['unknown' as PlatformId] }, 'publish')
  assert.ok(errors.some((error) => error.includes('尚未支持')))
})

test('Douyin image posts need an image, while an image can supply the post content', () => {
  const douyin = { ...textContent, platforms: ['douyin'] as PlatformId[] }
  assert.ok(validateContent(douyin, 'publish').some((error) => error.includes('至少添加一张图片')))
  assert.deepEqual(validateContent({ ...douyin, body: '', images: ['https://example.com/photo.jpg'] }, 'publish'), [])
})

test('scheduling rejects missing, malformed, past, and current timestamps', (context) => {
  const now = Date.parse('2026-09-14T10:00:00+08:00')
  context.mock.method(Date, 'now', () => now)
  for (const date of [undefined, '', 'not a date', new Date(now - 1).toISOString(), new Date(now).toISOString()]) {
    const errors = validateContent(textContent, 'schedule', date)
    assert.equal(errors.length, 1)
    assert.ok(errors[0].includes('定时发布时间'))
  }
})

test('scheduling accepts a future timestamp and still checks required content', (context) => {
  const now = Date.parse('2026-09-14T10:00:00+08:00')
  context.mock.method(Date, 'now', () => now)
  const future = new Date(now + 1).toISOString()
  assert.deepEqual(validateContent(textContent, 'schedule', future), [])
  assert.equal(validateContent(emptyContent, 'schedule', future).length, 3)
})

const realReceipt: PlatformReceipt = {
  platform: 'weibo', id: '529382921', requestId: 'request-weibo-123',
  url: 'https://weibo.com/detail/529382921', publishedAt: '2026-09-14T10:00:00+08:00',
  account: { uid: '10001', name: '我的账号' },
}

test('legacy Weibo success and uncertain records remain locked after reload', () => {
  const legacy: ContentItem = { ...SEED_CONTENT[0], weiboReceipt: realReceipt, publishMode: 'weibo' }
  const pending: ContentItem = { ...SEED_CONTENT[1], weiboRequestId: 'old-request', weiboPublishState: 'uncertain' }
  assert.equal(saveContent([legacy, pending]), true)
  const [saved, uncertain] = loadContent()
  assert.equal(isPublicationLocked(saved), true)
  assert.equal(getPublications(saved).weibo?.receipt?.account.uid, '10001')
  assert.equal(isPublicationLocked(uncertain), true)
  assert.deepEqual(getPublications(uncertain).weibo, { requestId: 'old-request', state: 'uncertain' })
})

test('partial success keeps independent pending request and only completes all selected platforms', () => {
  const pending: ContentItem = { ...SEED_CONTENT[0], status: 'draft', platforms: ['weibo', 'bilibili'], platformPublications: {
    weibo: { requestId: realReceipt.requestId, state: 'pending', expectedAccountUid: '10001' },
    bilibili: { requestId: 'request-bili-123', state: 'uncertain', expectedAccountUid: '20002' },
  } }
  const partial = withPlatformReceipt(pending, realReceipt)
  assert.equal(partial.status, 'draft')
  assert.equal(partial.publishMode, 'real')
  assert.equal(partial.platformPublications?.weibo?.state, 'published')
  assert.equal(partial.platformPublications?.bilibili?.state, 'uncertain')
  assert.equal(pending.platformPublications?.weibo?.state, 'pending')
  assert.equal(saveContent([partial]), true)
  const saved = loadContent()[0]
  assert.equal(isPublicationLocked(saved), true)
  const completed = withPlatformReceipt(saved, { ...realReceipt, platform: 'bilibili', requestId: 'request-bili-123', id: '982345', url: 'https://t.bilibili.com/982345', account: { uid: '20002', name: 'B站账号' } })
  assert.equal(completed.status, 'published')
  assert.equal(completed.platformPublications?.weibo?.receipt?.id, realReceipt.id)
  assert.equal(completed.platformPublications?.bilibili?.receipt?.id, '982345')
})

test('receipt recovery refuses a different request or account', () => {
  const pending: ContentItem = { ...SEED_CONTENT[0], platformPublications: { weibo: { requestId: realReceipt.requestId, state: 'uncertain', expectedAccountUid: '10001' } } }
  assert.equal(withPlatformReceipt(pending, { ...realReceipt, requestId: 'another-request' }), pending)
  assert.equal(withPlatformReceipt(pending, { ...realReceipt, account: { uid: 'wrong-account', name: '另一个账号' } }), pending)
  assert.equal(withPlatformReceipt(pending, { ...realReceipt, platform: 'douyin' }), pending)
  assert.equal(recoverPlatformReceipt(pending, { ...realReceipt, platform: 'unknown' as PlatformId }), pending)
})

test('copying clears every real receipt and request without changing the original', () => {
  const original: ContentItem = { ...SEED_CONTENT[0], weiboReceipt: realReceipt, weiboRequestId: realReceipt.requestId, weiboPublishState: 'pending', publishMode: 'real', platformPublications: {
    weibo: { requestId: realReceipt.requestId, state: 'published', receipt: realReceipt },
    douyin: { requestId: 'another-request', state: 'uncertain', expectedAccountUid: '20002' },
  } }
  const copy = duplicateContent(original)
  assert.notEqual(copy.id, original.id)
  assert.equal(copy.status, 'draft')
  assert.equal(isPublicationLocked(copy), false)
  assert.deepEqual(getPublications(copy), {})
  assert.equal(copy.weiboRequestId, undefined)
  assert.equal(copy.weiboPublishState, undefined)
  assert.equal(copy.publishedAt, undefined)
  assert.equal(copy.publishMode, undefined)
  copy.images.push('another-image')
  assert.notEqual(original.images.length, copy.images.length)
  assert.equal(isPublicationLocked(original), true)
})

test('unconfirmed payload and UID survive storage intact', () => {
  const pending: ContentItem = { ...SEED_CONTENT[0], title: '冻结的内容', images: ['data:image/png;base64,iVBORw0KGgo='], platformPublications: { xiaohongshu: { requestId: 'frozen-request', state: 'pending', expectedAccountUid: 'original-account' } } }
  assert.equal(saveContent([pending]), true)
  assert.deepEqual(loadContent(), [pending])
  const loaded = loadContent()
  loaded[0].platformPublications!.xiaohongshu!.expectedAccountUid = 'mutated'
  assert.equal(loadContent()[0].platformPublications?.xiaohongshu?.expectedAccountUid, 'original-account')
})

test('non-seeding storage reads distinguish a missing key, an empty library, and invalid data', () => {
  assert.deepEqual(readStoredContent(), { ok: true, items: null })
  stored.set(CONTENT_STORAGE_KEY, '[]')
  assert.deepEqual(readStoredContent(), { ok: true, items: [] })
  for (const invalid of ['{broken', 'null', '[null]', JSON.stringify([SEED_CONTENT[0], SEED_CONTENT[0]]), JSON.stringify([{ ...SEED_CONTENT[0], platformPublications: { weibo: { state: 'pending' } } }])]) {
    stored.set(CONTENT_STORAGE_KEY, invalid)
    assert.deepEqual(readStoredContent(), { ok: false })
    assert.equal(stored.get(CONTENT_STORAGE_KEY), invalid)
  }
})

test('non-seeding reads fail closed when storage is missing or access is denied', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined })
  assert.deepEqual(readStoredContent(), { ok: false })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied') } })
  assert.deepEqual(readStoredContent(), { ok: false })
})

function pendingContent(): ContentItem {
  return { ...structuredClone(SEED_CONTENT[0]), title: '已确认的标题', body: '已确认的正文', image: 'frozen-cover', images: ['frozen-image'], platforms: ['weibo', 'bilibili'], status: 'draft', publishedAt: undefined, category: '已确认分类', platformPublications: {
    weibo: { requestId: realReceipt.requestId, expectedAccountUid: realReceipt.account.uid, state: 'pending' },
  } }
}

test('a stale tab save cannot replace the persisted publication payload or receipt', () => {
  const staged = pendingContent()
  const published = withPlatformReceipt(staged, realReceipt)
  assert.equal(saveContent([published]), true)
  const read = readStoredContent()
  assert.equal(read.ok, true)
  if (!read.ok || !read.items) throw new Error('expected stored publication')
  const stale: ContentItem = { ...staged, title: '过期编辑', body: '过期正文', image: 'changed-cover', images: ['changed-image'], platforms: ['douyin'], category: '过期分类', platformPublications: undefined }
  const reconciled = reconcileContentSnapshots([stale], read.items)
  assert.equal(saveContent(reconciled), true)
  const saved = loadContent()[0]
  for (const key of ['title', 'body', 'image', 'images', 'platforms', 'category'] as const) assert.deepEqual(saved[key], published[key])
  assert.deepEqual(getPublications(saved).weibo?.receipt, realReceipt)
  assert.equal(getPublications(saved).weibo?.requestId, realReceipt.requestId)
  assert.equal(getPublications(saved).weibo?.expectedAccountUid, realReceipt.account.uid)
  assert.equal(getPublications(saved).weibo?.state, 'published')
})

test('omitted locked records survive deletion from a stale snapshot, while ordinary drafts may be deleted', () => {
  const pending = pendingContent()
  const uncertain = { ...pending, id: 'uncertain', platformPublications: { weibo: { ...pending.platformPublications!.weibo!, state: 'uncertain' as const } } }
  const published = withPlatformReceipt({ ...pending, id: 'published' }, realReceipt)
  const unlocked = { ...SEED_CONTENT[2], id: 'ordinary' }
  const result = reconcileContentSnapshots([], [pending, uncertain, published, unlocked])
  assert.deepEqual(result.map(item => item.id), [pending.id, uncertain.id, published.id])
  result[0].images.push('mutable-copy')
  assert.deepEqual(pending.images, ['frozen-image'])
})

test('same-request receipts upgrade latest pending and uncertainty without changing canonical content', () => {
  const latest = pendingContent()
  const proposed = withPlatformReceipt({ ...latest, body: 'stale payload' }, realReceipt)
  const [merged] = reconcileContentSnapshots([proposed], [latest])
  assert.equal(merged.body, latest.body)
  assert.equal(getPublications(merged).weibo?.state, 'published')
  const [replayed] = reconcileContentSnapshots([latest], [merged])
  assert.deepEqual(getPublications(replayed).weibo, getPublications(merged).weibo)
  const uncertain: ContentItem = { ...latest, platformPublications: { weibo: { ...latest.platformPublications!.weibo!, state: 'uncertain' } } }
  assert.equal(getPublications(reconcileContentSnapshots([latest], [uncertain])[0]).weibo?.state, 'uncertain')
})

test('conflicting requests and accounts cannot replace a latest publication', () => {
  const latest = pendingContent()
  for (const receipt of [{ ...realReceipt, requestId: 'different-request' }, { ...realReceipt, account: { uid: 'different-account', name: '另一个账号' } }]) {
    const proposed: ContentItem = { ...latest, platformPublications: { weibo: { requestId: receipt.requestId, expectedAccountUid: receipt.account.uid, state: 'published', receipt } } }
    assert.deepEqual(getPublications(reconcileContentSnapshots([proposed], [latest])[0]).weibo, getPublications(latest).weibo)
  }
})

test('new requests merge only for canonically selected platforms and new staging can replace an unlocked draft', () => {
  const latest = pendingContent()
  const proposed: ContentItem = { ...latest, platforms: ['weibo', 'bilibili', 'douyin'], platformPublications: { ...latest.platformPublications,
    bilibili: { requestId: 'new-bilibili', state: 'pending', expectedAccountUid: '20002' },
    douyin: { requestId: 'new-douyin', state: 'pending', expectedAccountUid: '30003' },
  } }
  const [merged] = reconcileContentSnapshots([proposed], [latest])
  assert.equal(getPublications(merged).bilibili?.requestId, 'new-bilibili')
  assert.equal(getPublications(merged).douyin, undefined)
  assert.deepEqual(merged.platforms, latest.platforms)
  const unlocked = { ...latest, platformPublications: undefined }
  assert.deepEqual(reconcileContentSnapshots([proposed], [unlocked]), [proposed])
})

test('legacy confirmed Weibo receipts survive stale newer-shaped pending metadata', () => {
  const legacy: ContentItem = { ...pendingContent(), weiboReceipt: realReceipt, platformPublications: { weibo: { requestId: 'stale-request', state: 'pending', expectedAccountUid: 'different-account' } } }
  assert.equal(getPublications(legacy).weibo?.state, 'published')
  assert.equal(getPublications(legacy).weibo?.requestId, realReceipt.requestId)
  const [merged] = reconcileContentSnapshots([{ ...legacy, weiboReceipt: undefined }], [legacy])
  assert.deepEqual(getPublications(merged).weibo?.receipt, realReceipt)
})

test('receipt-only recovery preserves local payload and platform choices and refuses conflicting identities', () => {
  const draft = { ...pendingContent(), platforms: ['bilibili'] as PlatformId[], platformPublications: undefined }
  const recovered = recoverPlatformReceipt(draft, realReceipt)
  assert.equal(recovered.body, draft.body)
  assert.equal(recovered.title, draft.title)
  assert.deepEqual(recovered.images, draft.images)
  assert.deepEqual(recovered.platforms, draft.platforms)
  assert.equal(getPublications(recovered).weibo?.receipt?.id, realReceipt.id)
  assert.equal(getPublications(recovered).weibo?.recoveredFromReceipt, true)
  assert.equal(recoverPlatformReceipt(recovered, { ...realReceipt, requestId: 'another-request' }), recovered)
  assert.equal(recoverPlatformReceipt(recovered, { ...realReceipt, account: { uid: 'different-account', name: '其他人' } }), recovered)
  assert.equal(getPublications(draft).weibo, undefined)
})

test('receipt replay preserves confirmed identity and older receipts do not move completion time backward', () => {
  const first = withPlatformReceipt(pendingContent(), realReceipt)
  assert.equal(withPlatformReceipt(first, { ...realReceipt, id: 'different-id' }), first)
  const older: PlatformReceipt = { ...realReceipt, platform: 'bilibili', requestId: 'older-bilibili', publishedAt: '2026-09-13T10:00:00+08:00', account: { uid: '20002', name: 'B站账号' } }
  const completed = recoverPlatformReceipt(first, older)
  assert.equal(completed.status, 'published')
  assert.equal(completed.publishedAt, realReceipt.publishedAt)
  assert.equal(completed.updatedAt, realReceipt.publishedAt)
})

test('a second tab honors a verified pending release and cannot resurrect it on its next save', () => {
  const pending = pendingContent()
  assert.equal(saveContent([pending]), true)
  const tabB = loadContent()
  assert.equal(isPublicationLocked(tabB[0]), true)
  const released: ContentItem = { ...pending, platformPublications: undefined, weiboPublishState: undefined, weiboRequestId: undefined, weiboReceipt: undefined }
  assert.equal(saveContent([released]), true)
  const latest = readStoredContent()
  assert.equal(latest.ok, true)
  if (!latest.ok || !latest.items) throw new Error('stored draft missing')
  const synced = syncStoredContent(tabB, latest.items)
  assert.equal(isPublicationLocked(synced[0]), false)
  assert.deepEqual(getPublications(synced[0]), {})
  const edited = { ...synced[0], body: '发布前已拒绝，重新编辑的正文' }
  assert.equal(saveContent(reconcileContentSnapshots([edited], latest.items)), true)
  assert.equal(loadContent()[0].body, edited.body)
  assert.equal(isPublicationLocked(loadContent()[0]), false)
})

test('read synchronization preserves confirmed in-memory receipts while preferring stored unlocked drafts', () => {
  const draft = { ...pendingContent(), platformPublications: undefined }
  const staleDraft = { ...draft, body: '旧标签页正文' }
  const latestDraft = { ...draft, body: '最新草稿正文' }
  assert.equal(syncStoredContent([staleDraft], [latestDraft])[0].body, latestDraft.body)
  const confirmed = withPlatformReceipt(pendingContent(), realReceipt)
  const recovered = syncStoredContent([confirmed], [latestDraft])[0]
  assert.equal(getPublications(recovered).weibo?.receipt?.id, realReceipt.id)
  assert.equal(recovered.body, confirmed.body)
})

test('partial success does not resurrect another platform pending request after a verified release', () => {
  const xhsReceipt: PlatformReceipt = { ...realReceipt, platform: 'xiaohongshu', requestId: 'xhs-confirmed-request', id: 'note-123', url: 'https://www.xiaohongshu.com/explore/note-123' }
  const staged: ContentItem = { ...pendingContent(), platforms: ['xiaohongshu', 'weibo'], platformPublications: {
    xiaohongshu: { requestId: xhsReceipt.requestId, expectedAccountUid: xhsReceipt.account.uid, state: 'published', receipt: xhsReceipt },
    weibo: { requestId: realReceipt.requestId, expectedAccountUid: realReceipt.account.uid, state: 'pending' },
  }, weiboRequestId: realReceipt.requestId, weiboPublishState: 'pending' }
  assert.equal(saveContent([staged]), true)
  const tabB = loadContent()
  const released: ContentItem = { ...staged, platformPublications: { xiaohongshu: staged.platformPublications!.xiaohongshu }, weiboRequestId: undefined, weiboPublishState: undefined }
  assert.equal(saveContent([released]), true)
  assert.equal(isPublicationLocked(released), true)
  const synced = syncStoredContent(tabB, loadContent())
  assert.equal(getPublications(synced[0]).weibo, undefined)
  assert.equal(getPublications(synced[0]).xiaohongshu?.receipt?.id, xhsReceipt.id)
  const persisted = reconcileContentSnapshots(synced, loadContent())
  assert.equal(saveContent(persisted), true)
  assert.equal(getPublications(loadContent()[0]).weibo, undefined)
  assert.equal(getPublications(loadContent()[0]).xiaohongshu?.receipt?.id, xhsReceipt.id)
})

function publishedContent(): ContentItem {
  return withPlatformReceipt({ ...pendingContent(), platforms: ['weibo'] }, realReceipt)
}

const updatedReceipt: PlatformReceipt = {
  ...realReceipt, updatedAt: '2026-09-15T10:00:00+08:00',
  lastOperation: { requestId: 'update-operation-1', type: 'update', title: '微博的新标题', body: '微博确认的新正文' },
}
const deletedReceipt: PlatformReceipt = {
  ...updatedReceipt, deletedAt: '2026-09-15T11:00:00+08:00',
  lastOperation: { requestId: 'delete-operation-1', type: 'delete' },
}

test('starter samples never imply successful publication or engagement', () => {
  assert.ok(SEED_CONTENT.length > 0)
  for (const item of SEED_CONTENT) {
    assert.equal(item.status, 'draft')
    assert.equal(item.publishedAt, undefined)
    assert.equal(item.scheduledAt, undefined)
    assert.equal(item.views, undefined)
    assert.equal(item.likes, undefined)
    assert.equal(isPublicationLocked(item), false)
  }
})

test('legacy simulated success migrates into a draft without losing authored content', () => {
  const simulated = { ...SEED_CONTENT[0], status: 'published', publishMode: 'demo', publishedAt: '2026-09-14T08:00:00+08:00', views: 900, likes: 50 }
  const original = JSON.stringify([simulated])
  stored.set(CONTENT_STORAGE_KEY, original)
  const [migrated] = loadContent()
  for (const key of ['id', 'title', 'body', 'image', 'images', 'platforms'] as const) assert.deepEqual(migrated[key], simulated[key])
  assert.equal(migrated.status, 'draft')
  assert.equal(migrated.publishedAt, undefined)
  assert.equal(migrated.publishMode, undefined)
  assert.equal(migrated.views, undefined)
  assert.equal(migrated.likes, undefined)
  assert.equal(stored.get(CONTENT_STORAGE_KEY), original)
  assert.equal(saveContent([migrated]), true)
  assert.equal(JSON.parse(stored.get(CONTENT_STORAGE_KEY)!).version, 2)
})

test('legacy genuine Weibo receipts survive migration even when mixed with an old demo flag', () => {
  stored.set(CONTENT_STORAGE_KEY, JSON.stringify([{ ...SEED_CONTENT[0], platforms: ['weibo'], status: 'published', publishMode: 'demo', weiboReceipt: realReceipt, views: 1000 }]))
  const [migrated] = loadContent()
  assert.equal(migrated.status, 'published')
  assert.equal(migrated.publishMode, 'real')
  assert.deepEqual(getPublications(migrated).weibo?.receipt, realReceipt)
  assert.equal(isContentDeletionLocked(migrated), true)
  assert.equal(migrated.views, undefined)
})

test('a lifecycle submission freezes its request and text until that exact operation is confirmed', () => {
  const original = publishedContent()
  const staged = stagePlatformLifecycle(original, 'weibo', { operation: 'update', requestId: 'update-operation-1', state: 'pending', title: '已提交标题', body: '已提交正文' })
  assert.equal(isContentDeletionLocked(staged), true)
  assert.equal(stagePlatformLifecycle(staged, 'weibo', { operation: 'delete', requestId: 'different-operation', state: 'pending' }), staged)
  const uncertain = stagePlatformLifecycle(staged, 'weibo', { operation: 'update', requestId: 'update-operation-1', state: 'uncertain', title: '不得替换的标题', body: '不得替换的正文' })
  assert.deepEqual(getPublications(uncertain).weibo?.lifecycle, { operation: 'update', requestId: 'update-operation-1', state: 'uncertain', title: '已提交标题', body: '已提交正文' })
  const confirmed = withPlatformReceipt(uncertain, updatedReceipt)
  assert.equal(getPublications(confirmed).weibo?.lifecycle, undefined)
  assert.deepEqual(getPublications(confirmed).weibo?.receipt?.lastOperation, updatedReceipt.lastOperation)
  assert.equal(stagePlatformLifecycle(confirmed, 'weibo', { operation: 'update', requestId: 'update-operation-1', state: 'uncertain' }), confirmed)
})

test('a confirmed single-platform update never changes the original multi-platform payload', () => {
  const original = withPlatformReceipt(pendingContent(), realReceipt)
  const other = { requestId: 'bili-pending', state: 'uncertain' as const, expectedAccountUid: 'bili-user' }
  original.platformPublications!.bilibili = other
  const staged = stagePlatformLifecycle(original, 'weibo', { operation: 'update', requestId: 'update-operation-1', state: 'pending', title: '微博的新标题', body: '微博确认的新正文' })
  const updated = withPlatformReceipt(staged, updatedReceipt)
  for (const key of ['title', 'body', 'image', 'images', 'platforms', 'category'] as const) assert.deepEqual(updated[key], original[key])
  assert.deepEqual(getPublications(updated).bilibili, other)
  assert.equal(getPublications(updated).weibo?.receipt?.lastOperation?.body, '微博确认的新正文')
})

test('newer receipts without a matching operation do not clear an uncertain lifecycle', () => {
  const staged = stagePlatformLifecycle(publishedContent(), 'weibo', { operation: 'update', requestId: 'current-operation', state: 'uncertain', body: '仍需确认' })
  for (const receipt of [updatedReceipt, { ...updatedReceipt, lastOperation: undefined }]) {
    assert.equal(getPublications(withPlatformReceipt(staged, receipt)).weibo?.lifecycle?.requestId, 'current-operation')
  }
})

test('old receipt replay and stale lifecycle snapshots cannot override a confirmed newer version', () => {
  const staged = stagePlatformLifecycle(publishedContent(), 'weibo', { operation: 'update', requestId: 'update-operation-1', state: 'uncertain' })
  const confirmed = withPlatformReceipt(staged, updatedReceipt)
  assert.equal(withPlatformReceipt(confirmed, realReceipt), confirmed)
  const [merged] = reconcileContentSnapshots([staged], [confirmed])
  assert.deepEqual(getPublications(merged).weibo?.receipt, updatedReceipt)
  assert.equal(getPublications(merged).weibo?.lifecycle, undefined)
  assert.equal(saveContent([confirmed]), true)
  assert.equal(saveContent([staged]), false)
  assert.deepEqual(getPublications(loadContent()[0]).weibo?.receipt, updatedReceipt)
})

test('an old completion does not release a different operation staged after it', () => {
  const confirmed = withPlatformReceipt(publishedContent(), updatedReceipt)
  const staged = stagePlatformLifecycle(confirmed, 'weibo', { operation: 'delete', requestId: 'next-operation', state: 'pending' })
  const [merged] = reconcileContentSnapshots([confirmed], [staged])
  assert.equal(getPublications(merged).weibo?.lifecycle?.requestId, 'next-operation')
  assert.equal(getPublications(syncStoredContent([confirmed], [staged])[0]).weibo?.lifecycle?.requestId, 'next-operation')
})

test('confirmed deletion is terminal against replayed updates, legacy receipts, and stale saves', () => {
  const original = publishedContent()
  const deleted = withPlatformReceipt(original, deletedReceipt)
  assert.equal(isContentDeletionLocked(deleted), false)
  assert.equal(isPublicationLocked(deleted), true)
  assert.equal(withPlatformReceipt(deleted, { ...updatedReceipt, updatedAt: '2026-09-16T10:00:00+08:00' }), deleted)
  const staleLegacy = { ...deleted, weiboReceipt: realReceipt }
  assert.equal(getPublications(staleLegacy).weibo?.receipt?.deletedAt, deletedReceipt.deletedAt)
  const [merged] = reconcileContentSnapshots([original], [deleted])
  assert.equal(getPublications(merged).weibo?.receipt?.deletedAt, deletedReceipt.deletedAt)
  assert.equal(stagePlatformLifecycle(deleted, 'weibo', { operation: 'update', requestId: 'after-deletion', state: 'pending' }), deleted)
  assert.equal(saveContent([deleted]), true)
  assert.equal(saveContent([original]), false)
})

test('local removal stays locked until every published platform and every pending lifecycle is resolved', () => {
  const weiboDeleted = withPlatformReceipt(publishedContent(), deletedReceipt)
  const biliReceipt: PlatformReceipt = { ...realReceipt, platform: 'bilibili', requestId: 'bili-request', id: 'bili-id', account: { uid: 'bili-user', name: 'B站账号' } }
  const twoPlatforms = recoverPlatformReceipt({ ...weiboDeleted, platforms: ['weibo', 'bilibili'] }, biliReceipt)
  assert.equal(isContentDeletionLocked(twoPlatforms), true)
  const bothDeleted = withPlatformReceipt(twoPlatforms, { ...biliReceipt, deletedAt: deletedReceipt.deletedAt, lastOperation: { requestId: 'delete-bili', type: 'delete' } })
  assert.equal(isContentDeletionLocked(bothDeleted), false)
  for (const state of ['pending', 'uncertain'] as const) {
    const pending = { ...bothDeleted, platformPublications: { ...getPublications(bothDeleted), douyin: { requestId: 'douyin-request', state } } }
    assert.equal(isContentDeletionLocked(pending), true)
    const unresolvedLifecycle = { ...bothDeleted, platformPublications: { ...getPublications(bothDeleted), weibo: { ...getPublications(bothDeleted).weibo!, lifecycle: { operation: 'update' as const, requestId: 'unconfirmed-update', state } } } }
    assert.equal(isContentDeletionLocked(unresolvedLifecycle), true)
  }
})

test('the persistence boundary refuses to omit published or unconfirmed records', () => {
  for (const item of [pendingContent(), publishedContent(), stagePlatformLifecycle(publishedContent(), 'weibo', { operation: 'delete', requestId: 'pending-delete', state: 'pending' })]) {
    stored.clear()
    assert.equal(saveContent([item]), true)
    const previous = stored.get(CONTENT_STORAGE_KEY)
    assert.equal(saveContent([]), false)
    assert.equal(stored.get(CONTENT_STORAGE_KEY), previous)
    assert.equal(reconcileContentSnapshots([], [item]).length, 1)
  }
})

test('local deletion records a durable tombstone that blocks stale tabs and server receipt recovery', () => {
  const oldTab = publishedContent()
  const deleted = withPlatformReceipt(oldTab, deletedReceipt)
  assert.equal(saveContent([deleted]), true)
  assert.equal(saveContent([]), true)
  const persisted = JSON.parse(stored.get(CONTENT_STORAGE_KEY)!)
  assert.deepEqual(persisted.items, [])
  assert.deepEqual(persisted.deletedContentIds, [deleted.id])
  assert.deepEqual(loadContent(), [])
  assert.deepEqual(syncStoredContent([oldTab], []), [])
  assert.deepEqual(syncStoredContent([deleted], []), [])
  assert.deepEqual(reconcileContentSnapshots([oldTab], []), [])
  assert.equal(saveContent([oldTab]), false)
  assert.equal(recoverPlatformReceipt(oldTab, updatedReceipt), oldTab)
  const copy = duplicateContent(deleted)
  assert.equal(saveContent([copy]), true)
  assert.notEqual(copy.id, deleted.id)
  assert.equal(isPublicationLocked(copy), false)
  assert.deepEqual(JSON.parse(stored.get(CONTENT_STORAGE_KEY)!).deletedContentIds, [deleted.id])
})

test('ordinary draft deletion also blocks an old tab from overwriting the empty library', () => {
  const draft = { ...SEED_CONTENT[0], id: 'local-draft' }
  assert.equal(saveContent([draft]), true)
  assert.equal(saveContent([]), true)
  assert.deepEqual(reconcileContentSnapshots([draft], []), [])
  assert.equal(saveContent([draft]), false)
})

test('a quota failure cannot save half of a content deletion and its tombstone', () => {
  const deleted = withPlatformReceipt(publishedContent(), deletedReceipt)
  assert.equal(saveContent([deleted]), true)
  const previous = stored.get(CONTENT_STORAGE_KEY)
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => stored.get(key) ?? null, setItem() { throw new Error('QuotaExceededError') } },
  })
  assert.equal(saveContent([]), false)
  assert.equal(stored.get(CONTENT_STORAGE_KEY), previous)
  assert.equal(loadContent().length, 1)
  assert.deepEqual(JSON.parse(previous!).deletedContentIds, [])
})

test('draft reconciliation retains the more recent authored version', () => {
  const old = { ...SEED_CONTENT[0], updatedAt: '2026-09-14T00:00:00Z' }
  const latest = { ...old, title: '最新草稿', updatedAt: '2026-09-15T00:00:00Z' }
  assert.equal(reconcileContentSnapshots([old], [latest])[0].title, latest.title)
  assert.equal(reconcileContentSnapshots([latest], [old])[0].title, latest.title)
})

test('storage and backup parsing preserve lifecycle metadata and reject malformed receipts', () => {
  const pending = stagePlatformLifecycle(withPlatformReceipt(publishedContent(), updatedReceipt), 'weibo', { operation: 'delete', requestId: 'delete-operation-1', state: 'uncertain' })
  assert.equal(saveContent([pending]), true)
  assert.deepEqual(getPublications(loadContent()[0]), getPublications(pending))
  for (const input of [[pending], { app: '发条', exportedAt: new Date().toISOString(), content: [pending] }, JSON.parse(stored.get(CONTENT_STORAGE_KEY)!)]) {
    assert.deepEqual(getPublications(parseContentImport(input)![0]), getPublications(pending))
  }
  const invalidPublications = [
    { requestId: realReceipt.requestId, state: 'published' },
    { requestId: realReceipt.requestId, state: 'published', receipt: { ...updatedReceipt, updatedAt: 'bad-time' } },
    { requestId: realReceipt.requestId, state: 'published', receipt: { ...deletedReceipt, deletedAt: 'bad-time' } },
    { requestId: realReceipt.requestId, state: 'published', receipt: { ...updatedReceipt, lastOperation: { requestId: '', type: 'update' } } },
    { requestId: realReceipt.requestId, state: 'published', receipt: realReceipt, lifecycle: { operation: 'delete', requestId: 'op', state: 'complete' } },
    { requestId: realReceipt.requestId, state: 'pending', lifecycle: { operation: 'delete', requestId: 'op', state: 'pending' } },
  ]
  for (const publication of invalidPublications) {
    const invalid = [{ ...SEED_CONTENT[0], platformPublications: { weibo: publication } }]
    assert.equal(parseContentImport(invalid), null)
    assert.equal(saveContent(invalid as ContentItem[]), false)
  }
})

test('malformed storage envelopes fail closed and cannot be overwritten by a fallback draft', () => {
  for (const invalid of [
    { version: 3, items: [], deletedContentIds: [] },
    { version: 2, items: [], deletedContentIds: [123] },
    { version: 2, items: [], deletedContentIds: ['same', 'same'] },
    { version: 2, items: [SEED_CONTENT[0]], deletedContentIds: [SEED_CONTENT[0].id] },
  ]) {
    const raw = JSON.stringify(invalid)
    stored.set(CONTENT_STORAGE_KEY, raw)
    assert.deepEqual(readStoredContent(), { ok: false })
    assert.equal(saveContent([]), false)
    assert.equal(stored.get(CONTENT_STORAGE_KEY), raw)
  }
})
