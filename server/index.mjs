import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, sep } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { createPlatformsHandler } from './platforms.mjs';
import { createWeiboBrowser } from './weibo-browser.mjs';
import { createPlatformBrowser } from './platform-browser.mjs';
import { createLocalStorageHandler } from './local-storage.mjs';
import { createCurrentChrome } from './current-chrome.mjs';
import { createAvatarHandler } from './avatar.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:5173');
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.protocol !== 'http:' || origin.username || origin.password) {
  throw new Error('APP_ORIGIN 必须为本机 http://localhost:端口 或 http://127.0.0.1:端口。');
}
const port = Number(origin.port || 80);
const dev = process.argv.includes('--dev');
const dataDir = resolve(root, process.env.APP_DATA_DIR || '.data');
const currentChrome = createCurrentChrome();
const browsers = {
  weibo: createWeiboBrowser({ dataDir, currentChrome }),
  ...Object.fromEntries(['xiaohongshu', 'douyin', 'bilibili'].map(platform => [platform, createPlatformBrowser({ platform, dataDir, currentChrome })])),
};
const handlePlatforms = createPlatformsHandler({ env: { ...process.env, APP_ORIGIN: origin.origin }, dataDir, browsers });
const handleLocalStorage = createLocalStorageHandler({ env: { ...process.env, APP_ORIGIN: origin.origin }, dataDir });
const handleAvatar = createAvatarHandler({ env: { ...process.env, APP_ORIGIN: origin.origin } });
let vite;
let stopping = false;
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.headers.host !== origin.host) { res.writeHead(403); res.end('Host not allowed'); return; }
  if (stopping) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'SERVER_STOPPING', message: '本地服务正在重启，请稍后重试。' } })); return; }
  try {
    const requestedPath = decodeURIComponent(new URL(req.url, origin).pathname);
    if (/(?:^|\/)(?:\.data|\.git|\.env(?:\.[^/]*)?)(?:\/|$)/.test(requestedPath)) { res.writeHead(403); res.end('Private local data'); return; }
    const filesystemPath = requestedPath.startsWith('/@fs/') ? resolve('/', requestedPath.slice('/@fs/'.length)) : resolve(root, `.${requestedPath}`);
    if (filesystemPath === dataDir || filesystemPath.startsWith(dataDir + sep)) { res.writeHead(403); res.end('Private local data'); return; }
    if (await handleLocalStorage(req, res)) return;
    if (await handleAvatar(req, res)) return;
    if (await handlePlatforms(req, res)) return;
    if (req.url?.startsWith('/api/')) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: '接口不存在。' } })); return; }
    if (dev) { vite.middlewares(req, res); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const pathname = decodeURIComponent(new URL(req.url, origin).pathname);
    const dist = resolve(root, 'dist');
    let path = resolve(dist, `.${pathname}`);
    if (path !== dist && !path.startsWith(dist + sep)) { res.writeHead(403); res.end(); return; }
    try { if (!(await stat(path)).isFile()) path = resolve(dist, 'index.html'); } catch { path = resolve(dist, 'index.html'); }
    const file = await readFile(path);
    res.writeHead(200, { 'Content-Type': mimeTypes[extname(path)] || 'application/octet-stream', 'Cache-Control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(req.method === 'HEAD' ? undefined : file);
  } catch {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'SERVER_ERROR', message: '本地服务出现异常，请检查启动状态。' } }));
  }
});

if (dev) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
}

server.listen(port, origin.hostname === '[::1]' ? '::1' : '127.0.0.1', () => {
  console.log(`\n  发条 · ${dev ? '开发模式' : '本地服务'}\n  ${origin.origin}\n  小红书 · 抖音图文 · 微博 · B站动态：在平台账号页连接\n`);
});
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请关闭本项目旧服务后重试。` : '本地服务启动失败。'); void shutdown(1); });
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => process.exit(code), 10000); timer.unref();
  await handlePlatforms.close?.();
  await handleLocalStorage.close();
  await Promise.allSettled(Object.values(browsers).map(browser => browser.close()));
  await currentChrome.close().catch(() => {});
  await vite?.close();
  server.closeAllConnections();
  server.close(() => process.exit(code));
  if (!server.listening) process.exit(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
