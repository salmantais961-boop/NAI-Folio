import { setIcon } from './icons.js';
import { addWorkTags, getWork } from './archive-store.js';
import { parseWorkTags } from './archive-tags.js';
import { createArchiveZip } from './archive-zip.js';

export function mountArchiveBatch(archive, { flushSearch, onEnter, onTags, download, notify }) {
  const find = (id) => archive.querySelector('#' + id);
  const toggle = find('archive-batch-toggle'), panel = find('archive-batch-panel');
  const manualButton = find('batch-manual'), allButton = find('batch-matches');
  const count = find('batch-count'), tags = find('batch-tags'), apply = find('batch-apply');
  const zip = find('batch-zip'), zipLabel = zip.lastElementChild, dismiss = find('batch-close');
  const manual = new Set();
  let opened = false, all = false, matches = [], matchingIds = new Set(), job = null;

  function selected(id) {
    return all ? matchingIds.has(id) : manual.has(id);
  }

  function decorate(card) {
    const button = card.querySelector('.archive-open');
    if (!opened) {
      if (button.hasAttribute('aria-pressed')) {
        button.removeAttribute('aria-pressed');
        button.setAttribute('aria-label', '查看作品：' + button.querySelector('img').alt);
      }
      return;
    }
    if (!card.querySelector('.batch-check')) {
      const mark = document.createElement('span');
      mark.className = 'batch-check';
      mark.setAttribute('aria-hidden', 'true');
      setIcon(mark, 'check');
      button.append(mark);
    }
    button.setAttribute('aria-label', '选择作品：' + button.querySelector('img').alt);
    button.setAttribute('aria-pressed', String(selected(card.dataset.workId)));
  }

  function paintControls() {
    const size = all ? matches.length : manual.size;
    count.querySelector('b').textContent = size;
    allButton.querySelector('span').textContent = matches.length;
    manualButton.setAttribute('aria-pressed', String(!all));
    allButton.setAttribute('aria-pressed', String(all));
    manualButton.disabled = allButton.disabled = tags.disabled = Boolean(job);
    apply.disabled = Boolean(job) || !size || !parseWorkTags(tags.value).length;
    zip.disabled = Boolean(job) || !size;
    zipLabel.textContent = job?.kind === 'zip' ? job.progress : '打包 ZIP';
    dismiss.disabled = job?.kind === 'tags';
    panel.toggleAttribute('data-packing', job?.kind === 'zip');
  }

  function paint() {
    paintControls();
    for (const card of archive.querySelectorAll('.archive-card:not([data-departing])')) decorate(card);
  }

  function syncResults(filtered, works) {
    matches = filtered;
    matchingIds = new Set(filtered.map(work => work.id));
    if (manual.size) {
      const live = new Set(works.map(work => work.id));
      for (const id of manual) if (!live.has(id)) manual.delete(id);
    }
    toggle.disabled = !works.length && !opened;
    if (opened) paint();
  }

  function open() {
    flushSearch();
    onEnter();
    opened = true;
    panel.inert = false;
    archive.dataset.batchOpen = '';
    toggle.setAttribute('aria-expanded', 'true');
    paint();
  }

  function close(restoreFocus = false) {
    if (!opened) return;
    job?.controller?.abort();
    job = null;
    opened = all = false;
    manual.clear();
    tags.value = '';
    delete archive.dataset.batchOpen;
    toggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) toggle.focus({ preventScroll: true });
    panel.inert = true;
    paint();
  }

  function pick(id) {
    if (!opened) return false;
    if (job || !matchingIds.has(id)) return true;
    if (all) {
      manual.clear();
      for (const match of matches) manual.add(match.id);
      all = false;
    }
    if (!manual.delete(id)) manual.add(id);
    paint();
    return true;
  }

  function targetIds() {
    // A just-typed query may still be waiting for the search debounce.
    flushSearch();
    return all ? matches.map(work => work.id) : [...manual];
  }

  find('batch-tag-form').onsubmit = async (event) => {
    event.preventDefault();
    if (!opened || job) return;
    const ids = targetIds(), values = parseWorkTags(tags.value);
    if (!ids.length || !values.length) return;
    const pending = { kind: 'tags' };
    job = pending;
    paintControls();
    try {
      const updated = await addWorkTags(ids, values);
      onTags(updated);
      if (job === pending) tags.value = '';
      notify('已为 ' + ids.length + ' 张作品保存标签');
    } catch (error) {
      notify(error.message || '标签保存失败，请重试。');
    } finally {
      if (job === pending) {
        job = null;
        paintControls();
        tags.focus({ preventScroll: true });
      }
    }
  };
  zip.onclick = async () => {
    if (!opened || job) return;
    const ids = targetIds();
    if (!ids.length) return;
    const controller = new AbortController();
    const pending = { kind: 'zip', controller, progress: '0 / ' + ids.length };
    job = pending;
    paintControls();
    try {
      const blob = await createArchiveZip(ids.map(id => ({ id })), getWork, {
        signal: controller.signal,
        onProgress(done, total) {
          if (job !== pending) return;
          pending.progress = done + ' / ' + total;
          zipLabel.textContent = pending.progress;
        },
      });
      if (job !== pending) return;
      const url = URL.createObjectURL(blob);
      try {
        download(url, 'Folio-' + ids.length + '-' + new Date().toISOString().slice(0, 10) + '.zip');
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      notify('已打包 ' + ids.length + ' 张原图');
    } catch (error) {
      if (!controller.signal.aborted) notify(error.message || '打包失败，请重试。');
    } finally {
      if (job === pending) {
        job = null;
        paintControls();
      }
    }
  };
  toggle.onclick = () => {
    if (!opened) open();
    else if (job?.kind !== 'tags') close(true);
  };
  dismiss.onclick = () => close(true);
  for (const item of [manualButton, allButton]) {
    item.onclick = () => {
      flushSearch();
      all = item === allButton;
      paint();
    };
  }
  tags.addEventListener('input', paintControls);
  document.addEventListener('keydown', event => {
    if (!opened || event.key !== 'Escape' || event.isComposing || event.defaultPrevented ||
        job?.kind === 'tags' || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    close(true);
  });
  return { syncResults, decorate, pick, close };
}
