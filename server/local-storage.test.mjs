import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, stat, readdir, rename, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalStorageHandler } from './local-storage.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3uoAAAAASUVORK5CYII=', 'base64');
const item = (image = '', overrides = {}) => ({ id: 'draft-1', title: '草稿', body: '正文', category: '生活', image, images: image ? [image] : [], platforms: ['weibo'], status: 'draft', updatedAt: '2026-09-16T00:00:00Z', ...overrides });
const content = (...items) => ({ version: 2, items, deletedContentIds: [] });
const watermark = icon => ({ version: 1, settings: { mode: 'icon', text: '', icon, position: 'random', opacity: 0.5, scale: 0.2, seed: 2 }, assetUploadsEnabled: true });

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'fatiao-local-storage-test-'));
  let handler;
  const server = createServer(async (req, res) => {
    if (!await handler(req, res)) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const restart = async () => {
    await handler?.close();
    handler = createLocalStorageHandler({ env: { APP_ORIGIN: origin }, dataDir });
  };
  await restart();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await handler.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const request = (route, { method = 'GET', value, raw, headers = {} } = {}) => new Promise((resolve, reject) => {
    const allHeaders = { Origin: origin, 'Content-Type': 'application/json', 'X-Fatiao-Request': '1', ...headers };
    for (const key of Object.keys(allHeaders)) if (allHeaders[key] === undefined) delete allHeaders[key];
    const req = httpRequest(`${origin}${route}`, { method, headers: allHeaders }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes, body: bytes.length && res.headers['content-type']?.startsWith('application/json') ? JSON.parse(bytes.toString()) : undefined });
      });
    });
    req.on('error', reject);
    req.end(raw ?? (value === undefined ? undefined : JSON.stringify(value)));
  });
  return {
    dataDir, request, restart, close: () => handler.close(),
    upload: (bytes = PNG, mime = 'image/png') => request('/api/media', { method: 'POST', raw: bytes, headers: { 'Content-Type': mime } }),
    put: (kind, value, expectedRevision = 0) => request(`/api/local-data/${kind}`, { method: 'PUT', value: { expectedRevision, value } }),
    get: kind => request(`/api/local-data/${kind}`),
  };
}

test('media is immutable, deduplicated, private and survives restart with exact bytes', async t => {
  const app = await fixture(t);
  const first = await app.upload();
  assert.equal(first.status, 200);
  assert.match(first.body.url, /^\/api\/media\/[a-f0-9]{64}\.png$/);
  assert.equal(first.body.size, PNG.length);
  assert.deepEqual((await app.upload()).body, first.body);
  assert.deepEqual(await readdir(path.join(app.dataDir, 'media')), [first.body.url.split('/').at(-1)]);
  for (const [name, mode] of [['', 0o700], ['media', 0o700], ['library.sqlite', 0o600], [first.body.url.replace('/api/', ''), 0o600]]) {
    assert.equal((await stat(path.join(app.dataDir, name))).mode & 0o777, mode);
  }
  const saved = await app.put('assets', { images: [first.body.url], migrationSources: ['legacy-browser-test'] });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  await app.restart();
  assert.deepEqual((await app.get('assets')).body, saved.body);
  const downloaded = await app.request(first.body.url);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(downloaded.bytes, PNG);
  assert.equal(downloaded.headers['content-type'], 'image/png');
  assert.equal(downloaded.headers['x-content-type-options'], 'nosniff');
  assert.equal(downloaded.headers['cross-origin-resource-policy'], 'same-origin');
  const head = await app.request(first.body.url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers['content-length']), PNG.length);
  assert.equal(head.bytes.length, 0);
});

test('drafts, assets and watermark use only references while files exceed browser storage limits', async t => {
  const app = await fixture(t);
  const large = Buffer.alloc(6 * 1024 * 1024, 7);
  PNG.copy(large);
  const media = (await app.upload(large)).body;
  const icon = (await app.upload()).body;
  assert.equal(media.size, large.length);
  const values = {
    content: content(item(media.url)),
    assets: { images: [media.url, icon.url] },
    watermark: watermark(icon.url),
  };
  for (const [kind, value] of Object.entries(values)) assert.equal((await app.put(kind, value)).status, 200);
  await app.restart();
  for (const [kind, value] of Object.entries(values)) assert.deepEqual((await app.get(kind)).body.value, value);
  assert.deepEqual((await app.request(media.url)).bytes, large);
  const db = new DatabaseSync(path.join(app.dataDir, 'library.sqlite'), { readOnly: true });
  t.after(() => db.close());
  const documents = db.prepare('SELECT value FROM documents').all();
  assert.equal(documents.length, 3);
  assert.ok(documents.every(document => !document.value.includes('base64') && document.value.length < 2048));
  assert.equal(db.prepare('SELECT count(*) AS count FROM media').get().count, 2);
});

