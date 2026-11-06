import { getWork, setWorkScore } from './archive-store.js';
import { workScore } from './archive-scoring.js';
import { MODELS, SAMPLERS, MODES, TOOLS } from './controls-model.js';
import { setIcon } from './icons.js';

const labels = {
  model: '模型',
  dataset: '数据集',
  medium: '运算强度',
  mode: '生成方式',
  seed: '种子',
  steps: '步数',
  scale: 'CFG',
  sampler: '采样器',
  cfgRescale: 'CFG 重缩放',
  noiseSchedule: '噪声调度',
  batch: '批次数量',
  quality: '质量标签',
  uc: '负面预设',
  strength: '重绘强度',
  noise: '噪声强度',
  enhance: '增强',
  transparent: '透明背景',
  variety: '变化增强',
  decrisper: '柔化',
  smea: 'SMEA',
  legacyUC: '旧版负面词',
  focusInpaint: '局部聚焦',
  normalizeVibes: '参考归一化',
  tool: '导演工具',
  toolPrompt: '工具提示词',
  emotion: '表情',
  defry: '色彩削弱',
  blur: '超分降噪',
  useCoords: '角色定位',
};
function display(key, value) {
  if (key === 'model') return MODELS.find(([id]) => id === value)?.[1] || String(value);
  if (key === 'sampler') return SAMPLERS[value] || String(value);
  if (key === 'mode') return MODES[value]?.[0] || String(value);
  if (key === 'tool') return TOOLS[value] || String(value);
  if (key === 'medium') return value ? 'Medium' : 'High';
  if (value === null) return key === 'seed' ? '随机' : '—';
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  return String(value || value === 0 ? value : '—');
}
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function button(text, cls, icon) {
  const node = el('button', cls);
  node.type = 'button';
  if (icon) {
    const glyph = el('span');
    setIcon(glyph, icon);
    node.append(glyph);
  }
  if (text) node.append(el('span', '', text));
  return node;
}

