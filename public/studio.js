import { two } from './plates.js';
import { loadIcons, setIcon } from './icons.js';
import { openCatalog, mountSuggestionSource, findReferencedCharacters, configureCatalog } from './catalog.js';
import { mountControls } from './studio-controls.js';
import { capabilities } from './controls-model.js';
import {
  listWorks,
  writeWorks,
  writeDraft,
  loadRecipe,
  removeWork,
  restoreWorks,
  listLineage,
} from './archive-store.js';
import {
  expandChunks,
  expandPrompt,
  listChunks,
  resolvePromptReferences,
  reference,
  replaceEditorRange,
} from './chunks.js';
import { mountPromptTools, bindPromptField, configurePromptAtlas } from './prompt-tools.js';
import { mountCharacterImport } from './character-import.js';
import { planCharacterMigration } from './character-sections.js';
import { mountAtlas } from './atlas.js';
import { ensureChunkEntries, captureGenerated } from './atlas-store.js';
import { searchItems, normalizeSearch } from './fuzzy-search.js';
import { mountBilling } from './billing.js';
import { mountProofViewer } from './proof-viewer.js';
import { mountProofActions } from './proof-actions.js';
import { mountStudioFinish } from './atelier.js';
import { mountStudioEntrance } from './studio-motion.js';
import { mountScreenExit } from './screen-exit.js';
import { transitionScreen, transitionTheme, mountToast, revealHeadings } from './motion.js';
import { mountGenerationAtmosphere } from './generation-atmosphere.js';
import { mountArchiveLayout } from './archive-layout.js';
import { mountRemovalConfirmation } from './removal-confirmation.js';
import { mountArchiveScoring } from './archive-scoring.js';
import { mountArchiveAppreciation } from './archive-appreciation.js';
import { mountPendingHistory } from './history-pending.js';
import { mountHistoryMotion } from './history-motion.js';
import { mountPromptTokens } from './prompt-tokens.js';
import { mountProofNotebook } from './proof-notebook.js';
import { mountProofProgress } from './proof-progress.js';
import { mountMetaReuse } from './meta-reuse.js';
import { mountLineageCanvas } from './lineage-canvas.js';
import {
  LINEAGE_VERSION,
  snapshotWork,
  appendReuse,
  activeReuses,
  reuseToken,
  createLineageRecords,
  buildLineageGraph,
  pruneLineage,
} from './lineage-core.js';

const $ = (id) => document.getElementById(id);
const make = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};
const prompt = $('prompt'),
  negative = $('negative');
const stamp = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const imageURLs = new WeakMap();
let controls,
  promptTokens,
  proofNotebook,
  proofActions,
  latestAccount,
  activePrompt = prompt,
  current,
  works = [],
  request = null,
  activeGeneration = null,
  completedInBackground = null,
  draftTimer,
  modeName = '生成图像',
  revision = 0;
const viewer = mountProofViewer($('canvas-stage'), $('canvas-image'), { toolbarHost: $('proof-view-tools') });
const atmosphere = mountGenerationAtmosphere($('canvas-stage'));
const proofProgress = mountProofProgress(document.querySelector('.proof-foot'));
const finish = mountStudioFinish({ notify });
const studioEntrance = mountStudioEntrance($('studio'));
const screenExit = mountScreenExit();
const removal = mountRemovalConfirmation(deleteHistoryWork);
const archiveLayout = mountArchiveLayout($('archive-grid'), {
  createCard: createArchiveCard,
  updateCard: (card, work) => archiveScoring.decorate(card, work),
  onUnmount: removal.forget,
  getURL: itemUrl,
});
const archiveScoring = mountArchiveScoring($('archive-score-controls'), {
  onChange: () => renderArchive(),
  notify,
});
let archiveQuery = '',
  currentScreen = 'studio';
const screenScroll = new Map();
const atlas = mountAtlas($('atlas'), {
  getWorks: () => works,
  onUse: async (entry) => {
    try {
      if (entry.type === 'oc') {
        useOC(entry);
        return;
      } else if (entry.type === 'material') {
        if (!entry.blob) return notify('先为素材添加一张图片。');
        await controls.setSourceImage(
          entry.blob,
          'img2img',
          works.some((work) => work.id === entry.sourceWorkId) ? { workId: entry.sourceWorkId } : undefined,
        );
      } else {
        const chunk = listChunks().find((item) => item.id === entry.chunkId || item.atlasId === entry.id);
        if (!chunk) return notify('这个条目尚未绑定词块，请编辑后保存。');
        const field = activePrompt?.isConnected ? activePrompt : prompt;
        const start = field.selectionStart ?? field.value.length;
        const end = field.selectionEnd ?? start;
        const prefix = start && !/[,，\s]$/.test(field.value.slice(0, start)) ? ', ' : '';
        setScreen(false);
        setPanel('compose');
        replaceEditorRange(field, start, end, prefix + reference(chunk.name) + ', ');
      }
      setScreen(false);
      setPanel('compose');
      notify(entry.type === 'material' ? '已作为图生图底图' : '已引用「' + entry.name + '」');
    } catch (error) {
      notify(error.message);
    }
  },
  onOpenWork: (work) => {
    showWork(work);
    setScreen(false);
    setPanel('canvas');
  },
  notify,
});
const pendingHistory = mountPendingHistory($('contact-strip'), { onOpen: returnToGeneration });
const historyMotion = mountHistoryMotion($('contact-strip'));
const lineageRecords = new Map();
const deletedWorkIds = new Set();
let lineageReuse = [];
const lineageReady = listLineage()
  .then((saved) => {
    for (const node of saved) if (!lineageRecords.has(node.id)) lineageRecords.set(node.id, node);
  })
  .catch(() => notify('本地线索暂时无法读取，现有作品仍可使用。'));
