import { findChunks, reference, replaceEditorRange } from './chunks.js';
import { isLocalCover } from './catalog-path.js';
const workerURL = new URL('./catalog-data/search-worker.js', import.meta.url);
const dataURL = new URL('./catalog-data/', import.meta.url);
let coverRoot = dataURL;
let editionRequest;
function useLocalEdition() {
  const selected = new URLSearchParams(globalThis.location?.search || '').get('catalog');
  try {
    if (selected === 'local' || selected === 'sample') {
      localStorage.setItem('folio.catalog.edition', selected);
      return selected === 'local';
    }
    return localStorage.getItem('folio.catalog.edition') === 'local';
  } catch {
    return selected === 'local';
  }
}
const useImported = useLocalEdition();

async function resolveEdition() {
  if (!useImported) return;
  if (!editionRequest) {
    editionRequest = fetch(new URL('local/current.json', dataURL), { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw Error('请先导入本机图鉴，或用 ?catalog=sample 打开示例库。');
        const { edition } = await response.json();
        if (!/^[a-f0-9-]{36}$/.test(edition)) throw Error('本机图鉴版本无效，请重新导入。');
        workerURL.searchParams.set('edition', edition);
        coverRoot = new URL('local/' + edition + '/', dataURL);
      })
      .catch((error) => {
        editionRequest = undefined;
        throw error;
      });
  }
  await editionRequest;
}
const number = new Intl.NumberFormat('zh-CN');
const pending = new Map();
let worker;
let nextId = 0;
let onCharacterSelection;

/** All character picker entry points share one multi-character destination. */
export function configureCatalog({ onCharacter } = {}) {
  onCharacterSelection = typeof onCharacter === 'function' ? onCharacter : undefined;
}

async function request(kind, query, options = {}) {
  await resolveEdition();
  if (!worker) {
    worker = new Worker(workerURL);
    worker.onmessage = ({ data }) => {
      const reply = pending.get(data.id);
      pending.delete(data.id);
      if (reply)
        data.error
          ? reply.reject(Object.assign(new Error(data.error), { code: data.code }))
          : reply.resolve(data);
    };
    worker.onerror = () => {
      for (const reply of pending.values()) reply.reject(new Error('本地索引暂时无法读取'));
      pending.clear();
      worker.terminate();
      worker = null;
    };
  }
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, kind, query, ...options });
  });
}

/** Resolve identities from expanded positive captions using the local catalog only. */
export async function findReferencedCharacters(texts) {
  const captions = (Array.isArray(texts) ? texts : []).filter(
    (text) => typeof text === 'string' && text.trim(),
  );
  if (!captions.length) return [];
  const result = await request('exact-characters', '', { texts: captions, channel: 'character-identity' });
  return result.characters;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const compact = (value) => value.trim().toLowerCase().replaceAll('_', ' ').replace(/\s+/g, ' ');
const delimiters = /[,，、\n|]/;
const categoryNames = { 0: '标签', 1: '画师', 3: '作品', 4: '角色', 5: '元标签', 6: '词块' };
const attached = new WeakSet();
let popup,
  active,
  debounce,
  suggestionEpoch = 0,
  composing = false;
let source = 'local',
  currentModel = () => 'nai-diffusion-5-full',
  remoteController;
const remoteCache = new Map();

export function mountSuggestionSource(element, getModel) {
  currentModel = getModel;
  const selector = node('span', 'cat-source');
  selector.setAttribute('role', 'group');
  selector.setAttribute('aria-label', '提示词联想来源');
  selector.append(node('span', '', '联想'));
  for (const [id, label, title] of [
    ['local', '本地', '使用本地图鉴索引'],
    ['official', '官方', '将光标处当前标签发给 NovelAI，查询当前模型的建议'],
  ]) {
    const button = node('button', '', label);
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.dataset.source = id;
    button.setAttribute('aria-pressed', String(id === source));
    button.onclick = () => {
      closeSuggestions();
      source = id;
      for (const item of selector.querySelectorAll('button'))
        item.setAttribute('aria-pressed', String(item.dataset.source === id));
    };
    selector.append(button);
  }
  element.replaceChildren(selector);
}

async function officialTags(region) {
  const model = currentModel?.() || 'nai-diffusion-5-full';
  const prefix = region.category === 1 ? 'artist:' : region.category === 4 ? 'character:' : '';
  const params = new URLSearchParams({
    model,
    prompt: prefix + region.query,
    lang: /[\u3040-\u30ff]/.test(region.query) ? 'jp' : 'en',
  });
  const key = params.toString();
  if (remoteCache.has(key)) return remoteCache.get(key);
  remoteController = new AbortController();
  const controller = remoteController;
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch('/api/suggest-tags?' + params, { signal: controller.signal });
    if (!response.ok) throw new Error('官方建议暂不可用');
    const body = await response.json();
    const rows = (body.tags || [])
      .filter((item) => typeof item?.tag === 'string')
      .slice(0, 8)
      .map((item) => [
        prefix && item.tag.startsWith(prefix) ? item.tag.slice(prefix.length) : item.tag,
        '',
        region.category || 0,
      ]);
    if (remoteCache.size >= 128) remoteCache.delete(remoteCache.keys().next().value);
    remoteCache.set(key, rows);
    return rows;
  } finally {
    clearTimeout(timeout);
    if (remoteController === controller) remoteController = null;
  }
}

