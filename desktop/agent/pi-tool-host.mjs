// A trusted Pi tool extension runs outside the bridge. This adapter speaks
// stdio MCP to share Folio's cancellation, discovery and lifetime management.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { format } from 'node:util';

const filename = process.argv[2];
const tools = new Map(),
  active = new Map();
const output = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
for (const key of ['log', 'info', 'debug', 'warn', 'error'])
  console[key] = (...args) => process.stderr.write(format(...args) + '\n');
const hooks = new Map();
const ctx = (signal) => ({
  cwd: dirname(filename),
  hasUI: false,
  mode: 'sdk',
  signal,
  isProjectTrusted: () => true,
});
async function emit(type, signal) {
  for (const handler of hooks.get(type) || [])
    await handler({ type, reason: type === 'session_start' ? 'startup' : 'quit' }, ctx(signal));
}
let start;
async function initialize() {
  const exports = await import(pathToFileURL(filename).href);
  const activate = typeof exports.default === 'function' ? exports.default : exports.default?.default;
  if (typeof activate !== 'function') throw Error('Pi extension must export a default factory');
  await activate({
    registerTool(tool) {
      if (
        !tool ||
        typeof tool.name !== 'string' ||
        !tool.name ||
        typeof tool.execute !== 'function' ||
        !tool.parameters ||
        tools.has(tool.name)
      )
        throw Error('Invalid Pi tool definition');
      tools.set(tool.name, tool);
    },
    on(event, fn) {
      if (!['session_start', 'session_shutdown'].includes(event))
        throw Error('Unsupported Pi extension event: ' + event);
      if (typeof fn !== 'function') throw Error('Invalid extension handler');
      if (!hooks.has(event)) hooks.set(event, []);
      hooks.get(event).push(fn);
    },
  });
  await emit('session_start');
}
async function dispatch({ method, params, id }) {
  if (method === 'initialize') {
    await (start ??= initialize());
    return {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'folio-pi-tool-host', version: '1.0' },
    };
  }
  if (method === 'tools/list')
    return {
      tools: [...tools.values()].map((t) => ({
        name: t.name,
        description: t.description || t.label || t.name,
        inputSchema: t.parameters,
      })),
    };
  if (method === 'ping') return {};
  if (method !== 'tools/call') throw Error('Unknown request');
  const tool = tools.get(params.name);
  if (!tool) throw Error('Unknown tool');
  const call = new AbortController();
  active.set(id, call);
  try {
    const result = await tool.execute(
      String(id),
      params.arguments || {},
      call.signal,
      () => {},
      ctx(call.signal),
    );
    if (!result || !Array.isArray(result.content)) throw Error('Pi tool must return content');
    return {
      content: result.content,
      ...(result.details !== undefined ? { structuredContent: { details: result.details } } : {}),
      isError: result.isError === true,
    };
  } finally {
    active.delete(id);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
    if (msg.method === 'notifications/cancelled') {
      active.get(msg.params?.requestId)?.abort();
      return;
    }
    if (msg.id === undefined) return;
    output({ id: msg.id, result: await dispatch(msg) });
  } catch {
    if (msg?.id !== undefined)
      output({ id: msg.id, error: { code: -32603, message: 'Pi extension operation failed' } });
  }
});
input.on('close', async () => {
  for (const call of active.values()) call.abort();
  try {
    await emit('session_shutdown');
  } finally {
    process.exit(0);
  }
});
