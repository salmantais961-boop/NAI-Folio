import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { discoverFiles, describeSkill, readSkill } from './plugin-files.mjs';
import { connectMcp } from './plugin-mcp.mjs';

const piHost = fileURLToPath(new URL('./pi-tool-host.mjs', import.meta.url));
const namespace = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');
const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 10);

function toolName(prefix, label, taken) {
  const base = prefix + '__' + namespace(label);
  if (base.length <= 64 && !taken.has(base)) return base;
  return base.slice(0, 53) + '_' + hash(prefix + '::' + label);
}

// Honor Pi's exact-name and first-match wildcard rules. Only direct tools are advertised.
function exposesTool(config, name) {
  const rules = config.toolExposure || {};
  if (typeof rules !== 'object' || Array.isArray(rules)) throw Error('toolExposure 的格式有误。');
  let exposure = config.exposure || 'direct';
  if (Object.hasOwn(rules, name)) exposure = rules[name];
  else {
    for (const [pattern, value] of Object.entries(rules)) {
      if (!pattern.includes('*')) continue;
      const regex = pattern
        .split('*')
        .map((s) => s.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, '\\$&'))
        .join('.*');
      if (new RegExp('^' + regex + '$', 'u').test(name)) {
        exposure = value;
        break;
      }
    }
  }
  if (!['direct', 'hidden'].includes(exposure)) throw Error('Folio 工具支持 direct 或 hidden 可见性。');
  return exposure === 'direct';
}

function localRoots(values, label) {
  if (values === undefined) return [];
  if (
    !Array.isArray(values) ||
    values.length > 64 ||
    values.some((s) => typeof s !== 'string' || !s.trim() || s.length > 4096)
  )
    throw Error(label + '应为本地路径列表（最多 64 项）。');
  return [...new Set(values)];
}

// Display diagnostics without reflecting credentials, upstream bodies or process output.
function diagnostic(error) {
  if (error?.name === 'TimeoutError') return '连接超时，请检查插件是否已安装并能独立启动。';
  if (error?.code === 'ENOENT') return '找不到所选路径或可执行文件。';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return '无法访问所选文件。';
  if (error?.name === 'SyntaxError') return '插件清单或 MCP 响应不是有效的 JSON。';
  if (error?.name === 'TypeError') return '连接或配置无效，请检查服务地址及配置格式。';
  if (
    typeof error?.message === 'string' &&
    /^[\p{Script=Han}A-Za-z0-9 /。：，、或（）、.。~_+-]+$/u.test(error.message)
  )
    return error.message.slice(0, 180);
  return '插件未能加载或执行。请检查本机插件配置。';
}

