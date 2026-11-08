import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const VERSION = '2025-11-25';
const versions = new Set([VERSION, '2025-06-18', '2025-03-26', '2024-11-05']);
const lineSeparator = /\r?\n/;
const closed = () => Error('MCP 连接已关闭。');
const abortReason = (signal) => (signal?.reason instanceof Error ? signal.reason : Error('调用已取消。'));

function expandHome(value) {
  return /^~[/\\]/.test(value) ? path.resolve(homedir(), value.slice(2)) : value;
}

function stringMap(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('插件环境变量或请求头格式有误。');
  return Object.fromEntries(
    Object.entries(value).map(([key, raw]) => {
      if (typeof raw !== 'string' || !key || /[\r\n\0]/.test(key) || raw.includes('\0'))
        throw Error('配置项必须是字符串。');
      const text = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
        if (process.env[name] === undefined) throw Error('配置引用了未设置的环境变量。');
        return process.env[name];
      });
      return [key, text];
    }),
  );
}

function childEnvironment(custom) {
  const keys =
    /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|LANG|LC_[A-Z_]+)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => keys.test(k)));
  return Object.assign(env, stringMap(custom));
}

// Windows does not spawn npm's .cmd shim without a shell. Launch its JS entry
// with the bundled Node runtime so arguments stay literal, including spaces.
function commandLine(config, env) {
  if (typeof config.command !== 'string' || !config.command.trim() || config.command.includes('\0'))
    throw Error('请填写 MCP 可执行文件和独立的参数列表。');
  const cmd = expandHome(config.command.trim());
  if (
    config.args !== undefined &&
    (!Array.isArray(config.args) || config.args.some((s) => typeof s !== 'string' || s.includes('\0')))
  )
    throw Error('MCP 的 args 应为字符串数组。');
  const args = (config.args || []).map(expandHome);
  if (process.platform === 'win32' && /^(?:npx|npm)(?:\.cmd)?$/i.test(path.basename(cmd))) {
    const base = path.basename(cmd, '.cmd').toLowerCase();
    const entryName = base.startsWith('npx') ? 'npx-cli.js' : 'npm-cli.js';
    const envPath = Object.entries(env).find(([k]) => k.toLowerCase() === 'path')?.[1] || '';
    const dirs = path.isAbsolute(cmd)
      ? [path.dirname(cmd)]
      : [path.dirname(process.execPath), ...envPath.split(path.delimiter).filter(Boolean)];
    const entry = dirs.map((d) => path.join(d, 'node_modules', 'npm', 'bin', entryName)).find(existsSync);
    if (!entry) throw Error('未找到 npm 的本机安装。请填写实际可执行文件路径。');
    return [process.execPath, [entry, ...args]];
  }
  return [cmd, args];
}

function stdioTransport(config) {
  const env = childEnvironment(config.env);
  const [command, args] = commandLine(config, env);
  const child = spawn(command, args, {
    cwd: config.cwd ? expandHome(config.cwd) : undefined,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const exited = new Promise((resolve) => child.once('close', resolve));
  const waiting = new Map();
  let buffer = '',
    ended = false;
  function finish() {
    if (ended) return;
    ended = true;
    for (const slot of waiting.values()) slot.reject(closed());
    waiting.clear();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      const timer = setTimeout(() => child.kill('SIGKILL'), 350);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    }
  }
  function write(msg) {
    if (ended) throw closed();
    child.stdin.write(JSON.stringify(msg) + '\n', (err) => {
      if (err) finish();
    });
  }
  child.on('error', finish);
  child.on('exit', finish);
  child.stdin.on('error', finish);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let split;
    while ((split = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, split).trim();
      buffer = buffer.slice(split + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
        finish();
        return;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        finish();
        return;
      }
      if (!msg || msg.jsonrpc !== '2.0') continue;
      if (typeof msg.method === 'string' && msg.id !== undefined) {
        try {
          write(
            msg.method === 'ping'
              ? { jsonrpc: '2.0', id: msg.id, result: {} }
              : {
                  jsonrpc: '2.0',
                  id: msg.id,
                  error: { code: -32601, message: 'Client capability unavailable' },
                },
          );
        } catch {
          finish();
        }
      } else if (msg.id !== undefined) waiting.get(msg.id)?.resolve(msg);
    }
    if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) finish();
  });
  return {
    async send(msg, signal) {
      signal.throwIfAborted();
      if (msg.id === undefined) {
        write(msg);
        return;
      }
      let onAbort;
      try {
        return await new Promise((resolve, reject) => {
          onAbort = () => {
            if (!ended && msg.method !== 'initialize') {
              try {
                write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: msg.id } });
              } catch {}
            }
            reject(abortReason(signal));
          };
          waiting.set(msg.id, { resolve, reject });
          signal.addEventListener('abort', onAbort, { once: true });
          write(msg);
        });
      } finally {
        signal.removeEventListener('abort', onAbort);
        waiting.delete(msg.id);
      }
    },
    async close() {
      finish();
      await exited;
    },
  };
}

