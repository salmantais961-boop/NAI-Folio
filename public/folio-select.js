// The original select owns form values and events. This adapter only changes
// its presentation, using the same popover motion as the proof action menu.
const mounts = new WeakMap();
const native = HTMLSelectElement.prototype;
const valueDescriptor = Object.getOwnPropertyDescriptor(native, 'value');
const indexDescriptor = Object.getOwnPropertyDescriptor(native, 'selectedIndex');

function svg(path, className) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('aria-hidden', 'true');
  icon.setAttribute('class', className);
  const line = document.createElementNS(icon.namespaceURI, 'path');
  line.setAttribute('d', path);
  icon.append(line);
  return icon;
}
function labelFor(select) {
  if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
  const ids = select.getAttribute('aria-labelledby');
  if (ids)
    return ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || '')
      .join(' ')
      .trim();
  const label = select.labels?.[0] || select.closest('label');
  if (label) {
    const clone = label.cloneNode(true);
    clone.querySelectorAll('select, .fs-control, button').forEach((node) => node.remove());
    const name = clone.textContent.trim().replace(/\s+/g, ' ');
    if (name) return name;
  }
  return select.title || '选择选项';
}
function addressFor(select) {
  const anchor = select.parentElement?.closest('[id]');
  let selector = select.id ? '#' + CSS.escape(select.id) : '';
  for (const attribute of ['data-f', 'data-key', 'name', 'aria-label']) {
    if (!selector && select.hasAttribute(attribute))
      selector = `select[${attribute}="${CSS.escape(select.getAttribute(attribute))}"]`;
  }
  return { anchor: anchor?.id, selector };
}

