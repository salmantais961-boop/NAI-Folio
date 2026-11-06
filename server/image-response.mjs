import path from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

const MiB = 1024 * 1024;
const maxImage = 48 * MiB;
const maxImages = 80 * MiB;
const maxResponse = 112 * MiB;
const badImage = () => new Error('NovelAI 返回的图片数据不完整或格式无法识别。');

export class RemoteImageResponseError extends Error {
  constructor(images) {
    super('上游返回了远程图片链接，当前响应不包含图片文件。');
    this.name = 'RemoteImageResponseError';
    this.code = 'REMOTE_IMAGE_URLS';
    // Internal transport data. Never include these URLs in a diagnostic message.
    this.images = images;
  }
}

function imageType(bytes) {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function imageFile(bytes, filename, seed) {
  const type = imageType(bytes);
  if (!type) throw badImage();
  if (bytes.length > maxImage) throw new Error('单张回图超过本机的解码上限。');
  const name = path.win32.parse(filename).name.replace(/[<>:"|?*\x00-\x1f]/g, '_') || 'novelai';
  return {
    name: name + '.' + (type === 'jpeg' ? 'jpg' : type),
    dataUrl: 'data:image/' + type + ';base64,' + bytes.toString('base64'),
    ...(Number.isInteger(seed) ? { seed } : {}),
  };
}

// Use the central directory rather than local size fields. Streamed ZIP producers
// often leave the latter at zero and append a data descriptor after each entry.
function zipImages(bytes, addImage, seed) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      end = i;
      break;
    }
  }
  if (end < 0) throw badImage();
  const entries = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  if (entries > 128 || offset + bytes.readUInt32LE(end + 12) > end) throw badImage();
  let count = 0, total = 0;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw badImage();
    const method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    if (offset > end) throw badImage();
    if (!/\.(png|webp|jpe?g)$/i.test(name)) continue;
    if (local + 30 > end || bytes.readUInt32LE(local) !== 0x04034b50) throw badImage();
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + compressedSize > end || !size || size > maxImage || total + size > maxImages || count >= 32) throw badImage();
    const compressed = bytes.subarray(start, start + compressedSize);
    if (method !== 0 && method !== 8) throw badImage();
    const data = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: size });
    if (data.length !== size || crc32(data) !== checksum) throw badImage();
    addImage(data, name, count === 0 ? seed : undefined);
    count++;
    total += size;
  }
  if (!count) throw badImage();
}

const isZip = bytes => bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
const mimeType = value => {
  const type = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) && type.length <= 100 ? type : 'unknown';
};
const jsonStart = bytes => bytes.toString('utf8', 0, Math.min(bytes.length, 128)).replace(/^\uFEFF/, '').trimStart()[0];
const payloadFields = ['image', 'base64', 'b64_json', 'dataUrl', 'zip', 'url'];

function base64Bytes(value) {
  let encoded = value.trim();
  if (encoded.startsWith('data:')) {
    const comma = encoded.indexOf(',');
    if (comma < 0 || !/^data:(?:image\/[a-z0-9.+-]+|application\/(?:zip|x-zip-compressed|octet-stream));base64$/i.test(encoded.slice(0, comma)))
      throw badImage();
    encoded = encoded.slice(comma + 1);
  }
  encoded = encoded.replace(/[\r\n\t ]/g, '');
  if (!encoded || encoded.length > 4 * Math.ceil(maxImages / 3) || encoded.length % 4 === 1 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || (encoded.includes('=') && encoded.length % 4 !== 0)) throw badImage();
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length > maxImages) throw badImage();
  return raw;
}

function responseItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (typeof payload === 'string') return [payload];
  if (!payload || typeof payload !== 'object' || payload.error || payload.errors) throw badImage();
  if (Array.isArray(payload.images)) return payload.images;
  if (Array.isArray(payload.data)) return payload.data;
  if (payloadFields.some(field => typeof payload[field] === 'string')) return [payload];
  // Some native relays wrap the whole base64 ZIP in a single data field.
  if (typeof payload.data === 'string') return [{ image: payload.data, seed: payload.seed }];
  throw badImage();
}

export function decodeImages(bytes, contentType = '') {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (!bytes.length || bytes.length > maxResponse) throw badImage();
  const images = [];
  let total = 0;
  function addImage(raw, name, seed) {
    total += raw.length;
    if (total > maxImages || images.length >= 32) throw badImage();
    images.push(imageFile(raw, name, seed));
  }
  function addPayload(value, name, seed) {
    if (/^https?:\/\//i.test(value.trim())) {
      let url;
      try { url = new URL(value.trim()); } catch { throw badImage(); }
      if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || images.length >= 32) throw badImage();
      images.push({ name, url: url.href, ...(Number.isInteger(seed) ? { seed } : {}) });
      return;
    }
    const raw = base64Bytes(value);
    if (isZip(raw)) zipImages(raw, addImage, seed);
    else addImage(raw, name, seed);
  }
  if (isZip(bytes)) zipImages(bytes, addImage);
  else if (imageType(bytes)) addImage(bytes, 'image_0');
  else if (['{', '[', '"'].includes(jsonStart(bytes))) {
    let payload;
    try { payload = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw badImage(); }
    const list = responseItems(payload);
    if (!list.length || list.length > 32) throw badImage();
    const indexOf = item => Number.isInteger(item?.index) && item.index >= 0 ? item.index : null;
    [...list].sort((a, b) => (indexOf(a) ?? 0) - (indexOf(b) ?? 0)).forEach((item, i) => {
      const value = typeof item === 'string' ? item : payloadFields.map(field => item?.[field]).find(value => typeof value === 'string');
      if (typeof value !== 'string') throw badImage();
      addPayload(value, 'image_' + (indexOf(item) ?? i), item?.seed);
    });
  } else if (mimeType(contentType) === 'text/html' || jsonStart(bytes) === '<') throw badImage();
  else {
    try { addImage(bytes, 'image_0'); }
    catch (error) {
      // Only a textual base64/data-URI body gets this fallback; never JSON or HTML.
      if (!/^[\x09\x0a\x0d\x20-\x7e]+$/.test(bytes.toString('latin1'))) throw error;
      images.length = 0;
      total = 0;
      addPayload(bytes.toString('ascii'), 'image_0');
    }
  }
  if (images.some(image => image.url)) throw new RemoteImageResponseError(images);
  return images;
}

