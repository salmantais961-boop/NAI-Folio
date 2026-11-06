const canvas = (width, height) => {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
};

// A scaled sprite concentrates its edge energy along one phase of a periodic
// lattice. Test both axes and prefer the largest similarly supported period.
function readGrid(image) {
  const { width: w, height: h, data } = image,
    gx = new Float64Array(w),
    gy = new Float64Array(h);
  const distance = (a, b) =>
    ((Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2])) *
      Math.min(data[a + 3], data[b + 3])) /
      255 +
    Math.abs(data[a + 3] - data[b + 3]);
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 90)))
    for (let x = 1; x < w; x++) {
      const i = (y * w + x) * 4;
      gx[x] += distance(i, i - 4);
    }
  for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 90)))
    for (let y = 1; y < h; y++) {
      const i = (y * w + x) * 4;
      gy[y] += distance(i, i - w * 4);
    }
  function fit(edges, period) {
    const bins = new Float64Array(period);
    let total = 0;
    for (let i = 1; i < edges.length; i++) {
      bins[i % period] += edges[i];
      total += edges[i];
    }
    const peak = Math.max(...bins);
    return {
      phase: bins.indexOf(peak),
      score: total ? Math.max(0, (peak / total - 1 / period) / (1 - 1 / period)) : 0,
    };
  }
  let best = { size: 1, x: 0, y: 0, score: 0 };
  for (let size = 2; size <= Math.min(64, Math.floor(Math.min(w, h) / 3)); size++) {
    const xx = fit(gx, size),
      yy = fit(gy, size);
    const score = (xx.score + yy.score) / 2;
    if (score > 0.12 && score >= best.score * 0.985) best = { size, x: xx.phase, y: yy.phase, score };
  }
  return best;
}

// Weighted median-cut on a 5-bit RGB histogram. Alpha is retained separately.
function reducePalette(pixels, limit) {
  const data = pixels.data,
    bins = new Map();
  const keyAt = (i) => ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
  for (let i = 0; i < data.length; i += 4)
    if (data[i + 3]) {
      const key = keyAt(i);
      let entry = bins.get(key);
      if (!entry) bins.set(key, (entry = { key, rgb: [0, 0, 0], n: 0 }));
      entry.rgb[0] += data[i];
      entry.rgb[1] += data[i + 1];
      entry.rgb[2] += data[i + 2];
      entry.n++;
    }
  if (!bins.size) return [];
  const rows = Array.from(bins.values());
  for (const e of rows) e.rgb = e.rgb.map((x) => x / e.n);
  function box(items) {
    const lo = [255, 255, 255],
      hi = [0, 0, 0];
    let total = 0;
    for (const e of items) {
      total += e.n;
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c], e.rgb[c]);
        hi[c] = Math.max(hi[c], e.rgb[c]);
      }
    }
    const ranges = hi.map((v, c) => v - lo[c]),
      span = Math.max(...ranges);
    return {
      items,
      total,
      axis: ranges.indexOf(span),
      score: items.length < 2 ? 0 : span * Math.sqrt(total),
    };
  }
  const boxes = [box(rows)];
  while (boxes.length < limit) {
    boxes.sort((a, b) => b.score - a.score);
    const b = boxes[0];
    if (!b.score) break;
    const sorted = b.items.sort((a, z) => a.rgb[b.axis] - z.rgb[b.axis]);
    let acc = 0,
      cut = 0;
    while (cut < sorted.length - 1 && acc < b.total / 2) acc += sorted[cut++].n;
    boxes.splice(0, 1, box(sorted.slice(0, cut)), box(sorted.slice(cut)));
  }
  const palette = boxes.map((b) => {
    const rgb = [0, 0, 0];
    for (const entry of b.items) for (let c = 0; c < 3; c++) rgb[c] += entry.rgb[c] * entry.n;
    return rgb.map((v) => Math.round(v / b.total));
  });
  for (const entry of rows) {
    let best = Infinity,
      nearest;
    for (const rgb of palette) {
      const dist = (entry.rgb[0] - rgb[0]) ** 2 + (entry.rgb[1] - rgb[1]) ** 2 + (entry.rgb[2] - rgb[2]) ** 2;
      if (dist < best) {
        best = dist;
        nearest = rgb;
      }
    }
    entry.nearest = nearest;
  }
  for (let i = 0; i < data.length; i += 4)
    if (data[i + 3]) {
      const rgb = bins.get(keyAt(i)).nearest;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
    }
  return palette;
}

