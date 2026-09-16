import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { ArrowLeft, CalendarClock, Check, ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Heart, ImagePlus, Link2, MessageCircle, MoreHorizontal, Plus, Send, Sparkles, Upload, X } from 'lucide-react';
import { getPublications, isPublicationLocked, makeId, PLATFORMS, validateContent } from './model';
import type { ContentItem, PlatformId } from './model';
import { hasBoundPlatformAccount, isPlatformAccountVerified, composePlatformText, platformResumeBlockReason, preparePlatformReview, requireConnectedPlatformAccount, requireReadyPlatformAccount, validatePlatformPublish } from './platforms';
import type { PlatformAccountState, PlatformComposerDraft } from './platforms';
import PublishedPostActions from './PublishedPostActions';
import ComposerDraftActions from './ComposerDraftActions';
import WatermarkEditor from './WatermarkEditor';
import AccountAvatar from './AccountAvatar';
import type { useWatermarkPreferences } from './useWatermarkPreferences';
import { readUploadedImages } from './watermark';
import './composer.css';

interface ComposerProps {
  watermarkPreferences: ReturnType<typeof useWatermarkPreferences>;
  item?: ContentItem;
  onClose: () => void;
  onSave: (item: ContentItem) => void | boolean | Promise<void | boolean>;
  accounts: Partial<Record<PlatformId, PlatformAccountState | null>>;
  onPublishPlatform: (platform: PlatformId, item: ContentItem, requestId: string, expectedAccountUid: string, continueOnly?: boolean) => Promise<ContentItem>;
  onPreparePlatform: (platform: PlatformId) => Promise<PlatformAccountState>;
  onConnectPlatform: (platform: PlatformId, mode?: 'qr' | 'window') => Promise<void>;
  onOperatePublication: (platform: PlatformId, operation: 'update' | 'delete', item: ContentItem, requestId: string, title?: string, body?: string) => Promise<ContentItem>;
  onCheckPublication: (platform: PlatformId, contentId: string, retryUpdate?: boolean) => Promise<ContentItem>;
  onReadComposerDraft: (platform: PlatformId) => Promise<PlatformComposerDraft>;
  onClearComposerDraft: (platform: PlatformId, snapshot: PlatformComposerDraft) => Promise<void>;
}

const SAMPLE_IMAGE = 'https://images.unsplash.com/photo-1442512595331-e89e73853f31?auto=format&fit=crop&w=900&q=85';
const MAX_IMAGES = 4;

function localDateTime(date: Date) {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return adjusted.toISOString().slice(0, 16);
}

function suggestedTime() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(10, 0, 0, 0);
  return localDateTime(date);
}

