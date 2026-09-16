import { isLocalMediaReference, resolveImage } from './local-storage.ts'

export type WatermarkPosition = 'random' | 'top-left' | 'top-center' | 'top-right' | 'middle-left' | 'center' | 'middle-right' | 'bottom-left' | 'bottom-center' | 'bottom-right'

export interface WatermarkSettings {
  mode: 'auto' | 'icon'
  text: string
  icon: string
  position: WatermarkPosition
  opacity: number
  scale: number
  seed: number
}

export const DEFAULT_WATERMARK_SETTINGS: WatermarkSettings = {
  mode: 'auto', text: '我的创作', icon: '', position: 'bottom-right', opacity: 0.72, scale: 0.22, seed: 1,
}

export const WATERMARK_POSITIONS: { value: Exclude<WatermarkPosition, 'random'>; label: string }[] = [
  { value: 'top-left', label: '左上' }, { value: 'top-center', label: '顶部居中' }, { value: 'top-right', label: '右上' },
  { value: 'middle-left', label: '左侧居中' }, { value: 'center', label: '正中' }, { value: 'middle-right', label: '右侧居中' },
  { value: 'bottom-left', label: '左下' }, { value: 'bottom-center', label: '底部居中' }, { value: 'bottom-right', label: '右下' },
]

const MAX_ICON_BYTES = 1024 * 1024
const MAX_SOURCE_BYTES = 12 * 1024 * 1024
const MAX_OUTPUT_BYTES = 3 * 1024 * 1024
const MAX_IMAGE_PIXELS = 16_000_000
const MAX_IMAGE_SIDE = 8192
const LOAD_TIMEOUT_MS = 15_000
const SUPPORTED_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const GIF_ERROR = 'GIF 暂不支持添加水印，请先将需要的画面转为 PNG、JPG 或 WebP 后重试。'

export function validateWatermarkSettings(settings: WatermarkSettings): string {
  if (settings.mode !== 'auto' && settings.mode !== 'icon') return '请选择自动生成或上传水印图标。'
  if (settings.mode === 'auto' && !settings.text.trim()) return '请输入水印文字。'
  if (settings.mode === 'auto' && Array.from(settings.text.trim()).length > 40) return '水印文字最多 40 个字。'
  if (settings.mode === 'icon' && !settings.icon) return '请先上传水印图标。'
  if (settings.mode === 'icon') {
    try { validateWatermarkImageSource(settings.icon, MAX_ICON_BYTES) }
    catch (error) { return error instanceof Error ? error.message : '水印图标无效，请重新上传。' }
  }
  if (settings.position !== 'random' && !WATERMARK_POSITIONS.some(position => position.value === settings.position)) return '请选择有效的水印位置。'
  if (!Number.isFinite(settings.opacity) || settings.opacity < 0.1 || settings.opacity > 1) return '水印透明度应在 10% 至 100% 之间。'
  if (!Number.isFinite(settings.scale) || settings.scale < 0.05 || settings.scale > 0.6) return '水印大小应在 5% 至 60% 之间。'
  if (!Number.isSafeInteger(settings.seed) || settings.seed < 0) return '随机位置设置无效，请重新随机一次。'
  return ''
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('图片尺寸无效，请重新上传图片。')
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
    throw new Error('图片尺寸过大，请将图片缩小至 1600 万像素以内，且宽高均不超过 8192 像素后重试。')
  }
}

function randomCoordinates(seed: number, index: number): [number, number] {
  let state = (seed >>> 0) ^ Math.imul(index + 1, 0x9e3779b1)
  const next = () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ state >>> 15, 1 | state)
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value)
    return ((value ^ value >>> 14) >>> 0) / 4294967296
  }
  return [next(), next()]
}