function sampleGrid(image, size, phaseX, phaseY, limit) {
  const { width: w, height: h, data } = image;
  const x0 = phaseX ? phaseX - size : 0,
    y0 = phaseY ? phaseY - size : 0;
  const result = canvas(Math.ceil((w - x0) / size), Math.ceil((h - y0) / size));
  const ctx = result.getContext('2d'),
    pixels = ctx.createImageData(result.width, result.height);
  if (size === 1) pixels.data.set(data);
  else {
    // Choose the most representative of five interior samples to keep sharp
    // boundaries, isolated sprite pixels and transparent background colors.
    const sample = new Int32Array(5);
    for (let j = 0; j < result.height; j++)
      for (let i = 0; i < result.width; i++) {
        const left = Math.max(0, x0 + i * size),
          top = Math.max(0, y0 + j * size);
        const right = Math.min(w, x0 + (i + 1) * size) - 1,
          bottom = Math.min(h, y0 + (j + 1) * size) - 1;
        const cx = (left + right) >> 1,
          cy = (top + bottom) >> 1;
        const dx = Math.floor((right - left) / 4),
          dy = Math.floor((bottom - top) / 4);
        sample[0] = (cy * w + cx) * 4;
        sample[1] = sample[0] - dx * 4;
        sample[2] = sample[0] + dx * 4;
        sample[3] = sample[0] - dy * w * 4;
        sample[4] = sample[0] + dy * w * 4;
        let best = Infinity,
          index = sample[0];
        if (dx || dy)
          for (const a of sample) {
            let score = 0;
            for (const b of sample) {
              score +=
                Math.abs(data[a + 3] - data[b + 3]) * 3 +
                ((Math.abs(data[a] - data[b]) +
                  Math.abs(data[a + 1] - data[b + 1]) +
                  Math.abs(data[a + 2] - data[b + 2])) *
                  Math.min(data[a + 3], data[b + 3])) /
                  255;
            }
            if (score < best) {
              index = a;
              best = score;
            }
          }
        const k = (j * result.width + i) * 4;
        pixels.data[k] = data[index];
        pixels.data[k + 1] = data[index + 1];
        pixels.data[k + 2] = data[index + 2];
        pixels.data[k + 3] = data[index + 3];
      }
  }
  const palette = limit ? reducePalette(pixels, limit) : [];
  ctx.putImageData(pixels, 0, 0);
  return { result, palette, x0, y0, size };
}

const toBlob = (canvas) =>
  new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG 导出失败'))), 'image/png'),
  );
