import { useEffect, useState } from 'react';
import { ArrowRight, Check, ExternalLink, LogIn, LogOut, Monitor, RefreshCw, X } from 'lucide-react';
import type { Platform } from './model';
import { hasBoundPlatformAccount, isPlatformAccountVerified, type PlatformAccountState } from './platforms';
import AccountAvatar from './AccountAvatar';
import './weibo.css';

interface Props {
  platform: Platform;
  state?: PlatformAccountState | null;
  error: string;
  busy: boolean;
  count: number;
  published: number;
  onLogin: () => Promise<void>;
  onOpen: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onClose: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onDismissError: () => void;
  onManage: () => void;
}

export default function PlatformAccountCard({ platform, state, error, busy, count, published, onLogin, onOpen, onRefresh, onClose, onDisconnect, onDismissError, onManage }: Props) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!state?.login?.expiresAt) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [state?.login?.expiresAt]);
  const currentChrome = !state || state.browserMode === 'current-chrome';
  const verified = isPlatformAccountVerified(state);
  const bound = hasBoundPlatformAccount(state);
  const boundAndClosed = currentChrome && bound && !state?.browserOpen;
  const expired = state?.login?.kind === 'qr' && Boolean(state.login.expiresAt && Date.parse(state.login.expiresAt) <= now);
  const status = verified ? currentChrome ? '已连接' : '已登录' : state?.login ? '等待登录' : currentChrome ? bound ? '已绑定' : '未连接' : state?.sessionSaved ? '登录信息已保存' : '未登录';
  const name = platform.name;
  const renewLogin = () => state?.login?.kind === 'qr' && state.browserOpen ? onRefresh() : onLogin();
  const canOpenSavedSession = verified || state?.sessionSaved && !state.login;
  return <article className="account-card weibo-account-card" aria-label={`${name}账号`}>
    <div className="account-card-top"><span className="wb-brand" style={{ color: platform.color, background: `${platform.color}15` }}>{platform.id === 'douyin' ? '♪' : platform.id === 'bilibili' ? '哔' : platform.id === 'xiaohongshu' ? '红' : '微'}</span><span className={`wb-connection ${verified || bound ? 'connected' : ''}`}><span />{status}</span></div>
    <h2>{name}<span className="wb-real-badge">账号直发</span></h2><p>{platform.id === 'xiaohongshu' ? '发布图文笔记，记录你的发现。' : platform.id === 'douyin' ? '发布抖音图文，让照片讲述故事。' : platform.id === 'bilibili' ? '发布文字和图片动态，与同好交流。' : '用自己的账号，记录每个新鲜瞬间。'}</p>
    <div className="account-identity"><span className="wb-avatar"><AccountAvatar platform={platform.id} src={state?.account?.avatarUrl} alt={`${name}头像`} /></span><div><strong>{state?.account?.name || (!currentChrome && state?.sessionSaved ? `${name}登录信息已保存` : `连接你的${name}账号`)}</strong><span>{state?.account ? `UID ${state.account.uid}` : currentChrome ? '使用当前 Chrome 中的账号' : state?.sessionSaved ? '发布前自动核对账号' : '在平台官网完成登录'}</span></div>{state?.account && <a href={state.account.profileUrl} target="_blank" rel="noreferrer" className="icon-button" aria-label={`查看${name}主页`}><ExternalLink size={15} /></a>}</div>
    <div className="account-numbers"><div><strong>{count}</strong><span>关联内容</span></div><div><strong>{published}</strong><span>真实发布</span></div></div>
    <div className="wb-account-actions"><button className="primary-button" disabled={busy} onClick={() => void (currentChrome || canOpenSavedSession ? onOpen() : renewLogin())}><LogIn size={15} />{busy ? '正在处理…' : currentChrome ? state?.browserOpen || bound ? `打开${name}标签页` : `连接 Chrome 中的${name}` : canOpenSavedSession ? `打开${name}窗口` : state?.login?.kind === 'qr' ? '刷新登录二维码' : `登录${name}`}</button><button className="secondary-button" disabled={busy} onClick={() => void onRefresh()} aria-label={`刷新${name}登录状态`}><RefreshCw size={15} /></button></div>
    {currentChrome && state?.browserOpen && <p className="platform-session-message">再次打开会复用此平台标签页，发布前会核对当前账号。</p>}
    {boundAndClosed && <p className="platform-session-message">标签页已关闭，账号绑定保留；操作时自动打开并核验登录。</p>}
    {!currentChrome && state?.sessionSaved && !state.login && <p className="platform-session-message">发布时会自动检查并恢复登录，过期时再登录。</p>}
    {!verified && state?.login?.kind === 'qr' && <div className="platform-qr" aria-live="polite">{!expired && state.login.image ? <><img src={state.login.image} alt={`${name}登录二维码`} /><strong>用{name} App 扫码登录</strong><p>请在手机上确认，账号状态会自动更新。</p></> : <><RefreshCw size={24} /><strong>{expired ? '二维码已失效，请刷新' : state.message || '二维码暂不可用，请刷新'}</strong><button className="secondary-button" disabled={busy} onClick={() => void renewLogin()}>获取新二维码</button></>}</div>}
    {!verified && state?.login?.kind === 'window' && <div className="wb-login-note"><Monitor size={16} /><p>{currentChrome ? `请在 Chrome 的${name}标签页中完成登录或验证，完成后这里会自动显示账号。` : state.headless ? '此步骤需要在官网完成，请打开官方登录窗口继续。' : '请在已打开的官方窗口完成登录。完成后，这里会自动显示你的账号。'}</p></div>}
    {state?.message && !boundAndClosed && !(state.login?.kind === 'qr' && !state.login.image && !expired) && <p className="platform-session-message" role="status">{state.message}</p>}
    {error && <div className="wb-error wb-dismissible-error" role="alert"><span>{error}</span><button type="button" className="wb-error-close" onClick={onDismissError} aria-label={`关闭${name}错误提示`} title="关闭提示"><X size={16} aria-hidden="true" /></button></div>}
    <div className="wb-account-links"><button onClick={onManage}>管理{name}内容<ArrowRight size={12} /></button>{state?.browserOpen && <button disabled={busy} onClick={() => void onClose()}><X size={12} />{currentChrome ? '关闭此平台标签页' : '关闭会话，保留登录'}</button>}</div>
    {!currentChrome && !verified && <button className="platform-window-fallback" disabled={busy} onClick={() => void onOpen()}><Monitor size={13} />{state?.login?.kind === 'qr' ? '扫码受阻？打开官方窗口' : '打开官方登录窗口'}</button>}
    <p className="wb-privacy-note"><Check size={12} />{currentChrome ? '登录由当前 Chrome 保留，连接时会核对账号。' : '登录状态仅保存在本机专用浏览器配置中。'}</p>
    {(state?.connected || state?.sessionSaved || state?.browserOpen) && !confirmDisconnect && <button className="wb-disconnect" disabled={busy} onClick={() => setConfirmDisconnect(true)}><LogOut size={12} />{currentChrome ? '解除绑定' : '退出并清除本机登录'}</button>}
    {confirmDisconnect && <div className="wb-disconnect-confirm"><p>{currentChrome ? `将解除发条与${name}的账号绑定。Chrome 中的登录会保留，不会退出网站。` : `将清除${name}专用浏览器的登录状态，下次需要重新登录。`}</p><div><button className="secondary-button" disabled={busy} onClick={() => setConfirmDisconnect(false)}>取消</button><button className="danger-button" disabled={busy} onClick={async () => { await onDisconnect(); setConfirmDisconnect(false); }}>{currentChrome ? '确认解除' : '确认退出'}</button></div></div>}
  </article>;
}
