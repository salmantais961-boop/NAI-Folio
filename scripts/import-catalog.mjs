import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLocalCover } from '../public/catalog-path.js';

const bundledRoot = fileURLToPath(new URL('../public/catalog-data/', import.meta.url));

function inside(parent, child) {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

async function sourceFile(source, name) {
  const path = await realpath(join(source, name));
  if (!inside(source, path) || !(await stat(path)).isFile()) throw Error('索引文件越界或无效：' + name);
  return path;
}

async function loadIndex(source, kind) {
  const name = kind + '.json';
  const data = JSON.parse(await readFile(await sourceFile(source, name), 'utf8'));
  if (kind === 'character-details' || kind === 'related-tags') {
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        Object.values(data).some((tags) => !Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')))
      throw Error('标签列表索引格式无效：' + name);
    return data;
  }
  if (!Array.isArray(data) || !data.length) throw Error('索引为空或格式无效：' + name);
  const schema = kind === 'tags'
    ? ['string', 'string', 'number', 'number', 'string']
    : ['string', 'string', 'string', 'string', 'string', 'number', 'string', 'string', 'string', 'string'];
  for (const [i, row] of data.entries()) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[0].trim() ||
        row.some((value, field) => field >= schema.length || typeof value !== schema[field]))
      throw Error(name + ' 第 ' + (i + 1) + ' 条记录格式无效。');
  }
  return data;
}

export async function importCatalog(sourceDirectory, targetDirectory = bundledRoot) {
  const source = await realpath(sourceDirectory);
  const target = await realpath(targetDirectory);
  const privateRoot = join(target, 'local');
  if (source === target || inside(source, privateRoot)) throw Error('请选择与目标分开的源图鉴目录。');

  const data = {};
  for (const kind of ['tags', 'artist', 'character']) data[kind] = await loadIndex(source, kind);
  for (const kind of ['character-details', 'related-tags']) {
    try {
      data[kind] = await loadIndex(source, kind);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      data[kind] = {};
    }
  }

  const covers = new Map();
  let missingCovers = 0;
  for (const row of [...data.artist, ...data.character]) {
    if (row.length > 6) row[6] = ''; // Imported editions, like the starter, stay offline.
    if (!row[7]) continue;
    const path = row[7];
    if (!isLocalCover(path)) throw Error('不支持的封面路径：' + path);
    if (!covers.has(path)) {
      try {
        covers.set(path, await sourceFile(source, path));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missingCovers++;
        covers.set(path, null);
      }
    }
    if (!covers.get(path)) row[7] = '';
  }

  await mkdir(privateRoot, { recursive: true });
  if (await realpath(privateRoot) !== privateRoot) throw Error('本机图鉴目标不能是符号链接。');
  const edition = randomUUID();
  const folder = join(privateRoot, edition);
  const pointer = join(privateRoot, edition + '.tmp');
  await mkdir(folder);
  try {
    for (const [name, rows] of Object.entries(data)) await writeFile(join(folder, name + '.json'), JSON.stringify(rows));
    for (const [name, file] of covers) {
      if (!file) continue;
      const destination = join(folder, name);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(file, destination);
    }
    await writeFile(pointer, JSON.stringify({ edition }) + '\n', { flag: 'wx' });
    await rename(pointer, join(privateRoot, 'current.json'));
  } catch (error) {
    if (inside(privateRoot, folder)) await rm(folder, { recursive: true, force: true });
    await rm(pointer, { force: true });
    throw error;
  }
  return { edition, tags: data.tags.length, artists: data.artist.length, characters: data.character.length,
    appearances: Object.keys(data['character-details']).length, covers: covers.size - missingCovers, missingCovers };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('用法：node scripts/import-catalog.mjs "<有权使用的 Folio catalog-data 目录>"');
    process.exitCode = 1;
  } else {
    try {
      const info = await importCatalog(process.argv[2]);
      console.log(`已导入 ${info.tags} 个联想词条、${info.artists} 位画师、${info.characters} 位角色，以及 ${info.covers} 张本地封面。`);
      if (info.missingCovers) console.log(`缺少 ${info.missingCovers} 张本地封面，这些条目将使用首字排版。`);
      console.log('在工作台地址后加 ?catalog=local 启用。?catalog=sample 切回随附示例库。');
    } catch (error) {
      console.error('导入失败：' + error.message);
      process.exitCode = 1;
    }
  }
}