function tokenAt(input) {
  const caret = input.selectionStart;
  if (caret !== input.selectionEnd) return null;
  const text = input.value;
  let start = caret,
    end = caret;
  while (start > 0 && !delimiters.test(text[start - 1])) start--;
  while (end < text.length && !delimiters.test(text[end])) end++;
  const token = text.slice(start, end);
  const prefix = token.match(/^\s*(?:(?:-?\d+(?:\.\d+)?::|[\[{])+\s*)?(?:(artist|character):\s*)?/i);
  const trailing = token.match(/(?:[\]}]|::)*\s*$/)[0];
  const from = start + prefix[0].length;
  const to = end - trailing.length;
  const query = compact(text.slice(from, Math.min(caret, to)));
  if (!query || query.startsWith('!macro:') || caret < from || caret > to || query.length > 100) return null;
  const type = prefix[1]?.toLowerCase();
  return { from, to, end, query, category: type === 'artist' ? 1 : type === 'character' ? 4 : null };
}

export function closeSuggestions() {
  clearTimeout(debounce);
  remoteController?.abort();
  suggestionEpoch++;
  if (active) {
    active.input.setAttribute('aria-expanded', 'false');
    active.input.removeAttribute('aria-activedescendant');
    active = null;
  }
  popup?.remove();
  popup = null;
}

function typeValue(input, text, from, to, caret) {
  replaceEditorRange(input, from, to, text, caret);
}

// Locate the line containing the caret, including wrapping and textarea scroll.
function anchorAt(input) {
  if (input.promptEditor?.focused) return input.promptEditor.caretRect();
  const box = input.getBoundingClientRect();
  const ink = input.nextElementSibling;
  if (ink?.classList.contains('pt-ink-layer')) {
    let offset = input.selectionStart;
    for (const run of ink.children) {
      const text = run.firstChild;
      if (!text) continue;
      if (offset <= text.length) {
        const range = document.createRange();
        range.setStart(text, offset);
        range.collapse(true);
        const rect = range.getClientRects()[0];
        if (rect?.height)
          return {
            left: Math.max(box.left, Math.min(box.right, rect.left)),
            top: Math.max(box.top, Math.min(box.bottom, rect.top)),
            bottom: Math.max(box.top, Math.min(box.bottom, rect.bottom)),
          };
        break;
      }
      offset -= text.length;
    }
  }
  const mirror = node('div');
  const style = getComputedStyle(input);
  for (const prop of [
    'fontFamily',
    'fontSize',
    'fontStyle',
    'fontWeight',
    'fontKerning',
    'fontVariantLigatures',
    'lineHeight',
    'letterSpacing',
    'textTransform',
    'wordSpacing',
    'paddingTop',
    'paddingBottom',
    'paddingLeft',
    'paddingRight',
    'tabSize',
    'textIndent',
  ])
    mirror.style[prop] = style[prop];
  Object.assign(mirror.style, {
    position: 'fixed',
    visibility: 'hidden',
    left: '0',
    top: '0',
    margin: '0',
    width: input.clientWidth + 'px',
    boxSizing: 'border-box',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    pointerEvents: 'none',
  });
  mirror.textContent = input.value.slice(0, input.selectionStart);
  const marker = node(
    'span',
    '',
    input.value.slice(input.selectionStart, input.selectionStart + 1) || '\u200b',
  );
  mirror.append(marker);
  document.body.append(mirror);
  const at = marker.getBoundingClientRect();
  const left = Math.max(
    box.left,
    Math.min(box.right, box.left + input.clientLeft + at.left - input.scrollLeft),
  );
  const top = Math.max(box.top, Math.min(box.bottom, box.top + input.clientTop + at.top - input.scrollTop));
  const height = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  mirror.remove();
  return { left, top, bottom: Math.min(box.bottom, top + height) };
}