const diagnosticKeys = new Set([
  ...payloadFields, 'images', 'data', 'result', 'results', 'output', 'outputs', 'files', 'artifacts',
  'status', 'statusCode', 'status_code', 'code', 'error', 'errors', 'message', 'msg', 'detail', 'reason',
  'success', 'index', 'seed', 'width', 'height', 'name', 'filename', 'created', 'created_at', 'id',
  'request_id', 'task_id', 'type', 'content', 'mime_type', 'content_type', 'prompt', 'negative_prompt',
  'parameters', 'authorization', 'api_key', 'key', 'token',
]);

export function summarizeImageResponse(bytes, contentType = '') {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  const summary = { contentType: mimeType(contentType), byteLength: bytes.length, format: 'binary' };
  if (isZip(bytes)) return { ...summary, format: 'zip' };
  if (imageType(bytes)) return { ...summary, format: 'image/' + imageType(bytes) };
  const first = jsonStart(bytes);
  if (first === '<') return { ...summary, format: 'html' };
  if (bytes.toString('ascii', 0, 5) === 'data:') return { ...summary, format: 'data-uri' };
  if (summary.contentType.includes('json') || ['{', '[', '"'].includes(first)) {
    if (bytes.length > maxResponse) return { ...summary, format: 'json-too-large' };
    let payload;
    try { payload = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
    catch { return { ...summary, format: 'invalid-json' }; }
    function shape(value, depth = 0) {
      if (value === null) return { type: 'null' };
      if (Array.isArray(value)) return { type: 'array', length: value.length, ...(depth < 3 ? { items: value.slice(0, 3).map(item => shape(item, depth + 1)) } : {}) };
      if (typeof value !== 'object') return { type: typeof value };
      if (depth >= 3) return { type: 'object', keyCount: Object.keys(value).length };
      const fields = {}, keys = Object.keys(value), known = keys.filter(key => diagnosticKeys.has(key));
      for (const key of known.slice(0, 16)) fields[key] = shape(value[key], depth + 1);
      return { type: 'object', fields, ...(keys.length > Object.keys(fields).length ? { otherKeys: keys.length - Object.keys(fields).length } : {}) };
    }
    return { ...summary, format: 'json', shape: shape(payload) };
  }
  if (summary.contentType === 'text/html') return { ...summary, format: 'html' };
  return summary;
}

async function* sseEvents(stream) {
  const decoder = new TextDecoder();
  let pending = '', event = '', data = [];
  let eventSize = 0, total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > 512 * MiB) throw new Error('流式回图超出本机内存限制。');
    pending += decoder.decode(chunk, { stream: true });
    let next;
    while ((next = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, next).replace(/\r$/, '');
      pending = pending.slice(next + 1);
      if (!line) {
        if (data.length) yield { event, data: data.join('\n') };
        data = []; event = ''; eventSize = 0;
      } else if (line.startsWith('data:')) {
        eventSize += line.length;
        if (eventSize > 68 * MiB) throw badImage();
        data.push(line.slice(5).replace(/^ /, ''));
      } else if (line.startsWith('event:')) event = line.slice(6).trim();
    }
    if (eventSize + pending.length > 68 * MiB) throw badImage();
  }
}

export async function* generationEvents(response, sampleCount, seed) {
  const finals = new Map();
  let finalSize = 0, lastPreview = 0;
  for await (const { event, data } of sseEvents(response.body)) {
    if (data === '[DONE]') break;
    if (event === 'error') throw new Error('NovelAI 返回流式错误，请查看余额或稍后重试。');
    if (event && !['message', 'intermediate', 'final'].includes(event)) continue;
    const payload = JSON.parse(data);
    const kind = payload.event_type ?? event;
    if (kind === 'error') throw new Error('NovelAI 返回流式错误，请检查模型与参数。');
    if (!['intermediate', 'final'].includes(kind)) continue;
    const sample = payload.samp_ix;
    if (!Number.isInteger(sample) || sample < 0 || sample >= sampleCount || typeof payload.image !== 'string') throw badImage();
    if (kind === 'intermediate') {
      if (Date.now() - lastPreview < 200 || payload.image.length > 4 * MiB) continue;
      lastPreview = Date.now();
      const file = imageFile(Buffer.from(payload.image, 'base64'), 'preview');
      yield { type: 'preview', url: file.dataUrl, step: payload.step_ix, sample };
    } else {
      if (finals.has(sample)) throw badImage();
      const raw = Buffer.from(payload.image, 'base64');
      finalSize += raw.length;
      if (finalSize > maxImages) throw badImage();
      finals.set(sample, imageFile(raw, 'image_' + sample, payload.seed));
      if (finals.size === sampleCount) break;
    }
  }
  if (finals.size !== sampleCount) throw new Error('流式连接在所有成图送达前中断，请先检查账户用量再重试。');
  const images = Array.from({ length: sampleCount }, (_, i) => finals.get(i));
  yield { type: 'result', images, seed: images[0].seed ?? seed };
}
