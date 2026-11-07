// Folio motion runtime. Pairs with motion.css.
//
// Arrivals settle like a printed leaf placed on the desk; departures lift away
// slightly defocused. Everything here is progressive: when a browser lacks an
// API, or the reader prefers reduced motion, the original instant behaviour runs.
//
// Techniques follow open patterns from the web platform docs and the community
// (View Transitions circular reveal, @starting-style sheets, spring linear()
// easing) and are implemented natively so the workspace stays build-free.

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const root = document.documentElement;
const calm = () => reduced.matches || document.hidden;
const canTransition = () => typeof document.startViewTransition === 'function';
const EASE_OUT = 'cubic-bezier(.16,1,.3,1)';
const EASE_IN = 'cubic-bezier(.4,0,.7,.4)';
const SPRING =
  'linear(0, 0.024, 0.083, 0.164, 0.254, 0.348, 0.44, 0.525, 0.604, 0.674, 0.735, 0.787, 0.832, 0.869, 0.899, 0.924, 0.944, 0.96, 0.972, 0.982, 0.989, 0.994, 0.998, 1, 1.002, 1.003, 1.004, 1.004, 1.004, 1.004, 1.003, 1.003, 1)';
const SNAP =
  'linear(0, 0.042, 0.147, 0.284, 0.432, 0.576, 0.706, 0.816, 0.903, 0.969, 1.016, 1.045, 1.062, 1.067, 1.066, 1.06, 1.051, 1.041, 1.031, 1.022, 1.014, 1.008, 1.003, 1, 0.997, 0.996, 0.996, 0.996, 0.996, 0.996, 0.997, 0.998, 1)';

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function settle(animation) {
  return animation.finished.then(
    () => animation.cancel(),
    () => {},
  );
}

/* ---------------------------------------------------------------------------
   View transitions
   ------------------------------------------------------------------------- */
let transitionSeq = 0;
const TRANSITION_CLASSES = ['m-vt-screen', 'm-vt-theme', 'm-vt-layered'];
function runTransition(classes, update, { onReady, still = false } = {}) {
  const token = ++transitionSeq;
  const masthead = document.querySelector('.app-top');
  // A new transition replaces the previous one; its names must not leak in.
  root.classList.remove(...TRANSITION_CLASSES);
  root.classList.add(...classes);
  masthead?.toggleAttribute('data-m-still', still);
  const cleanup = () => {
    if (token !== transitionSeq) return;
    root.classList.remove(...TRANSITION_CLASSES);
    masthead?.removeAttribute('data-m-still');
  };
  let transition;
  try {
    transition = document.startViewTransition(update);
  } catch {
    cleanup();
    update();
    return null;
  }
  transition.ready.then(onReady, () => {});
  transition.finished.then(cleanup, cleanup);
  return transition;
}

// Swap a top-level screen. Returns false when the caller should use its own
// fallback choreography (no API, reduced motion, hidden tab).
export function transitionScreen(update, { scrollAfter = 0, layered = false } = {}) {
  if (calm() || !canTransition()) return false;
  runTransition(layered ? ['m-vt-screen', 'm-vt-layered'] : ['m-vt-screen'], update, {
    // The masthead may only hold still when it sits at the same place before and after.
    still: scrollY < 1 && scrollAfter < 1,
  });
  return true;
}

