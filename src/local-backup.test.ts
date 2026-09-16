import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, test } from 'node:test'
import { createLocalBackup, parseLocalBackup } from './local-backup.ts'
import type { LocalBackup } from './local-backup.ts'
import type { ContentItem } from './model.ts'
import { DEFAULT_WATERMARK_SETTINGS } from './watermark.ts'
import type { WatermarkPreferencesRecord } from './watermark-preferences.ts'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZXkAAAAASUVORK5CYII='
const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const external = 'https://example.com/photo.png?size=100'
const reference = (data = png, extension = data.startsWith('data:image/gif;') ? 'gif' : 'png') => `/api/media/${createHash('sha256').update(Buffer.from(data.split(',')[1], 'base64')).digest('hex')}.${extension}`
const settings = (icon = png): WatermarkPreferencesRecord => ({ version: 1, settings: { ...DEFAULT_WATERMARK_SETTINGS, mode: 'icon', icon, seed: 123 }, assetUploadsEnabled: true })
const content = (image = png): ContentItem => ({ id: 'backup-draft', title: '备份标题', body: '原始正文\n第二行', image, images: [image], platforms: ['weibo'], status: 'draft', updatedAt: '2026-09-16T00:00:00Z', category: '生活方式' })
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function offline() {
  globalThis.fetch = async () => { throw new Error('Import must not call a server') }
}

async function fixture(): Promise<LocalBackup> {
  offline()
  return createLocalBackup([content()], [png], settings())
}

test('portable export embeds shared image once across cover, image list, assets and watermark', async () => {
  offline()
  const item = { ...content(), images: [png, external, png] }
  const original = structuredClone(item)
  const backup = await createLocalBackup([item], [png, external], settings())
  assert.equal(backup.app, '发条')
  assert.equal(backup.version, 3)
  assert.equal(Number.isNaN(Date.parse(backup.exportedAt)), false)
  assert.deepEqual(Object.keys(backup.media), [reference()])
  assert.equal(backup.media[reference()], png)
  assert.equal(backup.content[0].image, reference())
  assert.deepEqual(backup.content[0].images, [reference(), external, reference()])
  assert.deepEqual(backup.assets, [reference(), external])
  assert.equal(backup.watermark.settings.icon, reference())
  assert.deepEqual(item, original)
})

test('offline import restores exact bytes and remains portable with no source server files', async () => {
  const backup = await fixture()
  const original = structuredClone(backup)
  const imported = await parseLocalBackup(JSON.parse(JSON.stringify(backup)))
  assert.deepEqual(imported, { items: [content()], assets: [png], watermark: settings() })
  assert.deepEqual(backup, original)
  const recreated = await createLocalBackup(imported.items, imported.assets!, imported.watermark!)
  assert.deepEqual(recreated.media, backup.media)
  assert.deepEqual(recreated.content, backup.content)
})

test('export reads a disk media reference only once and never downloads external images', async () => {
  const requests: string[] = []
  globalThis.fetch = async input => {
    requests.push(String(input))
    assert.equal(String(input), reference())
    return new Response(Buffer.from(png.split(',')[1], 'base64'), { headers: { 'Content-Type': 'image/png' } })
  }
  const backup = await createLocalBackup([{ ...content(reference()), images: [reference(), external] }], [reference(), png], settings(reference()))
  assert.deepEqual(requests, [reference()])
  assert.deepEqual(backup.media, { [reference()]: png })
  assert.deepEqual(backup.assets, [reference(), reference()])
  offline()
  assert.deepEqual((await parseLocalBackup(backup)).items[0].images, [png, external])
})

test('GIF assets keep exact animated bytes while watermark settings keep their original format', async () => {
  offline()
  const backup = await createLocalBackup([content(gif)], [gif], settings(''))
  assert.equal(backup.media[reference(gif)], gif)
  const parsed = await parseLocalBackup(backup)
  assert.equal(parsed.items[0].image, gif)
  assert.deepEqual(parsed.assets, [gif])
  assert.equal(parsed.watermark?.settings.icon, '')
})

