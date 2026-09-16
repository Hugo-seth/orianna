import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initializeLocalStorage } from './local-storage';
import './styles.css';

function LocalStorageGate() {
  const [ready, setReady] = React.useState(false);
  const [error, setError] = React.useState('');
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    setError('');
    void initializeLocalStorage().then(() => { if (active) setReady(true); }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : '无法读取本地数据，请检查本地服务后重试。');
    });
    return () => { active = false; };
  }, [attempt]);
  if (ready) return <App />;
  return <main className="storage-startup"><section role={error ? 'alert' : 'status'} aria-live="polite">
    <h1>{error ? '本地数据暂时无法打开' : '正在读取本地工作空间'}</h1>
    <p>{error || '首次使用新版时，会将当前浏览器的素材和草稿迁移到本机。'}</p>
    {error && <><p>旧数据会保留。若刚更新版本，请重启本项目的本地服务后重试。</p><button className="primary-button" onClick={() => setAttempt(value => value + 1)}>重新读取</button></>}
  </section></main>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><LocalStorageGate /></React.StrictMode>);