export default function Composer({ watermarkPreferences, item, onClose, onSave, accounts, onPublishPlatform, onPreparePlatform, onConnectPlatform, onOperatePublication, onCheckPublication, onReadComposerDraft, onClearComposerDraft }: ComposerProps) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [body, setBody] = useState(item?.body ?? '');
  const [images, setImages] = useState<string[]>(item?.images?.length ? item.images : item?.image ? [item.image] : []);
  const [previewImageIndex, setPreviewImageIndex] = useState(0);
  const [platforms, setPlatforms] = useState<PlatformId[]>(item?.platforms ?? ['xiaohongshu']);
  const [category, setCategory] = useState(item?.category ?? '生活方式');
  const [previewPlatform, setPreviewPlatform] = useState<PlatformId>(item?.platforms?.[0] ?? 'xiaohongshu');
  const [imageUrl, setImageUrl] = useState('');
  const [showImageUrl, setShowImageUrl] = useState(false);
  const [schedule, setSchedule] = useState(item?.status === 'scheduled');
  const [scheduledAt, setScheduledAt] = useState(item?.scheduledAt && !Number.isNaN(new Date(item.scheduledAt).getTime()) ? localDateTime(new Date(item.scheduledAt)) : suggestedTime());
  const [errors, setErrors] = useState<string[]>([]);
  const [imageError, setImageError] = useState('');
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);
  const [watermarkSources, setWatermarkSources] = useState<string[] | null>(null);
  // Restoring uses the upload's normalized image; reapplying uses the untouched
  // source so adding a watermark to a large upload only resizes the final result.
  const watermarkOriginals = useRef(new Map<string, string>());
  const watermarkRenderSources = useRef(new Map<string, string>());
  const watermarkButtonRef = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false);
  const [preparingPlatform, setPreparingPlatform] = useState<PlatformId | null>(null);
  const [preparingPhase, setPreparingPhase] = useState<'resume' | 'images' | null>(null);
  const [connecting, setConnecting] = useState<{ platform: PlatformId; mode: 'qr' | 'window' } | null>(null);
  const [returnedItem, setReturnedItem] = useState<ContentItem | undefined>();
  const [publishNotice, setPublishNotice] = useState('');
  const [accountActionRequired, setAccountActionRequired] = useState<Partial<Record<PlatformId, string>>>({});
  const [review, setReview] = useState<{ platform: PlatformId; content: ContentItem; account: NonNullable<PlatformAccountState['account']> } | null>(null);
  const contentIdRef = useRef(item?.id ?? makeId());
  const savingRef = useRef(false);
  const requestRef = useRef<Partial<Record<PlatformId, { signature: string; requestId: string }>>>({});
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const watermarkUploadRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => titleRef.current?.focus());
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!savingRef.current) onCloseRef.current();
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const elements = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], [tabindex="0"]')).filter(element => !element.matches(':disabled') && element.tabIndex >= 0 && element.getClientRects().length > 0);
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialogRef.current.focus();
      } else if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (!review) return;
    const frame = requestAnimationFrame(() => reviewHeadingRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [review]);

  useEffect(() => {
    if (!watermarkSources) return;
    const frame = requestAnimationFrame(() => dialogRef.current?.querySelector('.wm-editor')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [watermarkSources]);

  const closeWatermark = () => {
    setWatermarkSources(null);
    requestAnimationFrame(() => watermarkButtonRef.current?.focus({ preventScroll: true }));
  };

  const applyWatermark = (nextImages: string[]) => {
    if (!watermarkSources || isPublicationLocked(item ?? returnedItem)) return;
    const originals = new Map<string, string>();
    const renderSources = new Map<string, string>();
    nextImages.forEach((image, index) => {
      originals.set(image, watermarkOriginals.current.get(images[index]) ?? images[index]);
      renderSources.set(image, watermarkSources[index]);
    });
    watermarkOriginals.current = originals;
    watermarkRenderSources.current = renderSources;
    setImages(nextImages);
    setImageError('');
    setErrors([]);
    closeWatermark();
  };

  const restoreWatermark = () => {
    const restored = images.map(image => watermarkOriginals.current.get(image) ?? image);
    const renderSources = new Map<string, string>();
    images.forEach((image, index) => {
      const source = watermarkRenderSources.current.get(image);
      if (source) renderSources.set(restored[index], source);
    });
    watermarkRenderSources.current = renderSources;
    watermarkOriginals.current.clear();
    setImages(restored);
  };

  const togglePlatform = (platform: PlatformId) => {
    setPlatforms(current => current.includes(platform) ? current.filter(id => id !== platform) : [...current, platform]);
    setPreviewPlatform(platform);
    setErrors([]);
  };

  const navigatePreviewTabs = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = PLATFORMS.findIndex(platform => platform.id === previewPlatform);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % PLATFORMS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + PLATFORMS.length) % PLATFORMS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = PLATFORMS.length - 1;
    else return;
    event.preventDefault();
    setPreviewPlatform(PLATFORMS[next].id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  const removeImage = (index: number) => {
    const nextPreviewIndex = Math.max(0, Math.min(previewImageIndex - (index < previewImageIndex ? 1 : 0), images.length - 2));
    setPreviewImageIndex(nextPreviewIndex);
    setImages(current => current.filter((_, itemIndex) => itemIndex !== index));
    setImageError('');
    requestAnimationFrame(() => {
      const nextFocus = dialogRef.current?.querySelector<HTMLButtonElement>(`[data-preview-index="${nextPreviewIndex}"]`) ?? dialogRef.current?.querySelector<HTMLButtonElement>('.cmp-upload-area');
      nextFocus?.focus({ preventScroll: true });
    });
  };

  const stepPreviewImage = (direction: -1 | 1) => {
    if (images.length < 2) return;
    setPreviewImageIndex(current => (current + direction + images.length) % images.length);
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>, openWatermark = false) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length || uploadingRef.current) return;
    setImageError('');
    if (images.length + files.length > MAX_IMAGES) {
      setImageError(`每条内容最多添加 ${MAX_IMAGES} 张图片。`);
      return;
    }
    uploadingRef.current = true;
    setUploading(true);
    try {
      const staticFiles = files.filter(file => file.type !== 'image/gif');
      const watermarkUploads = openWatermark ? await readUploadedImages(files, { forWatermark: true }) : null;
      const added = await readUploadedImages(files);
      const renderSources = watermarkUploads ?? await readUploadedImages(staticFiles, { forWatermark: true });
      let staticIndex = 0;
      added.forEach((image, index) => {
        if (files[index].type !== 'image/gif') watermarkRenderSources.current.set(image, renderSources[staticIndex++]);
      });
      setImages(current => [...current, ...added].slice(0, MAX_IMAGES));
      if (openWatermark) setWatermarkSources([...images, ...added].map(image => watermarkRenderSources.current.get(image) ?? image));
      setErrors([]);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : '图片上传失败，请重试。');
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }
  };

  const addImageUrl = () => {
    if (uploading) return;
    setImageError('');
    if (images.length >= MAX_IMAGES) {
      setImageError(`每条内容最多添加 ${MAX_IMAGES} 张图片。`);
      return;
    }
    try {
      const url = new URL(imageUrl.trim());
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
      setImages(current => [...current, url.toString()]);
      setImageUrl('');
      setShowImageUrl(false);
      setErrors([]);
    } catch {
      setImageError('请输入有效的图片链接，以 https:// 或 http:// 开头。');
    }
  };

  // Parent props include pending and failed attempts, and remain authoritative.
  const currentItem = item ?? returnedItem;
  const publications = currentItem ? getPublications(currentItem) : {};
  const managedPlatforms = [...new Set([...platforms, ...Object.keys(publications) as PlatformId[]])];
  const contentLocked = Boolean(currentItem && isPublicationLocked(currentItem));
  const editingLocked = saving || contentLocked || Boolean(review);
  const completedCount = platforms.filter(platform => publications[platform]?.state === 'published').length;
  const allPublished = platforms.length > 0 && completedCount === platforms.length;
  const platformName = (platform: PlatformId) => PLATFORMS.find(value => value.id === platform)?.name ?? platform;
  const platformGlyph = (platform: PlatformId) => platform === 'xiaohongshu' ? '红' : platform === 'douyin' ? '♪' : platform === 'weibo' ? '微' : '哔';
  const blockReason = (platform: PlatformId) => schedule
    ? '定时仅保存本地计划；关闭定时后可立即发布。'
    : platformResumeBlockReason(platform, accounts[platform], publications[platform]);
  const reviewBlockReason = (() => {
    if (!review) return '';
    const publication = publications[review.platform];
    const accountState = accounts[review.platform];
    const knownAccount = isPlatformAccountVerified(accountState) ? accountState.account : undefined;
    if (publication?.receipt?.deletedAt) return '该平台原文已删除；再次发布请复制为新草稿。';
    if (publication?.state === 'published' || publication?.receipt) return '已发布；可在下方修改已发文字或删除平台原文。';
    if (schedule) return '定时仅保存本地计划；关闭定时后可立即发布。';
    if (publication && !publication.expectedAccountUid) return '这笔旧发布记录缺少原账号标识，请先到平台核对结果。';
    if (publication?.expectedAccountUid && publication.expectedAccountUid !== review.account.uid) return '原发布账号与当前确认账号不一致，请返回平台列表核对。';
    if (knownAccount && knownAccount.uid !== review.account.uid) return '登录账号已变化，请返回平台列表并重新核对发布账号。';
    // A closed window can be restored; the parent rechecks this confirmed UID before sending.
    return '';
  })();
  const reviewPublication = review ? publications[review.platform] : undefined;
  const reviewUncertain = reviewPublication?.state === 'pending' || reviewPublication?.state === 'uncertain';
  const reviewAccountState = review ? accounts[review.platform] : undefined;
  const reviewVerified = isPlatformAccountVerified(reviewAccountState);
  const reviewQrLogin = !reviewVerified && reviewAccountState?.login?.kind === 'qr' ? reviewAccountState.login : undefined;
  const reviewSavedAndClosed = Boolean(reviewAccountState?.sessionSaved && !reviewAccountState.browserOpen && !reviewAccountState.login);
  const reviewNeedsLogin = Boolean(review && (accountActionRequired[review.platform] || !reviewSavedAndClosed && reviewAccountState && (!reviewVerified || !reviewUncertain && !reviewAccountState.publishReady) || reviewVerified && reviewAccountState?.account?.uid !== review.account.uid));
  const markAccountActionRequired = (platform: PlatformId, error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'LOGIN_REQUIRED' || code === 'CAPTCHA_REQUIRED' || code === 'ACCOUNT_CHANGED') {
      setAccountActionRequired(current => ({ ...current, [platform]: error instanceof Error ? error.message : '请完成账号登录或验证后继续。' }));
    }
  };

  useEffect(() => {
    if (!item || !isPublicationLocked(item)) return;
    setTitle(item.title);
    setBody(item.body);
    setImages(item.images);
    setWatermarkSources(null);
    watermarkOriginals.current.clear();
    watermarkRenderSources.current.clear();
    setPlatforms(item.platforms);
    setCategory(item.category);
    setSchedule(item.status === 'scheduled');
  }, [item]);

  const showErrors = (messages: string[]) => {
    setErrors(messages);
    requestAnimationFrame(() => errorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  };

  const buildContent = (mode: 'draft' | 'schedule'): ContentItem => {
    if (contentLocked && currentItem) return currentItem;
    const now = new Date().toISOString();
    const plannedDate = new Date(scheduledAt);
    const planned = Number.isNaN(plannedDate.getTime()) ? undefined : plannedDate.toISOString();
    return {
      ...currentItem,
      id: contentIdRef.current,
      title: title.trim(),
      body: body.trim(),
      image: images[0] ?? '',
      images,
      platforms,
      category: category.trim() || '未分类',
      status: mode === 'schedule' ? 'scheduled' : 'draft',
      updatedAt: now,
      scheduledAt: mode === 'schedule' ? planned : undefined,
      publishedAt: undefined,
      publishMode: undefined,
    };
  };

  const submit = async (mode: 'draft' | 'schedule') => {
    if (savingRef.current || uploading || watermarkSources || contentLocked) return;
    const content = buildContent(mode);
    const validation = validateContent(content, mode, content.scheduledAt);
    if (mode === 'schedule' && !content.scheduledAt && !validation.length) validation.push('请选择有效的发布时间。');
    if (validation.length) {
      showErrors(validation);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      if (await onSave(content) === false) throw new Error('保存失败，请确认本地服务正在运行且磁盘空间充足后重试。');
    } catch (error) {
      showErrors([error instanceof Error ? error.message : '保存失败，请确认本地服务正在运行且磁盘空间充足后重试。']);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const reviewPlatform = async (platform: PlatformId) => {
    if (savingRef.current || connecting || uploading || watermarkSources || blockReason(platform)) return;
    const content = buildContent('draft');
    const validation = validatePlatformPublish(platform, content);
    if (validation.length) { showErrors(validation); return; }
    setErrors([]);
    setPublishNotice('');
    savingRef.current = true;
    setSaving(true);
    setPreparingPlatform(platform);
    setPreparingPhase('resume');
    try {
      const freshState = await onPreparePlatform(platform);
      const account = (publications[platform] ? requireConnectedPlatformAccount : requireReadyPlatformAccount)(platform, freshState, publications[platform]?.expectedAccountUid);
      setAccountActionRequired(current => ({ ...current, [platform]: undefined }));
      setPreparingPhase('images');
      const prepared = await preparePlatformReview(platform, content);
      setReview({ platform, content: prepared, account: { ...account } });
    } catch (error) {
      markAccountActionRequired(platform, error);
      showErrors([error instanceof Error ? error.message : '无法准备发布，请检查账号状态和图片后重试。']);
    } finally {
      savingRef.current = false;
      setSaving(false);
      setPreparingPlatform(null);
      setPreparingPhase(null);
    }
  };

  const publishPlatform = async (continueOnly = false) => {
    if (savingRef.current || connecting || !review) return;
    if (reviewBlockReason) { showErrors([reviewBlockReason]); return; }
    savingRef.current = true;
    setSaving(true);
    setErrors([]);
    try {
      const source = JSON.stringify({ title: review.content.title, body: review.content.body, images: review.content.images, account: review.account.uid });
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
      const signature = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
      const storageKey = `fatiao.platform.request.${review.platform}.${contentIdRef.current}`;
      let previous = requestRef.current[review.platform];
      if (!previous) {
        try {
          const stored = JSON.parse(localStorage.getItem(storageKey) || 'null') as { signature?: string; requestId?: string } | null;
          if (stored && typeof stored.signature === 'string' && typeof stored.requestId === 'string') previous = { signature: stored.signature, requestId: stored.requestId };
        } catch { /* The parent persists each request before submitting it. */ }
      }
      const previousPublication = publications[review.platform];
      // Older sessions stored the JSON snapshot itself as the signature. Reuse
      // its request ID once, then replace it with the compact digest below.
      const requestId = previousPublication?.requestId || (previous && (previous.signature === signature || previous.signature === source) ? previous.requestId : makeId());
      requestRef.current[review.platform] = { signature, requestId };
      try { localStorage.setItem(storageKey, JSON.stringify(requestRef.current[review.platform])); } catch { /* The pending draft is the durable fallback. */ }
      const result = await onPublishPlatform(review.platform, review.content, requestId, previousPublication?.expectedAccountUid || review.account.uid, continueOnly);
      setReturnedItem(result);
      setAccountActionRequired(current => ({ ...current, [review.platform]: undefined }));
      setPublishNotice(`已发布到${platformName(review.platform)}，可查看原文或继续发布到其他已选平台。`);
      setReview(null);
    } catch (error) {
      markAccountActionRequired(review.platform, error);
      showErrors([error instanceof Error ? error.message : `${platformName(review.platform)}发布失败，内容已保留，请稍后重试。`]);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const connectPlatform = async (platform: PlatformId, mode: 'qr' | 'window' = 'window') => {
    if (connecting || savingRef.current) return;
    setConnecting({ platform, mode });
    setErrors([]);
    try { await onConnectPlatform(platform, mode); }
    catch (error) { showErrors([error instanceof Error ? error.message : mode === 'qr' ? '无法获取登录二维码，请稍后重试或打开平台官网页面。' : '无法打开平台官网页面，请稍后重试。']); }
    finally { setConnecting(null); }
  };

  const currentPreview = PLATFORMS.find(platform => platform.id === previewPlatform) ?? PLATFORMS[0];
  const visibleImageIndex = Math.min(previewImageIndex, Math.max(0, images.length - 1));
  const previewReceipt = publications[previewPlatform]?.receipt;
  const previewAccount = accounts[previewPlatform]?.account;
  const previewText = previewReceipt?.lastOperation?.type === 'update' ? previewReceipt.lastOperation : undefined;
  const previewTitle = previewText?.title ?? title;
  const previewBody = previewText?.body ?? body;
  const previewName = previewReceipt?.account.name || previewAccount?.name || `待登录的${currentPreview.shortName}账号`;
  const previewAvatar = !previewReceipt || previewReceipt.account.uid === previewAccount?.uid ? previewAccount?.avatarUrl : undefined;

  return (
    <div className="cmp-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !savingRef.current) onClose(); }}>
      <div ref={dialogRef} className="cmp-dialog" role="dialog" aria-modal="true" aria-labelledby="cmp-heading" aria-describedby="cmp-storage-note" tabIndex={-1}>
        <header className="cmp-header">
          <div className="cmp-header-title"><span className="cmp-heading-icon"><Sparkles size={20} /></span><div><h2 id="cmp-heading">{allPublished ? '已发布记录' : contentLocked ? '继续发布内容' : item ? '编辑内容' : '新建内容'}</h2><p>把灵感，分享给更多人。</p></div></div>
          <button className="cmp-icon-button" disabled={saving} onClick={() => { if (!savingRef.current) onClose(); }} aria-label="关闭编辑器"><X size={21} /></button>
        </header>

        <div className={`cmp-content${review ? ' is-reviewing' : ''}`}>
          {review && <section className="cmp-confirmation" aria-labelledby="cmp-confirmation-heading">
            <span className="cmp-confirmation-eyebrow">{reviewUncertain ? '历史发布核对' : '发布前核对'}</span>
            <h3 ref={reviewHeadingRef} tabIndex={-1} id="cmp-confirmation-heading">{reviewUncertain ? '核对上次发布到' : '确认发布到'}{platformName(review.platform)}</h3>
            <p className="cmp-confirmation-note">{reviewUncertain ? '核对只会读取原发布请求的结果，不会再次发布。以下是上次确认的账号与内容。' : `确认后，将使用以下账号在${platformName(review.platform)}发布这份内容。`}</p>
            <div className="cmp-weibo-account">
              <AccountAvatar platform={review.platform} src={review.account.avatarUrl} alt={`${platformName(review.platform)}头像`} />
              <div><strong>{review.account.name}</strong><span>{platformName(review.platform)}账号 · {review.account.uid}</span></div>
            </div>
            {review.platform === 'xiaohongshu' || review.platform === 'douyin' ? <div className="cmp-confirmation-text"><span>标题</span><h4>{review.content.title || '（无标题）'}</h4><span>正文</span><p>{review.content.body || '（无正文）'}</p></div> : <p className="cmp-confirmation-status">{composePlatformText(review.content.title, review.content.body)}</p>}
            {review.content.images.length > 0 && <div className="cmp-confirmation-images">{review.content.images.map((src, index) => <figure key={index}><img src={src} alt={`${reviewUncertain ? '上次发布的' : '即将发布的'}图片 ${index + 1}`} /><figcaption>图片 {index + 1}</figcaption></figure>)}</div>}
            <p className="cmp-confirmation-note">{review.platform === 'xiaohongshu' || review.platform === 'douyin' ? `标题 ${Array.from(review.content.title).length} 字 · 正文 ${Array.from(review.content.body).length} 字` : `${Array.from(composePlatformText(review.content.title, review.content.body)).length} 字（含换行）`} · {review.content.images.length} 张图片</p>
            {reviewUncertain && <p className="cmp-pending-note" role="status">上次发布结果尚未确定。请先到{platformName(review.platform)}查看；内容已锁定，核对时会沿用原账号和同一发布请求。此次核对不会重新发送。</p>}
            {reviewBlockReason && <p className="cmp-pending-note" role="status">{reviewBlockReason}</p>}
            {reviewSavedAndClosed && !reviewNeedsLogin && <p className="cmp-confirmation-note" role="status">继续时会连接平台官网页面并核对原账号。</p>}
            {reviewNeedsLogin && <div className="cmp-review-login" aria-label="连接发布账号">
              <p className="cmp-confirmation-note">{accountActionRequired[review.platform] || reviewAccountState?.message || '请完成登录或验证后继续。'}已确认的文案和图片会保留。</p>
              {reviewQrLogin && <div className="cmp-login-qr" aria-label={`${platformName(review.platform)}登录二维码`}>{reviewQrLogin.image ? <><img src={reviewQrLogin.image} alt={`${platformName(review.platform)}登录二维码`} /><p>使用{platformName(review.platform)}手机 App 扫码后，{reviewUncertain ? '继续核对上次发布。' : '继续确认发布。'}</p></> : <p>{reviewAccountState?.message || '暂未获取到可用二维码，请再次扫码或打开平台官网页面。'}</p>}</div>}
              <div className="cmp-platform-publish-actions"><button type="button" className="cmp-weibo-login cmp-qr-login-button" onClick={() => connectPlatform(review.platform, 'qr')} disabled={Boolean(connecting) || saving}>{connecting?.platform === review.platform && connecting.mode === 'qr' ? '正在获取二维码…' : reviewQrLogin ? '再次扫码' : '扫码登录'}</button><button type="button" className="cmp-weibo-login" onClick={() => connectPlatform(review.platform)} disabled={Boolean(connecting) || saving}>{connecting?.platform === review.platform && connecting.mode === 'window' ? '正在打开…' : '打开平台官网'}<ExternalLink size={13} /></button></div>
            </div>}
            {errors.length > 0 && <div ref={errorRef} className="cmp-error-box" role="alert"><strong>{reviewUncertain ? '核对尚未完成' : '发布尚未完成'}</strong><ul>{errors.map((error, index) => <li key={`${error}-${index}`}>{error}</li>)}</ul></div>}
          </section>}
          <div className="cmp-editor-column" hidden={Boolean(review)}>
          <fieldset className="cmp-editor" aria-label="内容编辑" disabled={editingLocked || uploading || Boolean(watermarkSources)}>
            <div className="cmp-field">
              <div className="cmp-label-row"><label id="cmp-platform-label">发布平台 <span className="cmp-label-hint">可多选</span></label><span className="cmp-count">已选择 {platforms.length} 个</span></div>
              <div className="cmp-platforms" role="group" aria-labelledby="cmp-platform-label">
                {PLATFORMS.map(platform => (
                  <button key={platform.id} type="button" className={`cmp-platform ${platforms.includes(platform.id) ? 'is-selected' : ''}`} aria-pressed={platforms.includes(platform.id)} onClick={() => togglePlatform(platform.id)}>
                    <span className={`cmp-platform-logo cmp-platform-logo-${platform.id}`} style={{ backgroundColor: platform.color }}>{platform.id === 'xiaohongshu' ? '红' : platform.id === 'douyin' ? '♪' : platform.id === 'weibo' ? '微' : '哔'}</span>
                    <span>{platform.name}</span>
                    <span className="cmp-checkbox">{platforms.includes(platform.id) && <Check size={11} strokeWidth={3} />}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="cmp-field">
              <div className="cmp-label-row"><label htmlFor="cmp-title">内容标题</label><span className="cmp-count">{Array.from(title).length} 字</span></div>
              <input ref={titleRef} id="cmp-title" className="cmp-input cmp-title-input" placeholder="给这份灵感，起个好标题" value={title} onChange={event => { setTitle(event.target.value); setErrors([]); }} />
            </div>

            <div className="cmp-field">
              <div className="cmp-label-row"><label htmlFor="cmp-body">正文内容</label><span className="cmp-count">{Array.from(body).length} 字</span></div>
              <textarea id="cmp-body" className="cmp-input cmp-body-input" placeholder={'分享你的故事、日常与好点子…\n\n试着用 #话题 标签，让更多人发现你。'} value={body} onChange={event => { setBody(event.target.value); setErrors([]); }} />
              <div className="cmp-editor-hint"><span>支持文字、话题与图片</span><span>支持换行</span></div>
            </div>

            <div className="cmp-field">
              <div className="cmp-label-row"><label id="cmp-images-label">图片素材</label><span className="cmp-count">{images.length} / {MAX_IMAGES}</span></div>
              <input ref={uploadRef} type="file" className="cmp-file-input" accept="image/jpeg,image/png,image/webp,image/gif" multiple onChange={handleUpload} aria-label="上传图片文件" tabIndex={-1} />
              <input ref={watermarkUploadRef} disabled={!watermarkPreferences.ready} type="file" className="cmp-file-input" accept="image/jpeg,image/png,image/webp" multiple onChange={event => void handleUpload(event, true)} aria-label="选择要加水印的图片" tabIndex={-1} />
              {images.length > 0 ? (
                <div className="cmp-image-gallery" role="group" aria-labelledby="cmp-images-label">
                  {images.map((src, index) => <div className={`cmp-image-thumb ${visibleImageIndex === index ? 'is-selected' : ''}`} key={`${index}-${src.slice(-32)}`}><button type="button" className="cmp-image-select" data-preview-index={index} aria-label={`预览图片 ${index + 1}`} aria-pressed={visibleImageIndex === index} onClick={() => setPreviewImageIndex(index)}><img src={src} alt={`待发布图片 ${index + 1}`} />{index === 0 && <span className="cmp-cover-tag">封面</span>}</button><button className="cmp-remove-image" onClick={() => removeImage(index)} aria-label={`移除图片 ${index + 1}`}><X size={13} /></button></div>)}
                  {images.length < MAX_IMAGES && <button className="cmp-add-image" onClick={() => uploadRef.current?.click()} disabled={uploading} aria-label="添加更多图片"><Plus size={23} /><span>{uploading ? '读取中…' : '添加图片'}</span></button>}
                </div>
              ) : (
                <button className="cmp-upload-area" onClick={() => uploadRef.current?.click()} disabled={uploading}>
                  <span className="cmp-upload-icon"><Upload size={22} /></span><strong>{uploading ? '正在处理图片…' : '点击上传，开启你的视觉故事'}</strong><span>JPG / PNG / WebP 原图 ≤ 12 MB<br />优先无损 PNG，超过 3 MB 才缩小<br />普通 GIF 原样保存，≤ 3 MB</span>
                </button>
              )}
              <div className="cmp-image-actions">
                <button className="cmp-text-button" onClick={() => setShowImageUrl(current => !current)} disabled={images.length >= MAX_IMAGES || uploading}><Link2 size={13} />使用图片链接</button>
                <button ref={watermarkButtonRef} type="button" className="cmp-text-button" disabled={uploading || !watermarkPreferences.ready} title={images.length ? '设置图片水印' : '选择图片并添加水印'} onClick={() => images.length ? setWatermarkSources(images.map(image => watermarkRenderSources.current.get(image) ?? image)) : watermarkUploadRef.current?.click()}><Sparkles size={13} />图片水印</button>
                {images.some(image => watermarkOriginals.current.has(image)) && <button type="button" className="cmp-text-button" disabled={uploading} onClick={restoreWatermark}>还原本次水印</button>}
                {!images.length && <button className="cmp-text-button" onClick={() => { setImages([SAMPLE_IMAGE]); setImageError(''); }} disabled={uploading}><ImagePlus size={13} />试试示例图片</button>}
              </div>
              {showImageUrl && <div className="cmp-url-row"><input className="cmp-input" aria-label="图片链接" placeholder="https://…" value={imageUrl} onChange={event => setImageUrl(event.target.value)} onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') { event.preventDefault(); addImageUrl(); } }} /><button className="cmp-small-button" onClick={addImageUrl} disabled={uploading}>添加</button></div>}
              {imageError && <p className="cmp-error-inline" role="alert">{imageError}</p>}
            </div>

            <div className="cmp-field cmp-category-field">
              <label htmlFor="cmp-category">内容分类</label>
              <div className="cmp-select-wrap"><select id="cmp-category" className="cmp-input" value={category} onChange={event => setCategory(event.target.value)}>{Array.from(new Set(['生活方式', '日常灵感', '好物分享', '干货知识', '品牌合作', '未分类', category])).map(value => <option key={value} value={value}>{value}</option>)}</select><ChevronDown size={14} /></div>
            </div>
          </fieldset>
          {watermarkPreferences.error && !watermarkSources && <div className="wm-preferences-status is-error" role="alert"><span>{watermarkPreferences.error}</span><button type="button" className="wm-preferences-retry" disabled={watermarkPreferences.saving} onClick={watermarkPreferences.retrySave}>重新保存</button></div>}
          {watermarkSources && watermarkPreferences.ready && <WatermarkEditor images={watermarkSources} settings={watermarkPreferences.settings} onSettingsChange={watermarkPreferences.updateSettings} preferencesSaving={watermarkPreferences.saving} preferencesError={watermarkPreferences.error} onRetryPreferences={watermarkPreferences.retrySave} disabled={editingLocked} onApply={applyWatermark} onCancel={closeWatermark} />}
          <section className="cmp-publication-list" aria-label="各平台账号与发布进度">
            <div className="cmp-publication-heading"><h3>发布到自己的账号</h3><span>{completedCount} / {platforms.length} 已完成</span></div>
            <p className="cmp-publication-help">逐个平台核对并发布。每个平台分别保存结果；已成功的内容不会重复发送。</p>
            {contentLocked && <p className="cmp-pending-note">草稿内容和所选平台已锁定。每个平台的原文可在下方单独修改文字或删除，其他平台不会一起改变。</p>}
            {publishNotice && <p className="cmp-publish-notice" role="status"><Check size={15} />{publishNotice}</p>}
            {!platforms.length && <p className="cmp-publication-help">先选择至少一个发布平台。</p>}
            {managedPlatforms.map(platform => {
              const state = accounts[platform];
              const publication = publications[platform];
              const receipt = publication?.receipt;
              const isPublished = publication?.state === 'published';
              const isUncertain = publication?.state === 'pending' || publication?.state === 'uncertain';
              const reason = blockReason(platform);
              const account = receipt?.account ?? state?.account;
              const verified = isPlatformAccountVerified(state);
              const bound = hasBoundPlatformAccount(state);
              const savedAndClosed = Boolean(state?.sessionSaved && !state.browserOpen && !state.login && !accountActionRequired[platform]);
              const qrLogin = !verified && state?.login?.kind === 'qr' ? state.login : undefined;
              const needsLogin = Boolean(accountActionRequired[platform]) || !savedAndClosed && (!verified || !isUncertain && !state?.publishReady) || Boolean(verified && publication?.expectedAccountUid && state.account?.uid && state.account.uid !== publication.expectedAccountUid);
              return <article className="cmp-weibo-panel cmp-platform-publish-panel" key={platform} aria-label={`${platformName(platform)}账号与发布`}>
                <div className="cmp-weibo-panel-heading"><strong>{platformName(platform)}</strong><span className={`cmp-weibo-state${isPublished || verified || bound ? ' is-connected' : ''}`}>{receipt?.deletedAt ? '原文已删除' : publication?.lifecycle ? '操作待核对' : isPublished ? '已发布' : isUncertain ? '结果待确认' : !state ? '读取状态中' : savedAndClosed ? bound ? '已绑定' : '待重新连接' : verified ? '已登录' : state.browserOpen ? '等待登录' : '未登录'}</span></div>
                {account ? <div className="cmp-weibo-account"><AccountAvatar platform={platform} src={state?.account?.uid === account.uid ? state.account.avatarUrl : undefined} alt={`${platformName(platform)}头像`} /><div><strong>{account.name}</strong><span>账号 · {account.uid}</span></div></div> : <p>{savedAndClosed ? '发布时会连接平台官网页面并核对账号。' : accountActionRequired[platform] || state?.message || '请连接平台官网页面并核对账号；未登录时可在页面登录或扫码登录。'}</p>}
                {isPublished && receipt ? <><div className="cmp-weibo-receipt"><Check size={16} /><div><strong>{receipt.deletedAt ? '平台原文已删除' : `已发布到 ${receipt.account.name}`}</strong>{!receipt.deletedAt && <a href={receipt.url} target="_blank" rel="noreferrer">查看已发布原文 <ExternalLink size={12} /></a>}{publication.recoveredFromReceipt && !receipt.deletedAt && <p>已恢复发布回执。本地文案可能与原文不同，请打开原文核对。</p>}</div></div><PublishedPostActions platform={platform} item={currentItem!} publication={publication} accountState={state} busy={saving || Boolean(connecting)} acquire={() => { if (savingRef.current || connecting) return false; savingRef.current = true; setSaving(true); return true; }} release={() => { savingRef.current = false; setSaving(false); }} onPrepare={onPreparePlatform} onConnect={onConnectPlatform} onOperate={onOperatePublication} onCheck={onCheckPublication} /></> : <>
                  <p className="cmp-weibo-guidance">{platform === 'xiaohongshu' || platform === 'douyin' ? '将发布图文内容，标题与正文分别填写，至少需要一张图片。' : '标题与正文合并发布，支持文字、话题和图片。'}</p>
                  {account && savedAndClosed && <p className="cmp-session-note">{state?.browserMode === 'current-chrome' ? '标签页已关闭，账号绑定保留；操作时自动打开并核验登录。' : '发布时会连接平台官网页面并核对账号。'}</p>}
                  {qrLogin && <div className="cmp-login-qr" aria-label={`${platformName(platform)}登录二维码`}>{qrLogin.image ? <><img src={qrLogin.image} alt={`${platformName(platform)}登录二维码`} /><p>请使用{platformName(platform)}手机 App 扫码登录。扫码完成后再次点击发布，会重新核对账号。</p></> : <p>{state?.message || '暂未获取到可用二维码，请再次扫码或打开平台官网页面。'}</p>}</div>}
                  {!savedAndClosed && !qrLogin && account && state?.message && <p>{state.message}</p>}
                  {isUncertain && <p className="cmp-pending-note" role="status">原发布账号：{publication.expectedAccountUid || '旧记录未保存'}。请先到平台查看结果，再核对同一发布请求。</p>}
                  {reason && <p className="cmp-weibo-block-reason">{reason}</p>}
                  <div className="cmp-platform-publish-actions">
                    {needsLogin && <><button type="button" className="cmp-weibo-login cmp-qr-login-button" onClick={() => connectPlatform(platform, 'qr')} disabled={Boolean(connecting) || saving}>{connecting?.platform === platform && connecting.mode === 'qr' ? '正在获取二维码…' : qrLogin ? '再次扫码' : '扫码登录'}</button><button type="button" className="cmp-weibo-login" onClick={() => connectPlatform(platform)} disabled={Boolean(connecting) || saving}>{connecting?.platform === platform && connecting.mode === 'window' ? '正在打开…' : '打开平台官网'}<ExternalLink size={13} /></button></>}
                    <button type="button" className="cmp-publish-button" onClick={() => reviewPlatform(platform)} disabled={saving || Boolean(connecting) || uploading || Boolean(watermarkSources) || Boolean(reason)} title={reason || undefined}><Send size={14} />{preparingPlatform === platform ? preparingPhase === 'resume' ? '正在连接并核对账号…' : '正在准备图片…' : isUncertain ? '核对上次发布' : `发布到${platformName(platform)}`}</button>
                  </div>
                </>}
                {platform === 'bilibili' && <ComposerDraftActions platform={platform} busy={saving || Boolean(connecting) || uploading} acquire={() => { if (savingRef.current || connecting || uploading) return false; savingRef.current = true; setSaving(true); return true; }} release={() => { savingRef.current = false; setSaving(false); }} onRead={onReadComposerDraft} onClear={onClearComposerDraft} />}
              </article>;
            })}
            {!review && errors.length > 0 && <div ref={errorRef} className="cmp-error-box" role="alert"><strong>操作尚未完成</strong><ul>{errors.map((error, index) => <li key={`${error}-${index}`}>{error}</li>)}</ul></div>}
          </section>
          </div>

          <aside className="cmp-preview" aria-label="内容实时预览" hidden={Boolean(review)}>
            <div className="cmp-preview-label"><span>实时预览</span><span className="cmp-preview-live"><i /> 随编辑更新</span></div>
            <div className="cmp-preview-tabs" role="tablist" aria-label="预览平台" onKeyDown={navigatePreviewTabs}>
              {PLATFORMS.map(platform => <button key={platform.id} type="button" role="tab" tabIndex={previewPlatform === platform.id ? 0 : -1} aria-selected={previewPlatform === platform.id} aria-controls="cmp-preview-panel" className={previewPlatform === platform.id ? 'is-active' : ''} onClick={() => setPreviewPlatform(platform.id)}>{platform.shortName}</button>)}
            </div>
            <div className={`cmp-phone cmp-phone-${previewPlatform}`} id="cmp-preview-panel" role="tabpanel" aria-label={`${currentPreview.name}预览`}>
              <div className="cmp-phone-status"><span>9:41</span><span>▮▮▮ <span className="cmp-battery" /></span></div>
              <div className="cmp-phone-nav"><ArrowLeft size={18} /><span>{currentPreview.name}</span><MoreHorizontal size={19} /></div>
              <div className="cmp-phone-profile"><span className="cmp-avatar"><AccountAvatar platform={previewPlatform} src={previewAvatar} alt={`${currentPreview.name}头像`} /></span><div><strong>{previewName}</strong><span>{currentPreview.name}内容预览</span></div><span className="cmp-follow">关注</span></div>
              {images.length ? <div className="cmp-phone-image" role="group" aria-label="发布图片预览"><img src={images[visibleImageIndex]} alt={visibleImageIndex === 0 ? '发布封面预览' : `发布图片 ${visibleImageIndex + 1} 预览`} /><span className="cmp-image-number" aria-live="polite" aria-atomic="true">{visibleImageIndex + 1} / {images.length}</span>{images.length > 1 && <><button type="button" className="cmp-carousel-button cmp-carousel-previous" aria-label="预览上一张图片" onClick={() => stepPreviewImage(-1)}><ChevronLeft size={17} /></button><button type="button" className="cmp-carousel-button cmp-carousel-next" aria-label="预览下一张图片" onClick={() => stepPreviewImage(1)}><ChevronRight size={17} /></button></>}</div> : <div className="cmp-phone-placeholder"><ImagePlus size={31} strokeWidth={1.2} /><span>你的精彩，即将在这里呈现</span></div>}
              {images.length > 1 && <div className="cmp-image-dots" role="group" aria-label="选择预览图片">{images.map((_, index) => <button type="button" key={index} aria-label={`显示第 ${index + 1} 张图片`} aria-pressed={visibleImageIndex === index} className={index === visibleImageIndex ? 'is-active' : ''} onClick={() => setPreviewImageIndex(index)}><i /></button>)}</div>}
              <div className="cmp-phone-copy">{previewPlatform === 'weibo' || previewPlatform === 'bilibili' ? <p className={title || body ? '' : 'is-placeholder'}>{composePlatformText(previewTitle, previewBody) || '你的文字将在这里显示。'}</p> : <><h3 className={title ? '' : 'is-placeholder'}>{previewTitle || '一个值得分享的好标题'}</h3><p className={body ? '' : 'is-placeholder'}>{previewBody || '每一份认真记录的日常，\n都值得被更多人看见。'}</p></>}<span className="cmp-phone-date">刚刚 · {category || '未分类'}</span></div>
              <div className="cmp-phone-bottom"><span>说点什么…</span><Heart size={18} /><MessageCircle size={18} /><Send size={17} /></div>
            </div>
            <p className="cmp-preview-note">预览仅供参考，实际样式以平台展示为准</p>
          </aside>
        </div>

        <footer className="cmp-footer">
          {!review && !contentLocked && <div className="cmp-schedule-area"><label className="cmp-schedule-toggle"><input type="checkbox" checked={schedule} disabled={editingLocked} onChange={event => { setSchedule(event.target.checked); setErrors([]); }} /><CalendarClock size={16} /><span>本地定时计划</span></label>{schedule && <input type="datetime-local" className="cmp-input cmp-datetime" aria-label="计划发布时间" value={scheduledAt} disabled={editingLocked} min={localDateTime(new Date())} onChange={event => { setScheduledAt(event.target.value); setErrors([]); }} />}</div>}
          <div className="cmp-footer-actions">
            {review ? <>{reviewUncertain && review.platform === 'bilibili' && <button className="cmp-draft-button" onClick={() => publishPlatform(true)} disabled={saving || Boolean(connecting) || Boolean(reviewBlockReason)}>继续完成B站首次发布确认</button>}<button className="cmp-draft-button" onClick={() => { setReview(null); setErrors([]); }} disabled={saving}>返回平台列表</button><button className="cmp-publish-button" onClick={() => publishPlatform()} disabled={saving || Boolean(connecting) || Boolean(reviewBlockReason)}><Send size={16} />{saving ? reviewUncertain ? '正在核对，请勿关闭…' : '正在核对并发布，请勿关闭…' : reviewUncertain ? '核对同一发布请求' : `确认发布到${platformName(review.platform)}`}</button></> : contentLocked ? <button className="cmp-draft-button" onClick={onClose} disabled={saving}>关闭</button> : <><button className="cmp-draft-button" onClick={() => submit('draft')} disabled={saving || uploading || Boolean(watermarkSources)}>保存草稿</button>{schedule && <button className="cmp-draft-button cmp-plan-button" onClick={() => submit('schedule')} disabled={saving || uploading || Boolean(watermarkSources)}><CalendarClock size={16} />{saving ? '正在保存…' : '加入本地计划'}</button>}</>}
          </div>
          <p id="cmp-storage-note" className="cmp-storage-note"><span />发布、修改和删除会操作平台原文；草稿与定时计划保存在本地，定时计划不会自动发帖。</p>
        </footer>
      </div>
    </div>
  );
}
