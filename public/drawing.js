import { canvasOf, decodeImage } from './controls-media.js';
import { readDrawingFile, writeDrawingFile } from './drawing-file.js';

const sheet = new URL('./drawing.css', import.meta.url).href;
let recentDrawing = null;
const tools = { brush: '画笔', erase: '橡皮', pick: '取色', clone: '克隆', move: '移动' };
const instructions = {
  brush: '拖动绘制，触控笔可用压感。',
  erase: '擦除当前图层的笔迹。',
  pick: '点按画面吸取颜色。',
  clone: '先点取样，再拖动复制像素。按 Alt 或「重新取样」更换来源。',
  move: '拖动移动当前图层。姿势图层可单独拖动关节。',
};
const bodyJoints = [
  [0.5, 0.18],
  [0.5, 0.3],
  [0.4, 0.31],
  [0.32, 0.45],
  [0.28, 0.58],
  [0.6, 0.31],
  [0.7, 0.41],
  [0.75, 0.29],
  [0.5, 0.56],
  [0.44, 0.55],
  [0.41, 0.72],
  [0.39, 0.91],
  [0.56, 0.55],
  [0.61, 0.73],
  [0.66, 0.9],
];
const limbs = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [1, 5],
  [5, 6],
  [6, 7],
  [1, 8],
  [8, 9],
  [9, 10],
  [10, 11],
  [8, 12],
  [12, 13],
  [13, 14],
];
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
};