const lineageCanvas = mountLineageCanvas({
  getGraph: async (work) => {
    await lineageReady;
    return buildLineageGraph(work, lineageRecords, works);
  },
  getImageUrl: itemUrl,
  onOpenWork: (work) => {
    showWork(work);
    setScreen(false);
    setPanel('canvas');
  },
  notify,
});
const metaReuse = mountMetaReuse({
  getRecipe: async (work) => {
    const original = work.recipeId && (await loadRecipe(work.recipeId));
    return { ...work, settings: { ...original, ...work.settings } };
  },
  getImageUrl: (work) => (work.blob ? itemUrl(work) : ''),
  onApply: (patch, { work, groups }) => {
    applyRecipe({ ...patch, settings: { ...controls.getSettings({ includeMedia: true }), ...patch.settings } });
    lineageReuse = appendReuse(lineageReuse, work, groups, patch);
    saveDraft(true);
    setScreen(false);
    setPanel('compose');
    notify('已复用选中的 META · ' + groups.length + ' 项');
  },
  notify,
});
const appreciation = mountArchiveAppreciation({
  getWorks: () => filteredArchiveWorks(),
  getRecipe: async (work) => {
    const original = work.recipeId && (await loadRecipe(work.recipeId));
    return { ...work, settings: { ...original, ...work.settings } };
  },
  onOpenStudio: (work) => {
    showWork(work);
    setPanel('canvas');
    setScreen(false);
  },
  onReuse: (work) => metaReuse.open(work),
  onCollect: (work) => atlas.openSaveWork(work),
  onLineage: (work) => lineageCanvas.open(work),
  onRequestDelete: (work) => {
    if (archiveLayout.focusWork(work.id)) {
      const card = document.activeElement?.closest('.archive-card');
      if (card?.dataset.workId === work.id)
        removal.arm(card, works.find(item => item.id === work.id), card.querySelector('.archive-open'));
    }
  },
  onScore: (updated) => {
    for (const work of new Set([
      works.find((item) => item.id === updated.id),
      current?.id === updated.id ? current : null,
    ])) {
      if (!work) continue;
      delete work.score;
      delete work.scoreUpdated;
      Object.assign(work, updated);
    }
    renderArchive();
  },
  notify,
});
document.addEventListener(
  'pointerdown',
  (event) => {
    for (const card of $('archive-grid').querySelectorAll('[data-actions-open]')) {
      if (card.contains(event.target)) continue;
      card.removeAttribute('data-actions-open');
      card.querySelector('.archive-more')?.setAttribute('aria-expanded', 'false');
    }
  },
  { passive: true },
);
const toast = mountToast($('toast'));
function notify(message) {
  toast(message);
}
let mediaChanged = false;
let mediaVersion = null;
function flushDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  if (!controls) return;
  if (mediaChanged) mediaVersion = crypto.randomUUID();
  const draft = {
    savedAt: Date.now(),
    mediaVersion,
    prompt: prompt.value,
    negative: negative.value,
    settings: controls.getSettings(),
    lineageReuse,
  };
  let includeMedia = mediaChanged;
  mediaChanged = false;
  try {
    localStorage.setItem('folio.draft', JSON.stringify(draft));
  } catch {
    includeMedia = true;
  }
  if (includeMedia) {
    writeDraft({ ...draft, settings: controls.getSettings({ includeMedia: true }) }).catch(() =>
      notify('底图或参考图未能存入浏览器，可从「配方」导出备份。'),
    );
  }
}
function saveDraft(changed = false) {
  revision++;
  mediaChanged ||= changed;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 230);
}
window.addEventListener('pagehide', () => {
  if (draftTimer) flushDraft();
});
function charCount() {
  $('char-count').textContent = Array.from(activePrompt.value).length + ' 字符';
}
function setPanel(panel) {
  const previous = $('studio').dataset.panel;
  $('studio').dataset.panel = panel;
  document
    .querySelectorAll('.mobile-views [data-view]')
    .forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.view === panel)));
  if (panel !== previous && matchMedia('(max-width: 760px)').matches)
    finish.enter(
      document.querySelector(
        '.' + { compose: 'compose', canvas: 'proof', history: 'history' }[panel] + '-panel',
      ),
    );
}
for (const btn of document.querySelectorAll('.mobile-views [data-view]'))
  btn.onclick = () => setPanel(btn.dataset.view);
function setScreen(target, viewTransition = false) {
  screenExit.cancel();
  const screen = target === true ? 'archive' : target === false ? 'studio' : target;
  const changed = currentScreen !== screen;
  if (changed) screenScroll.set(currentScreen, window.scrollY);
  currentScreen = screen;
  for (const id of ['studio', 'archive', 'atlas']) {
    $(id).hidden = id !== screen;
    $(id + '-nav').toggleAttribute('aria-current', id === screen);
  }
  $(screen + '-nav').setAttribute('aria-current', 'page');
  if (screen === 'archive') renderArchive();
  else if (changed) archiveLayout.refresh();
  if (screen === 'atlas') void atlas.refresh();
  if (changed) {
    // Animate the content, keeping the shared masthead fixed and immediately usable.
    studioEntrance.cancel();
    if (screen === 'studio') studioEntrance.play();
    else if (!viewTransition) finish.enter($(screen));
    revealHeadings($(screen), viewTransition ? 120 : 40);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (currentScreen === screen)
          window.scrollTo({ top: screenScroll.get(screen) || 0, behavior: 'instant' });
      }),
    );
  }
}
function navigateScreen(target) {
  const screen = target === true ? 'archive' : target === false ? 'studio' : target;
  studioEntrance.cancel();
  screenExit.cancel();
  if (currentScreen === screen) return;
  const scrollAfter = screenScroll.get(screen) || 0;
  const swapped = transitionScreen(
    () => {
      setScreen(screen, true);
      window.scrollTo({ top: scrollAfter, behavior: 'instant' });
    },
    { scrollAfter, layered: screen === 'studio' },
  );
  if (!swapped) screenExit.play($(currentScreen), () => setScreen(screen));
}
function useOC(entry) {
  const chunk = listChunks().find((item) => item.id === entry.chunkId || item.atlasId === entry.id);
  if (!chunk) throw Error('这个 OC 尚未保存外貌提示词。');
  useCharacterPrompt(reference(chunk.name), entry.name);
}
function useCharacterPrompt(text, name, { target, start, end } = {}) {
  const settings = controls.getSettings({ includeMedia: true });
  const cap = capabilities(settings);
  if (!cap.chars) throw Error('当前模型不支持多角色，请先切换到 V4 或更新模型。');
  const characters = (settings.characters || []).map((character) => ({ ...character }));
  const existing =
    target?.isConnected && target.matches('textarea[data-key="prompt"]') && target.closest('.fc-char');
  let index = existing ? Number(existing.dataset.c) : -1;
  const inPlace = Number.isInteger(index) && index >= 0 && index < characters.length;
  if (!inPlace)
    index = characters.findIndex((character) => !character.prompt?.trim() && !character.negative?.trim());
  if (index < 0) {
    if (characters.length >= cap.chars)
      throw Error('当前模型最多支持 ' + cap.chars + ' 个角色，请先移除一个角色。');
    index = characters.length;
    characters.push({ prompt: '', negative: '', x: 0.5, y: 0.5, enabled: true });
  }
  if (inPlace) {
    const previous = characters[index].prompt || '';
    const from = Math.max(0, Math.min(previous.length, start ?? previous.length));
    const to = Math.max(from, Math.min(previous.length, end ?? from));
    const before = previous.slice(0, from),
      after = previous.slice(to);
    const prefix = before && !/[,，\n]\s*$/.test(before) ? ', ' : '';
    const suffix = after && !/^\s*[,，\n]/.test(after) ? ', ' : '';
    text = before + prefix + text + suffix + after;
  }
  characters[index] = { ...characters[index], prompt: text, enabled: true };
  controls.restore({ ...settings, mode: cap.imageMode ? settings.mode : 'generate', characters });
  setScreen(false);
  setPanel('compose');
  controls.openSection('characters');
  requestAnimationFrame(() => {
    const field = document.querySelector(
      `[data-section="characters"] [data-c="${index}"] textarea[data-key="prompt"]`,
    );
    (field?.promptEditor?.element || field)?.focus({ preventScroll: true });
  });
  saveDraft();
  notify('已将「' + name + '」加入角色 ' + (index + 1));
}
function migrateCharacterSections(parsed) {
  if (prompt.value !== parsed.source) throw Error('提示词刚刚发生了变化，请完成编辑后重试。');
  const settings = controls.getSettings({ includeMedia: true });
  const cap = capabilities(settings);
  const { characters, migrated } = planCharacterMigration(settings, parsed.sections, cap.chars);
  // Preflight the entire batch before removing anything from the main prompt.
  controls.restore({ ...settings, mode: cap.imageMode ? settings.mode : 'generate', characters });
  if (prompt.promptEditor)
    prompt.promptEditor.replace(
      0,
      parsed.source.length,
      parsed.remaining,
      parsed.remaining.length,
      parsed.remaining.length,
      'insertFromCharacterImport',
    );
  else {
    prompt.value = parsed.remaining;
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
  }
  controls.openSection('characters');
  charCount();
  saveDraft();
  return migrated;
}
function replaceImportedCharacters(batch, values) {
  const settings = controls.getSettings({ includeMedia: true });
  const characters = (settings.characters || []).map((character) => ({ ...character }));
  let skipped = 0;
  for (const value of values) {
    const { slot, expected } = batch[value.index];
    const current = characters[slot];
    // A delayed save must not overwrite a different role after edits/reordering.
    if (!current || ['prompt', 'negative', 'x', 'y', 'enabled'].some((key) => current[key] !== expected[key])) {
      skipped++;
      continue;
    }
    characters[slot] = { ...current, prompt: value.prompt };
  }
  if (skipped < values.length) {
    controls.restore({ ...settings, characters });
    controls.openSection('characters');
    saveDraft();
  }
  return { skipped };
}
function itemUrl(work) {
  if (!imageURLs.has(work)) imageURLs.set(work, URL.createObjectURL(work.blob));
  return imageURLs.get(work);
}
function shortPrompt(work) {
  return (
    work.prompt?.trim().slice(0, 65) ||
    { inpaint: '局部重绘', img2img: '图像变体', augment: '导演工具', upscale: '超分放大' }[work.mode] ||
    '生成图像'
  );
}
const historyTiles = new Map();
let historyQueue = Promise.resolve(),
  removedWorks = [],
  undoTimer,
  undoRevision = 0;
