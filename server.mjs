import http from 'node:http';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { handleApi, json } from './server/novelai.mjs';

const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.gz': 'application/gzip', '.wasm': 'application/wasm', '.csv': 'text/csv; charset=utf-8',
};

function insidePublic(filename) {
  const relative = path.relative(publicDir, filename);
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

async function serveFile(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '静态文件仅支持读取。' });
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return json(res, 400, { error: '文件地址无效。' }); }
  if (/[\\:\x00]/.test(decoded) || decoded.split('/').some(part => part.startsWith('.'))) return json(res, 404, { error: '找不到文件。' });
  const filename = path.resolve(publicDir, '.' + (decoded === '/' ? '/index.html' : decoded));
  if (!insidePublic(filename)) return json(res, 404, { error: '找不到文件。' });
  let actual, info;
  try {
    actual = await realpath(filename);
    if (!insidePublic(actual)) throw new Error();
    info = await stat(actual);
    if (!info.isFile()) throw new Error();
  } catch { return json(res, 404, { error: '找不到文件。' }); }
  const etag = '"' + info.size.toString(16) + '-' + Math.trunc(info.mtimeMs).toString(16) + '"';
  const headers = { 'Content-Type': contentTypes[path.extname(actual).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-cache', 'ETag': etag };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  res.writeHead(200, { ...headers, 'Content-Length': info.size });
  if (req.method === 'HEAD') return res.end();
  await pipeline(createReadStream(actual), res);
}

export function createFolioServer({ upstreamFetch = fetch } = {}) {
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    try {
      const host = req.headers.host || '';
      const port = req.socket.localPort;
      if (![ '127.0.0.1:' + port, 'localhost:' + port, ...(port === 80 ? ['127.0.0.1', 'localhost'] : []) ].includes(host.toLowerCase()))
        return json(res, 403, { error: '工作台仅接受本机连接。' });
      const origin = 'http://' + host;
      const url = new URL(req.url, origin);
      if (url.origin !== origin.toLowerCase() && !(port === 80 && url.host === host.split(':')[0])) return json(res, 403, { error: '地址无效。' });
      if (url.pathname.startsWith('/api/')) {
        if ((req.headers.origin && req.headers.origin !== url.origin) || req.headers['sec-fetch-site'] === 'cross-site')
          return json(res, 403, { error: '请从本机工作台提交请求。' });
        return await handleApi(req, res, url, upstreamFetch);
      }
      await serveFile(req, res, url.pathname);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.destroy();
      json(res, error.status || 502, { error: error.status ? error.message : '请求中断或 NovelAI 响应异常，请检查网络后再试。' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 4389);
  const server = createFolioServer();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? '端口 ' + port + ' 正在使用，请打开现有工作台或设置 PORT 后重启。' : '本地工作台启动失败：' + error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => console.log('NAI Folio   http://127.0.0.1:' + server.address().port));
}
