// Original native motion for the studio, inspired by the choice feedback in
// Rare UI Theme selector and the expandable answers in Rare UI FAQ.
// https://www.rareui.com/components/themeselector
// https://www.rareui.com/components/faq
import { captureComposeLayout, followComposeLayout, cancelComposeLayout } from './compose-layout.js';
const mounts = new WeakMap();
export function mountComposeMotion(root = document.querySelector('.compose-panel')) {
  if (!root) return { destroy() {} };
  if (mounts.has(root)) return mounts.get(root);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const abort = new AbortController();
  const segments = new Map();
  const disclosures = new Map();
  const previous = new Map();
  let frame = 0;
  let disposed = false;
  let layoutFrame = 0;
  let layoutBefore = null;
  let restoreFocus = null;
  let layoutExpiry = 0;
  const layoutActions = new Set([
    'mode',
    'add-char',
    'delete-char',
    'raise-char',
    'lower-char',
    'delete-ref',
    'remove-source',
  ]);
  function captureChange(event) {
    const control = event.target.closest('[data-action], [data-f], [data-file], [data-key]');
    if (
      !control ||
      (event.type === 'click'
        ? !layoutActions.has(control.dataset.action)
        : !control.matches('select, input[type="checkbox"], input[type="file"]'))
    )
      return;
    layoutBefore = captureComposeLayout(root);
    clearTimeout(layoutExpiry);
    layoutExpiry = setTimeout(() => {
      layoutBefore = null;
      restoreFocus = null;
    }, 1200);
    restoreFocus = null;
    if (document.activeElement === control) {
      if (control.dataset.action === 'mode')
        restoreFocus = [`.fc-mode-switch [data-id="${CSS.escape(control.dataset.id)}"]`];
      else if (control.dataset.action === 'delete-char')
        restoreFocus = [
          `[data-c="${CSS.escape(control.closest('[data-c]').dataset.c)}"] [data-action="delete-char"]`,
          '[data-action="add-char"]',
        ];
    }
  }
  function followChange() {
    layoutFrame = 0;
    if (!layoutBefore || disposed) return;
    const before = layoutBefore;
    clearTimeout(layoutExpiry);
    layoutBefore = null;
    followComposeLayout(root, before);
    if (restoreFocus && document.activeElement === document.body)
      restoreFocus
        .map((selector) => root.querySelector(selector))
        .find(Boolean)
        ?.focus({ preventScroll: true });
    restoreFocus = null;
  }
  root.addEventListener('click', captureChange, { capture: true, signal: abort.signal });
  root.addEventListener('change', captureChange, { capture: true, signal: abort.signal });
  const keyFor = (group) => (group.matches('.fc-mode-switch') ? 'mode' : 'format');
  const write = (group, rect) => {
    for (const [key, value] of Object.entries(rect)) group.style.setProperty('--cm-' + key, value + 'px');
  };
  function place(group) {
    const choice = group.querySelector('button[aria-pressed="true"]');
    if (!choice || !group.getClientRects().length) return;
    const bounds = group.getBoundingClientRect(),
      item = choice.getBoundingClientRect();
    if (!bounds.width || !item.width) return;
    const target = {
      x: item.left - bounds.left,
      y: item.top - bounds.top,
      width: item.width,
      height: item.height,
    };
    const key = keyFor(group),
      last = previous.get(key);
    if (!segments.has(group)) {
      segments.set(group, true);
      observer.observe(group);
      group.classList.add('cm-segmented');
      group.setAttribute('data-cm-instant', '');
      write(
        group,
        !reduced.matches && last && Math.abs(last.parentWidth - bounds.width) < 2 ? last.rect : target,
      );
      // Resolve the initial underlay before enabling its next-position transition.
      getComputedStyle(group, '::before').translate;
      group.removeAttribute('data-cm-instant');
    }
    write(group, target);
    previous.set(key, { rect: target, parentWidth: bounds.width });
  }
  function scan() {
    frame = 0;
    if (disposed) return;
    for (const group of segments.keys())
      if (!group.isConnected) {
        observer.unobserve(group);
        segments.delete(group);
      }
    for (const [details, state] of disclosures)
      if (!details.isConnected) {
        state.animation?.cancel();
        disclosures.delete(details);
      }
    for (const group of root.querySelectorAll('.fc-mode-switch, .fc-formats')) place(group);
  }
  function queue() {
    if (!frame && !disposed) frame = requestAnimationFrame(scan);
  }
  const observer = new ResizeObserver(queue);
  observer.observe(root);
  const mutation = new MutationObserver((records) => {
    queue();
    if (layoutBefore && records.some((record) => record.type === 'childList') && !layoutFrame) {
      layoutFrame = 1;
      // Mutation delivery is before paint. Applying the inverse here avoids a
      // one-frame glimpse of the final layout before its followers catch up.
      queueMicrotask(followChange);
    }
  });
  mutation.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['aria-pressed'],
  });

  function settle(details, state) {
    if (disclosures.get(details) !== state) return;
    disclosures.delete(details);
    details.open = state.open;
    details.style.removeProperty('height');
    details.removeAttribute('data-cm-disclosing');
    state.animation?.cancel();
  }
  function disclose(details) {
    const existing = disclosures.get(details);
    const open = existing ? !existing.open : !details.open;
    const height = details.getBoundingClientRect().height;
    existing?.animation?.cancel();
    const state = { open, animation: null };
    disclosures.set(details, state);
    if (reduced.matches) {
      settle(details, state);
      return;
    }
    details.open = true;
    details.style.removeProperty('height');
    const target = open
      ? details.getBoundingClientRect().height
      : (() => {
          const style = getComputedStyle(details);
          return (
            details.querySelector(':scope > summary').getBoundingClientRect().height +
            parseFloat(style.paddingTop) +
            parseFloat(style.paddingBottom) +
            parseFloat(style.borderTopWidth) +
            parseFloat(style.borderBottomWidth)
          );
        })();
    details.setAttribute('data-cm-disclosing', '');
    details.style.height = height + 'px';
    state.animation = details.animate([{ height: height + 'px' }, { height: target + 'px' }], {
      duration: open ? 270 : 220,
      easing: 'cubic-bezier(.2,.75,.25,1)',
      fill: 'forwards',
    });
    state.animation.onfinish = () => settle(details, state);
  }
  root.addEventListener(
    'click',
    (event) => {
      const summary = event.target.closest('summary');
      const details = summary?.parentElement;
      if (
        !details?.matches('details.fc-details, details.bill-usage, details.bill-cost') ||
        !root.contains(details)
      )
        return;
      if (event.target.closest('a, button, input, select') || event.ctrlKey || event.metaKey || event.altKey)
        return;
      event.preventDefault();
      disclose(details);
    },
    { signal: abort.signal },
  );

  root.addEventListener(
    'keydown',
    (event) => {
      const button = event.target.closest('.fc-mode-switch > button, .fc-formats > button');
      if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const group = button.parentElement;
      const options = [...group.querySelectorAll('button:not(:disabled)')];
      const at = options.indexOf(button);
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? options.length - 1
            : (at + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length;
      event.preventDefault();
      const selector = group.matches('.fc-mode-switch') ? '.fc-mode-switch' : '.fc-formats';
      options[index]?.click();
      requestAnimationFrame(() =>
        root.querySelector(selector + ' button[aria-pressed="true"]')?.focus({ preventScroll: true }),
      );
    },
    { signal: abort.signal },
  );
  reduced.addEventListener(
    'change',
    () => {
      if (reduced.matches) for (const [details, state] of [...disclosures]) settle(details, state);
      if (reduced.matches) cancelComposeLayout(root);
      queue();
    },
    { signal: abort.signal },
  );
  scan();
  const api = {
    destroy() {
      mounts.delete(root);
      disposed = true;
      abort.abort();
      cancelAnimationFrame(frame);
      layoutFrame = 0;
      clearTimeout(layoutExpiry);
      cancelComposeLayout(root);
      mutation.disconnect();
      observer.disconnect();
      for (const [details, state] of [...disclosures]) settle(details, state);
      for (const group of segments.keys()) {
        group.classList.remove('cm-segmented');
        for (const prop of ['x', 'y', 'width', 'height']) group.style.removeProperty('--cm-' + prop);
      }
      segments.clear();
    },
  };
  mounts.set(root, api);
  return api;
}