function positionPopup() {
  if (!popup || !active) return;
  const anchor = anchorAt(active.input);
  const gap = 5,
    margin = 10;
  const width = Math.min(350, window.innerWidth - margin * 2);
  const availableBelow = window.innerHeight - anchor.bottom - margin;
  const above = availableBelow < 165 && anchor.top > availableBelow;
  const available = Math.max(70, above ? anchor.top - margin : availableBelow);
  popup.style.width = width + 'px';
  popup.style.maxHeight = Math.min(320, available - gap) + 'px';
  const height = popup.getBoundingClientRect().height;
  popup.style.left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin)) + 'px';
  popup.style.top = Math.max(margin, above ? anchor.top - height - gap : anchor.bottom + gap) + 'px';
}

function highlight(index) {
  if (!active || !popup) return;
  const list = Array.from(popup.querySelectorAll('[role="option"]'));
  active.index = (index + list.length) % list.length;
  for (const [i, option] of list.entries()) option.setAttribute('aria-selected', String(i === active.index));
  const selected = list[active.index];
  active.input.setAttribute('aria-activedescendant', selected.id);
  const top = selected.offsetTop;
  if (top < popup.scrollTop) popup.scrollTop = top;
  if (top + selected.offsetHeight > popup.scrollTop + popup.clientHeight)
    popup.scrollTop = top + selected.offsetHeight - popup.clientHeight;
}

function commitSuggestion(index) {
  if (!active) return;
  const { input, results } = active;
  const region = tokenAt(input);
  const row = results[index];
  closeSuggestions();
  if (!region || !row) return;
  const suffix = input.value.slice(region.to, region.end).trimEnd();
  const next = input.value.slice(region.end);
  const delimiter = /^[,，、][ \t]*/.exec(next);
  const replacement =
    (row[2] === 6 ? reference(row[0]) : row[0]) +
    suffix +
    (delimiter
      ? next[delimiter[0].length] === '\n'
        ? delimiter[0][0]
        : ', '
      : next.startsWith('|') || next.startsWith('\n')
        ? ''
        : ', ');
  const to = region.end + (delimiter?.[0].length || 0);
  typeValue(input, replacement, region.from, to);
}

