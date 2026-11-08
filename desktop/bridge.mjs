// In the desktop bundle this entry sits beside the existing server/ modules.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';
import { handleApi, json } from './server/novelai.mjs';

const origins = new Set(['http://tauri.localhost', 'https://tauri.localhost']);
const tokenHeader = 'x-folio-desktop';
const allowedHeaders = new Set([
  tokenHeader, 'authorization', 'content-type', 'accept', 'cache-control', 'pragma',
  'x-nai-provider', 'x-nai-image-base', 'x-nai-account-base',
]);

function acceptsToken(value, expected) {
  if (typeof value !== 'string' || value.length !== expected.length) return false;
  const offered = Buffer.from(value);
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

function preflight(req, res) {
  const method = req.headers['access-control-request-method'];
  const headers = String(req.headers['access-control-request-headers'] || '')
    .toLowerCase().split(',').map(header => header.trim()).filter(Boolean);
  if (!['GET', 'POST'].includes(method) || !headers.includes(tokenHeader) ||
      headers.some(header => !allowedHeaders.has(header))) {
    return json(res, 403, { error: '桌面请求未获授权。' });
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', [...allowedHeaders].join(', '));
  if (req.headers['access-control-request-private-network'] === 'true')
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '600');
  res.writeHead(204);
  res.end();
}

function startBridge(token, signal) {
  const expected = Buffer.from(token);
  // The desktop account picker owns its credentials. An environment key for a
  // separate web-server installation must not become the desktop default.
  delete process.env.NOVELAI_TOKEN;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const host = '127.0.0.1:' + req.socket.localPort;
      const origin = req.headers.origin;
      if (req.headers.host !== host || !origins.has(origin))
        return json(res, 403, { error: '仅接受本机桌面窗口的请求。' });
      if (!/^\/api\/[a-z-]+(?:\?|$)/.test(req.url))
        return json(res, 404, { error: '没有这个接口。' });
      res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
      res.setHeader('Access-Control-Allow-Origin', origin);
      if (req.method === 'OPTIONS') return preflight(req, res);
      if (!acceptsToken(req.headers[tokenHeader], expected))
        return json(res, 403, { error: '桌面会话已失效，请重新打开 Folio。' });
      const url = new URL(req.url, 'http://' + host);
      if (url.pathname.startsWith('/api/agent-')) {
        agentApi ??= import('./agent/api.mjs');
        return await (await agentApi).handleAgent(req, res, url, signal, json);
      }
      await handleApi(req, res, url);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.destroy();
      json(res, error.status || 502, { error: error.status ? error.message : '桌面服务未能完成请求，请检查连接。' });
    }
  });
  server.once('error', () => process.exit(1));
  server.listen({ port: 0, host: '127.0.0.1', signal }, () => {
    process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n');
  });
  return server;
}

// The pipe doubles as a lifetime lease. EOF also terminates a long-lived
// stream when the parent crashes, without waiting for an upstream timeout.
const lifetime = new AbortController();
let server;
let agentApi;
function shutdown() {
  if (lifetime.signal.aborted) return;
  lifetime.abort();
  void agentApi?.then(api => api.closeAgentSessions()).catch(() => {});
  // Destroy client streams first. The shared handler observes their close
  // event and aborts any active upstream request before Node releases libuv.
  server?.closeAllConnections();
  setTimeout(() => process.exit(0), 2000).unref();
}
process.stdin.once('end', shutdown);
process.stdin.once('error', shutdown);
process.stdout.once('error', shutdown);
createInterface({ input: process.stdin, crlfDelay: Infinity }).once('line', token => {
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(token)) process.exit(1);
  server = startBridge(token, lifetime.signal);
});