/** Fits the entire watermark inside the image, including extreme icon aspect ratios. */
export function getWatermarkBounds(
  imageWidth: number,
  imageHeight: number,
  aspectRatio: number,
  settings: Pick<WatermarkSettings, 'position' | 'scale' | 'seed'>,
  index = 0,
): { x: number; y: number; width: number; height: number } {
  assertDimensions(imageWidth, imageHeight)
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) throw new Error('水印图标尺寸无效，请重新上传。')
  if (!Number.isFinite(settings.scale) || settings.scale < 0.05 || settings.scale > 0.6) throw new Error('水印大小应在 5% 至 60% 之间。')
  if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(settings.seed) || settings.seed < 0) throw new Error('随机位置设置无效，请重新随机一次。')
  const margin = Math.min(24, Math.min(imageWidth, imageHeight) * 0.035)
  const availableWidth = imageWidth - margin * 2
  const availableHeight = imageHeight - margin * 2
  const desiredWidth = imageWidth * settings.scale
  const width = Math.min(desiredWidth, availableWidth, availableHeight * aspectRatio)
  const height = width / aspectRatio
  let horizontal: number
  let vertical: number
  if (settings.position === 'random') {
    [horizontal, vertical] = randomCoordinates(settings.seed, index)
  } else {
    const positionIndex = WATERMARK_POSITIONS.findIndex(position => position.value === settings.position)
    if (positionIndex < 0) throw new Error('请选择有效的水印位置。')
    horizontal = (positionIndex % 3) / 2
    vertical = Math.floor(positionIndex / 3) / 2
  }
  return {
    x: margin + Math.max(0, availableWidth - width) * horizontal,
    y: margin + Math.max(0, availableHeight - height) * vertical,
    width, height,
  }
}

function inspectSignature(bytes: Uint8Array, allowGif = false): string {
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    if (!allowGif) throw new Error(GIF_ERROR)
    if (bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif'
    throw new Error('GIF 图片格式无效，请重新上传完整的 GIF 文件。')
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  throw new Error('图片格式无效，请使用 PNG、JPG 或 WebP 格式的图片。')
}

function assertEncodedDimensions(base64: string, type: string): void {
  // Read dimensions before creating an Image, avoiding huge allocations from highly compressed files.
  const bytes = atob(type === 'image/jpeg' ? base64 : base64.slice(0, 88))
  const byte = (offset: number) => bytes.charCodeAt(offset)
  const big16 = (offset: number) => byte(offset) * 256 + byte(offset + 1)
  const little24 = (offset: number) => byte(offset) + byte(offset + 1) * 256 + byte(offset + 2) * 65536
  const big32 = (offset: number) => byte(offset) * 16777216 + byte(offset + 1) * 65536 + byte(offset + 2) * 256 + byte(offset + 3)
  if (type === 'image/gif') {
    assertDimensions(byte(6) + byte(7) * 256, byte(8) + byte(9) * 256)
    return
  }
  if (type === 'image/png' && bytes.slice(12, 16) === 'IHDR') {
    assertDimensions(big32(16), big32(20))
    return
  }
  if (type === 'image/webp') {
    const chunk = bytes.slice(12, 16)
    if (chunk === 'VP8X') { assertDimensions(little24(24) + 1, little24(27) + 1); return }
    if (chunk === 'VP8 ' && bytes.slice(23, 26) === '\x9d\x01\x2a') {
      assertDimensions((byte(26) + byte(27) * 256) & 0x3fff, (byte(28) + byte(29) * 256) & 0x3fff)
      return
    }
    if (chunk === 'VP8L' && byte(20) === 0x2f) {
      const packed = byte(21) + byte(22) * 256 + byte(23) * 65536 + byte(24) * 16777216
      assertDimensions((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1)
      return
    }
  }
  if (type === 'image/jpeg') {
    let offset = 2
    while (offset < bytes.length) {
      if (byte(offset) !== 0xff) break
      while (byte(offset) === 0xff) offset += 1
      const marker = byte(offset++)
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      const length = big16(offset)
      if (!Number.isFinite(length) || length < 2 || offset + length > bytes.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        assertDimensions(big16(offset + 5), big16(offset + 3))
        return
      }
      offset += length
    }
  }
  throw new Error('图片尺寸信息无效，请重新导出为 PNG、JPG 或 WebP 后上传。')
}

/** Validates the declared format, file signature, base64 encoding and byte limit. */
export function validateWatermarkImageSource(source: string, maxBytes = MAX_SOURCE_BYTES): void {
  if (/^data:image\/gif[;,]/i.test(source)) throw new Error(GIF_ERROR)
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(source)
  if (!match || !match[2].length || match[2].length % 4 !== 0) throw new Error('图片数据无效，请重新上传 PNG、JPG 或 WebP 图片。')
  const padding = match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0
  if (match[2].length * 3 / 4 - padding > maxBytes) throw new Error(maxBytes === MAX_ICON_BYTES ? '水印图标不能超过 1 MB，请压缩后重试。' : '图片文件过大，请压缩至 12 MB 以内后重试。')
  const prefix = atob(match[2].slice(0, 32))
  const signature = inspectSignature(Uint8Array.from(prefix, character => character.charCodeAt(0)))
  if (signature !== match[1].toLowerCase()) throw new Error('图片格式与文件内容不一致，请重新上传 PNG、JPG 或 WebP 图片。')
  assertEncodedDimensions(match[2], signature)
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const timer = setTimeout(() => { cleanup(); reader.abort(); reject(new Error('图片读取超时，请重试。')) }, LOAD_TIMEOUT_MS)
    const cleanup = () => { clearTimeout(timer); reader.onload = null; reader.onerror = null; reader.onabort = null }
    reader.onload = () => {
      const result = reader.result
      cleanup()
      if (typeof result === 'string') resolve(result)
      else reject(new Error('图片读取失败，请重试。'))
    }
    reader.onerror = reader.onabort = () => { cleanup(); reject(new Error('图片读取失败，请重试。')) }
    try { reader.readAsDataURL(blob) } catch { cleanup(); reject(new Error('图片读取失败，请重试。')) }
  })
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    const timer = setTimeout(() => { cleanup(); image.src = ''; reject(new Error('图片加载超时，请检查网络或下载图片后重新上传。')) }, LOAD_TIMEOUT_MS)
    const cleanup = () => { clearTimeout(timer); image.onload = null; image.onerror = null }
    image.onload = () => {
      cleanup()
      try { assertDimensions(image.naturalWidth, image.naturalHeight); resolve(image) }
      catch (error) { image.src = ''; reject(error) }
    }
    image.onerror = () => { cleanup(); image.src = ''; reject(new Error('无法解码图片，请确认文件完整，并使用 PNG、JPG 或 WebP 格式。')) }
    image.src = source
  })
}

