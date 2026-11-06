import { expandChunks, listChunks, reference } from './chunks.js';
import { saveEntry } from './atlas-store.js';
import { parseCharacterSections } from './character-sections.js';

const make = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const button = (text, className) => {
  const node = make('button', className, text);
  node.type = 'button';
  return node;
};

/** Only user edits in the main positive field are eligible. Restoring a recipe
 * dispatches a plain Event, which deliberately does not initiate a transfer. */
export function mountCharacterImport(field, { migrate, replaceCharacters, getContext, notify }) {
  const abort = new AbortController(),
    { signal } = abort;
  const seen = new Set();
  let timer,
    composing = false,
    dirty = false,
    processing = false,
    lastFailure = '',
    dialog,
    rows = [],
    busy = false;
  let savedBatch = [],
    opener;

  function close() {
    if (busy || !dialog?.open) return;
    dialog.close();
    rows = [];
    savedBatch = [];
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }
  function createDialog() {
    if (dialog) return;
    dialog = make('dialog', 'ci-dialog');
    dialog.setAttribute('aria-labelledby', 'ci-title');
    const spread = make('div', 'ci-spread');
    const aside = make('aside', 'ci-aside');
    aside.append(make('small', 'ci-kicker', 'A CHARACTER STUDY'), make('span', 'ci-total', '01'));
    const title = make('h2', '', 'Meet');
    title.append(make('i', '', 'your characters.'));
    aside.append(
      title,
      make('p', 'ci-aside-copy', '角色已移入多角色栏。给他们一个名字，下一次灵感来临时，就能再次相遇。'),
    );
    const note = make('div', 'ci-note');
    note.append(
      make('span', '', '已完成 · 角色分段'),
      make('p', '', '全局提示词保留在原处。保存为 OC 后会收入万象集，首张引用生成的图片将自动成为封面。'),
    );
    aside.append(note);
    const sheet = make('section', 'ci-sheet');
    const header = make('header', 'ci-header');
    const heading = make('div');
    heading.append(make('small', 'ci-kicker', 'OPTIONAL · KEEP FOR LATER'));
    const titleText = make('h3', '', '把角色收藏为 OC');
    titleText.id = 'ci-title';
    heading.append(titleText, make('p', '', '勾选要收藏的角色，名称与外貌都可以调整。'));
    const dismiss = button('×', 'ci-close');
    dismiss.setAttribute('aria-label', '关闭 OC 保存提示');
    dismiss.onclick = close;
    header.append(heading, dismiss);
    const list = make('div', 'ci-list');
    const message = make('p', 'ci-message');
    message.setAttribute('role', 'status');
    const footer = make('footer', 'ci-footer');
    const keep = button('仅保留多角色', 'ci-keep');
    const save = button('保存 OC', 'ci-save');
    keep.onclick = () => void finish(false);
    save.onclick = () => void finish(true);
    footer.append(keep, save);
    sheet.append(header, list, message, footer);
    spread.append(aside, sheet);
    dialog.append(spread);
    document.body.append(dialog);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (
        event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom
      )
        close();
    });
  }
  function state() {
    const count = rows.filter((row) => row.selected.checked).length;
    dialog.querySelector('.ci-save').textContent = busy ? '正在保存…' : `保存 OC${count ? ' · ' + count : ''}`;
    for (const node of dialog.querySelectorAll('button,input,textarea')) node.disabled = busy;
    dialog.querySelector('.ci-save').disabled = busy || !count;
  }
  function open(migrated) {
    createDialog();
    savedBatch = migrated;
    dialog.querySelector('.ci-total').textContent = String(migrated.length).padStart(2, '0');
    dialog.querySelector('.ci-message').textContent = '';
    const list = dialog.querySelector('.ci-list');
    list.replaceChildren();
    rows = migrated.map((item, index) => {
      const card = make('article', 'ci-character');
      const top = make('div', 'ci-character-top');
      const selection = make('label', 'ci-selection fc-check');
      const selected = make('input');
      selected.type = 'checkbox';
      selected.checked = true;
      selected.setAttribute('aria-label', `收藏角色 ${item.slot + 1} 为 OC`);
      selected.onchange = () => {
        card.dataset.selected = String(selected.checked);
        state();
      };
      selection.append(selected, make('span', '', '角色 ' + (item.slot + 1)));
      top.append(selection, make('small', '', 'CHARACTER / ' + String(index + 1).padStart(2, '0')));
      const nameLabel = make('label', 'ci-name-label');
      nameLabel.append(make('span', '', 'OC 名称'));
      const name = make('input', 'ci-name');
      name.value = item.name;
      name.maxLength = 55;
      name.required = true;
      name.setAttribute('aria-label', '角色 ' + (item.slot + 1) + ' 的 OC 名称');
      nameLabel.append(name);
      const promptLabel = make('label', 'ci-prompt-label');
      promptLabel.append(make('span', '', '外貌提示词'));
      const prompt = make('textarea', 'ci-prompt');
      prompt.rows = 3;
      prompt.maxLength = 100000;
      // Appearance is a snapshot. An OC should never accidentally inherit the
      // identity of another OC through a nested reference.
      try {
        prompt.value = expandChunks(item.prompt);
      } catch {
        prompt.value = item.prompt;
      }
      prompt.setAttribute('aria-label', '角色 ' + (item.slot + 1) + ' 的外貌提示词');
      promptLabel.append(prompt);
      card.append(top, nameLabel, promptLabel);
      card.dataset.selected = 'true';
      list.append(card);
      return { selected, name, prompt, initialPrompt: prompt.value, entry: null };
    });
    state();
    opener = document.activeElement;
    dialog.showModal();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
      dialog.animate(
        [
          { opacity: 0, transform: 'translateY(16px) scale(.985)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
    rows[0]?.name.focus({ preventScroll: true });
  }
  async function finish(save) {
    if (busy) return;
    const message = dialog.querySelector('.ci-message');
    try {
      const names = new Set(),
        chunks = listChunks();
      const values = rows.map((row, index) => {
        const name = row.name.value.trim();
        const prompt = expandChunks(row.prompt.value).trim();
        if (!prompt) {
          row.prompt.focus();
          throw Error('请为每个角色保留外貌提示词。');
        }
        if (save && row.selected.checked) {
          if (!name || name.length > 55 || /[!\r\n]/u.test(name)) {
            row.name.focus();
            throw Error('OC 名称应为 1–55 个字符，且不能含换行或感叹号。');
          }
          const key = name.toLocaleLowerCase();
          if (
            names.has(key) ||
            chunks.some(
              (chunk) =>
                chunk.name.toLocaleLowerCase() === ('OC · ' + name).toLocaleLowerCase() &&
                chunk.id !== row.entry?.chunkId,
            )
          ) {
            row.name.focus();
            throw Error(`「${name}」已被使用，请给这个 OC 换一个名称。`);
          }
          names.add(key);
        }
        return { name, prompt, index, keepOriginal: row.prompt.value === row.initialPrompt };
      });
      busy = true;
      state();
      message.textContent = '';
      for (const value of values) {
        const row = rows[value.index];
        if (save && row.selected.checked) {
          row.entry = await saveEntry({
            ...(row.entry ? { id: row.entry.id } : {}),
            type: 'oc',
            name: value.name,
            prompt: value.prompt,
            category: 'OC',
          });
          value.prompt = reference(row.entry.chunkName);
        } else if (value.keepOriginal) value.prompt = savedBatch[value.index].prompt;
      }
      const result = replaceCharacters(savedBatch, values);
      const count = save ? rows.filter((row) => row.selected.checked).length : 0;
      busy = false;
      state();
      close();
      notify(
        result?.skipped
          ? '角色内容已改变，未覆盖新的编辑；保存的 OC 可在万象集再次引用。'
          : count
            ? `已收藏 ${count} 个 OC，并在多角色栏引用。`
            : '已保留多角色提示词。',
      );
    } catch (error) {
      busy = false;
      state();
      message.textContent = error.message || '未完成保存，请重试。';
    }
  }
  function run(reason) {
    clearTimeout(timer);
    if (!dirty || composing || processing || dialog?.open || field.disabled || field.readOnly) return;
    const parsed = parseCharacterSections(field.value);
    if (!parsed) return;
    // An unfinished first word should never steal focus while the user types.
    if (reason === 'idle' && parsed.sections.some((section) => !/[,，\n]|!macro:/u.test(section.prompt)))
      return;
    const signature = JSON.stringify(parsed.sections.map((section) => [section.number, section.prompt]));
    if (seen.has(signature)) {
      dirty = false;
      return;
    }
    const failureKey = parsed.source + '\0' + JSON.stringify(getContext?.());
    if (failureKey === lastFailure) return;
    processing = true;
    try {
      const migrated = migrate(parsed);
      if (!migrated?.length) return;
      seen.add(signature);
      dirty = false;
      lastFailure = '';
      open(migrated);
    } catch (error) {
      lastFailure = failureKey;
      notify(error.message || '未能迁移角色，原文已保留。');
    } finally {
      processing = false;
    }
  }
  field.addEventListener(
    'input',
    (event) => {
      if (processing || composing || event.isComposing) return;
      const type = event.inputType || '';
      if (/historyUndo|historyRedo/u.test(type)) {
        clearTimeout(timer);
        dirty = false;
        return;
      }
      // Folding may rewrite the same body before our paste timer fires. Read the
      // latest value then, without turning the fold itself into a new user edit.
      if (type === 'insertFromAutoBlock') return;
      clearTimeout(timer);
      if (!/^(?:insert|delete)/u.test(type)) {
        dirty = false;
        return;
      }
      dirty = true;
      timer = setTimeout(
        () => run(type === 'insertFromPaste' ? 'paste' : 'idle'),
        type === 'insertFromPaste' ? 160 : 1100,
      );
    },
    { signal },
  );
  field.addEventListener(
    'blur',
    () => {
      if (!composing) timer = setTimeout(() => run('blur'), 100);
    },
    { signal },
  );
  field.addEventListener(
    'compositionstart',
    () => {
      composing = true;
      clearTimeout(timer);
    },
    { signal },
  );
  field.addEventListener(
    'compositionend',
    () => {
      composing = false;
    },
    { signal },
  );
  return {
    destroy() {
      abort.abort();
      clearTimeout(timer);
      dialog?.remove();
    },
  };
}
