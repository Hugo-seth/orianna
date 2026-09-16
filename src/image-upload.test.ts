import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { createHash } from 'node:crypto'
import { DEFAULT_WATERMARK_SETTINGS, readUploadedImages, renderWatermarkedImage } from './watermark.ts'

const MIB = 1024 * 1024
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZXkAAAAASUVORK5CYII=', 'base64')
const gifBytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
// The decoder is stubbed in these contract tests; browser acceptance checks real image pixels.
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 100, 0, 200, 0])
const webpBytes = Buffer.alloc(30)
webpBytes.write('RIFF', 0)
webpBytes.write('WEBPVP8X', 8)
webpBytes.writeUIntLE(199, 24, 3)
webpBytes.writeUIntLE(99, 27, 3)

function browserStubs(t: TestContext, options: { sizes?: number[]; width?: number; height?: number; failSource?: string } = {}) {
  const reads: Blob[] = []
  const loads: string[] = []
  const canvases: FakeCanvas[] = []
  const exports: { canvas: FakeCanvas; width: number; height: number; type: string; quality?: number }[] = []
  class FakeFileReader {
    result: string | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    readAsDataURL(blob: Blob) {
      reads.push(blob)
      void blob.arrayBuffer().then(bytes => {
        this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString('base64')}`
        this.onload?.()
      }, () => this.onerror?.())
    }
    abort() { this.onabort?.() }
  }
  class FakeImage {
    naturalWidth = options.width ?? 200
    naturalHeight = options.height ?? 100
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(source: string) {
      if (!source) return
      loads.push(source)
      queueMicrotask(() => source === options.failSource ? this.onerror?.() : this.onload?.())
    }
  }
  class FakeCanvas {
    width = 0
    height = 0
    draws: unknown[][] = []
    context = {
      drawImage: (...args: unknown[]) => this.draws.push(args),
      measureText: () => ({ width: 240 }),
      save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, roundRect() {}, fill() {}, fillText() {},
    }
    getContext() { return this.context }
    toBlob(callback: (blob: Blob) => void, type: string, quality?: number) {
      const size = options.sizes?.[exports.length] ?? 100
      exports.push({ canvas: this, width: this.width, height: this.height, type, quality })
      queueMicrotask(() => callback(new Blob([new Uint8Array(size)], { type })))
    }
  }
  const replacements = {
    FileReader: FakeFileReader,
    Image: FakeImage,
    document: { createElement: () => { const canvas = new FakeCanvas(); canvases.push(canvas); return canvas } },
  }
  for (const [name, value] of Object.entries(replacements)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    })
  }
  return { reads, loads, canvases, exports }
}

test('all ordinary static formats export original-resolution PNG without a lossy quality parameter', async t => {
  const browser = browserStubs(t)
  const files = [new File([jpegBytes], 'photo.jpg', { type: 'image/jpeg' }), new File([pngBytes], 'photo.png', { type: 'image/png' }), new File([webpBytes], 'photo.webp', { type: 'image/webp' })]
  const results = await readUploadedImages(files)
  assert.equal(results.length, 3)
  assert.ok(results.every(source => source.startsWith('data:image/png;base64,')))
  assert.deepEqual(browser.exports.map(({ width, height, type, quality }) => ({ width, height, type, quality })), Array.from({ length: 3 }, () => ({ width: 200, height: 100, type: 'image/png', quality: undefined })))
  assert.ok(browser.canvases.every(canvas => canvas.width === 0 && canvas.height === 0))
})

test('watermarked JPEG also exports PNG at original resolution', async t => {
  const browser = browserStubs(t)
  const result = await renderWatermarkedImage(`data:image/jpeg;base64,${jpegBytes.toString('base64')}`, DEFAULT_WATERMARK_SETTINGS)
  assert.match(result, /^data:image\/png;base64,/)
  assert.equal(browser.exports.length, 1)
  assert.equal(browser.exports[0].type, 'image/png')
  assert.equal(browser.exports[0].quality, undefined)
  assert.equal(browser.exports[0].width, 200)
  assert.equal(browser.exports[0].height, 100)
})

test('watermark rendering resolves immutable disk media before decoding and preserves its source bytes', async t => {
  const browser = browserStubs(t)
  const reference = `/api/media/${createHash('sha256').update(pngBytes).digest('hex')}.png`
  const calls: { url: string; options?: RequestInit }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL, options?: RequestInit) => {
    calls.push({ url: String(url), options })
    return new Response(pngBytes, { headers: { 'Content-Type': 'image/png' } })
  })
  const result = await renderWatermarkedImage(reference, DEFAULT_WATERMARK_SETTINGS)
  assert.match(result, /^data:image\/png;base64,/)
  assert.deepEqual(browser.loads, [`data:image/png;base64,${pngBytes.toString('base64')}`])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, reference)
  assert.equal(calls[0].options?.credentials, 'same-origin')
  assert.equal(calls[0].options?.redirect, 'error')
  assert.equal(browser.exports[0].width, 200)
  assert.equal(browser.exports[0].height, 100)
})

test('watermark rendering refuses missing or changed disk media and still rejects local GIF animation', async t => {
  const browser = browserStubs(t)
  const reference = `/api/media/${createHash('sha256').update(pngBytes).digest('hex')}.png`
  const gifReference = `/api/media/${createHash('sha256').update(gifBytes).digest('hex')}.gif`
  const changedBytes = Buffer.from(pngBytes)
  changedBytes[changedBytes.length - 1] ^= 1
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 404 }))
  await assert.rejects(renderWatermarkedImage(reference, DEFAULT_WATERMARK_SETTINGS))
  fetchMock.mock.mockImplementation(async () => new Response(changedBytes, { headers: { 'Content-Type': 'image/png' } }))
  await assert.rejects(renderWatermarkedImage(reference, DEFAULT_WATERMARK_SETTINGS))
  fetchMock.mock.mockImplementation(async () => new Response(gifBytes, { headers: { 'Content-Type': 'image/gif' } }))
  await assert.rejects(renderWatermarkedImage(gifReference, DEFAULT_WATERMARK_SETTINGS), /GIF.*转为/)
  assert.equal(browser.loads.length, 0)
  assert.equal(browser.exports.length, 0)
})

test('PNG at exactly 3 MiB keeps its dimensions; oversized PNG resizes from the original each time', async t => {
  const browser = browserStubs(t, { sizes: [3 * MIB, 6 * MIB, 4 * MIB, 2 * MIB], width: 2000, height: 1000 })
  const file = new File([pngBytes], 'photo.png', { type: 'image/png' })
  const [atLimit, resized] = await readUploadedImages([file, file])
  assert.equal(Buffer.from(atLimit.split(',')[1], 'base64').length, 3 * MIB)
  assert.equal(Buffer.from(resized.split(',')[1], 'base64').length, 2 * MIB)
  assert.equal(browser.exports.length, 4)
  assert.equal(browser.exports[0].width, 2000)
  const original = browser.exports[1].canvas
  for (const output of browser.exports.slice(2)) {
    assert.equal(output.canvas.draws[0][0], original)
    assert.ok(output.width < 2000 && output.height < 1000)
    assert.ok(Math.abs(output.width - output.height * 2) <= 1)
    assert.equal(output.type, 'image/png')
  }
  assert.ok(browser.canvases.every(canvas => canvas.width === 0 && canvas.height === 0))
})

test('watermark uploads validate/decode sources above 3 MiB and retain their original bytes until overlay', async t => {
  const browser = browserStubs(t)
  const file = new File([pngBytes, new Uint8Array(4 * MIB)], 'large.png', { type: 'image/png' })
  const [result] = await readUploadedImages([file], { forWatermark: true })
  assert.deepEqual(Buffer.from(result.split(',')[1], 'base64'), Buffer.from(await file.arrayBuffer()))
  assert.equal(browser.loads.length, 1)
  assert.equal(browser.canvases.length, 0)
  assert.equal(browser.exports.length, 0)
})

test('upload format follows MIME and signature, independent of the filename suffix', async t => {
  const browser = browserStubs(t)
  const [result] = await readUploadedImages([new File([pngBytes], 'renamed.gif', { type: 'image/png' })], { forWatermark: true })
  assert.equal(result, `data:image/png;base64,${pngBytes.toString('base64')}`)
  await assert.rejects(readUploadedImages([new File([gifBytes], 'renamed.png', { type: 'image/png' })], { forWatermark: true }), /GIF.*转为/)
  assert.equal(browser.loads.length, 1)
})

test('ordinary GIF keeps exact bytes and avoids canvas conversion', async t => {
  const browser = browserStubs(t)
  const [result] = await readUploadedImages([new File([gifBytes], 'animated.gif', { type: 'image/gif' })])
  assert.equal(result, `data:image/gif;base64,${gifBytes.toString('base64')}`)
  assert.equal(browser.loads.length, 1)
  assert.equal(browser.canvases.length, 0)
})

test('batch prevalidation rejects unsupported, oversized and watermarked GIF files before reading any image', async t => {
  const browser = browserStubs(t)
  const valid = new File([pngBytes], 'photo.png', { type: 'image/png' })
  await assert.rejects(readUploadedImages([valid, new File(['svg'], 'image.svg', { type: 'image/svg+xml' })]), /第 2 张图片.*仅支持/)
  await assert.rejects(readUploadedImages([new File([new Uint8Array(12 * MIB + 1)], 'large.png', { type: 'image/png' })]), /12 MB/)
  await assert.rejects(readUploadedImages([new File([new Uint8Array(3 * MIB + 1)], 'large.gif', { type: 'image/gif' })]), /GIF.*3 MB.*保留动画/)
  await assert.rejects(readUploadedImages([valid, new File([gifBytes], 'animation.gif', { type: 'image/gif' })], { forWatermark: true }), /第 2 张图片.*GIF.*转为/)
  assert.equal(browser.reads.length, 0)
})

test('invalid GIF signatures, mislabeled images and oversized GIF dimensions fail before decoding', async t => {
  const browser = browserStubs(t)
  await assert.rejects(readUploadedImages([new File(['GIF99a0000'], 'broken.gif', { type: 'image/gif' })]), /GIF.*格式无效/)
  await assert.rejects(readUploadedImages([new File([pngBytes], 'mislabeled.gif', { type: 'image/gif' })]), /GIF.*不一致/)
  await assert.rejects(readUploadedImages([new File([pngBytes], 'mislabeled.jpg', { type: 'image/jpeg' })]), /不一致/)
  const hugeGif = Buffer.from(gifBytes)
  hugeGif.writeUInt16LE(8193, 6)
  await assert.rejects(readUploadedImages([new File([hugeGif], 'huge.gif', { type: 'image/gif' })]), /尺寸过大/)
  assert.equal(browser.loads.length, 0)
})

test('a later decoder failure rejects the whole batch, keeps inputs intact and releases earlier canvases', async t => {
  const source = `data:image/jpeg;base64,${jpegBytes.toString('base64')}`
  const browser = browserStubs(t, { failSource: source })
  const files = [new File([pngBytes], 'first.png', { type: 'image/png' }), new File([jpegBytes], 'second.jpg', { type: 'image/jpeg' })]
  const originals = [...files]
  await assert.rejects(readUploadedImages(files), /第 2 张图片.*无法解码/)
  assert.deepEqual(files, originals)
  assert.equal(browser.exports.length, 1)
  assert.ok(browser.canvases.every(canvas => canvas.width === 0 && canvas.height === 0))
  assert.deepEqual(await readUploadedImages([]), [])
})
