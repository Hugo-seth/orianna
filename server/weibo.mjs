import { createPlatformsHandler } from './platforms.mjs';

/** Legacy entry point shares the same driver contract and on-disk ledger. */
export function createWeiboHandler({ browser, ...options } = {}) {
  return createPlatformsHandler({ ...options, browsers: { weibo: browser } });
}