const undoTray = make('div', 'history-undo');
undoTray.hidden = true;
const undoCount = make('span'),
  undoButton = make('button', '', '撤销');
undoButton.id = 'undo-history-delete';
undoButton.type = 'button';
undoTray.setAttribute('role', 'status');
undoTray.append(undoCount, undoButton);
$('toast').before(undoTray);
function expireUndo() {
  for (const { work } of removedWorks) {
    const url = imageURLs.get(work);
    if (url) URL.revokeObjectURL(url);
    imageURLs.delete(work);
  }
  removedWorks = [];
  undoTray.hidden = true;
}
function refreshUndo() {
  clearTimeout(undoTimer);
  const version = ++undoRevision;
  undoTray.hidden = !removedWorks.length;
  undoCount.textContent = '已删除 ' + removedWorks.length + ' 张';
  if (removedWorks.length)
    undoTimer = setTimeout(() => {
      historyQueue = historyQueue.then(() => {
        if (version === undoRevision) expireUndo();
      });
    }, 10000);
}
function deleteHistoryWork(work) {
  historyQueue = historyQueue.then(async () => {
    if (!works.some((item) => item.id === work.id)) return;
    const focused = document.activeElement;
    const tile = historyTiles.get(work.id);
    const fromArchive = focused?.closest('.archive-card')?.dataset.workId === work.id;
    const keepFocus = fromArchive || tile?.contains(focused);
    const order = fromArchive ? filteredArchiveWorks() : works;
    const index = order.findIndex((item) => item.id === work.id);
    const neighbor = order[index + 1] || order[index - 1];
    try {
      const snapshot = await removeWork(work.id);
      const restoreFocus = keepFocus && document.activeElement === focused;
      // A generated image can still be in memory when local storage is full.
      const lineage = [...lineageRecords.values()].filter(
        (node) =>
          node.id === work.id || node.edges?.some((edge) => edge.source === work.id || edge.target === work.id),
      );
      removedWorks.push({ work, recipe: snapshot?.recipe, lineage: snapshot?.lineage || lineage });
      deletedWorkIds.add(work.id);
      const cleaned = pruneLineage([...lineageRecords.values()], [work.id]);
      lineageRecords.clear();
      for (const node of cleaned) lineageRecords.set(node.id, node);
      lineageReuse = lineageReuse.filter((entry) => entry.id !== work.id);
      const draftSettings = controls.getSettings({ includeMedia: true });
      if (draftSettings.source?.origin?.workId === work.id) {
        delete draftSettings.source.origin;
        controls.restore(draftSettings);
      }
      saveDraft(true);
      if (currentScreen === 'archive') archiveLayout.depart(work.id);
      if (historyMotion.depart(tile, work.id)) historyTiles.delete(work.id);
      works = works.filter((item) => item.id !== work.id);
      if (current?.id === work.id) {
        current = null;
        if (!activeGeneration?.viewing) showEmpty();
      }
      if (completedInBackground?.id === work.id) completedInBackground = null;
      syncNotebookGeneration();
      drawStrip();
      renderArchive();
      refreshUndo();
      finish.enter(undoTray);
      if (restoreFocus && fromArchive) {
        if (!neighbor || !archiveLayout.focusWork(neighbor.id)) undoButton.focus({ preventScroll: true });
      } else if (restoreFocus) {
        (historyTiles.get(neighbor?.id)?.querySelector('.history-delete') || undoButton).focus({ preventScroll: true });
      }
    } catch {
      notify('删除失败，图片仍保留在历史中。');
    }
  });
  return historyQueue;
}
undoButton.onclick = () => {
  clearTimeout(undoTimer);
  historyQueue = historyQueue.then(async () => {
    const batch = [...removedWorks];
    if (!batch.length) return;
    undoButton.disabled = true;
    try {
      await restoreWorks(batch);
      for (const snapshot of batch) {
        archiveLayout.finishDeparture(snapshot.work.id);
        historyMotion.finishDeparture(snapshot.work.id);
        deletedWorkIds.delete(snapshot.work.id);
        for (const node of snapshot.lineage || []) {
          const existing = lineageRecords.get(node.id);
          const edges = new Map(
            [...(existing?.edges || []), ...(node.edges || [])].map((edge) => [edge.id, edge]),
          );
          lineageRecords.set(node.id, { ...node, ...existing, edges: [...edges.values()] });
        }
      }
      const existing = new Set(works.map((work) => work.id));
      works.push(...batch.map((item) => item.work).filter((work) => !existing.has(work.id)));
      works.sort((a, b) => b.created - a.created || a.sequence - b.sequence);
      removedWorks = [];
      refreshUndo();
      drawStrip(new Set(batch.map((item) => item.work.id)));
      renderArchive();
      notify('已恢复 ' + batch.length + ' 张作品与配方');
      const restoredId = batch[0].work.id;
      if (currentScreen === 'archive') {
        if (!archiveLayout.focusWork(restoredId)) $('archive-search').focus({ preventScroll: true });
      } else {
        historyTiles.get(restoredId)?.querySelector('.history-open')?.focus({ preventScroll: true });
      }
    } catch {
      notify('恢复失败，可以再次点击撤销。');
      refreshUndo();
    } finally {
      undoButton.disabled = false;
    }
  });
};
function drawStrip(freshIds) {
  $('strip-count').textContent = two(works.length);
  const host = $('contact-strip');
  const live = new Set(works.map((w) => w.id));
  for (const [id, tile] of historyTiles)
    if (!live.has(id)) {
      removal.forget(tile);
      tile.remove();
      historyTiles.delete(id);
    }
  if (!works.length) {
    if (pendingHistory.active) {
      pendingHistory.sync();
      return;
    }
    if (!host.querySelector('.history-empty')) host.append(make('span', 'history-empty', '暂无记录'));
    return;
  }
  host.querySelector('.history-empty')?.remove();
  // Inert departure slots hold their place until their animation completes.
  const nextWorkTile = (element) => {
    while (element && !element.matches('.history-item:not([data-pending])')) element = element.nextElementSibling;
    return element;
  };
  let cursor = nextWorkTile(host.firstElementChild);
  works.forEach((work, i) => {
    const num = two(works.length - i);
    let tile = historyTiles.get(work.id);
    if (!tile) {
      tile = make('div', 'history-item');
      const open = make('button', 'history-open');
      open.type = 'button';
      open.dataset.workId = work.id;
      const surface = make('span', 'hm-thumbnail');
      const img = make('img');
      img.src = itemUrl(work);
      img.loading = 'lazy';
      img.alt = '';
      const sizeThumbnail = (width, height) => {
        if (!(width > 0 && height > 0)) return;
        img.width = width;
        img.height = height;
        surface.style.setProperty('--thumb-aspect', width + ' / ' + height);
        img.style.aspectRatio = width + ' / ' + height;
      };
      sizeThumbnail(work.width, work.height);
      img.addEventListener('load', () => sizeThumbnail(img.naturalWidth, img.naturalHeight), { once: true });
      surface.append(img);
      open.append(surface, make('small'));
      open.onclick = () => {
        setPanel('canvas');
        showWork(work);
      };
      const del = make('button', 'history-delete');
      del.type = 'button';
      del.dataset.workId = work.id;
      del.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5m4-5v5"/></svg>';
      del.onclick = () => removal.arm(tile, work, open, surface);
      const trail = make('button', 'history-lineage');
      trail.type = 'button';
      trail.title = '查看图片线索';
      trail.setAttribute('aria-label', '查看图片线索');
      setIcon(trail, 'lineage');
      trail.onclick = () => lineageCanvas.open(work);
      tile.append(open, trail, del);
      historyTiles.set(work.id, tile);
    }
    const label = '作品 ' + num + ' · ' + shortPrompt(work);
    const open = tile.querySelector('.history-open');
    if (!tile.hasAttribute('data-removal-armed')) {
      open.title = label;
      open.setAttribute('aria-label', label);
    }
    open.querySelector('small').textContent = num;
    open.setAttribute('aria-pressed', String(work.id === current?.id));
    tile.dataset.selected = String(work.id === current?.id);
    tile.querySelector('.history-delete').setAttribute('aria-label', '删除作品 ' + num);
    tile.querySelector('.history-delete').title = '删除作品 · 可撤销';
    if (cursor !== tile) host.insertBefore(tile, cursor);
    cursor = nextWorkTile(tile.nextElementSibling);
    if (freshIds?.has(work.id) && work.id !== pendingHistory.completingId)
      finish.enter(tile, Math.min(i, 3) * 45);
  });
  pendingHistory.sync();
}
function preview(state, url, alt, title, info, reveal = false, slide = 0) {
  $('canvas-stage').dataset.state = state;
  viewer.show({
    url,
    alt,
    state,
    reveal,
    slide,
    historyKey: state === 'result' ? current?.id : null,
    historyOrder: state === 'result' && slide ? works.map((work) => work.id) : [],
  });
  finish.setProof(
    state === 'result' ? current : null,
    state === 'stream' ? 'LIVE' : null,
    works.length - works.indexOf(current),
  );
  $('image-title').textContent = title;
  $('image-info').textContent = info;
  $('expand').disabled = !url;
  for (const id of ['download-image', 'use-source', 'clear-preview', 'image-lineage', 'save-atlas'])
    $(id).hidden = state !== 'result';
  proofActions?.refresh();
}
function syncNotebookGeneration() {
  proofProgress.setViewing(Boolean(activeGeneration?.viewing));
  proofNotebook?.setGeneration({
    active: Boolean(activeGeneration && request && !request.signal.aborted),
    viewing: Boolean(activeGeneration?.viewing),
    completedWork: completedInBackground,
    settings: activeGeneration
      ? {
          ...activeGeneration.settings,
          ...(activeGeneration.prepared
            ? { width: activeGeneration.width, height: activeGeneration.height }
            : {}),
        }
      : undefined,
  });
}
function leaveGeneration(work) {
  if (!activeGeneration) return;
  activeGeneration.viewing = false;
  if (work?.id) activeGeneration.returnWork = work;
  atmosphere.cancel();
  pendingHistory.select(false);
  finish.viewingGeneration(false);
  syncNotebookGeneration();
}
function displayGeneration() {
  const run = activeGeneration;
  if (!run || !request || request.signal.aborted || !run.prepared) return;
  run.viewing = true;
  current = null;
  pendingHistory.select(true);
  finish.viewingGeneration(true);
  viewer.prepare(run);
  atmosphere.begin({ ...run, url: run.lastPreview?.url || run.referenceURL });
  finish.setProof(null);
  $('image-title').textContent = '等待显影';
  $('image-info').textContent = run.width + ' × ' + run.height;
  $('expand').disabled = true;
  for (const id of ['download-image', 'use-source', 'clear-preview', 'image-lineage', 'save-atlas'])
    $(id).hidden = true;
  proofNotebook?.setWork(null);
  proofNotebook?.setDraft(run.settings);
  if (run.lastPreview) {
    const { url, info } = run.lastPreview;
    preview('stream', url, 'NovelAI 中间预览', '流式预览', info);
    atmosphere.preview(url);
  }
  drawStrip();
  syncNotebookGeneration();
  proofActions?.refresh();
}
function returnToGeneration() {
  if (activeGeneration && request && !request.signal.aborted) {
    setScreen(false);
    setPanel('canvas');
    if (!activeGeneration.viewing) displayGeneration();
    return;
  }
  if (completedInBackground && works.some((work) => work.id === completedInBackground.id)) {
    showWork(completedInBackground);
    setScreen(false);
    setPanel('canvas');
  }
}
function showEmpty() {
  leaveGeneration();
  current = null;
  const settings = controls?.getSettings();
  preview('empty', '', '', '画布待命', settings ? settings.width + ' × ' + settings.height : '');
  proofNotebook?.setWork(null);
  proofNotebook?.setDraft(settings);
  drawStrip();
}
function showWork(work, reveal = false, freshIds) {
  const slide =
    !reveal && current?.id !== work.id ? (current && works.indexOf(work) < works.indexOf(current) ? -1 : 1) : 0;
  leaveGeneration(work);
  current = work;
  if (completedInBackground?.id === work.id) completedInBackground = null;
  const info = [
    work.width && work.height ? work.width + ' × ' + work.height : '',
    work.settings.seed != null ? 'SEED ' + work.settings.seed : '',
    stamp.format(work.created),
  ]
    .filter(Boolean)
    .join('  /  ');
  preview('result', itemUrl(work), shortPrompt(work), work.modelLabel || '生成结果', info, reveal, slide);
  proofNotebook?.setWork(work);
  syncNotebookGeneration();
  drawStrip(freshIds);
}
function download(url, name) {
  const a = make('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
}
function applyRecipe(recipe) {
  if (typeof recipe.prompt === 'string') prompt.value = recipe.prompt;
  if (typeof recipe.negative === 'string') negative.value = recipe.negative;
  if (recipe.settings) controls.restore(recipe.settings);
  for (const field of [prompt, negative]) field.dispatchEvent(new Event('input', { bubbles: true }));
  charCount();
  saveDraft();
}
function filteredArchiveWorks() {
  return archiveScoring.sort(
    searchItems(works, archiveQuery, (work) => [
      work.prompt || '',
      ...(work.settings?.characters || [])
        .filter((character) => character.enabled !== false)
        .map((character) => character.prompt || ''),
    ]),
  );
}
function renderArchive() {
  $('nav-count').textContent = $('archive-total').textContent = two(works.length);
  if (currentScreen !== 'archive') return;
  const filtered = filteredArchiveWorks();
  $('archive').querySelector('.section-rule > .micro').textContent = archiveScoring.enabled
    ? '完整画幅 / 高分优先 · 同分按原顺序'
    : '完整画幅 / 最新在前';
  $('archive-search-count').textContent = archiveQuery.trim()
    ? filtered.length + ' / ' + works.length + ' 张匹配'
    : '按正面提示词搜索 · 支持模糊匹配';
  $('archive-search-clear').hidden = !archiveQuery;
  const grid = $('archive-grid');
  archiveLayout.setWorks(filtered);
  grid.querySelector('.archive-empty')?.remove();
  if (!filtered.length) {
    const empty = make('div', 'archive-empty'),
      button = make('button', '', works.length ? '清除搜索 ↗' : '返回工作台 ↗');
    button.onclick = () => (works.length ? clearArchiveSearch() : setScreen(false));
    empty.append(
      Object.assign(make('i', 'flower folio-mark'), { ariaHidden: 'true' }),
      make('h2', '', works.length ? 'A different phrase?' : 'First impressions'),
      make(
        'p',
        '',
        works.length
          ? '没有找到匹配的正面提示词，试试更短的标签。'
          : '第一张生成图会出现在这里。作品和配方保存在当前浏览器。',
      ),
      button,
    );
    grid.append(empty);
  }
}
function createArchiveCard(work) {
  const card = make('article', 'archive-card'),
    button = make('button', 'archive-open'),
    image = make('img');
  card.dataset.workId = work.id;
  if (work.width > 0 && work.height > 0) {
    card.dataset.width = image.width = work.width;
    card.dataset.height = image.height = work.height;
  }
  button.type = 'button';
  button.setAttribute('aria-label', '查看作品：' + shortPrompt(work));
  image.decoding = 'async';
  image.alt = shortPrompt(work);
  button.append(image);
  const caption = make('div', 'archive-caption'),
    dimensions = make('span', 'archive-dimensions');
  const updateDimensions = () => {
    const width = image.naturalWidth || work.width,
      height = image.naturalHeight || work.height;
    dimensions.textContent = width && height ? width + ' × ' + height : '';
    card.toggleAttribute('data-wide', width / height > 2.4);
  };
  updateDimensions();
  image.addEventListener('load', updateDimensions);
  caption.append(
    make('strong', '', shortPrompt(work)),
    make('span', 'micro', stamp.format(work.created) + '  /  ' + (work.modelLabel || 'NOVELAI')),
    dimensions,
  );
  button.onclick = () => appreciation.open(work);
  const actions = make('div', 'record-tools archive-actions');
  const action = (label, icon, name) => {
    const item = make('button');
    item.type = 'button';
    item.title = label;
    item.setAttribute('aria-label', label);
    item.dataset.archiveAction = name;
    setIcon(item, icon);
    return item;
  };
  const restore = action('复用配方', 'sliders', 'restore'),
    trail = action('查看图片线索', 'lineage', 'lineage'),
    collect = action('收藏到万象集', 'bookmark', 'collect'),
    dl = action('下载原图', 'download', 'download'),
    del = action('删除作品', 'trash', 'delete'),
    more = action('作品操作', 'more', 'more');
  more.className = 'archive-more';
  actions.id = 'archive-actions-' + work.id;
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', '作品操作');
  more.setAttribute('aria-controls', actions.id);
  more.setAttribute('aria-expanded', 'false');
  more.onclick = () => {
    const opened = card.toggleAttribute('data-actions-open');
    more.setAttribute('aria-expanded', String(opened));
    if (opened) restore.focus({ preventScroll: true });
  };
  const closeActions = () => {
    card.removeAttribute('data-actions-open');
    more.setAttribute('aria-expanded', 'false');
  };
  card.addEventListener('focusout', (event) => {
    if (!card.contains(event.relatedTarget)) closeActions();
  });
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && card.hasAttribute('data-actions-open')) {
      closeActions();
      more.focus({ preventScroll: true });
      event.stopPropagation();
    }
  });
  restore.onclick = () => {
    closeActions();
    metaReuse.open(work);
  };
  trail.onclick = () => {
    closeActions();
    lineageCanvas.open(work);
  };
  collect.onclick = () => {
    closeActions();
    atlas.openSaveWork(work);
  };
  dl.onclick = () => {
    download(itemUrl(work), work.filename);
    closeActions();
  };
  del.onclick = () => {
    closeActions();
    removal.arm(card, work, button);
  };
  actions.append(collect, restore, trail, dl, del);
  card.append(button, caption, actions, more);
  archiveScoring.decorate(card, work);
  return card;
}
function showPreview(frame) {
  if (!request || request.signal.aborted) return;
  proofProgress.frame(frame);
  const { url, dataUrl, step, sample } = frame;
  if (!(url || dataUrl)) return;
  const info = '样本 ' + ((sample ?? 0) + 1) + (step != null ? ' · 第 ' + step + ' 步' : '');
  if (activeGeneration) activeGeneration.lastPreview = { url: url || dataUrl, info };
  if (activeGeneration?.viewing) {
    preview('stream', url || dataUrl, 'NovelAI 中间预览', '流式预览', info);
    atmosphere.preview(url || dataUrl);
  }
  void pendingHistory.preview(url || dataUrl);
  $('generation-status').textContent = '正在生成 · ' + info;
}
async function generate(job = {}) {
  if (request) return;
  request = new AbortController();
  activeGeneration = {
    viewing: true,
    prepared: false,
    returnWork: current,
    referenceURL: current ? itemUrl(current) : '',
    settings: structuredClone(job.settings || controls.getSettings()),
    lastPreview: null,
  };
  proofProgress.begin({ mode: activeGeneration.settings.mode });
  completedInBackground = null;
  const signal = request.signal,
    submitted = { prompt: job.prompt ?? prompt.value, negative: job.negative ?? negative.value };
  // Capture provenance at submission, independently of browsing or editing the next draft.
  const submittedSettings = { ...controls.getSettings({ includeMedia: true }), ...job.settings };
  const submittedReuse = structuredClone(lineageReuse);
  const consumedReuses = new Set(submittedReuse.map(reuseToken));
  const submittedAtlas = ensureChunkEntries().catch(() => {
    notify('万象集暂时无法读取，本次仍可生成，但不会自动记录例图。');
    return [];
  });
  const sourceOrigin = submittedSettings.mode !== 'generate' && submittedSettings.source?.origin;
  const sourceWork = sourceOrigin && works.find((work) => work.id === sourceOrigin.workId);
  const provenance = {
    source: sourceOrigin
      ? { ...sourceOrigin, snapshot: sourceWork ? snapshotWork(sourceWork) : undefined }
      : null,
    reuses: [],
  };
  signal.addEventListener(
    'abort',
    () => {
      proofProgress.clear();
      pendingHistory.cancel();
      if (activeGeneration?.viewing) {
        const previous = activeGeneration.returnWork;
        if (previous && works.some((work) => work.id === previous.id)) showWork(previous);
        else showEmpty();
      }
      syncNotebookGeneration();
      drawStrip();
    },
    { once: true },
  );
  $('generate').disabled = true;
  $('generate').querySelector('b').textContent = '处理中…';
  $('cancel').hidden = false;
  const started = performance.now();
  const waiting = () => {
    if (!$('generation-status').textContent.startsWith('正在处理')) return;
    const seconds = Math.floor((performance.now() - started) / 1000);
    $('generation-status').textContent = '正在处理 · 已等待 ' + seconds + ' 秒';
  };
  $('generation-status').textContent = '正在处理…';
  const timer = setInterval(waiting, 1000);
  try {
    // Resolve and choose every caption once, before account/network awaits. Only
    // macros in the chosen random branch can claim a role identity or example.
    const positive = resolvePromptReferences(submitted.prompt);
    const undesired = resolvePromptReferences(submitted.negative);
    const positiveReferenceIds = new Set(positive.chunks.map((chunk) => chunk.id));
    const usageReferenceIds = new Set([...positive.chunks, ...undesired.chunks].map((chunk) => chunk.id));
    const cap = capabilities(submittedSettings);
    const resolvedSettings = {
      ...submittedSettings,
      characters: (submittedSettings.characters || []).map((character) => {
        if (character.enabled === false || !cap.imageMode || !cap.chars) return character;
        const p = resolvePromptReferences(character.prompt || ''),
          n = resolvePromptReferences(character.negative || '');
        for (const chunk of p.chunks) positiveReferenceIds.add(chunk.id);
        for (const chunk of [...p.chunks, ...n.chunks]) usageReferenceIds.add(chunk.id);
        return { ...character, prompt: p.text, negative: n.text };
      }),
    };
    const actual = { prompt: positive.text, negative: undesired.text };
    provenance.reuses = activeReuses(submittedReuse, { ...actual, settings: resolvedSettings });
    const recipeId = crypto.randomUUID();
    const result = await controls.generate({
      ...actual,
      signal,
      settings: resolvedSettings,
      resolvedPrompts: true,
      accountSession: job.accountSession,
    });
    if (!result?.images?.length) throw Error('未收到图像，请检查接口响应。');
    const entries = await submittedAtlas;
    const usingPrompts = ['generate', 'img2img', 'inpaint'].includes(result.mode);
    const usageIds = usingPrompts
      ? entries
          .filter(
            (entry) =>
              usageReferenceIds.has(entry.chunkId) &&
              (entry.type !== 'oc' || positiveReferenceIds.has(entry.chunkId)),
          )
          .map((entry) => entry.id)
      : [];
    const ocEntries = usingPrompts
      ? entries.filter((entry) => entry.type === 'oc' && positiveReferenceIds.has(entry.chunkId))
      : [];
    let identities = ocEntries.map((entry) => ({ id: 'oc:' + entry.id, name: entry.name }));
    if (usingPrompts) {
      // A selectively reused OC caption is already expanded in its META. Keep
      // its identity only while its registered appearance is still present in
      // one of the positively reused lanes; seed/parameter reuse cannot carry it.
      for (const reuse of provenance.reuses) {
        const captions = [
          ...(reuse.groups.includes('prompt') ? [actual.prompt] : []),
          ...(reuse.groups.includes('characters')
            ? (result.settings.characters || [])
                .filter((character) => character.enabled !== false)
                .map((character) => character.prompt)
            : []),
        ].map(normalizeSearch);
        if (!captions.length || deletedWorkIds.has(reuse.id)) continue;
        for (const entry of entries) {
          if (entry.type !== 'oc' || !reuse.snapshot?.characterIds?.includes('oc:' + entry.id)) continue;
          try {
            const tags = expandChunks(entry.prompt)
              .split(/[,，\n]+/)
              .map(normalizeSearch)
              .filter(Boolean);
            if (tags.length && captions.some((caption) => tags.every((tag) => caption.includes(tag))))
              identities.push({ id: 'oc:' + entry.id, name: entry.name });
          } catch {
            /* An edited/broken block never invents a retained identity. */
          }
        }
      }
      try {
        identities.push(
          ...(await findReferencedCharacters([
            actual.prompt,
            ...(cap.chars ? result.settings.characters || [] : [])
              .filter((character) => character.enabled !== false)
              .map((character) => character.prompt),
          ])),
        );
      } catch {
        notify('本地角色索引暂不可用，本次仍保留 OC 与生成来源线索。');
      }
    } else if (sourceWork) {
      identities = (sourceWork.characterIds || []).map((id) => ({
        id,
        name: sourceWork.characterLabels?.[id] || id,
      }));
    }
    const characterIds = [...new Set(identities.map((identity) => identity.id))];
    const characterLabels = Object.fromEntries(identities.map((identity) => [identity.id, identity.name]));
    const created = Date.now();
    const { source, mask, references, ...scalarSettings } = result.settings;
    const batch = await Promise.all(
      result.images.map(async (image, i) => {
        const blob = await (await fetch(image.url)).blob();
        const data = {
          id: crypto.randomUUID(),
          lineageVersion: LINEAGE_VERSION,
          recipeId,
          created,
          sequence: i,
          blob,
          ...actual,
          characterIds,
          characterLabels,
          atlasUsageIds: usageIds,
          settings: { ...scalarSettings },
          modelLabel: result.modelLabel || result.model,
          mode: result.mode,
          filename: image.filename || 'folio-' + created + '-' + (i + 1) + '.png',
        };
        const seed = image.seed ?? (result.images.length === 1 ? result.seed : null);
        data.settings.seed = seed ?? null;
        try {
          const bmp = await createImageBitmap(blob);
          data.width = bmp.width;
          data.height = bmp.height;
          bmp.close();
        } catch {}
        return data;
      }),
    );
    await lineageReady;
    signal.throwIfAborted();
    lineageReuse = lineageReuse.filter((entry) => !consumedReuses.has(reuseToken(entry)));
    saveDraft();
    const lineage = createLineageRecords(batch, {
      previous: works,
      known: lineageRecords,
      source: deletedWorkIds.has(provenance.source?.workId) ? null : provenance.source,
      reuses: provenance.reuses.filter((entry) => !deletedWorkIds.has(entry.id)),
    });
    for (const node of lineage) lineageRecords.set(node.id, node);
    pendingHistory.complete(batch[0].id);
    works.unshift(...batch);
    const viewingResult = Boolean(activeGeneration?.viewing);
    proofProgress.complete();
    activeGeneration = null;
    if (viewingResult) {
      showWork(batch[0], true, new Set(batch.map((w) => w.id)));
      atmosphere.complete(itemUrl(batch[0]));
    } else {
      completedInBackground = batch[0];
      drawStrip(new Set(batch.map((w) => w.id)));
      syncNotebookGeneration();
      notify('新图已完成 · 点击历史首图或「查看新作」即可查看');
    }
    finish.complete(result.mode === 'upscale' ? '超分完成' : '显影完成', { reveal: viewingResult });
    renderArchive();
    void captureGenerated(batch[0], usageIds).catch(() => notify('作品已生成，但例图未能保存到万象集。'));
    try {
      if (source?.origin && deletedWorkIds.has(source.origin.workId)) delete source.origin;
      await writeWorks(batch, null, { source, mask, references }, null, lineage);
      $('generation-status').textContent = '已完成 · ' + batch.length + ' 张作品已存入本地作品集。';
    } catch {
      $('generation-status').textContent = '已生成，但浏览器存储空间不足。请下载本次结果。';
    }
  } catch (e) {
    proofProgress.clear();
    pendingHistory.cancel();
    atmosphere.cancel();
    if (activeGeneration?.viewing) {
      const previous = activeGeneration.returnWork;
      if (previous && works.some((work) => work.id === previous.id)) showWork(previous);
      else showEmpty();
    }
    activeGeneration = null;
    syncNotebookGeneration();
    drawStrip();
    $('generation-status').textContent = signal.aborted
      ? '已停止等待。本次任务的计费以所用服务的账户记录为准。'
      : e.message || '生成请求失败。';
  } finally {
    clearInterval(timer);
    if (pendingHistory.active) {
      pendingHistory.cancel();
      drawStrip();
    }
    request = null;
    activeGeneration = null;
    syncNotebookGeneration();
    finish.busy(false);
    proofActions?.refresh();
    $('generate').disabled = false;
    $('generate').querySelector('b').textContent = modeName;
    $('cancel').hidden = true;
  }
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  setIcon($('theme'), theme === 'dark' ? 'sun' : 'moon');
  $('theme').setAttribute('aria-pressed', String(theme === 'dark'));
  $('theme').setAttribute('aria-label', theme === 'dark' ? '切换至浅色界面' : '切换至深色界面');
  $('theme').title = theme === 'dark' ? '浅色纸面' : '深色纸面';
  try {
    localStorage.setItem('folio.theme', theme);
  } catch {}
}
loadIcons();
try {
  setTheme(localStorage.getItem('folio.theme') || 'light');
} catch {
  setTheme('light');
}
const getModel = () => controls?.getSettings().model;
const billing = mountBilling({
  summary: $('usage-summary'),
  cost: $('cost-summary'),
  badge: $('generate-cost'),
  openAccount: () => controls.openAccount(),
  refreshAccount: () => controls.refreshAccount(),
});
function syncSettings() {
  if (!controls) return;
  const config = controls.billingSettings();
  billing.setSettings(config);
  proofActions?.refresh();
  promptTokens?.refresh();
  proofNotebook?.setDraft(activeGeneration?.viewing ? activeGeneration.settings : controls.getSettings());
  if ($('canvas-stage').dataset.state === 'empty')
    $('image-info').textContent = config.width + ' × ' + config.height;
}
controls = mountControls($('controls'), {
  modelHost: $('model-controls'),
  transportHost: $('transport-controls'),
  dockHost: $('generation-controls'),
  notify,
  bindAutocomplete: (field) => bindPromptField(field, { inline: true, getModel, notify }),
  onBillingChange: syncSettings,
  onPreview: showPreview,
  onPrepare({ mode, width, height, count }) {
    if (activeGeneration) Object.assign(activeGeneration, { mode, width, height, count, prepared: true });
    pendingHistory.begin({ mode, width, height, count });
    finish.viewingGeneration(true);
    finish.busy(true, mode);
    setPanel('canvas');
    displayGeneration();
  },
  onTransportStart({ stream, mode, totalSteps, samples }) {
    proofProgress.transport({ stream, mode, totalSteps, samples });
    proofActions?.refresh();
    $('generation-status').textContent =
      mode === 'upscale'
        ? '正在进行 2× 超分放大，完成后自动存入作品集…'
        : stream
          ? '流式传输中，正在等待首帧…'
          : '标准传输中，正在等待最终图像…';
  },
  onChange: () => {
    saveDraft(true);
    syncSettings();
  },
  resolvePrompt: expandPrompt,
  onMode({ button }) {
    modeName = button || '生成图像';
    if (!request) $('generate').querySelector('b').textContent = modeName;
  },
  onAccount(info) {
    $('account').classList.toggle('connected', info.connected);
    $('account').querySelector('span').textContent = info.label;
    $('account').title = info.label + ' · 管理账户与连接';
    billing.setAccount(info);
    latestAccount = info;
    proofActions?.refresh();
  },
});
proofActions = mountProofActions($('proof-actions'), {
  getControls: () => controls,
  getImage: () =>
    !request && current?.id && $('canvas-stage').dataset.state === 'result'
      ? {
          id: current.id,
          source: current.blob,
          name: current.filename,
          width: current.width,
          height: current.height,
        }
      : null,
  getAccount: () => latestAccount,
  getBusy: () => !!request,
  onExecute: (settings, accountSession) =>
    generate({ settings, accountSession, prompt: current?.prompt, negative: current?.negative }),
  onReady: (mode) => {
    if (['enhance', 'vary', 'inpaint', 'max'].includes(mode) && current) {
      for (const [field, key] of [
        [prompt, 'prompt'],
        [negative, 'negative'],
      ]) {
        if (!field.value.trim() && current[key]) {
          field.value = current[key];
          field.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    }
    setPanel('compose');
  },
  notify,
});
promptTokens = mountPromptTokens({ positive: prompt, negative, getSettings: () => controls.getSettings() });
proofNotebook = mountProofNotebook({
  host: $('proof-notebook'),
  notify,
  onReturnGeneration: returnToGeneration,
  onUseRecipe: (work) => metaReuse.open(work),
  onUseSeed: (seed) => {
    controls.restore({ ...controls.getSettings({ includeMedia: true }), seed });
    if (current) lineageReuse = appendReuse(lineageReuse, current, ['seed'], { settings: { seed } });
    saveDraft();
    syncSettings();
    notify('下一次生成将沿用种子 ' + seed);
  },
});
syncSettings();
let fallback;
try {
  fallback = JSON.parse(localStorage.getItem('folio.draft'));
} catch {}
const originalRevision = revision;
loadRecipe('draft')
  .catch(() => null)
  .then((stored) => {
    if (revision !== originalRevision) return;
    const saved = stored && (!fallback || stored.savedAt >= fallback.savedAt) ? stored : fallback;
    if (saved === fallback && stored?.mediaVersion && stored.mediaVersion === fallback?.mediaVersion) {
      saved.settings = { ...stored.settings, ...saved.settings };
    }
    if (saved) mediaVersion = saved.mediaVersion ?? null;
    if (saved)
      try {
        lineageReuse = Array.isArray(saved.lineageReuse) ? saved.lineageReuse.slice(0, 3) : [];
        applyRecipe(saved);
      } catch {
        notify('上次草稿无法完整恢复，可导入备份配方。');
      }
  });
for (const field of [prompt, negative]) {
  bindPromptField(field, { getModel, notify });
  field.addEventListener('focus', () => {
    activePrompt = field;
    charCount();
  });
  field.addEventListener('input', () => {
    charCount();
    saveDraft();
  });
}
mountCharacterImport(prompt, {
  migrate: migrateCharacterSections,
  replaceCharacters: replaceImportedCharacters,
  getContext: () => {
    const { model, characters } = controls.getSettings();
    return { model, characters };
  },
  notify,
});
mountSuggestionSource($('suggestion-source'), getModel);
configurePromptAtlas({ getWorks: () => works, notify, onUseOC: useOC });
configureCatalog({
  onCharacter: (entry, selection) => useCharacterPrompt(entry.prompt || entry.tag, entry.name, selection),
});
mountPromptTools($('prompt-workbench'), () => activePrompt, { getModel, notify });
$('all-history').onclick = () => navigateScreen(true);
$('clear-preview').onclick = showEmpty;
$('artists').onclick = () => openCatalog('artist', activePrompt);
$('characters').onclick = () => openCatalog('character', activePrompt);
$('studio-nav').onclick = $('brand').onclick = () => navigateScreen(false);
$('archive-nav').onclick = () => navigateScreen(true);
$('atlas-nav').onclick = () => navigateScreen('atlas');
let searchTimer,
  composingSearch = false;
function updateArchiveSearch() {
  clearTimeout(searchTimer);
  removal.cancel();
  archiveQuery = $('archive-search').value;
  renderArchive();
}
function clearArchiveSearch() {
  $('archive-search').value = '';
  updateArchiveSearch();
  $('archive-search').focus({ preventScroll: true });
}
$('archive-search').addEventListener('input', () => {
  if (!composingSearch) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(updateArchiveSearch, 100);
  }
});
$('archive-search').addEventListener('compositionstart', () => {
  composingSearch = true;
  clearTimeout(searchTimer);
});
$('archive-search').addEventListener('compositionend', () => {
  composingSearch = false;
  updateArchiveSearch();
});
$('archive-search').addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !event.isComposing) {
    event.preventDefault();
    clearArchiveSearch();
  }
});
$('archive-search-clear').onclick = clearArchiveSearch;
$('theme').onclick = () =>
  transitionTheme($('theme'), () =>
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'),
  );