function scheduleSuggestions(input) {
  closeSuggestions();
  if (composing || (input !== document.activeElement && !input.promptEditor?.focused)) return;
  const region = tokenAt(input);
  if (!region) return;
  const epoch = suggestionEpoch;
  debounce = setTimeout(
    async () => {
      let result,
        headingText = 'DANBOORU  /  LOCAL';
      if (region.query.startsWith('@')) {
        result = {
          results: findChunks(region.query.slice(1))
            .slice(0, 8)
            .map((c) => [c.name, c.text.slice(0, 50), 6]),
        };
        headingText = 'FOLIO  /  PROMPT BLOCKS';
      } else if (source === 'official') {
        try {
          const rows = await officialTags(region);
          if (rows.length) {
            result = { results: rows };
            headingText = 'NOVELAI  /  LIVE';
          } else headingText = '官方无匹配 · 本地联想';
        } catch {
          headingText = '官方暂不可用 · 本地联想';
        }
      }
      if (epoch !== suggestionEpoch) return;
      if (!result) {
        try {
          result = await request('tags', region.query, { category: region.category, limit: 8 });
        } catch {
          return;
        }
      }
      if (
        epoch !== suggestionEpoch ||
        result.stale ||
        (input !== document.activeElement && !input.promptEditor?.focused) ||
        !result.results.length
      )
        return;
      popup = node('div', 'cat-suggestions');
      popup.id = 'folio-tag-suggestions';
      popup.setAttribute('role', 'listbox');
      popup.setAttribute('aria-label', 'Danbooru 标签建议');
      const heading = node('div', 'cat-suggest-head', headingText);
      heading.append(node('span', '', 'Tab 插入 · Shift Enter 换行'));
      popup.append(heading);
      active = { input, results: result.results, index: 0 };
      result.results.forEach((row, i) => {
        const option = node('div', 'cat-option');
        option.id = 'folio-tag-option-' + i;
        option.setAttribute('role', 'option');
        const label = node('span', 'cat-option-text');
        label.append(node('b', '', row[0]), node('small', '', row[1] || ''));
        option.append(label, node('em', '', categoryNames[row[2] || 0] || '标签'));
        option.addEventListener('pointerdown', (event) => event.preventDefault());
        option.addEventListener('click', () => commitSuggestion(i));
        popup.append(option);
      });
      (input.closest('dialog[open]') || document.body).append(popup);
      input.setAttribute('aria-expanded', 'true');
      highlight(0);
      positionPopup();
    },
    source === 'official' && !region.query.startsWith('@') ? 320 : 65,
  );
}

/** Bind once per textarea. Handles IME composition, weights and mid-prompt edits. */
export function attachAutocomplete(input) {
  if (!input || attached.has(input)) return;
  attached.add(input);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'folio-tag-suggestions');
  input.setAttribute('aria-haspopup', 'listbox');
  input.setAttribute('aria-expanded', 'false');
  input.addEventListener('compositionstart', () => {
    composing = true;
    closeSuggestions();
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    scheduleSuggestions(input);
  });
  input.addEventListener('input', () => scheduleSuggestions(input));
  input.addEventListener('click', () => scheduleSuggestions(input));
  input.addEventListener('blur', () => {
    composing = false;
    closeSuggestions();
  });
  input.addEventListener('scroll', () => {
    if (active?.input === input) positionPopup();
  });
  input.addEventListener('keydown', (event) => {
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    if (!active || active.input !== input) {
      if (event.key === 'Escape') closeSuggestions();
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      highlight(active.index + (event.key === 'ArrowUp' ? -1 : 1));
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      commitSuggestion(active.index);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeSuggestions();
    } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      closeSuggestions();
      requestAnimationFrame(() => scheduleSuggestions(input));
    }
  });
}

window.addEventListener('resize', closeSuggestions);
window.addEventListener(
  'scroll',
  (event) => {
    if (active && event.target !== active.input && !popup.contains(event.target)) closeSuggestions();
  },
  true,
);

function insertFromPicker(input, trigger, start, end) {
  const text = input.value;
  if (
    start === end &&
    start > 0 &&
    !delimiters.test(text[start - 1]) &&
    !/\s/.test(text[start - 1]) &&
    start < text.length &&
    !delimiters.test(text[start])
  ) {
    while (end < text.length && !delimiters.test(text[end])) end++;
    start = end;
  }
  const before = text.slice(0, start),
    after = text.slice(end);
  const prefix = !before || /[,，\n|]\s*$/.test(before) ? (before && /[,，]$/.test(before) ? ' ' : '') : ', ';
  const following = /^\s*([,，]\s*)/.exec(after);
  const suffix = following || !/^\s*[\n|]/.test(after) ? ', ' : '';
  typeValue(input, prefix + trigger + suffix, start, end + (following?.[0].length || 0));
}

const dimensions = {
  artist: {
    short: '画师',
    title: 'Artist',
    english: 'ARTIST',
    placeholder: '搜索画师名、中文名或别名…',
  },
  character: {
    short: '角色',
    title: 'Character',
    english: 'CHARACTER',
    placeholder: '搜索角色名、中文名或作品…',
  },
};
const pageSize = 12;
let dialog;
let includeAppearance = true;

