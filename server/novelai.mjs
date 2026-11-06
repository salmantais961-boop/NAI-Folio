import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { decodeImages, generationEvents, summarizeImageResponse } from './image-response.mjs';

const MiB = 1024 * 1024;
const officialHost = 'https://image.novelai.net/';
const endpoints = new Map([
  ['/api/generate', 'generate-image'],
  ['/api/generate-stream', 'generate-image-stream'],
  ['/api/encode-vibe', 'encode-vibe'],
  ['/api/augment', 'augment-image'],
  ['/api/upscale', 'upscale'],
]);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function relayBase(value, label) {
  let base;
  try { base = new URL(value); } catch { throw new HttpError(400, label + '无效，请填写完整的 HTTPS 地址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) || base.username || base.password || /[?#]/.test(base.href))
    throw new HttpError(400, label + '须使用 HTTPS（本机可用 HTTP），且不能包含账号、密码、查询参数或片段。');
  base.pathname = base.pathname.replace(/\/+$/, '') + '/';
  return base;
}

function connectionFor(req) {
  const provider = req.headers['x-nai-provider'] || 'official';
  if (!['official', 'relay'].includes(provider)) throw new HttpError(400, '请选择官方连接或 NAI 原生中转站。');
  if (provider === 'official') {
    if (req.headers['x-nai-image-base'] || req.headers['x-nai-account-base'])
      throw new HttpError(400, '自定义地址需要选择中转站连接。');
    return { provider, service: 'NovelAI', image: officialHost + 'ai/', subscription: officialHost + 'user/subscription' };
  }
  const base = relayBase(req.headers['x-nai-image-base'], '中转站图像地址');
  const root = new URL(base);
  if (root.pathname.endsWith('/ai/')) root.pathname = root.pathname.slice(0, -3);
  const accountBase = req.headers['x-nai-account-base'] ? relayBase(req.headers['x-nai-account-base'], '中转站账户地址') : root;
  let accountPath = accountBase.href.replace(/\/$/, '');
  if (!accountPath.endsWith('/user/subscription')) accountPath += accountPath.endsWith('/user') ? '/subscription' : '/user/subscription';
  return {
    provider, service: '中转站',
    image: base.pathname.endsWith('/ai/') ? base.href : base.href + 'ai/',
    subscription: accountPath,
  };
}

function unavailableRelayAccount() {
  return {
    provider: 'relay', accountAvailable: false, active: true, entitled: null, tier: null,
    anlas: null, subscriptionAnlas: null, purchasedAnlas: null, usage: null, expiresAt: null,
    accountNotice: '中转站未提供兼容的账户查询接口，用量请在中转站查看。',
  };
}

export function json(res, status, value) {
  const data = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readLimited(stream, max, status, message) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.byteLength;
    if (length > max) throw new HttpError(status, message);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function validateOperation(operation, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求必须是 JSON 对象。');
  if (operation.startsWith('generate-image')) {
    if (!['generate', 'img2img', 'infill'].includes(body.action) || typeof body.model !== 'string' ||
        typeof body.input !== 'string' || !body.parameters || typeof body.parameters !== 'object' || Array.isArray(body.parameters))
      throw new HttpError(400, '请检查模型、提示词、生成模式和参数。');
    if (body.action !== 'generate' && !body.parameters.image) throw new HttpError(400, '请先选择底图。');
    if (body.action === 'infill' && !body.parameters.mask) throw new HttpError(400, '请先提交局部重绘蒙版。');
    const samples = body.parameters.n_samples ?? 1;
    if (!Number.isInteger(samples) || samples < 1 || samples > 8) throw new HttpError(400, '每次可请求 1–8 张图。');
    if (operation === 'generate-image-stream') body.parameters.stream = 'sse';
  } else {
    if (typeof body.image !== 'string' || !body.image.length) throw new HttpError(400, '请选择图片。');
    if (operation === 'augment-image' && !body.req_type) throw new HttpError(400, '请选择导演工具。');
    if (operation !== 'augment-image' && !body.model) throw new HttpError(400, '请选择模型。');
  }
}

async function postData(req, operation) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, '请用 JSON 格式提交请求。');
  const max = 96 * MiB;
  const tooLarge = '上传的图片总量过大，请先调整尺寸。';
  if (Number(req.headers['content-length']) > max) throw new HttpError(413, tooLarge);
  const data = await readLimited(req, max, 413, tooLarge);
  let parsed;
  try { parsed = JSON.parse(data); } catch { throw new HttpError(400, '请求 JSON 无法解析。'); }
  validateOperation(operation, parsed);
  return parsed;
}

function upstreamError(response, id, service) {
  const status = response.status;
  const hint = {
    400: service + '未接受当前参数，请检查模型、图片尺寸、参考图和采样设置。',
    401: service + ' API Key 无效或已过期，请重新填写。',
    402: '账户的 Anlas 余额或可用额度不足。',
    403: service + '拒绝了访问，请检查订阅和模型权限。',
    409: '账户有正在处理的请求，请稍后重试。',
    413: '上传的图片超过' + service + '的大小限制。',
    422: service + '无法处理当前图片或请求参数。',
    429: service + '请求过于频繁，请稍后再试。',
  };
  return new HttpError(status >= 400 && status < 600 ? status : 502,
    (hint[status] ?? service + '服务返回异常，请核对账户记录后重试。') + '（HTTP ' + status + ' · ' + id + '）');
}

async function upstream(fetchImpl, url, options, signal, service, optionalAccount = false) {
  const id = randomBytes(3).toString('hex');
  let response;
  try {
    response = await fetchImpl(url, { ...options, headers: { ...options.headers, 'x-correlation-id': id }, signal, redirect: 'error' });
  } catch {
    throw new HttpError(signal.aborted ? 504 : 502,
      signal.aborted ? '等待' + service + '响应超时或已中断。请核对账户用量后重试。' : '无法连接' + service + '，请检查地址、本机网络或代理。');
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (optionalAccount && [404, 405, 501].includes(response.status)) return null;
    throw upstreamError(response, id, service);
  }
  if (!response.body) {
    if (optionalAccount) return null;
    throw new HttpError(502, service + '返回了空响应。');
  }
  return response;
}

function accountSummary(raw) {
  if (typeof raw?.tier !== 'number' || typeof raw.active !== 'boolean') throw new HttpError(502, '无法解析 NovelAI 的订阅信息。');
  const numeric = value => Number.isFinite(value) ? value : null;
  const balance = raw.trainingStepsLeft;
  const subscriptionAnlas = numeric(balance?.fixedTrainingStepsLeft);
  const purchasedAnlas = numeric(balance?.purchasedTrainingSteps);
  const anlas = subscriptionAnlas !== null && purchasedAnlas !== null ? subscriptionAnlas + purchasedAnlas : numeric(balance);
  const expiresAt = numeric(raw.expiresAt);
  const entitled = [1,2,3,4].includes(raw.accountType) || (raw.tier > 0 && (expiresAt !== null ? expiresAt * 1000 > Date.now() : raw.active));
  const usage = raw.usage && typeof raw.usage === 'object' ? {
    percent: numeric(raw.usage.percent), purchasedPercent: numeric(raw.usage.purchasedPercent),
    isNegative: typeof raw.usage.isNegative === 'boolean' ? raw.usage.isNegative : null,
    timeUntilNextPercent: numeric(raw.usage.timeUntilNextPercent),
  } : null;
  return { tier:raw.tier, active:raw.active, entitled, expiresAt, anlas, subscriptionAnlas, purchasedAnlas, usage };
}

function imageResponseError(error, raw, contentType, service) {
  const summary = summarizeImageResponse(raw, contentType);
  if (summary.format === 'html')
    return new HttpError(502, service + '返回了网页而非图片，请检查生图 API 地址和该站是否支持所选功能。本次请求未自动重试。');
  if (error.code === 'REMOTE_IMAGE_URLS')
    return new HttpError(502, service + '返回的是图片链接，当前连接需要 Base64 或 ZIP 回图。请在中转站启用内联图片返回；本次请求未自动重试。');
  const fields = summary.shape?.fields;
  const shape = fields ? Object.entries(fields).map(([key, value]) => key + ':' + value.type).join(', ') : summary.shape?.type;
  const detail = [summary.format, shape, summary.byteLength + ' bytes'].filter(Boolean).join(' · ').slice(0, 350);
  if (fields?.error || fields?.errors)
    return new HttpError(502, service + '返回了错误信息而非图片（' + detail + '）。请核对该站的模型权限、余额与任务记录。本次请求未自动重试。');
  return new HttpError(502, '无法读取' + service + '回图（' + detail + '）。本次请求未自动重试，请先核对该站任务记录。');
}

// A token is used for this request only. Never persist it or log upstream payloads.
export async function handleApi(req, res, url, fetchImpl = fetch) {
  const route = url.pathname;
  const configured = Boolean(process.env.NOVELAI_TOKEN?.trim());
  if (route === '/api/status' && req.method === 'GET') return json(res, 200, { configured });
  const account = route === '/api/account';
  const suggest = route === '/api/suggest-tags';
  const operation = endpoints.get(route);
  if (!operation && !account && !suggest) throw new HttpError(404, '没有这个接口。');
  if (req.method !== (account || suggest ? 'GET' : 'POST')) throw new HttpError(405, '请求方法不适用。');
  const connection = connectionFor(req);
  const relay = connection.provider === 'relay';
  let token;
  if (req.headers.authorization) {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization);
    if (!match) throw new HttpError(401, '请输入有效的 NovelAI Token。');
    token = match[1];
  } else if (!relay) token = process.env.NOVELAI_TOKEN?.trim();
  if (!token && relay) throw new HttpError(401, '请填写当前中转站的 API Key。');
  if (!token && !suggest) throw new HttpError(401, '请先连接 NovelAI，填写你的 Persistent API Token。');
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(account || suggest ? 20000 : 300000)]);
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  if (account || suggest) {
    const endpoint = new URL(account ? connection.subscription : connection.image + 'generate-image/suggest-tags');
    if (suggest) {
      const prompt = url.searchParams.get('prompt') ?? '';
      if (!prompt.trim() || prompt.length > 2048) throw new HttpError(400, '请输入要查询的标签。');
      endpoint.searchParams.set('prompt', prompt);
      endpoint.searchParams.set('model', (url.searchParams.get('model') || 'nai-diffusion-5-full').slice(0, 150));
      endpoint.searchParams.set('lang', url.searchParams.get('lang') === 'jp' ? 'jp' : 'en');
    }
    const response = await upstream(fetchImpl, endpoint, { headers }, signal, connection.service, account && relay);
    if (!response) return json(res, 200, unavailableRelayAccount());
    const raw = await readLimited(response.body, MiB, 502, '账户或标签响应过大。');
    let parsed;
    try { parsed = JSON.parse(raw); } catch {
      if (account && relay) return json(res, 200, unavailableRelayAccount());
      throw new HttpError(502, connection.service + '返回了无法识别的账户或标签数据。');
    }
    if (!account) return json(res, 200, parsed);
    if (relay && (typeof parsed?.tier !== 'number' || typeof parsed?.active !== 'boolean'))
      return json(res, 200, unavailableRelayAccount());
    const summary = accountSummary(parsed);
    return json(res, 200, relay ? { ...summary, provider: 'relay', accountAvailable: true } : summary);
  }
  const body = await postData(req, operation);
  const streaming = operation === 'generate-image-stream';
  // Some native relays negotiate a ZIP or text/base64 response. Accept it once,
  // then inspect the bytes rather than retrying a potentially billable request.
  const accept = streaming ? 'text/event-stream' : operation === 'encode-vibe' ? 'application/octet-stream' : relay ? '*/*' : operation === 'augment-image' ? 'application/zip' : 'application/json';
  const response = await upstream(fetchImpl, connection.image + operation, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: accept }, body: JSON.stringify(body),
  }, signal, connection.service);
  const type = response.headers.get('content-type') || '';
  if (streaming) {
    if (!type.includes('text/event-stream')) {
      await response.body.cancel();
      throw new HttpError(502, connection.service + '未返回图像事件流。该站可能只支持普通生图，请关闭「流式预览」后使用。本次请求未自动重试。');
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    res.flushHeaders();
    try {
      for await (const event of generationEvents(response, body.parameters.n_samples ?? 1, body.parameters.seed)) {
        if (!res.write(JSON.stringify(event) + '\n')) await once(res, 'drain', { signal });
      }
      res.end();
    } catch (error) {
      if (!res.destroyed) res.end(JSON.stringify({ type: 'error', error: '流式生成未完成。' + (error.message.startsWith('NovelAI') || error.message.startsWith('流式') ? error.message : '请检查连接与账户用量。') }) + '\n');
    }
    return;
  }
  const raw = await readLimited(response.body, 112 * MiB, 502, connection.service + '回图超过本机处理上限。');
  if (!raw.length) throw new HttpError(502, connection.service + '返回了空响应。');
  if (operation === 'encode-vibe') {
    if (type.includes('json') || type.startsWith('text/')) throw new HttpError(502, 'NovelAI 未返回有效的 Vibe 编码。');
    return json(res, 200, { encoding: raw.toString('base64') });
  }
  let images;
  try { images = decodeImages(raw, type); } catch (error) { throw imageResponseError(error, raw, type, connection.service); }
  if (operation === 'generate-image' && images.length !== (body.parameters.n_samples ?? 1)) throw new HttpError(502, connection.service + '返回的样本数量不完整，请检查账户用量。');
  json(res, 200, { images, seed: images[0].seed ?? body.parameters?.seed });
}
