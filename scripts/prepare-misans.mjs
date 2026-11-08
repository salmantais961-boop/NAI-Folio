import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const directory = fileURLToPath(new URL('../public/fonts/misans/', import.meta.url));
const base = 'https://hyperos.mi.com/font-download/';
const fonts = [
  { name: 'MiSans-VF.ttf', archive: 'MiSans.zip', member: 'MiSans/可变字体/MiSansVF.ttf',
    sha: '0ddef90648998900175cfdca9a6f087a2544c182f130b0ad4f7e94a03a115e79' },
  { name: 'MiSans-L3.otf', archive: 'MiSans_L3.zip', member: 'MiSans L3/MiSans L3.otf',
    sha: '4c4d71526d260d13525f141f2333025c6c77368f598841e110e25c2cae02b29a' },
];

// Xiaomi's archives also include large static families. Read their central directory
// and fetch only the original font member. A proxy may instead return the whole ZIP.
async function readMember(font) {
  let wholeZip;
  async function range(first, last) {
    if (!wholeZip) {
      const spec = first < 0 ? String(first) : first + '-' + last;
      const response = await fetch(base + font.archive, {
        headers: { Range: 'bytes=' + spec, 'Accept-Encoding': 'identity' },
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw Error(font.archive + ' · HTTP ' + response.status);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (response.status === 206) return bytes;
      wholeZip = bytes;
    }
    return wholeZip.subarray(first, last === undefined ? undefined : last + 1);
  }

  // A classic ZIP has a 22-byte end record and at most 65535 bytes of comment.
  const tail = await range(-65557);
  const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > tail.length) throw Error('无法识别官方 ZIP 目录。');
  const length = tail.readUInt32LE(end + 12);
  const offset = tail.readUInt32LE(end + 16);
  const entries = end >= length ? tail.subarray(end - length, end) : await range(offset, offset + length - 1);
  for (let at = 0; at + 46 <= entries.length;) {
    if (entries.readUInt32LE(at) !== 0x02014b50) throw Error('官方 ZIP 文件表无效。');
    const nameLength = entries.readUInt16LE(at + 28);
    const name = entries.toString('utf8', at + 46, at + 46 + nameLength);
    if (name === font.member) {
      if (entries.readUInt16LE(at + 10) !== 8) throw Error('官方字体压缩格式已改变。');
      const size = entries.readUInt32LE(at + 20), header = entries.readUInt32LE(at + 42);
      const local = await range(header, header + 29);
      if (local.readUInt32LE(0) !== 0x04034b50) throw Error('官方 ZIP 字体条目无效。');
      const start = header + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      return inflateRawSync(await range(start, start + size - 1), { maxOutputLength: 32 * 1024 * 1024 });
    }
    at += 46 + nameLength + entries.readUInt16LE(at + 30) + entries.readUInt16LE(at + 32);
  }
  throw Error('官方 ZIP 内未找到 ' + font.member);
}

const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
export async function prepareMiSans() {
  await mkdir(directory, { recursive: true });
  for (const font of fonts) {
    const dest = join(directory, font.name);
    const existing = await readFile(dest).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (existing && checksum(existing) === font.sha) continue;
    const bytes = await readMember(font);
    if (checksum(bytes) !== font.sha) throw Error('官方字体内容已改变，请核对新版文件后更新 SHA-256：' + font.name);
    const temporary = dest + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, dest);
    } finally {
      await rm(temporary, { force: true });
    }
    console.log('MiSans 已校验 · ' + font.name);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  prepareMiSans().catch(error => {
    console.error(error.message, '\n可从 https://hyperos.mi.com/font/download 获取官方文件，将以上字体放入 public/fonts/misans 后重试。');
    process.exitCode = 1;
  });
