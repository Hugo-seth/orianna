export type PlatformId = 'xiaohongshu' | 'douyin' | 'weibo' | 'bilibili'

export type ContentStatus = 'draft' | 'scheduled' | 'published'

export interface WeiboReceipt {
  id: string
  url: string
  publishedAt: string
  account: { uid: string; name: string }
  requestId: string
  /** Included when a receipt is recovered from the local platform ledger. */
  contentId?: string
  updatedAt?: string
  deletedAt?: string
  lastOperation?: PlatformOperation
}

export interface PlatformOperation {
  requestId: string
  type: 'update' | 'delete'
  title?: string
  body?: string
}

export interface PlatformLifecycle {
  operation: 'update' | 'delete'
  requestId: string
  state: 'pending' | 'uncertain'
  title?: string
  body?: string
}

export interface PlatformReceipt extends WeiboReceipt {
  platform: PlatformId
}

export interface PlatformPublication {
  requestId: string
  state: 'pending' | 'uncertain' | 'published'
  expectedAccountUid?: string
  receipt?: PlatformReceipt
  recoveredFromReceipt?: boolean
  lifecycle?: PlatformLifecycle
}

export interface ContentItem {
  id: string
  title: string
  body: string
  image: string
  images: string[]
  platforms: PlatformId[]
  status: ContentStatus
  scheduledAt?: string
  publishedAt?: string
  updatedAt: string
  category: string
  views?: number
  likes?: number
  weiboReceipt?: WeiboReceipt
  weiboRequestId?: string
  weiboPublishState?: 'pending' | 'uncertain'
  publishMode?: 'demo' | 'weibo' | 'real'
  platformPublications?: Partial<Record<PlatformId, PlatformPublication>>
}

export interface Platform {
  id: PlatformId
  name: string
  shortName: string
  color: string
  account: string
}

export const PLATFORMS: Platform[] = [
  { id: 'xiaohongshu', name: '小红书', shortName: '小红书', color: '#f04452', account: '' },
  { id: 'douyin', name: '抖音图文', shortName: '抖音', color: '#25272c', account: '' },
  { id: 'weibo', name: '微博', shortName: '微博', color: '#ed7b3d', account: '' },
  { id: 'bilibili', name: 'B站动态', shortName: 'B站', color: '#69a9c6', account: '' },
]

export const DEMO_DATA_NOTICE = '初始内容仅为可编辑草稿；只有平台确认的内容才会标记为已发布。'
export const CONTENT_STORAGE_KEY = 'fatiao.content.v1'

const photo = (id: string) => `https://images.unsplash.com/${id}?w=1000&auto=format&fit=crop&q=85`

const photos = {
  cafe: photo('photo-1442512595331-e89e73853f31'),
  forest: photo('photo-1448375240586-882707db888b'),
  home: photo('photo-1449247709967-d4461a6a6103'),
  city: photo('photo-1511818966892-d7d671e672a2'),
  journal: photo('photo-1456324504439-367cee3b3c32'),
  sea: photo('photo-1507525428034-b723cf961d3e'),
  tea: photo('photo-1544787219-7f47ccb76574'),
  autumn: photo('photo-1476820865390-c52aeebb9891'),
  house: photo('photo-1494526585095-c41746248156'),
}

