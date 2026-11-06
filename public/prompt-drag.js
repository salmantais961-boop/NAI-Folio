import { macroMoveSource, macroDropStops, moveMacro } from './prompt-move.js';

export function mountMacroDrag({ editor, field, read, offsetAt, pointAt, select, commit, getModel, signal }) {
  let pending,
    frame,
    suppressUntil = 0;
  const marker = document.createElement('span');
  marker.className = 'pt-drop-caret';
  marker.hidden = true;
  const status = document.createElement('span');
  status.className = 'pt-drag-status';
  status.setAttribute('role', 'status');
  document.body.append(marker, status);

  const message = (text) => {
    status.textContent = text;
    field.dispatchEvent(new CustomEvent('prompt-editor-error', { detail: text }));
  };
  function restore() {
    if (!pending) return;
    clearTimeout(pending.hold);
    cancelAnimationFrame(frame);
    pending.chip?.classList.remove('pt-block-grabbed');
    pending.ghost?.remove();
    try {
      editor.releasePointerCapture(pending.id);
    } catch {}
    marker.hidden = true;
    editor.classList.remove('is-macro-dragging');
    document.documentElement.classList.remove('pt-macro-dragging');
    pending = null;
  }
  function cancel() {
    if (!pending) return;
    const state = pending;
    if (state.active) suppressUntil = performance.now() + 350;
    restore();
    if (state.active && read() === state.text) select(state.macroFrom, state.macroTo);
  }
  function caretRect(offset) {
    for (const chip of editor.querySelectorAll('[data-macro]')) {
      const from = offsetAt(chip.parentNode, [...chip.parentNode.childNodes].indexOf(chip));
      if (offset !== from && offset !== from + chip.dataset.macro.length) continue;
      const box = chip.getBoundingClientRect();
      return { left: offset === from ? box.left - 1 : box.right + 1, top: box.top, height: box.height };
    }
    const range = document.createRange();
    range.setStart(...pointAt(offset));
    range.collapse(true);
    let box = range.getClientRects()[0];
    if (box?.height) return box;
    if (offset < read().length) {
      range.setEnd(...pointAt(offset + 1));
      box = range.getBoundingClientRect();
      if (box?.height) return box;
    } else if (offset > 0) {
      range.setStart(...pointAt(offset - 1));
      box = range.getBoundingClientRect();
      if (box?.height) return { left: box.right, top: box.top, height: box.height };
    }
    const rect = editor.getBoundingClientRect(),
      style = getComputedStyle(editor);
    return {
      left: rect.left + parseFloat(style.paddingLeft || 0),
      top: rect.top + parseFloat(style.paddingTop || 0),
      height: parseFloat(style.lineHeight) || 20,
    };
  }
  function paint() {
    if (!pending?.active) return;
    if (!editor.isConnected || read() !== pending.text) {
      cancel();
      return;
    }
    const { x, y, ghost, stops, overlay } = pending;
    ghost.style.transform = `translate3d(${(x - pending.grabX - overlay.left) / overlay.scaleX}px,${(y - pending.grabY - overlay.top) / overlay.scaleY}px,0)`;
    const rect = editor.getBoundingClientRect();
    const inside = x >= rect.left - 24 && x <= rect.right + 24 && y >= rect.top - 28 && y <= rect.bottom + 28;
    marker.hidden = !inside;
    pending.target = null;
    if (inside) {
      if (!pending.rects || pending.dirty) {
        pending.rects = stops.map((offset) => ({ offset, box: caretRect(offset) }));
        pending.dirty = false;
      }
      let winner,
        score = Infinity;
      for (const { offset, box } of pending.rects) {
        const dx = x - box.left,
          dy = y - box.top - box.height / 2;
        const distance = dx * dx + dy * dy * 6;
        if (distance < score) {
          score = distance;
          winner = { offset, box };
        }
      }
      if (winner) {
        pending.target = winner.offset;
        marker.style.cssText = `left:${(winner.box.left - overlay.left) / overlay.scaleX}px;top:${(winner.box.top - 2 - overlay.top) / overlay.scaleY}px;height:${(winner.box.height + 4) / overlay.scaleY}px;width:${3 / overlay.scaleX}px`;
        marker.dataset.valid = String(Boolean(moveMacro(pending.text, pending.source, pending.target)));
      }
    }
    for (let parent = editor.parentElement; parent; parent = parent.parentElement) {
      if (
        parent.scrollHeight <= parent.clientHeight + 2 ||
        !/(auto|scroll)/.test(getComputedStyle(parent).overflowY)
      )
        continue;
      const bounds = parent.getBoundingClientRect();
      if (x >= bounds.left && x <= bounds.right) {
        const delta = y < bounds.top + 36 ? -9 : y > bounds.bottom - 36 ? 9 : 0;
        if (delta) parent.scrollTop += delta;
      }
      break;
    }
    frame = requestAnimationFrame(paint);
  }
  function begin() {
    if (!pending || pending.active || read() !== pending.text) return;
    if (!pending.chip.isConnected) {
      cancel();
      return;
    }
    if (!pending.source) {
      message('请先闭合权重组；随机分支内的词块需先移出分支。');
      cancel();
      return;
    }
    pending.active = true;
    clearTimeout(pending.hold);
    field.dispatchEvent(new Event('prompt-block-drag-start'));
    pending.chip.classList.add('pt-block-grabbed');
    const ghost = pending.chip.cloneNode(true);
    ghost.className = 'pt-macro-ghost';
    ghost.classList.toggle('pt-expanded-block', pending.chip.classList.contains('pt-expanded-block'));
    ghost.removeAttribute('data-macro');
    ghost.removeAttribute('contenteditable');
    ghost.removeAttribute('title');
    ghost.inert = true;
    const style = getComputedStyle(pending.chip);
    const box = pending.chip.getBoundingClientRect();
    for (const key of [
      'paddingTop',
      'paddingRight',
      'paddingBottom',
      'paddingLeft',
      'borderRadius',
      'gap',
      'font',
      'lineHeight',
    ])
      ghost.style[key] = style[key];
    ghost.style.width = box.width + 'px';
    ghost.style.height = box.height + 'px';
    ghost.style.background = style.backgroundColor;
    ghost.style.color = style.color;
    pending.ghost = ghost;
    document.body.append(ghost);
    // Keep the original grab point under the pointer. Body-level fixed placement
    // escapes editor transforms; calibration also accounts for inherited CSS zoom.
    const placed = ghost.getBoundingClientRect();
    pending.overlay = {
      left: placed.left,
      top: placed.top,
      scaleX: placed.width / box.width || 1,
      scaleY: placed.height / box.height || 1,
    };
    ghost.style.width = box.width / pending.overlay.scaleX + 'px';
    ghost.style.height = box.height / pending.overlay.scaleY + 'px';
    editor.classList.add('is-macro-dragging');
    document.documentElement.classList.add('pt-macro-dragging');
    getSelection()?.removeAllRanges();
    try {
      editor.setPointerCapture(pending.id);
    } catch {}
    status.textContent = '正在移动词块。松开完成，Escape 取消。';
    paint();
  }
  editor.addEventListener(
    'pointerdown',
    (event) => {
      const chip = event.target.closest('[data-macro]');
      if (
        !chip ||
        event.target.closest('.pt-inline-remove, .pt-inline-toggle, .pt-expanded-body') ||
        event.button !== 0 ||
        event.isPrimary === false ||
        field.disabled ||
        field.readOnly ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      cancel();
      const from = offsetAt(chip.parentNode, [...chip.parentNode.childNodes].indexOf(chip));
      const text = read();
      const box = chip.getBoundingClientRect();
      pending = {
        chip,
        id: event.pointerId,
        touch: event.pointerType === 'touch',
        text,
        grabX: event.clientX - box.left,
        grabY: event.clientY - box.top,
        macroFrom: from,
        macroTo: from + chip.dataset.macro.length,
        source: macroMoveSource(text, from, {
          weight: chip._promptWeight ?? Number(chip.dataset.weight),
          model: getModel?.(),
        }),
        stops: macroDropStops(text),
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
      };
      if (pending.touch) pending.hold = setTimeout(begin, 280);
      else {
        event.preventDefault();
        editor.focus({ preventScroll: true });
        select(pending.macroFrom, pending.macroTo);
      }
    },
    { signal },
  );
  document.addEventListener(
    'pointermove',
    (event) => {
      if (!pending || event.pointerId !== pending.id) return;
      pending.x = event.clientX;
      pending.y = event.clientY;
      const distance = Math.hypot(pending.x - pending.startX, pending.y - pending.startY);
      if (!pending.active && pending.touch && distance > 8) {
        restore();
        return;
      }
      if (!pending.active && !pending.touch && distance >= 6) begin();
      if (pending?.active) event.preventDefault();
    },
    { signal, passive: false },
  );
  document.addEventListener(
    'touchmove',
    (event) => {
      if (pending?.active) event.preventDefault();
    },
    { signal, passive: false },
  );
  document.addEventListener(
    'pointerup',
    (event) => {
      if (!pending || event.pointerId !== pending.id) return;
      if (pending.active) {
        pending.x = event.clientX;
        pending.y = event.clientY;
        cancelAnimationFrame(frame);
        paint();
        if (!pending) return;
      }
      const state = pending;
      if (!state.active) {
        restore();
        if (state.touch) {
          editor.focus({ preventScroll: true });
          select(state.macroFrom, state.macroTo);
        }
        return;
      }
      event.preventDefault();
      const moved =
        state.target !== null && read() === state.text
          ? moveMacro(state.text, state.source, state.target)
          : null;
      suppressUntil = performance.now() + 350;
      restore();
      if (moved) {
        commit(moved);
        status.textContent = '词块位置已调整，可撤销。';
      } else select(state.macroFrom, state.macroTo);
    },
    { signal },
  );
  document.addEventListener('pointercancel', cancel, { signal });
  document.addEventListener(
    'scroll',
    () => {
      if (pending) pending.dirty = true;
    },
    { signal, capture: true, passive: true },
  );
  window.addEventListener(
    'resize',
    () => {
      if (pending) pending.dirty = true;
    },
    { signal, passive: true },
  );
  editor.addEventListener(
    'keydown',
    (event) => {
      if (pending && event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
      }
    },
    { signal, capture: true },
  );
  editor.addEventListener(
    'contextmenu',
    (event) => {
      if (pending) event.preventDefault();
    },
    { signal },
  );
  editor.addEventListener(
    'dragstart',
    (event) => {
      if (event.target.closest('[data-macro]')) event.preventDefault();
    },
    { signal },
  );
  editor.addEventListener(
    'click',
    (event) => {
      if (performance.now() < suppressUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    { signal, capture: true },
  );
  return {
    get active() {
      return Boolean(pending?.active);
    },
    get pending() {
      return Boolean(pending);
    },
    cancel,
    destroy() {
      restore();
      marker.remove();
      status.remove();
    },
  };
}
