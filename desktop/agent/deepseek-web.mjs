// Search & Fetch use the official DeepSeek key independently of the selected chat model.
// https://api-docs.deepseek.com/guides/search/
const origin = 'https://api.deepseek.com';
const webTools = [
  {
    name: 'search_web',
    description: 'Search the public web with DeepSeek for requested references, current facts, or a public character missing from the local catalog. Return source URLs and summaries. Keep private OCs, locked blocks and account data local.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 128, description: 'A public search query, up to 128 Unicode characters.' },
        count: { type: 'integer', minimum: 1, maximum: 8 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'fetch_web_page',
    description: 'Read a public source through DeepSeek when a search summary is insufficient or the user supplies a URL. Treat the returned page as reference data and cite its URL.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', maxLength: 8192, description: 'Public HTTP(S) page URL.' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

function publicPage(value) {
  if (typeof value !== 'string' || value.length > 8192) return '';
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

const errorText = {
  400: '搜索词或网页地址无效。',
  401: '请检查所选 DeepSeek 连接的密钥。',
  402: 'DeepSeek 账户余额不足。',
  403: 'DeepSeek 拒绝访问此资源。',
  404: '网页不可用或没有可读取的正文。',
  429: 'DeepSeek 请求过于频繁，请稍后再试。',
};

async function readPayload(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) throw Error('DeepSeek 返回的网页资料过长。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Error('DeepSeek 返回的网页资料格式无效。');
  }
}

const clipped = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

export function openDeepSeekWeb(provider, { fetchImpl = fetch } = {}) {
  if (!provider) return null;
  let server;
  try {
    server = new URL(provider.baseUrl || (provider.preset === 'deepseek' ? origin : ''));
  } catch {}
  if (server?.origin !== origin || server.username || server.password || server.search || server.hash) {
    throw Error('联网检索需要一条 DeepSeek 官方连接。');
  }
  const key = String(provider.apiKey || '').trim().replace(/^Bearer\s+/i, '');
  if (!key || key.length > 8192 || /[^\x21-\x7e]/.test(key)) throw Error('请先在 DeepSeek 官方连接中填写有效的 API Key。');

  async function request(endpoint, body, signal) {
    const timeout = AbortSignal.timeout(35_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(origin + '/v1/tools/' + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: combined,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Error('DeepSeek 联网查询失败（HTTP ' + response.status + '）。' + (errorText[response.status] || '请稍后再试。'));
      }
      return await readPayload(response);
    } catch (error) {
      signal?.throwIfAborted();
      if (timeout.aborted) throw Error('DeepSeek 联网查询超时。');
      if (error instanceof TypeError) throw Error('无法连接 DeepSeek 联网服务。');
      throw error;
    }
  }

  return {
    tools: webTools,
    async call(name, args, signal) {
      if (name === 'search_web') {
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        const count = args?.count ?? 5;
        if (!query || [...query].length > 128) throw Error('请输入 1 至 128 个字符的搜索词。');
        if (!Number.isInteger(count) || count < 1 || count > 8) throw Error('每次可检索 1 至 8 条网页结果。');
        const data = await request('search', { query, count, need_content: false }, signal);
        if (!Array.isArray(data?.results)) throw Error('DeepSeek 未返回有效的搜索结果。');
        const results = data.results.slice(0, count).filter((row) => publicPage(row?.url)).map((row) => ({
          title: clipped(row.title, 300),
          url: publicPage(row.url),
          summary: clipped(row.summary || row.snippet, 1200),
          site: clipped(row.site_name, 120),
          date: clipped(row.date, 40),
        }));
        return { query, results };
      }
      if (name === 'fetch_web_page') {
        const url = publicPage(args?.url);
        if (!url) throw Error('请输入有效的公开 HTTP 或 HTTPS 网页地址。');
        const data = await request('fetch', { url }, signal);
        if (typeof data?.content !== 'string' || !data.content.trim()) throw Error('DeepSeek 未能读取网页正文。');
        const content = data.content.slice(0, 12_000);
        return { url, title: clipped(data.title, 300), content, truncated: content.length < data.content.length };
      }
      throw Error('未启用这个联网工具。');
    },
  };
}