// Reveal the next paper colour as a circle expanding from the switch.
export function transitionTheme(origin, update) {
  const icon = () => {
    if (calm()) return;
    const glyph = origin?.querySelector('svg');
    if (glyph)
      settle(
        glyph.animate(
          [
            { rotate: '-120deg', scale: 0.3, opacity: 0 },
            { rotate: '0deg', scale: 1, opacity: 1 },
          ],
          { duration: 720, easing: SNAP },
        ),
      );
  };
  const swap = () => {
    // Paint the new theme at once; colour transitions would muddy the reveal.
    root.classList.add('m-theme-swap');
    update();
    icon();
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('m-theme-swap')));
  };
  if (calm() || !canTransition() || !origin) return swap();
  const box = origin.getBoundingClientRect();
  const x = box.left + box.width / 2,
    y = box.top + box.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  runTransition(['m-vt-theme'], swap, {
    onReady() {
      root.animate(
        {
          clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`],
        },
        { duration: 820, easing: 'cubic-bezier(.65,0,.35,1)', pseudoElement: '::view-transition-new(root)' },
      );
    },
  });
}

/* ---------------------------------------------------------------------------
   Display headings develop like ink drawn across the page.
   ------------------------------------------------------------------------- */
const HEADINGS = '.panel-intro h1, .proof-head h2, .history-head h2, .studio-heading h1, .at-heading h1, .at-heading h2';
export function revealHeadings(scope, delay = 60) {
  if (calm() || !scope) return;
  const mask = 'linear-gradient(90deg, #000 34%, transparent 52%)';
  let order = 0;
  for (const heading of scope.querySelectorAll(HEADINGS)) {
    if (!heading.getClientRects().length) continue;
    const box = heading.getBoundingClientRect();
    if (box.bottom < 0 || box.top > innerHeight) continue;
    settle(
      heading.animate(
        [
          {
            maskImage: mask,
            maskSize: '300% 100%',
            maskRepeat: 'no-repeat',
            maskPosition: '100% 0',
            filter: 'blur(5px)',
            translate: '0 6px',
          },
          {
            maskImage: mask,
            maskSize: '300% 100%',
            maskRepeat: 'no-repeat',
            maskPosition: '0% 0',
            filter: 'blur(0px)',
            translate: '0 0',
          },
        ],
        { duration: 1100, delay: delay + order++ * 90, easing: EASE_OUT, fill: 'backwards' },
      ),
    );
  }
}

/* ---------------------------------------------------------------------------
   Dialog departures.
   Callers close and often remove dialogs synchronously, so the sheet that is
   seen leaving is a detached copy, drawn in the top layer for a few frames.
   ------------------------------------------------------------------------- */
const pendingExit = new WeakSet();
function ghostDialog(dialog) {
  if (
    calm() ||
    pendingExit.has(dialog) ||
    !dialog.open ||
    dialog.dataset.motion === 'none' ||
    dialog.classList.contains('m-ghost-sheet')
  )
    return;
  const box = dialog.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return;
  if (!(Number(getComputedStyle(dialog).opacity) > 0.02)) return;
  const nodes = dialog.getElementsByTagName('*');
  if (nodes.length > 6000 || dialog.querySelector('iframe, video')) return;

  const scrolls = [];
  if (dialog.scrollTop || dialog.scrollLeft) scrolls.push([-1, dialog.scrollTop, dialog.scrollLeft]);
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node.scrollTop || node.scrollLeft) scrolls.push([index, node.scrollTop, node.scrollLeft]);
  }
  const style = getComputedStyle(dialog);
  let veil = null;
  try {
    const backdrop = getComputedStyle(dialog, '::backdrop');
    veil = { background: backdrop.backgroundColor, filter: backdrop.backdropFilter };
  } catch {}
  const sheet = dialog.cloneNode(true);
  // Keep ids: sheets are styled through them, and the original stays first in
  // document order for getElementById during the brief overlap.
  sheet.classList.add('m-ghost-sheet');
  for (const radio of sheet.querySelectorAll('input[type="radio"][name]')) radio.name = 'm-ghost-' + radio.name;
  for (const [key, value] of [
    ['left', box.left + 'px'],
    ['top', box.top + 'px'],
    ['width', box.width + 'px'],
    ['height', box.height + 'px'],
    ['overflow', style.overflow],
  ])
    sheet.style.setProperty(key, value, 'important');
  // A sheet closed mid-entrance leaves from where it was, not from full ink.
  const from = Math.min(1, Number(style.opacity) || 0);
  const sourceCanvases = [...dialog.querySelectorAll('canvas')];
  const fullscreen = box.width >= innerWidth - 2 && box.height >= innerHeight - 2;
  pendingExit.add(dialog);
  const started = performance.now();

  // The closing work (removal, focus return, cleanup) runs before the next frame.
  requestAnimationFrame(() => {
    pendingExit.delete(dialog);
    if (dialog.open && dialog.isConnected) return; // cancelled, or reopened at once
    if (document.hidden || performance.now() - started > 250) return; // the moment has passed
    const host = make('div', 'm-ghost');
    host.setAttribute('aria-hidden', 'true');
    host.inert = true;
    const topLayer = typeof host.showPopover === 'function';
    if (topLayer) host.popover = 'manual';
    let underlay = null;
    let otherModal = false;
    try {
      otherModal = Boolean(document.querySelector('dialog:modal'));
    } catch {}
    if (veil && !otherModal && veil.background !== 'rgba(0, 0, 0, 0)') {
      underlay = make('div', 'm-ghost-backdrop');
      underlay.style.background = veil.background;
      if (veil.filter && veil.filter !== 'none') underlay.style.backdropFilter = veil.filter;
      host.append(underlay);
    }
    host.append(sheet);
    document.body.append(host);
    if (topLayer) {
      try {
        host.showPopover();
      } catch {}
    }
    const copies = sheet.querySelectorAll('canvas');
    sourceCanvases.forEach((source, index) => {
      const copy = copies[index];
      if (!copy || !source.width || !source.height) return;
      try {
        copy.width = source.width;
        copy.height = source.height;
        copy.getContext('2d')?.drawImage(source, 0, 0);
      } catch {}
    });
    const copiesAll = sheet.getElementsByTagName('*');
    for (const [index, top, left] of scrolls) {
      const node = index < 0 ? sheet : copiesAll[index];
      if (!node) continue;
      node.scrollTop = top;
      node.scrollLeft = left;
    }
    const leaving = sheet.animate(
      fullscreen
        ? [{ opacity: from }, { opacity: 0, scale: 0.992 }]
        : [
            { opacity: from, translate: '0 0', scale: 1, filter: 'blur(0px)' },
            { opacity: 0, translate: '0 12px', scale: 0.972, filter: 'blur(6px)' },
          ],
      { duration: fullscreen ? 240 : 280, easing: EASE_IN, fill: 'forwards' },
    );
    const fades = [leaving.finished];
    if (underlay)
      fades.push(
        underlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 340, easing: 'ease', fill: 'forwards' })
          .finished,
      );
    Promise.allSettled(fades).then(() => host.remove());
  });
}

const nativeClose = HTMLDialogElement.prototype.close;
HTMLDialogElement.prototype.close = function close(...args) {
  if (this.open) ghostDialog(this);
  return nativeClose.apply(this, args);
};
// Escape / requestClose() / <form method="dialog"> close without calling close().
document.addEventListener(
  'cancel',
  (event) => {
    if (event.target instanceof HTMLDialogElement) ghostDialog(event.target);
  },
  true,
);
document.addEventListener(
  'submit',
  (event) => {
    const form = event.target;
    if (form instanceof HTMLFormElement && form.method === 'dialog') {
      const dialog = form.closest('dialog');
      if (dialog) ghostDialog(dialog);
    }
  },
  true,
);

/* ---------------------------------------------------------------------------
   Floating panels that are not dialogs (e.g. the account sheet) leave in place.
   ------------------------------------------------------------------------- */
export function leave(node, { x = 16, y = 0 } = {}) {
  if (!node?.isConnected) return;
  if (calm() || !node.getClientRects().length) return node.remove();
  node.classList.add('m-leaving');
  node.inert = true;
  for (const named of [node, ...node.querySelectorAll('[id]')]) named.removeAttribute('id');
  const animation = node.animate(
    [
      { opacity: 1, translate: '0 0', filter: 'blur(0px)' },
      { opacity: 0, translate: `${x}px ${y}px`, filter: 'blur(5px)' },
    ],
    { duration: 260, easing: EASE_IN, fill: 'forwards' },
  );
  animation.finished.then(
    () => node.remove(),
    () => node.remove(),
  );
}

/* ---------------------------------------------------------------------------
   Toast
   ------------------------------------------------------------------------- */
export function mountToast(node) {
  let hideTimer = 0;
  let clearTimer = 0;
  function clear() {
    node.replaceChildren();
    delete node.dataset.state;
  }
  return function show(message, life = 3800) {
    clearTimeout(hideTimer);
    clearTimeout(clearTimer);
    const replacing = node.dataset.state === 'in';
    const mark = make('span', 'm-toast-mark');
    const label = make('span', 'm-toast-text', String(message));
    const time = make('i', 'm-toast-time');
    mark.setAttribute('aria-hidden', 'true');
    time.setAttribute('aria-hidden', 'true');
    node.style.setProperty('--m-toast-life', life + 'ms');
    node.replaceChildren(mark, label, time);
    if (replacing) {
      if (!calm()) {
        label.animate(
          [
            { opacity: 0, translate: '0 7px', filter: 'blur(3px)' },
            { opacity: 1, translate: '0 0', filter: 'blur(0px)' },
          ],
          { duration: 380, easing: EASE_OUT },
        );
        node.animate([{ scale: 1.04 }, { scale: 1 }], { duration: 560, easing: SNAP });
      }
    } else node.dataset.state = 'in';
    hideTimer = setTimeout(() => {
      if (calm()) return clear();
      node.dataset.state = 'out';
      clearTimer = setTimeout(clear, 300);
    }, life);
  };
}

/* ---------------------------------------------------------------------------
   Masthead ink rule
   ------------------------------------------------------------------------- */
function mountNavInk(nav) {
  if (!nav || nav.querySelector('.m-nav-ink')) return;
  const ink = make('i', 'm-nav-ink');
  ink.setAttribute('aria-hidden', 'true');
  ink.dataset.instant = '';
  nav.append(ink);
  nav.classList.add('m-has-ink');
  let frame = 0;
  function place() {
    frame = 0;
    const current = nav.querySelector('button[aria-current="page"]');
    if (!current || !nav.getClientRects().length || !current.getClientRects().length) {
      ink.style.opacity = '0';
      return;
    }
    const bounds = nav.getBoundingClientRect(),
      item = current.getBoundingClientRect();
    // A screen view transition morphs the rule itself, so the element jumps.
    if (root.classList.contains('m-vt-screen')) ink.dataset.instant = '';
    ink.style.setProperty('--m-ink-x', item.left - bounds.left + 'px');
    ink.style.setProperty('--m-ink-w', item.width + 'px');
    ink.style.opacity = '1';
    if (ink.hasAttribute('data-instant')) {
      ink.getBoundingClientRect();
      requestAnimationFrame(() => requestAnimationFrame(() => ink.removeAttribute('data-instant')));
    }
  }
  const queue = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };
  // Synchronous on navigation, so a view transition captures the final place.
  new MutationObserver(place).observe(nav, { attributes: true, subtree: true, attributeFilter: ['aria-current'] });
  new ResizeObserver(queue).observe(nav);
  document.fonts?.ready.then(queue);
  place();
}

/* ---------------------------------------------------------------------------
   Archive cards lean toward the pointer, with a soft highlight.
   ------------------------------------------------------------------------- */
function mountArchiveTilt(grid) {
  if (!grid) return;
  let active = null;
  let frame = 0;
  let last = null;
  function release() {
    active?.removeAttribute('data-m-tilt');
    active = null;
  }
  function apply() {
    frame = 0;
    if (!last) return;
    const { card, x, y } = last;
    if (card !== active) {
      release();
      active = card;
    }
    if (!card || !card.isConnected || card.dataset.imageState !== 'ready') return release();
    const box = card.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const px = Math.min(1, Math.max(0, (x - box.left) / box.width)),
      py = Math.min(1, Math.max(0, (y - box.top) / box.height));
    card.style.setProperty('--m-tilt-y', ((px - 0.5) * 7).toFixed(2) + 'deg');
    card.style.setProperty('--m-tilt-x', ((0.5 - py) * 7).toFixed(2) + 'deg');
    card.style.setProperty('--m-spot-x', (px * 100).toFixed(1) + '%');
    card.style.setProperty('--m-spot-y', (py * 100).toFixed(1) + '%');
    card.setAttribute('data-m-tilt', '');
  }
  grid.addEventListener(
    'pointermove',
    (event) => {
      if (event.pointerType !== 'mouse' || calm() || event.buttons) return release();
      last = { card: event.target.closest('.archive-card'), x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(apply);
    },
    { passive: true },
  );
  grid.addEventListener('pointerleave', () => {
    last = null;
    release();
  });
  grid.addEventListener('pointerdown', release, { passive: true });
  addEventListener('scroll', release, { passive: true });
}

/* ---------------------------------------------------------------------------
   Controls that are revealed later (hidden → shown) arrive instead of popping.
   ------------------------------------------------------------------------- */
const APPEAR_CHIP = [
  '.proof-utilities > *',
  '#cancel',
  '#archive-search-clear',
  '.pa-inline-cost',
  '#proof-actions .pa-button',
].join(',');
const APPEAR_BLOCK = ['#ink-palette', '.history-undo', '.ap-relay', '.ap-delete-line', '.pt-merge-dock'].join(',');
function mountAppear() {
  const seen = new WeakSet();
  new MutationObserver((records) => {
    if (calm()) return;
    for (const record of records) {
      const node = record.target;
      if (record.oldValue === null || node.hidden || seen.has(node)) continue;
      const chip = node.matches(APPEAR_CHIP);
      if (!chip && !node.matches(APPEAR_BLOCK)) continue;
      if (!node.getClientRects().length) continue;
      seen.add(node);
      const animation = node.animate(
        chip
          ? [
              { opacity: 0, scale: 0.82, filter: 'blur(3px)' },
              { opacity: 1, scale: 1, filter: 'blur(0px)' },
            ]
          : [
              { opacity: 0, translate: '0 -6px', filter: 'blur(4px)' },
              { opacity: 1, translate: '0 0', filter: 'blur(0px)' },
            ],
        { duration: chip ? 520 : 460, easing: chip ? SNAP : EASE_OUT },
      );
      animation.finished.then(
        () => seen.delete(node),
        () => seen.delete(node),
      );
    }
  }).observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden'],
    attributeOldValue: true,
  });
}

/* ---------------------------------------------------------------------------
   Tooltip. Native title bubbles are slow, unstyled and ignore the theme; the
   title is lifted off while the pointer or focus rests and put back after.
   ------------------------------------------------------------------------- */
const SHORTCUT = /^(.*?)\s*[（(]([A-Za-z0-9+⌘⇧ ]{1,16})[)）]\s*$/;
function mountTooltips() {
  const tip = make('div', 'm-tip');
  tip.setAttribute('role', 'tooltip');
  tip.id = 'm-tip';
  const topLayer = typeof tip.showPopover === 'function';
  if (topLayer) tip.popover = 'manual';
  else tip.hidden = true;
  document.body.append(tip);
  let owner = null;
  let saved = '';
  let timer = 0;
  let outTimer = 0;
  let warmUntil = 0;
  let visible = false;
  const watch = new MutationObserver(() => {
    if (!owner) return;
    const next = owner.getAttribute('title');
    if (next == null) return;
    saved = next;
    owner.removeAttribute('title');
    if (visible) paint();
  });
  const accept = (node) => {
    const element = node instanceof Element ? node.closest('[title]') : null;
    if (
      !element ||
      element === tip ||
      element.matches('input, textarea, select, option, iframe, dialog, html, body, svg *') ||
      !element.getAttribute('title').trim()
    )
      return null;
    return element;
  };
  // Skip labels that merely repeat fully visible text.
  function redundant() {
    const text = owner.textContent.replace(/\s+/g, ' ').trim();
    if (text !== saved.replace(/\s+/g, ' ').trim()) return false;
    return ![owner, ...owner.querySelectorAll('*')].some((node) => node.scrollWidth > node.clientWidth + 1);
  }
  function paint() {
    const match = saved.match(SHORTCUT);
    if (match) tip.replaceChildren(document.createTextNode(match[1]), make('kbd', '', match[2].trim()));
    else tip.textContent = saved;
    place();
  }
  function place() {
    if (!owner?.isConnected) return hide();
    const box = owner.getBoundingClientRect();
    const width = tip.offsetWidth,
      height = tip.offsetHeight;
    const above = box.top - height - 9 > 8 && box.top > 90;
    const y = above ? box.top - height - 8 : Math.min(innerHeight - height - 8, box.bottom + 8);
    const x = Math.min(innerWidth - width - 8, Math.max(8, box.left + box.width / 2 - width / 2));
    tip.style.setProperty('--m-tip-x', Math.round(x) + 'px');
    tip.style.setProperty('--m-tip-y', Math.round(y) + 'px');
    tip.style.setProperty('--m-tip-lift', above ? '5px' : '-5px');
  }
  function close() {
    delete tip.dataset.state;
    if (!topLayer) tip.hidden = true;
    else if (tip.matches(':popover-open')) tip.hidePopover();
  }
  function show() {
    timer = 0;
    if (!owner?.isConnected || redundant()) return;
    clearTimeout(outTimer);
    if (!topLayer) tip.hidden = false;
    else {
      // Re-enter the top layer so the label sits above a sheet opened meanwhile.
      if (tip.matches(':popover-open')) tip.hidePopover();
      tip.showPopover();
    }
    paint();
    delete tip.dataset.state;
    tip.getBoundingClientRect();
    tip.dataset.state = 'in';
    owner.setAttribute('aria-describedby', tip.id);
    visible = true;
  }
  function hide() {
    clearTimeout(timer);
    timer = 0;
    if (!visible) return;
    visible = false;
    warmUntil = performance.now() + 500;
    if (owner?.getAttribute('aria-describedby') === tip.id) owner.removeAttribute('aria-describedby');
    if (calm()) return close();
    tip.dataset.state = 'out';
    outTimer = setTimeout(close, 140);
  }
  function release() {
    hide();
    watch.disconnect();
    if (owner && !owner.hasAttribute('title')) owner.setAttribute('title', saved);
    owner = null;
    saved = '';
  }
  function engage(element, delay) {
    if (element === owner) return;
    release();
    if (!element) return;
    owner = element;
    saved = element.getAttribute('title');
    element.removeAttribute('title');
    watch.observe(element, { attributes: true, attributeFilter: ['title'] });
    timer = setTimeout(show, performance.now() < warmUntil ? 60 : delay);
  }
  document.addEventListener(
    'pointerover',
    (event) => {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      // The owner's own title is lifted off, so moving within it keeps the label.
      if (owner && event.target instanceof Node && owner.contains(event.target)) return;
      engage(accept(event.target), 420);
    },
    true,
  );
  document.addEventListener(
    'pointerout',
    (event) => {
      if (owner && !(event.relatedTarget instanceof Node && owner.contains(event.relatedTarget))) release();
    },
    true,
  );
  document.addEventListener(
    'focusin',
    (event) => {
      const element = accept(event.target);
      if (element && element.matches(':focus-visible')) engage(element, 260);
    },
    true,
  );
  document.addEventListener('focusout', (event) => event.target === owner && release(), true);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', (event) => event.key === 'Escape' && hide(), true);
  addEventListener('scroll', hide, { passive: true, capture: true });
  addEventListener('blur', release);
}

/* ---------------------------------------------------------------------------
   Mount
   ------------------------------------------------------------------------- */
function mount() {
  mountNavInk(document.querySelector('.app-top nav'));
  mountArchiveTilt(document.getElementById('archive-grid'));
  mountAppear();
  mountTooltips();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();

export { SPRING, SNAP, EASE_OUT, EASE_IN };
