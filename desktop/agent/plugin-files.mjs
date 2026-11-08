import { open, realpath, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

const MAX_SKILL_BYTES = 512 * 1024;
const MAX_PAGE = 16_000;
const scriptSuffix = /\.(?:[cm]?js|[cm]?ts)$/i;
const textSuffix = /\.(?:md|txt|json|ya?ml|csv|toml)$/i;

export function userPath(value) {
  if (typeof value !== 'string' || !value.trim()) throw Error('请填写本地路径。');
  const input = value.trim();
  if (/^~[/\\]/.test(input)) return path.resolve(homedir(), input.slice(2));
  if (!path.isAbsolute(input)) throw Error('请使用绝对路径或 ~/ 开头的路径。');
  return path.resolve(input);
}

function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function readText(filename, limit) {
  const handle = await open(filename, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw Error('文件过大或不是普通文件。');
    return (await handle.readFile('utf8')).replace(/^\uFEFF/, '');
  } finally {
    await handle.close();
  }
}

async function present(filename) {
  try {
    return await stat(filename);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

// Only top-level scalar fields are consumed. Nested metadata and executable fields are inert.
function frontmatter(source) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) throw Error('SKILL.md 缺少 YAML 文件头。');
  const lines = match[1].split(/\r?\n/);
  const fields = {};
  for (let i = 0; i < lines.length; i++) {
    const field = /^(name|description|disable-model-invocation):\s*(.*)$/.exec(lines[i]);
    if (!field) continue;
    let value = field[2].trim();
    const continuation = [];
    while (i + 1 < lines.length && /^(?:\s|$)/.test(lines[i + 1])) continuation.push(lines[++i].trim());
    if (/^[|>][+-]?$/.test(value)) value = continuation.join(' ');
    else if (continuation.length) value = [value, ...continuation].join(' ').trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replaceAll("''", "'");
    } else value = value.replace(/\s+#.*$/, '');
    fields[field[1]] = value.trim();
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name || '') || fields.name.length > 64)
    throw Error('技能名称需为小写英文、数字或短横线。');
  if (!fields.description) throw Error('SKILL.md 缺少 description。');
  return {
    name: fields.name,
    description: fields.description.slice(0, 1024),
    manual: fields['disable-model-invocation'] === 'true',
    body: source.slice(match[0].length),
  };
}

const ignored = (name) => name.startsWith('.') || name === 'node_modules' || name === '__pycache__';
async function walk(dir, visit, state, depth = 0) {
  if (depth > 12 || state.count++ >= 4096) throw Error('目录过大，请选择更具体的插件目录。');
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored(entry.name) || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile()) await visit(full);
    else if (entry.isDirectory()) await walk(full, visit, state, depth + 1);
  }
}

function patternsMatch(rel, patterns) {
  const parts = rel.split('/');
  // A declared directory includes its descendants. Glob matching uses package-relative paths.
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  const matches = (pattern) => {
    const clean = pattern.replace(/^\.\/+/, '').replace(/\/+$/, '');
    return candidates.some((candidate) => path.posix.matchesGlob(candidate, clean));
  };
  return (
    patterns.some((p) => !p.startsWith('!') && matches(p)) &&
    !patterns.some((p) => p.startsWith('!') && matches(p.slice(1)))
  );
}

