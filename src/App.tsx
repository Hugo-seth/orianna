import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ArrowDownWideNarrow, ArrowRight, ArrowUpRight, Bell, CalendarDays, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, ChevronsUpDown, CircleCheck, CircleHelp, Clock3, Copy, Download, Eye, FileText, Flower2, FolderOpen, Heart, House, Image as ImageIcon, LayoutGrid, Layers3, Link2, List, Menu, MoreHorizontal, MousePointer2, Pencil, Plus, Search, Send, Settings2, Sparkles, Sun, Trash2, TvMinimal, Upload, X, Zap } from 'lucide-react';
import WatermarkEditor from './WatermarkEditor';
import { readUploadedImages } from './watermark';
import { useWatermarkPreferences } from './useWatermarkPreferences';
import Composer from './Composer';
import PlatformAccountCard from './PlatformAccountCard';
import { mergeContentImport } from './content-import';
import { hasBoundPlatformAccount, getPlatformAccount, getPlatformReceipts, loginPlatform, openPlatform, refreshPlatform, closePlatform, disconnectPlatform, resumePlatform, requireConnectedPlatformAccount, requireReadyPlatformAccount, preparePlatformContent, publishPlatform, updatePlatformPublication, deletePlatformPublication, getContentDeletionStatus, getPlatformComposerDraft, clearPlatformComposerDraft, validatePlatformPublish, validatePlatformUpdate, PlatformRequestError, type PlatformAccountState, type PlatformComposerDraft } from './platforms';
import { makeId, getPublications, isPublicationLocked, isContentDeletionLocked, stagePlatformLifecycle, withPlatformReceipt, duplicateContent, reconcileContentSnapshots, syncStoredContent, recoverPlatformReceipt, CONTENT_STORAGE_KEY, PLATFORMS, type ContentItem, type ContentStatus, type PlatformId } from './model';
import { loadContent, saveContent, readStoredContent, loadAssets, refreshAssets, saveAssets as persistAssets, resolveImage, getLocalStorageError } from './local-storage';
import { createLocalBackup, parseLocalBackup, type ParsedLocalBackup } from './local-backup';

type Page = 'dashboard' | 'content' | 'calendar' | 'assets' | 'accounts';
const pageNames: Record<Page, string> = { dashboard: '工作台', content: '内容管理', calendar: '发布日历', assets: '素材库', accounts: '平台账号' };
const statusLabels: Record<ContentStatus, string> = { draft: '草稿', scheduled: '待发布', published: '已发布' };
const PHOTO = 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=600&q=85';
const CHROME_CONNECTION_SETTINGS = 'chrome://inspect/#remote-debugging';
const formatDate = (value: string, withTime = false) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}) });

export function PlatformIcon({ id, small = false }: { id: PlatformId; small?: boolean }) {
  return <span className={`platform-icon ${id} ${small ? 'small' : ''}`} title={PLATFORMS.find(p => p.id === id)?.name}>
    {id === 'xiaohongshu' ? <span className="xhs-word">小红书</span> : id === 'douyin' ? <span className="douyin-note">♪</span> : id === 'bilibili' ? <TvMinimal size={small ? 14 : 20} strokeWidth={2.2} /> : <svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M24 16c-1-1-3-1-4-1 0-2-1-3-3-2-3 1-3-2-5-1-5 3-8 7-7 10 1 4 9 6 15 3 5-2 7-6 4-9Z" fill="currentColor"/><ellipse cx="14" cy="20" rx="7" ry="4.5" fill="white"/><ellipse cx="14" cy="20" rx="3.5" ry="3" fill="currentColor"/><circle cx="13" cy="19" r="1.2" fill="white"/><path d="M22 8c4 0 6 2 6 6M22 4c6 0 10 4 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>}
  </span>;
}

function Status({ status }: { status: ContentStatus }) { return <span className={`status status-${status}`}>{status === 'published' ? <CircleCheck size={12} /> : status === 'scheduled' ? <Clock3 size={12} /> : <span className="status-dot" />}{statusLabels[status]}</span>; }

let contentOperations: Promise<unknown> = Promise.resolve();
function withContentLock<T>(action: () => T | Promise<T>): Promise<T> {
  const operation = contentOperations.then(() => navigator.locks ? navigator.locks.request(CONTENT_STORAGE_KEY, action) : action());
  contentOperations = operation.catch(() => undefined);
  return operation;
}

const samePublishPayload = async (first: ContentItem, second: ContentItem) => {
  const payload = async (item: ContentItem) => JSON.stringify({ title: item.title, body: item.body, images: await Promise.all(item.images.map(resolveImage)), platforms: item.platforms });
  const [left, right] = await Promise.all([payload(first), payload(second)]);
  return left === right;
};

