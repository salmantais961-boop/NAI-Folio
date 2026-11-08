import { MODELS, SAMPLERS, TOOLS } from './controls-model.js';
import { getHideNSFW } from './content-preferences.js';
import { classifyWorkNSFW } from './nsfw-tags.js';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = (value) => structuredClone(value);
const parameterLabels = {
  steps: '步数',
  scale: 'CFG 引导',
  sampler: '采样器',
  cfgRescale: 'CFG 重缩放',
  noiseSchedule: '噪声调度',
  batch: '生成张数',
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
};
const labels = {
  anime: 'Anime',
  furry: 'Furry',
  background: 'Background',
  off: '关闭',
  none: '无',
  standard: '标准',
  light: '轻度',
  heavy: '强力',
  normal: '标准',
  max: 'Max',
};
function display(key, value) {
  if (key === 'model') return MODELS.find(([id]) => id === value)?.[1] || String(value);
  if (key === 'sampler') return SAMPLERS[value] || String(value);
  if (key === 'tool') return TOOLS[value] || String(value);
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (value === '') return '空';
  return labels[value] || String(value);
}

/** Only these groups can be applied: missing metadata never turns into defaults. */
export function metaReuseGroups(recipe = {}) {
  const settings = recipe.settings && typeof recipe.settings === 'object' ? recipe.settings : {};
  const pick = (keys) =>
    Object.fromEntries(keys.filter((key) => own(settings, key)).map((key) => [key, clone(settings[key])]));
  const basic = pick(['model', 'dataset', 'medium']);
  const parameters = pick(Object.keys(parameterLabels));
  const mediaPresent = Boolean(settings.source || settings.mask || settings.references?.length);
  const media = mediaPresent ? pick(['source', 'mask', 'references', 'mode']) : {};
  const characters = Array.isArray(settings.characters) ? pick(['characters', 'useCoords']) : {};
  return [
    {
      id: 'basic',
      title: '基础 META',
      eyebrow: 'IDENTITY',
      patch: { settings: basic },
      available: Object.keys(basic).length > 0,
    },
    {
      id: 'prompt',
      title: '正向提示词',
      eyebrow: 'PROMPT',
      patch: typeof recipe.prompt === 'string' ? { prompt: recipe.prompt } : {},
      available: typeof recipe.prompt === 'string',
    },
    {
      id: 'negative',
      title: '负向提示词',
      eyebrow: 'UNDESIRED',
      patch: typeof recipe.negative === 'string' ? { negative: recipe.negative } : {},
      available: typeof recipe.negative === 'string',
    },
    {
      id: 'seed',
      title: '种子',
      eyebrow: 'SEED',
      patch: { settings: pick(['seed']) },
      available: own(settings, 'seed') && (settings.seed === null || Number.isFinite(settings.seed)),
    },
    {
      id: 'size',
      title: '画幅尺寸',
      eyebrow: 'DIMENSIONS',
      patch: { settings: pick(['width', 'height']) },
      available:
        Number.isFinite(settings.width) &&
        settings.width > 0 &&
        Number.isFinite(settings.height) &&
        settings.height > 0,
    },
    {
      id: 'parameters',
      title: '生图参数',
      eyebrow: 'RECIPE',
      patch: { settings: parameters },
      available: Object.keys(parameters).length > 0,
    },
    {
      id: 'characters',
      title: '角色提示与位置',
      eyebrow: 'CHARACTERS',
      patch: { settings: characters },
      available: own(characters, 'characters'),
    },
    {
      id: 'media',
      title: '底图与参考素材',
      eyebrow: 'REFERENCES',
      patch: { settings: media },
      available: mediaPresent,
      optional: true,
    },
  ];
}

export function selectedMetaPatch(recipe, selected) {
  const wanted = new Set(selected);
  const patch = {};
  for (const group of metaReuseGroups(recipe)) {
    if (!group.available || !wanted.has(group.id)) continue;
    const { settings, ...text } = clone(group.patch);
    Object.assign(patch, text);
    if (settings) patch.settings = { ...patch.settings, ...settings };
  }
  return patch;
}

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(text, className = '') {
  const el = element('button', className, text);
  el.type = 'button';
  return el;
}
function glyph(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute(
    'd',
    {
      close: 'm6 6 12 12M6 18 18 6',
      arrow: 'M4 12h16m-6-6 6 6-6 6',
      check: 'm5 12 4 4L19 6',
      image: 'M4 4h16v16H4zM4 15l5-6 6 6 3-3 2 2',
    }[kind],
  );
  svg.append(path);
  return svg;
}

