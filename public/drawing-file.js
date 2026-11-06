import { canvasOf } from './controls-media.js';

// A small UTF-8 manifest followed by binary PNG and GLB parts. Blob slices let
// the reader load layers individually and keep GLBs on disk until edited.
const magic = 'FOLIOCAN';
const headerSize = 12;
const maxManifest = 4 * 1024 * 1024;
const maxGlb = 48 * 1024 * 1024;
const invalid = () => Error('画布文件不完整，或含有无法读取的图层。');
const vector = (value, n) => Array.isArray(value) && value.length === n && value.every(Number.isFinite);

async function bitmapBlob(canvas) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw Error('无法导出图层位图。');
  return blob;
}

export async function writeDrawingFile({ width, height, layers, selected }) {
  const blobs = [],
    parts = [],
    modelParts = new Map(),
    records = [];
  function addPart(blob, type, name) {
    if (!(blob instanceof Blob) || !blob.size) throw invalid();
    const index = parts.length;
    parts.push({ type, size: blob.size, ...(name ? { name } : {}) });
    blobs.push(blob);
    return index;
  }
  for (const layer of layers) {
    const { id, name, x, y, visible, opacity } = layer;
    const record = { id, name, x, y, visible, opacity };
    if (layer.canvas) record.bitmap = addPart(await bitmapBlob(layer.canvas), 'png');
    else Object.assign(record, { color: layer.color, joints: layer.joints });
    if (layer.scene3d) {
      const { file, angles, camera, target, joint, preset } = layer.scene3d;
      record.scene3d = { angles, camera, target, joint, preset };
      if (file) {
        if (!modelParts.has(file)) modelParts.set(file, addPart(file, 'glb', file.name));
        record.scene3d.model = modelParts.get(file);
      }
    }
    records.push(record);
  }
  const manifest = new TextEncoder().encode(
    JSON.stringify({ version: 1, width, height, selected, layers: records, parts }),
  );
  if (manifest.length > maxManifest) throw Error('三维骨架数据超过工程格式上限。');
  const header = new Uint8Array(headerSize);
  header.set(new TextEncoder().encode(magic));
  new DataView(header.buffer).setUint32(8, manifest.length);
  return new Blob([header, manifest, ...blobs], { type: 'application/octet-stream' });
}

export async function readDrawingFile(file) {
  const header = await file.slice(0, headerSize).arrayBuffer();
  if (header.byteLength !== headerSize || new TextDecoder().decode(header.slice(0, 8)) !== magic)
    throw Error('请选择 Folio 的 .foliocanvas 画布文件。');
  const length = new DataView(header).getUint32(8);
  if (!length || length > maxManifest || headerSize + length > file.size) throw invalid();
  let data;
  try {
    data = JSON.parse(await file.slice(headerSize, headerSize + length).text());
  } catch {
    throw invalid();
  }
  if (data?.version !== 1) throw Error('当前版本的工作台无法读取这个画布版本。');
  const { width, height } = data;
  if (![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 4096) || width * height > 4_194_304)
    throw invalid();
  if (
    !Array.isArray(data.layers) ||
    !data.layers.length ||
    data.layers.length > 10 ||
    !Array.isArray(data.parts) ||
    data.parts.length > 20
  )
    throw invalid();
  let offset = headerSize + length;
  const parts = [],
    models = new Map();
  for (const part of data.parts) {
    const isGlb = part?.type === 'glb';
    if (
      (!isGlb && part?.type !== 'png') ||
      !Number.isInteger(part.size) ||
      part.size < 20 ||
      part.size > (isGlb ? maxGlb : width * height * 5 + 65536) ||
      offset + part.size > file.size
    )
      throw invalid();
    parts.push(file.slice(offset, offset + part.size, isGlb ? 'model/gltf-binary' : 'image/png'));
    offset += part.size;
  }
  if (offset !== file.size) throw invalid();
  const layers = [],
    ids = new Set();
  for (const rec of data.layers) {
    if (
      !Number.isSafeInteger(rec?.id) ||
      rec.id < 1 ||
      rec.id > 1e9 ||
      ids.has(rec.id) ||
      typeof rec.name !== 'string' ||
      !Number.isFinite(rec.x) ||
      !Number.isFinite(rec.y) ||
      typeof rec.visible !== 'boolean' ||
      !Number.isFinite(rec.opacity) ||
      rec.opacity < 0 ||
      rec.opacity > 1
    )
      throw invalid();
    ids.add(rec.id);
    const layer = {
      id: rec.id,
      name: rec.name,
      x: rec.x,
      y: rec.y,
      visible: rec.visible,
      opacity: rec.opacity,
    };
    if (rec.bitmap !== undefined) {
      if (!Number.isInteger(rec.bitmap) || data.parts[rec.bitmap]?.type !== 'png') throw invalid();
      const blob = parts[rec.bitmap];
      const png = new DataView(await blob.slice(0, 24).arrayBuffer());
      if (
        png.byteLength < 24 ||
        png.getUint32(0) !== 0x89504e47 ||
        png.getUint32(12) !== 0x49484452 ||
        png.getUint32(16) !== width ||
        png.getUint32(20) !== height
      )
        throw invalid();
      const bitmap = await createImageBitmap(blob);
      try {
        layer.canvas = canvasOf(width, height);
        layer.canvas.getContext('2d').drawImage(bitmap, 0, 0);
      } finally {
        bitmap.close();
      }
    } else {
      if (
        !Array.isArray(rec.joints) ||
        rec.joints.length !== 15 ||
        !rec.joints.every((pair) => vector(pair, 2)) ||
        !/^#[0-9a-f]{6}$/i.test(rec.color)
      )
        throw invalid();
      Object.assign(layer, { canvas: null, joints: rec.joints, color: rec.color });
    }
    if (rec.scene3d) {
      const s = rec.scene3d;
      if (
        !layer.canvas ||
        !vector(s.camera, 3) ||
        !vector(s.target, 3) ||
        !s.angles ||
        typeof s.angles !== 'object' ||
        !Object.values(s.angles).every((angle) => vector(angle, 3))
      )
        throw invalid();
      let model = null;
      if (s.model !== undefined) {
        if (!Number.isInteger(s.model) || data.parts[s.model]?.type !== 'glb') throw invalid();
        if (!models.has(s.model)) {
          const blob = parts[s.model];
          const glb = new DataView(await blob.slice(0, 12).arrayBuffer());
          if (
            glb.getUint32(0, true) !== 0x46546c67 ||
            glb.getUint32(4, true) !== 2 ||
            glb.getUint32(8, true) !== blob.size
          )
            throw invalid();
          models.set(
            s.model,
            new File([blob], String(data.parts[s.model].name || 'model.glb'), { type: 'model/gltf-binary' }),
          );
        }
        model = models.get(s.model);
      }
      layer.scene3d = {
        file: model,
        camera: s.camera,
        target: s.target,
        angles: s.angles,
        joint: s.joint,
        preset: s.preset,
      };
    }
    layers.push(layer);
  }
  return { width, height, layers, selected: ids.has(data.selected) ? data.selected : layers.at(-1).id };
}
