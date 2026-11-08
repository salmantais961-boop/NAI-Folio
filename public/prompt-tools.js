import { attachAutocomplete, closeSuggestions } from './catalog.js';
import { bindInk, paintInkWeight } from './prompt-ink.js';
import { promptMoveParts } from './prompt-move.js';
import { formatWeight, unwrap, weightSelectedTags } from './prompt-weight.js';
import { captureProofChrome, moveProofChrome } from './library-chrome-motion.js';
import { mountAtlasPicker, openImagePicker } from './atlas-picker.js';
import { atlasImageMatches, markAtlasImage } from './atlas-image-meta.js';
import {
  ensureChunkEntries,
  getEntry,
  listEntries,
  saveEntry,
  setEntryImage,
  watchAtlas,
} from './atlas-store.js';
import {
  listChunks,
  findChunks,
  saveChunk,
  prepareChunkMerge,
  saveMergedChunk,
  removeChunk,
  expandChunks,
  reference,
  replaceEditorRange,
  watchChunks,
} from './chunks.js';

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(text, label, fn) {
  const b = element('button', '', text);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.onclick = fn;
  return b;
}
const round = (n) => Math.round(n * 100) / 100;
const readable = (n) => Number(n.toFixed(2)).toString();

export function promptParts(text) {
  return promptMoveParts(text).parts;
}
function profile(model) {
  if (!model) return { numeric: true, negative: true };
  const numeric = /nai-diffusion-(?:[4-9]|\d{2,})/.test(model);
  return { numeric, negative: numeric && !/^nai-diffusion-4-(?:full|curated)/.test(model) };
}
function targetRange(field, parts = promptParts(field.value)) {
  let a = field.selectionStart, b = field.selectionEnd;
  const text = field.value;
  if (a !== b) {
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (a === b) return null;
    const outer = parts.find((p) => a >= p.from && b <= p.to);
    if (outer) {
      const plain = unwrap(outer.text);
      if (plain.body !== outer.text && a === outer.from + plain.offset && b === a + plain.body.length)
        return outer;
    }
    return { from: a, to: b, text: text.slice(a, b), outer };
  }
  const atCaret = parts.find((p) => a >= p.from && a <= p.to);
  if (atCaret) return atCaret;
  // The suggestion menu leaves a comma and a space after a completed tag.
  const previous = parts.findLast((part) => part.to < a);
  return previous && /^[,，、 \t]*$/.test(text.slice(previous.to, a)) ? previous : null;
}
// Keep an intentional group as the target of repeated adjustments without
// leaving a live text selection that the next keystroke would overwrite.
const weightRanges = new WeakMap();

function caretAfterWeight(position, from, to, oldText, newText) {
  if (position >= to) return position + newText.length - oldText.length;
  if (position <= from) return position;
  const before = unwrap(oldText), after = unwrap(newText);
  const within = position - from - before.offset;
  if (within > before.body.length) return from + newText.length;
  return from + after.offset + Math.max(0, within);
}

function adjust(field, action, model, notify, value) {
  const start = field.selectionStart, end = field.selectionEnd;
  const previous = weightRanges.get(field);
  const repeat = start === end && previous?.to === end && previous.value === field.value;
  const cap = profile(model);
  const nextWeight = (old) => {
    if (action === 'reset') return 1;
    if (action === 'set') return value;
    if (cap.numeric)
      return Math.max(cap.negative ? -999 : 0, Math.min(999, round(old + (action === 'up' ? 0.1 : -0.1))));
    return (
      1.05 **
      Math.max(
        -80,
        Math.min(80, Math.round(Math.log(Math.max(0.0001, old)) / Math.log(1.05)) + (action === 'up' ? 1 : -1)),
      )
    );
  };
  const wasSelected = start !== end || repeat;
  let from, to, replacement, caret, selectedFrom;
  if (wasSelected) {
    const edit = weightSelectedTags(field.value, repeat ? previous.from : start, end, nextWeight, cap);
    if (!edit) return;
    ({ from, to, replacement, selectedFrom, selectedTo: caret } = edit);
  } else {
    const part = targetRange(field);
    if (!part) {
      notify?.('请把光标放在一个标签上，或先选中提示词。');
      return;
    }
    ({ from, to } = part);
    const parsed = unwrap(part.text);
    replacement = formatWeight(parsed.body, nextWeight(parsed.weight), cap);
    caret = caretAfterWeight(end, from, to, part.text, replacement);
  }
  if (field.value.slice(from, to) !== replacement)
    replaceEditorRange(field, from, to, replacement, caret, caret);
  else {
    field.focus({ preventScroll: true });
    field.setSelectionRange(caret, caret);
  }
  if (wasSelected) weightRanges.set(field, { from: selectedFrom, to: caret, value: field.value });
  else weightRanges.delete(field);
  closeSuggestions();
}
function insertBlock(field, text) {
  let from = field.selectionStart,
    to = field.selectionEnd;
  if (from === to) {
    const current = promptParts(field.value).find((p) => p.from < from && from < p.to);
    if (current) from = to = current.to;
  }
  const before = field.value.slice(0, from),
    after = field.value.slice(to);
  const leading = !before || /[,，\n|]\s*$/.test(before) ? (/[,，]$/.test(before) ? ' ' : '') : ', ';
  const next = after.match(/^\s*[,，][ \t]*/);
  const trailing = next || !/^\s*[\n|]/.test(after) ? ', ' : '';
  replaceEditorRange(field, from, to + (next?.[0].length || 0), leading + text + trailing);
  closeSuggestions();
}
function expandHere(field, notify) {
  const range = targetRange(field);
  if (!range || !range.text.includes('!macro:')) {
    notify?.('请选中词块引用，或将光标放在引用内。');
    return;
  }
  try {
    if (field.promptEditor?.expandMacro?.(range.from, range.to) === true) return;
    const text = expandChunks(range.text);
    replaceEditorRange(field, range.from, range.to, text, range.from, range.from + text.length);
    closeSuggestions();
  } catch (e) {
    notify?.(e.message);
  }
}
let blockLibrary;
let promptAtlasOptions = {};
let promptAtlasPicker;
export function configurePromptAtlas(options = {}) {
  promptAtlasOptions = options;
}
async function useOCChunk(chunk) {
  if (!promptAtlasOptions.onUseOC) throw Error('角色栏尚未准备好，请稍后重试。');
  const entries = await ensureChunkEntries();
  const entry = entries.find((item) => item.type === 'oc' && item.chunkId === chunk.id);
  if (!entry) throw Error('这个 OC 尚未保存到万象集。');
  await promptAtlasOptions.onUseOC(entry);
}
const draftsKey = 'folio.prompt.block-form-drafts';

function touchActivation(event) {
  if (!event) return false;
  return (
    event.pointerType === 'touch' ||
    event.sourceCapabilities?.firesTouchEvents === true ||
    (!event.pointerType && event.detail > 0 && matchMedia('(hover:none) and (pointer:coarse)').matches)
  );
}

function setLibraryToggle(button, open) {
  button.setAttribute('aria-controls', 'block-library-slot');
  button.setAttribute('aria-expanded', String(open));
  button.title = open ? '收起提示词块库' : '打开提示词块库';
  button.setAttribute('aria-label', button.title);
  if (button.classList.contains('pt-entry')) {
    button.querySelector('.pt-entry-arrow').textContent = open ? '↙' : '↗';
  } else button.textContent = open ? '收起词块库' : '词块库 ↗';
}