function drawLayer(ctx, layer, w, h) {
  if (!layer.visible) return;
  ctx.save();
  ctx.translate(layer.x, layer.y);
  ctx.globalAlpha = layer.opacity;
  if (layer.canvas) ctx.drawImage(layer.canvas, 0, 0);
  else {
    // Canvas-space joints make the pose editable without requiring WebGL.
    const unit = Math.max(1, Math.min(w, h) / 700);
    ctx.strokeStyle = layer.color;
    ctx.fillStyle = layer.color;
    ctx.lineWidth = 10 * unit;
    ctx.lineCap = 'round';
    for (const [a, b] of limbs) {
      ctx.beginPath();
      ctx.moveTo(...layer.joints[a]);
      ctx.lineTo(...layer.joints[b]);
      ctx.stroke();
    }
    const [x, y] = layer.joints[0];
    ctx.beginPath();
    ctx.arc(x, y, 24 * unit, 0, Math.PI * 2);
    ctx.fill();
    for (const [jx, jy] of layer.joints.slice(1)) {
      ctx.beginPath();
      ctx.arc(jx, jy, 8 * unit, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.fillStyle = '#f7f5ee';
      ctx.beginPath();
      ctx.arc(jx, jy, 3 * unit, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();
}

export async function openDrawing({ source = null, width = 832, height = 1216, onApply }) {
  if (!document.querySelector('link[data-folio-drawing]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = sheet;
    link.dataset.folioDrawing = '';
    document.head.append(link);
  }
  let w = Math.round(Number(width)),
    h = Math.round(Number(height));
  if (!(w > 0 && h > 0 && w <= 4096 && h <= 4096 && w * h <= 4_194_304))
    throw Error('请选择 419 万像素以内的画布尺寸。');
  const sameBase =
    recentDrawing &&
    source === recentDrawing.source &&
    recentDrawing.inputWidth === w &&
    recentDrawing.inputHeight === h;
  const sameOutput =
    source &&
    recentDrawing &&
    source === recentDrawing.output &&
    recentDrawing.width === w &&
    recentDrawing.height === h;
  const remembered = sameBase || sameOutput ? recentDrawing : null;
  const inputWidth = w,
    inputHeight = h;
  let output = remembered?.output || null;
  const im = source && !remembered ? await decodeImage(source) : null;
  let serial = 0;
  const newLayer = (name, canvas = null) => ({
    id: ++serial,
    name,
    canvas,
    x: 0,
    y: 0,
    visible: true,
    opacity: 1,
  });
  let layers, selected;
  if (remembered) {
    ({ width: w, height: h, layers, selected } = remembered);
    serial = Math.max(...layers.map((l) => l.id));
  } else {
    const base = newLayer(im ? '底图' : '纸张', canvasOf(w, h));
    const context = base.canvas.getContext('2d');
    if (im) fitImage(context, im);
    else {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, w, h);
    }
    const ink = newLayer('画层 01', canvasOf(w, h));
    layers = [base, ink];
    selected = ink.id;
  }
  let mode = 'brush',
    sampling = null,
    drag = null,
    applyBusy = false;
  const undo = [],
    redo = [];
  const dlg = el('dialog', '', 'folio-draw');
  dlg.setAttribute('aria-label', '绘图画布');
  dlg.innerHTML =
    '<header><div><small>FOLIO　/　DRAWING ROOM</small><h2>绘图画布</h2></div><div class="fd-project-actions"><button data-action="open-project">打开画布</button><button data-action="save-project">保存画布</button><button data-action="close" aria-label="关闭画布">×</button></div></header>' +
    '<div class="fd-tools" role="toolbar" aria-label="绘图工具"></div><div class="fd-body"><div class="fd-stage"><canvas aria-label="绘图区域"></canvas></div>' +
    '<aside><small>INK</small><label class="fd-ink">笔色 <input type="color" value="#292c36" aria-label="笔色"></label>' +
    '<label>笔径 <output class="fd-size-value">24 px</output><input type="range" class="fd-size" min="1" max="192" value="24"></label>' +
    '<div class="fd-layers-title"><small>LAYERS</small><b>图层</b></div><div class="fd-layers"></div>' +
    '<label>不透明度 <output class="fd-opacity-value"></output><input type="range" class="fd-opacity" min="0" max="100"></label>' +
    '<div class="fd-layer-actions"><button data-action="add">＋ 画层</button><button data-action="pose">＋ 线架</button><button data-action="three">＋ 三维 / GLB</button><button data-action="edit3d">编辑三维</button><button data-action="import">导入图片</button>' +
    '<button data-action="up">上移</button><button data-action="down">下移</button><button data-action="remove">删除层</button></div>' +
    '<input class="fd-image-file" type="file" accept="image/png,image/jpeg,image/webp" hidden><input class="fd-project-file" type="file" accept=".foliocanvas" hidden></aside></div>' +
    '<footer><div><span class="fd-format"></span><p class="fd-hint" role="status"></p></div><button class="fd-apply" data-action="apply">用作图生图底图 ↗</button></footer>';
  document.body.append(dlg);
  const $ = (q) => dlg.querySelector(q);
  const surface = $('canvas');
  surface.width = w;
  surface.height = h;
  const ctx = surface.getContext('2d', { willReadFrequently: true });
  const color = $('[type=color]'),
    size = $('.fd-size'),
    opacity = $('.fd-opacity'),
    hint = $('.fd-hint');
  const active = () => layers.find((l) => l.id === selected);
  $('.fd-format').textContent = w + ' × ' + h + '　/　RGBA';
  const toolRow = $('.fd-tools');
  for (const [id, title] of Object.entries(tools)) {
    const b = el('button', title);
    b.dataset.tool = id;
    toolRow.append(b);
  }
  for (const [id, title] of [
    ['sample', '重新取样'],
    ['undo', '撤销'],
    ['redo', '重做'],
  ]) {
    const b = el('button', title);
    b.dataset.action = id;
    toolRow.append(b);
  }

  function fitImage(c, image) {
    const scale = Math.min(w / image.naturalWidth, h / image.naturalHeight);
    const rw = image.naturalWidth * scale,
      rh = image.naturalHeight * scale;
    c.drawImage(image, (w - rw) / 2, (h - rh) / 2, rw, rh);
  }
  function render() {
    ctx.clearRect(0, 0, w, h);
    for (const layer of layers) drawLayer(ctx, layer, w, h);
  }
  function controls() {
    for (const b of dlg.querySelectorAll('[data-tool]'))
      b.setAttribute('aria-pressed', String(b.dataset.tool === mode));
    $('[data-action=sample]').hidden = mode !== 'clone';
    $('[data-action=undo]').disabled = !undo.length;
    $('[data-action=redo]').disabled = !redo.length;
    $('[data-action=up]').disabled = layers.at(-1).id === selected;
    $('[data-action=down]').disabled = layers[0].id === selected;
    $('[data-action=remove]').disabled = layers.length === 1;
    $('[data-action=edit3d]').disabled = !active().scene3d;
    const list = $('.fd-layers');
    list.replaceChildren();
    for (const layer of [...layers].reverse()) {
      const row = el('div', '', 'fd-layer'),
        select = el('button', layer.name),
        visibility = el('button', layer.visible ? '●' : '○');
      select.dataset.select = layer.id;
      select.setAttribute('aria-pressed', String(layer.id === selected));
      visibility.dataset.visibility = layer.id;
      visibility.setAttribute('aria-label', (layer.visible ? '隐藏' : '显示') + layer.name);
      visibility.title = visibility.getAttribute('aria-label');
      row.append(select, visibility);
      list.append(row);
    }
    opacity.value = Math.round(active().opacity * 100);
    $('.fd-opacity-value').textContent = opacity.value + '%';
    hint.textContent = instructions[mode];
  }
  function state() {
    return { layers: layers.slice(), selected };
  }
  function restore(snapshot) {
    layers = snapshot.layers;
    selected = snapshot.selected;
    render();
    controls();
  }
  function checkpoint() {
    undo.push(state());
    redo.length = 0;
    const maxCanvases = Math.max(layers.length + 1, Math.floor((96 * 1024 * 1024) / (w * h * 4)));
    while (undo.length > 1) {
      const memory = new Set(
        [...layers, ...undo.flatMap((s) => s.layers)].map((l) => l.canvas).filter(Boolean),
      );
      if (undo.length <= 20 && memory.size < maxCanvases) break;
      undo.shift();
    }
  }
  function changeLayer(updated) {
    layers = layers.map((l) => (l.id === updated.id ? updated : l));
  }
  function insertLayer(layer) {
    if (layers.length >= 10) throw Error('画布最多可使用 10 个图层。');
    const index = layers.findIndex((l) => l.id === selected) + 1;
    layers = [...layers.slice(0, index), layer, ...layers.slice(index)];
    selected = layer.id;
  }
  function history(from, to) {
    if (!from.length || drag) return;
    to.push(state());
    restore(from.pop());
  }
  function point(e) {
    const r = surface.getBoundingClientRect();
    return {
      x: clamp(((e.clientX - r.left) / r.width) * w, 0, w - 0.01),
      y: clamp(((e.clientY - r.top) / r.height) * h, 0, h - 0.01),
    };
  }
  function sample(p) {
    const rgb = ctx.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
    color.value = '#' + Array.from(rgb.slice(0, 3), (v) => v.toString(16).padStart(2, '0')).join('');
    mode = 'brush';
    controls();
    hint.textContent = '已取色 ' + color.value;
  }
  function drawStroke(p, event) {
    const localX = p.x - drag.layer.x,
      localY = p.y - drag.layer.y;
    const previous = drag.prev || p;
    const rc = drag.context;
    const radius =
      (Number(size.value) / 2) * (event.pointerType === 'pen' ? clamp(event.pressure * 1.65, 0.18, 1.3) : 1);
    rc.save();
    if (mode === 'clone') {
      const distance = Math.hypot(p.x - previous.x, p.y - previous.y),
        count = Math.max(1, Math.ceil(distance / Math.max(1, radius * 0.4)));
      for (let i = 1; i <= count; i++) {
        const x = previous.x + ((p.x - previous.x) * i) / count - drag.layer.x,
          y = previous.y + ((p.y - previous.y) * i) / count - drag.layer.y;
        rc.save();
        rc.beginPath();
        rc.arc(x, y, radius, 0, Math.PI * 2);
        rc.clip();
        rc.drawImage(
          drag.sampleCanvas,
          drag.start.x - sampling.x - drag.layer.x,
          drag.start.y - sampling.y - drag.layer.y,
        );
        rc.restore();
      }
    } else {
      rc.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';
      rc.lineCap = 'round';
      rc.lineJoin = 'round';
      rc.lineWidth = radius * 2;
      rc.fillStyle = rc.strokeStyle = color.value;
      if (!drag.prev) {
        rc.beginPath();
        rc.arc(localX, localY, radius, 0, Math.PI * 2);
        rc.fill();
      } else {
        rc.beginPath();
        rc.moveTo(previous.x - drag.layer.x, previous.y - drag.layer.y);
        rc.lineTo(localX, localY);
        rc.stroke();
      }
    }
    rc.restore();
    drag.prev = p;
    render();
  }
  surface.onpointerdown = (e) => {
    if (e.button !== 0 || drag || applyBusy) return;
    const p = point(e);
    if (mode === 'pick') {
      sample(p);
      return;
    }
    if (mode === 'clone' && (!sampling || e.altKey)) {
      sampling = p;
      hint.textContent = '已取样，拖动以克隆图像。';
      return;
    }
    if (!active().visible) {
      hint.textContent = '请先显示所选图层。';
      return;
    }
    if ((active().joints || active().scene3d) && mode !== 'move' && layers.length >= 10) {
      hint.textContent = '请先选择一个可绘制的图层。';
      return;
    }
    if (active().scene3d && mode === 'erase') {
      hint.textContent = '三维图层可单独编辑，请在笔迹图层使用橡皮。';
      return;
    }
    checkpoint();
    let layer = active();
    let sampleCanvas;
    if (mode === 'clone') {
      sampleCanvas = canvasOf(w, h);
      sampleCanvas.getContext('2d').drawImage(surface, 0, 0);
    }
    if (mode === 'move') {
      let joint = -1,
        near = (26 * w) / surface.getBoundingClientRect().width;
      layer.joints?.forEach(([x, y], i) => {
        const d = Math.hypot(p.x - x - layer.x, p.y - y - layer.y);
        if (d < near) {
          near = d;
          joint = i;
        }
      });
      drag = { id: e.pointerId, layer, joint, start: p };
    } else {
      if ((!layer.canvas || layer.scene3d) && mode !== 'erase') {
        layer = newLayer('笔迹 ' + (serial + 1), canvasOf(w, h));
        insertLayer(layer);
      }
      const clone = canvasOf(w, h),
        paint = clone.getContext('2d');
      if (layer.canvas) paint.drawImage(layer.canvas, 0, 0);
      else drawLayer(paint, { ...layer, x: 0, y: 0, opacity: 1 }, w, h);
      const updated = { ...layer, canvas: clone, joints: undefined };
      changeLayer(updated);
      drag = { id: e.pointerId, layer: updated, start: p, context: paint, sampleCanvas };
      drawStroke(p, e);
    }
    surface.setPointerCapture(e.pointerId);
    controls();
  };
  surface.onpointermove = (e) => {
    if (drag?.id !== e.pointerId) return;
    const p = point(e);
    if (mode !== 'move') return drawStroke(p, e);
    const layer = drag.layer;
    if (drag.joint >= 0) {
      const joints = layer.joints.slice();
      joints[drag.joint] = [p.x - layer.x, p.y - layer.y];
      changeLayer({ ...layer, joints });
    } else changeLayer({ ...layer, x: layer.x + p.x - drag.start.x, y: layer.y + p.y - drag.start.y });
    render();
  };
  surface.onpointerup =
    surface.onpointercancel =
    surface.onlostpointercapture =
      () => {
        drag = null;
      };
  size.oninput = () => {
    $('.fd-size-value').textContent = size.value + ' px';
  };
  // Range changes commit once for each keyboard step or completed pointer gesture.
  let opacityStart = null;
  opacity.oninput = () => {
    if (!opacityStart) {
      checkpoint();
      opacityStart = selected;
    }
    changeLayer({ ...active(), opacity: Number(opacity.value) / 100 });
    $('.fd-opacity-value').textContent = opacity.value + '%';
    render();
  };
  opacity.onchange = () => {
    opacityStart = null;
    controls();
  };
  dlg.onkeydown = (e) => {
    if (applyBusy) return;
    if (!(e.ctrlKey || e.metaKey) || !['z', 'y'].includes(e.key.toLowerCase())) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key.toLowerCase() === 'y' || e.shiftKey) history(redo, undo);
    else history(undo, redo);
  };
  const projectFile = $('.fd-project-file');
  projectFile.onchange = async () => {
    const chosen = projectFile.files[0];
    projectFile.value = '';
    if (!chosen || applyBusy) return;
    applyBusy = true;
    hint.textContent = '正在还原图层…';
    try {
      const loaded = await readDrawingFile(chosen);
      if (!dlg.open) return;
      ({ width: w, height: h, layers, selected } = loaded);
      surface.width = w;
      surface.height = h;
      serial = Math.max(...layers.map((l) => l.id));
      undo.length = redo.length = 0;
      sampling = null;
      output = null;
      mode = 'move';
      $('.fd-format').textContent = w + ' × ' + h + '　/　RGBA';
      render();
      controls();
      hint.textContent = '已还原 ' + layers.length + ' 个图层。';
    } catch (error) {
      hint.textContent = error.message;
    } finally {
      applyBusy = false;
    }
  };
  const file = $('.fd-image-file');
  file.onchange = async () => {
    const choice = file.files[0];
    file.value = '';
    if (!choice) return;
    try {
      const picture = await decodeImage(choice);
      if (!dlg.open) return;
      const canvas = canvasOf(w, h);
      fitImage(canvas.getContext('2d'), picture);
      if (layers.length >= 10) throw Error('画布最多可使用 10 个图层。');
      checkpoint();
      insertLayer(newLayer(choice.name, canvas));
      mode = 'move';
      render();
      controls();
    } catch (error) {
      hint.textContent = error.message;
    }
  };
  dlg.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b || drag || applyBusy) return;
    const act = b.dataset.action;
    if (b.dataset.tool) {
      mode = b.dataset.tool;
      controls();
      return;
    }
    if (b.dataset.select) {
      selected = Number(b.dataset.select);
      controls();
      return;
    }
    try {
      if (b.dataset.visibility) {
        const layer = layers.find((l) => l.id === Number(b.dataset.visibility));
        checkpoint();
        changeLayer({ ...layer, visible: !layer.visible });
      } else if (act === 'undo') return history(undo, redo);
      else if (act === 'redo') return history(redo, undo);
      else if (act === 'close') return dlg.close();
      else if (act === 'open-project') return projectFile.click();
      else if (act === 'save-project') {
        applyBusy = true;
        try {
          hint.textContent = '正在保存图层…';
          const blob = await writeDrawingFile({ width: w, height: h, ...state() });
          if (!dlg.open) return;
          const url = URL.createObjectURL(blob),
            link = el('a');
          link.href = url;
          link.download =
            'Folio-' + w + 'x' + h + '-' + new Date().toISOString().slice(0, 10) + '.foliocanvas';
          dlg.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 60000);
          hint.textContent = '已导出可继续编辑的画布文件。';
        } finally {
          applyBusy = false;
        }
        return;
      } else if (act === 'sample') sampling = null;
      else if (act === 'import') return file.click();
      else if (act === 'three' || act === 'edit3d') {
        if (act === 'three' && layers.length >= 10) throw Error('画布最多可使用 10 个图层。');
        const editing = act === 'edit3d' ? active() : null;
        const { editThreeLayer } = await import('./drawing-3d.js');
        if (!dlg.open) return;
        return await editThreeLayer({
          width: w,
          height: h,
          previous: editing?.scene3d,
          onSave: ({ canvas, scene3d, name }) => {
            checkpoint();
            if (editing) changeLayer({ ...editing, name, canvas, scene3d });
            else insertLayer({ ...newLayer(name, canvas), scene3d });
            mode = 'move';
            render();
            controls();
          },
        });
      } else if (act === 'apply') {
        applyBusy = true;
        b.disabled = true;
        const data = surface.toDataURL('image/png');
        await onApply(data);
        output = data;
        dlg.close();
        return;
      } else if (act === 'add' || act === 'pose') {
        if (layers.length >= 10) throw Error('画布最多可使用 10 个图层。');
        checkpoint();
        if (act === 'add') {
          insertLayer(newLayer('画层 ' + String(serial + 1).padStart(2, '0'), canvasOf(w, h)));
          mode = 'brush';
        } else {
          insertLayer({
            ...newLayer('姿势 ' + (serial + 1)),
            color: color.value,
            joints: bodyJoints.map(([x, y]) => [x * w, y * h]),
          });
          mode = 'move';
        }
      } else if (act === 'remove') {
        if (layers.length === 1) return;
        const old = layers.findIndex((l) => l.id === selected);
        checkpoint();
        layers = layers.filter((l) => l.id !== selected);
        selected = layers[Math.min(old, layers.length - 1)].id;
      } else if (act === 'up' || act === 'down') {
        const i = layers.findIndex((l) => l.id === selected),
          dest = i + (act === 'up' ? 1 : -1);
        if (dest < 0 || dest >= layers.length) return;
        checkpoint();
        layers = layers.slice();
        [layers[i], layers[dest]] = [layers[dest], layers[i]];
      } else return;
      render();
      controls();
    } catch (error) {
      hint.textContent = error.message;
      applyBusy = false;
      $('[data-action=apply]').disabled = false;
    }
  };
  dlg.addEventListener(
    'close',
    () => {
      recentDrawing = { width: w, height: h, inputWidth, inputHeight, source, output, ...state() };
      drag = null;
      layers = [];
      undo.length = redo.length = 0;
      dlg.remove();
    },
    { once: true },
  );
  render();
  controls();
  if (remembered) hint.textContent = '已恢复本标签页的画布与图层。';
  dlg.showModal();
}
