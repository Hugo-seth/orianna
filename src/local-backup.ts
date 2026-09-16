import { parseContentImport } from './model.ts'
import type { ContentItem } from './model.ts'
import { parseWatermarkPreferences } from './watermark-preferences.ts'
import type { WatermarkPreferencesRecord } from './watermark-preferences.ts'
import { validateWatermarkImageSource } from './watermark.ts'
import { resolveImage } from './local-storage.ts'

export const MAX_LOCAL_BACKUP_BYTES = 256 * 1024 * 1024
const MAX_RECORDS = 10_000
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_IMAGE_REFERENCES = 100_000
const MEDIA_REFERENCE = /^\/api\/media\/([a-f0-9]{64})\.(png|jpg|webp|gif)$/
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

export interface LocalBackup {
  app: '发条'
  version: 3
  exportedAt: string
  content: ContentItem[]
  assets: string[]
  watermark: WatermarkPreferencesRecord
  media: Record<string, string>
}

export interface ParsedLocalBackup {
  items: ContentItem[]
  assets?: string[]
  watermark?: WatermarkPreferencesRecord
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertSize(value: unknown): void {
  let serialized: string | undefined
  try { serialized = JSON.stringify(value) } catch { throw new Error('备份格式无效，无法读取。') }
  if (serialized === undefined) throw new Error('备份格式无效，无法读取。')
  if (serialized.length > MAX_LOCAL_BACKUP_BYTES || new TextEncoder().encode(serialized).byteLength > MAX_LOCAL_BACKUP_BYTES) {
    throw new Error('备份不能超过 256 MB，请减少素材后重试。')
  }
}

function assertCounts(items: ContentItem[], assets: unknown): asserts assets is string[] {
  if (items.length > MAX_RECORDS || !Array.isArray(assets) || assets.length > MAX_RECORDS || !assets.every(source => typeof source === 'string')) {
    throw new Error('备份的内容或素材列表无效，每类最多支持 10000 条。')
  }
  if (items.reduce((count, item) => count + item.images.length + 1, assets.length) > MAX_IMAGE_REFERENCES) {
    throw new Error('备份中的图片引用过多，请分批导出。')
  }
}

function dataImage(source: string): { bytes: Uint8Array; extension: string } {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(source)
  if (!match || match[2].length % 4 !== 0) throw new Error('备份包含无效的图片数据。')
  const base64 = match[2]
  const size = base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
  if (size > MAX_IMAGE_BYTES) throw new Error('备份中的单张图片不能超过 12 MB。')
  let binary: string
  try { binary = atob(base64) } catch { throw new Error('备份包含无效的图片编码。') }
  if (btoa(binary) !== base64) throw new Error('备份包含无效的图片编码。')
  const mime = match[1].toLowerCase()
  if (mime === 'image/gif') {
    if (!/^GIF8[79]a/.test(binary) || binary.length < 14 || binary.charCodeAt(binary.length - 1) !== 0x3b) {
      throw new Error('备份中的 GIF 图片不完整。')
    }
    const width = binary.charCodeAt(6) + binary.charCodeAt(7) * 256
    const height = binary.charCodeAt(8) + binary.charCodeAt(9) * 256
    if (!width || !height || width > 8192 || height > 8192 || width * height > 16_000_000) throw new Error('备份中的 GIF 图片尺寸无效。')
  } else {
    validateWatermarkImageSource(source, MAX_IMAGE_BYTES)
  }
  return { bytes: Uint8Array.from(binary, character => character.charCodeAt(0)), extension: EXTENSIONS[mime] }
}

async function mediaReference(source: string): Promise<string> {
  const { bytes, extension } = dataImage(source)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  return `/api/media/${hash}.${extension}`
}

function externalImage(source: string): void {
  let url: URL
  try { url = new URL(source) } catch { throw new Error('备份包含无效的图片链接或本地素材引用。') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || source.length > 16_384) {
    throw new Error('备份中的图片链接必须使用有效的 HTTP 或 HTTPS 地址。')
  }
}

function imageSources(items: ContentItem[], assets: string[], icon: string): string[] {
  return [...new Set([...items.flatMap(item => [item.image, ...item.images]), ...assets, icon].filter(Boolean))]
}

function mapItems(items: ContentItem[], convert: (source: string) => string): ContentItem[] {
  return items.map(item => ({ ...item, image: item.image ? convert(item.image) : '', images: item.images.map(convert) }))
}

function rawWatermark(value: unknown): Record<string, unknown> & { settings: Record<string, unknown> & { icon: string } } {
  if (!object(value) || !object(value.settings) || typeof value.settings.icon !== 'string') throw new Error('备份中的水印设置格式无效。')
  return value as Record<string, unknown> & { settings: Record<string, unknown> & { icon: string } }
}

/** Includes each local image once; remote URLs remain URLs and are never downloaded. */
export async function createLocalBackup(content: ContentItem[], assets: string[], watermark: WatermarkPreferencesRecord): Promise<LocalBackup> {
  const items = parseContentImport(content)
  if (!items) throw new Error('当前内容格式无效，无法导出备份。')
  assertCounts(items, assets)
  const raw = rawWatermark(watermark)
  const sources = imageSources(items, assets, raw.settings.icon)
  const replacements = new Map<string, string>()
  const media: Record<string, string> = {}
  let embeddedSize = 0
  let mediaCount = 0
  for (const source of sources) {
    if (!source.startsWith('data:') && !MEDIA_REFERENCE.test(source)) { externalImage(source); replacements.set(source, source); continue }
    const data = MEDIA_REFERENCE.test(source) ? await resolveImage(source) : source
    const reference = await mediaReference(data)
    if (MEDIA_REFERENCE.test(source) && reference !== source) throw new Error('本地素材与文件校验值不一致，无法导出备份。')
    if (!Object.hasOwn(media, reference)) {
      embeddedSize += data.length
      mediaCount += 1
      if (embeddedSize > MAX_LOCAL_BACKUP_BYTES || mediaCount > MAX_RECORDS) throw new Error('备份中的素材过多或超过 256 MB，请分批导出。')
      media[reference] = data
    }
    replacements.set(source, reference)
  }
  const convert = (source: string) => {
    const replacement = replacements.get(source)
    if (replacement === undefined) throw new Error('备份包含空的图片引用。')
    return replacement
  }
  const icon = raw.settings.icon ? convert(raw.settings.icon) : ''
  const parsedWatermark = parseWatermarkPreferences({ ...raw, settings: { ...raw.settings, icon: icon ? media[icon] ?? icon : '' } })
  const backup: LocalBackup = {
    app: '发条', version: 3, exportedAt: new Date().toISOString(),
    content: mapItems(items, convert), assets: assets.map(convert),
    watermark: { ...parsedWatermark, settings: { ...parsedWatermark.settings, icon } }, media,
  }
  assertSize(backup)
  return backup
}

/** Validates and hydrates embedded files without fetching or modifying the local server. */
export async function parseLocalBackup(value: unknown): Promise<ParsedLocalBackup> {
  assertSize(value)
  const versioned = object(value) && Object.hasOwn(value, 'version') && value.app === '发条'
  if (versioned && value.version !== 3) throw new Error('不支持此备份版本，请使用当前控制台导出的备份。')
  const modern = versioned && value.version === 3
  if (modern && (typeof value.exportedAt !== 'string' || !Number.isFinite(Date.parse(value.exportedAt)))) throw new Error('备份的导出时间无效。')
  const items = parseContentImport(value)
  if (!items) throw new Error('备份格式无效或包含不完整的发布记录。')
  const assets = modern ? value.assets : []
  assertCounts(items, assets)
  const raw = modern ? rawWatermark(value.watermark) : undefined
  const media = modern ? value.media : {}
  if (!object(media) || Object.keys(media).length > MAX_RECORDS) throw new Error('备份中的素材数据表无效或数量过多。')
  const checkedMedia = new Map<string, string>()
  for (const [reference, data] of Object.entries(media)) {
    if (!MEDIA_REFERENCE.test(reference) || typeof data !== 'string' || !data.startsWith('data:')) throw new Error('备份包含无效的本地素材引用。')
    if (await mediaReference(data) !== reference) throw new Error('备份中的素材校验失败，文件内容可能已损坏。')
    checkedMedia.set(reference, data)
  }
  const replacements = new Map<string, string>()
  for (const source of imageSources(items, assets, raw?.settings.icon ?? '')) {
    if (MEDIA_REFERENCE.test(source)) {
      const embedded = checkedMedia.get(source)
      if (!embedded) throw new Error('备份缺少本地素材的图片数据，无法在其他设备恢复。')
      replacements.set(source, embedded)
    } else if (source.startsWith('data:')) {
      dataImage(source)
      replacements.set(source, source)
    } else {
      externalImage(source)
      replacements.set(source, source)
    }
  }
  const convert = (source: string) => {
    const replacement = replacements.get(source)
    if (replacement === undefined) throw new Error('备份包含空的图片引用。')
    return replacement
  }
  const result: ParsedLocalBackup = { items: mapItems(items, convert) }
  if (modern && raw) {
    result.assets = assets.map(convert)
    result.watermark = parseWatermarkPreferences({ ...raw, settings: { ...raw.settings, icon: raw.settings.icon ? convert(raw.settings.icon) : '' } })
  }
  return result
}