export function mountMetaReuse({ getRecipe, getImageUrl, onApply, notify = () => {} } = {}) {
  const dialog = element('dialog', 'mr-dialog');
  const id = 'meta-reuse-' + crypto.randomUUID();
  dialog.setAttribute('aria-labelledby', id);
  const spread = element('div', 'mr-spread');
  const visual = element('aside', 'mr-visual');
  const edition = element('div', 'mr-edition');
  edition.append(element('span', '', 'FOLIO / SOURCE'), element('span', 'mr-edition-number', '01'));
  const plate = element('div', 'mr-plate');
  const image = element('img', 'mr-image');
  image.alt = '待复用元数据的原图';
  image.decoding = 'async';
  const placeholder = element('div', 'mr-placeholder');
  placeholder.append(
    glyph('image'),
    element('span', '', 'Metadata only'),
    element('small', '', '该配方未附带预览图'),
  );
  plate.append(image, placeholder);
  const imageCaption = element('div', 'mr-image-caption');
  visual.append(edition, plate, imageCaption);
  const sheet = element('section', 'mr-sheet');
  const header = element('header', 'mr-header');
  const titleGroup = element('div');
  titleGroup.append(element('small', 'mr-kicker', 'SELECT · KEEP · CREATE'));
  const heading = element('h2', '', 'Reuse');
  heading.id = id;
  heading.append(element('i', '', 'the details.'));
  titleGroup.append(heading, element('p', 'mr-intro', '把灵感延续下去。选择这次想带走的 META。'));
  const closeButton = button('', 'mr-close');
  closeButton.setAttribute('aria-label', '关闭元数据复用');
  closeButton.append(glyph('close'));
  header.append(titleGroup, closeButton);
  const selectionBar = element('div', 'mr-selection-bar');
  const count = element('span', 'mr-selection-count');
  count.setAttribute('aria-live', 'polite');
  const all = button('全选', 'mr-text-button');
  const none = button('清空', 'mr-text-button');
  const toggleGroup = element('div', 'mr-toggle-group');
  toggleGroup.append(all, none);
  selectionBar.append(count, toggleGroup);
  const list = element('div', 'mr-list');
  const message = element('p', 'mr-message');
  message.setAttribute('role', 'status');
  const footer = element('footer', 'mr-footer');
  const footnote = element('p', '', '未勾选的内容，保留工作台当前设置。');
  const footerActions = element('div', 'mr-footer-actions');
  const cancel = button('取消', 'mr-cancel');
  const apply = button('', 'mr-apply');
  const applyLabel = element('span', '', '复用所选');
  apply.append(applyLabel, glyph('arrow'));
  footerActions.append(cancel, apply);
  footer.append(footnote, footerActions);
  sheet.append(header, selectionBar, list, message, footer);
  spread.append(visual, sheet);
  dialog.append(spread);
  document.body.append(dialog);

  let currentWork = null;
  let currentRecipe = null;
  let epoch = 0;
  let applying = false;
  let opener = null;
  let ownedUrl = null;
  const boxes = new Map();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  function releaseImage() {
    image.removeAttribute('src');
    if (ownedUrl) URL.revokeObjectURL(ownedUrl);
    ownedUrl = null;
  }
  function displayPreview() {
    releaseImage();
    image.hidden = true;
    placeholder.hidden = false;
    const hidden = getHideNSFW() && (classifyWorkNSFW(currentWork).nsfw || classifyWorkNSFW(currentRecipe).nsfw);
    placeholder.querySelector('small').textContent = hidden ? 'NSFW · 图像已隐藏' : '该配方未附带预览图';
    if (hidden || !currentWork || !currentRecipe) return;
    try {
      let url = getImageUrl?.(currentWork);
      if (!url && currentWork.blob instanceof Blob) url = ownedUrl = URL.createObjectURL(currentWork.blob);
      if (url) image.src = url;
    } catch { /* The recipe is still usable when its preview is unavailable. */ }
  }
  const preferencesChanged = () => { if (dialog.open) displayPreview(); };
  window.addEventListener('folio:content-preferences', preferencesChanged);
  function selection() {
    return [...boxes].filter(([, input]) => input.checked && !input.disabled).map(([key]) => key);
  }
  function syncSelection() {
    const selected = selection().length;
    const available = [...boxes.values()].filter((input) => !input.disabled).length;
    count.textContent = `已选择 ${selected} / ${available} 项`;
    apply.disabled = !selected || applying;
    all.disabled = !available || applying;
    none.disabled = !selected || applying;
    for (const input of boxes.values())
      input.closest('.mr-field').dataset.selected = String(input.checked && !input.disabled);
    applyLabel.textContent = applying ? '正在载入…' : `复用所选${selected ? ' · ' + selected : ''}`;
  }
  function addStat(host, label, value) {
    const stat = element('div', 'mr-stat');
    stat.append(element('dt', '', label), element('dd', '', value));
    host.append(stat);
  }
  function contentFor(group) {
    const body = element('div', 'mr-field-content');
    if (!group.available) {
      body.append(element('span', 'mr-missing', '原始 META 未记录此项'));
      return body;
    }
    const data = group.patch.settings || {};
    if (group.id === 'prompt' || group.id === 'negative') {
      const value = group.patch[group.id];
      const text = element('p', 'mr-prompt', value || '空提示词 · 复用后会清空此输入框');
      if (!value) text.classList.add('mr-missing');
      body.append(text);
    } else if (group.id === 'basic') {
      const stats = element('dl', 'mr-stats');
      for (const [key, label] of [
        ['model', '模型'],
        ['dataset', '数据集'],
        ['medium', '运算强度'],
      ]) {
        if (own(data, key))
          addStat(stats, label, key === 'medium' ? (data.medium ? 'Medium' : 'High') : display(key, data[key]));
      }
      body.append(stats);
    } else if (group.id === 'seed') {
      body.append(element('strong', 'mr-numeric', data.seed === null ? '随机种子' : String(data.seed)));
    } else if (group.id === 'size') {
      body.append(
        element('strong', 'mr-numeric', `${data.width} × ${data.height}`),
        element('small', 'mr-unit', 'PX'),
      );
    } else if (group.id === 'parameters') {
      const stats = element('dl', 'mr-stats mr-parameter-stats');
      for (const [key, value] of Object.entries(data))
        addStat(stats, parameterLabels[key], display(key, value));
      if (currentRecipe?.settings?.medium) {
        body.append(
          element('p', 'mr-note', 'Medium 生效时固定 14 步、Euler Ancestral；下列其余值为保存的设置。'),
        );
      }
      const detail = element('details', 'mr-parameter-details');
      const summary = element('summary', '', `${Object.keys(data).length} 项参数`);
      summary.append(element('span', '', '展开查看'));
      const preview = element('div', 'mr-parameter-preview');
      for (const key of ['steps', 'scale', 'sampler']) {
        if (!own(data, key)) continue;
        const value =
          currentRecipe?.settings?.medium && key === 'steps'
            ? 14
            : currentRecipe?.settings?.medium && key === 'sampler'
              ? 'k_euler_ancestral'
              : data[key];
        preview.append(element('span', '', parameterLabels[key] + ' ' + display(key, value)));
      }
      detail.append(summary, stats);
      body.append(preview, detail);
    } else if (group.id === 'characters') {
      body.append(
        element(
          'p',
          'mr-note',
          data.characters.length
            ? `${data.characters.length} 个角色 · 正负提示、开关与坐标一并复用`
            : '无独立角色 · 复用后移除当前角色配置',
        ),
      );
      if (data.characters.length) {
        const details = element('details', 'mr-character-details');
        details.append(element('summary', '', '查看角色描述'));
        data.characters.forEach((character, index) => {
          const row = element('div', 'mr-character');
          row.append(
            element('b', '', `CHAR. ${String(index + 1).padStart(2, '0')}`),
            element('p', '', character.prompt || '空正向提示'),
            element('p', 'mr-character-negative', character.negative || '空负向提示'),
          );
          details.append(row);
        });
        body.append(details);
      }
    } else if (group.id === 'media') {
      const names = [
        data.source ? '底图' : '',
        data.mask ? '蒙版' : '',
        data.references?.length ? `${data.references.length} 张参考` : '',
      ].filter(Boolean);
      body.append(
        element('p', 'mr-note', names.join(' · ')),
        element('small', 'mr-media-hint', '可选：同时恢复原来的生成模式与素材。'),
      );
    }
    return body;
  }
  function render(recipe) {
    boxes.clear();
    list.replaceChildren();
    for (const group of metaReuseGroups(recipe)) {
      const field = element('section', 'mr-field');
      field.dataset.group = group.id;
      field.dataset.available = String(group.available);
      const label = element('label', 'mr-field-label');
      const input = element('input', 'mr-checkbox');
      input.type = 'checkbox';
      input.name = group.id;
      input.checked = group.available && !group.optional;
      input.disabled = !group.available;
      const mark = element('span', 'mr-checkmark');
      mark.append(glyph('check'));
      const text = element('span', 'mr-field-title', group.title);
      const eyebrow = element('small', 'mr-field-eyebrow', group.eyebrow);
      label.append(input, mark, text, eyebrow);
      field.append(label, contentFor(group));
      input.addEventListener('change', syncSelection);
      boxes.set(group.id, input);
      list.append(field);
    }
    syncSelection();
  }
  function close() {
    if (applying) return;
    epoch++;
    dialog.close();
  }
  closeButton.onclick = cancel.onclick = close;
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        close();
    }
  });
  dialog.addEventListener('close', () => {
    releaseImage();
    currentWork = currentRecipe = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  });
  all.onclick = () => {
    for (const input of boxes.values()) if (!input.disabled) input.checked = true;
    syncSelection();
  };
  none.onclick = () => {
    for (const input of boxes.values()) input.checked = false;
    syncSelection();
  };
  apply.onclick = async () => {
    const groups = selection();
    if (!groups.length || applying || !currentRecipe) return;
    applying = true;
    closeButton.disabled = cancel.disabled = true;
    syncSelection();
    message.textContent = '';
    try {
      await onApply?.(selectedMetaPatch(currentRecipe, groups), { work: currentWork, groups });
      applying = false;
      close();
    } catch (error) {
      message.textContent = error.message || 'META 载入失败，请重试。';
      notify(message.textContent);
    } finally {
      applying = false;
      closeButton.disabled = cancel.disabled = false;
      syncSelection();
    }
  };
  return {
    async open(work, recipe) {
      if (applying) return;
      const token = ++epoch;
      opener = document.activeElement;
      currentWork = work;
      currentRecipe = null;
      releaseImage();
      placeholder.hidden = false;
      image.hidden = true;
      imageCaption.replaceChildren();
      imageCaption.append(
        element('strong', '', work?.filename || 'Source metadata'),
        element(
          'span',
          '',
          [
            work?.width && work?.height ? `${work.width} × ${work.height} px` : '',
            work?.created ? new Date(work.created).toLocaleDateString('zh-CN') : '',
          ]
            .filter(Boolean)
            .join(' · '),
        ),
      );
      const fallbackImage = () => {
        image.hidden = true;
        placeholder.hidden = false;
      };
      image.onerror = fallbackImage;
      image.onload = () => {
        image.hidden = false;
        placeholder.hidden = true;
      };
      boxes.clear();
      list.replaceChildren(element('p', 'mr-loading', '正在读取图像 META…'));
      message.textContent = '';
      syncSelection();
      if (!dialog.open) dialog.showModal();
      if (!reduced.matches)
        spread.animate(
          [
            { opacity: 0, transform: 'translateY(14px) scale(.985)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 300, easing: 'cubic-bezier(.22,.75,.25,1)' },
        );
      closeButton.focus({ preventScroll: true });
      try {
        const loaded = recipe ?? (await getRecipe?.(work)) ?? work;
        if (token !== epoch || !dialog.open) return;
        currentRecipe = loaded || {};
        displayPreview();
        render(currentRecipe);
        list.scrollTop = 0;
      } catch (error) {
        if (token !== epoch || !dialog.open) return;
        list.replaceChildren(element('p', 'mr-loading', '暂时无法读取这张作品的 META。'));
        message.textContent = error.message || '读取失败，请重试。';
      }
    },
    close,
    destroy() {
      epoch++;
      window.removeEventListener('folio:content-preferences', preferencesChanged);
      releaseImage();
      dialog.remove();
    },
  };
}
