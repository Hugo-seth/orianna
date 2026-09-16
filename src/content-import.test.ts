import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { mergeContentImport } from './content-import.ts'
import { CONTENT_STORAGE_KEY, SEED_CONTENT } from './model.ts'
import type { ContentItem, PlatformReceipt } from './model.ts'

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
let stored: Map<string, string>
let writes: number

beforeEach(() => {
  stored = new Map()
  writes = 0
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { writes += 1; stored.set(key, value) },
    },
  })
})

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

function draft(overrides: Partial<ContentItem> = {}): ContentItem {
  return { ...structuredClone(SEED_CONTENT[0]), id: 'existing-draft', platforms: ['weibo'], updatedAt: '2026-09-14T00:00:00Z', ...overrides }
}

const receipt: PlatformReceipt = {
  platform: 'weibo', id: '529382921', requestId: 'publish-request',
  url: 'https://weibo.com/detail/529382921', publishedAt: '2026-09-14T01:00:00Z',
  account: { uid: '10001', name: '已连接账号' },
}

function published(overrides: Partial<ContentItem> = {}): ContentItem {
  return draft({
    status: 'published', publishedAt: receipt.publishedAt, publishMode: 'real',
    platformPublications: { weibo: { requestId: receipt.requestId, state: 'published', receipt: structuredClone(receipt) } },
    ...overrides,
  })
}

test('a new ID keeps the original title, body, image order and ID', () => {
  const incoming = draft({ id: 'import-original-id', title: '导入标题', body: '原始正文\n\n#原始标签', image: 'data:image/png;base64,Y292ZXI=', images: ['data:image/png;base64,Y292ZXI=', 'https://example.com/second.png'] })
  assert.deepEqual(mergeContentImport([incoming], []), [incoming])
  assert.equal(writes, 0)
})

test('imports retain unmatched current drafts and preserve a library on empty input', () => {
  const current = [draft(), draft({ id: 'another-local-draft' })]
  const incoming = draft({ id: 'new-import' })
  assert.deepEqual(mergeContentImport([incoming], current), [...current, incoming])
  assert.deepEqual(mergeContentImport([], current), current)
})

test('a confirmed imported draft replaces the same ID regardless of its timestamp', () => {
  const old = draft({ title: '旧版草稿' })
  const latest = draft({ title: '新版草稿', body: '新增正文', updatedAt: '2026-09-15T00:00:00Z' })
  assert.deepEqual(mergeContentImport([latest], [old]), [latest])
  assert.deepEqual(mergeContentImport([old], [latest]), [old])
})

test('equal draft timestamps also use the confirmed imported version', () => {
  const current = draft()
  const incoming = draft({ title: '相同时间的导入草稿' })
  assert.deepEqual(mergeContentImport([incoming], [current]), [incoming])
})

test('a locked receipt and all original payload fields remain exactly authoritative', () => {
  const current = published()
  const forgedReceipt: PlatformReceipt = { ...receipt, updatedAt: '2026-09-16T00:00:00Z', deletedAt: '2026-09-16T00:00:00Z', lastOperation: { type: 'delete', requestId: 'imported-delete' } }
  const importedVariants = [
    draft({ title: '替换标题', body: '替换正文', platforms: ['bilibili'], images: ['https://example.com/replaced.png'], image: 'https://example.com/replaced.png', updatedAt: '2026-09-17T00:00:00Z' }),
    published({ updatedAt: '2026-09-17T00:00:00Z', platformPublications: { weibo: { requestId: receipt.requestId, state: 'published', receipt: forgedReceipt }, bilibili: { requestId: 'new-publication', state: 'pending' } } }),
  ]
  for (const incoming of importedVariants) assert.deepEqual(mergeContentImport([incoming], [current]), [current])
  assert.deepEqual(mergeContentImport([], [current]), [current])
})

test('pending and uncertain publication requests cannot be removed or confirmed by import', () => {
  for (const state of ['pending', 'uncertain'] as const) {
    const current = draft({ platformPublications: { weibo: { requestId: receipt.requestId, state, expectedAccountUid: receipt.account.uid } } })
    for (const incoming of [draft({ updatedAt: '2026-09-17T00:00:00Z' }), published()]) {
      assert.deepEqual(mergeContentImport([incoming], [current]), [current])
    }
  }
})

test('pending and uncertain lifecycle operations cannot be changed or cleared by import', () => {
  for (const operation of ['update', 'delete'] as const) for (const state of ['pending', 'uncertain'] as const) {
    const current = published({ platformPublications: { weibo: {
      requestId: receipt.requestId, state: 'published', receipt: structuredClone(receipt),
      lifecycle: { requestId: 'local-operation', operation, state, title: '已提交标题', body: '已提交正文' },
    } } })
    const confirmation = published({ platformPublications: { weibo: {
      requestId: receipt.requestId, state: 'published',
      receipt: { ...receipt, updatedAt: '2026-09-16T00:00:00Z', lastOperation: { requestId: 'local-operation', type: operation } },
    } } })
    assert.deepEqual(mergeContentImport([confirmation], [current]), [current])
    assert.deepEqual(mergeContentImport([draft()], [current]), [current])
  }
})

test('legacy Weibo receipt and uncertain request records remain unchanged', () => {
  const currentRecords = [
    draft({ weiboReceipt: structuredClone(receipt), publishMode: 'weibo' }),
    draft({ weiboRequestId: 'legacy-request', weiboPublishState: 'uncertain' }),
  ]
  for (const current of currentRecords) {
    assert.deepEqual(mergeContentImport([draft({ title: '导入覆盖', updatedAt: '2026-09-17T00:00:00Z' })], [current]), [current])
  }
})

test('a confirmed platform deletion remains authoritative and survives an unrelated import', () => {
  const current = published({ platformPublications: { weibo: {
    requestId: receipt.requestId, state: 'published',
    receipt: { ...receipt, deletedAt: '2026-09-15T00:00:00Z', lastOperation: { type: 'delete', requestId: 'confirmed-delete' } },
  } } })
  assert.deepEqual(mergeContentImport([published()], [current]), [current])
  const newDraft = draft({ id: 'new-import' })
  assert.deepEqual(mergeContentImport([newDraft], [current]), [current, newDraft])
})

test('local v2 tombstones block imported and stale current records without changing storage', () => {
  const removed = published({ id: 'deleted-local-id' })
  const retained = draft({ id: 'retained-local-id' })
  const raw = JSON.stringify({ version: 2, items: [retained], deletedContentIds: [removed.id] })
  stored.set(CONTENT_STORAGE_KEY, raw)
  assert.deepEqual(mergeContentImport([removed], [retained]), [retained])
  assert.deepEqual(mergeContentImport([], [removed, retained]), [retained])
  assert.equal(stored.get(CONTENT_STORAGE_KEY), raw)
  assert.equal(writes, 0)
})

test('the plan and its nested values are independent of both input snapshots', () => {
  const current = published()
  const incoming = draft({ id: 'new-import' })
  const originalCurrent = structuredClone(current)
  const originalIncoming = structuredClone(incoming)
  const plan = mergeContentImport([incoming], [current])
  plan[0].platformPublications!.weibo!.receipt!.account.name = 'changed'
  plan[0].images.push('https://example.com/changed.png')
  plan[1].images.splice(0)
  plan[1].platforms.push('bilibili')
  assert.deepEqual(current, originalCurrent)
  assert.deepEqual(incoming, originalIncoming)
  assert.equal(writes, 0)
})
