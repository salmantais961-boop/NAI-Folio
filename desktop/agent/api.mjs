import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chat, listModels, normalizeProvider, PROVIDER_PRESETS, testConnection } from './providers.mjs';
import { openPlugins } from './plugins.mjs';
import { openDeepSeekWeb } from './deepseek-web.mjs';
const webTagGuide = fileURLToPath(new URL('./skills/folio-web-tags/SKILL.md', import.meta.url));
const scopes = new Map();

async function bodyOf(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error('对话上下文过长，请新建对话或缩短插件结果。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求正文必须是 JSON。');
  }
}

async function closeScope(id) {
  const scope = scopes.get(id);
  if (!scope) return;
  scopes.delete(id);
  clearTimeout(scope.timer);
  scope.controller.abort();
  await scope.plugins.close();
}

function touchScope(id) {
  const scope = scopes.get(id);
  if (!scope) throw new Error('这轮插件会话已结束，请重新发送。');
  clearTimeout(scope.timer);
  scope.timer = setTimeout(() => void closeScope(id).catch(() => {}), 10 * 60_000).unref();
  return scope;
}

function describe(plugins) {
  return { skills: plugins.skills, tools: plugins.tools, issues: plugins.issues };
}

export async function handleAgent(request, response, url, lifetime, json) {
  if (url.pathname === '/api/agent-presets' && request.method === 'GET')
    return json(response, 200, { presets: PROVIDER_PRESETS });
  if (request.method !== 'POST') return json(response, 405, { error: '此操作需要 POST 请求。' });
  const client = new AbortController();
  response.once('close', () => {
    if (!response.writableEnded) client.abort();
  });
  const signal = AbortSignal.any([lifetime, client.signal]);
  try {
    const body = await bodyOf(request);
    signal.throwIfAborted();
    let result;
    switch (url.pathname) {
      case '/api/agent-normalize': {
        const { baseUrl, protocol, exactRoot } = normalizeProvider(body.provider);
        result = { baseUrl, protocol, exactRoot };
        break;
      }
      case '/api/agent-models':
        result = { models: await listModels(body.provider, { signal }) };
        break;
      case '/api/agent-test':
        result = await testConnection(body.provider, { signal });
        break;
      case '/api/agent-chat':
        if (body.sessionId) touchScope(body.sessionId);
        result = await chat(body.provider, {
          system: body.system,
          messages: body.messages,
          tools: body.tools,
          reasoningEffort: body.reasoningEffort,
          signal,
          maxTokens: 2800,
        });
        break;
      case '/api/agent-plugins':
      case '/api/agent-open': {
        if (scopes.size >= 8) throw new Error('同时运行的 Agent 会话过多，请先停止一轮。');
        const config = body.plugins || {};
        const controller = new AbortController();
        const pluginSignal = AbortSignal.any([signal, controller.signal]);
        let web, webIssue;
        if (config.webSearch?.enabled !== false && body.webSearchProvider) {
          try {
            web = openDeepSeekWeb(body.webSearchProvider);
          } catch (error) {
            webIssue = { source: 'DeepSeek 联网检索', message: error.message };
          }
        }
        const plugins = await openPlugins(
          web ? { ...config, skillPaths: [webTagGuide, ...(config.skillPaths || [])] } : config,
          { signal: pluginSignal },
        );
        if (signal.aborted) {
          await plugins.close();
          signal.throwIfAborted();
        }
        result = describe(plugins);
        if (web) result.tools = [...result.tools, ...web.tools];
        if (webIssue) result.issues = [...result.issues, webIssue];
        if (url.pathname === '/api/agent-open') {
          const id = randomUUID();
          scopes.set(id, { plugins, web, controller, timer: null });
          touchScope(id);
          result = { ...result, sessionId: id };
        } else await plugins.close();
        break;
      }
      case '/api/agent-call': {
        const scope = touchScope(body.sessionId);
        const callSignal = AbortSignal.any([signal, scope.controller.signal]);
        if (scope.web?.tools.some((tool) => tool.name === body.name)) {
          result = await scope.web.call(body.name, body.arguments || {}, callSignal);
        } else {
          result = await scope.plugins.call(body.name, body.arguments || {}, { signal: callSignal });
        }
        break;
      }
      case '/api/agent-close':
        await closeScope(body.sessionId);
        result = { ok: true };
        break;
      default:
        return json(response, 404, { error: '没有这个 Agent 接口。' });
    }
    if (!signal.aborted && !response.destroyed) json(response, 200, result);
  } catch (error) {
    if (!signal.aborted && !response.destroyed)
      json(response, 400, { error: error.message || 'Agent 请求未完成。' });
  }
}

export async function closeAgentSessions() {
  await Promise.allSettled([...scopes.keys()].map(closeScope));
}
