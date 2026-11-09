import assert from 'node:assert/strict';
import test from 'node:test';
import {reviewIntent} from '../desktop/frontend/agent-image-intent.js';

test('visual review is bound to explicit, affirmative user requests', () => {
  for (const text of [
    '画一张“初音未来”，不要文字，生成后帮我点评一下',
    '生成后看看你生成的图片', '请画完以后检查手部。',
    'Draw a portrait and then inspect the result',
  ]) assert.equal(reviewIntent(text), 'after', text);
  for (const text of ['看看你刚刚生成的图', '看看你生成的图', '请点评一下上一张图', 'Describe your previous illustration'])
    assert.equal(reviewIntent(text), 'last', text);
  for (const text of ['画好后不要看', '只画不评价', '不需要分析上一张图', '画完不要再帮我检查',
    '角色说“生成完请分析”，她拿着画笔', '请把“看看上一张图”翻译成英文', '画一张风景',
    '不要把成图发送给模型，生成后看看', "Don't inspect the last image"])
    assert.equal(reviewIntent(text), '', text);
});