test('legacy content arrays, content envelopes and existing app exports still import offline', async () => {
  offline()
  const items = [{ ...content(), images: [png, external] }]
  for (const value of [items, { version: 2, items, deletedContentIds: [] }, { app: '发条', exportedAt: '2026-09-16T00:00:00Z', content: items }]) {
    assert.deepEqual(await parseLocalBackup(value), { items })
  }
})

test('empty workspace backup retains assets and settings without requiring draft content', async () => {
  offline()
  const backup = await createLocalBackup([], [png], settings())
  assert.deepEqual(await parseLocalBackup(backup), { items: [], assets: [png], watermark: settings() })
})

test('missing bytes are rejected even if the same media path might exist on this machine', async () => {
  const backup = await fixture()
  backup.media = {}
  await assert.rejects(parseLocalBackup(backup), /缺少.*图片数据/)
  await assert.rejects(parseLocalBackup([content(reference())]), /缺少.*图片数据/)
})

test('media hash and extension must both match exact embedded bytes', async () => {
  const backup = await fixture()
  for (const badReference of [`/api/media/${'0'.repeat(64)}.png`, reference(png, 'jpg')]) {
    const invalid = { ...backup, media: { [badReference]: png } }
    await assert.rejects(parseLocalBackup(invalid), /素材校验失败/)
  }
})

test('malformed refs, invalid bytes, and dangerous image URLs are rejected without requests', async () => {
  const backup = await fixture()
  for (const badReference of ['/api/media/no-hash.png', `${reference()}?cache=1`, reference().toUpperCase(), '/api/media/../data.png']) {
    await assert.rejects(parseLocalBackup({ ...backup, media: { [badReference]: png } }), /无效.*素材引用/)
    await assert.rejects(parseLocalBackup([{ ...content(), image: badReference }]), /无效.*图片链接/)
  }
  for (const source of ['data:image/png;base64,YmFk', 'data:image/png;base64,====', 'data:image/svg+xml;base64,PHN2Zy8+', 'javascript:alert(1)', 'file:///private/image.png', 'https://name:password@example.com/image.png']) {
    await assert.rejects(parseLocalBackup([content(source)]))
  }
  await assert.rejects(parseLocalBackup({ ...backup, media: { [reference()]: 'https://example.com/image.png' } }), /无效.*素材引用/)
})

test('invalid watermark and publication metadata reject the complete backup', async () => {
  const backup = await fixture()
  await assert.rejects(parseLocalBackup({ ...backup, watermark: { ...backup.watermark, settings: { ...backup.watermark.settings, opacity: 9 } } }), /透明度/)
  await assert.rejects(parseLocalBackup({ ...backup, content: [{ ...backup.content[0], platformPublications: { weibo: { requestId: 'x', state: 'published' } } }] }), /发布记录/)
  await assert.rejects(parseLocalBackup({ ...backup, watermark: null }), /水印设置格式无效/)
})

test('counts, required fields and versions are bounded and validated', async () => {
  const backup = await fixture()
  for (const patch of [{ assets: null }, { assets: [4] }, { assets: Array(10_001).fill(png) }, { content: Array.from({ length: 10_001 }, (_, index) => ({ ...content(), id: `draft-${index}` })) }]) {
    await assert.rejects(parseLocalBackup({ ...backup, ...patch }), /列表无效/)
  }
  await assert.rejects(parseLocalBackup({ ...backup, version: 99 }), /不支持.*版本/)
  await assert.rejects(parseLocalBackup({ ...backup, exportedAt: 'not a date' }), /导出时间/)
  await assert.rejects(parseLocalBackup({ ...backup, media: null }), /素材数据表/)
  await assert.rejects(parseLocalBackup({ ...backup, assets: [''] }), /空的图片引用/)
})

test('disk read failures prevent creating an incomplete backup', async () => {
  globalThis.fetch = async () => new Response('missing', { status: 404 })
  await assert.rejects(createLocalBackup([content(reference())], [], settings('')), /404/)
})