/** Starter writing samples are drafts and never claim a platform publication or engagement. */
export const SEED_CONTENT: ContentItem[] = [
  {
    id: 'demo-cafe',
    title: '把周末，留给一杯咖啡',
    body: '走进巷子深处的小店，找个有阳光的位置。\n\n咖啡慢慢喝，书慢慢翻，今天的待办只有一件事：好好感受生活。你也有一家愿意反复去的咖啡馆吗？\n\n#周末日常 #咖啡探店 #慢生活',
    image: photos.cafe,
    images: [photos.cafe],
    platforms: ['xiaohongshu', 'douyin', 'weibo'],
    status: 'draft',
    updatedAt: '2026-09-13T10:30:00+08:00',
    category: '生活方式',
  },
  {
    id: 'demo-forest',
    title: '去山里，给自己放个空',
    body: '这周的绿色电量，来自山里。\n\n走过有苔藓的小径，听见风穿过树梢。没有赶路，也没有计划，只想多吸一口带着草木味道的空气。\n\n#山野漫游 #户外日常 #去自然里充电',
    image: photos.forest,
    images: [photos.forest, photos.autumn],
    platforms: ['xiaohongshu', 'bilibili'],
    status: 'draft',
    updatedAt: '2026-09-14T09:20:00+08:00',
    category: '旅行日记',
  },
  {
    id: 'demo-home',
    title: '我的一平方米治愈角落',
    body: '重新整理了窗边的小角落。\n\n一张木桌、几本常翻的书，再放一盆绿植。让光线成为房间的主角，也给忙碌的日子留一点呼吸的空间。\n\n#居家灵感 #我的书桌 #日常美学',
    image: photos.home,
    images: [photos.home],
    platforms: ['xiaohongshu', 'douyin'],
    status: 'draft',
    updatedAt: '2026-09-14T08:45:00+08:00',
    category: '空间灵感',
  },
  {
    id: 'demo-city',
    title: '在熟悉的城市，散一次新步',
    body: '把导航收起来，跟着喜欢的光影拐弯。\n\n发现了一面旧墙、一扇好看的窗，还有一家从来没注意过的小店。原来生活半径不需要变大，眼睛可以更好奇一点。\n\n#城市漫游 #街角风景 #CityWalk',
    image: photos.city,
    images: [photos.city, photos.house],
    platforms: ['xiaohongshu', 'weibo', 'bilibili'],
    status: 'draft',
    updatedAt: '2026-09-12T18:00:00+08:00',
    category: '城市漫游',
  },
  {
    id: 'demo-journal',
    title: '九月，把喜欢的事写下来',
    body: '给九月开了一页新的手帐。\n\n读完一本书，寄出一张明信片，记住一顿好吃的饭。不一定每天都有大事发生，但小小的快乐值得留下。\n\n#九月手帐 #读书日常 #纸笔之间',
    image: photos.journal,
    images: [photos.journal],
    platforms: ['xiaohongshu', 'weibo'],
    status: 'draft',
    updatedAt: '2026-09-13T16:10:00+08:00',
    category: '读书手帐',
  },
  {
    id: 'demo-sea',
    title: '收集一片蓝，寄给忙碌的你',
    body: '海边没有标准答案。\n\n只要脱下鞋子，沿着潮水慢慢走，就能把心里的声音听得更清楚。拍下这一片蓝，希望你今天也有一个轻盈的瞬间。\n\n#海边日记 #旅行碎片 #治愈风景',
    image: photos.sea,
    images: [photos.sea],
    platforms: ['xiaohongshu', 'douyin', 'bilibili'],
    status: 'draft',
    updatedAt: '2026-09-10T12:30:00+08:00',
    category: '旅行日记',
  },
  {
    id: 'demo-tea',
    title: '生活的暂停键，是一杯热茶',
    body: '下午四点，暂时把消息提醒关掉。\n\n给自己泡一杯茶，看茶叶舒展开来。十分钟就好，把注意力还给当下，也还给自己。\n\n#一人食光 #喝茶日常 #生活碎片',
    image: photos.tea,
    images: [photos.tea],
    platforms: ['weibo', 'bilibili'],
    status: 'draft',
    updatedAt: '2026-09-09T16:00:00+08:00',
    category: '生活方式',
  },
  {
    id: 'demo-autumn',
    title: '秋天的第一场散步',
    body: '风里开始有一点秋天的味道。\n\n准备带着相机去公园，捡一片好看的叶子，记录树木慢慢换颜色的过程。把季节的变化，收进自己的日常里。\n\n#秋日计划 #自然观察 #散步日记',
    image: photos.autumn,
    images: [photos.autumn],
    platforms: ['xiaohongshu', 'douyin', 'weibo'],
    status: 'draft',
    updatedAt: '2026-09-13T20:00:00+08:00',
    category: '生活方式',
  },
  {
    id: 'demo-house',
    title: '想住进这样的绿色里',
    body: '收藏一些让人心动的小房子。\n\n喜欢被树包围的窗，门前自然生长的植物，还有不需要刻意装饰的安静。下次旅行，想在这样的地方多住两天。\n\n#理想居所 #空间灵感 #绿色生活',
    image: photos.house,
    images: [photos.house, photos.forest],
    platforms: ['xiaohongshu', 'bilibili'],
    status: 'draft',
    updatedAt: '2026-09-12T15:40:00+08:00',
    category: '空间灵感',
  },
]

