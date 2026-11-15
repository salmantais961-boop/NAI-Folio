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
const TRANSITION_CLASSES = ['m-vt-screen', 'm-vt-theme', 'm-vt-layered', 'm-vt-reveal'];
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

// The next view grows as a circle from the control that asked for it, exactly
// like the paper-colour switch. `within` bounds the circle (and so its pace)
// to the region that actually changes; the rest of the page is identical.
export function transitionReveal(origin, update, { within = null, duration = 680 } = {}) {
  if (calm() || !canTransition() || !origin?.isConnected) return update();
  const box = origin.getBoundingClientRect();
  const x = box.left + box.width / 2,
    y = box.top + box.height / 2;
  const area = within?.getBoundingClientRect() || { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const radius = Math.hypot(Math.max(x - area.left, area.right - x), Math.max(y - area.top, area.bottom - y));
  let result;
  const transition = runTransition(['m-vt-reveal'], () => (result = update()), {
    onReady() {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration, easing: 'cubic-bezier(.65,0,.35,1)', pseudoElement: '::view-transition-new(root)' },
      );
    },
  });
  return transition ? transition.updateCallbackDone.then(() => result) : result;
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
  let order = 0;
  for (const heading of scope.querySelectorAll(HEADINGS)) {
    if (!heading.getClientRects().length) continue;
    const box = heading.getBoundingClientRect();
    if (box.bottom < 0 || box.top > innerHeight) continue;
    // Italic display glyphs paint outside their line boxes. A CSS mask clips
    // those overhangs until it is removed, causing the visible end-of-swap pop.
    // Fade the ink itself without a mask or temporary layout measurements.
    for (const animation of heading.getAnimations())
      if (animation.id === 'folio-heading') animation.cancel();
    const animation = heading.animate(
      [{ opacity: 0, translate: '0 4px' }, { opacity: 1, translate: '0 0' }],
      { duration: 680, delay: delay + order++ * 70, easing: EASE_OUT, fill: 'backwards' },
    );
    animation.id = 'folio-heading';
    settle(animation);
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
  for (const select of sheet.querySelectorAll('select')) select.setAttribute('data-native-select', '');
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
   Presence. Everything the interface reveals or withdraws through `hidden`
   arrives and leaves instead of popping. Blocks in a vertical flow also
   open and close by height, so their neighbours slide rather than jump.

   The `hidden` setter is observed (every caller in Folio uses the property),
   and the decision is taken once per frame: a node hidden and shown again in
   the same task never animates. Leaving content is drawn by a short-lived
   sibling copy, so callers keep their synchronous hide-and-measure logic.
   ------------------------------------------------------------------------- */
// Containers whose children are positioned or observed by their own motion.
const PRESENCE_SKIP = [
  '[data-motion="none"]',
  '.m-ghost',
  '.m-exit-ghost',
  '.m-spacer',
  '#archive-grid',
  '.cat-grid',
  '.at-grid',
  '.history-panel',
  '.pv-window',
  '.pv-dialog',
  '.lc-canvas',
  '.lc-world',
  '.cover',
  'canvas',
].join(',');
const PRESENCE_SELF_SKIP =
  'main, #app, #studio, #archive, #atlas, #lab, #desktop-agent, #block-library-slot, img, video, dialog, [popover]';
const presence = new Map();
const manualPresence = new WeakSet();
let presenceFrame = 0;
let exitBudget = 0;

function presenceAllowed(node) {
  return !(node.matches(PRESENCE_SELF_SKIP) || node.closest(PRESENCE_SKIP));
}
function flowAxis(node) {
  const parent = node.parentElement;
  if (!parent) return null;
  const style = getComputedStyle(parent);
  const display = style.display;
  if (display === 'block' || display === 'flow-root' || display === 'list-item') return 'block';
  if ((display === 'flex' || display === 'inline-flex') && style.flexDirection.startsWith('column')) return 'block';
  if (display === 'grid' && style.gridTemplateColumns.split(' ').length === 1) return 'block';
  return null;
}
function isBlockPresence(node, rect, axis) {
  if (axis !== 'block') return false;
  const parent = node.parentElement.getBoundingClientRect();
  return rect.width >= parent.width * 0.6 && rect.height <= innerHeight * 0.6;
}
function onScreen(rect) {
  return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
}

function snapshotExit(node) {
  if (exitBudget > 10 || !node.isConnected || !presenceAllowed(node)) return null;
  const rect = node.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2 || !onScreen(rect)) return null;
  if (rect.width * rect.height > innerWidth * innerHeight * 0.35) return null;
  if (node.getElementsByTagName('*').length > 300) return null;
  const style = getComputedStyle(node);
  if (style.display === 'contents' || Number(style.opacity) < 0.05) return null;
  exitBudget++;
  const fixed = style.position === 'fixed';
  const holder = fixed ? null : node.offsetParent;
  let left = rect.left,
    top = rect.top;
  if (holder) {
    const box = holder.getBoundingClientRect();
    left = rect.left - box.left - holder.clientLeft + holder.scrollLeft;
    top = rect.top - box.top - holder.clientTop + holder.scrollTop;
  }
  const axis = fixed || style.position === 'absolute' ? null : flowAxis(node);
  const copy = node.cloneNode(true);
  for (const select of copy.querySelectorAll('select')) select.setAttribute('data-native-select', '');
  for (const radio of copy.querySelectorAll('input[type="radio"][name]')) radio.name = 'm-ghost-' + radio.name;
  return {
    copy,
    rect,
    left,
    top,
    fixed: fixed || !holder,
    block: isBlockPresence(node, rect, axis),
    margins: [parseFloat(style.marginTop) || 0, parseFloat(style.marginBottom) || 0],
    parent: node.parentNode,
  };
}

