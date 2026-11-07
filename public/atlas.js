import {
  ATLAS_TYPES,
  listEntries,
  getEntry,
  saveEntry,
  deleteEntry,
  restoreEntry,
  watchAtlas,
  setEntryImage,
  listCategories,
  saveCategory,
  deleteCategory,
  atlasTags,
} from './atlas-store.js';
import { openImagePicker } from './atlas-picker.js';
import { searchItems } from './fuzzy-search.js';
import { setIcon } from './icons.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function button(label, className, icon) {
  const node = el('button', className);
  node.type = 'button';
  if (icon) {
    const glyph = el('span');
    setIcon(glyph, icon);
    node.append(glyph);
  }
  if (label) node.append(el('span', '', label));
  return node;
}
function closeButton(label = '关闭') {
  const node = button('', 'at-close', 'x');
  node.setAttribute('aria-label', label);
  return node;
}
const fileName = (value) =>
  String(value || '')
    .replace(/\.[a-z0-9]+$/iu, '')
    .replace(/[!\r\n]/gu, '')
    .trim()
    .slice(0, 45);
const count = (value) => String(value).padStart(2, '0');

export function mountAtlas(
  host,
  { getWorks = () => [], onUse = () => {}, onOpenWork, notify = () => {} } = {},
) {
  host.classList.add('atlas-page');
  const abort = new AbortController(),
    motion = matchMedia('(prefers-reduced-motion: reduce)');
  const urls = new Map(),
    observedImages = new Map();
  let entries = [],
    categories = [],
    type = 'all',
    category = '',
    query = '',
    searchTimer,
    composing = false,
    revision = 0,
    refreshTimer,
    dialogURL,
    dialogFocus,
    currentDialogEntry,
    deletedEntry,
    undoTimer,
    disposed = false;
  const heading = el('header', 'at-heading'),
    title = el('div');
  title.append(el('div', 'at-kicker', 'FOLIO / A PERSONAL ATLAS'));
  const h1 = el('h1', '', '万象集');
  h1.append(el('i', '', 'Atlas.'));
  title.append(h1);
  title.append(el('p', 'at-subtitle', '收藏图像，保存角色，让每一次灵感都有来处。'));
  const headerActions = el('div', 'at-heading-actions');
  const importButton = button('导入图片', 'at-secondary', 'upload'),
    createButton = button('新建条目', 'at-primary', 'image-plus');
  importButton.onclick = () => openImport();
  createButton.onclick = () => edit({ type: 'example' });
  headerActions.append(importButton, createButton);
  heading.append(title, headerActions);
  const toolbar = el('div', 'at-toolbar'),
    tabs = el('div', 'at-tabs');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', '收藏类型');
  const tabButtons = new Map();
  for (const [value, label] of [['all', '全部'], ...Object.entries(ATLAS_TYPES)]) {
    const tab = button(label, 'at-tab');
    tab.dataset.atlasType = value;
    tab.append(el('small', '', '00'));
    tab.onclick = () => {
      type = value;
      draw();
    };
    tabs.append(tab);
    tabButtons.set(value, tab);
  }
  const search = el('label', 'at-search'),
    searchIcon = el('span', 'at-search-symbol');
  setIcon(searchIcon, 'search');
  const searchField = el('input');
  searchField.type = 'search';
  searchField.placeholder = '搜索名称、标签或提示词';
  searchField.setAttribute('aria-label', '搜索万象集');
  const searchChanged = () => {
    clearTimeout(searchTimer);
    if (composing) return;
    searchTimer = setTimeout(() => {
      query = searchField.value;
      draw();
    }, 100);
  };
  searchField.oncompositionstart = () => {
    composing = true;
    clearTimeout(searchTimer);
  };
  searchField.oncompositionend = () => {
    composing = false;
    searchChanged();
  };
  searchField.oninput = searchChanged;
  search.append(searchIcon, searchField);
  toolbar.append(tabs, search);
  const categoryBar = el('div', 'at-category-bar'),
    categoryList = el('div', 'at-categories');
  categoryList.setAttribute('role', 'group');
  categoryList.setAttribute('aria-label', '收藏分类');
  const manageCategories = button('管理分类', 'at-text', 'sliders');
  manageCategories.onclick = () => openCategories();
  categoryBar.append(categoryList, manageCategories);
  const line = el('div', 'at-section-line'),
    total = el('span'),
    locality = el('span', '', '只存于此设备 · 原图完整保留');
  line.append(total, locality);
  const undoBar = el('div', 'at-undo'),
    undoText = el('span'),
    undoButton = button('撤销', 'at-text');
  undoBar.hidden = true;
  undoBar.setAttribute('role', 'status');
  undoBar.append(undoText, undoButton);
  undoButton.onclick = async () => {
    if (!deletedEntry) return;
    undoButton.disabled = true;
    try {
      await restoreEntry(deletedEntry);
      deletedEntry = null;
      undoBar.hidden = true;
      clearTimeout(undoTimer);
    } catch (error) {
      notify(error.message);
    } finally {
      undoButton.disabled = false;
    }
  };
  const grid = el('div', 'at-grid');
  grid.setAttribute('aria-label', '万象集条目');
  const status = el('p', 'at-status', '正在翻开收藏…');
  status.setAttribute('role', 'status');
  host.replaceChildren(heading, toolbar, categoryBar, line, undoBar, grid, status);

  const dialog = el('dialog', 'at-dialog');
  dialog.setAttribute('aria-label', '万象集条目');
  const categoryDialog = el('dialog', 'at-category-dialog');
  categoryDialog.setAttribute('aria-label', '管理分类');
  document.body.append(dialog, categoryDialog);
  dialog.addEventListener(
    'close',
    () => {
      if (dialogURL) URL.revokeObjectURL(dialogURL);
      dialogURL = null;
      currentDialogEntry = null;
      if (dialogFocus?.isConnected) dialogFocus.focus({ preventScroll: true });
    },
    { signal: abort.signal },
  );
  for (const item of [dialog, categoryDialog])
    item.addEventListener(
      'click',
      (event) => {
        if (event.target !== item) return;
        const bounds = item.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          item.close();
      },
      { signal: abort.signal },
    );

  const observer = new IntersectionObserver(
    (changes) => {
      for (const change of changes) {
        const entry = observedImages.get(change.target);
        if (!entry) continue;
        const image = change.target.querySelector('img');
        if (change.isIntersecting && change.intersectionRatio > 0 && !host.hidden) {
          if (!image.hasAttribute('src')) {
            if (!urls.has(entry.id)) urls.set(entry.id, URL.createObjectURL(entry.blob));
            image.src = urls.get(entry.id);
          }
        } else image.removeAttribute('src');
      }
    },
    { rootMargin: '0px', threshold: 0 },
  );
  const visibility = new MutationObserver(() => {
    if (!host.hidden) return;
    for (const card of observedImages.keys()) card.querySelector('img')?.removeAttribute('src');
  });
  visibility.observe(host, { attributes: true, attributeFilter: ['hidden'] });
  function clearGrid() {
    observer.disconnect();
    observedImages.clear();
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
    grid.replaceChildren();
  }
  function drawCategories() {
    categoryList.replaceChildren();
    for (const name of ['', ...categories.map((item) => item.name)]) {
      const chip = button(name || '所有分类', 'at-category');
      chip.setAttribute('aria-pressed', String(category === name));
      chip.onclick = () => {
        category = name;
        draw();
      };
      categoryList.append(chip);
    }
  }
  function draw() {
    if (disposed) return;
    clearGrid();
    drawCategories();
    for (const [value, tab] of tabButtons) {
      tab.setAttribute('aria-pressed', String(type === value));
      tab.querySelector('small').textContent = count(
        value === 'all' ? entries.length : entries.filter((entry) => entry.type === value).length,
      );
    }
    let matches = entries.filter(
      (entry) => (type === 'all' || entry.type === type) && (!category || entry.category === category),
    );
    matches = searchItems(matches, query, (entry) => [entry.name, entry.category, ...entry.tags, entry.prompt]);
    total.textContent = count(matches.length) + ' / ' + (type === 'all' ? 'COLLECTION' : type.toUpperCase());
    status.textContent = matches.length
      ? ''
      : query
        ? '没有找到相符的条目。试试名称的一部分，或更换标签。'
        : '这一页还留着空白。导入一张图片，或写下一个新角色。';
    status.hidden = Boolean(matches.length);
    for (const [index, entry] of matches.entries()) {
      const card = el('article', 'at-card');
      card.dataset.entryId = entry.id;
      card.dataset.entryType = entry.type;
      const open = button('', 'at-card-visual');
      open.setAttribute('aria-label', '打开条目：' + entry.name);
      open.onclick = () => openItem(entry.id);
      if (entry.blob) {
        const image = el('img');
        image.alt = entry.name;
        image.decoding = 'async';
        image.loading = 'eager';
        if (entry.width && entry.height) {
          image.width = entry.width;
          image.height = entry.height;
          open.style.aspectRatio = `${entry.width} / ${entry.height}`;
        }
        image.onload = () => {
          image.dataset.loaded = '';
          if (!motion.matches)
            image.animate(
              [
                { opacity: 0, translate: '0 12px' },
                { opacity: 1, translate: '0 0' },
              ],
              { duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)' },
            );
        };
        open.append(image);
        observedImages.set(open, entry);
      } else {
        open.classList.add('at-card-empty');
        open.dataset.kind = entry.type;
        const monogram = el('span', 'at-monogram', entry.type === 'oc' ? 'Oc' : 'Aa');
        const preview = el('span', 'at-preview-text', entry.prompt || '等待一张新的图像');
        open.append(
          el('span', 'at-card-folio', `${ATLAS_TYPES[entry.type]} / ${count(index + 1)}`),
          monogram,
          preview,
          el('small', 'at-awaiting', entry.type === 'material' ? '尚未附图' : '首次引用生图后自动收录'),
        );
      }
      const caption = el('div', 'at-card-caption'),
        nameButton = button(entry.name, 'at-card-name');
      nameButton.onclick = () => openItem(entry.id);
      const use = button('', 'at-card-use', 'arrow-up-right');
      use.title = entry.type === 'material' ? '使用素材' : '引用提示词块';
      use.setAttribute('aria-label', use.title + '：' + entry.name);
      use.onclick = () => useEntry(entry);
      const kindName = ATLAS_TYPES[entry.type];
      const meta = el(
        'div',
        'at-card-meta',
        entry.category === kindName ? kindName : `${kindName} · ${entry.category}`,
      );
      caption.append(nameButton, use, meta);
      if (entry.tags.length) caption.append(el('p', 'at-card-tags', entry.tags.slice(0, 4).join(' · ')));
      card.append(open, caption);
      grid.append(card);
    }
    for (const card of observedImages.keys()) observer.observe(card);
  }
  async function refresh() {
    const token = ++revision;
    try {
      const result = await Promise.all([listEntries(), listCategories()]);
      if (disposed || token !== revision) return;
      [entries, categories] = result;
      if (category && !categories.some((item) => item.name === category)) category = '';
      draw();
    } catch (error) {
      status.textContent = error.message || '万象集暂时无法读取。';
      status.hidden = false;
    }
  }
  const unwatch = watchAtlas(() => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 30);
  });
  async function useEntry(entry) {
    try {
      await onUse(entry);
    } catch (error) {
      notify(error.message);
    }
  }
  function present() {
    const swapping = dialog.open;
    if (!dialog.open) {
      dialogFocus = document.activeElement;
      dialog.showModal();
    }
    // Opening is choreographed by motion.css; an open sheet only cues its new content.
    if (swapping && !motion.matches)
      dialog.animate(
        [
          { opacity: 0, translate: '0 10px' },
          { opacity: 1, translate: '0 0' },
        ],
        { duration: 260, easing: 'cubic-bezier(.2,.75,.2,1)' },
      );
  }
  function picture(blob, name, hostNode) {
    if (dialogURL) URL.revokeObjectURL(dialogURL);
    dialogURL = null;
    hostNode.replaceChildren();
    if (blob) {
      const image = el('img');
      image.alt = name || '条目图像';
      dialogURL = URL.createObjectURL(blob);
      image.src = dialogURL;
      hostNode.append(image);
    } else {
      const empty = el('div', 'at-detail-empty');
      empty.append(el('i', '', 'An image to come.'), el('p', '', '为灵感留一个位置。'));
      hostNode.append(empty);
    }
  }
  function spread(titleText) {
    const frame = el('div', 'at-spread'),
      visual = el('aside', 'at-detail-visual'),
      image = el('div', 'at-detail-image');
    const visualTop = el('div', 'at-detail-edition');
    visualTop.append(el('span', '', 'FOLIO / ATLAS'), el('span', '', 'PERSONAL COLLECTION'));
    visual.append(visualTop, image);
    const sheet = el('section', 'at-detail-sheet'),
      top = el('header', 'at-detail-top'),
      close = closeButton();
    const title = el('h2', '', titleText);
    close.onclick = () => dialog.close();
    top.append(title, close);
    sheet.append(top);
    frame.append(visual, sheet);
    dialog.replaceChildren(frame);
    return { visual, image, sheet, title };
  }
  async function openItem(item) {
    try {
      const entry = typeof item === 'string' ? await getEntry(item) : item;
      if (!entry) return notify('这条收藏已被移除。');
      currentDialogEntry = entry;
      const { visual, image, sheet, title } = spread(entry.name);
      title.dataset.entryType = entry.type;
      picture(entry.blob, entry.name, image);
      const change = button(entry.blob ? '替换图像' : '添加图像', 'at-secondary', 'image-plus');
      change.onclick = () =>
        openImagePicker({
          getWorks,
          notify,
          onSelect: async (blob, info = {}) => {
            await setEntryImage(entry.id, blob, { origin: 'manual', workId: info.workId });
            await openItem(entry.id);
          },
        });
      visual.append(change);
      sheet.append(el('p', 'at-detail-kind', `${ATLAS_TYPES[entry.type]} / ${entry.category}`));
      if (entry.tags.length) {
        const tags = el('div', 'at-detail-tags');
        entry.tags.forEach((tag) => tags.append(el('span', '', tag)));
        sheet.append(tags);
      }
      const prompt = el('section', 'at-detail-prompt');
      prompt.append(
        el('small', 'at-kicker', entry.type === 'oc' ? 'APPEARANCE / 外貌提示词' : 'FIXED PROMPT / 固定提示词'),
      );
      prompt.append(el('p', '', entry.prompt || '这条素材还没有附带提示词。'));
      sheet.append(prompt);
      const note =
        entry.type === 'material'
          ? '素材会以独立原图保存在万象集。'
          : entry.blob
            ? '提示词块已关联，可随时引用或替换示例图。'
            : '实际引用这个词块后，首张成功生成的图像会自动成为封面。';
      prompt.append(el('p', 'at-detail-note', note));
      const footer = el('footer', 'at-detail-actions'),
        use = button('使用此条目', 'at-primary', 'arrow-up-right');
      use.onclick = async () => {
        dialog.close();
        await useEntry(entry);
      };
      const editButton = button('编辑', 'at-secondary', 'pen');
      editButton.onclick = () => edit(entry.id);
      const remove = button('移除', 'at-text', 'trash');
      remove.onclick = async () => {
        remove.disabled = true;
        try {
          const snapshot = await deleteEntry(entry.id);
          if (!snapshot) {
            dialog.close();
            return;
          }
          deletedEntry = snapshot;
          undoText.textContent = '已移除「' + entry.name + '」';
          undoBar.hidden = false;
          clearTimeout(undoTimer);
          undoTimer = setTimeout(() => {
            deletedEntry = null;
            undoBar.hidden = true;
          }, 15000);
          dialog.close();
          notify(
            entry.chunkId ? '已移除条目及关联词块，已有提示词正文与作品仍保留。' : '已移除条目，原作品仍保留。',
          );
        } catch (error) {
          notify(error.message);
        } finally {
          remove.disabled = false;
        }
      };
      footer.append(use, editButton, remove);
      sheet.append(footer);
      const works = await getWorks();
      const original = Array.isArray(works) && works.find((work) => work.id === entry.sourceWorkId);
      if (original && onOpenWork) {
        const source = button('查看来源作品', 'at-source-link');
        source.onclick = () => {
          dialog.close();
          onOpenWork(original);
        };
        visual.append(source);
      }
      present();
    } catch (error) {
      notify(error.message);
    }
  }
  async function edit(item = {}) {
    try {
      const existing = typeof item === 'string' ? await getEntry(item) : item;
      if (!existing) return notify('这条收藏已被移除。');
      const draft = {
        type: 'material',
        name: '',
        category: '',
        tags: [],
        prompt: '',
        blob: null,
        ...structuredClone(existing),
      };
      currentDialogEntry = draft;
      categories = await listCategories();
      const { visual, image, sheet, title } = spread(draft.id ? '编辑条目' : 'A new impression.');
      picture(draft.blob, draft.name, image);
      const replace = button(draft.blob ? '替换图像' : '添加图像', 'at-secondary', 'image-plus');
      replace.onclick = () =>
        openImagePicker({
          getWorks,
          notify,
          onSelect: async (blob, info = {}) => {
            draft.blob = blob;
            draft.imageOrigin = 'manual';
            draft.sourceWorkId = info.workId;
            picture(blob, draft.name, image);
            replace.querySelector('span:last-child').textContent = '替换图像';
            if (!name.value.trim()) name.value = fileName(info.filename || info.work?.filename || blob.name);
          },
        });
      visual.append(replace);
      const form = el('form', 'at-form');
      form.noValidate = true;
      const field = (label, input, hint) => {
        const wrap = el('label', 'at-field');
        wrap.append(el('span', '', label), input);
        if (hint) wrap.append(el('small', '', hint));
        form.append(wrap);
        return wrap;
      };
      const kind = el('select');
      kind.name = 'type';
      kind.setAttribute('aria-label', '条目类型');
      for (const [value, label] of Object.entries(ATLAS_TYPES)) {
        const option = el('option', '', label);
        option.value = value;
        kind.append(option);
      }
      kind.value = draft.type;
      kind.disabled = Boolean(draft.id && draft.chunkId);
      field('条目类型', kind);
      const name = el('input');
      name.name = 'name';
      name.value = draft.name;
      name.maxLength = 60;
      name.placeholder = '给它一个容易找到的名字';
      field('名称', name);
      const categorySelect = el('select');
      categorySelect.name = 'category';
      categorySelect.setAttribute('aria-label', '条目分类');
      for (const item of categories) {
        const option = el('option', '', item.name);
        option.value = item.name;
        categorySelect.append(option);
      }
      if (draft.category && !categories.some((item) => item.name === draft.category))
        categorySelect.append(new Option(draft.category, draft.category));
      categorySelect.value = draft.category || ATLAS_TYPES[draft.type];
      field('分类', categorySelect);
      const tags = el('input');
      tags.name = 'tags';
      tags.value = (draft.tags || []).join(', ');
      tags.placeholder = '场景、发色、主题…';
      field('额外标签', tags, '用逗号分隔，支持中文标签。');
      const prompt = el('textarea');
      prompt.name = 'prompt';
      prompt.value = draft.prompt;
      prompt.rows = 6;
      prompt.maxLength = 100000;
      const promptField = field(
        draft.type === 'oc' ? 'OC 外貌提示词' : '固定提示词',
        prompt,
        'OC 与例图会同步为可引用的提示词块。素材的提示词可以留空。',
      );
      let previousType = draft.type;
      kind.onchange = () => {
        if (!draft.id && categorySelect.value === ATLAS_TYPES[previousType])
          categorySelect.value = ATLAS_TYPES[kind.value];
        previousType = kind.value;
        promptField.firstElementChild.textContent = kind.value === 'oc' ? 'OC 外貌提示词' : '固定提示词';
      };
      const error = el('p', 'at-form-error');
      error.setAttribute('role', 'alert');
      const footer = el('footer', 'at-form-actions'),
        cancel = button('取消', 'at-secondary'),
        save = button('保存条目', 'at-primary', 'arrow-up-right');
      cancel.onclick = () => dialog.close();
      save.type = 'submit';
      footer.append(cancel, save);
      form.append(error, footer);
      sheet.append(form);
      form.onsubmit = async (event) => {
        event.preventDefault();
        save.disabled = true;
        error.textContent = '';
        try {
          const saved = await saveEntry({
            ...draft,
            name: name.value,
            type: kind.value,
            category: categorySelect.value,
            tags: atlasTags(tags.value),
            prompt: prompt.value,
          });
          dialog.close();
          notify('已保存到万象集 · ' + saved.name);
        } catch (failure) {
          error.textContent = failure.message || '保存失败，请稍后重试。';
        } finally {
          save.disabled = false;
        }
      };
      if (!draft.id) title.dataset.new = '';
      present();
      name.focus({ preventScroll: true });
    } catch (error) {
      notify(error.message);
    }
  }
  async function openImport() {
    await openImagePicker({
      getWorks,
      notify,
      onSelect: (blob, info = {}) =>
        edit({
          type: 'material',
          name: fileName(info.filename || info.work?.filename || blob.name || '新素材'),
          blob,
          sourceWorkId: info.workId,
          imageOrigin: 'manual',
          prompt: info.work?.prompt || '',
        }),
    });
  }
  function openSaveWork(work) {
    return edit({
      type: 'material',
      name: fileName(work.filename) || '新的收藏',
      prompt: work.prompt || '',
      blob: work.blob,
      width: work.width,
      height: work.height,
      sourceWorkId: work.id,
      imageOrigin: 'manual',
    });
  }
  async function openCategories() {
    const list = await listCategories();
    const top = el('header', 'at-detail-top'),
      close = closeButton('关闭分类管理');
    close.onclick = () => categoryDialog.close();
    top.append(el('h2', '', '分类'), close);
    const body = el('div', 'at-category-manager'),
      message = el('p', 'at-form-error');
    message.setAttribute('role', 'status');
    for (const item of list) {
      const row = el('div', 'at-category-row'),
        input = el('input');
      input.value = item.name;
      input.maxLength = 30;
      input.setAttribute('aria-label', '分类名称：' + item.name);
      input.readOnly = item.fixed;
      row.append(input);
      if (item.fixed) row.append(el('small', '', '基础分类'));
      else {
        const save = button('保存', 'at-text'),
          del = button('移除', 'at-text');
        save.onclick = async () => {
          try {
            await saveCategory(input.value, item.name);
            await openCategories();
          } catch (error) {
            message.textContent = error.message;
          }
        };
        del.onclick = async () => {
          try {
            await deleteCategory(item.name);
            await openCategories();
          } catch (error) {
            message.textContent = error.message;
          }
        };
        row.append(save, del);
      }
      body.append(row);
    }
    const add = el('form', 'at-category-add'),
      input = el('input');
    input.placeholder = '新的分类名称';
    input.maxLength = 30;
    input.setAttribute('aria-label', '新的分类名称');
    const submit = button('添加分类', 'at-primary');
    submit.type = 'submit';
    add.append(input, submit);
    add.onsubmit = async (event) => {
      event.preventDefault();
      try {
        await saveCategory(input.value);
        await openCategories();
      } catch (error) {
        message.textContent = error.message;
      }
    };
    categoryDialog.replaceChildren(
      top,
      el('p', 'at-detail-note', '类型与分类相互独立。移除分类后，条目回到对应的基础分类。'),
      body,
      add,
      message,
    );
    if (!categoryDialog.open) categoryDialog.showModal();
  }
  void refresh();
  return {
    refresh,
    openItem,
    edit,
    openImport,
    openSaveWork,
    destroy() {
      disposed = true;
      revision++;
      clearTimeout(refreshTimer);
      clearTimeout(searchTimer);
      clearTimeout(undoTimer);
      unwatch();
      abort.abort();
      visibility.disconnect();
      clearGrid();
      dialog.close();
      categoryDialog.close();
      dialog.remove();
      categoryDialog.remove();
      if (dialogURL) URL.revokeObjectURL(dialogURL);
    },
  };
}