const platformIds = new Set<string>(PLATFORMS.map(({ id }) => id))
const statuses = new Set<string>(['draft', 'scheduled', 'published'])
const isTimestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

function isOperation(value: unknown): value is PlatformOperation {
  return isRecord(value) && typeof value.requestId === 'string' && value.requestId.length > 0 &&
    ['update', 'delete'].includes(value.type as string) &&
    (value.title === undefined || typeof value.title === 'string') &&
    (value.body === undefined || typeof value.body === 'string')
}

function isLifecycle(value: unknown): value is PlatformLifecycle {
  return isRecord(value) && typeof value.requestId === 'string' && value.requestId.length > 0 &&
    ['update', 'delete'].includes(value.operation as string) && ['pending', 'uncertain'].includes(value.state as string) &&
    (value.title === undefined || typeof value.title === 'string') &&
    (value.body === undefined || typeof value.body === 'string')
}

function isReceipt(value: unknown, platform?: PlatformId): value is WeiboReceipt {
  if (!isRecord(value)) return false
  const account = value.account
  return typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.requestId === 'string' && value.requestId.length > 0 &&
    (value.contentId === undefined || typeof value.contentId === 'string' && value.contentId.length > 0) &&
    typeof value.url === 'string' && /^https?:\/\//.test(value.url) &&
    isTimestamp(value.publishedAt) &&
    (value.updatedAt === undefined || (isTimestamp(value.updatedAt) && Date.parse(value.updatedAt) >= Date.parse(value.publishedAt))) &&
    (value.deletedAt === undefined || (isTimestamp(value.deletedAt) && Date.parse(value.deletedAt) >= Date.parse(value.updatedAt as string || value.publishedAt))) &&
    (value.lastOperation === undefined || (isOperation(value.lastOperation) &&
      (value.lastOperation.type === 'update' ? isTimestamp(value.updatedAt) && value.deletedAt === undefined : isTimestamp(value.deletedAt)))) &&
    isRecord(account) && typeof account.uid === 'string' && account.uid.length > 0 && typeof account.name === 'string' &&
    (platform === undefined || value.platform === platform)
}

function isPublications(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([platform, publication]) => {
    if (!platformIds.has(platform) || !isRecord(publication)) return false
    return typeof publication.requestId === 'string' && publication.requestId.length > 0 &&
      ['pending', 'uncertain', 'published'].includes(publication.state as string) &&
      (publication.expectedAccountUid === undefined || (typeof publication.expectedAccountUid === 'string' && publication.expectedAccountUid.length > 0)) &&
      (publication.recoveredFromReceipt === undefined || typeof publication.recoveredFromReceipt === 'boolean') &&
      (publication.receipt === undefined || (isReceipt(publication.receipt, platform as PlatformId) &&
        publication.receipt.requestId === publication.requestId &&
        (publication.expectedAccountUid === undefined || publication.receipt.account.uid === publication.expectedAccountUid))) &&
      (publication.state !== 'published' || publication.receipt !== undefined) &&
      (publication.lifecycle === undefined || (isLifecycle(publication.lifecycle) && publication.receipt !== undefined))
  })
}

