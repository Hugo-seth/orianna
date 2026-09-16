import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, Pencil, RefreshCw, Trash2, X } from 'lucide-react';
import { getPublications, makeId, PLATFORMS, type ContentItem, type PlatformId, type PlatformPublication } from './model';
import { PlatformRequestError, requireReadyPlatformAccount, validatePlatformUpdate, type PlatformAccountState } from './platforms';

interface Props {
  platform: PlatformId;
  item: ContentItem;
  publication: PlatformPublication;
  accountState?: PlatformAccountState | null;
  busy: boolean;
  acquire: () => boolean;
  release: () => void;
  onPrepare: (platform: PlatformId) => Promise<PlatformAccountState>;
  onConnect: (platform: PlatformId, mode?: 'qr' | 'window') => Promise<void>;
  onOperate: (platform: PlatformId, operation: 'update' | 'delete', item: ContentItem, requestId: string, title?: string, body?: string) => Promise<ContentItem>;
  onCheck: (platform: PlatformId, contentId: string, retryUpdate?: boolean) => Promise<ContentItem>;
}

export default function PublishedPostActions({ platform, item, publication, accountState, busy, acquire, release, onPrepare, onConnect, onOperate, onCheck }: Props) {
  const [review, setReview] = useState<{ type: 'update' | 'delete'; item: ContentItem } | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [phase, setPhase] = useState<'idle' | 'resume' | 'submit' | 'check' | 'login'>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsLogin, setNeedsLogin] = useState(false);
  const [retryReview, setRetryReview] = useState(false);
  const workingRef = useRef(false);
  const receipt = publication.receipt!;
  const operation = publication.lifecycle;
  const name = PLATFORMS.find(value => value.id === platform)!.name;
  const latestText = receipt.lastOperation?.type === 'update' ? receipt.lastOperation : undefined;
  const qrLogin = needsLogin && !accountState?.connected && accountState?.login?.kind === 'qr' ? accountState.login : undefined;

  useEffect(() => {
    if (receipt.deletedAt || receipt.lastOperation) setReview(null);
  }, [receipt.lastOperation?.requestId, receipt.deletedAt]);

  const lock = (nextPhase: typeof phase) => {
    if (workingRef.current || !acquire()) return false;
    workingRef.current = true; setPhase(nextPhase); setError(''); setNotice('');
    return true;
  };
  const unlock = () => { workingRef.current = false; setPhase('idle'); release(); };
  const showError = (failure: unknown) => {
    setError(failure instanceof Error ? failure.message : '操作未完成，请稍后核对。');
    if (failure instanceof PlatformRequestError && ['LOGIN_REQUIRED', 'CAPTCHA_REQUIRED', 'ACCOUNT_CHANGED'].includes(failure.code)) setNeedsLogin(true);
  };
  const begin = async (type: 'update' | 'delete') => {
    if (operation || receipt.deletedAt || !lock('resume')) return;
    try {
      const fresh = await onPrepare(platform);
      requireReadyPlatformAccount(platform, fresh, receipt.account.uid);
      setNeedsLogin(false);
      setTitle(latestText?.title ?? item.title);
      setBody(latestText?.body ?? item.body);
      setReview({ type, item: structuredClone(item) });
    } catch (failure) { showError(failure); }
    finally { unlock(); }
  };
  const confirm = async () => {
    if (!review || operation || receipt.deletedAt) return;
    if (review.type === 'update') {
      const errors = validatePlatformUpdate(platform, title, body);
      if (errors.length) { setError(errors.join(' ')); return; }
    }
    if (!lock('submit')) return;
    try {
      await onOperate(platform, review.type, review.item, makeId(), review.type === 'update' ? title.trim() : undefined, review.type === 'update' ? body.trim() : undefined);
      setNeedsLogin(false); setReview(null);
      setNotice(review.type === 'update' ? '平台原文文字已更新，原图片已保留。' : '平台原文已确认删除。');
    } catch (failure) { showError(failure); }
    finally { unlock(); }
  };
  const checkResult = async (retryUpdate = false) => {
    if (!lock('check')) return;
    try {
      const updated = await onCheck(platform, item.id, retryUpdate);
      setRetryReview(false);
      setNotice(getPublications(updated)[platform]?.lifecycle ? '尚未取得确认回执，请到平台核对原文。控制台不会重复提交这次操作。' : '已同步平台操作回执。');
    } catch (failure) { showError(failure); }
    finally { unlock(); }
  };
  const connect = async (mode: 'qr' | 'window') => {
    if (!lock('login')) return;
    try { await onConnect(platform, mode); setNotice(mode === 'qr' ? '请使用手机 App 扫码确认，完成后重新核对原文操作。内容已保留。' : '完成官网登录后，再次选择原文操作。'); }
    catch (failure) { showError(failure); }
    finally { unlock(); }
  };

  return <div className="cmp-published-actions" aria-label={`${name}原文管理`}>
    {receipt.deletedAt ? <p className="cmp-platform-deleted" role="status"><Check size={14} />{name}原文已删除 · {new Date(receipt.deletedAt).toLocaleString('zh-CN')}</p> : <>
      {receipt.updatedAt && <p className="cmp-session-note">最近修改：{new Date(receipt.updatedAt).toLocaleString('zh-CN')}</p>}
      {operation ? <div className="cmp-lifecycle-pending" role="status"><strong>{operation.operation === 'update' ? '修改' : '删除'}结果待核对</strong><p>这次操作已保留，核对只会读取原文和回执，不会重复修改或删除。</p>{operation.operation === 'update' && <blockquote>{[operation.title, operation.body].filter(Boolean).join('\n\n')}</blockquote>}<button type="button" className="cmp-draft-button" disabled={busy} onClick={() => void checkResult()}><RefreshCw size={14} />{phase === 'check' ? '正在核对…' : '核对操作结果'}</button></div> : review ? <section className="cmp-lifecycle-review" aria-label={`${review.type === 'update' ? '修改' : '删除'}${name}原文确认`}>
        <div className="cmp-lifecycle-heading"><h4>{review.type === 'update' ? `修改${name}已发文字` : `删除${name}平台原文`}</h4><button type="button" className="cmp-icon-button" aria-label="取消原文操作" disabled={busy} onClick={() => { setReview(null); setError(''); }}><X size={16} /></button></div>
        <p>账号：<strong>{receipt.account.name}</strong> · UID {receipt.account.uid}</p><a href={receipt.url} target="_blank" rel="noreferrer">核对这篇平台原文 <ExternalLink size={12} /></a>
        {review.type === 'update' ? <><label htmlFor={`lifecycle-title-${platform}`}>修改后的标题</label><input id={`lifecycle-title-${platform}`} className="cmp-input" value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /><label htmlFor={`lifecycle-body-${platform}`}>修改后的正文</label><textarea id={`lifecycle-body-${platform}`} className="cmp-input" value={body} disabled={busy} onChange={event => setBody(event.target.value)} /><p>仅修改这篇原文的文字，保留原来的 {item.images.length} 张图片。其他平台的原文不受影响。</p></> : <><blockquote>{[latestText?.title ?? item.title, latestText?.body ?? item.body].filter(Boolean).join('\n\n')}</blockquote><p>确认后将删除以上账号的这篇平台原文，删除后无法从控制台恢复。只有全部平台原文都已删除，才能移除本地记录。</p></>}
        <div className="cmp-platform-publish-actions"><button type="button" className="cmp-draft-button" disabled={busy} onClick={() => { setReview(null); setError(''); }}>取消</button><button type="button" className={review.type === 'delete' ? 'danger-button' : 'cmp-publish-button'} disabled={busy} onClick={() => void confirm()}>{review.type === 'delete' ? <Trash2 size={14} /> : <Pencil size={14} />}{phase === 'submit' ? '正在执行，请勿关闭…' : `确认${review.type === 'update' ? '修改' : '删除'}${name}原文`}</button></div>
      </section> : <div className="cmp-platform-publish-actions"><button type="button" className="cmp-draft-button" disabled={busy} onClick={() => void begin('update')}><Pencil size={14} />{phase === 'resume' ? '正在核对账号…' : '编辑已发文字'}</button><button type="button" className="cmp-delete-post-button" disabled={busy} onClick={() => void begin('delete')}><Trash2 size={14} />删除平台原文</button></div>}
    </>}
    {qrLogin && <div className="cmp-login-qr" aria-label={`${name}登录二维码`}>{qrLogin.image ? <><img src={qrLogin.image} alt={`${name}登录二维码`} /><p>请使用{name}手机 App 扫码登录，并确认登录账号为 UID {receipt.account.uid}。</p></> : <p>{accountState?.message || '暂未获取到可用二维码，请再次扫码或打开登录窗口。'}</p>}</div>}
    {needsLogin && <div className="cmp-platform-publish-actions"><button type="button" className="cmp-weibo-login cmp-qr-login-button" disabled={busy} onClick={() => void connect('qr')}>{phase === 'login' ? '正在准备登录…' : qrLogin ? '再次扫码' : '扫码登录'}</button><button type="button" className="cmp-weibo-login" disabled={busy} onClick={() => void connect('window')}>打开登录窗口 <ExternalLink size={12} /></button></div>}
    {platform === 'xiaohongshu' && operation?.operation === 'update' && !receipt.deletedAt && <div className="cmp-lifecycle-review">
      {retryReview ? <><p>将把账号 {receipt.account.name} 的这篇原文设为上方保存的文字，保留当前原图。确认后会重新提交修改。</p><button className="cmp-draft-button" disabled={busy} onClick={() => setRetryReview(false)}>取消</button><button className="cmp-publish-button" disabled={busy} onClick={() => void checkResult(true)}>确认重新提交小红书修改</button></> : <button className="cmp-draft-button" disabled={busy} onClick={() => setRetryReview(true)}>重新提交这次修改</button>}
    </div>}
    {error && <p className="cmp-error-inline" role="alert">{error}</p>}{notice && <p className="cmp-session-note" role="status">{notice}</p>}
  </div>;
}