async function sourceDataUrl(source: string): Promise<string> {
  if (isLocalMediaReference(source)) {
    const resolved = await resolveImage(source)
    validateWatermarkImageSource(resolved)
    return resolved
  }
  if (source.startsWith('data:')) { validateWatermarkImageSource(source); return source }
  let url: URL
  try { url = new URL(source) } catch { throw new Error('图片链接无效，请重新上传图片或使用 http(s) 图片链接。') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('仅支持上传图片或使用 http(s) 图片链接。')
  if (/\.gif$/i.test(url.pathname)) throw new Error(GIF_ERROR)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS)
  try {
    let response: Response
    try { response = await fetch(url, { mode: 'cors', credentials: 'omit', signal: controller.signal }) }
    catch { throw new Error(controller.signal.aborted ? '图片下载超时，请下载图片后重新上传。' : '图片链接无法读取，可能被跨域权限限制，请下载图片后重新上传。') }
    if (!response.ok) throw new Error(`图片链接返回 ${response.status}，请检查链接或下载图片后重新上传。`)
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (type === 'image/gif') throw new Error(GIF_ERROR)
    if (Number(response.headers.get('content-length')) > MAX_SOURCE_BYTES) throw new Error('图片文件过大，请压缩至 12 MB 以内后重试。')
    if (!response.body) throw new Error('图片下载失败，请下载图片后重新上传。')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_SOURCE_BYTES) throw new Error('图片文件过大，请压缩至 12 MB 以内后重试。')
        chunks.push(value)
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      if (controller.signal.aborted) throw new Error('图片下载超时，请下载图片后重新上传。')
      throw error instanceof Error && !(error instanceof TypeError) ? error : new Error('图片下载失败，请检查网络或下载图片后重新上传。')
    } finally { reader.releaseLock() }
    const blob = new Blob(chunks)
    const signature = inspectSignature(new Uint8Array(await blob.slice(0, 12).arrayBuffer()))
    const source = await readBlob(new Blob(chunks, { type: signature }))
    validateWatermarkImageSource(source)
    return source
  } finally { clearTimeout(timer); controller.abort() }
}