test('recovered platform receipts preserve their contentId and full lifecycle fields through migration and restart', async t => {
  const app = await fixture(t);
  const platforms = ['weibo', 'xiaohongshu', 'douyin', 'bilibili'];
  const recovered = platforms.map(platform => {
    const contentId = `recovered-${platform}`;
    const requestId = `publish-${platform}-1`;
    const receipt = {
      platform, contentId, id: `post-${platform}`, url: `https://example.com/${platform}/post`,
      publishedAt: '2026-09-15T00:00:00Z', updatedAt: '2026-09-16T00:00:00Z',
      account: { uid: `account-${platform}`, name: `账号 ${platform}` }, requestId,
      lastOperation: { requestId: `update-${platform}-1`, type: 'update', title: '更新标题', body: '更新正文' },
    };
    return item('', {
      id: contentId, platforms: [platform], status: 'published', publishedAt: receipt.publishedAt, publishMode: 'real',
      platformPublications: { [platform]: { requestId, state: 'published', expectedAccountUid: receipt.account.uid, recoveredFromReceipt: true, receipt } },
      ...(platform === 'weibo' ? { weiboReceipt: receipt, weiboRequestId: requestId } : {}),
    });
  });
  // Older saved drafts may carry only the legacy Weibo receipt. Both receipt
  // representations came from the server's content-recovery endpoint.
  recovered.push(item('', {
    id: 'legacy-recovered-weibo', platforms: ['weibo'], status: 'published',
    weiboReceipt: { ...recovered[0].weiboReceipt, contentId: 'legacy-recovered-weibo', deletedAt: '2026-09-16T01:00:00Z', lastOperation: { requestId: 'delete-weibo-1', type: 'delete' } },
    weiboRequestId: recovered[0].weiboRequestId,
  }));
  const document = { ...content(...recovered), migrationSources: ['a'.repeat(64)] };
  const saved = await app.put('content', document);
  assert.equal(saved.status, 200, saved.body?.error?.message);
  assert.deepEqual(saved.body, { revision: 1, value: document });
  await app.restart();
  assert.deepEqual((await app.get('content')).body, saved.body);
  assert.equal((await app.put('content', document, 1)).status, 200);
  for (const entry of (await app.get('content')).body.value.items) {
    for (const publication of Object.values(entry.platformPublications ?? {})) assert.equal(publication.receipt.contentId, entry.id);
    if (entry.weiboReceipt) assert.equal(entry.weiboReceipt.contentId, entry.id);
  }
  const malformed = structuredClone(document);
  malformed.items[0].platformPublications.weibo.receipt.contentId = 42;
  assert.equal((await app.put('content', malformed, 2)).status, 400);
  assert.deepEqual((await app.get('content')).body, { revision: 2, value: document });
});

test('metadata can itself exceed 5 MiB and persists with an atomic revision', async t => {
  const app = await fixture(t);
  const value = content(...Array.from({ length: 100 }, (_, index) => item('', { id: `large-${index}`, body: '文'.repeat(20000) })));
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 5 * 1024 * 1024);
  const saved = await app.put('content', value);
  assert.equal(saved.status, 200);
  await app.restart();
  assert.deepEqual((await app.get('content')).body, saved.body);
});

test('concurrent compare-and-swap writes cannot overwrite a newer revision', async t => {
  const app = await fixture(t);
  assert.deepEqual((await app.get('assets')).body, { revision: 0, value: null });
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => app.put('assets', { images: [], migrationSources: [`source-${index}`] })));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 409).length, 7);
  const winner = results.find(result => result.status === 200);
  assert.deepEqual((await app.get('assets')).body, winner.body);
  const next = await app.put('assets', { images: [] }, 1);
  assert.equal(next.body.revision, 2);
  assert.equal((await app.put('assets', winner.body.value, 1)).status, 409);
  assert.deepEqual((await app.get('assets')).body, next.body);
});

