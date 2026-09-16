import test from 'node:test';
import assert from 'node:assert/strict';
import { composeWeiboStatus, validateWeiboPublish } from './weibo.ts';

test('own-account publishing needs no share URL and preserves topics and multiline text', () => {
  const item = { title: '今天的生活', body: '#日常#\n第二行', images: [], platforms: ['weibo' as const] };
  assert.deepEqual(validateWeiboPublish(item), []);
  assert.equal(composeWeiboStatus(item.title, item.body), '今天的生活\n\n#日常#\n第二行');
});

test('ordinary long-form text and four pictures are supported without share API restrictions', () => {
  assert.deepEqual(validateWeiboPublish({ title: '', body: '文字'.repeat(150), images: ['a', 'b', 'c', 'd'], platforms: ['weibo'] }), []);
});

test('real publishing cannot label other demo platforms as published', () => {
  assert.match(validateWeiboPublish({ title: '微博', body: '', images: [], platforms: ['weibo', 'douyin'] }).join(' '), /单独选择微博/);
});

test('empty text and excessive images are rejected', () => {
  const errors = validateWeiboPublish({ title: '  ', body: '\n', images: ['a', 'b', 'c', 'd', 'e'], platforms: ['weibo'] });
  assert.equal(errors.length, 2);
});

test('a body-only Weibo is accepted and whitespace trimmed', () => {
  assert.deepEqual(validateWeiboPublish({ title: '', body: ' 一条微博 ', images: [], platforms: ['weibo'] }), []);
  assert.equal(composeWeiboStatus('', ' 一条微博 '), '一条微博');
});
