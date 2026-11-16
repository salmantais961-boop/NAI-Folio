// Interface language. Chinese is the source; English and Japanese are applied
// to the rendered DOM from a phrase table (public/i18n/strings.tsv), so the
// existing modules keep writing their Chinese copy unchanged.
//
// Only interface copy is translated: prompts, tags, catalog names, chat
// messages and anything the user or a model wrote are left exactly as they are.

const STORAGE = 'folio.locale';
export const LOCALES = [
  ['zh', '中文'],
  ['en', 'English'],
  ['ja', '日本語'],
];
const supported = new Set(LOCALES.map(([code]) => code));
const HTML_LANG = { zh: 'zh-CN', en: 'en', ja: 'ja' };

// A run of CJK text with its own punctuation; Latin text, digits and spaces split runs.
const RUN = /[　-〿぀-ヿ㐀-鿿＀-￯—…“”·]*[㐀-鿿][　-〿぀-ヿ㐀-鿿＀-￯—…“”]*/g;
const HAS_HAN = /[㐀-鿿]/;
const ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt', 'aria-description', 'aria-roledescription'];
// Containers whose text belongs to the user, a model or the tag catalogue.
const SKIP = [
  'script',
  'style',
  'textarea',
  'code',
  'pre',
  '[contenteditable]',
  '[translate="no"]',
  '.pt-textframe',
  '.pt-rich-frame',
  '.pt-editor',
  '.pt-item-body',
  '.da-prose',
  '.da-question',
  '.da-plan-body',
  '.av-prompt',
  '.at-detail-prompt p',
  '.at-card-tags',
  '.cat-tags',
  '.cat-trigger',
  '.cat-tile h3',
  '.cat-suggestions .cat-tag',
  '.mr-prompt',
  '.lc-prompt',
  '.history-caption',
  '.archive-caption p',
].join(',');

const PUNCT = {
  en: { '，': ', ', '。': '. ', '、': ', ', '：': ': ', '；': '; ', '！': '! ', '？': '? ', '（': ' (', '）': ') ', '“': '“', '”': '”', '《': '“', '》': '”', '…': '…', '—': '—', '·': '·', '　': ' ' },
  ja: { '，': '、', '“': '「', '”': '」', '《': '『', '》': '』', '（': '（', '）': '）' },
};

let locale = readLocale();
let table = null;
let loading = null;
let observer = null;
const originalText = new WeakMap();
const writtenText = new WeakMap();
const originalAttr = new WeakMap();
const writtenAttr = new WeakMap();

function readLocale() {
  try {
    const stored = localStorage.getItem(STORAGE);
    if (supported.has(stored)) return stored;
  } catch {}
  return 'zh';
}
export function getLocale() {
  return locale;
}

async function loadTable() {
  if (table) return table;
  loading ??= fetch('/i18n/strings.tsv', { cache: 'no-cache' })
    .then((response) => (response.ok ? response.text() : ''))
    .catch(() => '')
    .then((text) => {
      const rows = { en: new Map(), ja: new Map() };
      for (const line of text.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const [zh, en, ja] = line.split('\t');
        if (!zh) continue;
        if (en) rows.en.set(zh, en.replace(/\\n/g, '\n'));
        if (ja) rows.ja.set(zh, ja.replace(/\\n/g, '\n'));
      }
      table = rows;
      return rows;
    });
  return loading;
}

// Template phrases whose word order changes in translation.
const PATTERNS = {
  en: [
    [/^第\s*(\d+)\s*轮$/, 'Round $1'],
    [/^第\s*(\d+)\s*张$/, 'Image $1'],
    [/^角色\s*(\d+)$/, 'Character $1'],
    [/^(\d+)\s*张$/, '$1 images'],
    [/^(\d+)\s*次$/, '$1×'],
    [/^(\d+)\s*个$/, '$1'],
    [/^(\d+(?:\.\d+)?)\s*秒$/, '$1 s'],
    [/^(\d+)\s*分\s*(\d+(?:\.\d+)?)\s*秒$/, '$1 min $2 s'],
    [/^(\d+)\s*字符$/, '$1 characters'],
  ],
  ja: [
    [/^第\s*(\d+)\s*轮$/, 'ラウンド $1'],
    [/^第\s*(\d+)\s*张$/, '$1 枚目'],
    [/^角色\s*(\d+)$/, 'キャラクター $1'],
    [/^(\d+)\s*张$/, '$1 枚'],
    [/^(\d+)\s*次$/, '$1 回'],
    [/^(\d+)\s*个$/, '$1 件'],
    [/^(\d+(?:\.\d+)?)\s*秒$/, '$1 秒'],
    [/^(\d+)\s*分\s*(\d+(?:\.\d+)?)\s*秒$/, '$1 分 $2 秒'],
    [/^(\d+)\s*字符$/, '$1 文字'],
  ],
};

// Cover a run entirely with known phrases (longest first); otherwise leave it.
function segment(run, words) {
  const out = [];
  let i = 0;
  while (i < run.length) {
    let hit = '';
    for (let end = Math.min(run.length, i + 24); end > i; end--) {
      const piece = run.slice(i, end);
      if (words.has(piece)) {
        hit = piece;
        break;
      }
    }
    if (!hit) {
      const mark = PUNCT[locale]?.[run[i]];
      if (mark == null) return null;
      out.push(mark);
      i++;
      continue;
    }
    out.push(words.get(hit));
    i += hit.length;
  }
  return out.join(locale === 'en' ? ' ' : '').replace(/\s+([,.;:!?)])/g, '$1').replace(/\s{2,}/g, ' ');
}