function isContentItem(value: unknown): value is ContentItem {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.title === 'string' && typeof value.body === 'string' && typeof value.image === 'string' &&
    Array.isArray(value.images) && value.images.every(image => typeof image === 'string') &&
    Array.isArray(value.platforms) && value.platforms.every(id => typeof id === 'string' && platformIds.has(id)) &&
    new Set(value.platforms).size === value.platforms.length &&
    typeof value.status === 'string' && statuses.has(value.status) && isTimestamp(value.updatedAt) &&
    typeof value.category === 'string' &&
    (value.scheduledAt === undefined || isTimestamp(value.scheduledAt)) &&
    (value.publishedAt === undefined || isTimestamp(value.publishedAt)) &&
    (value.views === undefined || (typeof value.views === 'number' && Number.isFinite(value.views) && value.views >= 0)) &&
    (value.likes === undefined || (typeof value.likes === 'number' && Number.isFinite(value.likes) && value.likes >= 0)) &&
    (value.publishMode === undefined || ['demo', 'weibo', 'real'].includes(value.publishMode as string)) &&
    (value.weiboReceipt === undefined || isReceipt(value.weiboReceipt)) &&
    (value.weiboRequestId === undefined || (typeof value.weiboRequestId === 'string' && value.weiboRequestId.length > 0)) &&
    (value.weiboPublishState === undefined || (['pending', 'uncertain'].includes(value.weiboPublishState as string) && typeof value.weiboRequestId === 'string')) &&
    (value.platformPublications === undefined || isPublications(value.platformPublications))
}

function cloneItems(items: ContentItem[]): ContentItem[] { return structuredClone(items) }
function latestTimestamp(values: (string | undefined)[]): string | undefined {
  return values.filter(isTimestamp).reduce<string | undefined>((latest, value) => !latest || Date.parse(value) > Date.parse(latest) ? value : latest, undefined)
}
function receiptVersion(receipt?: PlatformReceipt): number {
  return receipt ? Date.parse(latestTimestamp([receipt.publishedAt, receipt.updatedAt, receipt.deletedAt])!) : -Infinity
}
function sameReceiptIdentity(a: PlatformReceipt, b: PlatformReceipt): boolean {
  return a.platform === b.platform && a.requestId === b.requestId && a.id === b.id && a.account.uid === b.account.uid
}

/** Confirmed deletion is terminal, even when a stale response claims a later update. */
function mergeReceipt(latest: PlatformReceipt, proposed: PlatformReceipt): PlatformReceipt {
  if (!sameReceiptIdentity(latest, proposed)) return latest
  if (latest.deletedAt) {
    if (!proposed.deletedAt || receiptVersion(proposed) <= receiptVersion(latest)) return latest
    return { ...proposed, deletedAt: latest.deletedAt, publishedAt: latest.publishedAt }
  }
  if (proposed.deletedAt || receiptVersion(proposed) > receiptVersion(latest)) return { ...proposed, publishedAt: latest.publishedAt }
  return latest
}

function operationConfirms(receipt: PlatformReceipt | undefined, lifecycle: PlatformLifecycle): boolean {
  const operation = receipt?.lastOperation
  return Boolean(operation && operation.requestId === lifecycle.requestId && operation.type === lifecycle.operation &&
    (operation.type === 'delete' ? receipt?.deletedAt : receipt?.updatedAt))
}