let current;
export function openPixelSnap({ source, onApply } = {}) {
  current?.close();
  const dialog = document.createElement('dialog');
  current = dialog;
  dialog.className = 'cat-dialog snap-dialog';
  dialog.setAttribute('aria-labelledby', 'snap-title');
  dialog.innerHTML = `
    <header class="cat-header"><span class="cat-kicker"><i></i> FOLIO &nbsp;/&nbsp; LOCAL TOOLS</span><button class="cat-close" type="button" aria-label="关闭像素整理">×</button></header>
    <div class="cat-heading"><h2 id="snap-title">Pixel Snap</h2><div class="cat-nameplate"><b>像素网格整理</b><span>LOCAL EDITION</span></div></div>
    <p class="snap-note">为已有像素画重新对齐网格。在本机检测像素间距，可微调起点并缩减色板。</p>
    <div class="snap-frame"><p>导入一张像素画开始整理</p></div>
    <div class="snap-settings">
      <div class="snap-row"><button type="button" data-action="import">导入图片 ↗</button><input type="file" hidden accept="image/png,image/webp,image/jpeg,image/avif,image/gif">
      <button type="button" data-action="detect" disabled>自动检测网格</button><label>色板 <select name="colors"><option value="0">保留原色</option><option value="8">8 色</option><option value="16">16 色</option><option value="32">32 色</option><option value="64">64 色</option></select></label></div>
      <div class="snap-sliders"><label>像素间距 <output></output><input name="size" type="range" min="1" max="64" value="1"></label><label>水平起点 <output></output><input name="x" type="range" min="0" max="0" value="0"></label><label>垂直起点 <output></output><input name="y" type="range" min="0" max="0" value="0"></label></div>
    </div>
    <footer class="snap-footer"><span role="status"></span><div><button data-action="save" type="button" disabled>下载 PNG</button><button data-action="apply" type="button" disabled>送入图生图 ↗</button></div></footer>`;
  const $ = (selector) => dialog.querySelector(selector);
  const frame = $('.snap-frame'),
    file = $('input[type=file]'),
    status = $('[role=status]'),
    size = $('[name=size]'),
    x = $('[name=x]'),
    y = $('[name=y]'),
    colors = $('[name=colors]');
  const save = $('[data-action=save]'),
    apply = $('[data-action=apply]'),
    detect = $('[data-action=detect]');
  if (!onApply) apply.hidden = true;
  let image,
    snap,
    epoch = 0,
    timer,
    applying = false;
  function render() {
    clearTimeout(timer);
    for (const axis of [x, y]) {
      axis.max = Number(size.value) - 1;
      axis.disabled = axis.max === '0';
    }
    for (const slider of [size, x, y]) slider.previousElementSibling.value = slider.value + ' px';
    if (!image) return;
    save.disabled = apply.disabled = true;
    status.textContent = '正在整理网格…';
    timer = setTimeout(() => {
      try {
        snap = sampleGrid(image, +size.value, +x.value, +y.value, +colors.value);
        snap.result.setAttribute('aria-label', '透明网格上的像素整理预览');
        frame.replaceChildren(snap.result);
        save.disabled = false;
        apply.disabled = applying;
        status.textContent =
          image.width +
          ' × ' +
          image.height +
          ' → ' +
          snap.result.width +
          ' × ' +
          snap.result.height +
          ' px' +
          (snap.palette.length ? ' · ' + snap.palette.length + ' 色' : '');
      } catch (error) {
        snap = null;
        status.textContent = error.message || '处理图像失败';
      }
    }, 40);
  }
  function autoDetect() {
    if (!image) return;
    const grid = readGrid(image);
    size.value = grid.size;
    x.max = y.max = grid.size - 1;
    x.value = grid.x;
    y.value = grid.y;
    render();
  }
  async function load(input) {
    const id = ++epoch;
    status.textContent = '读取图片…';
    clearTimeout(timer);
    snap = null;
    image = null;
    save.disabled = apply.disabled = detect.disabled = true;
    frame.replaceChildren();
    let objectURL;
    try {
      const img = new Image();
      if (input instanceof Blob) img.src = objectURL = URL.createObjectURL(input);
      else {
        const url = new URL(input?.src || input, location.href);
        if (!['data:', 'blob:'].includes(url.protocol) && url.origin !== location.origin)
          throw Error('请使用本地文件或工作台中的图片');
        img.src = url.href;
      }
      await img.decode();
      if (id !== epoch) return;
      if (
        img.naturalWidth * img.naturalHeight > 8388608 ||
        Math.max(img.naturalWidth, img.naturalHeight) > 8192
      )
        throw Error('请选择不超过 8 百万像素且边长不超过 8192 的图像');
      const original = canvas(img.naturalWidth, img.naturalHeight);
      const ctx = original.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      image = ctx.getImageData(0, 0, original.width, original.height);
      detect.disabled = false;
      autoDetect();
    } catch (error) {
      if (id === epoch) status.textContent = error.message || '图片读取失败';
    } finally {
      if (objectURL) URL.revokeObjectURL(objectURL);
    }
  }
  $('.cat-close').onclick = () => dialog.close();
  $('[data-action=import]').onclick = () => file.click();
  file.onchange = () => {
    if (file.files[0]) void load(file.files[0]);
    file.value = '';
  };
  detect.onclick = autoDetect;
  for (const el of [size, x, y, colors]) el.oninput = render;
  save.onclick = async () => {
    if (!snap) return;
    try {
      const blob = await toBlob(snap.result),
        url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'folio-pixel-grid.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      status.textContent = error.message;
    }
  };
  apply.onclick = async () => {
    if (!snap || applying) return;
    applying = true;
    apply.disabled = true;
    try {
      const out = canvas(image.width, image.height),
        ctx = out.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(
        snap.result,
        snap.x0,
        snap.y0,
        snap.result.width * snap.size,
        snap.result.height * snap.size,
      );
      const blob = await toBlob(out);
      if (!dialog.open) return;
      await onApply(new File([blob], 'folio-pixel-grid.png', { type: 'image/png' }));
      dialog.close();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      applying = false;
      apply.disabled = !snap;
    }
  };
  dialog.addEventListener(
    'close',
    () => {
      epoch++;
      clearTimeout(timer);
      image = snap = null;
      dialog.remove();
      if (current === dialog) current = null;
    },
    { once: true },
  );
  document.body.append(dialog);
  dialog.showModal();
  render();
  if (source) void load(source);
}
