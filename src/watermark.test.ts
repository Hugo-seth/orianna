import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyWatermarks, DEFAULT_WATERMARK_SETTINGS, getWatermarkBounds, readWatermarkIcon,
  renderWatermarkedImage, validateWatermarkImageSource, validateWatermarkSettings, WATERMARK_POSITIONS,
} from './watermark.ts'
import type { WatermarkSettings } from './watermark.ts'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZXkAAAAASUVORK5CYII='
const settings = (changes: Partial<WatermarkSettings> = {}): WatermarkSettings => ({ ...DEFAULT_WATERMARK_SETTINGS, ...changes })

test('defaults render a named watermark, and every fixed position appears exactly once', () => {
  assert.equal(validateWatermarkSettings(DEFAULT_WATERMARK_SETTINGS), '')
  assert.equal(DEFAULT_WATERMARK_SETTINGS.text, '我的创作')
  assert.equal(DEFAULT_WATERMARK_SETTINGS.position, 'bottom-right')
  assert.equal(WATERMARK_POSITIONS.length, 9)
  assert.equal(new Set(WATERMARK_POSITIONS.map(position => position.value)).size, 9)
})

test('auto watermarks require text and count Unicode characters without splitting emoji', () => {
  assert.match(validateWatermarkSettings(settings({ text: '   \n ' })), /文字/)
  assert.equal(validateWatermarkSettings(settings({ text: '🐱'.repeat(40) })), '')
  assert.match(validateWatermarkSettings(settings({ text: '🐱'.repeat(41) })), /40/)
})

test('invalid modes, positions and nonfinite settings fail instead of drawing unpredictably', () => {
  for (const opacity of [NaN, Infinity, 0, 1.01]) assert.match(validateWatermarkSettings(settings({ opacity })), /透明度/)
  for (const scale of [NaN, Infinity, 0, 0.61]) assert.match(validateWatermarkSettings(settings({ scale })), /大小/)
  for (const seed of [NaN, Infinity, -1, 1.5]) assert.match(validateWatermarkSettings(settings({ seed })), /随机/)
  assert.match(validateWatermarkSettings(settings({ mode: 'unknown' as WatermarkSettings['mode'] })), /选择/)
  assert.match(validateWatermarkSettings(settings({ position: 'unknown' as WatermarkSettings['position'] })), /位置/)
})

test('uploaded icon is required and must be a supported local image, independent of unused text', () => {
  assert.match(validateWatermarkSettings(settings({ mode: 'icon' })), /上传/)
  assert.match(validateWatermarkSettings(settings({ mode: 'icon', icon: 'https://example.com/logo.png' })), /数据无效/)
  assert.equal(validateWatermarkSettings(settings({ mode: 'icon', icon: png, text: '' })), '')
})

test('nine positions align to the correct edges or centers with an inset', () => {
  for (let index = 0; index < WATERMARK_POSITIONS.length; index += 1) {
    const position = WATERMARK_POSITIONS[index].value
    const bounds = getWatermarkBounds(1000, 800, 2, settings({ position, scale: 0.2 }))
    assert.equal(bounds.width, 200)
    assert.equal(bounds.height, 100)
    assert.equal(bounds.x, [24, 400, 776][index % 3])
    assert.equal(bounds.y, [24, 350, 676][Math.floor(index / 3)])
  }
})

test('watermarks keep their aspect ratio and fit tiny, portrait and panorama images', () => {
  for (const [width, height] of [[1, 1], [1, 500], [500, 1], [64, 1024], [8192, 2], [2, 8192], [4000, 4000]]) {
    for (const aspect of [0.0001, 0.1, 1, 10, 10000]) {
      for (const position of [...WATERMARK_POSITIONS.map(item => item.value), 'random'] as const) {
        const bounds = getWatermarkBounds(width, height, aspect, settings({ position, scale: 0.6 }))
        assert.ok(bounds.width > 0 && bounds.height > 0)
        assert.ok(bounds.x >= 0 && bounds.y >= 0)
        assert.ok(bounds.x + bounds.width <= width + 1e-9)
        assert.ok(bounds.y + bounds.height <= height + 1e-9)
        assert.ok(Math.abs(bounds.width / bounds.height - aspect) < 1e-9)
      }
    }
  }
})

test('preview and batch use the same random seed/index; reshuffle and image index change placement', () => {
  const random = settings({ position: 'random', seed: 52 })
  const first = getWatermarkBounds(1200, 800, 3, random, 0)
  assert.deepEqual(getWatermarkBounds(1200, 800, 3, { ...random }, 0), first)
  assert.notDeepEqual(getWatermarkBounds(1200, 800, 3, random, 1), first)
  assert.notDeepEqual(getWatermarkBounds(1200, 800, 3, { ...random, seed: 53 }, 0), first)
  const positions = new Set(Array.from({ length: 100 }, (_, index) => {
    const { x, y } = getWatermarkBounds(1200, 800, 3, random, index)
    return `${x},${y}`
  }))
  assert.equal(positions.size, 100)
})