function mergePublication(latest: PlatformPublication, proposed: PlatformPublication): PlatformPublication {
  if (latest.requestId !== proposed.requestId) return latest
  const uids = [latest.expectedAccountUid, latest.receipt?.account.uid, proposed.expectedAccountUid, proposed.receipt?.account.uid].filter((uid): uid is string => Boolean(uid))
  if (new Set(uids).size > 1) return latest
  if (latest.receipt && proposed.receipt && !sameReceiptIdentity(latest.receipt, proposed.receipt)) return latest
  const receipt = latest.receipt && proposed.receipt ? mergeReceipt(latest.receipt, proposed.receipt) : latest.receipt ?? proposed.receipt
  let lifecycle = latest.lifecycle
  if (lifecycle && operationConfirms(receipt, lifecycle)) lifecycle = undefined
  if (proposed.lifecycle && !operationConfirms(receipt, proposed.lifecycle)) {
    if (lifecycle?.requestId === proposed.lifecycle.requestId && lifecycle.operation === proposed.lifecycle.operation) {
      // The submitted text is immutable while this exact operation is uncertain.
      if (proposed.lifecycle.state === 'uncertain') lifecycle = { ...lifecycle, state: 'uncertain' }
    } else if (!lifecycle && !receipt?.deletedAt && receiptVersion(proposed.receipt) >= receiptVersion(latest.receipt)) {
      lifecycle = proposed.lifecycle
    }
  }
  const rank = (publication: PlatformPublication) => publication.state === 'uncertain' ? 2 : 1
  const state = receipt ? 'published' : rank(proposed) > rank(latest) ? proposed.state : latest.state
  return { ...latest, state, ...(uids[0] ? { expectedAccountUid: uids[0] } : {}),
    ...(receipt ? { receipt } : {}), ...(lifecycle ? { lifecycle } : latest.lifecycle ? { lifecycle: undefined } : {}),
    ...(latest.recoveredFromReceipt || proposed.recoveredFromReceipt ? { recoveredFromReceipt: true } : {}) }
}

/** Compatibility is resolved here, so legacy Weibo requests stay protected. */
export function getPublications(item?: ContentItem): Partial<Record<PlatformId, PlatformPublication>> {
  if (!item) return {}
  const publications = structuredClone(item.platformPublications ?? {})
  for (const platform of Object.keys(publications) as PlatformId[]) {
    const publication = publications[platform]!
    if (publication.receipt) publications[platform] = { ...publication, state: 'published' }
  }
  if (item.weiboReceipt) {
    const legacy: PlatformPublication = { requestId: item.weiboReceipt.requestId, state: 'published', expectedAccountUid: item.weiboReceipt.account.uid, receipt: { ...item.weiboReceipt, platform: 'weibo' } }
    publications.weibo = publications.weibo?.receipt ? mergePublication(publications.weibo, legacy) : legacy
  } else if (item.weiboPublishState && item.weiboRequestId) {
    const legacy: PlatformPublication = { requestId: item.weiboRequestId, state: item.weiboPublishState }
    publications.weibo = publications.weibo ? mergePublication(publications.weibo, legacy) : legacy
  }
  return publications
}

/** Publication metadata always protects the original from ordinary draft editing. */
export function isPublicationLocked(item?: ContentItem): boolean {
  return Object.keys(getPublications(item)).length > 0
}

/** The server deletion-status check is also required before removing a record. */
export function isContentDeletionLocked(item?: ContentItem): boolean {
  return Object.values(getPublications(item)).some(publication => Boolean(publication &&
    (publication.lifecycle || publication.state !== 'published' || !publication.receipt?.deletedAt)))
}

function applyPublications(item: ContentItem, publications: Partial<Record<PlatformId, PlatformPublication>>): ContentItem {
  const receipts = Object.values(publications).flatMap(publication => publication?.receipt ? [publication.receipt] : [])
  const complete = item.platforms.length > 0 && item.platforms.every(platform => Boolean(publications[platform]?.receipt))
  const weibo = publications.weibo
  return {
    ...item, platformPublications: publications,
    status: complete ? 'published' : 'draft', publishMode: 'real', scheduledAt: undefined,
    publishedAt: complete ? latestTimestamp(receipts.map(receipt => receipt.publishedAt)) : undefined,
    updatedAt: latestTimestamp([item.updatedAt, ...receipts.flatMap(receipt => [receipt.publishedAt, receipt.updatedAt, receipt.deletedAt])])!,
    views: undefined, likes: undefined,
    ...(weibo ? { weiboRequestId: weibo.requestId, weiboReceipt: weibo.receipt, weiboPublishState: weibo.state === 'published' ? undefined : weibo.state } : {}),
  }
}