export function translate(text) {
  if (locale === 'zh' || !table || typeof text !== 'string' || !HAS_HAN.test(text)) return text;
  const words = table[locale];
  const lead = text.match(/^\s*/)[0];
  const tail = text.slice(lead.length).match(/\s*$/)[0];
  const core = text.slice(lead.length, text.length - tail.length);
  if (words.has(core)) return lead + words.get(core) + tail;
  for (const [pattern, replacement] of PATTERNS[locale]) if (pattern.test(core)) return lead + core.replace(pattern, replacement) + tail;
  const result = core.replace(RUN, (match, offset, whole) => {
    // Ideographic spaces at the edges of a run are spacing, not words.
    const [, before = '', run, after = ''] = match.match(/^(　*)([\s\S]*?)(　*)$/);
    const found = words.get(run) ?? segment(run, words);
    if (found == null) return match;
    const value = locale === 'en' ? (before ? ' ' : '') + found + (after ? ' ' : '') : before + found + after;
    if (locale !== 'en') return value;
    const left = whole[offset - 1],
      right = whole[offset + match.length];
    return (left && /[A-Za-z0-9)\]]/.test(left) ? ' ' : '') + value + (right && /[A-Za-z0-9(\[]/.test(right) ? ' ' : '');
  });
  return lead + result + tail;
}

// Fields hold user text, but their placeholder and labels are interface copy.
const SKIP_ATTRIBUTES = '[translate="no"], .da-prose, .da-question, .cat-tags, .cat-trigger, .history-caption';
const skipCache = new WeakMap();
const skipAttrCache = new WeakMap();
function skipped(element) {
  if (!element) return true;
  let value = skipCache.get(element);
  if (value === undefined) {
    value = Boolean(element.closest(SKIP));
    skipCache.set(element, value);
  }
  return value;
}
function attributesSkipped(element) {
  let value = skipAttrCache.get(element);
  if (value === undefined) {
    value = Boolean(element.closest(SKIP_ATTRIBUTES));
    skipAttrCache.set(element, value);
  }
  return value;
}

function applyText(node) {
  if (skipped(node.parentElement)) return;
  const current = node.data;
  if (writtenText.get(node) === current) return;
  originalText.set(node, current);
  const next = translate(current);
  writtenText.set(node, next);
  if (next !== current) node.data = next;
}
function retranslateText(node) {
  if (skipped(node.parentElement)) return;
  const source = writtenText.get(node) === node.data ? (originalText.get(node) ?? node.data) : node.data;
  originalText.set(node, source);
  const next = translate(source);
  writtenText.set(node, next);
  if (next !== node.data) node.data = next;
}
function applyAttributes(element, refresh = false) {
  if (attributesSkipped(element)) return;
  for (const name of ATTRIBUTES) {
    if (!element.hasAttribute(name)) continue;
    const current = element.getAttribute(name);
    let originals = originalAttr.get(element),
      written = writtenAttr.get(element);
    if (!originals) originalAttr.set(element, (originals = new Map()));
    if (!written) writtenAttr.set(element, (written = new Map()));
    if (written.get(name) === current) {
      if (!refresh) continue;
    } else originals.set(name, current);
    const next = translate(originals.get(name) ?? current);
    written.set(name, next);
    if (next !== current) element.setAttribute(name, next);
  }
}
// Text inside user-content containers stays as written; their fields' labels do not.
const LABELLED = ATTRIBUTES.map((name) => `[${name}]`).join(',');
function labelsWithin(element, refresh) {
  for (const node of element.querySelectorAll(LABELLED)) applyAttributes(node, refresh);
}
function walk(root, refresh = false) {
  if (root.nodeType === Node.TEXT_NODE) {
    if (HAS_HAN.test(root.data) || refresh) (refresh ? retranslateText : applyText)(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  const element = root.nodeType === Node.DOCUMENT_NODE ? root.documentElement : root;
  if (!element) return;
  applyAttributes(element, refresh);
  if (skipped(element)) return labelsWithin(element, refresh);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (!node.matches(SKIP)) return NodeFilter.FILTER_ACCEPT;
        applyAttributes(node, refresh);
        labelsWithin(node, refresh);
        return NodeFilter.FILTER_REJECT;
      }
      return refresh || HAS_HAN.test(node.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) (refresh ? retranslateText : applyText)(node);
    else applyAttributes(node, refresh);
  }
}

function observe() {
  if (observer) return;
  observer = new MutationObserver((records) => {
    if (locale === 'zh') return;
    for (const record of records) {
      if (record.type === 'childList') for (const node of record.addedNodes) walk(node);
      else if (record.type === 'characterData') {
        if (HAS_HAN.test(record.target.data)) applyText(record.target);
      } else if (record.type === 'attributes') applyAttributes(record.target);
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRIBUTES,
  });
}

function paintDocument(refresh) {
  document.documentElement.lang = HTML_LANG[locale];
  walk(document, refresh);
  document.documentElement.removeAttribute('data-i18n-pending');
}

export async function setLocale(next) {
  if (!supported.has(next) || next === locale) return;
  const previous = locale;
  locale = next;
  try {
    localStorage.setItem(STORAGE, next);
  } catch {}
  if (next !== 'zh') await loadTable();
  if (locale !== next) return;
  observe();
  paintDocument(previous !== 'zh' || next === 'zh');
  window.dispatchEvent(new CustomEvent('folio:locale', { detail: { locale: next } }));
}

// Boot: translate before the first meaningful paint when a language is stored.
export const i18nReady =
  locale !== 'zh'
    ? loadTable().then(() => {
        observe();
        paintDocument(false);
      })
    : Promise.resolve(document.documentElement.removeAttribute('data-i18n-pending'));
// Another window (the desktop frame, or a second tab) changed the language.
window.addEventListener('storage', (event) => {
  if (event.key === STORAGE) void setLocale(readLocale());
});