export async function readWatermarkIcon(file: File): Promise<string> {
  if (file.type === 'image/gif' || /\.gif$/i.test(file.name)) throw new Error(GIF_ERROR)
  if (!SUPPORTED_TYPES.includes(file.type)) throw new Error('水印图标仅支持 PNG、JPG 或 WebP，推荐使用透明 PNG。')
  if (file.size > MAX_ICON_BYTES) throw new Error('水印图标不能超过 1 MB，请压缩后重试。')
  const source = await readBlob(file)
  validateWatermarkImageSource(source, MAX_ICON_BYTES)
  const image = await loadImage(source)
  image.src = ''
  return source
}

function validateGifSource(source: string): void {
  const match = /^data:image\/gif;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(source)
  if (!match || !match[1].length || match[1].length % 4 !== 0) throw new Error('GIF 图片数据无效，请重新上传完整的 GIF 文件。')
  const prefix = atob(match[1].slice(0, 32))
  if (inspectSignature(Uint8Array.from(prefix, character => character.charCodeAt(0)), true) !== 'image/gif') {
    throw new Error('GIF 图片格式与文件内容不一致，请重新上传。')
  }
  assertEncodedDimensions(match[1], 'image/gif')
}

/** A batch is validated up front, then processed sequentially; callers only receive a complete result. */
export async function readUploadedImages(files: File[], options: { forWatermark?: boolean } = {}): Promise<string[]> {
  const sources = [...files]
  const forWatermark = !!options.forWatermark
  const withIndex = (error: unknown, index: number) => new Error(`第 ${index + 1} 张图片：${error instanceof Error ? error.message : '图片处理失败，请重试。'}`)
  for (let index = 0; index < sources.length; index += 1) {
    const file = sources[index]
    try {
      if (forWatermark && file.type === 'image/gif') throw new Error(GIF_ERROR)
      if (!SUPPORTED_TYPES.includes(file.type) && file.type !== 'image/gif') throw new Error('仅支持 PNG、JPG、WebP 或 GIF 格式的图片。')
      if (file.type === 'image/gif' && file.size > MAX_OUTPUT_BYTES) throw new Error('GIF 图片不能超过 3 MB，请压缩 GIF 后重试；为保留动画，不会自动转换或缩小。')
      if (file.size > MAX_SOURCE_BYTES) throw new Error('图片文件过大，请压缩至 12 MB 以内后重试。')
    } catch (error) { throw withIndex(error, index) }
  }
  const results: string[] = []
  for (let index = 0; index < sources.length; index += 1) {
    try {
      const source = await readBlob(sources[index])
      const isGif = sources[index].type === 'image/gif'
      if (isGif) validateGifSource(source)
      else validateWatermarkImageSource(source)
      const image = await loadImage(source)
      let canvas: HTMLCanvasElement | undefined
      try {
        if (isGif || forWatermark) results.push(source)
        else {
          canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth
          canvas.height = image.naturalHeight
          const context = canvas.getContext('2d')
          if (!context) throw new Error('浏览器无法处理图片，请更换浏览器后重试。')
          context.drawImage(image, 0, 0)
          results.push(await exportImage(canvas))
        }
      } finally {
        image.src = ''
        if (canvas) { canvas.width = 0; canvas.height = 0 }
      }
    } catch (error) { throw withIndex(error, index) }
  }
  return results
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('图片导出超时，请缩小图片后重试。')), LOAD_TIMEOUT_MS)
    try {
      canvas.toBlob(blob => {
        clearTimeout(timer)
        if (blob) resolve(blob)
        else reject(new Error('图片导出失败，请缩小图片后重试。'))
      }, 'image/png')
    } catch { clearTimeout(timer); reject(new Error('图片无法处理，请下载图片后重新上传。')) }
  })
}