export function stagePlatformLifecycle(item: ContentItem, platform: PlatformId, lifecycle: PlatformLifecycle): ContentItem {
  const publications = getPublications(item)
  const publication = publications[platform]
  if (!isLifecycle(lifecycle) || !publication?.receipt || publication.receipt.deletedAt) return item
  if (publication.lifecycle && (publication.lifecycle.requestId !== lifecycle.requestId || publication.lifecycle.operation !== lifecycle.operation)) return item
  if (operationConfirms(publication.receipt, lifecycle)) return item
  publications[platform] = mergePublication(publication, { ...publication, lifecycle: structuredClone(lifecycle) })
  return { ...item, platformPublications: publications }
}

export function withPlatformReceipt(item: ContentItem, receipt: PlatformReceipt): ContentItem {
  if (!platformIds.has(receipt.platform) || !isReceipt(receipt, receipt.platform)) return item
  const publications = getPublications(item)
  const previous = publications[receipt.platform]
  if (!previous || previous.requestId !== receipt.requestId) return item
  if (previous.expectedAccountUid && previous.expectedAccountUid !== receipt.account.uid) return item
  const merged = mergePublication(previous, { requestId: receipt.requestId, state: 'published', expectedAccountUid: receipt.account.uid, receipt })
  if (JSON.stringify(merged) === JSON.stringify(previous)) return item
  publications[receipt.platform] = merged
  return applyPublications(item, publications)
}

/** Server receipts can restore metadata for an existing record; they do not create deleted records. */
export function recoverPlatformReceipt(item: ContentItem, receipt: PlatformReceipt): ContentItem {
  if (knownDeletedIds().has(item.id) || !platformIds.has(receipt.platform) || !isReceipt(receipt, receipt.platform)) return item
  const publications = getPublications(item)
  if (publications[receipt.platform]) return withPlatformReceipt(item, receipt)
  return withPlatformReceipt({ ...item, platformPublications: { ...publications, [receipt.platform]: {
    requestId: receipt.requestId, expectedAccountUid: receipt.account.uid, state: 'pending', recoveredFromReceipt: true,
  } } }, receipt)
}

/** Merge under the storage lock, preserving newer platform versions and terminal tombstones. */
export function reconcileContentSnapshots(proposed: ContentItem[], latest: ContentItem[], deletedIds = knownDeletedIds()): ContentItem[] {
  const latestById = new Map(latest.map(item => [item.id, item]))
  const proposedIds = new Set(proposed.map(item => item.id))
  const reconciled = proposed.filter(item => !deletedIds.has(item.id)).map(item => {
    const stored = latestById.get(item.id)
    if (!stored) return item
    if (!isPublicationLocked(stored)) {
      return !isPublicationLocked(item) && Date.parse(stored.updatedAt) > Date.parse(item.updatedAt) ? stored : item
    }
    const publications = getPublications(stored)
    for (const [platform, publication] of Object.entries(getPublications(item)) as [PlatformId, PlatformPublication][]) {
      const previous = publications[platform]
      if (previous) publications[platform] = mergePublication(previous, publication)
      else if (stored.platforms.includes(platform)) publications[platform] = publication
    }
    return applyPublications(stored, publications)
  })
  for (const item of latest) if (!deletedIds.has(item.id) && !proposedIds.has(item.id) && isContentDeletionLocked(item)) reconciled.push(item)
  return cloneItems(reconciled)
}

/** Stored pending state is authoritative; confirmed memory receipts may only advance it. */
export function syncStoredContent(inMemory: ContentItem[], stored: ContentItem[]): ContentItem[] {
  const deletedIds = knownDeletedIds()
  const memoryById = new Map(inMemory.map(item => [item.id, item]))
  const receiptSnapshot = (item: ContentItem): ContentItem | undefined => {
    const publications = Object.fromEntries(Object.entries(getPublications(item)).filter(([, publication]) => publication?.receipt)
      .map(([platform, publication]) => [platform, { ...publication, lifecycle: undefined }])) as ContentItem['platformPublications']
    if (!publications || !Object.keys(publications).length) return undefined
    return { ...item, platformPublications: publications, weiboReceipt: publications.weibo?.receipt, weiboRequestId: publications.weibo?.requestId, weiboPublishState: undefined }
  }
  const next = stored.filter(item => !deletedIds.has(item.id)).map(latest => {
    const memory = memoryById.get(latest.id)
    const confirmed = memory && receiptSnapshot(memory)
    return confirmed ? reconcileContentSnapshots([confirmed], [latest])[0] : structuredClone(latest)
  })
  const storedIds = new Set(stored.map(item => item.id))
  for (const item of inMemory) {
    if (storedIds.has(item.id) || deletedIds.has(item.id)) continue
    const confirmed = receiptSnapshot(item)
    if (confirmed && isContentDeletionLocked(confirmed)) next.push(structuredClone(confirmed))
  }
  return next
}

