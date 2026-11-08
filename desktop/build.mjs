import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeDesktopNotices } from './notices.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = path.join(root, 'desktop-build');
const backend = path.join(build, 'backend');
const frontend = path.join(build, 'frontend');
const portable = path.join(build, 'Folio');
const zip = path.join(build, 'Folio-desktop-windows-x64.zip');
const runtime = path.join(backend, 'runtime');
const nodeVersion = 'v24.22.2';

async function assertBuildFolder(folder) {
  if (path.dirname(folder) !== build || await realpath(build) !== build)
    throw Error('桌面构建目录路径无效。');
  const existing = await lstat(folder).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing) {
    if (!existing.isDirectory() || (await realpath(folder)) !== folder)
      throw Error('请使用普通目录作为桌面构建目录。');
  }
  return Boolean(existing);
}

async function runtimeFile(name, url, expectedHash) {
  const target = path.join(runtime, name);
  const check = bytes => {
    const content = name === 'LICENSE' ? bytes.toString('utf8').replaceAll('\r\n', '\n') : bytes;
    return createHash('sha256').update(content).digest('hex') === expectedHash;
  };
  const existing = await readFile(target).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing && check(existing)) return;
  const response = await fetch(url);
  if (!response.ok) throw Error('无法获取 ' + name + ' · HTTP ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!check(bytes)) throw Error('Node.js 运行时校验失败 · ' + name);
  await writeFile(target, bytes);
}

async function prepare() {
  await mkdir(runtime, { recursive: true });
  await writeDesktopNotices(root, path.join(build, 'notices'));
  if (await assertBuildFolder(frontend)) await rm(frontend, { recursive: true });
  const assets = path.join(root, 'public');
  await cp(assets, frontend, { recursive: true, filter: async file => {
    const parts = path.relative(assets, file).split(path.sep);
    return !['art', 'cover.js'].includes(parts[0]) && !parts.some(part => part.startsWith('.')) &&
      !(parts[0] === 'catalog-data' && parts[1] === 'local') && !(await lstat(file)).isSymbolicLink();
  } });
  const index = path.join(frontend, 'index.html');
  const markup = await readFile(index, 'utf8');
  const charset = '<meta charset="utf-8" />';
  if (!markup.includes(charset) || !markup.includes('</head>')) throw Error('无法识别工作台入口。');
  // The desktop shell presents its own opening on every launch.
  const desktopPage = markup.replace(/<!-- web-cover -->[\s\S]*?<!-- \/web-cover -->/g, '')
    .replace(charset, charset + '\n    <script src="/desktop-api.js"></script>')
    .replace('</head>', '  <link rel="stylesheet" href="/desktop-workspace.css" />\n  </head>');
  await writeFile(index, desktopPage);
  await copyFile(path.join(root, 'desktop', 'api-client.js'), path.join(frontend, 'desktop-api.js'));
  await copyFile(path.join(root, 'desktop', 'bridge.mjs'), path.join(backend, 'bridge.mjs'));
  await mkdir(path.join(backend, 'server'), { recursive: true });
  for (const file of ['novelai.mjs', 'image-response.mjs']) {
    await copyFile(path.join(root, 'server', file), path.join(backend, 'server', file));
  }
  await runtimeFile('node.exe', 'https://nodejs.org/dist/' + nodeVersion + '/win-x64/node.exe',
    '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9');
  await runtimeFile('LICENSE', 'https://raw.githubusercontent.com/nodejs/node/' + nodeVersion + '/LICENSE',
    '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(command + ' 退出码 ' + result.status);
}

async function packageApp(executable) {
  const staging = await mkdtemp(path.join(build, '.package-'));
  const folder = path.join(staging, 'Folio'), archive = path.join(staging, path.basename(zip));
  const previous = path.join(staging, 'previous');
  let backup = false;
  let destination = portable;
  try {
    await mkdir(folder);
    await copyFile(executable, path.join(folder, 'Folio.exe'));
    await cp(path.join(build, 'notices'), path.join(folder, 'notices'), { recursive: true });
    for (const file of ['bridge.mjs', 'runtime/node.exe', 'runtime/LICENSE', 'server/novelai.mjs', 'server/image-response.mjs']) {
      const dest = path.join(folder, 'backend', file);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(path.join(backend, file), dest);
    }
    run('tar.exe', ['-a', '-cf', archive, '-C', staging, 'Folio']);
    if (await assertBuildFolder(portable)) {
      try {
        await rename(portable, previous);
        backup = true;
      } catch (error) {
        if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        // Keep a running portable app intact and deliver the new build beside it.
        destination = path.join(build, 'Folio-update-' + path.basename(staging).slice('.package-'.length));
      }
    }
    try {
      await rename(folder, destination);
    } catch (error) {
      if (backup) await rename(previous, portable);
      throw error;
    }
    backup = false;
    await rename(archive, zip);
    return destination;
  } finally {
    if (!backup && await assertBuildFolder(staging)) await rm(staging, { recursive: true });
  }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('本构建脚本用于 Windows x64。');
  run(process.execPath, ['scripts/prepare-misans.mjs']);
  await prepare();
  if (process.argv.includes('--prepare')) return;
  // Keep Cargo output independent of any global CARGO_TARGET_DIR override.
  const target = path.join(root, 'src-tauri', 'target');
  const flags = process.env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f') ||
    (process.env.RUSTFLAGS || '').split(/\s+/).filter(Boolean);
  for (const [from, to] of [
    [homedir(), '/user'], [process.env.CARGO_HOME || path.join(homedir(), '.cargo'), '/cargo'],
    [path.resolve(root), '/folio'],
  ]) {
    flags.push('--remap-path-prefix=' + from + '=' + to);
  }
  flags.push('-C', 'link-arg=/PDBALTPATH:%_PDB%');
  run('cargo', ['build', '--release', '--locked', '--target-dir', target, '--manifest-path', 'src-tauri/Cargo.toml'], {
    env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') },
  });
  const destination = await packageApp(path.join(target, 'release', 'Folio.exe'));
  console.log('桌面程序：' + path.join(destination, 'Folio.exe') + '\n便携包：' + zip);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