function playExit(node, shot) {
  const parent = node.parentNode === shot.parent ? shot.parent : null;
  if (!parent || !parent.isConnected) return;
  const after = node.nextSibling;
  const ghost = shot.copy;
  ghost.classList.add('m-exit-ghost');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  for (const [key, value] of [
    ['position', shot.fixed ? 'fixed' : 'absolute'],
    ['left', (shot.fixed ? shot.rect.left : shot.left) + 'px'],
    ['top', (shot.fixed ? shot.rect.top : shot.top) + 'px'],
    ['right', 'auto'],
    ['bottom', 'auto'],
    ['width', shot.rect.width + 'px'],
    ['height', shot.rect.height + 'px'],
    ['margin', '0'],
    ['box-sizing', 'border-box'],
    ['transition', 'none'],
    ['pointer-events', 'none'],
  ])
    ghost.style.setProperty(key, value, 'important');
  parent.insertBefore(ghost, after);
  if (shot.block) {
    // Hold the vacated space and let it close, so what follows slides up.
    const spacer = make('div', 'm-spacer');
    spacer.setAttribute('aria-hidden', 'true');
    parent.insertBefore(spacer, ghost);
    const [mt, mb] = shot.margins;
    spacer
      .animate(
        [
          { height: shot.rect.height + 'px', marginTop: mt + 'px', marginBottom: mb + 'px' },
          { height: '0px', marginTop: '0px', marginBottom: '0px' },
        ],
        { duration: 380, easing: EASE_OUT, fill: 'forwards' },
      )
      .finished.then(
        () => spacer.remove(),
        () => spacer.remove(),
      );
  }
  const small = shot.rect.width < 220 && shot.rect.height < 90;
  ghost
    .animate(
      small
        ? [
            { opacity: 1, scale: 1, filter: 'blur(0px)' },
            { opacity: 0, scale: 0.86, filter: 'blur(3px)' },
          ]
        : [
            { opacity: 1, translate: '0 0', filter: 'blur(0px)' },
            { opacity: 0, translate: shot.block ? '0 -6px' : '0 4px', filter: 'blur(4px)' },
          ],
      { duration: small ? 200 : 260, easing: EASE_IN, fill: 'forwards' },
    )
    .finished.then(
      () => ghost.remove(),
      () => ghost.remove(),
    );
}

function playEnter(node) {
  if (!node.isConnected || !presenceAllowed(node)) return;
  if (node.getAnimations().some((animation) => animation.playState === 'running')) return;
  const rect = node.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2 || !onScreen(rect)) return;
  if (rect.width * rect.height > innerWidth * innerHeight * 0.35) {
    node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
    return;
  }
  const style = getComputedStyle(node);
  if (style.display === 'contents') return;
  const inFlow = style.position === 'static' || style.position === 'relative' || style.position === 'sticky';
  if (inFlow && isBlockPresence(node, rect, flowAxis(node))) {
    node.animate(
      [
        {
          height: '0px',
          paddingTop: '0px',
          paddingBottom: '0px',
          marginTop: '0px',
          marginBottom: '0px',
          overflow: 'clip',
        },
        {
          height: rect.height + 'px',
          paddingTop: style.paddingTop,
          paddingBottom: style.paddingBottom,
          marginTop: style.marginTop,
          marginBottom: style.marginBottom,
          overflow: 'clip',
        },
      ],
      { duration: 460, easing: SPRING },
    );
    node.animate(
      [
        { opacity: 0, translate: '0 -6px', filter: 'blur(4px)' },
        { opacity: 1, translate: '0 0', filter: 'blur(0px)' },
      ],
      { duration: 420, delay: 60, easing: EASE_OUT, fill: 'backwards' },
    );
    return;
  }
  const small = rect.width < 220 && rect.height < 90;
  node.animate(
    small
      ? [
          { opacity: 0, scale: 0.82, filter: 'blur(3px)' },
          { opacity: 1, scale: 1, filter: 'blur(0px)' },
        ]
      : [
          { opacity: 0, translate: '0 6px', scale: 0.985, filter: 'blur(4px)' },
          { opacity: 1, translate: '0 0', scale: 1, filter: 'blur(0px)' },
        ],
    { duration: small ? 520 : 460, easing: small ? SNAP : EASE_OUT },
  );
}