export function duplicateContent(item: ContentItem): ContentItem {
  return { ...structuredClone(item), id: makeId(), title: `${item.title} · 副本`, status: 'draft', scheduledAt: undefined, publishedAt: undefined, updatedAt: new Date().toISOString(), views: undefined, likes: undefined, weiboReceipt: undefined, weiboRequestId: undefined, weiboPublishState: undefined, platformPublications: undefined, publishMode: undefined }
}

/** Legacy simulated successes become editable drafts; genuine receipts and pending requests survive. */
function migrateContent(item: ContentItem): ContentItem {
  const copy = structuredClone(item)
  const publications = getPublications(copy)
  if (Object.keys(publications).length) {
    if (Object.values(publications).some(publication => publication?.receipt)) return applyPublications(copy, publications)
    copy.status = 'draft'
    delete copy.publishedAt
    delete copy.views
    delete copy.likes
    if (copy.publishMode === 'demo') copy.publishMode = 'real'
    return copy
  }
  if (copy.status === 'published' || copy.publishMode === 'demo' || copy.id.startsWith('demo-')) {
    copy.status = copy.status === 'scheduled' ? 'scheduled' : 'draft'
    delete copy.publishedAt
    delete copy.views
    delete copy.likes
    delete copy.publishMode
  }
  return copy
}

export interface StoredEnvelope { version: 2; items: ContentItem[]; deletedContentIds: string[] }
export function parseContentEnvelope(value: unknown): StoredEnvelope | undefined {
  const candidate = Array.isArray(value) ? { items: value, deletedContentIds: [] } : value
  if (!isRecord(candidate) || (!Array.isArray(value) && candidate.version !== 2) ||
    !Array.isArray(candidate.items) || !candidate.items.every(isContentItem) ||
    new Set(candidate.items.map(item => item.id)).size !== candidate.items.length ||
    !Array.isArray(candidate.deletedContentIds) || !candidate.deletedContentIds.every(id => typeof id === 'string' && id.length > 0) ||
    new Set(candidate.deletedContentIds).size !== candidate.deletedContentIds.length) return undefined
  const deletedIds = new Set(candidate.deletedContentIds)
  if (candidate.items.some(item => deletedIds.has(item.id))) return undefined
  return { version: 2, items: candidate.items.map(migrateContent), deletedContentIds: [...candidate.deletedContentIds] }
}

function readEnvelope(): { ok: true; envelope: StoredEnvelope | null } | { ok: false } {
  try {
    if (!globalThis.localStorage) return { ok: false }
    const raw = globalThis.localStorage.getItem(CONTENT_STORAGE_KEY)
    if (raw === null) return { ok: true, envelope: null }
    const envelope = parseContentEnvelope(JSON.parse(raw))
    if (envelope) return { ok: true, envelope }
  } catch { /* Never overwrite unreadable storage with a stale snapshot. */ }
  return { ok: false }
}
let deletedIdsReader: (() => Iterable<string>) | undefined
/** The application installs its durable server cache; standalone model callers retain legacy behavior. */
export function setContentDeletedIdsReader(reader?: () => Iterable<string>): void { deletedIdsReader = reader }
function knownDeletedIds(): Set<string> {
  if (deletedIdsReader) return new Set(deletedIdsReader())
  const stored = readEnvelope()
  return new Set(stored.ok ? stored.envelope?.deletedContentIds ?? [] : [])
}