async function httpReply(response, id) {
  const isEvents = response.headers.get('content-type')?.split(';')[0].trim() === 'text/event-stream';
  const reader = response.body?.getReader();
  if (!reader) throw Error('MCP 返回了空响应。');
  const decoder = new TextDecoder();
  let buffer = '',
    bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      bytes += value?.byteLength || 0;
      if (bytes > MAX_MESSAGE_BYTES) throw Error('MCP 返回的数据过大。');
      buffer += decoder.decode(value, { stream: !done });
      if (isEvents) {
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const data = frame
            .split(lineSeparator)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
          if (!data) continue;
          const msg = JSON.parse(data);
          if (msg.id === id && !msg.method) return msg;
        }
      }
      if (done) break;
    }
    if (!isEvents) return JSON.parse(buffer);
    throw Error('MCP 事件流在返回结果前结束。');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function httpTransport(config) {
  const url = new URL(config.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    throw Error('请填写有效的 MCP HTTP 地址。');
  const custom = stringMap(config.headers);
  for (const k of Object.keys(custom)) {
    if (
      /^(host|content-length|transfer-encoding|connection|mcp-session-id|mcp-protocol-version|content-type|accept)$/i.test(
        k,
      )
    )
      throw Error('MCP 请求头与传输协议冲突。');
  }
  let session, version;
  function headers() {
    return {
      ...custom,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(session ? { 'Mcp-Session-Id': session } : {}),
      ...(version ? { 'MCP-Protocol-Version': version } : {}),
    };
  }
  return {
    async send(msg, signal) {
      const response = await fetch(url, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(msg),
        signal,
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Error('MCP 服务返回 HTTP ' + response.status + '。');
      }
      if (msg.id === undefined) {
        await response.body?.cancel();
        return;
      }
      const reply = await httpReply(response, msg.id);
      if (msg.method === 'initialize') {
        session = response.headers.get('mcp-session-id');
        version = reply.result?.protocolVersion;
      }
      return reply;
    },
    async close() {
      if (!session) return;
      const h = headers();
      session = null;
      try {
        const res = await fetch(url, {
          method: 'DELETE',
          headers: h,
          redirect: 'error',
          signal: AbortSignal.timeout(1200),
        });
        await res.body?.cancel();
      } catch {}
    },
  };
}

export async function connectMcp(config, { signal } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('MCP 配置格式有误。');
  const isHttp = typeof config.url === 'string';
  if (
    Boolean(config.command) === isHttp ||
    (config.type && !(isHttp ? ['http', 'streamable-http'] : ['stdio']).includes(config.type))
  )
    throw Error('请选择 stdio 或 Streamable HTTP，并提供对应的 command 或 url。');
  signal?.throwIfAborted();
  const transport = isHttp ? httpTransport(config) : stdioTransport(config);
  const lifetime = new AbortController();
  const timeoutMs =
    config.timeout === undefined ? 60_000 : Math.min(600, Math.max(1, Number(config.timeout) || 60)) * 1000;
  let sequence = 0;
  async function request(method, params, callSignal, timeout = timeoutMs) {
    const signals = [lifetime.signal, AbortSignal.timeout(timeout), signal, callSignal].filter(Boolean);
    const combined = AbortSignal.any(signals);
    const id = ++sequence;
    let reply;
    try {
      reply = await transport.send({ jsonrpc: '2.0', id, method, params }, combined);
    } catch (e) {
      if (combined.aborted) throw abortReason(combined);
      throw e;
    }
    if (reply?.jsonrpc !== '2.0' || reply.id !== id || !Object.hasOwn(reply, 'result') || reply.error)
      throw Error(
        'MCP 请求失败（' +
          method +
          (Number.isInteger(reply?.error?.code) ? ' · ' + reply.error.code : '') +
          '）。',
      );
    return reply.result;
  }
  let closing;
  function close() {
    if (!closing) {
      lifetime.abort();
      signal?.removeEventListener('abort', close);
      closing = Promise.resolve(transport.close());
    }
    return closing;
  }
  signal?.addEventListener('abort', close, { once: true });
  async function list(kind) {
    const rows = [],
      cursors = new Set();
    let cursor;
    do {
      const page = await request(
        kind + '/list',
        cursor ? { cursor } : {},
        undefined,
        Math.min(timeoutMs, 15_000),
      );
      if (!Array.isArray(page?.[kind])) throw Error('MCP 工具目录格式有误。');
      rows.push(...page[kind]);
      cursor = page.nextCursor;
      if (rows.length > 512 || cursors.size >= 64 || (cursor && cursors.has(cursor)))
        throw Error('MCP 工具目录过大或分页重复。');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return rows;
  }
  try {
    const ready = await request(
      'initialize',
      { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'folio-agent', version: '1.0' } },
      undefined,
      Math.min(timeoutMs, 15_000),
    );
    if (!versions.has(ready?.protocolVersion)) throw Error('MCP 服务器的协议版本不兼容。');
    await transport.send(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(Math.min(timeoutMs, 15_000))]),
    );
    const tools = ready.capabilities?.tools ? await list('tools') : [];
    return { tools, request, close };
  } catch (e) {
    await close();
    throw e;
  }
}
