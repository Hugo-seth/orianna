import { useRef, useState } from 'react';
import { Check, RefreshCw, Trash2, X } from 'lucide-react';
import type { PlatformId } from './model';
import type { PlatformComposerDraft } from './platforms';

interface Props {
  platform: PlatformId;
  busy: boolean;
  acquire: () => boolean;
  release: () => void;
  onRead: (platform: PlatformId) => Promise<PlatformComposerDraft>;
  onClear: (platform: PlatformId, snapshot: PlatformComposerDraft) => Promise<void>;
}

export default function ComposerDraftActions({ platform, busy, acquire, release, onRead, onClear }: Props) {
  const [snapshot, setSnapshot] = useState<PlatformComposerDraft | null>(null);
  const [phase, setPhase] = useState<'read' | 'clear' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const working = useRef(false);
  const lock = (next: 'read' | 'clear') => {
    if (working.current || !acquire()) return false;
    working.current = true; setPhase(next); setError(''); setNotice('');
    return true;
  };
  const unlock = () => { working.current = false; setPhase(null); release(); };
  const inspect = async () => {
    if (!lock('read')) return;
    setSnapshot(null);
    try { setSnapshot(await onRead(platform)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '无法读取官网未发草稿。'); }
    finally { unlock(); }
  };
  const confirm = async () => {
    if (!snapshot || !lock('clear')) return;
    try {
      await onClear(platform, snapshot);
      setNotice('官网未发草稿已清空。本地内容和发布记录已保留，可重新核对需要发布的内容。');
    } catch (failure) {
      setError(`${failure instanceof Error ? failure.message : '未能确认清理结果。'} 请重新读取官网草稿后再操作。`);
    } finally { setSnapshot(null); unlock(); }
  };
  const empty = snapshot && !snapshot.draft.title.trim() && !snapshot.draft.body.trim() && snapshot.draft.imageCount === 0;

  return <section className="cmp-published-actions cmp-composer-draft-actions" aria-label="官网未发草稿管理">
    <button type="button" className="cmp-draft-button" disabled={busy} onClick={() => void inspect()}><Trash2 size={14} />{phase === 'read' ? '正在读取官网草稿…' : '清理官网未发草稿'}</button>
    {snapshot && <section className="cmp-lifecycle-review" aria-label="清理官网未发草稿确认">
      <div className="cmp-lifecycle-heading"><h4>核对官网编辑器中的实际草稿</h4><button type="button" className="cmp-icon-button" aria-label="取消清理官网草稿" disabled={busy} onClick={() => setSnapshot(null)}><X size={16} /></button></div>
      <p>账号：<strong>{snapshot.account.name}</strong> · UID {snapshot.account.uid}</p>
      <p>实际标题：{snapshot.draft.title || '（无标题）'}</p>
      <blockquote>{snapshot.draft.body || '（正文为空）'}</blockquote>
      <p>实际图片：<strong>{snapshot.draft.imageCount} 张</strong></p>
      <p>仅清空专用官网编辑器中以上未发布的文字和图片，本地草稿、已发布原文及待核对记录都会保留。清理后不会自动发布。</p>
      {empty ? <p className="cmp-session-note"><Check size={14} />官网编辑器已经为空，无需清理。</p> : <div className="cmp-platform-publish-actions"><button type="button" className="cmp-draft-button" disabled={busy} onClick={() => void inspect()}><RefreshCw size={14} />重新读取</button><button type="button" className="cmp-delete-post-button" disabled={busy} onClick={() => void confirm()}><Trash2 size={14} />{phase === 'clear' ? '正在清理…' : '确认清理官网未发草稿'}</button></div>}
    </section>}
    {error && <p className="cmp-error-inline" role="alert">{error}</p>}{notice && <p className="cmp-session-note" role="status">{notice}</p>}
  </section>;
}