test('invalid dimensions and excessive decoded images are rejected before canvas allocation', () => {
  for (const [width, height] of [[0, 1], [-1, 1], [NaN, 1], [Infinity, 1], [8193, 1], [4001, 4000]]) {
    assert.throws(() => getWatermarkBounds(width, height, 1, settings()), /尺寸/)
  }
  for (const aspect of [0, -1, NaN, Infinity]) assert.throws(() => getWatermarkBounds(100, 100, aspect, settings()), /尺寸/)
  assert.throws(() => getWatermarkBounds(100, 100, 1, settings(), -1), /随机/)
})

test('local data URLs verify image signatures, byte sizes and encoding', () => {
  assert.doesNotThrow(() => validateWatermarkImageSource(png))
  assert.throws(() => validateWatermarkImageSource(png, 10), /过大/)
  assert.throws(() => validateWatermarkImageSource(png.replace('image/png', 'image/jpeg')), /不一致/)
  assert.throws(() => validateWatermarkImageSource('data:image/png;base64,YWJjZA=='), /格式无效/)
  assert.throws(() => validateWatermarkImageSource('data:image/png;base64,%%%'), /数据无效/)
  assert.throws(() => validateWatermarkImageSource('data:image/svg+xml;base64,PHN2Zz4='), /数据无效/)
  assert.throws(() => validateWatermarkImageSource('blob:local-resource'), /数据无效/)
})

test('compressed image headers reject oversized PNG, JPEG and WebP before decoding', () => {
  const pngBytes = Buffer.from(png.split(',')[1], 'base64')
  pngBytes.writeUInt32BE(100_000, 16)
  assert.throws(() => validateWatermarkImageSource(`data:image/png;base64,${pngBytes.toString('base64')}`), /尺寸过大/)

  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc2, 0, 8, 8, 0, 100, 0, 200, 0])
  const jpegSource = () => `data:image/jpeg;base64,${jpegBytes.toString('base64')}`
  assert.doesNotThrow(() => validateWatermarkImageSource(jpegSource()))
  jpegBytes.writeUInt16BE(8193, 15)
  assert.throws(() => validateWatermarkImageSource(jpegSource()), /尺寸过大/)

  const webpBytes = Buffer.alloc(30)
  webpBytes.write('RIFF', 0)
  webpBytes.write('WEBPVP8X', 8)
  webpBytes.writeUIntLE(199, 24, 3)
  webpBytes.writeUIntLE(99, 27, 3)
  const webpSource = () => `data:image/webp;base64,${webpBytes.toString('base64')}`
  assert.doesNotThrow(() => validateWatermarkImageSource(webpSource()))
  webpBytes.writeUIntLE(100_000, 24, 3)
  assert.throws(() => validateWatermarkImageSource(webpSource()), /尺寸过大/)
})

test('GIF payloads, mislabeled GIFs and GIF URLs fail with a conversion instruction', async () => {
  assert.throws(() => validateWatermarkImageSource('data:image/gif;base64,R0lGODlh'), /GIF.*转为/)
  assert.throws(() => validateWatermarkImageSource('data:image/png;base64,R0lGODlh'), /GIF.*转为/)
  await assert.rejects(renderWatermarkedImage('https://example.com/animated.gif?version=2', settings()), /GIF.*转为/)
  await assert.rejects(readWatermarkIcon(new File(['GIF89a'], 'watermark.gif', { type: 'image/gif' })), /GIF.*转为/)
})

test('icon type and size failures are rejected before attempting browser image APIs', async () => {
  await assert.rejects(readWatermarkIcon(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })), /仅支持/)
  await assert.rejects(readWatermarkIcon(new File([new Uint8Array(1024 * 1024 + 1)], 'large.png', { type: 'image/png' })), /1 MB/)
})

test('batch rejection identifies the failing image and preserves original inputs', async () => {
  const images = ['data:image/gif;base64,R0lGODlh', png]
  const original = [...images]
  await assert.rejects(applyWatermarks(images, settings()), /第 1 张图片.*GIF/)
  assert.deepEqual(images, original)
  assert.deepEqual(await applyWatermarks([], settings()), [])
  await assert.rejects(renderWatermarkedImage('file:///private/image.png', settings()), /http\(s\)/)
})

test('noncanonical local paths cannot be fetched for watermarks', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected request') })
  const reference = `/api/media/${'a'.repeat(64)}.png`
  for (const source of ['/images/local.png', `.${reference}`, `${reference}?v=1`, `${reference}#fragment`, reference.toUpperCase(), `/api/media/../${'a'.repeat(64)}.png`]) {
    await assert.rejects(renderWatermarkedImage(source, settings()), /图片链接无效/)
  }
  assert.equal(fetchMock.mock.callCount(), 0)
})