$('account').onclick = () => controls.openAccount();
$('generate').onclick = generate;
$('cancel').onclick = () => request?.abort();
document.addEventListener('keydown', (e) => {
  if (
    (e.ctrlKey || e.metaKey) &&
    e.key === 'Enter' &&
    !e.defaultPrevented &&
    !e.isComposing &&
    !$('block-library-slot').contains(e.target) &&
    !e.target.closest('.ap-panel') &&
    !$('app').hidden &&
    !$('studio').hidden &&
    !document.querySelector('dialog[open]')
  ) {
    e.preventDefault();
    generate();
  }
});
$('expand').onclick = () => viewer.open();
$('image-lineage').onclick = () => current && lineageCanvas.open(current);
$('save-atlas').onclick = () => current?.id && atlas.openSaveWork(current);
$('download-image').onclick = () => {
  if (current?.id) download(itemUrl(current), current.filename);
};
$('use-source').onclick = async () => {
  if (!current?.id) return;
  try {
    const work = current;
    await controls.setSourceImage(itemUrl(work), 'img2img', { workId: work.id });
    notify('已作为图生图底图');
  } catch (e) {
    notify(e.message);
  }
};
async function openCanvasTool(kind) {
  try {
    const origin = current;
    const { width, height, source } = controls.getSettings({ includeMedia: true });
    const options = {
      source: current?.id ? itemUrl(current) : source?.data || null,
      width: current?.width || source?.width || width,
      height: current?.height || source?.height || height,
      onApply: async (url) => {
        await controls.setSourceImage(url, 'img2img', origin?.id ? { workId: origin.id } : source?.origin);
        notify('已将画布送入图生图');
      },
    };
    if (kind === 'draw') {
      const { openDrawing } = await import('./drawing.js');
      await openDrawing(options);
    } else {
      const { openPixelSnap } = await import('./pixel-snap.js');
      await openPixelSnap(options);
    }
  } catch (e) {
    notify(e.message);
  }
}
$('draw').onclick = () => openCanvasTool('draw');
$('pixel').onclick = () => openCanvasTool('pixel');
$('recipes').onclick = () => {
  const settings = controls.getSettings();
  const hasImage = Boolean(current?.blob && $('canvas-stage').dataset.state === 'result');
  $('recipe-preview').hidden = !hasImage;
  $('recipe-blank').hidden = hasImage;
  if (hasImage) $('recipe-preview').src = itemUrl(current);
  else $('recipe-preview').removeAttribute('src');
  $('recipe-caption').textContent = hasImage ? '当前画布预览 · 导出内容以当前编辑参数为准' : '当前创作配方';
  $('recipe-summary').replaceChildren(
    ...[
      ['MODEL', capabilities(settings).label],
      ['SIZE', settings.width + ' × ' + settings.height],
      ['STEPS', settings.steps],
      ['CHARACTERS', (settings.characters || []).filter((character) => character.enabled !== false).length],
    ].map(([label, value]) => {
      const item = make('span');
      item.append(make('small', '', label), document.createTextNode(String(value)));
      return item;
    }),
  );
  $('utility').showModal();
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
    $('utility').animate(
      [
        { opacity: 0, translate: '0 10px', scale: '.99' },
        { opacity: 1, translate: '0 0', scale: '1' },
      ],
      { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
};
document
  .querySelectorAll('[data-close]')
  .forEach((button) => (button.onclick = () => button.closest('dialog').close()));
for (const dialog of [$('utility')])
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
  });