async function exportImage(canvas: HTMLCanvasElement): Promise<string> {
  // Always try lossless PNG at original resolution before reducing dimensions.
  let blob = await canvasBlob(canvas)
  let scale = 1
  let width = canvas.width
  let height = canvas.height
  for (let attempt = 0; blob.size > MAX_OUTPUT_BYTES && attempt < 8; attempt += 1) {
    const ratio = Math.min(0.85, Math.sqrt(MAX_OUTPUT_BYTES / blob.size) * 0.9)
    scale *= ratio
    const nextWidth = Math.max(1, Math.floor(canvas.width * scale))
    const nextHeight = Math.max(1, Math.floor(canvas.height * scale))
    if (nextWidth === width && nextHeight === height) break
    const reduced = document.createElement('canvas')
    reduced.width = nextWidth
    reduced.height = nextHeight
    try {
      const context = reduced.getContext('2d')
      if (!context) throw new Error('浏览器无法处理图片，请更换浏览器后重试。')
      context.imageSmoothingQuality = 'high'
      // Every attempt resamples the original rendering, avoiding cumulative blur.
      context.drawImage(canvas, 0, 0, nextWidth, nextHeight)
      blob = await canvasBlob(reduced)
    } finally { reduced.width = 0; reduced.height = 0 }
    width = nextWidth
    height = nextHeight
  }
  if (blob.size > MAX_OUTPUT_BYTES) throw new Error('处理后的图片仍超过 3 MB，请缩小原图后重试。')
  return readBlob(blob)
}

export async function renderWatermarkedImage(source: string, settings: WatermarkSettings, index = 0): Promise<string> {
  const error = validateWatermarkSettings(settings)
  if (error) throw new Error(error)
  // Snapshot controls before awaiting image I/O, so an in-flight render cannot mix settings.
  const options = { ...settings }
  const dataUrl = await sourceDataUrl(source)
  const image = await loadImage(dataUrl)
  const canvas = document.createElement('canvas')
  let icon: HTMLImageElement | undefined
  try {
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法处理图片，请更换浏览器后重试。')
    context.drawImage(image, 0, 0)
    context.globalAlpha = options.opacity
    if (options.mode === 'icon') {
      validateWatermarkImageSource(options.icon, MAX_ICON_BYTES)
      icon = await loadImage(options.icon)
      const bounds = getWatermarkBounds(canvas.width, canvas.height, icon.naturalWidth / icon.naturalHeight, options, index)
      context.drawImage(icon, bounds.x, bounds.y, bounds.width, bounds.height)
    } else {
      const label = `© ${options.text.trim()}`
      context.font = '500 100px system-ui, sans-serif'
      const virtualWidth = context.measureText(label).width + 96
      const virtualHeight = 164
      const bounds = getWatermarkBounds(canvas.width, canvas.height, virtualWidth / virtualHeight, options, index)
      context.save()
      context.translate(bounds.x, bounds.y)
      context.scale(bounds.width / virtualWidth, bounds.height / virtualHeight)
      context.beginPath()
      context.roundRect(0, 0, virtualWidth, virtualHeight, virtualHeight / 2)
      context.fillStyle = 'rgba(15, 23, 42, 0.72)'
      context.fill()
      context.fillStyle = '#ffffff'
      context.textBaseline = 'middle'
      context.textAlign = 'center'
      context.fillText(label, virtualWidth / 2, virtualHeight / 2)
      context.restore()
    }
    return await exportImage(canvas)
  } finally {
    image.src = ''
    if (icon) icon.src = ''
    canvas.width = 0
    canvas.height = 0
  }
}

/** The caller only receives results after every image succeeds; inputs are never mutated. */
export async function applyWatermarks(images: string[], settings: WatermarkSettings): Promise<string[]> {
  const error = validateWatermarkSettings(settings)
  if (error) throw new Error(error)
  const sources = [...images]
  const options = { ...settings }
  const results: string[] = []
  for (let index = 0; index < sources.length; index += 1) {
    try { results.push(await renderWatermarkedImage(sources[index], options, index)) }
    catch (error) { throw new Error(`第 ${index + 1} 张图片：${error instanceof Error ? error.message : '添加水印失败，请重试。'}`) }
  }
  return results
}