test('document validation rejects Base64, unsafe URLs, malformed references and missing files without replacing data', async t => {
  const app = await fixture(t);
  const media = (await app.upload()).body;
  const original = await app.put('assets', { images: [media.url] });
  const invalidImages = [
    `data:image/png;base64,${PNG.toString('base64')}`, 'javascript:alert(1)', 'file:///etc/passwd',
    '/api/media/../library.sqlite', '/api/media/%2e%2e/library.sqlite', media.url + '?x=1',
    '/api/media/' + '0'.repeat(64) + '.png',
  ];
  for (const source of invalidImages) assert.ok([400, 404].includes((await app.put('assets', { images: [source] }, 1)).status), source);
  assert.equal((await app.put('assets', { images: [], extra: `data:image/png;base64,${PNG.toString('base64')}` }, 1)).status, 400);
  assert.equal((await app.put('content', { version: 2, items: [item(), item()], deletedContentIds: [] })).status, 400);
  assert.equal((await app.put('content', { version: 2, items: [item()], deletedContentIds: ['draft-1'] })).status, 400);
  assert.equal((await app.put('content', content(item('', { platforms: ['unknown'] })))).status, 400);
  assert.equal((await app.put('watermark', watermark('https://example.com/icon.png'))).status, 400);
  assert.equal((await app.put('watermark', { ...watermark(media.url), settings: { ...watermark(media.url).settings, opacity: 2 } })).status, 400);
  assert.deepEqual((await app.get('assets')).body, original.body);
  assert.equal((await app.put('content', content(item('https://images.unsplash.com/example.png')))).status, 200);
});

test('MIME, image bytes, body limits and icon size are enforced', async t => {
  const app = await fixture(t);
  assert.equal((await app.upload(PNG, 'text/html')).status, 415);
  assert.equal((await app.upload(PNG, 'image/jpeg')).status, 400);
  assert.equal((await app.upload(Buffer.from('<script>bad</script>'), 'image/png')).status, 400);
  assert.equal((await app.upload(Buffer.alloc(0))).status, 400);
  const tooLarge = await app.request('/api/media', { method: 'POST', raw: PNG, headers: { 'Content-Type': 'image/png', 'Content-Length': String(12 * 1024 * 1024 + 1) } });
  assert.equal(tooLarge.status, 413);
  const largeIcon = Buffer.alloc(1024 * 1024 + 1);
  PNG.copy(largeIcon);
  const media = (await app.upload(largeIcon)).body;
  assert.equal((await app.put('watermark', watermark(media.url))).status, 400);
  const gif = (await app.upload(Buffer.from('GIF89aGIF bytes'), 'image/gif')).body;
  assert.equal((await app.put('watermark', watermark(gif.url))).status, 400);
  assert.equal((await app.put('assets', { images: [gif.url] })).status, 200);
});

test('image-like captions and watermark labels remain text while unknown metadata is rejected', async t => {
  const app = await fixture(t);
  const document = content(item('', {
    title: 'data:image/example remains text',
    body: '/api/media/example is a route described in this caption',
    category: 'data: notes',
    platformPublications: {
      weibo: {
        requestId: 'request-1', state: 'published',
        receipt: { platform: 'weibo', id: '1', url: 'https://weibo.com/detail/1', publishedAt: '2026-09-16T00:00:00Z', account: { uid: '1', name: 'data:image/example' }, requestId: 'request-1' },
        lifecycle: { operation: 'update', requestId: 'update-1', state: 'pending', title: 'data:标题', body: '/api/media/说明' },
      },
    },
  }));
  assert.equal((await app.put('content', document)).status, 200);
  assert.deepEqual((await app.get('content')).body.value, document);
  const preferences = watermark('');
  preferences.settings.mode = 'auto';
  preferences.settings.text = 'data:image/example';
  assert.equal((await app.put('watermark', preferences)).status, 200);
  preferences.settings.text = '/api/media/example';
  assert.equal((await app.put('watermark', preferences, 1)).status, 200);
  await app.restart();
  assert.deepEqual((await app.get('content')).body.value, document);
  assert.deepEqual((await app.get('watermark')).body.value, preferences);
  assert.equal((await app.put('content', content(item('', { extraImage: `data:image/png;base64,${PNG.toString('base64')}` })), 1)).status, 400);
  assert.equal((await app.put('assets', { images: [], extra: { image: `data:image/png;base64,${PNG.toString('base64')}` } })).status, 400);
});

