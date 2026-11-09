import { reviewIntent } from './agent-image-intent.js';
import { button, element, icon } from './desktop-agent-elements.js';

export const imageLimit = 4;
const maxDataUrl = 720000;
const supported = new Set(['image/png', 'image/jpeg', 'image/webp']);

// Decode and draw only the pixels. Camera EXIF, embedded NovelAI prompts and
// local filenames never enter the provider request.
export async function imageForModel(blob) {
  if (!(blob instanceof Blob) || !supported.has(blob.type))
    throw Error('请选择 PNG、JPEG 或 WebP 图片。');
  if (!blob.size || blob.size > 24 * 1024 * 1024) throw Error('请选择小于 24 MB 的图片。');
  let bitmap;
  try { bitmap = await createImageBitmap(blob); } catch { throw Error('图片无法解码，请重新选择。'); }
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw Error('当前设备无法读取图片像素。');
    let scale = Math.min(1, 1568 / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 5; attempt++) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg', 0.86);
      if (url.startsWith('data:image/jpeg;base64,') && url.length <= maxDataUrl) return url;
      scale *= 0.72;
    }
    throw Error('图片无法转换为可发送的预览，请缩小图片后重试。');
  } finally { bitmap.close(); }
}

export function attachmentStrip(items, remove) {
  const strip = element('div', 'da-attachments');
  for (const [i, item] of items.entries()) {
    const figure = element('div', 'da-attachment');
    if (item.url?.startsWith('data:image/jpeg;base64,')) {
      const img = element('img');
      img.alt = item.name || '图片 ' + (i + 1);
      img.src = item.url;
      figure.append(img);
    } else figure.append(icon('image-plus'), element('span', '', item.name || '成图'));
    if (remove) figure.append(button('移除' + (item.name || '图片 ' + (i + 1)), 'x', () => remove(i), 'da-remove-image'));
    strip.append(figure);
  }
  return strip;
}

export function visionComposer({ owner, input, isCurrent, persist, changed, notice }) {
  const panel = element('div', 'da-vision');
  const shelf = element('div', 'da-vision-shelf');
  const bar = element('div', 'da-vision-bar');
  const picker = element('input');
  picker.type = 'file';
  picker.accept = [...supported].join(',');
  picker.multiple = true;
  picker.hidden = true;
  const add = button('附图', 'image-plus', () => picker.click(), 'da-vision-add', true);
  add.title = '发送图片到当前对话模型 · 也可直接粘贴';
  const review = button('生成后看图', 'spark', () => {
    owner.draftReview = mode() ? 'off' : 'after';
    save();
  }, 'da-review-toggle', true);
  panel.append(shelf, bar);
  bar.append(add, review, picker);
  let pending = false, displayed;
  function mode() {
    if (owner.draftReview === 'off') return '';
    return owner.draftReview || reviewIntent(input.value);
  }
  function paint() {
    const items = owner.draftImages || [];
    if (displayed !== owner.draftImages) {
      displayed = owner.draftImages;
      shelf.replaceChildren();
      if (items.length) shelf.append(attachmentStrip(items, index => {
        owner.draftImages = items.filter((_, i) => i !== index);
        save();
      }));
    }
    shelf.hidden = !items.length;
    add.disabled = pending || items.length >= imageLimit;
    review.setAttribute('aria-pressed', String(Boolean(mode())));
    const label = mode() === 'last' ? '看上次成图' : '生成后看图';
    review.lastChild.textContent = label;
    review.setAttribute('aria-label', label);
    review.title = mode() === 'last' ? '本轮会把最近一张成图发送给当前对话模型，点击取消'
      : '本轮生成成功后，把成图交给当前对话模型查看';
    changed();
  }
  function save() {
    paint();
    persist(owner.id, { draftImages: owner.draftImages || [], draftReview: owner.draftReview || '' })
      .catch(e => notice(e.message));
  }
  async function files(list) {
    if (!list.length || pending || !isCurrent()) return;
    if (list.length + (owner.draftImages?.length || 0) > imageLimit) { notice('每条消息最多附 4 张图。'); return; }
    pending = true;
    paint();
    try {
      const prepared = [];
      for (const file of list) prepared.push({ name: file.name || '粘贴的图片', url: await imageForModel(file) });
      if (!isCurrent()) return;
      owner.draftImages = [...(owner.draftImages || []), ...prepared];
      save();
      input.focus();
    } catch (e) { notice(e.message); }
    finally { pending = false; if (isCurrent()) paint(); }
  }
  picker.onchange = () => { const selected = [...picker.files]; picker.value = ''; void files(selected); };
  input.addEventListener('paste', e => {
    const images = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (!images.length) return;
    e.preventDefault();
    void files(images);
  });
  function addWork(id, name) {
    if (!isCurrent() || pending) return;
    const items = owner.draftImages || [];
    if (items.some(item => item.workId === id)) { notice('这张成图已附在输入框中。'); return; }
    if (items.length >= imageLimit) { notice('每条消息最多附 4 张图。'); return; }
    owner.draftImages = [...items, { workId: id, name }];
    save();
    input.focus();
  }
  return { panel, mode, paint, addWork, get pending() { return pending; } };
}
