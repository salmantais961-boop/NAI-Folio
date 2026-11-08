const utf8 = new TextEncoder();
const max32 = 0xffffffff;
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value;
});

async function checksum(blob, signal) {
  let crc = max32;
  // Keep only a small slice in JS memory. The completed ZIP reuses the original Blobs.
  const chunkSize = 512 * 1024;
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    signal?.throwIfAborted();
    const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff];
  }
  return (crc ^ max32) >>> 0;
}

function zipHeader(size, signature) {
  const header = new DataView(new ArrayBuffer(size));
  header.setUint32(0, signature, true);
  return header;
}

function zip64Extra(values) {
  if (!values.length) return new Uint8Array(0);
  const extra = new DataView(new ArrayBuffer(4 + 8 * values.length));
  extra.setUint16(0, 1, true);
  extra.setUint16(2, 8 * values.length, true);
  values.forEach((value, index) => extra.setBigUint64(4 + index * 8, BigInt(value), true));
  return new Uint8Array(extra.buffer);
}

function fileHeaders(name, size, crc, offset, created) {
  const encoded = utf8.encode(name);
  const sizes = size >= max32 ? [size, size] : [];
  const localExtra = zip64Extra(sizes);
  const centralExtra = zip64Extra(offset >= max32 ? [...sizes, offset] : sizes);
  const version = centralExtra.length ? 45 : 20;
  const local = zipHeader(30 + encoded.length + localExtra.length, 0x04034b50);
  const central = zipHeader(46 + encoded.length + centralExtra.length, 0x02014b50);
  const date = new Date(created);
  local.setUint16(4, version, true);
  local.setUint16(6, 0x0800, true); // UTF-8 filenames, stored (already compressed image formats).
  const validDate = Number.isFinite(date.getTime()) && date.getFullYear() >= 1980 && date.getFullYear() <= 2107;
  local.setUint16(10, validDate ? (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1) : 0, true);
  local.setUint16(12, validDate ? ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() : 33, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, Math.min(size, max32), true);
  local.setUint32(22, Math.min(size, max32), true);
  local.setUint16(26, encoded.length, true);
  local.setUint16(28, localExtra.length, true);
  const localBytes = new Uint8Array(local.buffer);
  localBytes.set(encoded, 30);
  localBytes.set(localExtra, 30 + encoded.length);
  central.setUint16(4, version, true);
  const centralBytes = new Uint8Array(central.buffer);
  centralBytes.set(localBytes.subarray(4, 28), 6);
  central.setUint16(30, centralExtra.length, true);
  central.setUint32(42, Math.min(offset, max32), true);
  centralBytes.set(encoded, 46);
  centralBytes.set(centralExtra, 46 + encoded.length);
  return { local, central };
}

function endRecords(count, size, offset) {
  const end = zipHeader(22, 0x06054b50);
  end.setUint16(8, Math.min(count, 0xffff), true);
  end.setUint16(10, Math.min(count, 0xffff), true);
  end.setUint32(12, Math.min(size, max32), true);
  end.setUint32(16, Math.min(offset, max32), true);
  if (count < 0xffff && size < max32 && offset < max32) return [end];
  const end64 = zipHeader(56, 0x06064b50);
  end64.setBigUint64(4, 44n, true);
  end64.setUint16(12, 45, true);
  end64.setUint16(14, 45, true);
  end64.setBigUint64(24, BigInt(count), true);
  end64.setBigUint64(32, BigInt(count), true);
  end64.setBigUint64(40, BigInt(size), true);
  end64.setBigUint64(48, BigInt(offset), true);
  const locator = zipHeader(20, 0x07064b50);
  locator.setBigUint64(8, BigInt(offset + size), true);
  locator.setUint32(16, 1, true);
  return [end64, locator, end];
}

function imageName(work, index, width) {
  const basename = String(work.filename || '').split(/[\\/]/).pop();
  const stem = basename.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  const format = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
  const extension = format[work.blob.type] || basename.match(/\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i)?.[1] || 'png';
  return String(index).padStart(width, '0') + '-' + Array.from(stem || 'folio').slice(0, 90).join('') + '.' + extension;
}

export async function createArchiveZip(items, getWork, { onProgress, signal } = {}) {
  signal?.throwIfAborted();
  const ids = [...new Set(Array.from(items, (item) => item.id))];
  if (!ids.length) throw Error('请先选择要打包的作品。');
  const width = Math.max(3, String(ids.length).length);
  const files = [], directory = [], manifest = [];
  let offset = 0;
  async function append(name, blob, created) {
    const crc = await checksum(blob, signal);
    const { local, central } = fileHeaders(name, blob.size, crc, offset, created);
    files.push(local, blob);
    directory.push(central);
    offset += local.byteLength + blob.size;
  }
  onProgress?.(0, ids.length);
  for (const [index, id] of ids.entries()) {
    signal?.throwIfAborted();
    const work = await getWork(id);
    signal?.throwIfAborted();
    if (!(work?.blob instanceof Blob) || !work.blob.size) throw Error('有作品的原图已无法读取，请刷新作品集后重试。');
    const name = imageName(work, index + 1, width);
    await append(name, work.blob, work.created);
    manifest.push({ file: name, tags: Array.isArray(work.galleryTags) ? work.galleryTags : [] });
    onProgress?.(index + 1, ids.length);
  }
  await append('tags.json', new Blob([JSON.stringify(manifest, null, 2)]), Date.now());
  signal?.throwIfAborted();
  const size = directory.reduce((sum, entry) => sum + entry.byteLength, 0);
  return new Blob([...files, ...directory, ...endRecords(directory.length, size, offset)], { type: 'application/zip' });
}