$('export-recipe').onclick = () => {
  let recipe;
  try {
    const settings = controls.getSettings({ includeMedia: true });
    settings.characters = settings.characters.map((c) => ({
      ...c,
      prompt: expandChunks(c.prompt),
      negative: expandChunks(c.negative),
    }));
    recipe = {
      format: 'nai-folio',
      version: 1,
      prompt: expandChunks(prompt.value),
      negative: expandChunks(negative.value),
      settings,
    };
  } catch (e) {
    $('utility').close();
    notify(e.message);
    return;
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' }));
  download(url, 'folio-recipe.json');
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  $('utility').close();
};
$('import-recipe').onclick = () => $('recipe-file').click();
$('recipe-file').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    if (file.size > 80 * 1024 * 1024) throw Error('配方文件超过 80 MB。');
    let recipe;
    if (/\.png$/i.test(file.name)) {
      const { readPngRecipe } = await import('./png-recipe.js');
      recipe = await readPngRecipe(file);
    } else {
      recipe = JSON.parse(await file.text());
      if (recipe?.format !== 'nai-folio' || recipe.version !== 1 || !recipe.settings)
        throw Error('请选择由 Folio 导出的 JSON 配方。');
    }
    if (!recipe) throw Error('未找到可读取的 NovelAI 生成参数。');
    $('utility').close();
    const imported = {
      id: 'import-' + crypto.randomUUID(),
      external: true,
      created: Date.now(),
      filename: file.name,
      ...recipe,
      blob: /\.png$/i.test(file.name) ? file : null,
    };
    if (imported.blob) {
      try {
        const bitmap = await createImageBitmap(imported.blob);
        imported.width = bitmap.width;
        imported.height = bitmap.height;
        bitmap.close();
      } catch {}
    }
    metaReuse.open(imported, recipe);
  } catch (err) {
    $('utility').close();
    notify(err.message || '配方读取失败。');
  }
};
document.addEventListener('folio:enter', () => {
  if (currentScreen !== 'studio') return;
  studioEntrance.play();
  revealHeadings($('studio'), 160);
});
if (!$('app').hidden && !document.body.classList.contains('is-cover')) {
  studioEntrance.play();
  revealHeadings($('studio'), 80);
}
showEmpty();
renderArchive();
listWorks()
  .then((saved) => {
    const existing = new Set(works.map((w) => w.id));
    works.push(...saved.filter((w) => !existing.has(w.id)));
    renderArchive();
    drawStrip();
  })
  .catch(() => notify('本地作品集暂时无法读取'));