export function catalogSelection(row, kind, appearance = [], include = true) {
  const unique = (tags) => [
    ...new Map(
      tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => [compact(tag), tag.trim()]),
    ).values(),
  ];
  const appearanceTags = unique(appearance);
  const trigger = String(row[2] || row[0] || '');
  const tags = unique([
    ...trigger.split(/[,，\n]/),
    ...(kind === 'character' && include ? appearanceTags : []),
  ]);
  return {
    id: (kind === 'character' ? 'tag:' : 'artist:') + String(row[0]).replaceAll(' ', '_'),
    kind,
    tag: row[0],
    trigger,
    prompt: tags.join(', '),
    tags,
    appearanceTags,
    name: row[3] || row[1] || row[0],
    displayName: row[1] || row[0],
    series: row[9] || row[4] || '',
  };
}

function makeTile(row, kind, appearance, select, observe) {
  const item = catalogSelection(row, kind, appearance, includeAppearance);
  const tile = node('article', 'cat-tile');
  tile.dataset.catalogTag = item.tag;
  const choose = node('button', 'cat-tile-select');
  choose.type = 'button';
  choose.setAttribute('aria-label', (kind === 'character' ? '选择角色：' : '选择画师：') + item.name);
  choose.title = item.prompt;
  const cover = node('span', 'cat-tile-image');
  const fallback = node('span', 'cat-missing', item.displayName.slice(0, 1));
  fallback.setAttribute('aria-hidden', 'true');
  const label = node('span', 'cat-missing-caption', 'VISUAL INDEX');
  fallback.append(label);
  cover.append(fallback);
  const local = isLocalCover(row[7]) ? new URL(row[7], coverRoot).href : '';
  if (local) {
    const img = node('img');
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.dataset.source = local;
    img.addEventListener('load', () => {
      cover.dataset.loaded = 'true';
      tile.dataset.ratio = img.naturalWidth + '/' + img.naturalHeight;
      cover.style.aspectRatio = img.naturalWidth + '/' + img.naturalHeight;
      observe.relayout();
    });
    img.addEventListener('error', () => {
      img.remove();
      cover.dataset.failed = 'true';
      observe.relayout();
    });
    cover.append(img);
    observe.image(tile, img);
  } else {
    observe.image(tile, null);
  }
  cover.append(node('span', 'cat-tile-plus', '↗'));
  const info = node('span', 'cat-tile-info');
  info.append(node('strong', '', item.name), node('span', 'cat-tile-subtitle', item.displayName));
  if (item.series) info.append(node('span', 'cat-tile-series', item.series));
  choose.append(cover, info);
  choose.addEventListener('click', () => select(item));
  const details = node('details', 'cat-tag-details');
  const summary = node('summary');
  summary.append(
    node('span', '', kind === 'character' ? '角色提示词' : '画师标签'),
    node('small', '', item.tags.length + ' TAGS'),
  );
  const tags = node('div', 'cat-tags');
  tags.append(...item.tags.map((tag) => node('span', '', tag)));
  details.append(summary, tags);
  details.open = item.tags.length <= 6;
  details.addEventListener('toggle', observe.relayout);
  // The canonical trigger is always visible, including records without appearance data.
  const trigger = node('p', 'cat-trigger', item.trigger);
  tile.append(choose, trigger);
  if (item.tags.length > 6) {
    const preview = node('div', 'cat-tags cat-tag-preview');
    preview.append(
      ...item.tags
        .slice(trigger.textContent.split(',').length, trigger.textContent.split(',').length + 4)
        .map((tag) => node('span', '', tag)),
    );
    tile.append(preview);
  }
  tile.append(details);
  if (kind === 'character' && !appearance.length)
    tile.append(node('span', 'cat-no-appearance', '仅角色标签 · 暂无外貌资料'));
  return tile;
}