export function mountFolioSelects(root = document) {
  if (mounts.has(root)) return mounts.get(root);
  const states = new Map();
  const abort = new AbortController();
  let active = null,
    scanFrame = 0,
    positionFrame = 0,
    disposed = false;
  const contains = (select) => (root === document ? select.isConnected : root.contains(select));
  const suitable = (select) =>
    !select.multiple && select.size <= 1 && !select.hasAttribute('data-native-select');
  const isOpen = (state) => !!state && active === state;

  function close(state = active, focus = false) {
    if (!state) return;
    if (active === state) active = null;
    state.trigger.setAttribute('aria-expanded', 'false');
    state.trigger.removeAttribute('aria-activedescendant');
    state.typed = '';
    if (state.popover && state.menu.matches(':popover-open')) state.menu.hidePopover();
    state.menu.classList.remove('fs-fallback-open');
    if (!state.popover) state.menu.hidden = true;
    if (focus && state.trigger.isConnected && !state.trigger.disabled)
      state.trigger.focus({ preventScroll: true });
  }
  function highlight(state, index, scroll = true) {
    if (!state.rows.has(index) || state.rows.get(index).getAttribute('aria-disabled') === 'true') return;
    state.highlighted = index;
    for (const [i, row] of state.rows) row.toggleAttribute('data-active', i === index);
    const row = state.rows.get(index);
    state.trigger.setAttribute('aria-activedescendant', row.id);
    if (scroll && isOpen(state)) row.scrollIntoView({ block: 'nearest' });
  }
  function enabledIndices(state) {
    return [...state.rows]
      .filter(([, row]) => row.getAttribute('aria-disabled') !== 'true')
      .map(([index]) => index);
  }
  function position() {
    positionFrame = 0;
    const state = active;
    if (!state) return;
    if (!contains(state.select) || state.trigger.disabled || !state.trigger.getClientRects().length)
      return close(state);
    const rect = state.trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft || 0,
      topEdge = viewport?.offsetTop || 0;
    const rightEdge = leftEdge + (viewport?.width || innerWidth),
      bottomEdge = topEdge + (viewport?.height || innerHeight);
    if (rect.bottom < topEdge || rect.top > bottomEdge || rect.right < leftEdge || rect.left > rightEdge)
      return close(state);
    const width = Math.max(0, Math.min(Math.max(180, rect.width), 360, rightEdge - leftEdge - 16));
    const below = bottomEdge - rect.bottom - 14,
      above = rect.top - topEdge - 14;
    const desired = Math.min(380, state.menu.scrollHeight || 380);
    const upwards = below < Math.min(200, desired) && above > below;
    state.menu.style.width = width + 'px';
    state.menu.style.maxHeight = Math.max(64, Math.min(380, upwards ? above : below)) + 'px';
    const height = Math.min(state.menu.scrollHeight, parseFloat(state.menu.style.maxHeight));
    state.menu.style.left = Math.max(leftEdge + 8, Math.min(rect.left, rightEdge - width - 8)) + 'px';
    state.menu.style.top = Math.max(topEdge + 8, upwards ? rect.top - height - 6 : rect.bottom + 6) + 'px';
    state.menu.dataset.side = upwards ? 'above' : 'below';
  }
  function schedulePosition() {
    if (active && !positionFrame) positionFrame = requestAnimationFrame(position);
  }
  function renderOptions(state) {
    const { select, list, menu } = state;
    const rows = new Map();
    let group = null;
    const fragment = document.createDocumentFragment();
    for (const [index, option] of [...select.options].entries()) {
      const optgroup = option.parentElement?.tagName === 'OPTGROUP' ? option.parentElement : null;
      if (option.hidden || optgroup?.hidden) continue;
      if (optgroup && group !== optgroup) {
        const heading = document.createElement('div');
        heading.className = 'fs-optgroup';
        heading.textContent = optgroup.label;
        heading.setAttribute('role', 'presentation');
        fragment.append(heading);
      }
      group = optgroup;
      const row = document.createElement('div');
      row.className = 'fs-option';
      row.id = menu.id + '-option-' + index;
      row.dataset.index = index;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === select.selectedIndex));
      row.setAttribute('aria-disabled', String(option.disabled || !!optgroup?.disabled));
      const text = document.createElement('span');
      text.textContent = option.label;
      row.append(text, svg('M3 8.5 6.3 12 13 4.5', 'fs-check'));
      fragment.append(row);
      rows.set(index, row);
    }
    list.replaceChildren(fragment);
    state.rows = rows;
  }
  function sync(state) {
    const { select, trigger, value, menu, heading } = state;
    const disabled = select.matches(':disabled');
    if (trigger.disabled !== disabled) trigger.disabled = disabled;
    trigger.tabIndex =
      select.getAttribute('data-fs-tabindex') == null ? 0 : Number(select.getAttribute('data-fs-tabindex'));
    const text = select.options[select.selectedIndex]?.label || '请选择';
    if (value.textContent !== text) value.textContent = text;
    const label = labelFor(select);
    if (trigger.getAttribute('aria-label') !== label) {
      trigger.setAttribute('aria-label', label);
      state.list.setAttribute('aria-label', label);
      heading.textContent = label;
    }
    trigger.title = select.title || text;
    const signature = [...select.options]
      .map((option) =>
        [
          option.value,
          option.label,
          option.disabled,
          option.hidden,
          option.parentElement?.label,
          option.parentElement?.disabled,
          option.parentElement?.hidden,
        ].join('\u0001'),
      )
      .join('\u0002');
    if (state.signature !== signature) {
      state.signature = signature;
      renderOptions(state);
    }
    if (state.index !== select.selectedIndex) {
      state.index = select.selectedIndex;
      for (const [index, row] of state.rows) row.setAttribute('aria-selected', String(index === state.index));
      if (isOpen(state)) highlight(state, state.index, false);
    }
    if (isOpen(state) && disabled) close(state);
    if (isOpen(state)) schedulePosition();
    menu.toggleAttribute('data-fs-disabled', disabled);
  }
  function open(state) {
    sync(state);
    if (state.trigger.disabled || !contains(state.select)) return;
    if (active === state) return close(state, true);
    close();
    active = state;
    // Descendant popovers remain interactive inside a modal dialog's inert boundary.
    const host = state.select.closest('dialog') || document.body;
    if (state.menu.parentElement !== host) host.append(state.menu);
    if (state.popover) state.menu.showPopover();
    else {
      state.menu.hidden = false;
      state.menu.classList.add('fs-fallback-open');
    }
    state.trigger.setAttribute('aria-expanded', 'true');
    const indices = enabledIndices(state);
    highlight(
      state,
      indices.includes(state.select.selectedIndex) ? state.select.selectedIndex : indices[0],
      false,
    );
    position();
    state.rows.get(state.highlighted)?.scrollIntoView({ block: 'nearest' });
  }
  function commit(state, index) {
    const row = state.rows.get(index);
    if (!row || row.getAttribute('aria-disabled') === 'true') return;
    const { select, trigger } = state;
    const changed = select.selectedIndex !== index;
    const address = addressFor(select);
    select.selectedIndex = index;
    sync(state);
    close(state);
    if (changed) {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    requestAnimationFrame(() => {
      if (disposed) return;
      const focused = document.activeElement;
      if (
        focused &&
        focused !== document.body &&
        focused !== trigger &&
        focused !== select &&
        focused.isConnected
      )
        return;
      if (trigger.isConnected) return trigger.focus({ preventScroll: true });
      // A change handler may rebuild controls synchronously. Mount their new
      // proxy before restoring focus, regardless of observer/rAF ordering.
      if (scanFrame) cancelAnimationFrame(scanFrame);
      scan();
      const anchor = address.anchor && document.getElementById(address.anchor);
      const replacement = address.selector && (anchor || document).querySelector(address.selector);
      if (replacement?.isConnected) replacement.focus({ preventScroll: true });
    });
  }
  function keyboard(event, state) {
    if (state.trigger.disabled || event.ctrlKey || event.metaKey) return;
    const key = event.key,
      opened = isOpen(state);
    if (key === 'Tab') {
      close(state);
      return;
    }
    if (key === 'Escape' && opened) {
      event.preventDefault();
      event.stopPropagation();
      close(state, true);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      if (opened) commit(state, state.highlighted);
      else open(state);
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(key)) {
      event.preventDefault();
      if (!opened) {
        open(state);
        if (key.startsWith('Arrow')) return;
      }
      const indices = enabledIndices(state);
      const index = indices.indexOf(state.highlighted),
        length = indices.length;
      let next =
        key === 'Home'
          ? 0
          : key === 'End'
            ? length - 1
            : Math.max(
                0,
                Math.min(
                  length - 1,
                  index + (key === 'PageDown' ? 8 : key === 'PageUp' ? -8 : key === 'ArrowDown' ? 1 : -1),
                ),
              );
      highlight(state, indices[next]);
      return;
    }
    if (key.length === 1 && !event.altKey) {
      event.preventDefault();
      if (!opened) open(state);
      const now = performance.now();
      state.typed = now - state.typedAt > 700 ? key : state.typed + key;
      state.typedAt = now;
      const search = state.typed.toLocaleLowerCase();
      const match = enabledIndices(state).find((index) =>
        state.select.options[index].label.trim().toLocaleLowerCase().startsWith(search),
      );
      if (match != null) highlight(state, match);
    }
  }
  function mount(select) {
    const wrapper = document.createElement('span');
    wrapper.className = 'fs-control';
    const trigger = document.createElement('button');
    trigger.className = 'fs-trigger';
    trigger.type = 'button';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const value = document.createElement('span');
    value.className = 'fs-value';
    trigger.append(value, svg('M4 6 8 10 12 6', 'fs-chevron'));
    const menu = document.createElement('div');
    menu.className = 'fs-menu';
    menu.id = 'folio-select-' + crypto.randomUUID();
    const popover = typeof menu.showPopover === 'function';
    if (popover) menu.setAttribute('popover', 'auto');
    else menu.hidden = true;
    const heading = document.createElement('div');
    heading.className = 'fs-heading';
    heading.setAttribute('aria-hidden', 'true');
    const list = document.createElement('div');
    list.className = 'fs-options';
    list.id = menu.id + '-list';
    list.setAttribute('role', 'listbox');
    menu.append(heading, list);
    trigger.setAttribute('aria-controls', list.id);
    const original = {
      tabindex: select.getAttribute('tabindex'),
      ariaHidden: select.getAttribute('aria-hidden'),
    };
    const stateAbort = new AbortController();
    const state = {
      select,
      wrapper,
      trigger,
      value,
      menu,
      heading,
      list,
      popover,
      original,
      abort: stateAbort,
      rows: new Map(),
      signature: null,
      index: null,
      highlighted: -1,
      typed: '',
      typedAt: 0,
      owned: new Map(),
    };
    states.set(select, state);
    if (original.tabindex != null) select.setAttribute('data-fs-tabindex', original.tabindex);
    select.before(wrapper);
    wrapper.append(select, trigger);
    select.classList.add('fs-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    for (const [name, descriptor] of [
      ['value', valueDescriptor],
      ['selectedIndex', indexDescriptor],
    ]) {
      const own = Object.getOwnPropertyDescriptor(select, name);
      if (own && !own.configurable) continue;
      state.owned.set(name, own);
      Object.defineProperty(select, name, {
        configurable: true,
        get() {
          return descriptor.get.call(select);
        },
        set(value) {
          descriptor.set.call(select, value);
          sync(state);
        },
      });
    }
    const ownFocus = Object.getOwnPropertyDescriptor(select, 'focus');
    if (!ownFocus || ownFocus.configurable) {
      state.owned.set('focus', ownFocus);
      Object.defineProperty(select, 'focus', {
        configurable: true,
        value(options) {
          trigger.focus(options);
        },
      });
    }
    select.addEventListener('focus', () => trigger.focus({ preventScroll: true }), {
      signal: stateAbort.signal,
    });
    select.addEventListener('change', () => sync(state), { signal: stateAbort.signal });
    select.addEventListener('input', () => sync(state), { signal: stateAbort.signal });
    trigger.addEventListener('click', () => open(state), { signal: stateAbort.signal });
    trigger.addEventListener('keydown', (event) => keyboard(event, state), { signal: stateAbort.signal });
    trigger.addEventListener('focus', () => sync(state), { signal: stateAbort.signal });
    menu.addEventListener(
      'pointerdown',
      (event) => {
        if (event.pointerType !== 'touch') event.preventDefault();
      },
      { signal: stateAbort.signal },
    );
    menu.addEventListener(
      'pointermove',
      (event) => {
        const row = event.target.closest('.fs-option');
        if (row) highlight(state, Number(row.dataset.index), false);
      },
      { signal: stateAbort.signal },
    );
    menu.addEventListener(
      'click',
      (event) => {
        const row = event.target.closest('.fs-option');
        if (row) commit(state, Number(row.dataset.index));
      },
      { signal: stateAbort.signal },
    );
    menu.addEventListener(
      'toggle',
      () => {
        if (active === state && popover && !menu.matches(':popover-open')) close(state);
      },
      { signal: stateAbort.signal },
    );
    sync(state);
  }
  function unmount(select, state) {
    close(state);
    state.abort.abort();
    state.menu.remove();
    state.trigger.remove();
    for (const [key, descriptor] of state.owned) {
      if (descriptor) Object.defineProperty(select, key, descriptor);
      else delete select[key];
    }
    select.classList.remove('fs-native');
    select.removeAttribute('data-fs-tabindex');
    for (const [name, value] of [
      ['tabindex', state.original.tabindex],
      ['aria-hidden', state.original.ariaHidden],
    ]) {
      if (value == null) select.removeAttribute(name);
      else select.setAttribute(name, value);
    }
    if (state.wrapper.parentNode) state.wrapper.replaceWith(select);
    states.delete(select);
  }
  function scan() {
    scanFrame = 0;
    if (disposed) return;
    for (const [select, state] of states) if (!contains(select) || !suitable(select)) unmount(select, state);
    for (const select of root.querySelectorAll('select')) {
      if (!suitable(select)) continue;
      if (!states.has(select)) mount(select);
      else sync(states.get(select));
    }
  }
  function queueScan() {
    if (!scanFrame && !disposed) scanFrame = requestAnimationFrame(scan);
  }
  const observer = new MutationObserver(queueScan);
  observer.observe(root === document ? document.documentElement : root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      'disabled',
      'selected',
      'label',
      'value',
      'hidden',
      'multiple',
      'size',
      'aria-label',
      'aria-labelledby',
    ],
  });
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (active && !active.wrapper.contains(event.target) && !active.menu.contains(event.target)) close();
    },
    { capture: true, signal: abort.signal },
  );
  document.addEventListener(
    'scroll',
    (event) => {
      if (!active?.menu.contains(event.target)) schedulePosition();
    },
    { capture: true, passive: true, signal: abort.signal },
  );
  window.addEventListener('resize', schedulePosition, { passive: true, signal: abort.signal });
  window.visualViewport?.addEventListener('resize', schedulePosition, { passive: true, signal: abort.signal });
  window.visualViewport?.addEventListener('scroll', schedulePosition, { passive: true, signal: abort.signal });
  document.addEventListener('reset', () => setTimeout(queueScan, 0), { capture: true, signal: abort.signal });
  // Option.selected can be assigned without an attribute mutation or a change
  // event. A small visible-page reconciliation also covers that native API.
  const reconciliation = setInterval(() => {
    if (!document.hidden) for (const state of states.values()) if (contains(state.select)) sync(state);
  }, 400);
  scan();
  const api = {
    refresh: scan,
    destroy() {
      disposed = true;
      mounts.delete(root);
      abort.abort();
      observer.disconnect();
      clearInterval(reconciliation);
      cancelAnimationFrame(scanFrame);
      cancelAnimationFrame(positionFrame);
      for (const [select, state] of [...states]) unmount(select, state);
    },
  };
  mounts.set(root, api);
  return api;
}