function flushPresence() {
  presenceFrame = 0;
  exitBudget = 0;
  const batch = [...presence];
  presence.clear();
  if (calm()) return;
  // Exits first: their copies are placed against the layout callers left.
  for (const [node, entry] of batch) if (!entry.wasHidden && node.hidden && entry.shot) playExit(node, entry.shot);
  for (const [node, entry] of batch) if (entry.wasHidden && !node.hidden) playEnter(node);
}

function mountPresence() {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'hidden');
  if (!descriptor?.set || !descriptor.get) return;
  Object.defineProperty(HTMLElement.prototype, 'hidden', {
    ...descriptor,
    set(value) {
      const was = descriptor.get.call(this) === true;
      const next = Boolean(value);
      // The first render settles silently; the entrance choreography covers it.
      if (
        was !== next &&
        this.isConnected &&
        !manualPresence.has(this) &&
        !presence.has(this) &&
        performance.now() > 900 &&
        !calm()
      ) {
        presence.set(this, { wasHidden: was, shot: was ? null : snapshotExit(this) });
        if (!presenceFrame) presenceFrame = requestAnimationFrame(flushPresence);
      }
      descriptor.set.call(this, value);
    },
  });
}

// Explicit forms for callers that move a node while showing or hiding it.
export function reveal(node) {
  manualPresence.add(node);
  node.hidden = false;
  manualPresence.delete(node);
  if (!calm()) playEnter(node);
}
export function conceal(node) {
  const shot = calm() || node.hidden ? null : (exitBudget = 0, snapshotExit(node));
  manualPresence.add(node);
  node.hidden = true;
  manualPresence.delete(node);
  if (shot) playExit(node, shot);
}

/* ---------------------------------------------------------------------------
   Floating layers appended to <body> (suggestion lists, pickers) fade out
   instead of vanishing when they are removed.
   ------------------------------------------------------------------------- */
function mountFloatingExit() {
  const nativeRemove = Element.prototype.remove;
  Element.prototype.remove = function remove() {
    if (
      this instanceof HTMLElement &&
      this.parentNode === document.body &&
      !calm() &&
      !this.classList.contains('m-tip') &&
      !this.classList.contains('m-leaving') &&
      presenceAllowed(this)
    ) {
      const style = getComputedStyle(this);
      const rect = this.getBoundingClientRect();
      if (
        (style.position === 'fixed' || style.position === 'absolute') &&
        rect.width > 2 &&
        rect.height > 2 &&
        Number(style.opacity) > 0.05
      ) {
        const ghost = this.cloneNode(true);
        for (const select of ghost.querySelectorAll('select')) select.setAttribute('data-native-select', '');
        ghost.classList.add('m-exit-ghost');
        ghost.removeAttribute('id');
        ghost.setAttribute('aria-hidden', 'true');
        ghost.inert = true;
        for (const [key, value] of [
          ['position', 'fixed'],
          ['left', rect.left + 'px'],
          ['top', rect.top + 'px'],
          ['right', 'auto'],
          ['bottom', 'auto'],
          ['width', rect.width + 'px'],
          ['height', rect.height + 'px'],
          ['margin', '0'],
          ['box-sizing', 'border-box'],
          ['transition', 'none'],
          ['animation', 'none'],
          ['pointer-events', 'none'],
        ])
          ghost.style.setProperty(key, value, 'important');
        this.after(ghost);
        ghost
          .animate(
            [
              { opacity: 1, translate: '0 0', scale: 1 },
              { opacity: 0, translate: '0 -4px', scale: 0.97 },
            ],
            { duration: 180, easing: EASE_IN, fill: 'forwards' },
          )
          .finished.then(
            () => nativeRemove.call(ghost),
            () => nativeRemove.call(ghost),
          );
      }
    }
    return nativeRemove.call(this);
  };
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
  mountPresence();
  mountFloatingExit();
  mountTooltips();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();

export { SPRING, SNAP, EASE_OUT, EASE_IN };
