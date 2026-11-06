import { listEntries, watchAtlas } from './atlas-store.js';

const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
};
const button = (text, className, action) => {
  const el = node('button', className, text);
  el.type = 'button';
  el.onclick = action;
  return el;
};

// A bounded chooser shared by block examples and the atlas. It never changes a
// work or its metadata; the caller owns copying the selected Blob into the atlas.
function createChooser({ getItems, onChoose, notify = () => {}, imageMode = false }) {
  const dialog = node('dialog', 'ax-dialog' + (imageMode ? '' : ' ax-entry-picker'));
  const titleId = 'atlas-picker-' + crypto.randomUUID();
  dialog.setAttribute('aria-labelledby', titleId);
  const head = node('header', 'ax-head');
  const titleGroup = node('div');
  const eyebrow = node('small', 'ax-eyebrow', imageMode ? 'FOLIO / IMAGE INDEX' : 'FOLIO / CHARACTER INDEX');
  const title = node('h2', '', imageMode ? '选择例图' : '引用 OC');
  title.id = titleId;
  const subtitle = node(
    'p',
    'ax-intro',
    imageMode ? '从作品集带走一张图，或上传新的原图。' : '让角色的名字，带上属于它的外貌。',
  );
  titleGroup.append(eyebrow, title, subtitle);
  const close = button('×', 'ax-close', () => dismiss());
  close.setAttribute('aria-label', '关闭选择器');
  head.append(titleGroup, close);
  const rail = node('div', 'ax-rail');
  const search = node('input', 'ax-search');
  search.type = 'search';
  search.placeholder = imageMode ? '搜索作品的提示词或文件名…' : '搜索名称、外貌或分类…';
  search.setAttribute('aria-label', search.placeholder);
  const upload = button('上传原图 ↗', 'ax-upload', () => file.click());
  const file = node('input');
  file.type = 'file';
  file.accept = 'image/png,image/jpeg,image/webp,image/avif,image/gif';
  file.hidden = true;
  upload.hidden = !imageMode;
  rail.append(search, upload, file);
  const grid = node('div', 'ax-grid');
  grid.setAttribute('aria-label', imageMode ? '可选作品' : '可选条目');
  const status = node('p', 'ax-status');
  status.setAttribute('role', 'status');
  const foot = node('footer', 'ax-foot');
  const count = node('span', '', '');
  foot.append(
    count,
    node('small', '', imageMode ? '仅复制图像，作品集中的原图不变。' : '点击角色，放入独立的多角色提示栏。'),
  );
  dialog.append(head, rail, grid, status, foot);
  document.body.append(dialog);
  let items = [],
    currentOptions = {},
    opener,
    busy = false,
    request = 0;
  const urls = new Map();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  function arrangeCards() {
    const layout = grid.querySelector('.ax-cards');
    if (!layout?._cards?.length || !grid.clientWidth) return;
    const gap = 12;
    const columns = Math.max(1, Math.min(3, Math.floor((grid.clientWidth + gap) / (235 + gap))));
    if (layout.dataset.columns === String(columns)) return;
    layout.dataset.columns = String(columns);
    layout.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
    const lanes = Array.from({ length: columns }, () => node('div', 'ax-column'));
    const heights = Array(columns).fill(0);
    const width = (grid.clientWidth - gap * (columns - 1)) / columns;
    for (const card of layout._cards) {
      const item = card._atlasItem;
      const index = heights.indexOf(Math.min(...heights));
      lanes[index].append(card);
      const ratio = item.width > 0 && item.height > 0 ? item.height / item.width : 1;
      heights[index] +=
        (item.blob instanceof Blob ? width * ratio : 145) + (item.type === 'oc' ? 105 : imageMode ? 65 : 90);
    }
    layout.replaceChildren(...lanes);
  }
  const resizing = new ResizeObserver(arrangeCards);
  resizing.observe(grid);
  const visibility = new IntersectionObserver(
    (entries) => {
      for (const { target, isIntersecting } of entries) {
        if (!isIntersecting) continue;
        const item = target._atlasItem;
        if (item?.blob instanceof Blob) {
          const image = target.querySelector('img');
          const url = URL.createObjectURL(item.blob);
          urls.set(target, url);
          image.src = url;
          image.onload = () => (target.dataset.loaded = 'true');
          image.onerror = () => {
            image.hidden = true;
            target.dataset.loaded = 'error';
          };
        }
        visibility.unobserve(target);
      }
    },
    { root: grid, rootMargin: '0px', threshold: 0.01 },
  );

  function release() {
    visibility.disconnect();
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
  }
  function dismiss() {
    if (busy) return;
    request++;
    dialog.close();
  }
  async function choose(item) {
    if (busy) return;
    busy = true;
    dialog.setAttribute('aria-busy', 'true');
    close.disabled = upload.disabled = true;
    status.textContent = imageMode ? '正在设置例图…' : '正在引用…';
    try {
      await (currentOptions.onSelect || onChoose)?.(item);
      busy = false;
      dismiss();
    } catch (error) {
      status.textContent = error.message || '操作失败，请重试。';
      notify(status.textContent);
    } finally {
      busy = false;
      dialog.removeAttribute('aria-busy');
      close.disabled = upload.disabled = false;
    }
  }
  function render() {
    release();
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = items.filter((item) =>
      [item.name, item.filename, item.prompt, item.category, ...(item.tags || [])]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase()
        .includes(query),
    );
    count.textContent = `${filtered.length} / ${items.length} 项`;
    const cards = filtered.map((item) => {
      const card = button('', 'ax-card', () => choose(item));
      card._atlasItem = item;
      card.dataset.type = item.type || 'work';
      card.dataset.image = String(item.blob instanceof Blob);
      card.setAttribute(
        'aria-label',
        (imageMode ? '选用图像：' : '引用：') + (item.name || item.filename || '未命名'),
      );
      const media = node('span', 'ax-card-media');
      if (item.blob instanceof Blob) {
        const image = node('img');
        image.alt = '';
        image.decoding = 'async';
        if (item.width > 0 && item.height > 0) {
          image.width = item.width;
          image.height = item.height;
        }
        media.append(image);
      } else media.append(node('span', 'ax-card-monogram', item.name || 'OC'));
      const text = node('span', 'ax-card-copy');
      const label = imageMode ? item.filename || '作品' : item.name;
      text.append(
        node('strong', '', label),
        node(
          'small',
          '',
          imageMode
            ? [
                item.width && item.height ? `${item.width} × ${item.height}` : '',
                item.created ? new Date(item.created).toLocaleDateString('zh-CN') : '',
              ]
                .filter(Boolean)
                .join(' · ')
            : item.category || '未分组',
        ),
      );
      if (!imageMode && (item.prompt || item.tags?.length))
        text.append(node('span', 'ax-card-tags', item.prompt || item.tags.join(', ')));
      card.append(media, text);
      return card;
    });
    const layout = node('div', 'ax-cards');
    layout._cards = cards;
    layout.replaceChildren(
      ...(cards.length
        ? cards
        : [
            node(
              'p',
              'ax-empty',
              query
                ? '没有匹配的条目。'
                : imageMode
                  ? '作品集还没有成图，可以先上传一张。'
                  : '还没有保存的 OC。可在「万象集」中创建角色与外貌提示词。',
            ),
          ]),
    );
    grid.replaceChildren(layout);
    arrangeCards();
    for (const card of cards) visibility.observe(card);
    if (!reduced.matches)
      grid.animate(
        [
          { opacity: 0.35, translate: '0 5px' },
          { opacity: 1, translate: '0 0' },
        ],
        { duration: 180, easing: 'ease-out' },
      );
  }
  async function reload() {
    const token = ++request;
    try {
      const result = await getItems(currentOptions);
      if (token !== request || !dialog.open) return;
      items = Array.isArray(result) ? result : [];
      status.textContent = '';
      render();
    } catch (error) {
      if (token !== request || !dialog.open) return;
      grid.replaceChildren(node('p', 'ax-empty', '暂时无法读取条目。'));
      status.textContent = error.message || '读取失败，请重试。';
    }
  }
  search.oninput = render;
  file.onchange = async () => {
    const selected = file.files[0];
    file.value = '';
    if (!selected) return;
    if (selected.size > 96 * 1024 * 1024) {
      status.textContent = '请选择 96 MB 以内的图像。';
      return;
    }
    await choose({ blob: selected, filename: selected.name, uploaded: true });
  };
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    dismiss();
  });
  dialog.addEventListener('close', () => {
    release();
    grid.replaceChildren();
    items = [];
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      dismiss();
  });
  return {
    async open(options = {}) {
      if (busy) return;
      currentOptions = options;
      dialog.classList.toggle('ax-oc-picker', !imageMode && options.type !== 'example');
      eyebrow.textContent = imageMode
        ? 'FOLIO / IMAGE INDEX'
        : options.type === 'example'
          ? 'FOLIO / EXAMPLE INDEX'
          : 'FOLIO / CHARACTER INDEX';
      if (!imageMode)
        foot.lastElementChild.textContent =
          options.type === 'example'
            ? '点击例图，选用这个已保存的词块。'
            : '点击角色，放入独立的多角色提示栏。';
      opener = document.activeElement;
      search.value = '';
      status.textContent = '正在读取…';
      title.textContent = imageMode ? '选择例图' : options.type === 'example' ? '选择词块例图' : '引用 OC';
      if (!dialog.open) dialog.showModal();
      if (!reduced.matches)
        dialog.animate(
          [
            { opacity: 0, translate: '0 12px', scale: '.985' },
            { opacity: 1, translate: '0 0', scale: '1' },
          ],
          { duration: 250, easing: 'cubic-bezier(.22,.75,.25,1)' },
        );
      search.focus({ preventScroll: true });
      await reload();
    },
    refresh() {
      if (dialog.open) void reload();
    },
    close: dismiss,
    destroy() {
      request++;
      release();
      resizing.disconnect();
      dialog.remove();
    },
  };
}

export function mountAtlasPicker({ onInsert, notify, getWorks } = {}) {
  const chooser = createChooser({
    getItems: async ({ type = 'oc' }) => (await listEntries()).filter((entry) => entry.type === type),
    onChoose: onInsert,
    notify,
  });
  const unwatch = watchAtlas(() => chooser.refresh());
  return {
    ...chooser,
    destroy() {
      unwatch();
      chooser.destroy();
    },
  };
}

let imageChooser;
let imageOptions = {};
export function openImagePicker(options = {}) {
  imageOptions = options;
  imageChooser ??= createChooser({
    imageMode: true,
    getItems: () => imageOptions.getWorks?.() || [],
    notify: (message) => imageOptions.notify?.(message),
    onChoose: (item) =>
      imageOptions.onSelect?.(item.blob, {
        workId: item.uploaded ? undefined : item.id,
        work: item.uploaded ? undefined : item,
        filename: item.filename,
      }),
  });
  return imageChooser.open();
}