export function mountArchiveAppreciation({
  getWorks = () => [],
  getRecipe = async (work) => work,
  onOpenStudio,
  onReuse,
  onCollect,
  onLineage,
  onDelete,
  onScore = () => {},
  notify = () => {},
} = {}) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const dialog = el('dialog', 'av-dialog'),
    spread = el('div', 'av-spread');
  dialog.setAttribute('aria-label', '作品鉴赏');
  const visual = el('section', 'av-visual'),
    edition = el('div', 'av-edition');
  const imageNumber = el('span'),
    imageDate = el('span');
  edition.append(el('span', '', 'FOLIO / A CLOSER LOOK'), imageDate);
  const plate = el('div', 'av-plate'),
    image = el('img');
  image.alt = '作品原图';
  image.decoding = 'async';
  plate.append(image);
  const imageFooter = el('div', 'av-image-footer'),
    dimension = el('span', 'av-dimensions');
  const browse = el('div', 'av-browse'),
    previous = button('←', 'av-icon'),
    next = button('→', 'av-icon');
  previous.setAttribute('aria-label', '上一张作品');
  next.setAttribute('aria-label', '下一张作品');
  browse.append(previous, imageNumber, next);
  const download = button('', 'av-icon', 'download');
  download.title = '下载原图';
  download.setAttribute('aria-label', '下载原图');
  imageFooter.append(dimension, browse, download);
  visual.append(edition, plate, imageFooter);
  const sheet = el('section', 'av-sheet'),
    top = el('header', 'av-top'),
    title = el('div');
  title.append(el('span', 'av-eyebrow', 'IMAGE APPRECIATION'), el('h2', '', 'In focus.'));
  const closeButton = button('', 'av-close', 'x');
  closeButton.setAttribute('aria-label', '关闭作品鉴赏');
  top.append(title, closeButton);
  const rating = el('section', 'av-rating'),
    ratingHeading = el('div', 'av-rating-heading');
  const scoreText = el('strong', 'av-score-value'),
    scoreHelp = el('span', 'av-score-help', '为这一张留下判断。');
  scoreText.setAttribute('aria-live', 'polite');
  ratingHeading.append(el('span', '', '我的评分'), scoreText);
  const ratingRow = el('div', 'av-rating-row'),
    ratingButtons = [];
  ratingRow.setAttribute('role', 'group');
  ratingRow.setAttribute('aria-label', '为作品评分');
  for (let value = 0; value <= 5; value++) {
    const item = button(String(value), 'av-rating-button');
    item.dataset.score = String(value);
    item.setAttribute('aria-label', value + ' 分');
    item.onclick = () => void rate(value);
    ratingButtons.push(item);
    ratingRow.append(item);
  }
  const clearScore = button('清除', 'av-clear-score');
  clearScore.setAttribute('aria-label', '清除作品评分');
  clearScore.onclick = () => void rate(null);
  ratingRow.append(clearScore);
  rating.append(ratingHeading, ratingRow, scoreHelp);
  const tabs = el('div', 'av-tabs'),
    tabButtons = new Map();
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '作品元数据');
  const content = el('section', 'av-content');
  content.id = 'appreciation-meta';
  content.setAttribute('role', 'tabpanel');
  content.tabIndex = 0;
  for (const [key, label] of [
    ['meta', 'META'],
    ['prompt', '正向'],
    ['negative', '负向'],
    ['characters', '角色'],
  ]) {
    const tab = button(label, 'av-tab');
    tab.id = 'appreciation-tab-' + key;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', content.id);
    tab.onclick = () => {
      selectedTab = key;
      renderMeta();
    };
    tabs.append(tab);
    tabButtons.set(key, tab);
  }
  tabs.onkeydown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const options = [...tabButtons.entries()],
      index = options.findIndex(([key]) => key === selectedTab);
    const position =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length;
    event.preventDefault();
    options[position][1].click();
    options[position][1].focus();
  };
  const footer = el('footer', 'av-actions'),
    openStudio = button('在工作台打开', 'av-primary', 'arrow-up-right');
  openStudio.onclick = () => forward(onOpenStudio);
  const secondary = el('div', 'av-secondary-actions');
  for (const [label, icon, handler] of [
    ['复用 META', 'sliders', onReuse],
    ['收藏', 'bookmark', onCollect],
    ['线索', 'lineage', onLineage],
  ]) {
    const item = button(label, 'av-secondary', icon);
    item.onclick = () => forward(handler);
    item.disabled = !handler;
    secondary.append(item);
  }
  const remove = button('', 'av-secondary av-remove', 'trash');
  remove.title = '删除作品';
  remove.setAttribute('aria-label', '删除作品');
  remove.disabled = !onDelete;
  remove.onclick = async () => {
    if (!work || !onDelete) return;
    remove.disabled = true;
    try {
      if (await onDelete(work)) dialog.close();
    } catch (error) {
      notify(error.message);
    } finally {
      remove.disabled = !onDelete;
    }
  };
  secondary.append(remove);
  footer.append(openStudio, secondary);
  sheet.append(top, rating, tabs, content, footer);
  spread.append(visual, sheet);
  dialog.append(spread);
  document.body.append(dialog);

  let work,
    recipe,
    imageURL,
    opener,
    selectedTab = 'meta',
    ticket = 0,
    writing = false,
    disposed = false;
  function revokeImage() {
    if (imageURL) URL.revokeObjectURL(imageURL);
    imageURL = null;
    image.removeAttribute('src');
  }
  closeButton.onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    ticket++;
    revokeImage();
    work = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    else document.querySelector('#archive-nav')?.focus({ preventScroll: true });
  });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      dialog.close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (
      event.target.closest('.av-tabs, .av-rating, input, textarea, select') ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      navigate(event.key === 'ArrowRight' ? 1 : -1);
    }
  });
  previous.onclick = () => navigate(-1);
  next.onclick = () => navigate(1);
  image.onload = () => {
    if (!work || image.src !== imageURL) return;
    if (!work.width || !work.height) {
      work = { ...work, width: work.width || image.naturalWidth, height: work.height || image.naturalHeight };
      dimension.textContent = `${work.width} × ${work.height} · 完整原图`;
      if (selectedTab === 'meta') renderMeta();
    }
  };
  download.onclick = () => {
    if (!work || !imageURL) return;
    const link = el('a');
    link.href = imageURL;
    link.download = work.filename || 'folio-' + work.id + '.png';
    link.click();
  };
  async function forward(handler) {
    if (!work || !handler) return;
    const selected = work;
    dialog.close();
    try {
      await handler(selected);
    } catch (error) {
      notify(error.message);
    }
  }
  function renderRating() {
    const score = workScore(work);
    scoreText.textContent = score === null ? '未评分' : score + ' / 5';
    scoreText.toggleAttribute('data-unrated', score === null);
    for (const item of ratingButtons) {
      item.setAttribute('aria-pressed', String(Number(item.dataset.score) === score));
      item.disabled = writing;
    }
    clearScore.disabled = writing || score === null;
    scoreHelp.textContent = writing
      ? '正在保存…'
      : score === null
        ? '0–5 分 · 未评分与 0 分分别记录'
        : '评分已存于此设备 · 可随时修改';
  }
  async function rate(score) {
    if (!work || writing) return;
    const id = work.id;
    writing = true;
    renderRating();
    try {
      const updated = await setWorkScore(id, score);
      await onScore(updated);
      if (work?.id === id) work = updated;
      if (!reduced.matches && work?.id === id)
        scoreText.animate(
          [
            { opacity: 0.25, translate: '0 5px' },
            { opacity: 1, translate: '0 0' },
          ],
          { duration: 260, easing: 'ease-out' },
        );
    } catch (error) {
      notify(error.message);
    } finally {
      writing = false;
      if (work) {
        renderRating();
        renderNavigation();
      }
    }
  }
  function renderNavigation() {
    const rows = getWorks(),
      index = rows.findIndex((item) => item.id === work?.id);
    imageNumber.textContent =
      index < 0 ? '—' : `${String(index + 1).padStart(2, '0')} / ${String(rows.length).padStart(2, '0')}`;
    previous.disabled = index <= 0;
    next.disabled = index < 0 || index >= rows.length - 1;
  }
  function navigate(direction) {
    const rows = getWorks(),
      index = rows.findIndex((item) => item.id === work?.id);
    const target = rows[index + direction];
    if (index >= 0 && target) void open(target, { keepTab: true, direction });
  }
  function renderMeta() {
    if (!work) return;
    const settings = recipe?.settings || work.settings || {};
    for (const [key, tab] of tabButtons) {
      tab.setAttribute('aria-selected', String(key === selectedTab));
      tab.tabIndex = key === selectedTab ? 0 : -1;
    }
    content.setAttribute('aria-labelledby', tabButtons.get(selectedTab).id);
    content.replaceChildren();
    content.scrollTop = 0;
    if (selectedTab === 'meta') {
      const facts = el('dl', 'av-facts');
      function fact(label, value) {
        const row = el('div');
        row.append(el('dt', '', label), el('dd', '', value));
        facts.append(row);
      }
      fact('画幅', `${work.width || settings.width || '—'} × ${work.height || settings.height || '—'}`);
      for (const [key, label] of Object.entries(labels))
        if (Object.hasOwn(settings, key)) fact(label, display(key, settings[key]));
      if (!Object.hasOwn(settings, 'model') && work.modelLabel) fact('模型', work.modelLabel);
      if (settings.references?.length) fact('参考素材', settings.references.length + ' 张');
      if (settings.source) fact('输入底图', '已保存');
      if (settings.mask) fact('重绘蒙版', '已保存');
      if (work.operation) fact('操作', work.operation);
      content.append(facts);
    } else if (selectedTab === 'characters') {
      const characters = settings.characters || [];
      if (!characters.length) content.append(el('p', 'av-empty', '这张作品没有独立的角色提示词。'));
      for (const [index, character] of characters.entries()) {
        const block = el('section', 'av-character');
        block.append(
          el(
            'h3',
            '',
            (character.name || '角色 ' + (index + 1)) + (character.enabled === false ? ' · 未启用' : ''),
          ),
        );
        block.append(el('p', 'av-prompt', character.prompt || '未填写正向提示词'));
        if (character.negative)
          block.append(el('small', 'av-eyebrow', 'UNDESIRED'), el('p', 'av-prompt', character.negative));
        const center = character.center || character.centers?.[0];
        if (center) block.append(el('small', 'av-empty', `位置 ${center.x ?? '—'} / ${center.y ?? '—'}`));
        content.append(block);
      }
    } else {
      const value = recipe?.[selectedTab] ?? work[selectedTab] ?? '';
      const head = el('div', 'av-copy-heading'),
        copy = button('复制', 'av-copy');
      head.append(
        el('span', 'av-eyebrow', selectedTab === 'prompt' ? 'POSITIVE PROMPT' : 'UNDESIRED CONTENT'),
        copy,
      );
      copy.disabled = !value;
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(value);
          copy.textContent = '已复制';
        } catch {
          notify('复制失败，请选择正文复制。');
        }
      };
      content.append(head, el('p', value ? 'av-prompt' : 'av-empty', value || '未记录这部分提示词。'));
    }
  }
  async function open(selected, options = {}) {
    if (disposed || !selected) return;
    const version = ++ticket;
    try {
      const latest = (await getWork(selected.id)) || selected;
      const meta = await getRecipe(latest);
      if (disposed || version !== ticket) return;
      work = latest;
      recipe = meta || latest;
      if (!options.keepTab) selectedTab = 'meta';
      revokeImage();
      if (work.blob) {
        imageURL = URL.createObjectURL(work.blob);
        image.src = imageURL;
      }
      image.alt = work.prompt?.slice(0, 100) || '生成作品';
      dimension.textContent = `${work.width || '—'} × ${work.height || '—'} · 完整原图`;
      imageDate.textContent = work.created ? new Date(work.created).toLocaleDateString('zh-CN') : '';
      renderRating();
      renderMeta();
      renderNavigation();
      if (!dialog.open) {
        opener = document.activeElement;
        dialog.showModal();
        closeButton.focus({ preventScroll: true });
      }
      if (!reduced.matches) {
        plate.animate(
          [
            { opacity: 0.2, translate: `${(options.direction || 1) * 12}px 0` },
            { opacity: 1, translate: '0 0' },
          ],
          { duration: 320, easing: 'cubic-bezier(.2,.7,.2,1)' },
        );
        if (!options.keepTab)
          dialog.animate(
            [
              { opacity: 0, translate: '0 10px' },
              { opacity: 1, translate: '0 0' },
            ],
            { duration: 260, easing: 'ease-out' },
          );
      }
    } catch (error) {
      if (version === ticket) notify(error.message || '作品暂时无法打开。');
    }
  }
  return {
    open,
    close: () => dialog.close(),
    destroy() {
      disposed = true;
      ticket++;
      dialog.close();
      revokeImage();
      dialog.remove();
    },
  };
}