/** Accept legacy arrays and existing exported backups without trusting malformed receipt metadata. */
export function parseContentImport(value: unknown): ContentItem[] | null {
  const candidate = isRecord(value) && value.app === '发条' && Array.isArray(value.content) ? value.content : value
  const envelope = parseContentEnvelope(candidate)
  return envelope ? cloneItems(envelope.items) : null
}

/** A missing key differs from inaccessible or invalid storage; this read never seeds data. */
export function readStoredContent(): { ok: true; items: ContentItem[] | null } | { ok: false } {
  const stored = readEnvelope()
  return stored.ok ? { ok: true, items: stored.envelope?.items ?? null } : { ok: false }
}

export function loadContent(): ContentItem[] {
  const stored = readStoredContent()
  return stored.ok && stored.items !== null ? stored.items : cloneItems(SEED_CONTENT)
}

/** Validate a full snapshot without changing storage or losing publication confirmations. */
export function createContentEnvelope(items: ContentItem[], current: StoredEnvelope | null): StoredEnvelope | null {
  if (!items.every(isContentItem) || new Set(items.map(item => item.id)).size !== items.length) return null
  const deletedIds = new Set(current?.deletedContentIds ?? [])
  if (items.some(item => deletedIds.has(item.id))) return null
  const nextIds = new Set(items.map(item => item.id))
  const nextById = new Map(items.map(item => [item.id, item]))
  for (const previous of current?.items ?? []) {
    if (nextIds.has(previous.id)) {
      const proposed = getPublications(nextById.get(previous.id))
      for (const [platform, publication] of Object.entries(getPublications(previous)) as [PlatformId, PlatformPublication][]) {
        const receipt = publication.receipt
        if (!receipt) continue
        const candidate = proposed[platform]?.receipt
        // A caller must merge newer confirmations first; a stale write cannot erase them.
        if (!candidate || !sameReceiptIdentity(receipt, candidate) ||
          (receipt.deletedAt && !candidate.deletedAt) || receiptVersion(candidate) < receiptVersion(receipt) ||
          (receiptVersion(candidate) === receiptVersion(receipt) && receipt.lastOperation &&
            receipt.lastOperation.requestId !== candidate.lastOperation?.requestId)) return null
      }
      continue
    }
    if (isContentDeletionLocked(previous)) return null
    deletedIds.add(previous.id)
  }
  return { version: 2, items: items.map(migrateContent), deletedContentIds: [...deletedIds] }
}

/** Persist records and deletion tombstones atomically; false leaves the previous snapshot intact. */
export function saveContent(items: ContentItem[]): boolean {
  try {
    if (!globalThis.localStorage) return false
    const current = readEnvelope()
    if (!current.ok) return false
    const envelope = createContentEnvelope(items, current.envelope)
    if (!envelope) return false
    globalThis.localStorage.setItem(CONTENT_STORAGE_KEY, JSON.stringify(envelope))
    return true
  } catch { return false }
}

export function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `post-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Editor checks only; platform API requirements must be checked by a future integration. */
export function validateContent(
  item: Pick<ContentItem, 'title' | 'body' | 'platforms' | 'images'>,
  mode: 'draft' | 'publish' | 'schedule',
  scheduledAt?: string,
): string[] {
  const errors: string[] = []
  if (mode === 'draft') return errors
  if (!item.title.trim()) errors.push('请填写内容标题')
  if (!item.body.trim() && item.images.length === 0) errors.push('请添加正文或图片')
  if (item.platforms.length === 0) errors.push('请至少选择一个发布平台')
  if (item.platforms.some((id) => !platformIds.has(id))) errors.push('包含尚未支持的发布平台')
  if (item.platforms.includes('douyin') && item.images.length === 0) errors.push('抖音图文内容请至少添加一张图片')
  if (mode === 'schedule') {
    const timestamp = scheduledAt ? Date.parse(scheduledAt) : Number.NaN
    if (!Number.isFinite(timestamp)) errors.push('请选择有效的定时发布时间')
    else if (timestamp <= Date.now()) errors.push('定时发布时间需要晚于当前时间')
  }
  return errors
}