export async function discoverFiles(location, kind) {
  const root = await realpath(userPath(location));
  const info = await stat(root);
  const allows = (f) => (kind === 'skills' ? path.basename(f) === 'SKILL.md' : scriptSuffix.test(f));
  if (info.isFile()) {
    if (!allows(root))
      throw Error(kind === 'skills' ? '请选择 SKILL.md 或技能目录。' : '请选择本地 Pi 工具扩展脚本。');
    return [root];
  }
  if (!info.isDirectory()) throw Error('插件路径不是普通文件或文件夹。');
  const standalone = path.join(root, 'SKILL.md');
  if (kind === 'skills' && (await present(standalone))?.isFile()) {
    const resolved = await realpath(standalone);
    if (!within(root, resolved)) throw Error('SKILL.md 超出所选目录。');
    return [resolved];
  }
  const manifest = path.join(root, 'package.json');
  let patterns;
  if ((await present(manifest))?.isFile()) {
    if (!within(root, await realpath(manifest))) throw Error('包清单超出所选目录。');
    const metadata = JSON.parse(await readText(manifest, MAX_SKILL_BYTES));
    if (metadata.pi !== undefined) patterns = metadata.pi[kind] ?? [kind];
    else if ((await present(path.join(root, kind)))?.isDirectory()) patterns = [kind];
  }
  if (
    patterns !== undefined &&
    (!Array.isArray(patterns) ||
      patterns.some(
        (p) => typeof p !== 'string' || !p || p.split(/[/\\]/).includes('..') || path.isAbsolute(p),
      ))
  )
    throw Error('Pi 包清单必须使用包内的相对路径。');
  const files = [];
  if (kind === 'extensions' && !patterns) {
    // A plain folder uses Pi's entry points; never execute every helper JS in a package.
    const children = await readdir(root, { withFileTypes: true });
    const index = children.find((e) => e.isFile() && /^index\.(?:[cm]?js|[cm]?ts)$/i.test(e.name));
    if (index) return [path.join(root, index.name)];
    for (const e of children) {
      if (ignored(e.name) || e.isSymbolicLink()) continue;
      if (e.isFile() && allows(e.name)) files.push(path.join(root, e.name));
      if (e.isDirectory()) {
        const folder = path.join(root, e.name);
        const candidate = (await readdir(folder, { withFileTypes: true })).find(
          (c) => c.isFile() && /^index\.(?:[cm]?js|[cm]?ts)$/i.test(c.name),
        );
        if (candidate) files.push(path.join(folder, candidate.name));
      }
    }
  } else if (kind === 'extensions') {
    // Discover directory entries using the same Pi layout as directly selected roots.
    // Enumerating source files is reserved for an explicit file/glob in the manifest.
    const includes = patterns.filter((p) => !p.startsWith('!'));
    for (const p of includes) {
      if (/[*?[\]{}]/.test(p)) continue;
      const entry = path.resolve(root, p);
      if (!(await present(entry))?.isDirectory()) continue;
      const resolved = await realpath(entry);
      if (!within(root, resolved) || resolved === root) throw Error('扩展入口必须位于包内子目录。');
      files.push(
        ...(await discoverFiles(resolved, kind)).filter((f) =>
          patternsMatch(path.relative(root, f).split(path.sep).join('/'), patterns),
        ),
      );
    }
    const explicit = includes.filter((p) => /[*?[\]{}]/.test(p) || scriptSuffix.test(p));
    if (explicit.length)
      await walk(
        root,
        async (f) => {
          if (!allows(f)) return;
          const rel = path.relative(root, f).split(path.sep).join('/');
          if (patternsMatch(rel, [...explicit, ...patterns.filter((p) => p.startsWith('!'))])) files.push(f);
        },
        { count: 0 },
      );
  } else {
    await walk(
      root,
      async (file) => {
        if (!allows(file)) return;
        const rel = path.relative(root, file).split(path.sep).join('/');
        if (!patterns || patternsMatch(rel, patterns)) files.push(file);
      },
      { count: 0 },
    );
  }
  return [...new Set(files)].sort();
}

export async function describeSkill(filename) {
  const data = frontmatter(await readText(filename, MAX_SKILL_BYTES));
  return { name: data.name, description: data.description, manual: data.manual, filename };
}

export async function readSkill(skill, file = 'SKILL.md', offset = 0) {
  if (
    typeof file !== 'string' ||
    !file ||
    !textSuffix.test(file) ||
    file.split(/[/\\]/).some((p) => !p || p === '..' || p.startsWith('.')) ||
    path.isAbsolute(file) ||
    file.includes(':')
  )
    throw Error('请使用技能目录内的相对文档路径。');
  const root = path.dirname(skill.filename);
  const filename = await realpath(path.join(root, file));
  if (!within(root, filename)) throw Error('文档超出所选技能目录。');
  if (!Number.isInteger(offset) || offset < 0) throw Error('文档偏移量无效。');
  const text = await readText(filename, MAX_SKILL_BYTES);
  const body = file === 'SKILL.md' ? frontmatter(text).body : text;
  const end = Math.min(body.length, offset + MAX_PAGE);
  return {
    content: [{ type: 'text', text: body.slice(offset, end) }],
    structuredContent: { skill: skill.name, file, nextOffset: end < body.length ? end : null },
  };
}