export async function openPlugins(config = {}, { signal } = {}) {
  signal?.throwIfAborted();
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('插件配置应为 JSON 对象。');
  const skillPaths = localRoots(config.skillPaths, 'Skills');
  const extensionPaths = localRoots(config.extensionPaths, 'Pi 扩展');
  const servers = config.mcpServers ?? {};
  if (typeof servers !== 'object' || !servers || Array.isArray(servers) || Object.keys(servers).length > 24)
    throw Error('mcpServers 应为按服务名索引的对象（最多 24 个）。');
  const clients = [],
    skills = new Map(),
    handlers = new Map(),
    tools = [],
    issues = [];
  const report = (source, e) => {
    signal?.throwIfAborted();
    issues.push({ source, message: diagnostic(e) });
  };
  const connected = [];
  async function registerServer(source, prefix, settings) {
    let client;
    try {
      client = await connectMcp(settings, { signal });
      const staged = [];
      const reserved = new Set(handlers.keys()),
        seen = new Set();
      for (const tool of client.tools) {
        if (
          typeof tool.name !== 'string' ||
          !tool.name ||
          seen.has(tool.name) ||
          !tool.inputSchema ||
          tool.inputSchema.type !== 'object'
        )
          throw Error('工具定义中有重复名称或无效参数。');
        seen.add(tool.name);
        if (!exposesTool(settings, tool.name)) continue;
        const name = toolName(prefix, tool.name, reserved);
        if (reserved.has(name)) throw Error('工具名称冲突。');
        reserved.add(name);
        staged.push({
          name,
          description: String(tool.description || tool.name).slice(0, 4096),
          inputSchema: tool.inputSchema,
          upstream: tool.name,
        });
      }
      for (const { upstream, ...spec } of staged) {
        tools.push(spec);
        handlers.set(spec.name, (args, callSignal) =>
          client.request('tools/call', { name: upstream, arguments: args }, callSignal),
        );
      }
      clients.push(client);
      connected.push({ source, tools: staged.length });
    } catch (e) {
      await client?.close();
      report(source, e);
    }
  }
  try {
    for (const source of skillPaths) {
      signal?.throwIfAborted();
      try {
        const files = await discoverFiles(source, 'skills');
        if (!files.length) throw Error('目录内没有找到 SKILL.md。');
        for (const f of files) {
          try {
            const skill = await describeSkill(f);
            if (skill.manual) continue;
            if (skills.has(skill.name)) {
              if (skills.get(skill.name).filename !== f) throw Error('技能名称重复。');
            } else if (skills.size >= 256) throw Error('已达到 256 个技能上限。');
            else skills.set(skill.name, skill);
          } catch (e) {
            report(path.basename(path.dirname(f)), e);
          }
        }
      } catch (e) {
        report(path.basename(source) || 'Skills', e);
      }
    }
    if (skills.size) {
      tools.push({
        name: 'read_skill',
        description: '按需阅读已启用的技能。可用 file 读取同一技能目录内的参考文档，用 offset 分页。',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', enum: [...skills.keys()] },
            file: { type: 'string' },
            offset: { type: 'integer', minimum: 0 },
          },
          required: ['name'],
          additionalProperties: false,
        },
      });
      handlers.set('read_skill', (args) => {
        const skill = skills.get(args.name);
        if (!skill) throw Error('未找到这个已启用的技能。');
        return readSkill(skill, args.file, args.offset);
      });
    }
    const extSet = new Set();
    for (const root of extensionPaths) {
      try {
        const files = await discoverFiles(root, 'extensions');
        if (!files.length) throw Error('没有找到 Pi 工具扩展入口。');
        for (const filename of files) extSet.add(filename);
      } catch (e) {
        report(path.basename(root) || 'Pi', e);
      }
    }
    if (extSet.size > 32) throw Error('请选择更精确的扩展目录，最多启用 32 个扩展。');
    const jobs = [];
    for (const filename of extSet) {
      const label = path.basename(filename, path.extname(filename));
      const id = label === 'index' ? path.basename(path.dirname(filename)) : label;
      jobs.push([
        id,
        'pi__' + namespace(id) + '_' + hash(filename),
        { command: process.execPath, args: [piHost, filename], cwd: path.dirname(filename) },
      ]);
    }
    const aliases = new Set();
    for (const [alias, settings] of Object.entries(servers)) {
      if (settings?.enabled === false) continue;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(alias) || aliases.has(namespace(alias))) {
        report('MCP', Error('服务名称无效或重复。'));
        continue;
      }
      aliases.add(namespace(alias));
      jobs.push([alias, 'mcp__' + namespace(alias), settings]);
    }
    // Bound concurrent local processes/handshakes. A failed endpoint is isolated.
    for (let i = 0; i < jobs.length; i += 4) {
      const result = await Promise.allSettled(
        jobs.slice(i, i + 4).map(([source, prefix, settings]) => registerServer(source, prefix, settings)),
      );
      const failed = result.find((r) => r.status === 'rejected');
      if (failed) throw failed.reason;
    }
    signal?.throwIfAborted();
    return {
      skills: [...skills.values()].map(({ name, description }) => ({ name, description })),
      tools,
      issues,
      connected,
      async call(name, args = {}, options = {}) {
        const fn = handlers.get(name);
        if (!fn) throw Error('工具未启用或已关闭。');
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('工具参数应为 JSON 对象。');
        signal?.throwIfAborted();
        options.signal?.throwIfAborted();
        const result = await fn(args, options.signal);
        if (!Array.isArray(result?.content)) throw Error('工具返回的内容格式无效。');
        return {
          content: result.content,
          isError: result.isError === true,
          ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        };
      },
      async close() {
        handlers.clear();
        await Promise.allSettled(clients.map((c) => c.close()));
      },
    };
  } catch (e) {
    await Promise.allSettled(clients.map((c) => c.close()));
    throw e;
  }
}