function mountCatalogLayout(grid, scroll) {
  let frame = 0,
    disposed = false,
    ready = false;
  const images = new Map();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const relayout = () => {
    if (frame || disposed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const width = grid.clientWidth;
      if (!width) return;
      const columns = width >= 980 ? 3 : width >= 610 ? 2 : 1;
      const gap = width >= 610 ? 12 : 10,
        columnWidth = (width - gap * (columns - 1)) / columns;
      const cards = [...grid.querySelectorAll('.cat-tile')],
        bottoms = Array(columns).fill(0);
      for (const card of cards) card.style.width = columnWidth + 'px';
      const heights = cards.map((card) => card.offsetHeight);
      cards.forEach((card, index) => {
        const column = bottoms.indexOf(Math.min(...bottoms));
        card.style.translate = `${column * (columnWidth + gap)}px ${bottoms[column]}px`;
        bottoms[column] += heights[index] + gap;
      });
      grid.style.height = Math.max(0, ...bottoms) + 'px';
      for (const [card, image] of images) {
        if (!card.isConnected) {
          observer.unobserve(card);
          images.delete(card);
          continue;
        }
        observer.observe(card);
      }
      ready = true;
    });
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || !ready) continue;
        const image = images.get(entry.target);
        if (image && !image.hasAttribute('src')) image.src = image.dataset.source;
        if (!entry.target.dataset.entered) {
          entry.target.dataset.entered = 'true';
          if (!reduced.matches)
            entry.target.animate(
              [
                { opacity: 0, transform: 'translateY(22px) scale(.985)' },
                { opacity: 1, transform: 'translateY(0) scale(1)' },
              ],
              { duration: 580, easing: 'cubic-bezier(.2,.75,.2,1)', fill: 'backwards' },
            );
        }
      }
    },
    { root: scroll, rootMargin: '100px 0px', threshold: 0 },
  );
  const resize = new ResizeObserver(relayout);
  resize.observe(scroll);
  return {
    image: (card, image) => images.set(card, image),
    relayout,
    reset() {
      ready = false;
      observer.disconnect();
      images.clear();
    },
    destroy() {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      observer.disconnect();
      images.clear();
    },
  };
}

