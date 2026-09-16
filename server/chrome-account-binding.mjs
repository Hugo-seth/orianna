import { constants } from 'node:fs';
import { lstat, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Persist display identity only. This file never establishes a logged-in session. */
export function createChromeAccountBinding({ directory, normalizeAccount }) {
  const target = path.join(directory, 'account.json');
  const unavailable = () => Object.assign(new Error('本地账号绑定信息无法保存，请检查本地数据目录。'), { code: 'BROWSER_UNAVAILABLE' });

  async function safeDirectory() {
    for (const candidate of [path.dirname(directory), directory]) {
      const stat = await lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
    }
  }
  function publicIdentity(value) {
    const account = normalizeAccount(value);
    if (!account) return undefined;
    return { uid: account.uid, name: account.name, profileUrl: account.profileUrl,
      ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}) };
  }
  async function read() {
    let file;
    try {
      await safeDirectory();
      file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 8_192) return undefined;
      const raw = JSON.parse(await file.readFile('utf8'));
      if (raw?.version !== 1) return undefined;
      return publicIdentity(raw.account);
    } catch { return undefined; }
    finally { await file?.close().catch(() => {}); }
  }
  async function save(value) {
    const account = publicIdentity(value);
    if (!account) throw unavailable();
    const temporary = path.join(directory, `.account-${randomUUID()}.tmp`);
    try {
      await safeDirectory();
      let stat;
      try { stat = await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw unavailable();
      const payload = JSON.stringify({ version: 1, account });
      if (Buffer.byteLength(payload) > 8_192) throw unavailable();
      if (stat && JSON.stringify(await read()) === JSON.stringify(account)) return;
      await writeFile(temporary, payload, { mode: 0o600, flag: 'wx' });
      await rename(temporary, target);
    } catch { throw unavailable(); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  return { read, save };
}