test('Host, Origin, Fetch Metadata and mutation header protect all storage APIs', async t => {
  const app = await fixture(t);
  const media = (await app.upload()).body;
  const routes = ['/api/local-data/content', media.url];
  for (const route of routes) {
    for (const headers of [{ Host: 'attacker.invalid' }, { Origin: 'https://attacker.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
      assert.equal((await app.request(route, { headers })).status, 403);
    }
    assert.equal((await app.request(route, { headers: { Origin: undefined, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  }
  for (const headers of [{ Origin: undefined }, { 'X-Fatiao-Request': undefined }, { Origin: 'null' }]) {
    assert.equal((await app.request('/api/local-data/assets', { method: 'PUT', value: { expectedRevision: 0, value: { images: [] } }, headers })).status, 403);
    assert.equal((await app.request('/api/media', { method: 'POST', raw: PNG, headers: { 'Content-Type': 'image/png', ...headers } })).status, 403);
  }
  assert.equal((await app.request('/api/local-data/assets', { method: 'PUT', value: {}, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await app.request('/api/local-data/assets', { method: 'DELETE' })).status, 405);
  assert.equal((await app.request('/api/media', { method: 'GET' })).status, 405);
});

test('canonical media routes cannot traverse directories or serve symlinks', async t => {
  const app = await fixture(t);
  const media = (await app.upload()).body;
  // Percent encoding must never be normalized into an allowed canonical name.
  for (const route of [media.url.replace('/api/media/', '/api/media/%2e%2e/'), media.url + '?download=1', '/api/media/%2e%2e/library.sqlite', '/api/media/%2Fetc%2Fpasswd', '/api/media/' + 'f'.repeat(64) + '.sqlite']) {
    assert.equal((await app.request(route)).status, 404);
  }
  const mediaFile = path.join(app.dataDir, media.url.slice('/api/'.length));
  await rm(mediaFile);
  await symlink(path.join(app.dataDir, 'library.sqlite'), mediaFile);
  assert.equal((await app.request(media.url)).status, 503);
  assert.equal((await app.upload()).status, 503);
});

test('a missing or damaged image fails safely without resetting metadata', async t => {
  const app = await fixture(t);
  const media = (await app.upload()).body;
  assert.equal((await app.put('assets', { images: [media.url] })).status, 200);
  const mediaFile = path.join(app.dataDir, media.url.slice('/api/'.length));
  await writeFile(mediaFile, Buffer.alloc(PNG.length, 0));
  assert.equal((await app.request(media.url)).status, 503);
  assert.equal((await app.upload()).status, 503);
  assert.deepEqual(await readFile(mediaFile), Buffer.alloc(PNG.length, 0));
  await rm(mediaFile);
  assert.equal((await app.get('assets')).status, 503);
  assert.equal((await app.request(media.url)).status, 404);
  await app.restart();
  assert.equal((await app.get('assets')).status, 503);
  // Uploading the exact missing file repairs it; metadata itself remains intact.
  assert.equal((await app.upload()).status, 200);
  assert.deepEqual((await app.get('assets')).body, { revision: 1, value: { images: [media.url] } });
});

test('filesystem upload failure leaves saved metadata and media intact and can be retried', async t => {
  const app = await fixture(t);
  const media = (await app.upload()).body;
  const saved = await app.put('assets', { images: [media.url] });
  const directory = path.join(app.dataDir, 'media');
  const backup = path.join(app.dataDir, 'media-before-error');
  await rename(directory, backup);
  await writeFile(directory, 'blocked');
  assert.equal((await app.upload()).status, 503);
  await rm(directory);
  await rename(backup, directory);
  assert.deepEqual((await app.get('assets')).body, saved.body);
  assert.deepEqual((await app.request(media.url)).bytes, PNG);
  assert.equal((await app.upload()).status, 200);
  assert.ok((await readdir(directory)).every(name => !name.endsWith('.tmp')));
});

test('corrupt database is never replaced with a fresh empty library', async t => {
  const app = await fixture(t);
  const original = Buffer.from('corrupted SQLite file with user data');
  await writeFile(path.join(app.dataDir, 'library.sqlite'), original);
  assert.equal((await app.get('assets')).status, 503);
  assert.equal((await app.put('assets', { images: [] })).status, 503);
  assert.equal((await app.upload()).status, 503);
  await app.restart();
  assert.equal((await app.get('assets')).status, 503);
  assert.deepEqual(await readFile(path.join(app.dataDir, 'library.sqlite')), original);
});

test('a malformed stored document is preserved even when a caller has the old revision', async t => {
  const app = await fixture(t);
  assert.equal((await app.put('assets', { images: [] })).status, 200);
  await app.close();
  const databasePath = path.join(app.dataDir, 'library.sqlite');
  const db = new DatabaseSync(databasePath);
  db.prepare('UPDATE documents SET value = ? WHERE kind = ?').run('broken saved metadata', 'assets');
  db.close();
  await app.restart();
  assert.equal((await app.get('assets')).status, 503);
  assert.equal((await app.put('assets', { images: [] }, 1)).status, 503);
  await app.close();
  const saved = new DatabaseSync(databasePath, { readOnly: true });
  try { assert.equal(saved.prepare('SELECT value FROM documents WHERE kind = ?').get('assets').value, 'broken saved metadata'); }
  finally { saved.close(); }
});
