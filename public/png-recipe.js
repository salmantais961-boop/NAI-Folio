const utf8 = new TextDecoder();
const limit = 2 * 1024 * 1024;
const fieldsUsed = new Set(['Software', 'Comment', 'Source', 'Description']);
// Model hashes used by the official NovelAI import dialog, including earlier revisions.
const knownHashes = {
  'nai-diffusion-5-full': '657484A5 0ADF9AB7 93F4BD30 70AB5786',
  'nai-diffusion-5-curated': 'DB276663',
  'nai-diffusion-4-5-full': '4BDE2A90 1229B44F B9F340FD F3D95188',
  'nai-diffusion-4-5-curated': 'C02D4F98 5AB81C7C B5A2A797',
  'nai-diffusion-4-full': '37442FCA 4F49EC75 CA4B7203 79F47848 F6302A9D',
  'nai-diffusion-4-curated-preview': '7ABFFA2A C1CCBA86 770A9E12',
  'nai-diffusion-3': 'B0BDF6C1 C1E1DE52 7BCCAA2C 1120E6A9 8BA2AF87',
  'nai-diffusion-furry-3': '4BE8C60C C8704949 37C2B166 F306816B 9CC2F394',
};

async function decompress(raw, type) {
  const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream(type)).getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if ((length += value.length) > limit) { await reader.cancel(); throw Error('PNG 参数块过大。'); }
      chunks.push(value);
    }
    return new Blob(chunks).text();
  } finally { reader.releaseLock(); }
}

async function textFields(bytes) {
  const fields = {};
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = view.getUint32(offset);
    const type = utf8.decode(bytes.subarray(offset + 4, offset + 8));
    if (offset + size + 12 > bytes.length) throw Error('PNG 文件不完整。');
    const data = bytes.subarray(offset + 8, offset + 8 + size);
    offset += size + 12;
    if (size > limit || !['tEXt', 'zTXt', 'iTXt'].includes(type)) continue;
    const split = data.indexOf(0);
    if (split < 1) continue;
    const key = utf8.decode(data.subarray(0, split));
    if (!fieldsUsed.has(key)) continue;
    let start = split + 1, zipped = false;
    if (type === 'zTXt') { if (data[start++] !== 0) continue; zipped = true; }
    if (type === 'iTXt') {
      zipped = data[start++] === 1;
      if (data[start++] !== 0) continue;
      const langEnd = data.indexOf(0, start);
      const translatedEnd = langEnd < 0 ? -1 : data.indexOf(0, langEnd + 1);
      if (translatedEnd < 0) continue;
      start = translatedEnd + 1;
    }
    fields[key] = zipped ? await decompress(data.subarray(start), 'deflate') : utf8.decode(data.subarray(start));
  }
  return fields;
}

async function alphaFields(file, width, height) {
  if (width * height > 24_000_000 || width * height < 152) return {};
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    let cursor = 0;
    function read(length) {
      const result = new Uint8Array(length);
      for (let i = 0; i < length; i++) for (let bit = 0; bit < 8; bit++, cursor++) {
        const x = Math.floor(cursor / height), y = cursor % height;
        result[i] = (result[i] << 1) | (pixels[(y * width + x) * 4 + 3] & 1);
      }
      return result;
    }
    if (utf8.decode(read(15)) !== 'stealth_pngcomp') return {};
    const bits = new DataView(read(4).buffer).getUint32(0);
    if (bits % 8 || !bits || bits / 8 > limit || bits + cursor > width * height) return {};
    return JSON.parse(await decompress(read(bits / 8), 'gzip'));
  } finally { bitmap.close(); }
}

function asRecipe(fields) {
  if (!/novelai/i.test(String(fields.Software) + ' ' + String(fields.Source))) return null;
  let p = fields.Comment || {};
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = {}; } }
  if (!p || typeof p !== 'object') p = {};
  const caption = p.v4_prompt?.caption, neg = p.v4_negative_prompt?.caption;
  const prompt = caption?.base_caption ?? p.prompt ?? fields.Description;
  const negative = neg?.base_caption ?? p.uc ?? p.negative_prompt ?? '';
  if (typeof prompt !== 'string' || !prompt.length || typeof negative !== 'string') return null;
  const settings = { mode: 'generate', quality: 'off', uc: 'none' };
  const hash = (String(p.model_hash || fields.Source || '').trim().split(/\s+/).at(-1) || '').toUpperCase();
  const model = Object.hasOwn(knownHashes, p.model) ? p.model : Object.keys(knownHashes).find(id => knownHashes[id].split(' ').includes(hash));
  if (model) settings.model = model;
  settings.medium = ['93F4BD30','70AB5786'].includes(hash);
  for (const [from, to, min, max] of [
    ['width','width',64,4096], ['height','height',64,4096], ['seed','seed',0,4294967295],
    ['steps','steps',1,50], ['scale','scale',0,10], ['cfg_rescale','cfgRescale',0,1], ['n_samples','batch',1,8],
  ]) if (Number.isFinite(p[from]) && p[from] >= min && p[from] <= max) settings[to] = p[from];
  if (typeof p.sampler === 'string') settings.sampler = p.sampler;
  if (typeof p.noise_schedule === 'string') settings.noiseSchedule = p.noise_schedule;
  if (p.sm) settings.smea = p.sm_dyn ? 'dynamic' : 'sm';
  settings.useCoords = p.v4_prompt?.use_coords === true;
  const positives = Array.isArray(caption?.char_captions) ? caption.char_captions : [];
  const negatives = Array.isArray(neg?.char_captions) ? neg.char_captions : [];
  settings.characters = Array.from({ length: Math.min(22, Math.max(positives.length, negatives.length)) }, (_, i) => {
    const c = positives[i], n = negatives[i], point = c?.centers?.[0] ?? n?.centers?.[0] ?? {};
    return { prompt: String(c?.char_caption || ''), negative: String(n?.char_caption || ''), enabled: true,
      x: Number.isFinite(point.x) ? Math.max(0, Math.min(1, point.x)) : .5, y: Number.isFinite(point.y) ? Math.max(0, Math.min(1, point.y)) : .5 };
  });
  // The stored caption already contains quality/dataset/UC additions.
  // Medium effort supplies its own fixed negative caption.
  return { prompt, negative: settings.medium ? '' : negative, settings };
}

export async function readPngRecipe(file) {
  if (!file || file.size > 96 * 1024 * 1024) throw Error('请选择 96 MB 以内的 NovelAI PNG。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const header = new DataView(bytes.buffer);
  if (bytes.length < 33 || header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a) throw Error('无法识别 PNG 文件。');
  const fields = await textFields(bytes);
  const result = asRecipe(fields);
  if (result) return result;
  const hidden = await alphaFields(file, header.getUint32(16), header.getUint32(20));
  const recipe = asRecipe(hidden);
  if (!recipe) throw Error('这张 PNG 中没有可读的 NovelAI 创作参数。');
  return recipe;
}
