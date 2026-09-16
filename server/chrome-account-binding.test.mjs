import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createChromeAccountBinding } from './chrome-account-binding.mjs';
import { publicAccount } from './platform-browser.mjs';

const account = { uid: '123', name: 'Test', profileUrl: 'https://weibo.com/u/123', avatarUrl: 'https://wx1.sinaimg.cn/a.jpg' };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fatiao-bound-account-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'weibo-chrome-connection');
  await mkdir(directory);
  const binding = createChromeAccountBinding({ directory, normalizeAccount: publicAccount });
  return { root, directory, binding, file: path.join(directory, 'account.json') };
}

test('binding storage keeps only bounded public identity in an atomic private file', async t => {
  const f = await fixture(t);
  assert.equal(await f.binding.read(), undefined);
  await f.binding.save({ ...account, cookies: 'SECRET', token: 'SECRET' });
  assert.deepEqual(await f.binding.read(), account);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), { version: 1, account });
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  await f.binding.save({ ...account, name: 'Updated' });
  assert.equal((await f.binding.read()).name, 'Updated');
  assert.deepEqual(await readdir(f.directory), ['account.json']);
});

test('corrupt, unsupported and oversized binding files never become a cached account', async t => {
  const f = await fixture(t);
  for (const bytes of ['{', JSON.stringify({ version: 2, account }), JSON.stringify({ version: 1, account: { name: 'missing uid' } }), ' '.repeat(8_193)]) {
    await writeFile(f.file, bytes);
    assert.equal(await f.binding.read(), undefined);
  }
  await f.binding.save(account);
  assert.deepEqual(await f.binding.read(), account);
  await assert.rejects(f.binding.save({ ...account, avatarUrl: `https://wx1.sinaimg.cn/${'a'.repeat(9_000)}` }), { code: 'BROWSER_UNAVAILABLE' });
  assert.deepEqual(await f.binding.read(), account);
});

test('binding reads and writes never follow a symlink file or connection directory', async t => {
  const f = await fixture(t);
  const other = path.join(f.root, 'unrelated.json');
  const bytes = JSON.stringify({ version: 1, account });
  await writeFile(other, bytes);
  await symlink(other, f.file);
  assert.equal(await f.binding.read(), undefined);
  await assert.rejects(f.binding.save(account), { code: 'BROWSER_UNAVAILABLE' });
  assert.equal(await readFile(other, 'utf8'), bytes);
  await rm(f.file);
  await rm(f.directory, { recursive: true });
  const external = path.join(f.root, 'external');
  await mkdir(external);
  await writeFile(path.join(external, 'account.json'), bytes);
  await symlink(external, f.directory);
  assert.equal(await f.binding.read(), undefined);
  await assert.rejects(f.binding.save(account), { code: 'BROWSER_UNAVAILABLE' });
  assert.equal(await readFile(path.join(external, 'account.json'), 'utf8'), bytes);
});
