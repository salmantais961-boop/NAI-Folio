import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { formats } from './providers/formats.mjs';
import { readUsage } from './providers/usage.mjs';
import { applyReasoningEffort } from './providers/effort.mjs';

const chatProtocol = 'chat-completions';
const preset = (id, label, protocol, baseUrl, needsKey = true) => Object.freeze({ id, label, protocol, baseUrl, needsKey });
export const PROVIDER_PRESETS = Object.freeze([
  preset('openai', 'OpenAI · Responses', 'responses', 'https://api.openai.com/v1'),
  preset('openai-chat', 'OpenAI · Chat Completions', chatProtocol, 'https://api.openai.com/v1'),
  preset('deepseek', 'DeepSeek', chatProtocol, 'https://api.deepseek.com/v1'),
  preset('anthropic', 'Anthropic · Claude', 'anthropic', 'https://api.anthropic.com/v1'),
  preset('gemini', 'Google · Gemini', 'gemini', 'https://generativelanguage.googleapis.com/v1beta'),
  preset('openrouter', 'OpenRouter', chatProtocol, 'https://openrouter.ai/api/v1'),
  preset('groq', 'Groq', chatProtocol, 'https://api.groq.com/openai/v1'),
  preset('mistral', 'Mistral', chatProtocol, 'https://api.mistral.ai/v1'),
  preset('xai', 'xAI', chatProtocol, 'https://api.x.ai/v1'),
  preset('together', 'Together AI', chatProtocol, 'https://api.together.ai/v1'),
  preset('siliconflow', '硅基流动', chatProtocol, 'https://api.siliconflow.cn/v1'),
  preset('qwen-cn', '阿里云百炼 · 中国内地', chatProtocol, 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
  preset('qwen-intl', '阿里云百炼 · 国际', chatProtocol, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),
  preset('lmstudio', 'LM Studio', chatProtocol, 'http://127.0.0.1:1234/v1', false),
  preset('ollama', 'Ollama', 'ollama', 'http://127.0.0.1:11434/api', false),
  preset('custom', '自定义接口', chatProtocol, '', false),
]);

const defaults = { 'chat-completions': '/v1', responses: '/v1', anthropic: '/v1', gemini: '/v1beta', ollama: '/api' };
const modelsEndpoint = { 'chat-completions': 'models', responses: 'models', anthropic: 'models', gemini: 'models', ollama: 'tags' };
const fullEndpoint = {
  'chat-completions': /\/(?:chat\/completions|responses|models)$/i,
  responses: /\/(?:chat\/completions|responses|models)$/i,
  anthropic: /\/(?:messages|models)$/i,
  gemini: /\/models(?:\/[^/]+:(?:streamGenerateContent|generateContent))?$/i,
  ollama: /\/(?:tags|chat|generate)$/i,
};

function localEndpoint(host) {
  if (!isIPv4(host)) return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '[::1]'
    || /^\[f[cd][a-f0-9]{2}:/i.test(host);
  return /^(127|10)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

function normalizeUrl(value, protocol, preferRoot) {
  let text = String(value || '').trim();
  if (!text) throw Error('请填写模型服务的 API 地址。');
  if (text.length > 2048 || /[\\\s\u0000-\u001f\u007f]/.test(text)) throw Error('API 地址格式无效。');
  if (!/^[\w+.-]+:\/\//.test(text)) {
    let host;
    try { host = new URL('http://' + text).hostname; } catch { throw Error('API 地址格式无效。'); }
    text = (localEndpoint(host) ? 'http://' : 'https://') + text;
  }
  let url;
  try { url = new URL(text); } catch { throw Error('API 地址格式无效。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw Error('请填写 HTTP 或 HTTPS 地址，将密钥单独填入 API Key 栏。');
  // Provider origins come only from local settings. Never allow instance-metadata hosts or redirect credentials.
  if (/^(169\.254\.|0\.|metadata\.google\.internal\.?$|\[fe[89ab]|\[::\]$|\[::ffff:)/i.test(url.hostname))
    throw Error('该主机地址不能用作模型服务。');
  if (url.protocol === 'http:' && !localEndpoint(url.hostname))
    throw Error('远程模型服务需要 HTTPS。本机或局域网 IP 可以使用 HTTP。');
  const path = url.pathname.replace(/\/+$/, '');
  const stripped = path.replace(fullEndpoint[protocol], '');
  const exactRoot = !stripped && (path !== stripped || preferRoot === true);
  if (stripped || exactRoot) url.pathname = stripped || '/';
  else {
    const official = PROVIDER_PRESETS.find(p => p.protocol === protocol && p.baseUrl && new URL(p.baseUrl).origin === url.origin);
    url.pathname = official ? new URL(official.baseUrl).pathname : defaults[protocol];
  }
  return { baseUrl: url.href.replace(/\/+$/, ''), exactRoot };
}

export function normalizeProvider(input = {}) {
  const selected = input.preset ? PROVIDER_PRESETS.find(p => p.id === input.preset)
    : input.baseUrl ? PROVIDER_PRESETS.find(p => p.id === 'custom')
    : PROVIDER_PRESETS.find(p => p.protocol === (input.protocol || 'responses'));
  if (!selected) throw Error('请选择支持的模型服务。');
  const protocol = input.protocol || selected.protocol;
  if (!Object.hasOwn(formats, protocol)) throw Error('未知的模型通信协议。');
  const model = String(input.model || '').trim();
  if (model.length > 512 || /[\x00-\x1f\x7f]/.test(model) || model.split('/').some(p => p === '.' || p === '..'))
    throw Error('请输入有效的模型 ID。');
  const apiKey = String(input.apiKey || '').trim().replace(/^Bearer\s+/i, '');
  if (apiKey.length > 8192 || /[^\x21-\x7e]/.test(apiKey)) throw Error('API Key 中含有无效字符。');
  const address = normalizeUrl(input.baseUrl?.trim() || selected.baseUrl, protocol, input.exactRoot);
  const reasoningEffort = input.reasoningEffort ?? 'auto';
  return { preset: selected.id, protocol, ...address, apiKey, model, reasoningEffort };
}

function headers(config) {
  const result = { Accept: 'application/json' };
  if (config.protocol === 'anthropic') result['anthropic-version'] = '2023-06-01';
  if (!config.apiKey) return result;
  if (config.protocol === 'anthropic') result['x-api-key'] = config.apiKey;
  else if (config.protocol === 'gemini') result['x-goog-api-key'] = config.apiKey;
  else result.Authorization = 'Bearer ' + config.apiKey;
  return result;
}

function providerError(operation, status) {
  let hint = '请检查模型 ID、协议和 API 地址。';
  if (status === 401 || status === 403) hint = '请检查 API Key 和访问权限。';
  else if (status === 429) hint = '请求被限流或账户额度不足。';
  else if (operation === '拉取模型' && [404, 405, 501].includes(status)) hint = '该服务可能未开放模型列表，可手动填写模型 ID 后检测连接。';
  else if (status >= 500) hint = '上游模型服务暂时不可用。';
  else if (status >= 300 && status < 400) hint = '请填写服务的最终地址，凭据不会随重定向转发。';
  return Error(operation + '失败（HTTP ' + status + '）。' + hint);
}

async function readJson(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body || []) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) throw Error('模型服务的响应过大。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('模型服务未返回有效的 JSON，请检查 API 地址和协议。'); }
}

// Some OpenAI-compatible hosts list non-tool models next to tool-capable ones.
// Inspect only a small error prefix and surface a fixed diagnostic; provider messages
// sometimes echo user input, URLs or credentials.
async function rejectsTools(response) {
  let prefix = '';
  for await (const chunk of response.body || []) {
    prefix += Buffer.from(chunk.subarray(0, 4096 - prefix.length)).toString('utf8');
    if (prefix.length >= 4000) break;
  }
  return /(?:tools?|function.{0,2}call(?:ing)?).{0,90}(?:unsupported|not supported|not available|not enabled)|(?:does not support|doesn't support|unsupported|unknown parameter|unrecognized).{0,70}(?:tools?|function.{0,2}call)/is.test(prefix);
}

async function request(config, endpoint, { operation, body, query, signal }) {
  const url = new URL(config.baseUrl + '/' + endpoint);
  if (query) url.search = new URLSearchParams(query).toString();
  const outgoing = headers(config);
  if (body) outgoing['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(url, { method: body ? 'POST' : 'GET', headers: outgoing,
      body: body ? JSON.stringify(body) : undefined, redirect: 'manual', signal });
    if (!response.ok) {
      if (body?.tools?.length && [400, 404, 422].includes(response.status) && await rejectsTools(response))
        throw Error('这个模型不支持原生工具调用。');
      await response.body?.cancel();
      throw providerError(operation, response.status);
    }
    const json = await readJson(response);
    if (!json || typeof json !== 'object' || json.error) throw Error(operation + '失败，模型服务返回了错误。');
    return json;
  } catch (error) {
    if (signal?.aborted) {
      if (signal.reason?.name === 'TimeoutError') throw Error(operation + '超时。');
      throw new DOMException('操作已取消。', 'AbortError');
    }
    // Never forward raw upstream error bodies, URLs, Authorization headers, or fetch causes.
    if (!response || error instanceof TypeError) throw Error('无法连接模型服务，请检查地址、网络和协议。');
    throw error;
  }
}

function limitedSignal(signal, timeout) {
  const timer = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

export async function listModels(input, { signal } = {}) {
  const config = normalizeProvider(input);
  const { protocol } = config;
  const timeout = limitedSignal(signal, 45_000);
  const ids = new Set(), cursors = new Set();
  let cursor;
  for (let page = 0; page < 100; page++) {
    let query;
    if (protocol === 'gemini') query = cursor ? { pageSize: '100', pageToken: cursor } : { pageSize: '100' };
    else if (protocol === 'anthropic') query = cursor ? { limit: '100', after_id: cursor } : { limit: '100' };
    else if (cursor) query = { after: cursor };
    const json = await request(config, modelsEndpoint[protocol], { operation: '拉取模型', query, signal: timeout });
    const rows = protocol === 'gemini' || protocol === 'ollama' ? json.models : Array.isArray(json) ? json : json.data;
    if (!Array.isArray(rows)) throw Error('模型列表格式与所选协议不符，可手动填写模型 ID。');
    for (const row of rows) {
      if (protocol === 'gemini' && Array.isArray(row?.supportedGenerationMethods) && !row.supportedGenerationMethods.includes('generateContent')) continue;
      const id = typeof row === 'string' ? row : row?.id || row?.name || row?.model;
      if (typeof id === 'string' && id.trim()) ids.add(protocol === 'gemini' ? id.replace(/^models\//, '') : id);
    }
    if (protocol === 'gemini') cursor = json.nextPageToken;
    else if (json.has_more) {
      cursor = json.last_id || rows.at(-1)?.id;
      if (!cursor) throw Error('模型服务缺少下一页游标。');
    } else cursor = undefined;
    if (!cursor) return [...ids].sort((a, b) => a.localeCompare(b));
    if (typeof cursor !== 'string' || cursors.has(cursor)) throw Error('模型列表分页游标无效。');
    cursors.add(cursor);
  }
  throw Error('模型列表页数超出上限。');
}

async function complete(config, { system = '', messages, tools = [], signal, maxTokens, reasoningEffort = config.reasoningEffort }, operation) {
  if (!config.model) throw Error('请先选择或填写模型 ID。');
  if (typeof system !== 'string' || !Array.isArray(messages) || !messages.length ||
      messages.some(m => !m || !['user', 'assistant', 'tool'].includes(m.role) || typeof m.content !== 'string')) {
    throw Error('对话消息格式无效。');
  }
  if (!Array.isArray(tools) || tools.some(t => !t || typeof t.name !== 'string' || !/^[A-Za-z_][\w-]{0,63}$/.test(t.name)
      || !t.parameters || typeof t.parameters !== 'object' || Array.isArray(t.parameters)))
    throw Error('工具定义缺少有效的名称或参数。');
  if (maxTokens != null && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) throw Error('输出 token 上限无效。');
  const scope = createHash('sha256').update(JSON.stringify([config.protocol, config.baseUrl, config.model])).digest('hex');
  const format = formats[config.protocol];
  const body = format.build({ config, system, messages, tools, maxTokens, scope });
  applyReasoningEffort(body, config, reasoningEffort);
  const started = performance.now();
  const json = await request(config, format.path(config), { operation, body, signal });
  const usage = readUsage(config.protocol, json, performance.now() - started);
  const result = format.read(json, scope);
  if (usage) result.usage = usage;
  return result;
}

export async function chat(input, options = {}) {
  const result = await complete(normalizeProvider(input), { ...options, signal: limitedSignal(options.signal, 180_000) }, '对话');
  if (!result.content && !result.toolCalls.length) throw Error('模型没有返回文字或工具调用，请检查模型或输出长度。');
  return result;
}

export async function testConnection(input, { signal } = {}) {
  const config = normalizeProvider(input);
  await complete(config, { messages: [{ role: 'user', content: 'Reply with OK.' }],
    maxTokens: 64, signal: limitedSignal(signal, 90_000) }, '检测连接');
  // Reasoning models may consume a short probe's entire output budget on internal tokens.
  return { ok: true, model: config.model };
}