export default function App() {
  const [page, setPage] = useState<Page>(() => new URLSearchParams(window.location.search).get('page') === 'accounts' ? 'accounts' : 'dashboard');
  const [items, setItems] = useState<ContentItem[]>(loadContent);
  const [filter, setFilter] = useState<'all' | ContentStatus>('all');
  const [platform, setPlatform] = useState<'all' | PlatformId>('all');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState<'default' | 'newest' | 'oldest'>('default');
  const [composer, setComposer] = useState<{ item?: ContentItem } | null>(null);
  const [toast, setToast] = useState('');
  const [info, setInfo] = useState<'help' | 'inspiration' | 'workspace' | null>(null);
  const [notifications, setNotifications] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [deleteItem, setDeleteItem] = useState<ContentItem | null>(null);
  const [importPreview, setImportPreview] = useState<(ParsedLocalBackup & { filename: string }) | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportingRef = useRef(false);
  const [importBusy, setImportBusy] = useState<'read' | 'save' | null>(null);
  const [importError, setImportError] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const importingRef = useRef(false);
  const [calendarDate, setCalendarDate] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [assetImages, setAssetImages] = useState<string[]>(loadAssets);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadingAssetsRef = useRef(false);
  const [uploadingAssets, setUploadingAssets] = useState(false);
  const watermarkPreferences = useWatermarkPreferences();
  const { assetUploadsEnabled: watermarkAssetUploads, setAssetUploadsEnabled: setWatermarkAssetUploads } = watermarkPreferences;
  const [showAssetWatermarkSettings, setShowAssetWatermarkSettings] = useState(false);
  const [assetWatermarkEditorVersion, setAssetWatermarkEditorVersion] = useState(0);
  const [pendingAssetImages, setPendingAssetImages] = useState<string[] | null>(null);
  const assetWatermarkEditorExpanded = watermarkPreferences.ready && showAssetWatermarkSettings && (watermarkAssetUploads || Boolean(pendingAssetImages));
  const [accounts, setAccounts] = useState<Partial<Record<PlatformId, PlatformAccountState | null>>>({});
  const [accountErrors, setAccountErrors] = useState<Partial<Record<PlatformId, string>>>({});
  const dismissedAccountErrorsRef = useRef<Partial<Record<PlatformId, string>>>({});
  const [accountBusy, setAccountBusy] = useState<Partial<Record<PlatformId, boolean>>>({});
  const [chromeCopyStatus, setChromeCopyStatus] = useState<'idle' | 'copied' | 'manual'>('idle');
  const [showChromeConnectionGuide, setShowChromeConnectionGuide] = useState(true);
  const chromeAddressRef = useRef<HTMLInputElement>(null);
  const currentChromeMode = Object.values(accounts).some(state => state?.browserMode === 'current-chrome') || !Object.values(accounts).some(Boolean);
  const [publishing, setPublishing] = useState<PlatformId | null>(null);
  const [deletingContent, setDeletingContent] = useState(false);
  const itemsRef = useRef(items);
  const accountsRef = useRef(accounts);
  const publishingRef = useRef<PlatformId | null>(null);
  const accountOperationsRef = useRef(new Set<PlatformId>());
  const accountRevisionRef = useRef<Partial<Record<PlatformId, number>>>({});

  const notify = (message: string) => setToast(message);
  const copyChromeSettings = async () => {
    try { await navigator.clipboard.writeText(CHROME_CONNECTION_SETTINGS); setChromeCopyStatus('copied'); }
    catch { chromeAddressRef.current?.focus(); chromeAddressRef.current?.select(); setChromeCopyStatus('manual'); }
  };
  const navigate = (next: Page) => { setPage(next); setMobileNav(false); setSearch(''); setFilter('all'); setSelectedDay(null); window.scrollTo(0, 0); };
  const applyItems = (next: ContentItem[], newComposerId?: string) => {
    itemsRef.current = next; setItems(next);
    setComposer(current => {
      if (!current) return current;
      const id = current.item?.id || newComposerId;
      const updated = next.find(value => value.id === id);
      if (!updated && current.item && isPublicationLocked(current.item)) return null;
      return updated && (newComposerId === id || isPublicationLocked(updated) || isPublicationLocked(current.item)) ? { item: updated } : current;
    });
  };
  // This read never falls back to sample data: a failed read must stop a write.
  const latestItems = async () => {
    const stored = await readStoredContent();
    if (!stored.ok) throw new Error(getLocalStorageError() || '无法读取最新本地内容，请检查本地服务后重试。');
    if (!stored.items) return itemsRef.current;
    return syncStoredContent(itemsRef.current, stored.items);
  };
  const saveItem = (item: ContentItem) => withContentLock(async () => {
    const current = await latestItems();
    applyItems(current);
    if (item.status === 'published') throw new Error('只有平台确认发布后，内容才会进入已发布记录。');
    if (isPublicationLocked(item) || isPublicationLocked(current.find(value => value.id === item.id))) throw new Error('这条内容已有真实发布记录或待确认请求，请在对应平台的原文管理中修改。');
    const proposed = current.some(value => value.id === item.id) ? current.map(value => value.id === item.id ? item : value) : [item, ...current];
    const next = reconcileContentSnapshots(proposed, current);
    if (!next.some(value => value.id === item.id)) throw new Error('这条内容已在其他标签页删除，请复制为新草稿。');
    if (!await saveContent(next)) throw new Error(getLocalStorageError() || '本地保存失败，请检查本地服务与硬盘空间后重试。');
    applyItems(loadContent()); setComposer(null); notify(item.status === 'draft' ? '草稿已保存，灵感随时续写' : '已加入本地发布计划');
    return true;
  });
  const deleteContent = async (id: string) => {
    if (deletingContent || publishingRef.current) return;
    setDeletingContent(true);
    try {
      await withContentLock(async () => {
        let current = await latestItems();
        applyItems(current);
        const existing = current.find(item => item.id === id);
        if (!existing) throw new Error('这条内容已在其他标签页移除。');
        if (isContentDeletionLocked(existing)) throw new Error('请先删除所有已发布平台的原文，并核对未完成操作，再删除本地记录。');
        const status = await getContentDeletionStatus(id);
        if (!status.canDelete || status.pending) throw new Error('服务端仍有平台原文或结果待确认，暂不能删除本地记录。');
        current = await latestItems();
        const latest = current.find(item => item.id === id);
        if (!latest || isContentDeletionLocked(latest)) throw new Error('发布状态已变化，暂不能删除本地记录。');
        const allReceiptsConfirmed = Object.entries(getPublications(latest)).every(([platform, publication]) => !publication?.receipt || status.publications.some(entry => entry.platform === platform && entry.publicationRequestId === publication.receipt!.requestId && entry.receipt.id === publication.receipt!.id && entry.receipt.account.uid === publication.receipt!.account.uid && Boolean(entry.receipt.deletedAt)));
        if (!allReceiptsConfirmed) throw new Error('服务端未能确认全部本地回执的原文已删除，本地记录已保留。');
        const next = current.filter(item => item.id !== id);
        if (!await saveContent(next)) throw new Error(getLocalStorageError() || '本地删除操作未能保存，请稍后重试。');
        applyItems(loadContent()); setDeleteItem(null); notify('本地记录已删除');
      });
    } catch (error) { notify(error instanceof Error ? error.message : '无法核实平台删除状态，本地记录已保留。'); }
    finally { setDeletingContent(false); }
  };
  const storePublication = (item: ContentItem, mustPersist = false, release?: { platform: PlatformId; requestId: string; kind?: 'lifecycle' }) => withContentLock(async () => {
    const current = await latestItems();
    const previous = current.find(value => value.id === item.id);
    if (mustPersist && previous && isPublicationLocked(previous) && !await samePublishPayload(previous, item)) {
      applyItems(current, item.id);
      throw new Error('其他标签页已锁定不同的发布内容。已同步最新内容，请返回并重新核对。');
    }
    const proposed = current.some(value => value.id === item.id) ? current.map(value => value.id === item.id ? item : value) : [item, ...current];
    const next = reconcileContentSnapshots(proposed, current);
    let updated = next.find(value => value.id === item.id)!;
    if (!updated) throw new Error('这条内容已在其他标签页删除，不能继续平台操作。');
    if (release) {
      const publication = getPublications(updated)[release.platform];
      // Only an explicit pre-submit rejection may release the same pending key.
      if (release.kind === 'lifecycle' && publication?.lifecycle?.requestId === release.requestId && publication.lifecycle.state === 'pending' && publication.receipt?.lastOperation?.requestId !== release.requestId) {
        const publications = { ...getPublications(updated), [release.platform]: { ...publication, lifecycle: undefined } };
        updated = { ...updated, platformPublications: publications };
        next[next.findIndex(value => value.id === item.id)] = updated;
      } else if (!release.kind && publication?.requestId === release.requestId && publication.state === 'pending' && !publication.receipt) {
        const publications = { ...getPublications(updated) };
        delete publications[release.platform];
        updated = { ...updated, platformPublications: publications,
          ...(release.platform === 'weibo' ? { weiboRequestId: undefined, weiboPublishState: undefined, weiboReceipt: undefined } : {}) };
        next[next.findIndex(value => value.id === item.id)] = updated;
      }
    }
    const saved = await saveContent(next);
    if (mustPersist && !saved) throw new Error(getLocalStorageError() || '待发布内容未能保存，尚未发送。请检查本地服务与硬盘空间后重试。');
    const committed = saved ? loadContent() : next;
    updated = committed.find(value => value.id === item.id) || updated;
    applyItems(committed, item.id);
    return { saved, item: updated };
  });
  const applyAccount = (platformId: PlatformId, state: PlatformAccountState) => {
    accountsRef.current = { ...accountsRef.current, [platformId]: state };
    setAccounts(accountsRef.current);
  };
  const dismissAccountError = (platformId: PlatformId) => {
    dismissedAccountErrorsRef.current[platformId] = accountErrors[platformId];
    setAccountErrors(current => ({ ...current, [platformId]: '' }));
  };
  const runAccountOperation = async (platformId: PlatformId, action: () => Promise<PlatformAccountState>, duringPublish = false): Promise<PlatformAccountState> => {
    if (accountOperationsRef.current.has(platformId) || publishingRef.current && (!duringPublish || publishingRef.current !== platformId)) throw new PlatformRequestError('账号或发布请求正在处理，请稍候再试。', 'PUBLISH_BUSY', false);
    accountOperationsRef.current.add(platformId);
    accountRevisionRef.current[platformId] = (accountRevisionRef.current[platformId] || 0) + 1;
    delete dismissedAccountErrorsRef.current[platformId];
    setAccountBusy(current => ({ ...current, [platformId]: true })); setAccountErrors(current => ({ ...current, [platformId]: '' }));
    try { const state = await action(); applyAccount(platformId, state); return state; }
    catch (error) { setAccountErrors(current => ({ ...current, [platformId]: error instanceof Error ? error.message : '平台连接暂时不可用' })); throw error; }
    finally { accountOperationsRef.current.delete(platformId); setAccountBusy(current => ({ ...current, [platformId]: false })); }
  };
  const updateConnection = async (platformId: PlatformId, action: () => Promise<PlatformAccountState>, rethrow = false) => {
    try { await runAccountOperation(platformId, action); }
    catch (error) { setAccountErrors(current => ({ ...current, [platformId]: error instanceof Error ? error.message : '平台连接暂时不可用' })); if (rethrow) throw error; }
  };
  const preparePlatform = (platformId: PlatformId) => runAccountOperation(platformId, () => resumePlatform(platformId));
  const connectPlatform = (platformId: PlatformId, mode: 'qr' | 'window' = 'window') => updateConnection(platformId, () => {
    if (mode === 'window') return openPlatform(platformId);
    const state = accountsRef.current[platformId];
    return state?.login?.kind === 'qr' && state.browserOpen ? refreshPlatform(platformId) : loginPlatform(platformId, 'qr');
  }, true);
  const manageComposerDraft = async (platformId: PlatformId, snapshot?: PlatformComposerDraft): Promise<PlatformComposerDraft> => {
    if (publishingRef.current || accountOperationsRef.current.has(platformId)) throw new PlatformRequestError('账号或平台操作正在处理，请稍候。', 'PUBLISH_BUSY', false);
    publishingRef.current = platformId; setPublishing(platformId);
    try {
      const fresh = await runAccountOperation(platformId, () => resumePlatform(platformId), true);
      const account = requireConnectedPlatformAccount(platformId, fresh, snapshot?.account.uid);
      // Dedicated editor maintenance never modifies local content or publication metadata.
      return snapshot
        ? await clearPlatformComposerDraft(platformId, account.uid, snapshot.draft.fingerprint)
        : await getPlatformComposerDraft(platformId, account.uid);
    } finally { publishingRef.current = null; setPublishing(null); }
  };
  const publishToPlatform = async (platformId: PlatformId, item: ContentItem, requestId: string, expectedAccountUid: string, continueOnly = false): Promise<ContentItem> => {
    if (publishingRef.current || accountOperationsRef.current.has(platformId)) throw new Error('账号或发布请求正在处理，请稍候。');
    publishingRef.current = platformId; setPublishing(platformId);
    let prepared: ContentItem | undefined;
    let previous: ReturnType<typeof getPublications>[PlatformId];
    try {
      const currentItems = await withContentLock(async () => { const current = await latestItems(); applyItems(current); return current; });
      const current = currentItems.find(value => value.id === item.id);
      const source = current && isPublicationLocked(current) ? current : item;
      if (current && isPublicationLocked(current) && !await samePublishPayload(current, item)) throw new Error('其他标签页已锁定不同的内容。已同步最新状态，请返回并重新核对。');
      const publications = getPublications(source);
      previous = publications[platformId];
      if (previous?.state === 'published') throw new Error('这条内容已在其他标签页发布到该平台，请查看原文。');
      if (previous && previous.requestId !== requestId) throw new Error('其他标签页已开始发布。请沿用该平台原有请求，避免重复发送。');
      if (previous?.expectedAccountUid && previous.expectedAccountUid !== expectedAccountUid) throw new Error('请登录上次确认的账号，再核对同一发布请求。');
      const errors = validatePlatformPublish(platformId, source);
      if (errors.length) throw new Error(errors.join(' '));
      const freshState = await runAccountOperation(platformId, () => resumePlatform(platformId), true);
      (previous ? requireConnectedPlatformAccount : requireReadyPlatformAccount)(platformId, freshState, expectedAccountUid);
      const content = await preparePlatformContent(source);
      prepared = { ...content, status: 'draft', scheduledAt: undefined, publishedAt: undefined, publishMode: 'real', platformPublications: { ...publications, [platformId]: { requestId, state: 'pending', expectedAccountUid } } };
      const staged = await storePublication(prepared, true);
      const stagedPublication = getPublications(staged.item)[platformId];
      if (stagedPublication?.state === 'published') throw new Error('这条内容已在其他标签页发布，请查看已同步的原文回执。');
      if (stagedPublication?.requestId !== requestId || stagedPublication?.expectedAccountUid !== expectedAccountUid) throw new Error('其他标签页已开始发布。请返回并核对已同步的原请求。');
      prepared = staged.item;
      const receipt = await publishPlatform(platformId, prepared, requestId, expectedAccountUid, previous ? continueOnly ? { continueOnly: true } : { reconcileOnly: true } : undefined);
      const stored = itemsRef.current.find(value => value.id === prepared?.id) || prepared;
      const published = withPlatformReceipt(stored, receipt);
      const result = await storePublication(published);
      notify(result.saved ? `${PLATFORMS.find(p => p.id === platformId)?.name}已发布，回执已保存` : '已发布；本地回执保存失败，重载后将从服务恢复');
      return result.item;
    } catch (error) {
      if (prepared && itemsRef.current.find(i => i.id === prepared?.id)?.platformPublications?.[platformId]?.requestId === requestId) {
        const rejectedBeforeSubmit = error instanceof PlatformRequestError && error.submitted === false;
        const stored = itemsRef.current.find(value => value.id === prepared?.id) || prepared;
        if (getPublications(stored)[platformId]?.state === 'published') return stored;
        const nextPublications = { ...getPublications(stored) };
        const release = rejectedBeforeSubmit && !previous ? { platform: platformId, requestId } : undefined;
        if (!release) nextPublications[platformId] = { requestId, expectedAccountUid, state: 'uncertain' };
        try { await storePublication({ ...stored, platformPublications: nextPublications }, false, release); }
        catch { /* The existing durable pending payload remains protected if storage becomes unavailable. */ }
        if (error instanceof PlatformRequestError && error.code === 'CAPTCHA_REQUIRED' && !release) throw new PlatformRequestError(error.message, error.code, true);
        if (!rejectedBeforeSubmit || previous) throw new PlatformRequestError('发布结果尚未确认。请先到平台查看，再核对同一请求；成功平台不会再次发送。', 'PUBLISH_UNCERTAIN');
      }
      throw error;
    } finally { publishingRef.current = null; setPublishing(null); }
  };
  const operateOnPublication = async (platformId: PlatformId, operation: 'update' | 'delete', item: ContentItem, requestId: string, title?: string, body?: string): Promise<ContentItem> => {
    if (publishingRef.current || accountOperationsRef.current.has(platformId)) throw new PlatformRequestError('账号或平台操作正在处理，请稍候。', 'PUBLISH_BUSY', false);
    publishingRef.current = platformId; setPublishing(platformId);
    let staged: ContentItem | undefined;
    try {
      const current = await withContentLock(async () => { const next = await latestItems(); applyItems(next); return next.find(value => value.id === item.id); });
      if (!current) throw new PlatformRequestError('本地内容已被移除，不能继续操作原文。', 'CONTENT_NOT_FOUND', false);
      const publication = getPublications(current)[platformId];
      const reviewed = getPublications(item)[platformId]?.receipt;
      if (!publication?.receipt || publication.receipt.deletedAt) throw new PlatformRequestError('原文没有有效回执，或已经删除。', 'PUBLICATION_NOT_FOUND', false);
      if (publication.lifecycle) throw new PlatformRequestError('已有操作结果待核对，请使用“核对操作结果”，不会重复提交。', 'OPERATION_PENDING', false);
      if (!reviewed || reviewed.id !== publication.receipt.id || reviewed.requestId !== publication.receipt.requestId || reviewed.updatedAt !== publication.receipt.updatedAt || reviewed.lastOperation?.requestId !== publication.receipt.lastOperation?.requestId) throw new PlatformRequestError('原文已在其他标签页发生变化，请重新核对后操作。', 'PUBLICATION_CHANGED', false);
      if (operation === 'update') {
        const errors = validatePlatformUpdate(platformId, title || '', body || '');
        if (errors.length) throw new PlatformRequestError(errors.join(' '), 'VALIDATION_ERROR', false);
      }
      const fresh = await runAccountOperation(platformId, () => resumePlatform(platformId), true);
      requireReadyPlatformAccount(platformId, fresh, publication.receipt.account.uid);
      const pending = stagePlatformLifecycle(current, platformId, { operation, requestId, state: 'pending', ...(operation === 'update' ? { title: (title || '').trim(), body: (body || '').trim() } : {}) });
      const stored = await storePublication(pending, true);
      const active = getPublications(stored.item)[platformId];
      if (active?.lifecycle?.requestId !== requestId || active.lifecycle.operation !== operation) throw new PlatformRequestError('其他标签页已开始操作，请先核对最新结果。', 'OPERATION_PENDING', false);
      staged = stored.item;
      const result = operation === 'update'
        ? await updatePlatformPublication(platformId, staged, active, requestId, title || '', body || '')
        : await deletePlatformPublication(platformId, staged, active, requestId);
      const latest = itemsRef.current.find(value => value.id === item.id) || staged;
      const updated = withPlatformReceipt(latest, { ...result.receipt, lastOperation: result.operation });
      const completed = await storePublication(updated);
      const confirmed = getPublications(completed.item)[platformId];
      if (confirmed?.lifecycle || confirmed?.receipt?.lastOperation?.requestId !== requestId) throw new PlatformRequestError('操作回执尚未完成同步，请核对结果，不会重复提交。', 'OPERATION_UNCERTAIN', true);
      notify(operation === 'update' ? '平台原文文字已更新' : '平台原文已确认删除');
      return completed.item;
    } catch (error) {
      if (staged) {
        const current = itemsRef.current.find(value => value.id === staged?.id) || staged;
        const publication = getPublications(current)[platformId];
        if (publication?.receipt?.lastOperation?.requestId === requestId && !publication.lifecycle) return current;
        if (publication?.lifecycle?.requestId === requestId) {
          const beforeSubmit = error instanceof PlatformRequestError && error.submitted === false;
          const failed = beforeSubmit ? current : { ...current, platformPublications: { ...getPublications(current), [platformId]: { ...publication, lifecycle: { ...publication.lifecycle, state: 'uncertain' as const } } } };
          try { await storePublication(failed, false, beforeSubmit ? { platform: platformId, requestId, kind: 'lifecycle' } : undefined); }
          catch { /* The durable pending operation remains protected if local storage fails. */ }
          if (!beforeSubmit) throw new PlatformRequestError('操作结果尚未确认。请核对平台原文和操作回执，控制台不会重复执行。', 'OPERATION_UNCERTAIN', true);
        }
      }
      throw error;
    } finally { publishingRef.current = null; setPublishing(null); }
  };
  const checkPublicationResult = async (platformId: PlatformId, contentId: string, retryUpdate = false): Promise<ContentItem> => {
    if (publishingRef.current || accountOperationsRef.current.has(platformId)) throw new PlatformRequestError('账号或平台操作正在处理，请稍候。', 'PUBLISH_BUSY', false);
    publishingRef.current = platformId; setPublishing(platformId);
    try {
      const source = await withContentLock(async () => { const current = await latestItems(); applyItems(current); return current.find(value => value.id === contentId); });
      if (!source) throw new Error('本地记录已移除。');
      const publication = getPublications(source)[platformId];
      const operation = publication?.lifecycle;
      if (operation) {
        const original = publication.receipt;
        if (!original) throw new PlatformRequestError('缺少原文回执，已保留待核对操作。', 'PUBLICATION_NOT_FOUND', false);
        const fresh = await runAccountOperation(platformId, () => resumePlatform(platformId), true);
        // Read-only recovery needs the original account, not an available publisher.
        requireConnectedPlatformAccount(platformId, fresh, original.account.uid);
        const current = await withContentLock(async () => { const items = await latestItems(); applyItems(items); return items.find(value => value.id === contentId); });
        if (!current) throw new Error('本地记录已移除。');
        const active = getPublications(current)[platformId];
        if (!active?.lifecycle) return current;
        if (active.receipt?.id !== original.id || active.receipt.requestId !== original.requestId || active.receipt.account.uid !== original.account.uid
          || active.lifecycle.requestId !== operation.requestId || active.lifecycle.operation !== operation.operation
          || active.lifecycle.title !== operation.title || active.lifecycle.body !== operation.body) {
          throw new PlatformRequestError('待核对操作已变化，请重新查看当前记录。', 'OPERATION_CHANGED', false);
        }
        // Replaying this exact durable operation only asks the service to inspect
        // the native result; a pending request never submits its mutation again.
        const result = operation.operation === 'update'
          ? await updatePlatformPublication(platformId, current, active, operation.requestId, operation.title ?? '', operation.body ?? '', retryUpdate ? { retryUpdate: true } : { reconcileOnly: true })
          : await deletePlatformPublication(platformId, current, active, operation.requestId, { reconcileOnly: true });
        const latest = itemsRef.current.find(value => value.id === contentId) || current;
        const updated = withPlatformReceipt(latest, { ...result.receipt, lastOperation: result.operation });
        const stored = await storePublication(updated);
        const confirmed = getPublications(stored.item)[platformId];
        if (confirmed?.lifecycle || confirmed?.receipt?.lastOperation?.requestId !== operation.requestId) throw new PlatformRequestError('尚未取得确认回执，操作继续保留，控制台不会重复执行。', 'OPERATION_UNCERTAIN', true);
        return stored.item;
      }
      const { receipts } = await getPlatformReceipts(platformId);
      return await withContentLock(async () => {
        const current = await latestItems();
        const item = current.find(value => value.id === contentId);
        if (!item) throw new Error('本地记录已移除。');
        const publication = getPublications(item)[platformId];
        const receipt = receipts.find(value => value.contentId === contentId && value.requestId === publication?.requestId);
        const updated = receipt ? recoverPlatformReceipt(item, { ...receipt, platform: platformId }) : item;
        const next = reconcileContentSnapshots(current.map(value => value.id === contentId ? updated : value), current);
        const saved = await saveContent(next); applyItems(saved ? loadContent() : next, contentId);
        return next.find(value => value.id === contentId)!;
      });
    } finally { publishingRef.current = null; setPublishing(null); }
  };
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      await Promise.allSettled(PLATFORMS.map(async ({ id }) => {
        if (publishingRef.current === id || accountOperationsRef.current.has(id)) return;
        const revision = accountRevisionRef.current[id];
        try { const state = await getPlatformAccount(id); if (active && accountRevisionRef.current[id] === revision) { applyAccount(id, state); delete dismissedAccountErrorsRef.current[id]; } }
        catch (error) {
          const message = error instanceof Error ? error.message : '本地服务暂不可用';
          if (active && accountRevisionRef.current[id] === revision && dismissedAccountErrorsRef.current[id] !== message) {
            delete dismissedAccountErrorsRef.current[id];
            setAccountErrors(current => ({ ...current, [id]: message }));
          }
        }
        try {
          const { receipts } = await getPlatformReceipts(id);
          if (!active || !receipts.length) return;
          await withContentLock(async () => {
            const current = await latestItems();
            let changed = false;
            const next = current.map(item => {
              const publication = getPublications(item)[id];
              const receipt = receipts.find(value => value.contentId === item.id && (!publication || value.requestId === publication.requestId));
              if (!receipt || JSON.stringify(publication?.receipt) === JSON.stringify(receipt)) return item;
              const updated = recoverPlatformReceipt(item, { ...receipt, platform: id });
              if (updated !== item) changed = true;
              return updated;
            });
            const merged = reconcileContentSnapshots(next, current);
            const saved = changed && await saveContent(merged);
            applyItems(saved ? loadContent() : merged);
          });
        } catch { /* A pending draft is retained until a confirmed receipt is available. */ }
      }));
    };
    let inFlight = false;
    const run = async () => { if (inFlight) return; inFlight = true; try { await refresh(); } finally { inFlight = false; } };
    void run();
    const timer = setInterval(() => { if (!document.hidden) void run(); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    let active = true;
    let running = false;
    const synchronize = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        await withContentLock(async () => {
          const [content, images] = await Promise.all([latestItems(), refreshAssets()]);
          if (active) { applyItems(content); setAssetImages(images); }
        });
      } catch { /* Explicit saves report storage errors; preserve the visible data while offline. */ }
      finally { running = false; }
    };
    const timer = setInterval(() => void synchronize(), 5000);
    window.addEventListener('focus', synchronize);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', synchronize); };
  }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenuId(null); setNotifications(false); setInfo(null); setDeleteItem(null); setMobileNav(false); if (!importingRef.current) setImportPreview(null); }
      if (event.key.toLowerCase() === 'n' && !event.metaKey && !event.ctrlKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName) && !composer && !info && !deleteItem && !importPreview) { event.preventDefault(); setComposer({}); }
    };
    window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey);
  }, [composer, info, deleteItem, importPreview]);
  useEffect(() => { document.title = `${pageNames[page]} · 发条`; }, [page]);
  useEffect(() => {
    if (!info && !deleteItem && !importPreview) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const dialog = document.querySelector<HTMLElement>('.small-dialog');
      const buttons = dialog?.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
      if (!buttons?.length) return;
      const first = buttons[0]; const last = buttons[buttons.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleTab);
    return () => { document.removeEventListener('keydown', handleTab); previousFocus?.focus(); };
  }, [info, deleteItem, importPreview]);

  const counts = { all: items.length, draft: items.filter(i => i.status === 'draft').length, scheduled: items.filter(i => i.status === 'scheduled').length, published: items.filter(i => i.status === 'published').length };
  const visibleItems = items.filter(i => (filter === 'all' || i.status === filter) && (platform === 'all' || i.platforms.includes(platform)) && `${i.title} ${i.body} ${i.category}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => sort === 'default' ? 0 : sort === 'newest' ? +new Date(b.updatedAt) - +new Date(a.updatedAt) : +new Date(a.updatedAt) - +new Date(b.updatedAt));
  const scheduled = items.filter(i => i.status === 'scheduled').sort((a, b) => +(new Date(a.scheduledAt || a.updatedAt)) - +(new Date(b.scheduledAt || b.updatedAt)));
  const assets = [...new Set([...assetImages, ...items.flatMap(i => i.images.length ? i.images : i.image ? [i.image] : [])])];
  const duplicate = (item: ContentItem) => { setMenuId(null); setComposer({ item: duplicateContent(item) }); };
  const exportContent = async () => {
    if (exportingRef.current || !watermarkPreferences.ready) return;
    exportingRef.current = true; setExporting(true);
    try {
      const backup = await withContentLock(async () => createLocalBackup(await latestItems(), await refreshAssets(), {
        version: 1, settings: watermarkPreferences.settings, assetUploadsEnabled: watermarkPreferences.assetUploadsEnabled,
      }));
      const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `发条-工作空间备份-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify('工作空间备份已导出，包含内容、素材和水印设置');
    } catch (error) { notify(error instanceof Error ? error.message : '备份导出失败，请检查本地服务后重试。'); }
    finally { exportingRef.current = false; setExporting(false); }
  };
  const readContentBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || importingRef.current) return;
    if (publishingRef.current || deletingContent) { notify('平台操作正在进行，请完成后再导入备份。'); return; }
    importingRef.current = true; setImportBusy('read'); setImportError('');
    try {
      if (file.size > 256 * 1024 * 1024) throw new Error('请选择不超过 256 MB 的备份 JSON 文件。');
      const imported = await parseLocalBackup(JSON.parse(await file.text()));
      if (!imported.items.length && !imported.assets?.length && !imported.watermark) throw new Error('这份备份没有可导入的内容。');
      setInfo(null); setImportPreview({ filename: file.name, ...imported });
    } catch (error) { notify(error instanceof SyntaxError ? 'JSON 文件无法解析，原有内容未修改。' : error instanceof Error ? error.message : '无法读取内容备份，原有内容未修改。'); }
    finally { importingRef.current = false; setImportBusy(null); }
  };
  const confirmContentImport = async () => {
    if (!importPreview || importingRef.current) return;
    if (publishingRef.current || deletingContent) { setImportError('平台操作正在进行，请完成后再导入备份。'); return; }
    importingRef.current = true; setImportBusy('save'); setImportError('');
    try {
      const next = await withContentLock(async () => {
        const current = await latestItems();
        const merged = mergeContentImport(importPreview.items, current);
        if (!await saveContent(merged)) throw new Error(getLocalStorageError() || '备份未能保存，请检查本地服务与硬盘空间。');
        const committed = loadContent();
        applyItems(committed);
        return committed;
      });
      if (importPreview.assets) setAssetImages(await persistAssets(importPreview.assets));
      if (importPreview.watermark) await watermarkPreferences.replacePreferences(importPreview.watermark);
      setImportPreview(null); navigate('content'); setPlatform('all'); setSort('default');
      notify(`备份已合并，当前共有 ${next.length} 篇内容。可以按原草稿标题搜索。`);
    } catch (error) { setImportError(`${error instanceof Error ? error.message : '备份导入未完成。'} 已保存的部分会保留，可以安全重试。`); }
    finally { importingRef.current = false; setImportBusy(null); }
  };
  const finishAssetWatermarkEditing = () => {
    setPendingAssetImages(null);
    setShowAssetWatermarkSettings(false);
    setAssetWatermarkEditorVersion(version => version + 1);
  };
  const saveAssets = async (images: string[]) => {
    const next = await persistAssets(images);
    setAssetImages(next);
    finishAssetWatermarkEditing();
    notify(`已添加 ${images.length} 张素材`);
  };
  const uploadAssets = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []); event.target.value = '';
    if (!files.length) return;
    if (!watermarkPreferences.ready) { notify('正在读取本机水印设置，请稍候'); return; }
    if (uploadingAssetsRef.current || pendingAssetImages) { notify('请先完成当前素材的水印设置'); return; }
    uploadingAssetsRef.current = true;
    setUploadingAssets(true);
    try {
      const images = await readUploadedImages(files, { forWatermark: watermarkAssetUploads });
      if (watermarkAssetUploads) {
        setPendingAssetImages(images);
        setShowAssetWatermarkSettings(true);
      }
      else await saveAssets(images);
    } catch (error) { notify(error instanceof Error ? error.message : '素材保存失败，请检查本地服务与硬盘空间'); }
    finally { uploadingAssetsRef.current = false; setUploadingAssets(false); }
  };
  const startFromImage = (image: string) => setComposer({ item: { id: makeId(), title: '', body: '', image, images: [image], platforms: ['xiaohongshu'], category: '生活方式', status: 'draft', updatedAt: new Date().toISOString() } });

  const contentCards = (data: ContentItem[]) => <div className={`content-grid ${view === 'list' ? 'list-view' : ''}`}>
    {data.map(item => <article className="content-card" key={item.id}>
      <div className="card-cover">
        <button className="cover-button" onClick={() => setComposer({ item })} aria-label={`编辑 ${item.title}`}>
          {item.image ? <img key={item.image} src={item.image} alt={item.title} loading="lazy" onLoad={e => { e.currentTarget.style.visibility = 'visible'; }} onError={e => { e.currentTarget.style.visibility = 'hidden'; }} /> : <div className="cover-placeholder"><ImageIcon size={32} /><span>还没添加封面</span></div>}
        </button>
        <Status status={item.status} />
        <div className="card-menu-wrap"><button className="card-more" aria-label={`${item.title}的更多操作`} aria-expanded={menuId === item.id} onClick={() => setMenuId(menuId === item.id ? null : item.id)}><MoreHorizontal size={19} /></button>
          {menuId === item.id && <><button className="menu-dismiss" aria-label="关闭操作菜单" onClick={() => setMenuId(null)} /><div className="card-menu"><button onClick={() => { setComposer({ item }); setMenuId(null); }}><Pencil size={14} />编辑内容</button><button onClick={() => duplicate(item)}><Copy size={14} />复制为新草稿</button><button className="danger" disabled={isContentDeletionLocked(item)} title={isContentDeletionLocked(item) ? '请先删除所有平台原文并核对操作结果' : undefined} onClick={() => { setDeleteItem(item); setMenuId(null); }}><Trash2 size={14} />删除内容</button></div></>}
        </div>
        <span className="cover-category">{item.category || '日常记录'}</span>
        {item.images.length > 1 && <span className="image-count"><Layers3 size={12} />{item.images.length}</span>}
      </div>
      <div className="card-content">
        <button className="card-title" onClick={() => setComposer({ item })}>{item.title || '还未命名的灵感'}</button>
        <p className="card-excerpt">{item.body || '故事才刚刚开始，继续写下你的灵感…'}</p>
        <div className="card-meta"><div className="platform-stack">{item.platforms.map(id => <PlatformIcon id={id} small key={id} />)}<span>{item.platforms.length} 个平台</span></div>{Object.values(getPublications(item)).some(p => p?.receipt) ? <span className="card-date"><CheckCheck size={13} />真实发布</span> : item.status === 'published' ? <span className="card-date"><Eye size={13} />{((item.views || 0) / 1000).toFixed(1)}k</span> : <span className="card-date"><Clock3 size={12} />{formatDate(item.scheduledAt || item.updatedAt)}</span>}</div>
        {PLATFORMS.map(({ id, name }) => { const publication = getPublications(item)[id]; return publication?.receipt ? <div className="card-real-receipt" key={id}>{publication.receipt.deletedAt ? <span><CheckCheck size={12} />{name}原文已删除</span> : <a href={publication.receipt.url} target="_blank" rel="noreferrer"><CheckCheck size={12} />{name}{publication.lifecycle ? '操作待核对' : '已发布'} · 查看原文<ArrowUpRight size={12} /></a>}</div> : publication ? <div className="card-real-receipt pending" key={id}><Clock3 size={12} />{name}结果待核实</div> : null; })}
      </div>
    </article>)}
  </div>;

  const calendarYear = calendarDate.getFullYear(); const calendarMonth = calendarDate.getMonth();
  const firstWeekDay = (new Date(calendarYear, calendarMonth, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  const calendarItems = items.filter(i => i.status !== 'draft');
  const localDay = (value: string) => { const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const today = localDay(new Date().toISOString());

  return <div className="app-shell">
    {mobileNav && <button className="sidebar-scrim" aria-label="收起导航" onClick={() => setMobileNav(false)} />}
    <aside className={`sidebar ${mobileNav ? 'is-open' : ''}`}>
      <a className="brand" href="#" onClick={e => { e.preventDefault(); navigate('dashboard'); }}><span className="brand-logo"><Send size={24} fill="white" strokeWidth={1.5} /></span><span className="brand-name">发条<span>让创作自由发生</span></span></a>
      <button className="workspace-selector" onClick={() => setInfo('workspace')}><span className="workspace-avatar">创</span><span>我的工作空间<small>内容与素材管理</small></span><ChevronsUpDown size={14} /></button>
      <div className="nav-label">创作中心</div>
      <nav aria-label="主导航">{([{ id: 'dashboard', icon: House }, { id: 'content', icon: Layers3 }, { id: 'calendar', icon: CalendarDays }] as const).map(({ id, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => navigate(id)}><Icon size={19} strokeWidth={1.7} /><span>{pageNames[id]}</span>{id === 'content' && <span className="nav-counter">{items.length}</span>}{id === 'dashboard' && page === id && <span className="active-dot" />}</button>)}</nav>
      <div className="nav-label second-label">工作空间</div>
      <nav aria-label="空间导航">{([{ id: 'assets', icon: ImageIcon }, { id: 'accounts', icon: Link2 }] as const).map(({ id, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => navigate(id)}><Icon size={19} strokeWidth={1.7} /><span>{pageNames[id]}</span>{id === 'accounts' && <span className="account-dots"><i /><i /><i /><i /></span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="inspiration-card"><span className="inspiration-icon"><Sparkles size={20} /></span><strong>今天，也有好灵感</strong><p>从一个小小的想法开始。</p><button onClick={() => setInfo('inspiration')}>找点创作灵感<ArrowUpRight size={14} /></button><span className="inspiration-spark">✳</span></div>
        <button className="help-button" onClick={() => setInfo('help')}><CircleHelp size={18} />使用指南<ArrowUpRight size={14} /></button>
        <button className="user-profile" onClick={() => setInfo('workspace')}><span className="profile-avatar"><img src="https://images.unsplash.com/photo-1472396961693-142e6e269027?auto=format&fit=crop&w=100&q=80" alt="" /></span><span><strong>工作空间管理</strong><small>查看概况与备份</small></span><Settings2 size={16} /></button>
      </div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="mobile-menu icon-button" aria-label="打开导航" onClick={() => setMobileNav(true)}><Menu size={20} /></button><House size={16} /><span>/</span><span>{pageNames[page]}</span></div><div className="topbar-actions"><span className="demo-indicator"><span />{Object.values(accounts).some(hasBoundPlatformAccount) ? `${Object.values(accounts).filter(hasBoundPlatformAccount).length} 个账号已绑定` : '本地工作空间'}</span><span className="topbar-divider" /><div className="notification-wrap"><button className="icon-button notification-button" aria-label="通知" aria-expanded={notifications} onClick={() => setNotifications(!notifications)}><Bell size={18} /><i /></button>{notifications && <div className="notification-panel"><div><strong>工作空间动态</strong><button className="icon-button" aria-label="关闭通知" onClick={() => setNotifications(false)}><X size={15} /></button></div><p><Clock3 size={17} /><span>有 {counts.scheduled} 条内容等待发布<small>本地计划需要手动确认发布</small></span></p><p><CheckCheck size={17} /><span>你的灵感已妥善保存<small>草稿与素材已保存到本机</small></span></p><button className="text-link" onClick={() => { navigate('calendar'); setNotifications(false); }}>查看发布日历 <ArrowRight size={14} /></button></div>}</div><button className="top-avatar" onClick={() => setInfo('workspace')} aria-label="查看工作空间">创</button></div></header>

      <main>
        <div className="page-heading"><div><div className="greeting"><Sun size={15} />今天，继续创作</div><h1>{page === 'dashboard' ? '内容工作台' : pageNames[page]}{page === 'dashboard' && <span className="heading-dot">.</span>}</h1><p>{page === 'dashboard' ? '集中管理内容，轻松发布到多个平台。' : page === 'content' ? '整理草稿、查看进度，随时继续创作。' : page === 'calendar' ? '查看发布记录与计划，安排下一篇内容。' : page === 'assets' ? '集中收纳图片，随时用于新的创作。' : '连接平台账号，统一管理发布。'}</p></div><div className="heading-actions">{page === 'assets' ? <button className="primary-button" disabled={!watermarkPreferences.ready || uploadingAssets || Boolean(pendingAssetImages)} onClick={() => uploadRef.current?.click()}><Upload size={17} />{uploadingAssets ? '正在读取…' : '上传素材'}</button> : <button className="primary-button" onClick={() => setComposer({})}><Plus size={19} />新建内容<kbd>N</kbd></button>}</div></div>

        {page === 'dashboard' && <>
          <section className="hero-banner"><div className="hero-copy"><div className="hero-eyebrow"><span /> CREATE ONCE, SHARE EVERYWHERE</div><h2>好内容，值得被更多人看见<span>。</span></h2><p>一处编辑图文，逐个平台预览、核对与发布。</p><div className="hero-platforms">{PLATFORMS.map(p => <button key={p.id} onClick={() => { setPlatform(p.id); setFilter('all'); document.getElementById('my-content')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}><PlatformIcon id={p.id} small /><span>{p.name}</span></button>)}</div></div><div className="hero-art" aria-hidden="true"><span className="art-orbit" /><Flower2 className="art-flower" size={43} strokeWidth={1.25} /><div className="art-paper back-paper" /><div className="art-paper photo-paper"><div className="paper-tape" /><img src={PHOTO} alt="" /><div>把生活，写成喜欢的样子 <Heart size={10} /></div></div><div className="art-social social-one"><PlatformIcon id="xiaohongshu" /></div><div className="art-social social-two"><PlatformIcon id="douyin" /></div><div className="art-published"><span><Check size={13} /></span>一份灵感，无限可能<Sparkles size={13} /></div><MousePointer2 className="art-cursor" size={27} fill="#616d56" stroke="white" /><span className="art-star">✦</span><span className="art-dot" /></div></section>
          <section className="stats-grid" aria-label="内容统计">{[{ label: '全部内容', value: counts.all, icon: Layers3, name: 'all', suffix: '每一份灵感都算数', color: 'gray' }, { label: '已发布', value: counts.published, icon: Send, name: 'published', suffix: '与世界分享日常', color: 'green' }, { label: '待发布', value: counts.scheduled, icon: Clock3, name: 'scheduled', suffix: '好内容，即将登场', color: 'orange' }, { label: '草稿箱', value: counts.draft, icon: FileText, name: 'draft', suffix: '灵感正在酝酿中', color: 'purple' }].map(({ label, value, icon: Icon, name, suffix, color }) => <button className={`stat-card stat-${color}`} key={name} onClick={() => { setFilter(name as typeof filter); document.getElementById('my-content')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}><div className="stat-content"><span>{label}</span><strong>{String(value).padStart(2, '0')}<small>篇</small></strong><p>{suffix}</p></div><div className="stat-icon"><Icon size={21} strokeWidth={1.6} /></div><ArrowUpRight className="stat-arrow" size={14} /></button>)}</section>
        </>}

        {(page === 'dashboard' || page === 'content') && <section className="content-section" id="my-content"><div className="section-heading"><h2>{page === 'dashboard' ? '我的内容' : '内容库'}<span>{items.length}</span></h2><div className="section-heading-right">{page === 'dashboard' ? <span className="autosave"><span />所有灵感，安心保存</span> : <><button className="text-link muted" disabled={Boolean(importBusy)} onClick={() => importRef.current?.click()}><Upload size={14} />{importBusy === 'read' ? '正在读取备份…' : '导入内容备份'}</button><button className="text-link muted" disabled={exporting || !watermarkPreferences.ready} onClick={() => void exportContent()}><Download size={14} />{exporting ? '正在打包…' : '导出备份'}</button></>}</div></div>
          <div className="content-toolbar"><div className="filter-tabs" role="tablist" aria-label="内容状态">{(['all', 'draft', 'scheduled', 'published'] as const).map(status => <button key={status} className={filter === status ? 'selected' : ''} role="tab" aria-selected={filter === status} onClick={() => setFilter(status)}>{status === 'all' ? '全部内容' : status === 'draft' ? '草稿箱' : statusLabels[status]}<span>{counts[status]}</span></button>)}</div><div className="toolbar-controls"><label className="search-box"><Search size={15} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索内容…" aria-label="搜索内容" />{search && <button onClick={() => setSearch('')} aria-label="清除搜索"><X size={13} /></button>}</label><label className="platform-filter"><select value={platform} onChange={e => setPlatform(e.target.value as typeof platform)} aria-label="筛选平台"><option value="all">全部平台</option>{PLATFORMS.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select><ChevronDown size={13} /></label><label className="sort-control" title="内容排序"><ArrowDownWideNarrow size={17} /><select value={sort} onChange={e => setSort(e.target.value as typeof sort)} aria-label="内容排序"><option value="default">默认排序</option><option value="newest">最近更新</option><option value="oldest">最早更新</option></select></label><div className="view-switch"><button className={view === 'grid' ? 'active' : ''} onClick={() => setView('grid')} aria-label="卡片视图" aria-pressed={view === 'grid'}><LayoutGrid size={16} /></button><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} aria-label="列表视图" aria-pressed={view === 'list'}><List size={17} /></button></div></div></div>
          {visibleItems.length ? contentCards(visibleItems) : <div className="empty-state"><Search size={32} /><h3>{search ? '没有找到这份灵感' : '这里还有无限可能'}</h3><p>{search ? '试试其他关键词，或调整平台和状态筛选。' : '创建一篇内容，开启你的下一次分享。'}</p><button className="secondary-button" onClick={() => { setSearch(''); setPlatform('all'); setFilter('all'); }}>查看全部内容</button></div>}
          <div className="content-bottom"><span>共 {visibleItems.length} 篇内容<span className="bottom-dot">·</span>每一次记录，都有意义</span><span><span className="tiny-brand">✳</span> 用发条，把热爱分享出去</span></div>
        </section>}

        {page === 'calendar' && <section className="calendar-section"><div className="calendar-toolbar"><h2>{calendarYear} 年 <span>{calendarMonth + 1} 月</span></h2><div><button className="secondary-button" onClick={() => { setCalendarDate(new Date()); setSelectedDay(today); }}>今天</button><button className="icon-button" aria-label="上个月" onClick={() => setCalendarDate(new Date(calendarYear, calendarMonth - 1, 1))}><ChevronLeft size={18} /></button><button className="icon-button" aria-label="下个月" onClick={() => setCalendarDate(new Date(calendarYear, calendarMonth + 1, 1))}><ChevronRight size={18} /></button></div></div><div className="calendar-weekdays">{['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map(d => <span key={d}>{d}</span>)}</div><div className="calendar-grid">{Array.from({ length: Math.ceil((firstWeekDay + daysInMonth) / 7) * 7 }, (_, index) => { const day = index - firstWeekDay + 1; const date = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`; const dayItems = calendarItems.filter(i => localDay(i.scheduledAt || i.publishedAt || i.updatedAt) === date); return day < 1 || day > daysInMonth ? <div className="calendar-cell outside" key={index} /> : <button className={`calendar-cell ${date === today ? 'today' : ''} ${date === selectedDay ? 'day-selected' : ''}`} key={index} onClick={() => setSelectedDay(date)}><span className="day-number">{day}</span>{dayItems.slice(0, 2).map(i => <span key={i.id} className={`calendar-event event-${i.status}`}><span />{i.title}</span>)}{dayItems.length > 2 && <small>还有 {dayItems.length - 2} 篇</small>}</button>; })}</div><div className="calendar-legend"><span><i className="green" />已发布</span><span><i className="orange" />待发布</span><p>定时计划仅保存在本地，不会自动发送到平台</p></div><div className="schedule-list"><h3>{selectedDay ? `${selectedDay} 的内容` : '接下来的发布计划'}<span>{selectedDay ? '' : `${scheduled.length} 篇`}</span></h3>{(selectedDay ? calendarItems.filter(i => localDay(i.scheduledAt || i.publishedAt || i.updatedAt) === selectedDay) : scheduled).map(i => <button className="schedule-row" key={i.id} onClick={() => setComposer({ item: i })}><img src={i.image} alt="" /><div><strong>{i.title}</strong><span>{formatDate(i.scheduledAt || i.publishedAt || i.updatedAt, true)}</span></div><div className="platform-stack">{i.platforms.map(id => <PlatformIcon id={id} small key={id} />)}</div><Status status={i.status} /><ChevronRight size={17} /></button>)}{selectedDay && !calendarItems.some(i => localDay(i.scheduledAt || i.publishedAt || i.updatedAt) === selectedDay) && <p className="schedule-empty">这一天还没有发布安排，留一点空白给灵感。</p>}</div></section>}

        {page === 'assets' && <section className="assets-section"><input type="file" hidden multiple accept="image/jpeg,image/png,image/webp,image/gif" aria-label="上传素材文件" disabled={!watermarkPreferences.ready || uploadingAssets || Boolean(pendingAssetImages)} ref={uploadRef} onChange={uploadAssets} /><div className="assets-banner"><div className="assets-banner-icon"><FolderOpen size={25} /></div><div><strong>你的灵感素材夹</strong><p>共 {assets.length} 张图片 · JPG / PNG / WebP 原图 ≤ 12 MB<br />优先无损 PNG，超过 3 MB 才缩小 · 普通 GIF 原样保存，≤ 3 MB</p></div><span>点击图片，开始创作 <ArrowUpRight size={15} /></span></div><div className="asset-watermark-option">
          <label><input type="checkbox" checked={watermarkAssetUploads} disabled={!watermarkPreferences.ready || uploadingAssets || Boolean(pendingAssetImages)} onChange={event => { setWatermarkAssetUploads(event.target.checked); setShowAssetWatermarkSettings(event.target.checked); }} /><Sparkles size={16} />上传时添加水印</label>
          <span>{pendingAssetImages && !assetWatermarkEditorExpanded ? `已选择 ${pendingAssetImages.length} 张图片，展开水印设置后确认入库` : watermarkPreferences.ready ? '图标与设置自动记忆，可先设置再上传' : '正在读取本机水印设置…'}</span>
          <button type="button" className="asset-watermark-settings" aria-expanded={assetWatermarkEditorExpanded} aria-controls="asset-watermark-editor" disabled={!watermarkPreferences.ready || uploadingAssets} onClick={() => { if (!assetWatermarkEditorExpanded) setWatermarkAssetUploads(true); setShowAssetWatermarkSettings(!assetWatermarkEditorExpanded); }}><Settings2 size={14} aria-hidden="true" />{assetWatermarkEditorExpanded ? '收起水印设置' : '水印设置'}<ChevronDown className="asset-watermark-chevron" size={14} aria-hidden="true" /></button>
        </div>
        {watermarkPreferences.error && !assetWatermarkEditorExpanded && <div className="wm-preferences-status is-error" role="alert"><span>{watermarkPreferences.error}</span><button type="button" className="wm-preferences-retry" disabled={watermarkPreferences.saving} onClick={watermarkPreferences.retrySave}>重新保存</button></div>}
        {watermarkPreferences.ready && (pendingAssetImages || watermarkAssetUploads) && <div className="asset-watermark-editor" id="asset-watermark-editor" hidden={!assetWatermarkEditorExpanded}>
          <WatermarkEditor key={assetWatermarkEditorVersion} images={pendingAssetImages ?? []} settings={watermarkPreferences.settings} onSettingsChange={watermarkPreferences.updateSettings} preferencesSaving={watermarkPreferences.saving} preferencesError={watermarkPreferences.error} onRetryPreferences={watermarkPreferences.retrySave} disabled={uploadingAssets} onSelectImages={() => uploadRef.current?.click()} onApply={saveAssets} onCancel={finishAssetWatermarkEditing} applyLabel="添加到素材库" />
        </div>}<div className="assets-grid"><button className="asset-upload" disabled={!watermarkPreferences.ready || uploadingAssets || Boolean(pendingAssetImages)} onClick={() => uploadRef.current?.click()}><Plus size={28} /><strong>添加新素材</strong><span>把值得分享的画面留在这里</span></button>{assets.map((image, index) => <button className="asset-card" key={image} onClick={() => startFromImage(image)}><img src={image} alt={`素材 ${index + 1}`} /><span>用这张图创作 <ArrowUpRight size={16} /></span></button>)}</div></section>}

        {page === 'accounts' && <section className="accounts-section">
          {currentChromeMode ? <section className="chrome-connection-guide" aria-labelledby="chrome-connection-heading">
            <div className="chrome-connection-heading"><span><Link2 size={20} /></span><div><h2 id="chrome-connection-heading">连接当前 Chrome</h2><p>使用 Chrome 中已登录的平台账号。每个平台使用一个标签页，再次打开会复用。</p></div><button type="button" className="chrome-connection-toggle" aria-label={showChromeConnectionGuide ? '收起 Chrome 连接说明' : '展开 Chrome 连接说明'} aria-expanded={showChromeConnectionGuide} aria-controls="chrome-connection-details" onClick={() => setShowChromeConnectionGuide(expanded => !expanded)}>{showChromeConnectionGuide ? '收起' : '展开'}<ChevronDown size={15} aria-hidden="true" /></button></div>
            <div id="chrome-connection-details" hidden={!showChromeConnectionGuide}>
            <ol className="chrome-connection-steps">
              <li><span>01</span><div><strong>打开连接设置</strong><p>使用 Chrome 144 或更新版本，将下方地址粘贴到 Chrome 地址栏并打开。</p></div></li>
              <li><span>02</span><div><strong>开启远程调试</strong><p>开启设置页中的远程调试选项，并保持 Chrome 打开。</p></div></li>
              <li><span>03</span><div><strong>连接平台并允许</strong><p>点击下方平台的连接按钮，在 Chrome 弹窗中允许连接。</p></div></li>
            </ol>
            <div className="chrome-connection-address"><label htmlFor="chrome-connection-address">Chrome 设置地址</label><div><input id="chrome-connection-address" ref={chromeAddressRef} readOnly value={CHROME_CONNECTION_SETTINGS} onFocus={event => event.currentTarget.select()} /><button type="button" className="secondary-button" onClick={() => void copyChromeSettings()}>{chromeCopyStatus === 'copied' ? <Check size={14} /> : <Copy size={14} />}{chromeCopyStatus === 'copied' ? '已复制' : '复制地址'}</button></div></div>
            {chromeCopyStatus !== 'idle' && <p className="chrome-connection-feedback" role="status">{chromeCopyStatus === 'copied' ? '设置地址已复制，请粘贴到 Chrome 地址栏。' : '无法自动复制，地址已选中，请手动复制后粘贴到 Chrome 地址栏。'}</p>}
            </div>
          </section> : <div className="account-notice"><CircleHelp size={20} /><div><strong>四个平台，一个创作空间</strong><p>登录自己的账号，逐个平台核对图文并发布。扫码受阻时可打开官方窗口完成验证。</p></div><span>本机账号直发</span></div>}
          <div className="accounts-grid">{PLATFORMS.map(p => <PlatformAccountCard key={p.id} platform={p} state={accounts[p.id]} error={accountErrors[p.id] || ''} busy={Boolean(accountBusy[p.id]) || publishing === p.id} count={items.filter(i => i.platforms.includes(p.id)).length} published={items.filter(i => getPublications(i)[p.id]?.state === 'published').length} onLogin={() => updateConnection(p.id, () => loginPlatform(p.id, 'qr'))} onOpen={() => updateConnection(p.id, () => openPlatform(p.id))} onRefresh={() => updateConnection(p.id, () => refreshPlatform(p.id))} onClose={() => updateConnection(p.id, () => closePlatform(p.id))} onDisconnect={() => updateConnection(p.id, () => disconnectPlatform(p.id))} onDismissError={() => dismissAccountError(p.id)} onManage={() => { navigate('content'); setPlatform(p.id); }} />)}</div>
          <div className="account-bottom"><Link2 size={17} /><p>{currentChromeMode ? '关闭仅关闭此平台标签页。断开连接会保留 Chrome 登录，不会退出网站；其他标签页可继续使用。' : '每个平台使用独立的本机浏览器配置。关闭会话保留登录；退出账号清除该平台配置。'}</p><button className="text-link" onClick={() => setInfo('help')}>了解工作流程<ArrowUpRight size={14} /></button></div>
        </section>}
        <footer className="main-footer"><span>发条 FĀTIÁO <span>·</span> 为每一个认真创作的你</span><span>灵感在线，热爱不打烊 <span className="footer-flower">✳</span></span></footer>
      </main>
    </div>

    <input type="file" hidden accept="application/json,.json" ref={importRef} aria-label="选择内容备份 JSON 文件" onChange={event => void readContentBackup(event)} />
    {importPreview && <div className="dialog-backdrop" onClick={() => { if (!importingRef.current) setImportPreview(null); }}><section className="small-dialog backup-import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title" onClick={event => event.stopPropagation()}><div className="dialog-icon"><Upload size={24} /></div><h2 id="import-title">确认导入内容备份</h2><p className="backup-import-filename">{importPreview.filename}</p><p>共 {importPreview.items.length} 篇内容{importPreview.assets ? `、${importPreview.assets.length} 张素材` : ''}{importPreview.watermark ? '，并包含水印设置' : ''}。保留原来的内容编号、文案和图片；同编号普通草稿将使用备份内容。已有发布回执或待确认操作的记录会保留，已删除的记录不会恢复。{importPreview.watermark && '导入后会使用备份中的水印默认设置。'}</p><ul className="backup-import-list" aria-label="待导入内容">{importPreview.items.map(item => <li key={item.id}><strong>{item.title || '未命名内容'}</strong><span>{item.images.length} 张图片 · {item.platforms.map(id => PLATFORMS.find(value => value.id === id)!.name).join('、') || '未选择平台'}</span></li>)}</ul>{importError && <p className="backup-import-error" role="alert">{importError}</p>}<div className="dialog-actions"><button type="button" className="secondary-button" autoFocus disabled={Boolean(importBusy)} onClick={() => setImportPreview(null)}>取消</button><button type="button" className="primary-button" disabled={Boolean(importBusy)} onClick={() => void confirmContentImport()}>{importBusy === 'save' ? '正在导入…' : '确认导入'}</button></div></section></div>}
    {composer && <Composer watermarkPreferences={watermarkPreferences} item={composer.item} onClose={() => setComposer(null)} onSave={saveItem} accounts={accounts} onPreparePlatform={preparePlatform} onPublishPlatform={publishToPlatform} onConnectPlatform={connectPlatform} onOperatePublication={operateOnPublication} onCheckPublication={checkPublicationResult} onReadComposerDraft={platform => manageComposerDraft(platform)} onClearComposerDraft={async (platform, snapshot) => { await manageComposerDraft(platform, snapshot); }} />}
    {toast && <div className="toast" role="status"><CircleCheck size={18} /><span>{toast}</span><button onClick={() => setToast('')} aria-label="关闭提示"><X size={15} /></button></div>}
    {deleteItem && <div className="dialog-backdrop" onClick={() => setDeleteItem(null)}><section className="small-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" onClick={e => e.stopPropagation()}><div className="dialog-icon danger-bg"><Trash2 size={24} /></div><h2 id="delete-title">删除这篇本地记录？</h2><p>「{deleteItem.title}」将从本地数据库中移除。删除前会再次核实所有平台原文已删除且没有待确认操作。</p><div className="dialog-actions"><button className="secondary-button" autoFocus onClick={() => setDeleteItem(null)}>再想想</button><button className="danger-button" disabled={deletingContent} onClick={() => void deleteContent(deleteItem.id)}>{deletingContent ? '正在核实平台状态…' : '确认删除本地记录'}</button></div></section></div>}
    {info && <div className="dialog-backdrop" onClick={() => setInfo(null)}><section className="small-dialog info-dialog" role="dialog" aria-modal="true" aria-labelledby="info-title" onClick={e => e.stopPropagation()}><button className="dialog-close icon-button" aria-label="关闭" autoFocus onClick={() => setInfo(null)}><X size={19} /></button><div className="dialog-icon"><Sparkles size={25} /></div><h2 id="info-title">{info === 'help' ? '从创作到发布，三步开始' : info === 'workspace' ? '我的工作空间' : '从一个想法开始'}</h2>{info === 'help' ? <><p>在发条完成图文编辑、平台预览与发布管理。</p><div className="help-steps"><div><span>01</span><p><strong>编辑内容</strong>新建内容，填写标题和正文，按需添加图片。</p></div><div><span>02</span><p><strong>选择发布平台</strong>连接账号，选择小红书、抖音图文、微博或 B站动态，查看对应预览。</p></div><div><span>03</span><p><strong>核对后发布</strong>逐个平台确认账号与内容，发布后查看原文和回执。定时计划仅作本地记录，需手动发布。</p></div></div><button className="primary-button full-width" onClick={() => { setInfo(null); setComposer({}); }}>新建内容<ArrowRight size={16} /></button></> : info === 'workspace' ? <><p>内容、素材与设置，集中保存在本机</p><div className="workspace-summary"><div><strong>{items.length}</strong><span>篇内容</span></div><div><strong>4</strong><span>个平台</span></div><div><strong>{assets.length}</strong><span>张素材</span></div></div><p className="workspace-note">导出备份可保存内容、素材图片和水印设置，方便迁移或恢复。连接平台账号后，可发布内容、修改文案或删除原文，操作结果以平台回执为准。</p><button className="secondary-button full-width" disabled={exporting || !watermarkPreferences.ready} onClick={() => void exportContent()}><Download size={16} />{exporting ? '正在打包…' : '导出工作空间备份'}</button><button className="secondary-button full-width backup-import-workspace" disabled={Boolean(importBusy)} onClick={() => importRef.current?.click()}><Upload size={16} />{importBusy === 'read' ? '正在读取备份…' : '导入内容备份'}</button></> : <><p>选一个模板，补充你的故事，开始新的创作。</p><div className="inspiration-options">{[{ icon: '☕', title: '记录一间喜欢的小店', body: '在城市的某个转角，发现了一间想私藏的小店。\n\n最喜欢这里的…\n\n📍 地址：\n☕ 我的推荐：\n\n#城市漫游 #咖啡日常' }, { icon: '🌿', title: '分享我的日常小确幸', body: '最近让我觉得生活很可爱的三件小事：\n\n01 / \n02 / \n03 / \n\n普通的一天，也有值得被记住的瞬间。\n\n#日常碎片 #认真生活' }, { icon: '📷', title: '整理一次出走的回忆', body: '给自己放了一个小小的假。\n\n📍 目的地：\n🌤 当天的天气：\n💚 最难忘的瞬间：\n\n#旅行日记 #在路上' }].map(t => <button key={t.title} onClick={() => { setInfo(null); setComposer({ item: { id: makeId(), title: t.title, body: t.body, image: '', images: [], platforms: ['xiaohongshu'], status: 'draft', category: '生活方式', updatedAt: new Date().toISOString() } }); }}><span>{t.icon}</span><strong>{t.title}</strong><ArrowUpRight size={16} /></button>)}</div></>}</section></div>}
  </div>;
}
