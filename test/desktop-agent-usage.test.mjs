import assert from 'node:assert/strict';
import test from 'node:test';
import { readUsage } from '../desktop/agent/providers/usage.mjs';
import { replyUsage } from '../desktop/frontend/agent-usage.js';
import { webSearchProviderFor } from '../desktop/frontend/agent-web-search.js';

test('reply stats aggregate provider token counts and weight speed by model-request duration', () => {
  const track = replyUsage();
  const first = readUsage('chat-completions', { usage: { prompt_tokens: 82, completion_tokens: 18, total_tokens: 100 } }, 1250);
  const second = readUsage('responses', { usage: { input_tokens: 112, output_tokens: 32, total_tokens: 144 } }, 750);
  track(first);
  assert.deepEqual(track(second), { inputTokens: 194, outputTokens: 50, totalTokens: 244, tps: 25, approximateTps: true });
  assert.equal(readUsage('chat-completions', {}, 12), null);
  const partial = track(null);
  assert.equal(partial.totalTokens, null);
  assert.equal(partial.tps, null);
  const reportedOnly = replyUsage()(readUsage('chat-completions', { usage: { total_tokens: 450 } }, 1000));
  assert.equal(reportedOnly.totalTokens, 450);
  assert.equal(reportedOnly.tps, null);
});

test('cache input, thinking output and inference timing respect provider semantics', () => {
  const a = readUsage('anthropic', {usage:{ input_tokens: 10, cache_read_input_tokens: 40, cache_creation_input_tokens: 3, output_tokens: 7 }}, 135);
  assert.equal(a.totalTokens, 60);
  const g = readUsage('gemini', {usageMetadata:{promptTokenCount: 125, candidatesTokenCount: 80, thoughtsTokenCount: 19, totalTokenCount: 224}}, 1700);
  assert.equal(g.outputTokens, 99);
  const o = replyUsage()(readUsage('ollama', {prompt_eval_count: 7, eval_count: 12, eval_duration: 300_000_000}, 900));
  assert.equal(o.tps, 40);
  assert.equal(o.approximateTps, false);
});

test('web search reuses an eligible saved DeepSeek connection independently of the selected chat model', () => {
  const profiles = [
    { id: 'relay', preset: 'deepseek', baseUrl: 'https://api.deepseek.com.example.com', apiKey: 'relay-test' },
    { id: 'official', preset: 'custom', baseUrl: 'https://api.deepseek.com/beta', apiKey: 'official-test' },
    { id: 'second', preset: 'deepseek', apiKey: 'second-test' },
  ];
  const config = { profiles, activeId: 'relay', plugins: {} };
  assert.equal(webSearchProviderFor(config).apiKey, 'official-test');
  assert.equal(webSearchProviderFor({ ...config, activeId: 'second' }).apiKey, 'second-test');
  assert.equal(webSearchProviderFor(config, {profileId:'second'}).apiKey, 'second-test');
  for (const preferences of [{enabled:false}, {profileId:'deleted'}, {profileId:'relay'}])
    assert.equal(webSearchProviderFor(config, preferences), undefined);
  assert.equal(webSearchProviderFor({profiles:[profiles[0]], plugins:{}}), undefined);
});
