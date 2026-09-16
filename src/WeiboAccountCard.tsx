import { useState } from 'react';
import { ArrowRight, Check, ExternalLink, LogIn, LogOut, Monitor, RefreshCw, UserRound, X } from 'lucide-react';
import type { WeiboAccountState } from './weibo';
import './weibo.css';

interface Props {
  state: WeiboAccountState | null;
  error: string;
  busy: boolean;
  count: number;
  published: number;
  onLogin: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onClose: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onManage: () => void;
}

export default function WeiboAccountCard({ state, error, busy, count, published, onLogin, onRefresh, onClose, onDisconnect, onManage }: Props) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  return <article className="account-card weibo-account-card">
    <div className="account-card-top"><span className="wb-brand">微</span><span className={`wb-connection ${state?.connected ? 'connected' : ''}`}><span />{state?.connected ? '已登录' : state?.browserOpen ? '等待登录' : '未登录'}</span></div>
    <h2>微博<span className="wb-real-badge">账号直发</span></h2><p>用自己的账号，分享每一个新鲜瞬间。</p>
    <div className="account-identity"><span className="wb-avatar">{state?.account?.avatarUrl ? <img src={state.account.avatarUrl} alt="微博头像" /> : <UserRound size={20} />}</span><div><strong>{state?.account?.name || '连接你的微博账号'}</strong><span>{state?.account ? `UID ${state.account.uid}` : '扫码、验证码或账号密码登录'}</span></div>{state?.account && <a href={state.account.profileUrl} target="_blank" rel="noreferrer" className="icon-button" aria-label="查看微博主页"><ExternalLink size={15} /></a>}</div>
    <div className="account-numbers"><div><strong>{count}</strong><span>关联内容</span></div><div><strong>{published}</strong><span>真实发布</span></div></div>
    <div className="wb-account-actions"><button className="primary-button" disabled={busy} onClick={() => void onLogin()}><LogIn size={15} />{busy ? '正在处理…' : state?.connected ? '打开微博窗口' : state?.browserOpen ? '继续登录微博' : '登录微博账号'}</button><button className="secondary-button" disabled={busy || !state?.browserOpen} onClick={() => void onRefresh()} title="登录后刷新状态" aria-label="刷新微博登录状态"><RefreshCw size={15} /></button></div>
    {state?.browserOpen && !state.connected && <div className="wb-login-note"><Monitor size={16} /><p>已打开微博官方登录窗口。完成登录后，这里会自动显示你的账号。<button disabled={busy} onClick={() => void onRefresh()}>我已登录，刷新状态 <ArrowRight size={12} /></button></p></div>}
    {error && <p className="wb-error" role="alert">{error}</p>}
    <div className="wb-account-links"><button onClick={onManage}>管理微博内容<ArrowRight size={12} /></button>{state?.browserOpen && <button disabled={busy} onClick={() => void onClose()}><X size={12} />关闭专用窗口</button>}</div>
    <p className="wb-privacy-note"><Check size={12} />登录在微博官网完成，发条不收集你的密码。</p>
    {state?.connected && !confirmDisconnect && <button className="wb-disconnect" disabled={busy} onClick={() => setConfirmDisconnect(true)}><LogOut size={12} />退出此账号</button>}
    {confirmDisconnect && <div className="wb-disconnect-confirm"><p>将清除发条专用浏览器的登录状态，下次使用需要重新登录。</p><div><button className="secondary-button" disabled={busy} onClick={() => setConfirmDisconnect(false)}>取消</button><button className="danger-button" disabled={busy} onClick={async () => { await onDisconnect(); setConfirmDisconnect(false); }}>确认退出</button></div></div>}
  </article>;
}
