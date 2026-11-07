import { listChunks, watchChunks, expandChunks } from './chunks.js';
import { mountMacroDrag } from './prompt-drag.js';
import { foldExactChunks } from './prompt-match.js';

// The textarea remains the raw-value/event adapter. Only this surface edits the
// displayed document; macro leaves are atomic and count as their full raw source.
export function mountPromptEditor(field, { runs, paintWeight, getModel, signal }) {
  const proto = HTMLTextAreaElement.prototype;
  const valueProperty = Object.getOwnPropertyDescriptor(proto, 'value');
  const selectionProperties = Object.fromEntries(
    ['selectionStart', 'selectionEnd', 'selectionDirection'].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(proto, key),
    ]),
  );
  const nativeValue = () => valueProperty.get.call(field);
  const nativeSelection = (a, b = a, direction = 'none') =>
    proto.setSelectionRange.call(field, a, b, direction);
  const start = () => selectionProperties.selectionStart.get.call(field);
  const end = () => selectionProperties.selectionEnd.get.call(field);
  const direction = () => selectionProperties.selectionDirection.get.call(field);
  const frame = document.createElement('div');
  const editor = document.createElement('div');
  frame.className = 'pt-textframe pt-rich-frame';
  editor.className = 'pt-editor pt-ink-layer';
  editor.contentEditable = 'true';
  editor.spellcheck = field.spellcheck;
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.dataset.placeholder = field.placeholder;
  if (field.id) editor.id = field.id + '-editor';
  editor.setAttribute(
    'aria-label',
    field.getAttribute('aria-label') || field.closest('label')?.querySelector('span')?.textContent || '提示词',
  );
  const original = {
    tabindex: field.getAttribute('tabindex'),
    ariaHidden: field.getAttribute('aria-hidden'),
  };
  const ownedProperties = new Map();
  let composing = false;
  let sending = false;
  let syncing = false;
  let destroyed = false;
  let renderText;
  let renderModel;
  let previousWeights = new Map();
  let undo = [];
  let redo = [];
  let lastEdit;
  let lastBlurValue = nativeValue();
  let macroDrag;
  let foldTimer;
  let foldIgnoredValue;
  const expandedBlocks = new Set();
  const canAutoFold = !field.closest('.pt-form');
  const style = getComputedStyle(field);
  for (const prop of [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'lineHeight',
    'letterSpacing',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'textAlign',
    'direction',
    'tabSize',
  ])
    editor.style[prop] = style[prop];
  editor.style.minHeight = `${Math.max(44, Number.parseFloat(style.minHeight) || 0)}px`;
  field.before(frame);
  frame.append(field, editor);
  field.classList.add('pt-raw-field');
  field.tabIndex = -1;
  field.setAttribute('aria-hidden', 'true');

  function raw(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.data;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (node.hasAttribute('data-macro')) return node.dataset.macro;
    if (node.hasAttribute('data-editor-tail')) return '';
    if (node.tagName === 'BR') return '\n';
    return [...node.childNodes].map(raw).join('');
  }
  function offsetAt(node, offset) {
    let count =
      node.nodeType === Node.TEXT_NODE
        ? Math.min(offset, node.data.length)
        : [...node.childNodes].slice(0, offset).reduce((sum, child) => sum + raw(child).length, 0);
    const atom = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('[data-macro]');
    if (atom && editor.contains(atom)) {
      node = atom;
      count = offset ? atom.dataset.macro.length : 0;
    }
    while (node && node !== editor) {
      for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling)
        count += raw(sibling).length;
      node = node.parentNode;
    }
    return count;
  }
  function atomicRange(a, b, text = nativeValue()) {
    a = Math.max(0, Math.min(text.length, a));
    b = Math.max(a, Math.min(text.length, b));
    const collapsed = a === b;
    for (const match of text.matchAll(/!macro:[^!\n]+!/g)) {
      const left = match.index,
        right = left + match[0].length;
      if (collapsed && a > left && a < right) a = b = a - left < right - a ? left : right;
      else if (!collapsed) {
        if (a > left && a < right) a = left;
        if (b > left && b < right) b = right;
      }
    }
    return [a, b];
  }
  function syncSelection() {
    if (syncing || destroyed || macroDrag?.active) return;
    const selection = getSelection();
    if (
      !selection?.anchorNode ||
      !editor.contains(selection.anchorNode) ||
      !editor.contains(selection.focusNode)
    )
      return;
    const a = offsetAt(selection.anchorNode, selection.anchorOffset);
    const b = offsetAt(selection.focusNode, selection.focusOffset);
    const [from, to] = atomicRange(Math.min(a, b), Math.max(a, b), raw(editor));
    nativeSelection(from, to, a > b ? 'backward' : 'forward');
  }
  function pointAt(offset) {
    const visit = (node) => {
      const length = raw(node).length;
      if (node.nodeType === Node.TEXT_NODE) {
        if (offset <= length) return [node, offset];
        offset -= length;
        return null;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || node.hasAttribute('data-editor-tail')) return null;
      if (node.hasAttribute('data-macro') || node.tagName === 'BR') {
        if (offset <= length) {
          const index = [...node.parentNode.childNodes].indexOf(node);
          return [node.parentNode, index + (offset ? 1 : 0)];
        }
        offset -= length;
        return null;
      }
      for (const child of node.childNodes) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    const found = visit(editor);
    if (found) return found;
    // A placeholder BR is not part of the document. Placing an empty caret
    // after it offsets Chromium's IME composition range by one character.
    const tail = [...editor.childNodes].findIndex((node) => node.nodeType === Node.ELEMENT_NODE && node.hasAttribute('data-editor-tail'));
    return [editor, tail < 0 ? editor.childNodes.length : tail];
  }
  function showSelection() {
    if (document.activeElement !== editor || composing) return;
    const [a, b] = atomicRange(start(), end());
    nativeSelection(a, b, direction());
    const first = pointAt(a),
      last = pointAt(b);
    syncing = true;
    if (direction() === 'backward') getSelection().setBaseAndExtent(...last, ...first);
    else getSelection().setBaseAndExtent(...first, ...last);
    syncing = false;
  }
  function render(force = false) {
    if (composing || destroyed) return;
    const text = nativeValue(),
      model = getModel?.() || 'nai-diffusion-5-full';
    if (!force && renderText === text && renderModel === model) return;
    renderText = text;
    renderModel = model;
    const fragment = document.createDocumentFragment();
    const nextWeights = new Map();
    const blocks = new Map(listChunks().map((block) => [block.name, block]));
    const occurrences = new Map();
    for (const part of runs(text, model)) {
      const run = document.createElement('span');
      run.className = 'pt-ink-' + part.kind;
      paintWeight(run, part.weight);
      const key = part.kind + '\0' + part.value;
      nextWeights.set(key, part.weight);
      if (previousWeights.has(key) && previousWeights.get(key) !== part.weight)
        run.classList.add('pt-ink-changed');
      if (part.kind === 'macro') {
        const name = part.value.slice(7, -1),
          block = blocks.get(name);
        run.classList.add('pt-inline-block');
        run.contentEditable = 'false';
        run.dataset.macro = part.value;
        run._promptWeight = part.weight;
        run.draggable = false;
        const ordinal = occurrences.get(name) || 0;
        occurrences.set(name, ordinal + 1);
        run.dataset.blockKey = name + ':' + ordinal;
        const expanded = expandedBlocks.has(run.dataset.blockKey) && Boolean(block);
        run.classList.toggle('pt-expanded-block', expanded);
        run.title =
          '词块「' + name + '」 · 拖动换位 / 长按拖动 · 双击展开或收起' + (block ? '' : '\n未找到此词块');
        run.toggleAttribute('data-missing', !block);
        const label = document.createElement('span');
        label.className = 'pt-inline-name';
        label.textContent = name;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'pt-inline-toggle';
        toggle.disabled = !block;
        toggle.setAttribute('aria-label', (expanded ? '收起词块「' : '展开词块「') + name + '」');
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"/></svg>';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.tabIndex = -1;
        remove.className = 'pt-inline-remove';
        remove.setAttribute('aria-label', '移除词块「' + name + '」');
        remove.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9"/></svg>';
        if (expanded) {
          const heading = document.createElement('span');
          heading.className = 'pt-block-heading';
          const eyebrow = document.createElement('small');
          eyebrow.textContent = 'PROMPT BLOCK';
          heading.append(label, eyebrow, toggle, remove);
          const body = document.createElement('span');
          body.className = 'pt-expanded-body';
          body.setAttribute('aria-label', '词块「' + name + '」的提示词');
          try {
            for (const piece of runs(expandChunks(part.value), model)) {
              const ink = document.createElement('span');
              ink.className = 'pt-ink-' + piece.kind;
              paintWeight(ink, piece.weight * part.weight);
              ink.textContent = piece.value;
              body.append(ink);
            }
          } catch (error) {
            body.textContent = error.message;
          }
          run.append(heading, body);
        } else run.append(label, toggle, remove);
        fragment.append(document.createTextNode(''), run, document.createTextNode(''));
      } else if (part.kind === 'tag') {
        const [, leading, value, trailing] = part.value.match(/^(\s*)([\s\S]*?)(\s*)$/);
        run.textContent = value;
        fragment.append(document.createTextNode(leading), run, document.createTextNode(trailing));
      } else {
        run.textContent = part.value;
        fragment.append(run);
      }
    }
    if (!text || text.endsWith('\n')) {
      const tail = document.createElement('br');
      tail.dataset.editorTail = '';
      fragment.append(tail);
    }
    previousWeights = nextWeights;
    editor.replaceChildren(fragment);
    editor.toggleAttribute('data-empty', !text);
    showSelection();
  }
  function emitInput(type = 'insertText', data = null, isComposing = false) {
    sending = true;
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: type, data, isComposing }));
    sending = false;
  }
  function scheduleFold(type) {
    clearTimeout(foldTimer);
    if (
      !canAutoFold ||
      composing ||
      destroyed ||
      /historyUndo|historyRedo|insertFromAutoBlock/.test(type || '')
    )
      return;
    foldTimer = setTimeout(
      () => {
        if (composing || destroyed || macroDrag?.pending || field.disabled || field.readOnly) return;
        const text = nativeValue();
        if (text === foldIgnoredValue || !text.trim() || text.length > 100000) return;
        const candidates = [];
        for (const block of listChunks()) {
          // OC identity remains an explicit choice in the multi-character UI.
          if (block.kind === 'oc' || /^OC\s*[·•]/i.test(block.name)) continue;
          try {
            const body = expandChunks('!macro:' + block.name + '!');
            if (body.trim() && !body.includes('||')) candidates.push({ name: block.name, text: body });
          } catch {
            /* Incomplete library definitions never alter the document. */
          }
        }
        const folded = foldExactChunks(text, candidates);
        if (!folded) return;
        syncSelection();
        const a = folded.mapPosition(start()),
          b = folded.mapPosition(end());
        replace(0, text.length, folded.value, a, b, 'insertFromAutoBlock');
        field.dispatchEvent(new Event('prompt-editor-fold'));
      },
      type === 'insertFromPaste' ? 0 : 480,
    );
  }
  function setExpansion(chip, expanded, focusToggle = false) {
    if (!chip || chip.hasAttribute('data-missing')) return false;
    const key = chip.dataset.blockKey;
    if (expanded) expandedBlocks.add(key);
    else expandedBlocks.delete(key);
    render(true);
    const replacement = [...editor.querySelectorAll('[data-block-key]')].find(
      (node) => node.dataset.blockKey === key,
    );
    if (focusToggle) replacement?.querySelector('.pt-inline-toggle')?.focus({ preventScroll: true });
    if (expanded && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      replacement?.querySelector('.pt-expanded-body')?.animate(
        [
          { opacity: 0, translate: '0 -4px' },
          { opacity: 1, translate: '0 0' },
        ],
        { duration: 200, easing: 'cubic-bezier(.2,.7,.2,1)' },
      );
    field.dispatchEvent(new Event('prompt-editor-fold'));
    return true;
  }
  const snapshot = () => ({ value: nativeValue(), from: start(), to: end(), direction: direction() });
  function remember(type, before) {
    const now = performance.now();
    const grouped =
      /^(insertText|deleteContentBackward|deleteContentForward)$/.test(type) &&
      lastEdit?.type === type &&
      now - lastEdit.time < 850 &&
      before.from === before.to &&
      before.from === lastEdit.caret &&
      before.value === lastEdit.value;
    if (!grouped) {
      undo.push(before);
      if (undo.length > 160) undo.shift();
    }
    redo = [];
    lastEdit = { type, time: now };
  }
  function replace(from, to, text, selectStart, selectEnd, type = 'insertReplacementText') {
    if (destroyed || field.disabled || field.readOnly) return;
    syncSelection();
    const old = nativeValue();
    [from, to] = atomicRange(from, to, old);
    text = String(text).replace(/\r\n?/g, '\n');
    const value = old.slice(0, from) + text + old.slice(to);
    const a = selectStart ?? from + text.length,
      b = selectEnd ?? a;
    if (value !== old) remember(type, snapshot());
    valueProperty.set.call(field, value);
    nativeSelection(a, b);
    render();
    showSelection();
    if (lastEdit) Object.assign(lastEdit, { value, caret: end() });
    emitInput(type, text);
    field.dispatchEvent(new Event('select', { bubbles: true }));
  }
  function travelHistory(backward) {
    if (composing) return;
    clearTimeout(foldTimer);
    syncSelection();
    const source = backward ? undo : redo,
      destination = backward ? redo : undo;
    const entry = source.pop();
    if (!entry) return;
    destination.push(snapshot());
    valueProperty.set.call(field, entry.value);
    foldIgnoredValue = entry.value;
    nativeSelection(entry.from, entry.to, entry.direction);
    lastEdit = null;
    render();
    emitInput(backward ? 'historyUndo' : 'historyRedo');
  }
  function own(key, descriptor) {
    ownedProperties.set(key, Object.getOwnPropertyDescriptor(field, key));
    Object.defineProperty(field, key, { configurable: true, ...descriptor });
  }
  own('value', {
    get: nativeValue,
    set(value) {
      if (String(value) === nativeValue()) return;
      valueProperty.set.call(field, value);
      undo = [];
      redo = [];
      lastEdit = null;
      render();
    },
  });
  for (const key of ['selectionStart', 'selectionEnd', 'selectionDirection'])
    own(key, {
      get() {
        syncSelection();
        return selectionProperties[key].get.call(field);
      },
      set(value) {
        selectionProperties[key].set.call(field, value);
        showSelection();
      },
    });
  own('setSelectionRange', {
    value(a, b, dir) {
      nativeSelection(a, b, dir);
      showSelection();
    },
  });
  own('focus', {
    value(options) {
      editor.focus(options);
      showSelection();
    },
  });
  own('blur', {
    value() {
      editor.blur();
    },
  });
  own('select', {
    value() {
      editor.focus();
      nativeSelection(0, nativeValue().length);
      showSelection();
    },
  });
  own('setRangeText', {
    value(text, a, b, mode = 'preserve') {
      syncSelection();
      a ??= start();
      b ??= end();
      remember('insertReplacementText', snapshot());
      proto.setRangeText.call(field, text, a, b, mode);
      render();
    },
  });
  const bridge = {
    element: editor,
    get focused() {
      return document.activeElement === editor;
    },
    replace,
    expandMacro(from, to) {
      let found = false;
      for (const chip of [...editor.querySelectorAll('[data-macro]')]) {
        const a = offsetAt(chip.parentNode, [...chip.parentNode.childNodes].indexOf(chip));
        if (a >= to || a + chip.dataset.macro.length <= from) continue;
        if (!chip.hasAttribute('data-missing')) {
          expandedBlocks.add(chip.dataset.blockKey);
          found = true;
        }
      }
      if (found) {
        render(true);
        field.dispatchEvent(new Event('prompt-editor-fold'));
      }
      return found;
    },
    caretRect() {
      const selection = getSelection();
      if (selection?.rangeCount && editor.contains(selection.focusNode)) {
        const range = selection.getRangeAt(0).cloneRange();
        range.collapse(false);
        const rect = range.getClientRects()[0];
        if (rect?.height) return rect;
      }
      const rect = editor.getBoundingClientRect(),
        computed = getComputedStyle(editor);
      const top = rect.top + (parseFloat(computed.paddingTop) || 0);
      return {
        left: rect.left + (parseFloat(computed.paddingLeft) || 0),
        top,
        bottom: top + (parseFloat(computed.lineHeight) || 20),
      };
    },
  };
  own('promptEditor', { value: bridge });
  macroDrag = mountMacroDrag({
    editor,
    field,
    read: nativeValue,
    offsetAt,
    pointAt,
    getModel,
    signal,
    select(a, b) {
      nativeSelection(a, b);
      showSelection();
    },
    commit(move) {
      replace(0, nativeValue().length, move.value, move.from, move.to, 'insertFromDrag');
    },
  });

  function dispatchKeyboard(event) {
    if (event.target.closest('button') || event.target.closest('.pt-expanded-body')) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing && !composing) {
      if (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y') {
        event.preventDefault();
        event.stopPropagation();
        travelHistory(event.key.toLowerCase() === 'z' && !event.shiftKey);
        return;
      }
      if (event.key.toLowerCase() === 'a') {
        event.preventDefault();
        event.stopPropagation();
        nativeSelection(0, nativeValue().length);
        showSelection();
        return;
      }
    }
    syncSelection();
    const copy = new KeyboardEvent(event.type, {
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      isComposing: event.isComposing || composing,
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(copy);
    if (copy.defaultPrevented) event.preventDefault();
    event.stopPropagation();
  }
  editor.addEventListener('keydown', dispatchKeyboard, { signal });
  editor.addEventListener(
    'keyup',
    (event) => {
      syncSelection();
      event.stopPropagation();
    },
    { signal },
  );
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  editor.addEventListener(
    'beforeinput',
    (event) => {
      if (composing || event.isComposing || /Composition/.test(event.inputType)) return;
      syncSelection();
      let a = start(),
        b = end(),
        text;
      const type = event.inputType,
        value = nativeValue();
      if (type === 'historyUndo' || type === 'historyRedo') {
        event.preventDefault();
        travelHistory(type === 'historyUndo');
        return;
      }
      if (type === 'insertText' || type === 'insertReplacementText') text = event.data ?? '';
      else if (type === 'insertParagraph' || type === 'insertLineBreak') text = '\n';
      else if (type.startsWith('delete')) {
        text = '';
        if (a === b) {
          if (type.endsWith('Backward')) {
            const prefix = value.slice(0, a);
            a -= type.includes('Word')
              ? prefix.match(/\s*\S+\s*$/)?.[0].length || 0
              : type.includes('Line')
                ? prefix.length - prefix.lastIndexOf('\n') - 1
                : [...graphemes.segment(prefix)].at(-1)?.segment.length || 0;
          } else if (type.endsWith('Forward')) {
            const suffix = value.slice(b);
            b += type.includes('Word')
              ? suffix.match(/^\s*\S+\s*/)?.[0].length || 0
              : type.includes('Line')
                ? suffix.indexOf('\n') < 0
                  ? suffix.length
                  : suffix.indexOf('\n')
                : [...graphemes.segment(suffix)][0]?.segment.length || 0;
          }
        }
      }
      if (text !== undefined) {
        event.preventDefault();
        replace(a, b, text, undefined, undefined, type);
      }
    },
    { signal },
  );
  editor.addEventListener(
    'input',
    (event) => {
      event.stopPropagation();
      const before = snapshot();
      const value = raw(editor);
      if (!composing && value !== before.value) remember(event.inputType, before);
      valueProperty.set.call(field, value);
      syncSelection();
      if (!composing) render(true);
      emitInput(event.inputType, event.data, composing || event.isComposing);
    },
    { signal },
  );
  editor.addEventListener(
    'compositionstart',
    (event) => {
      syncSelection();
      remember('insertCompositionText', snapshot());
      composing = true;
      event.stopPropagation();
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: event.data }));
    },
    { signal },
  );
  editor.addEventListener(
    'compositionend',
    (event) => {
      valueProperty.set.call(field, raw(editor));
      syncSelection();
      composing = false;
      lastEdit = null;
      render(true);
      event.stopPropagation();
      field.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: event.data }));
      emitInput('insertCompositionText', event.data);
    },
    { signal },
  );
  editor.addEventListener(
    'paste',
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      syncSelection();
      replace(
        start(),
        end(),
        event.clipboardData.getData('text/plain'),
        undefined,
        undefined,
        'insertFromPaste',
      );
    },
    { signal },
  );
  for (const type of ['copy', 'cut'])
    editor.addEventListener(
      type,
      (event) => {
        const selection = getSelection();
        const anchor = selection?.anchorNode?.parentElement;
        if (anchor?.closest('.pt-expanded-body') && editor.contains(anchor) && !selection.isCollapsed) {
          event.preventDefault();
          event.stopPropagation();
          event.clipboardData.setData('text/plain', selection.toString());
          return;
        }
        syncSelection();
        if (start() === end()) return;
        event.preventDefault();
        event.stopPropagation();
        event.clipboardData.setData('text/plain', nativeValue().slice(start(), end()));
        if (type === 'cut') replace(start(), end(), '', undefined, undefined, 'deleteByCut');
      },
      { signal },
    );
  editor.addEventListener(
    'drop',
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      const point = document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (point && editor.contains(point.startContainer)) {
        const offset = offsetAt(point.startContainer, point.startOffset);
        nativeSelection(offset, offset);
        showSelection();
      }
      replace(start(), end(), event.dataTransfer.getData('text/plain'), undefined, undefined, 'insertFromDrop');
    },
    { signal },
  );
  editor.addEventListener(
    'pointerdown',
    (event) => {
      const chip = event.target.closest('[data-macro]');
      if (!chip) return;
      if (event.target.closest('.pt-inline-toggle, .pt-expanded-body')) return;
      if (macroDrag.pending) return;
      event.preventDefault();
      editor.focus({ preventScroll: true });
      const a = offsetAt(chip.parentNode, [...chip.parentNode.childNodes].indexOf(chip));
      nativeSelection(a, a + chip.dataset.macro.length);
      showSelection();
    },
    { signal },
  );
  editor.addEventListener(
    'click',
    (event) => {
      const toggle = event.target.closest('.pt-inline-toggle');
      if (toggle) {
        event.preventDefault();
        event.stopPropagation();
        const chip = toggle.closest('[data-macro]');
        setExpansion(chip, !chip.classList.contains('pt-expanded-block'), true);
        return;
      }
      if (event.target.closest('.pt-expanded-body')) {
        event.stopPropagation();
        return;
      }
      syncSelection();
      if (event.target.closest('.pt-inline-remove')) {
        const chip = event.target.closest('[data-macro]');
        const a = offsetAt(chip.parentNode, [...chip.parentNode.childNodes].indexOf(chip));
        const request = new CustomEvent('prompt-block-remove', {
          cancelable: true,
          detail: { from: a, to: a + chip.dataset.macro.length },
        });
        if (field.dispatchEvent(request)) replace(a, a + chip.dataset.macro.length, '');
      }
      field.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: event.clientX, clientY: event.clientY }),
      );
      event.stopPropagation();
    },
    { signal },
  );
  editor.addEventListener(
    'dblclick',
    (event) => {
      const chip = event.target.closest('[data-macro]');
      if (!chip || event.target.closest('button, .pt-expanded-body')) return;
      event.preventDefault();
      event.stopPropagation();
      setExpansion(chip, !chip.classList.contains('pt-expanded-block'));
    },
    { signal },
  );
  editor.addEventListener(
    'focus',
    () => {
      lastBlurValue = nativeValue();
      field.dispatchEvent(new FocusEvent('focus'));
      field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    },
    { signal },
  );
  editor.addEventListener(
    'blur',
    () => {
      syncSelection();
      field.dispatchEvent(new FocusEvent('blur'));
      field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      if (lastBlurValue !== nativeValue()) field.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { signal },
  );
  field.addEventListener(
    'focus',
    () => {
      if (document.activeElement === field) editor.focus({ preventScroll: true });
    },
    { signal },
  );
  field.addEventListener(
    'invalid',
    (event) => {
      event.preventDefault();
      editor.focus();
    },
    { signal },
  );
  field.addEventListener(
    'input',
    (event) => {
      if (!sending) render(true);
      scheduleFold(event.inputType);
    },
    { signal },
  );
  document.addEventListener(
    'selectionchange',
    () => {
      if (document.activeElement !== editor || syncing || composing) return;
      const a = start(),
        b = end();
      syncSelection();
      if (a !== start() || b !== end()) field.dispatchEvent(new Event('select', { bubbles: true }));
    },
    { signal },
  );
  document.addEventListener(
    'change',
    (event) => {
      if (event.target.matches?.('select[data-f="model"]')) queueMicrotask(() => render());
    },
    { signal },
  );
  function syncAttributes() {
    editor.contentEditable = String(!field.disabled && !field.readOnly);
    editor.setAttribute('aria-disabled', String(field.disabled));
    editor.dataset.placeholder = field.placeholder;
    for (const attr of [
      'aria-expanded',
      'aria-activedescendant',
      'aria-autocomplete',
      'aria-controls',
      'aria-haspopup',
    ]) {
      if (field.hasAttribute(attr)) editor.setAttribute(attr, field.getAttribute(attr));
      else editor.removeAttribute(attr);
    }
  }
  const attributes = new MutationObserver(syncAttributes);
  attributes.observe(field, {
    attributes: true,
    attributeFilter: [
      'disabled',
      'readonly',
      'placeholder',
      'aria-expanded',
      'aria-activedescendant',
      'aria-autocomplete',
      'aria-controls',
      'aria-haspopup',
    ],
  });
  const unwatch = watchChunks(() => render(true));
  syncAttributes();
  render();
  return () => {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(foldTimer);
    macroDrag.destroy();
    attributes.disconnect();
    unwatch();
    for (const [key, descriptor] of ownedProperties) {
      if (descriptor) Object.defineProperty(field, key, descriptor);
      else delete field[key];
    }
    field.classList.remove('pt-raw-field');
    for (const [attr, value] of [
      ['tabindex', original.tabindex],
      ['aria-hidden', original.ariaHidden],
    ]) {
      if (value === null) field.removeAttribute(attr);
      else field.setAttribute(attr, value);
    }
    if (frame.parentNode) frame.replaceWith(field);
  };
}