/** Open a visual selector, restoring the target field and its insertion position. */
export function openCatalog(initialKind, input, options = {}) {
  if (!dimensions[initialKind] || !input) return;
  dialog?.close();
  closeSuggestions();
  const start = input.selectionStart ?? input.value.length,
    end = input.selectionEnd ?? start;
  const view = node('dialog', 'cat-dialog');
  dialog = view;
  view.setAttribute('aria-labelledby', 'cat-heading');
  view.innerHTML = `
    <header class="cat-header"><span class="cat-kicker"><i></i> FOLIO &nbsp;/&nbsp; VISUAL INDEX</span><button type="button" class="cat-close" aria-label="关闭图鉴">×</button></header>
    <div class="cat-heading"><h2 id="cat-heading"></h2><div class="cat-nameplate"><b></b><span>DANBOORU COLLECTION</span></div></div>
    <div class="cat-bar"><div class="cat-switch" aria-label="图鉴分类"><button type="button" data-kind="artist">画师</button><button type="button" data-kind="character">角色</button></div><label class="cat-search"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input type="search" autocomplete="off" spellcheck="false" aria-label="检索图鉴"></label></div>
    <div class="cat-meta"><div class="cat-status" role="status"></div><label class="cat-appearance"><input type="checkbox" checked>附带外貌标签</label></div><div class="cat-scroll"><div class="cat-grid"></div></div>
    <footer class="cat-footer"><span></span><div class="cat-pager"><button type="button" data-nav="-1" aria-label="上一页">←</button><span></span><button type="button" data-nav="1" aria-label="下一页">→</button></div></footer>`;
  const $ = (selector) => view.querySelector(selector);
  const search = $('.cat-search input'),
    grid = $('.cat-grid'),
    status = $('.cat-status'),
    scroll = $('.cat-scroll');
  const layout = mountCatalogLayout(grid, scroll);
  let kind = initialKind,
    offset = 0,
    queryId = 0,
    timer,
    latest,
    choosing = false;
  async function choose(item) {
    if (choosing) return;
    choosing = true;
    grid.inert = true;
    try {
      if (item.kind === 'character') {
        const handler = options.onCharacter || onCharacterSelection;
        if (!handler) throw Error('请从工作台的角色栏打开图鉴。');
        const applied = await handler(item, { target: input, start, end });
        if (applied === false) {
          status.textContent = '未能加入角色栏，请检查模型或角色数量。';
          return;
        }
        view.close();
      } else {
        // Native insertion needs the destination to be outside the modal's
        // inert document; close before restoring the textarea selection.
        view.close();
        if (input.isConnected) insertFromPicker(input, item.prompt, start, end);
      }
    } catch (error) {
      status.textContent = error.message || '未能使用这项标签，请重试。';
    } finally {
      choosing = false;
      grid.inert = false;
    }
  }
  function drawResults() {
    if (!latest) return;
    layout.reset();
    if (latest.results.length)
      grid.replaceChildren(
        ...latest.results.map((row) => makeTile(row, kind, latest.details?.[row[0]] || [], choose, layout)),
      );
    else grid.replaceChildren(node('p', 'cat-empty', '没有匹配项。可试试英文标签、中文译名或更短的关键词。'));
    layout.relayout();
  }
  function render() {
    const serial = ++queryId;
    clearTimeout(timer);
    const query = search.value.trim();
    const d = dimensions[kind];
    $('#cat-heading').textContent = d.title + ' Index';
    $('.cat-nameplate b').textContent = d.short + '图鉴';
    $('.cat-footer > span').textContent =
      kind === 'character' ? '选入多角色栏 · 保留全局构图提示词' : '选择画师，加入当前提示词';
    $('.cat-appearance').hidden = kind !== 'character';
    $('.cat-appearance input').checked = includeAppearance;
    search.placeholder = d.placeholder;
    for (const button of view.querySelectorAll('[data-kind]'))
      button.setAttribute('aria-pressed', String(button.dataset.kind === kind));
    grid.setAttribute('aria-busy', 'true');
    grid.inert = true;
    $('.cat-appearance input').disabled = true;
    for (const button of view.querySelectorAll('[data-nav]')) button.disabled = true;
    status.textContent = '正在检索本地图鉴…';
    timer = setTimeout(
      async () => {
        let result;
        try {
          result = await request(kind, query, {
            offset,
            limit: pageSize,
            channel: 'picker',
            includeDetails: kind === 'character',
          });
        } catch (error) {
          if (serial !== queryId || !view.open) return;
          layout.reset();
          grid.replaceChildren();
          grid.style.height = '';
          status.textContent = error.message || '索引读取失败';
          const retry = node('button', 'cat-retry', '重新读取');
          retry.type = 'button';
          retry.onclick = render;
          grid.append(retry);
          grid.removeAttribute('aria-busy');
          grid.inert = false;
          $('.cat-appearance input').disabled = false;
          return;
        }
        if (serial !== queryId || result.stale || !view.open) return;
        status.textContent = query
          ? number.format(result.count) + ' 条匹配'
          : '本地馆藏  /  ' + number.format(result.count) + ' 位' + d.short;
        if (result.detailsUnavailable) status.textContent += ' · 外貌资料暂不可用';
        latest = result;
        drawResults();
        grid.removeAttribute('aria-busy');
        grid.inert = false;
        $('.cat-appearance input').disabled = false;
        scroll.scrollTop = 0;
        const page = Math.floor(offset / pageSize) + 1,
          total = Math.max(1, Math.ceil(result.count / pageSize));
        $('.cat-pager span').textContent = page + ' / ' + number.format(total);
        $('[data-nav="-1"]').disabled = offset === 0;
        $('[data-nav="1"]').disabled = offset + pageSize >= result.count;
      },
      query ? 65 : 0,
    );
  }
  $('.cat-close').onclick = () => view.close();
  $('.cat-appearance input').onchange = (event) => {
    includeAppearance = event.target.checked;
    drawResults();
  };
  view.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      view.close();
    }
  });
  view.addEventListener('click', (e) => {
    if (e.target === view) {
      const r = view.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) view.close();
    }
  });
  for (const button of view.querySelectorAll('[data-kind]'))
    button.onclick = () => {
      if (button.dataset.kind === kind) return;
      kind = button.dataset.kind;
      offset = 0;
      search.value = '';
      render();
    };
  for (const button of view.querySelectorAll('[data-nav]'))
    button.onclick = () => {
      offset = Math.max(0, offset + Number(button.dataset.nav) * pageSize);
      render();
    };
  search.addEventListener('input', () => {
    offset = 0;
    render();
  });
  view.addEventListener(
    'close',
    () => {
      clearTimeout(timer);
      queryId++;
      layout.destroy();
      view.remove();
      if (dialog === view) dialog = null;
    },
    { once: true },
  );
  document.body.append(view);
  view.showModal();
  search.focus({ preventScroll: true });
  render();
}