// Keep both the editor's scroll and the library's place while a pointer action
// restores the native selection. execCommand may otherwise reveal the caret.
function preserveLibraryScroll(field, panel, work) {
  const nodes = [
    field,
    field?.closest('.compose-scroll'),
    panel,
    panel.querySelector('.pt-items'),
    panel.parentElement,
    document.scrollingElement,
  ].filter((el) => el?.getClientRects().length);
  const positions = nodes.map((el) => [el, el.scrollLeft, el.scrollTop]);
  try {
    return work();
  } finally {
    for (const [el, left, top] of positions)
      if (el.scrollLeft !== left || el.scrollTop !== top) el.scrollTo({ left, top, behavior: 'instant' });
  }
}

function createBlockLibrary(slot, studio) {
  const panel = element('section', 'pt-dialog pt-library-panel');
  panel.id = 'pt-block-library';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-labelledby', 'pt-library-title');
  panel.innerHTML = `<header><span class="pt-eyebrow">FOLIO &nbsp;/&nbsp; PROMPT LIBRARY</span><button type="button" class="pt-x" title="收起词块库 · Esc" aria-label="收起词块库">×</button></header>
    <div class="pt-library-title"><h2 id="pt-library-title">词块库</h2><small>点击词块插入</small><button type="button" class="pt-merge-mode" aria-pressed="false" aria-label="合并多个词块"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m3 6 7-4 7 4-7 4zM3 10l7 4 7-4M3 14l7 4 7-4"/></svg><span>合并</span></button></div>
    <div class="pt-library-body"><section class="pt-index"><div class="pt-libsearch"><input type="search" aria-label="搜索提示词块" placeholder="检索名称、分组或内容…"><button type="button" class="pt-new">＋ 新建</button></div><div class="pt-group-list" aria-label="词块分组"></div><div class="pt-items" aria-label="词块列表"></div><div class="pt-merge-dock" hidden><details class="pt-merge-selection"><summary><span class="pt-merge-stack" aria-hidden="true"></span><span class="pt-merge-count">按顺序选择词块</span><small>顺序⌄</small></summary><ol class="pt-merge-order"></ol></details><div class="pt-merge-controls"><button type="button" class="pt-merge-clear">清空选择</button><button type="button" class="pt-merge-preview" disabled>预览合并 →</button></div></div></section>
    <form class="pt-form" hidden><button type="button" class="pt-back">← 返回列表</button><div class="pt-merge-review" hidden><div class="pt-merge-print" aria-hidden="true"></div><ol class="pt-merge-provenance"></ol><p>已展开词块引用，原词块保留。可继续编辑下方正文。</p></div><div class="pt-fields"><label>块名称<input name="blockName" maxlength="60" required autocomplete="off" placeholder="如：傍晚光照"></label><label>分组<input name="group" maxlength="30" autocomplete="off" placeholder="我的"></label></div><label>提示词<textarea name="text" rows="4" placeholder="golden hour, rim light" required></textarea></label>
    <div class="pt-form-actions"><button type="submit" class="pt-save">保存词块</button><button type="button" class="pt-delete">删除</button><button type="button" class="pt-cancel-delete" hidden>取消删除</button></div></form></div>
    <footer><span class="pt-target"></span><div class="pt-footer-actions" hidden><button type="button" class="pt-flat">插入纯文本</button><button type="button" class="pt-reference">插入词块 ↗</button></div><p class="pt-feedback" role="status"></p></footer>`;
  slot.replaceChildren(panel);
  const $ = (sel) => panel.querySelector(sel),
    form = $('.pt-form'),
    name = form.elements.blockName,
    group = form.elements.group,
    body = form.elements.text;
  const query = $('input[type=search]'),
    items = $('.pt-items'),
    message = $('[role=status]');
  const libraryReduced = matchMedia('(prefers-reduced-motion: reduce)');
  const workspaceGrid = studio.querySelector('.workspace-grid');
  const libraryTiming = { duration: 300, easing: 'cubic-bezier(.25,0,.75,1)', fill: 'both' };
  let libraryMotion = null,
    gridMotion = null,
    clearChromeMotion = null,
    motionVersion = 0,
    closing = false,
    finishDeparture = null,
    finishArrival = null;
  function libraryPose() {
    const surface = getComputedStyle(slot),
      grid = getComputedStyle(workspaceGrid),
      bounds = panel.getBoundingClientRect();
    return {
      opacity: surface.opacity,
      transform: surface.transform,
      columns: grid.gridTemplateColumns,
      rows: grid.gridTemplateRows,
      width: bounds.width,
      height: bounds.height,
      chrome: captureProofChrome(studio),
    };
  }
  function stopLibraryMotion() {
    const pose = libraryPose();
    motionVersion++;
    libraryMotion?.cancel();
    gridMotion?.cancel();
    clearChromeMotion?.();
    clearChromeMotion = null;
    libraryMotion = null;
    gridMotion = null;
    finishDeparture = null;
    finishArrival = null;
    panel.style.removeProperty('width');
    panel.style.removeProperty('height');
    studio.classList.remove('blocks-transitioning');
    return pose;
  }
  function moveLibrary(from, surfaceEnd, finish) {
    const to = libraryPose();
    studio.classList.add('blocks-transitioning');
    clearChromeMotion = moveProofChrome(studio, from.chrome, libraryTiming);
    // Keep the paper's typesetting steady while its real grid track is revealed
    // or folded away. The canvas itself is never scaled or snapshotted.
    panel.style.width = Math.max(from.width, to.width) + 'px';
    panel.style.height = Math.max(from.height, to.height) + 'px';
    gridMotion = workspaceGrid.animate(
      [
        { gridTemplateColumns: from.columns, gridTemplateRows: from.rows },
        { gridTemplateColumns: to.columns, gridTemplateRows: to.rows },
      ],
      libraryTiming,
    );
    libraryMotion = slot.animate(
      [{ opacity: from.opacity, transform: from.transform }, surfaceEnd],
      libraryTiming,
    );
    Promise.all([gridMotion.finished, libraryMotion.finished])
      .then(finish)
      .catch(() => {});
  }
  libraryReduced.addEventListener('change', () => {
    if (!libraryReduced.matches) return;
    if (closing) finishDeparture?.();
    else if (finishArrival) finishArrival();
    else stopLibraryMotion();
  });
  window.addEventListener('resize', () => {
    if (closing) finishDeparture?.();
    else finishArrival?.();
  });
  const example = element('section', 'pt-example');
  const exampleHead = element('div', 'pt-example-head');
  exampleHead.append(element('b', '', '真实例图'), element('small', '', '与万象集同步'));
  const examplePlate = element('div', 'pt-example-plate');
  const exampleImage = element('img');
  exampleImage.alt = '词块真实例图';
  exampleImage.decoding = 'async';
  exampleImage.hidden = true;
  const exampleEmpty = element('p', '', '还没有例图。上传图片，或从作品集中选择。');
  examplePlate.append(exampleImage, exampleEmpty);
  const exampleActions = element('div', 'pt-example-actions');
  const exampleUpload = button('上传替换', '上传词块例图', () => exampleFile.click());
  const exampleChoose = button('从作品集选择 ↗', '从作品集选择词块例图', () => {
    const chunk = currentExampleChunk();
    if (!chunk) return;
    openImagePicker({
      getWorks: () => promptAtlasOptions.getWorks?.() || [],
      notify: promptAtlasOptions.notify,
      onSelect: (blob, { workId }) => assignExample(chunk, blob, workId),
    });
  });
  const exampleClear = button('移除例图', '移除词块例图', async () => {
    const chunk = currentExampleChunk();
    if (!chunk) return;
    try {
      await assignExample(chunk, null);
    } catch (error) {
      message.textContent = error.message;
    }
  });
  const exampleFile = element('input');
  exampleFile.type = 'file';
  exampleFile.accept = 'image/png,image/jpeg,image/webp,image/avif,image/gif';
  exampleFile.hidden = true;
  exampleActions.append(exampleUpload, exampleChoose, exampleClear, exampleFile);
  const exampleNote = element('small', 'pt-example-note');
  example.append(exampleHead, examplePlate, exampleActions, exampleNote);
  form.querySelector('.pt-back').after(example);
  let exampleURL = null,
    exampleVersion = 0,
    exampleBusy = false;
  function currentExampleChunk() {
    return listChunks().find((chunk) => chunk.name === selected);
  }
  function releaseExample() {
    exampleVersion++;
    markAtlasImage(examplePlate, []);
    if (exampleURL) URL.revokeObjectURL(exampleURL);
    exampleURL = null;
    exampleImage.removeAttribute('src');
    exampleImage.hidden = true;
  }
  async function entryForChunk(chunk, ensure = true) {
    if (ensure) await ensureChunkEntries();
    const current = listChunks().find((item) => item.id === chunk.id) || chunk;
    if (current.atlasId) {
      const found = await getEntry(current.atlasId);
      if (found) return found;
    }
    return (await listEntries()).find((entry) => entry.chunkId === current.id);
  }
  async function renderExample(ensure = true) {
    // Keep the current object URL alive for the entire departure gesture.
    if (closing) return;
    releaseExample();
    const token = exampleVersion;
    const chunk = currentExampleChunk();
    example.hidden = mergeMode;
    exampleClear.hidden = true;
    exampleEmpty.hidden = false;
    exampleNote.textContent = '';
    exampleUpload.disabled = exampleChoose.disabled = !chunk || exampleBusy;
    exampleEmpty.textContent = chunk ? '正在读取例图…' : '保存这个词块后，即可为它选择一张真实例图。';
    if (!chunk || mergeMode || slot.hidden || panel.dataset.view !== 'edit') return;
    try {
      const entry = await entryForChunk(chunk, ensure);
      if (token !== exampleVersion || slot.hidden || panel.dataset.view !== 'edit') return;
      if (entry?.blob instanceof Blob) {
        const matches = await atlasImageMatches(entry);
        if (token !== exampleVersion || slot.hidden || panel.dataset.view !== 'edit') return;
        if (markAtlasImage(examplePlate, matches)) {
          exampleEmpty.textContent = 'NSFW · 例图已隐藏';
          exampleClear.hidden = false;
          return;
        }
        exampleURL = URL.createObjectURL(entry.blob);
        exampleImage.src = exampleURL;
        exampleImage.alt = '词块「' + chunk.name + '」的真实例图';
        exampleImage.hidden = false;
        exampleEmpty.hidden = true;
        exampleClear.hidden = false;
        exampleNote.textContent = [
          entry.width && entry.height ? `${entry.width} × ${entry.height}` : '',
          entry.imageOrigin === 'generated' ? '生成例图' : '手动指定例图',
        ]
          .filter(Boolean)
          .join(' · ');
      } else exampleEmpty.textContent = '还没有例图。上传图片，或从作品集中选择。';
    } catch (error) {
      if (token === exampleVersion) exampleEmpty.textContent = error.message || '例图读取失败。';
    }
  }
  async function assignExample(chunk, blob, workId) {
    if (exampleBusy) throw Error('例图正在保存，请稍后再试。');
    exampleBusy = true;
    exampleUpload.disabled = exampleChoose.disabled = exampleClear.disabled = true;
    message.textContent = '正在保存真实例图…';
    try {
      const entry = await entryForChunk(chunk);
      if (entry) await setEntryImage(entry.id, blob, { origin: 'manual', workId });
      else if (blob) {
        // Explicitly choosing a new example may recreate an atlas entry that the
        // user previously removed, without reviving it on passive library reads.
        await saveEntry({
          id: chunk.atlasId,
          type: chunk.kind === 'oc' ? 'oc' : 'example',
          name: chunk.kind === 'oc' ? chunk.name.replace(/^OC · /u, '') : chunk.name,
          chunkId: chunk.id,
          chunkName: chunk.name,
          prompt: chunk.text,
          blob,
          imageOrigin: 'manual',
          sourceWorkId: workId,
        });
      }
      message.textContent = blob ? '例图已更新，万象集同步显示。' : '已移除例图，词块内容保留。';
    } finally {
      exampleBusy = false;
      exampleClear.disabled = false;
      if (currentExampleChunk()?.id === chunk.id) await renderExample(false);
    }
  }
  exampleFile.onchange = async () => {
    const blob = exampleFile.files[0],
      chunk = currentExampleChunk();
    exampleFile.value = '';
    if (!blob || !chunk) return;
    try {
      await assignExample(chunk, blob);
    } catch (error) {
      message.textContent = error.message;
    }
  };
  watchAtlas(() => {
    if (!slot.hidden && panel.dataset.view === 'edit') void renderExample(false);
  });
  window.addEventListener('folio:content-preferences', () => {
    if (slot.hidden) return;
    releaseExample();
    if (panel.dataset.view === 'edit') void renderExample(false);
  });
  let target,
    options = {},
    category = '',
    selected = '',
    baseline,
    loading = false,
    confirmingDelete = false,
    composing = false;
  let mergeMode = false,
    mergeNames = [],
    mergeDraft = null;
  let listScroll = 0,
    needsIndex = true;
  // The same live form is kept while the rail is closed. Drafts for other
  // blocks and the new-block form survive switching rows and reloading a tab.
  let drafts;
  try {
    drafts = new Map(JSON.parse(sessionStorage.getItem(draftsKey) || '[]'));
  } catch {
    drafts = new Map();
  }
  function writeDrafts() {
    try {
      sessionStorage.setItem(draftsKey, JSON.stringify([...drafts]));
    } catch {}
  }
  const formValue = () => ({ name: name.value, category: group.value, text: body.value });
  const clean = (a, b) => a?.name === b?.name && a?.category === b?.category && a?.text === b?.text;
  function remember() {
    if (loading || panel.dataset.view !== 'edit') return;
    const next = formValue();
    if (mergeMode && mergeDraft) {
      mergeDraft.form = next;
      return;
    }
    if (clean(next, baseline)) drafts.delete(selected);
    else drafts.set(selected, next);
    writeDrafts();
    needsIndex = true;
  }
  function targetName() {
    if (!target?.isConnected) return '请点选一个提示词输入框';
    const character = target.closest('[data-c]');
    if (character)
      return (
        '角色 ' +
        (Number(character.dataset.c) + 1) +
        (target.dataset.key === 'negative' ? ' · 负面' : ' · 正向')
      );
    return target.id === 'negative' ? '负面提示词' : '正向提示词';
  }
  function setTarget(field) {
    target = field?.isConnected ? field : null;
    const isOC = panel.dataset.view === 'edit' && currentExampleChunk()?.kind === 'oc';
    const text = isOC ? '加入至 · 独立角色栏' : target ? '插入至 · ' + targetName() : targetName();
    if ($('.pt-target').textContent !== text) $('.pt-target').textContent = text;
    $('.pt-flat').hidden = mergeMode || isOC;
    $('.pt-flat').disabled = !target || !body.value.trim();
    const unsaved = panel.dataset.view === 'edit' && (mergeMode || !selected || !clean(formValue(), baseline));
    $('.pt-reference').textContent = isOC
      ? unsaved
        ? '保存并加入角色 ↗'
        : '加入角色 ↗'
      : unsaved
        ? '保存并插入 ↗'
        : '插入词块 ↗';
    $('.pt-reference').disabled = !target || !name.value.trim() || !body.value.trim();
    for (const pick of items.querySelectorAll('.pt-block-pick')) pick.disabled = !mergeMode && !target;
  }
  function resetDelete() {
    confirmingDelete = false;
    $('.pt-delete').textContent = '删除';
    $('.pt-cancel-delete').hidden = true;
  }
  function renderMergeDock() {
    if (!mergeMode) return;
    const available = new Map(listChunks().map((item) => [item.name, item]));
    const missing = mergeNames.some((name) => !available.has(name));
    $('.pt-merge-count').textContent = mergeNames.length
      ? '已选 ' + mergeNames.length + ' 个词块' + (missing ? ' · 来源已变更' : '')
      : '按顺序选择词块';
    $('.pt-merge-stack').textContent = String(mergeNames.length).padStart(2, '0');
    $('.pt-merge-preview').disabled = mergeNames.length < 2 || missing;
    $('.pt-merge-clear').disabled = !mergeNames.length;
    $('.pt-merge-order').replaceChildren(
      ...mergeNames.map((name, index) => {
        const row = element('li', '');
        const number = element('span', 'pt-merge-position', String(index + 1).padStart(2, '0'));
        number.setAttribute('aria-hidden', 'true');
        const title = element('span', 'pt-merge-source-name', name + (available.has(name) ? '' : '（已移除）'));
        const up = button('↑', '上移「' + name + '」', () => moveMerge(index, -1)),
          down = button('↓', '下移「' + name + '」', () => moveMerge(index, 1)),
          remove = button('×', '取消选择「' + name + '」', () => {
            mergeNames = mergeNames.filter((item) => item !== name);
            renderIndex();
            $('.pt-merge-selection summary').focus({ preventScroll: true });
          });
        up.disabled = index === 0;
        down.disabled = index === mergeNames.length - 1;
        row.append(number, title, up, down, remove);
        return row;
      }),
    );
  }
  function moveMerge(index, offset) {
    const destination = index + offset;
    if (destination < 0 || destination >= mergeNames.length) return;
    [mergeNames[index], mergeNames[destination]] = [mergeNames[destination], mergeNames[index]];
    renderIndex();
    const row = $('.pt-merge-order').children[destination];
    const control = row?.querySelector(
      offset < 0 ? 'button:first-of-type:not(:disabled)' : 'button:nth-of-type(2):not(:disabled)',
    );
    (control || row?.querySelector('button:last-of-type'))?.focus({ preventScroll: true });
  }
  function toggleMerge(name, event) {
    if (mergeNames.includes(name)) mergeNames = mergeNames.filter((item) => item !== name);
    else mergeNames.push(name);
    renderIndex();
    message.textContent = '';
    if (event)
      [...items.querySelectorAll('.pt-block-pick')]
        .find((pick) => pick.dataset.blockName === name)
        ?.focus({ preventScroll: true });
  }
  function beginMergeReview() {
    try {
      const prepared = prepareChunkMerge(mergeNames);
      const sameSources =
        mergeDraft &&
        prepared.sources.every(
          (source, index) =>
            source.name === mergeDraft.sources[index]?.name &&
            source.expanded === mergeDraft.sources[index]?.expanded,
        ) &&
        prepared.sources.length === mergeDraft.sources.length;
      const usedNames = new Set(listChunks().map((item) => item.name));
      const baseName = mergeNames.join(' + ').length <= 60 ? mergeNames.join(' + ') : '组合词块';
      let suggested = baseName,
        suffix = 2;
      while (usedNames.has(suggested)) suggested = baseName.slice(0, 54) + ' ' + suffix++;
      const value =
        sameSources && mergeDraft.form
          ? mergeDraft.form
          : {
              name: suggested,
              category:
                new Set(prepared.sources.map((source) => source.category)).size === 1
                  ? prepared.sources[0].category
                  : '组合',
              text: prepared.text,
            };
      listScroll = items.scrollTop;
      mergeDraft = { ...prepared, form: value };
      selected = '';
      baseline = value;
      resetDelete();
      changeView('edit');
      loading = true;
      name.value = value.name;
      group.value = value.category;
      body.value = value.text;
      body.dispatchEvent(new Event('input', { bubbles: true }));
      loading = false;
      $('.pt-merge-print').textContent = String(prepared.sources.length).padStart(2, '0');
      $('.pt-merge-provenance').replaceChildren(
        ...prepared.sources.map((source, index) =>
          element('li', '', String(index + 1).padStart(2, '0') + '  ' + source.name),
        ),
      );
      setTarget(target);
      message.textContent = sameSources ? '已保留合并草稿' : '按所选顺序拼接，重复标签与权重均保留';
      name.focus({ preventScroll: true });
    } catch (error) {
      message.textContent = error.message;
    }
  }
  function toggleMergeMode() {
    if (mergeMode) {
      mergeMode = false;
      mergeNames = [];
      mergeDraft = null;
      changeView('browse');
      renderIndex();
      setTarget(target);
      message.textContent = '已取消合并';
    } else {
      remember();
      mergeMode = true;
      mergeNames = [];
      mergeDraft = null;
      resetDelete();
      changeView('browse');
      renderIndex();
      message.textContent = '选择至少两个词块，随后预览并保存';
    }
  }
  function renderIndex(resetScroll = false) {
    if (panel.dataset.view !== 'browse' || slot.hidden) {
      needsIndex = true;
      return;
    }
    const prevTop = resetScroll ? 0 : items.scrollTop;
    const groups = [...new Set(listChunks().map((c) => c.category || '我的'))];
    if (!groups.includes(category)) category = '';
    const tabs = ['', ...groups].map((g) => {
      const b = button(g || '全部', g || '全部分组', () => {
        category = g;
        renderIndex(true);
        $('.pt-group-list [aria-pressed=true]')?.focus({ preventScroll: true });
      });
      b.setAttribute('aria-pressed', String(category === g));
      return b;
    });
    $('.pt-group-list').replaceChildren(...tabs);
    const list = findChunks(query.value).filter((c) => !category || category === (c.category || '我的'));
    items.replaceChildren(
      ...(list.length
        ? list.map((c) => {
            const row = element('div', 'pt-block-row');
            const order = mergeNames.indexOf(c.name);
            const pick = button('', (mergeMode ? '选择「' : '插入「') + c.name + '」', (e) => {
              if (mergeMode) toggleMerge(c.name, e);
              else insert(reference(c.name), c.name, e);
            });
            pick.className = 'pt-block-pick';
            pick.dataset.blockName = c.name;
            pick.disabled = !mergeMode && !target?.isConnected;
            if (mergeMode) {
              pick.setAttribute('role', 'checkbox');
              pick.setAttribute('aria-checked', String(order >= 0));
              row.classList.toggle('is-selected', order >= 0);
            }
            const label = element('span', 'pt-block-label');
            const title = element('strong', 'pt-block-name', c.name);
            label.append(
              title,
              element('small', 'pt-block-category', c.category || '我的'),
              element('em', 'pt-block-excerpt', c.text),
            );
            if (drafts.has(c.name)) label.append(element('small', 'pt-draft-mark', '有草稿'));
            if (mergeMode) {
              const stamp = element('span', 'pt-merge-stamp');
              stamp.append(element('b', '', order >= 0 ? String(order + 1).padStart(2, '0') : ''));
              pick.append(stamp, label);
            } else pick.append(label);
            const edit = button('详情', '词块详情「' + c.name + '」', () => openEditor(c));
            edit.className = 'pt-block-edit';
            edit.hidden = mergeMode;
            row.append(pick, edit);
            return row;
          })
        : [element('p', '', '没有匹配的词块')]),
    );
    items.scrollTop = prevTop;
    needsIndex = false;
    $('.pt-new').textContent = drafts.has('') ? '继续新建' : '＋ 新建';
    renderMergeDock();
  }
  function changeView(view) {
    panel.dataset.view = view;
    $('.pt-library-title small').textContent = mergeMode
      ? view === 'browse'
        ? '选择后合并'
        : '预览合并'
      : view === 'browse'
        ? '点击词块插入'
        : '编辑词块';
    $('.pt-index').hidden = view !== 'browse';
    form.hidden = view !== 'edit';
    $('.pt-footer-actions').hidden = view !== 'edit';
    $('.pt-merge-review').hidden = !mergeMode || view !== 'edit';
    $('.pt-merge-dock').hidden = !mergeMode;
    $('.pt-new').hidden = mergeMode;
    $('.pt-delete').hidden = mergeMode;
    $('.pt-flat').hidden = mergeMode;
    $('.pt-back').textContent = mergeMode ? '← 返回选块' : '← 返回列表';
    $('.pt-save').textContent = mergeMode ? '保存新词块' : '保存词块';
    $('.pt-merge-mode span').textContent = mergeMode ? '取消合并' : '合并';
    $('.pt-merge-mode').setAttribute('aria-pressed', String(mergeMode));
    $('.pt-merge-mode').setAttribute('aria-label', mergeMode ? '取消合并词块' : '合并多个词块');
    panel.dataset.merge = String(mergeMode);
    studio.classList.toggle('blocks-merging', mergeMode);
    if (view !== 'edit') releaseExample();
    example.hidden = view !== 'edit' || mergeMode;
  }
  function browse(focusList = false) {
    remember();
    resetDelete();
    changeView('browse');
    renderIndex();
    items.scrollTop = listScroll;
    message.textContent = '';
    if (focusList && mergeMode) {
      (
        items.querySelector('[aria-checked=true]') ||
        items.querySelector('.pt-block-pick') ||
        $('.pt-merge-mode')
      ).focus({ preventScroll: true });
      return;
    }
    if (focusList)
      (
        [...items.querySelectorAll('.pt-block-edit')].find(
          (b) => b.getAttribute('aria-label') === '词块详情「' + selected + '」',
        ) || $('.pt-new')
      ).focus({ preventScroll: true });
  }
  function openEditor(item, seed = '') {
    if (panel.dataset.view === 'browse') listScroll = items.scrollTop;
    remember();
    mergeMode = false;
    mergeNames = [];
    mergeDraft = null;
    resetDelete();
    selected = item?.name || '';
    baseline = { name: selected, category: item?.category || '我的', text: item?.text || '' };
    const saved = drafts.get(selected);
    const value = saved || { ...baseline, text: item?.text || seed };
    changeView('edit');
    loading = true;
    name.value = value.name;
    group.value = value.category;
    body.value = value.text;
    body.dispatchEvent(new Event('input', { bubbles: true }));
    loading = false;
    setTarget(target);
    $('.pt-delete').disabled = !item;
    remember();
    message.textContent = saved ? '已恢复未保存的草稿' : '';
    void renderExample();
    name.focus({ preventScroll: true });
  }
  function save() {
    const old = selected,
      merging = mergeMode && mergeDraft,
      newName = merging ? saveMergedChunk(mergeDraft, formValue()) : saveChunk(old, formValue());
    if (!merging) drafts.delete(old);
    drafts.delete(newName);
    writeDrafts();
    const item = listChunks().find((c) => c.name === newName);
    selected = newName;
    baseline = { name: item.name, category: item.category || '我的', text: item.text };
    loading = true;
    name.value = baseline.name;
    group.value = baseline.category;
    body.value = baseline.text;
    body.dispatchEvent(new Event('input', { bubbles: true }));
    loading = false;
    if (merging) {
      mergeMode = false;
      mergeNames = [];
      mergeDraft = null;
      changeView('edit');
    }
    $('.pt-delete').disabled = false;
    resetDelete();
    setTarget(target);
    message.textContent = merging ? '已合并为新词块，原词块保留' : '已保存到本机';
    needsIndex = true;
    void renderExample();
    return newName;
  }
  function insert(text, label, event) {
    const chunk = listChunks().find((item) => item.name === label);
    if (chunk?.kind === 'oc') {
      void useOCChunk(chunk).then(
        () => {
          message.textContent = '已将「' + chunk.name + '」加入多角色栏';
        },
        (error) => {
          message.textContent = error.message;
        },
      );
      return true;
    }
    if (!target?.isConnected) {
      setTarget(null);
      message.textContent = '请先点选要插入的提示词输入框。';
      return;
    }
    try {
      const touch = touchActivation(event);
      const returnTo = (touch || event?.detail === 0) && event.currentTarget;
      preserveLibraryScroll(target, panel, () => {
        const oldMode = target.getAttribute('inputmode');
        if (touch) target.inputMode = 'none';
        try {
          insertBlock(target, text);
        } finally {
          if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
          if (touch) {
            if (oldMode === null) target.removeAttribute('inputmode');
            else target.setAttribute('inputmode', oldMode);
          }
        }
      });
      message.textContent = '已插入「' + label + '」';
      return true;
    } catch (err) {
      message.textContent = err.message;
      return false;
    }
  }
  function open(field, settings) {
    options = settings;
    const wasClosing = closing;
    const wasMounted = !slot.hidden;
    const already = wasMounted && !wasClosing;
    if (already && settings.toggle && !settings.create) {
      close(settings.sourceEvent);
      return;
    }
    const resumePose = !already ? stopLibraryMotion() : null;
    closing = false;
    slot.inert = false;
    slot.removeAttribute('aria-hidden');
    slot.classList.remove('pt-library-leaving');
    studio.classList.remove('blocks-collapsing');
    if (resumePose && !libraryReduced.matches) studio.classList.add('blocks-transitioning');
    closeSuggestions();
    preserveLibraryScroll(field, panel, () => {
      slot.hidden = false;
      studio.classList.add('blocks-open');
      setTarget(field);
      if (settings.create) openEditor(null, field.value.slice(field.selectionStart, field.selectionEnd));
      else {
        if (!wasMounted && panel.dataset.view === 'edit' && (mergeDraft || drafts.has(selected))) {
          message.textContent = '未保存的草稿已保留';
        } else if (!wasMounted || !panel.dataset.view) {
          changeView('browse');
          if (needsIndex || !items.childElementCount) renderIndex();
          items.scrollTop = listScroll;
        }
        const keepTrigger = touchActivation(settings.sourceEvent) || settings.sourceEvent?.detail === 0;
        (keepTrigger && settings.trigger?.isConnected ? settings.trigger : field).focus({
          preventScroll: true,
        });
      }
      for (const b of studio.querySelectorAll('[data-pt=manage]')) setLibraryToggle(b, true);
    });
    if (resumePose && !libraryReduced.matches) {
      const version = motionVersion;
      const finish = () => {
        if (version === motionVersion && !closing) stopLibraryMotion();
      };
      finishArrival = finish;
      if (!wasMounted) {
        resumePose.opacity = 0;
        resumePose.transform = getComputedStyle(slot).getPropertyValue('--pt-library-exit').trim();
      }
      moveLibrary(resumePose, { opacity: 1, transform: 'none' }, finish);
    }
    if (panel.dataset.view === 'edit' && !wasClosing) void renderExample();
  }
  function close(event) {
    if (slot.hidden || closing) return;
    const pose = stopLibraryMotion();
    const version = motionVersion;
    closing = true;
    if (panel.dataset.view === 'browse') listScroll = items.scrollTop;
    remember();
    resetDelete();
    closeSuggestions();
    const restore =
      panel.contains(document.activeElement) || document.activeElement?.closest('[data-pt=manage]');
    preserveLibraryScroll(target, panel, () => {
      for (const b of studio.querySelectorAll('[data-pt=manage]')) setLibraryToggle(b, false);
      const keyboardOrTouch = event?.type === 'keydown' || event?.detail === 0 || touchActivation(event);
      const focusAfter = keyboardOrTouch && options.trigger?.isConnected ? options.trigger : target;
      if (restore && focusAfter?.isConnected) focusAfter.focus({ preventScroll: true });
    });
    slot.inert = true;
    slot.setAttribute('aria-hidden', 'true');
    slot.classList.add('pt-library-leaving');
    studio.classList.add('blocks-collapsing');
    const finish = () => {
      if (version !== motionVersion || !closing) return;
      preserveLibraryScroll(target, panel, () => {
        slot.hidden = true;
        studio.classList.remove('blocks-open', 'blocks-collapsing');
        slot.classList.remove('pt-library-leaving');
        slot.inert = false;
        slot.removeAttribute('aria-hidden');
        releaseExample();
      });
      closing = false;
      stopLibraryMotion();
    };
    finishDeparture = finish;
    if (libraryReduced.matches || !slot.getClientRects().length) finish();
    else {
      moveLibrary(
        pose,
        {
          opacity: 0,
          transform: getComputedStyle(slot).getPropertyValue('--pt-library-exit').trim(),
        },
        finish,
      );
    }
  }
  $('.pt-x').onclick = close;
  $('.pt-merge-mode').onclick = toggleMergeMode;
  $('.pt-merge-preview').onclick = beginMergeReview;
  $('.pt-merge-clear').onclick = () => {
    mergeNames = [];
    renderIndex();
    message.textContent = '已清空选择';
  };
  $('.pt-back').onclick = () => browse(true);
  $('.pt-new').onclick = () =>
    openEditor(null, target?.value.slice(target.selectionStart, target.selectionEnd) || '');
  query.oninput = () => renderIndex(true);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.stopPropagation();
      e.preventDefault();
      if (panel.dataset.view === 'edit' && !composing && !e.isComposing && e.keyCode !== 229)
        form.requestSubmit();
    }
  });
  form.addEventListener('input', () => {
    if (!loading) {
      remember();
      resetDelete();
      setTarget(target);
      message.textContent = mergeMode ? '合并草稿尚未保存' : drafts.has(selected) ? '草稿尚未保存' : '';
    }
  });
  form.onsubmit = (e) => {
    e.preventDefault();
    try {
      save();
    } catch (err) {
      message.textContent = err.message;
    }
  };
  $('.pt-flat').onclick = (e) => {
    try {
      if (currentExampleChunk()?.kind === 'oc') {
        const id = !clean(formValue(), baseline) ? save() : selected;
        insert(reference(id), id, e);
        return;
      }
      insert(expandChunks(body.value), name.value.trim() || '当前文本', e);
    } catch (err) {
      message.textContent = err.message;
    }
  };
  $('.pt-reference').onclick = (e) => {
    try {
      const id = !selected || !clean(formValue(), baseline) ? save() : selected;
      insert(reference(id), id, e);
    } catch (err) {
      message.textContent = err.message;
    }
  };
  $('.pt-delete').onclick = () => {
    if (!selected) return;
    if (!confirmingDelete) {
      confirmingDelete = true;
      $('.pt-delete').textContent = '确认删除';
      $('.pt-cancel-delete').hidden = false;
      message.textContent = '已有配方中的引用会保留原内容。';
      return;
    }
    try {
      removeChunk(selected);
      drafts.delete(selected);
      writeDrafts();
      changeView('browse');
      resetDelete();
      renderIndex();
      $('.pt-new').focus({ preventScroll: true });
      message.textContent = '已删除词块';
    } catch (err) {
      message.textContent = err.message;
    }
  };
  $('.pt-cancel-delete').onclick = () => {
    resetDelete();
    message.textContent = '';
  };
  // Pointer insertion must not put the caret into the side rail. Keyboard
  // users can tab freely between the editor, the rail, and the canvas.
  panel.addEventListener('pointerdown', (e) => {
    if (
      e.pointerType === 'mouse' &&
      e.button === 0 &&
      !(mergeMode && e.target.closest('.pt-block-pick')) &&
      e.target.closest('.pt-block-pick,.pt-flat,.pt-reference')
    )
      e.preventDefault();
  });
  items.addEventListener('keydown', (e) => {
    if (e.isComposing || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    const row = e.target.closest('.pt-block-row');
    if (!row || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const adjacent = e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
    const next = adjacent?.querySelector(
      e.target.closest('.pt-block-edit') ? '.pt-block-edit' : '.pt-block-pick:not(:disabled)',
    );
    if (next) {
      e.preventDefault();
      next.focus();
    }
  });
  studio.addEventListener('focusin', (e) => {
    if (!slot.hidden && bindings.has(e.target)) setTarget(e.target);
  });
  studio.addEventListener(
    'compositionstart',
    () => {
      composing = true;
    },
    true,
  );
  studio.addEventListener(
    'compositionend',
    () => {
      composing = false;
    },
    true,
  );
  studio.addEventListener('keydown', (e) => {
    if (
      slot.hidden ||
      e.key !== 'Escape' ||
      e.defaultPrevented ||
      e.isComposing ||
      e.keyCode === 229 ||
      composing ||
      document.querySelector('dialog[open]')
    )
      return;
    if (!panel.contains(e.target) && !bindings.has(e.target) && !e.target.closest('[data-pt=manage]')) return;
    e.preventDefault();
    e.stopPropagation();
    if (confirmingDelete) {
      resetDelete();
      message.textContent = '';
    } else close(e);
  });
  watchChunks(() => {
    needsIndex = true;
    renderIndex();
    if (mergeMode && mergeDraft && panel.dataset.view === 'edit') {
      try {
        const latest = prepareChunkMerge(mergeDraft.sources.map((source) => source.name));
        if (
          latest.sources.some(
            (source, index) =>
              source.text !== mergeDraft.sources[index].text ||
              source.expanded !== mergeDraft.sources[index].expanded,
          )
        )
          message.textContent = '源词块已变更，请返回选块并重新预览。';
      } catch (error) {
        message.textContent = error.message;
      }
    }
  });
  attachAutocomplete(body);
  bindInk(body, () => options.getModel?.(), new AbortController().signal);
  changeView('browse');
  return {
    open,
    setTarget,
    forget(field) {
      if (target === field) setTarget(null);
    },
    get visible() {
      return !slot.hidden && !closing;
    },
  };
}

export function openBlockLibrary(field, options = {}) {
  if (!field?.isConnected) return;
  const slot = document.getElementById('block-library-slot'),
    studio = document.getElementById('studio');
  if (!slot || !studio) {
    options.notify?.('词块库尚未加载，请刷新工作台。');
    return;
  }
  blockLibrary ??= createBlockLibrary(slot, studio);
  blockLibrary.open(field, options);
}
function changeOrder(field, direction, notify) {
  const parts = promptParts(field.value),
    picked = targetRange(field, parts);
  const i = parts.findIndex((p) => picked && picked.from >= p.from && picked.to <= p.to);
  if (i < 0) {
    notify?.('请先点选一个标签。');
    return;
  }
  const active = parts[i],
    text = field.value;
  if (direction === 'delete') {
    let from = active.from,
      to = active.to;
    if (parts[i + 1] && !text.slice(to, parts[i + 1].from).includes('|')) to = parts[i + 1].from;
    else if (parts[i - 1] && !text.slice(parts[i - 1].to, from).includes('|')) from = parts[i - 1].to;
    replaceEditorRange(field, from, to, '');
    closeSuggestions();
    return;
  }
  const other = parts[i + (direction === 'prev' ? -1 : 1)];
  if (!other) return;
  const [left, right] = active.from < other.from ? [active, other] : [other, active];
  const delim = text.slice(left.to, right.from);
  if (delim.includes('|')) {
    notify?.('角色或混合提示词的分隔线两侧独立排序。');
    return;
  }
  const at = direction === 'prev' ? left.from : left.from + right.text.length + delim.length;
  replaceEditorRange(field, left.from, right.to, right.text + delim + left.text, at, at + active.text.length);
  closeSuggestions();
}
function pick(field, part) {
  field.focus({ preventScroll: true });
  field.setSelectionRange(part.from, part.to);
  closeSuggestions();
}
function renameVisibleReference(field, detail) {
  if (!detail || !field.value.includes(detail.from)) return;
  const { from, to } = detail,
    old = field.value;
  const mapPosition = (n) => {
    let shift = 0;
    for (let i = old.indexOf(from); i >= 0 && i < n; i = old.indexOf(from, i + from.length)) {
      if (n < i + from.length) return i + shift + Math.min(n - i, to.length);
      shift += to.length - from.length;
    }
    return n + shift;
  };
  const a = mapPosition(field.selectionStart),
    b = mapPosition(field.selectionEnd);
  field.setRangeText(
    old.replaceAll(from, () => to),
    0,
    old.length,
    'preserve',
  );
  field.setSelectionRange(a, b);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

const bindings = new WeakMap();
export function bindPromptField(field, options = {}) {
  if (!field) return;
  if (bindings.has(field)) return bindings.get(field);
  attachAutocomplete(field);
  const events = new AbortController(),
    { signal } = events;
  const clearInk = bindInk(field, options.getModel, signal);
  const clearWeightRange = () => weightRanges.delete(field);
  for (const type of ['input', 'click', 'blur']) field.addEventListener(type, clearWeightRange, { signal });
  field.addEventListener('select', () => {
    const range = weightRanges.get(field);
    if (range && (field.selectionStart !== range.to || field.selectionEnd !== range.to)) clearWeightRange();
  }, { signal });
  field.addEventListener('prompt-block-drag-start', closeSuggestions, { signal });
  field.addEventListener('prompt-editor-fold', closeSuggestions, { signal });
  field.addEventListener(
    'keydown',
    (e) => {
      if (e.isComposing || e.keyCode === 229 || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const action =
        !e.shiftKey && e.key === 'ArrowUp'
          ? 'up'
          : !e.shiftKey && e.key === 'ArrowDown'
            ? 'down'
            : e.shiftKey && (e.code === 'Digit0' || e.code === 'Numpad0')
              ? 'reset'
              : null;
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      adjust(field, action, options.getModel?.(), options.notify);
    },
    { signal },
  );
  field.addEventListener(
    'dblclick',
    () => {
      const selected = field.selectionStart,
        parts = promptParts(field.value),
        r = parts.find((p) => selected >= p.from && selected <= p.to);
      if (r && /^!macro:[^!\n]+!$/.test(r.text)) {
        pick(field, r);
        expandHere(field, options.notify);
      }
    },
    { signal },
  );
  const unwatch = watchChunks((e) => renameVisibleReference(field, e.detail));
  field.addEventListener('prompt-editor-error', (e) => options.notify?.(e.detail), { signal });
  field.addEventListener(
    'prompt-block-remove',
    (event) => {
      event.preventDefault();
      let { from, to } = event.detail;
      const text = field.value,
        reference = text.slice(from, to);
      const outer = promptParts(text).find((part) => part.from <= from && part.to >= to);
      if (outer && unwrap(outer.text).body.trim() === reference) {
        from = outer.from;
        to = outer.to;
      }
      const after = /^[ \t]*[,，][ \t]*/.exec(text.slice(to));
      if (after) to += after[0].length;
      else from -= text.slice(0, from).match(/[,，][ \t]*$/)?.[0].length || 0;
      replaceEditorRange(field, from, to, '');
      closeSuggestions();
    },
    { signal },
  );
  let rail, unmount;
  if (options.inline) {
    rail = element('div', 'pt-inline-host');
    (field.closest('label') || field.closest('.pt-textframe') || field).after(rail);
    unmount = mountPromptTools(rail, () => field, options);
  }
  const cleanup = () => {
    if (document.activeElement === field || field.promptEditor?.focused) closeSuggestions();
    blockLibrary?.forget(field);
    events.abort();
    unwatch();
    unmount?.();
    rail?.remove();
    clearInk();
    bindings.delete(field);
  };
  bindings.set(field, cleanup);
  return cleanup;
}
export function mountPromptTools(host, getField, options = {}) {
  if (!host) return;
  host.classList.add('pt-workbench');
  if (options.inline) host.classList.add('pt-compact');
  const weights = `<div class="pt-weights"><span>权重</span><button type="button" data-pt="down" title="减弱 · Ctrl + ↓" aria-label="减弱当前提示词">−</button><label><input type="number" step=".1" min="-999" max="999" aria-label="当前提示词权重" title="输入精确权重，按回车应用"><span>×</span></label><button data-pt="up" type="button" title="加强 · Ctrl + ↑" aria-label="加强当前提示词">＋</button><button data-pt="reset" class="pt-reset" type="button" title="还原权重 · Ctrl + Shift + 0" aria-label="还原当前提示词权重">↺</button></div>`;
  host.innerHTML = `${options.inline ? '' : `<div class="pt-primary"><button type="button" data-pt="oc" class="pt-entry" aria-label="引用 OC 角色"><span class="pt-entry-name"><em>OC</em><strong>角色</strong></span><span class="pt-entry-arrow" aria-hidden="true">↗</span></button><button type="button" data-pt="manage" class="pt-entry" aria-label="打开词块库"><span class="pt-entry-name"><strong>词块库</strong><em>Blocks</em></span><span class="pt-entry-arrow" aria-hidden="true">↗</span></button></div>`}
    <div class="pt-rail">${weights}<div class="pt-links"><button type="button" data-pt="inspect" aria-expanded="false">标签 <i></i></button>${options.inline ? '<button type="button" data-pt="oc">OC ↗</button><button type="button" data-pt="manage">词块库 ↗</button>' : ''}</div></div>
    <div class="pt-shelf"><span class="pt-shelf-name">常用</span><div class="pt-chips"></div><button type="button" data-pt="create" title="将选中文本存为词块" aria-label="新建词块">＋</button></div>
    <div class="pt-inspector" hidden><div class="pt-tagrow"></div><div class="pt-arrange"><span>点选标签编辑</span><button type="button" data-pt="prev">前移</button><button type="button" data-pt="next">后移</button><button type="button" data-pt="expand">展开词块</button><button type="button" data-pt="delete">移除标签</button></div></div>`;
  if (!options.inline) {
    const legend = element('details', 'pt-legend');
    legend.setAttribute('aria-label', '标签权重色标');
    const summary = element('summary', '', '色标');
    const key = element('span', 'pt-legend-key');
    const body = element('div', 'pt-legend-body');
    legend.append(summary, body);
    for (const [tone, label, title] of [
      ['base', '默认', '默认 1×'],
      ['weak', '弱化', '0 到 1×'],
      ['strong', '强化', '超过 1×'],
      ['negative', '负权', '小于 0×，适用于 V4.5 及以上'],
    ]) {
      const item = element('span', '', label),
        swatch = element('i');
      item.title = title;
      swatch.dataset.tone = tone;
      swatch.setAttribute('aria-hidden', 'true');
      item.prepend(swatch);
      body.append(item);
      key.append(swatch.cloneNode());
    }
    summary.append(key);
    host.querySelector('.pt-links').append(legend);
  }
  const $ = (sel) => host.querySelector(sel),
    model = () => options.getModel?.(),
    number = $('input[type=number]'),
    panel = $('.pt-inspector');
  const events = new AbortController(),
    { signal } = events;
  document.addEventListener(
    'pointerdown',
    (event) => {
      const legend = host.querySelector('.pt-legend[open]');
      if (legend && !legend.contains(event.target)) legend.open = false;
    },
    { signal },
  );
  host.addEventListener(
    'keydown',
    (event) => {
      const legend = host.querySelector('.pt-legend[open]');
      if (legend && event.key === 'Escape') {
        legend.open = false;
        legend.querySelector('summary').focus();
      }
    },
    { signal },
  );
  let lastKey,
    scheduled = false;
  setLibraryToggle($('[data-pt=manage]'), Boolean(blockLibrary?.visible));
  function shelf() {
    const items = listChunks().slice(0, options.inline ? 2 : 4);
    const chips = items.map((c) => {
      const item = button(c.name, c.text, () => {
        if (c.kind === 'oc') void useOCChunk(c).catch((error) => options.notify?.(error.message));
        else insertBlock(getField(), reference(c.name));
      });
      return item;
    });
    $('.pt-chips').replaceChildren(
      ...(chips.length ? chips : [element('small', '', '选中常用提示词，点击 ＋ 收藏')]),
    );
  }
  function paint() {
    scheduled = false;
    const f = getField();
    if (!f || !host.isConnected) return;
    const parts = promptParts(f.value),
      range = targetRange(f, parts);
    const index = parts.findIndex((r) => range && range.from >= r.from && range.to <= r.to);
    const cap = profile(model()),
      value = range ? unwrap((range.outer || range).text).weight : 1;
    if (document.activeElement !== number) number.value = readable(value);
    number.min = cap.negative ? '-999' : cap.numeric ? '0' : '0.02';
    number.step = cap.numeric ? '0.1' : 'any';
    for (const control of host.querySelectorAll('.pt-weights button,.pt-weights input'))
      control.disabled = !range;
    $('[data-pt=inspect] i').textContent = String(parts.length);
    if (panel.hidden) return;
    const key = JSON.stringify([f.value, index, range?.from, range?.to]);
    if (key === lastKey) return;
    lastKey = key;
    const tags = parts.map((p, i) => {
      const parsed = unwrap(p.text),
        name = parsed.body.replace(/^!macro:([^!]+)!$/, '@$1');
      const b = button(name, p.text, () => {
        pick(f, p);
        refresh();
      });
      paintInkWeight(b, parsed.weight);
      b.append(element('em', '', readable(parsed.weight) + '×'));
      b.setAttribute('aria-pressed', String(index === i));
      return b;
    });
    $('.pt-tagrow').replaceChildren(
      ...(tags.length ? tags : [element('small', '', '写下提示词后，在这里选择或排列标签。')]),
    );
    $('[data-pt=prev]').disabled =
      index < 1 || f.value.slice(parts[index - 1]?.to, parts[index]?.from).includes('|');
    $('[data-pt=next]').disabled =
      index < 0 ||
      index >= parts.length - 1 ||
      f.value.slice(parts[index]?.to, parts[index + 1]?.from).includes('|');
    $('[data-pt=delete]').disabled = index < 0;
    $('[data-pt=expand]').disabled = !range?.text.includes('!macro:');
  }
  function refresh() {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(paint);
    }
  }
  function setExact() {
    if (number.disabled) return;
    const v = number.valueAsNumber,
      cap = profile(model()),
      f = getField();
    if (!Number.isFinite(v) || v < (cap.negative ? -999 : cap.numeric ? 0 : 0.02) || v > 999) {
      options.notify?.('该模型不支持此权重。');
      f.focus();
      refresh();
      return;
    }
    adjust(f, 'set', model(), options.notify, v);
    refresh();
  }
  number.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      setExact();
    }
  });
  number.addEventListener('change', () => {
    if (document.activeElement === number) setExact();
  });
  host.addEventListener(
    'click',
    (e) => {
      const action = e.target.closest('[data-pt]')?.dataset.pt,
        f = getField();
      if (!action || !f) return;
      if (['up', 'down', 'reset'].includes(action)) adjust(f, action, model(), options.notify);
      else if (['prev', 'next', 'delete'].includes(action)) changeOrder(f, action, options.notify);
      else if (action === 'inspect') {
        panel.hidden = !panel.hidden;
        $('[data-pt=inspect]').setAttribute('aria-expanded', String(!panel.hidden));
        lastKey = null;
      } else if (action === 'expand') expandHere(f, options.notify);
      else if (action === 'oc') {
        closeSuggestions();
        promptAtlasPicker ??= mountAtlasPicker({
          getWorks: () => promptAtlasOptions.getWorks?.() || [],
          notify: (message) => options.notify?.(message),
        });
        promptAtlasPicker.open({
          type: 'oc',
          onSelect: async (entry) => {
            if (!entry.chunkName) throw Error('这个 OC 尚未保存外貌提示词。');
            if (!promptAtlasOptions.onUseOC) throw Error('角色栏尚未准备好，请稍后重试。');
            await promptAtlasOptions.onUseOC(entry);
          },
        });
      } else if (action === 'create' || action === 'manage')
        openBlockLibrary(f, {
          create: action === 'create',
          toggle: action === 'manage',
          notify: options.notify,
          getModel: model,
          trigger: e.target.closest('[data-pt]'),
          sourceEvent: e,
        });
      refresh();
    },
    { signal },
  );
  const observed = (e) => {
    if (e.target === getField() || document.activeElement === getField() || host.contains(e.target)) refresh();
  };
  for (const type of ['input', 'select', 'focusin', 'selectionchange'])
    document.addEventListener(type, observed, { signal });
  const unwatch = watchChunks(() => {
    shelf();
    refresh();
  });
  shelf();
  paint();
  return () => {
    events.abort();
    unwatch();
    host.replaceChildren();
  };
}
