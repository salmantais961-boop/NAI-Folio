// Natural-ratio masonry. DOM order follows the gallery's current search and rating order.
// Geometry is computed only on changes; FLIP never runs a JavaScript frame loop.
export function mountArchiveLayout(grid) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const originals = new Map();
  const motions = new Map();
  const decoded = new WeakMap();
  const images = new Map();
  const originalHeight = grid.style.height;
  const originalPosition = grid.style.position;
  let previous = new Map();
  let frame = 0;
  let destroyed = false;
  let visible = false;
  let previousWidth = 0;
  let previousColumns = 0;
  let previousGap = 0;
  let observedWidth = -1;

  function inViewport(card) {
    if (document.hidden || !card.isConnected || !grid.getClientRects().length) return false;
    const bounds = card.getBoundingClientRect();
    return (
      bounds.width > 0 &&
      bounds.height > 0 &&
      bounds.bottom > 0 &&
      bounds.top < innerHeight &&
      bounds.right > 0 &&
      bounds.left < innerWidth
    );
  }

  function releaseImage(state) {
    state.ticket++;
    state.visible = false;
    state.enter?.cancel();
    state.enter = null;
    state.image.removeAttribute('src');
    state.card.dataset.imageState = 'idle';
    state.card.removeAttribute('aria-busy');
  }

  function forgetImage(card) {
    const state = images.get(card);
    if (!state) return;
    imageObserver.unobserve(card);
    releaseImage(state);
    state.events.abort();
    delete card.dataset.imageState;
    images.delete(card);
  }

  function enterImage(state, order = 0) {
    if (state.visible || !inViewport(state.card)) return;
    state.visible = true;
    state.ticket++;
    state.order = order;
    state.card.dataset.imageState = 'loading';
    state.card.setAttribute('aria-busy', 'true');
    // Native lazy loading prefetches outside the viewport. We assign the source
    // only after intersection, so eager decoding here cannot preload other cards.
    state.image.loading = 'eager';
    try {
      state.image.src = state.getURL();
    } catch {
      state.card.dataset.imageState = 'error';
      state.card.removeAttribute('aria-busy');
    }
  }

  const imageObserver = new IntersectionObserver(
    (entries) => {
      let order = 0;
      for (const entry of entries) {
        const state = images.get(entry.target);
        if (!state) continue;
        if (entry.isIntersecting && entry.intersectionRatio > 0 && inViewport(state.card))
          enterImage(state, order++);
        else if (state.visible) releaseImage(state);
      }
    },
    { rootMargin: '0px', threshold: 0 },
  );

  function registerImage(card, image, getURL) {
    forgetImage(card);
    image.removeAttribute('src');
    const state = {
      card,
      image,
      getURL,
      visible: false,
      observed: false,
      ticket: 0,
      enter: null,
      events: new AbortController(),
    };
    images.set(card, state);
    card.dataset.imageState = 'idle';
    image.addEventListener(
      'load',
      async () => {
        const ticket = state.ticket;
        if (!state.visible || !image.naturalWidth) return;
        // Remember the actual ratio before releasing a decoded image off-screen.
        card.dataset.width = image.naturalWidth;
        card.dataset.height = image.naturalHeight;
        schedule();
        try {
          await image.decode();
        } catch {
          /* A decoded load event is sufficient. */
        }
        if (destroyed || ticket !== state.ticket || !state.visible || !inViewport(card)) return;
        card.dataset.imageState = 'ready';
        card.removeAttribute('aria-busy');
        if (!reduced.matches) {
          state.enter?.cancel();
          const target = card.querySelector('.archive-open') || image;
          const enter = target.animate(
            [
              { opacity: 0, transform: 'translate3d(0, 20px, 0) scale(.985)' },
              { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
            ],
            {
              duration: 540,
              delay: Math.min(state.order, 5) * 24,
              easing: 'cubic-bezier(.2,.75,.2,1)',
              fill: 'backwards',
            },
          );
          state.enter = enter;
          enter.onfinish = () => {
            if (state.enter === enter) state.enter = null;
          };
        }
      },
      { signal: state.events.signal },
    );
    image.addEventListener(
      'error',
      () => {
        if (!state.visible || !image.hasAttribute('src')) return;
        card.dataset.imageState = 'error';
        card.removeAttribute('aria-busy');
      },
      { signal: state.events.signal },
    );
    schedule();
  }

  function syncImages(cards) {
    const live = new Set(cards);
    for (const [card, state] of images) {
      if (!live.has(card)) {
        forgetImage(card);
        continue;
      }
      // Observe only once the masonry positions exist, never while all newly
      // inserted cards temporarily overlap at the grid's origin.
      if (!state.observed) {
        imageObserver.observe(card);
        state.observed = true;
      }
    }
  }

  function suspendImages() {
    for (const state of images.values()) {
      if (state.visible) releaseImage(state);
      imageObserver.unobserve(state.card);
      state.observed = false;
    }
  }

  if (getComputedStyle(grid).position === 'static') grid.style.position = 'relative';

  function schedule() {
    if (!destroyed && !frame && !document.hidden) frame = requestAnimationFrame(layout);
  }

  function stopMotions() {
    for (const { animation } of motions.values()) animation.cancel();
    motions.clear();
  }

  function imageSize(card) {
    const image = card.querySelector('img');
    const usable = (w, h) => Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
    let width = Number(card.dataset.width);
    let height = Number(card.dataset.height);
    if (image?.naturalWidth && image.naturalHeight) {
      width = image.naturalWidth;
      height = image.naturalHeight;
      if (card.dataset.width !== String(width)) card.dataset.width = width;
      if (card.dataset.height !== String(height)) card.dataset.height = height;
      // Decode only already-loaded images, leaving lazy loading to the browser.
      const source = image.currentSrc || image.src;
      if (image.decode && decoded.get(image) !== source) {
        decoded.set(image, source);
        image.decode().then(schedule, schedule);
      }
    } else if (!usable(width, height) && image) {
      width = Number(image.getAttribute('width'));
      height = Number(image.getAttribute('height'));
    }
    const known = usable(width, height);
    if (!known) [width, height] = [3, 4];
    if (image) {
      // Intrinsic attributes reserve the complete image before its pixels arrive.
      // Never write fallback dimensions into card data: real metadata can arrive later.
      if (image.getAttribute('width') !== String(width)) image.setAttribute('width', width);
      if (image.getAttribute('height') !== String(height)) image.setAttribute('height', height);
    }
    return { width, height };
  }

  function layout() {
    frame = 0;
    if (destroyed) return;
    if (!grid.isConnected || !grid.getClientRects().length || grid.clientWidth <= 0) {
      visible = false;
      stopMotions();
      suspendImages();
      return;
    }
    const styles = getComputedStyle(grid);
    if (styles.visibility === 'hidden') {
      visible = false;
      stopMotions();
      suspendImages();
      return;
    }
    const number = (value) => Number.parseFloat(value) || 0;
    const paddingLeft = number(styles.paddingLeft);
    const paddingRight = number(styles.paddingRight);
    const paddingTop = number(styles.paddingTop);
    const paddingBottom = number(styles.paddingBottom);
    const width = grid.clientWidth - paddingLeft - paddingRight;
    if (width <= 0) return;
    const rawGap = Number.parseFloat(styles.getPropertyValue('--archive-gap'));
    const gap = Math.max(0, Number.isFinite(rawGap) ? rawGap : 4);
    const configuredColumns = Number.parseInt(styles.getPropertyValue('--archive-columns'), 10);
    const fallbackColumns = width < 600 ? 2 : Math.floor((width + gap) / (240 + gap));
    const columns = Math.max(
      1,
      Math.min(configuredColumns || fallbackColumns || 1, 12, Math.floor((width + gap) / (20 + gap))),
    );
    const columnWidth = (width - (columns - 1) * gap) / columns;
    const cards = [...grid.children].filter((child) => child.matches('article.archive-card'));
    const cardSet = new Set(cards);
    const animate =
      visible &&
      !reduced.matches &&
      Math.abs(previousWidth - width) < 0.5 &&
      previousColumns === columns &&
      previousGap === gap;

    // Read interrupted animations before canceling; rapid delete/undo begins where
    // each card is currently displayed, even if renderArchive replaced its DOM node.
    const offsets = new Map();
    for (const [card, motion] of motions) {
      const progress = motion.animation.effect?.getComputedTiming().progress ?? 1;
      offsets.set(card, { x: motion.x * (1 - progress), y: motion.y * (1 - progress) });
    }
    stopMotions();
    for (const [card, original] of originals) {
      if (!cardSet.has(card)) {
        Object.assign(card.style, original);
        originals.delete(card);
      }
    }
    if (!cards.length) {
      syncImages(cards);
      grid.style.height = originalHeight;
      previous.clear();
      visible = true;
      previousWidth = width;
      previousColumns = columns;
      previousGap = gap;
      return;
    }

    // Batch all width/attribute writes before reading natural block heights.
    const items = cards.map((card) => {
      const size = imageSize(card);
      if (!originals.has(card)) {
        originals.set(card, {
          position: card.style.position,
          width: card.style.width,
          left: card.style.left,
          top: card.style.top,
        });
      }
      card.style.position = 'absolute';
      card.style.width = `${columnWidth}px`;
      return { card, size, key: card.dataset.workId || card };
    });
    for (const item of items) {
      const computed = getComputedStyle(item.card);
      const extras =
        computed.boxSizing === 'border-box'
          ? 0
          : number(computed.paddingTop) +
            number(computed.paddingBottom) +
            number(computed.borderTopWidth) +
            number(computed.borderBottomWidth);
      item.height = number(computed.height) + extras || (columnWidth * item.size.height) / item.size.width;
    }

    const bottoms = Array(columns).fill(0);
    const next = new Map();
    for (const { card, key, height } of items) {
      let column = 0;
      for (let candidate = 1; candidate < columns; candidate++) {
        if (bottoms[candidate] < bottoms[column]) column = candidate;
      }
      const left = paddingLeft + column * (columnWidth + gap);
      const top = paddingTop + bottoms[column];
      const old = previous.get(key);
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
      bottoms[column] += height + gap;
      next.set(key, { card, left, top });
      if (animate && old && card.animate) {
        const offset = offsets.get(old.card);
        const x = old.left + (offset?.x || 0) - left;
        const y = old.top + (offset?.y || 0) - top;
        if (Math.abs(x) > 0.5 || Math.abs(y) > 0.5) {
          const animation = card.animate([{ translate: `${x}px ${y}px` }, { translate: '0px 0px' }], {
            duration: 280,
            easing: 'cubic-bezier(.22,.61,.36,1)',
          });
          motions.set(card, { animation, x, y });
          animation.onfinish = () => {
            if (motions.get(card)?.animation === animation) motions.delete(card);
          };
        }
      }
    }
    const contentHeight = Math.max(...bottoms) - gap;
    const boxExtras =
      styles.boxSizing === 'border-box'
        ? paddingTop + paddingBottom + number(styles.borderTopWidth) + number(styles.borderBottomWidth)
        : 0;
    grid.style.height = `${Math.max(0, contentHeight) + boxExtras}px`;
    previous = next;
    previousWidth = width;
    previousColumns = columns;
    previousGap = gap;
    visible = true;
    syncImages(cards);
  }

  const resize = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? 0;
    if (Math.abs(width - observedWidth) > 0.1) {
      observedWidth = width;
      schedule();
    }
  });
  resize.observe(grid);
  const children = new MutationObserver(schedule);
  children.observe(grid, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'data-width', 'data-height', 'data-work-id'],
  });
  const visibility = new MutationObserver(schedule);
  for (let ancestor = grid.parentElement; ancestor; ancestor = ancestor.parentElement) {
    visibility.observe(ancestor, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
  }
  function pageVisibility() {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
      stopMotions();
      suspendImages();
      visible = false;
    } else schedule();
  }
  function motionPreference() {
    if (reduced.matches) {
      stopMotions();
      for (const state of images.values()) {
        state.enter?.cancel();
        state.enter = null;
      }
    }
    schedule();
  }
  grid.addEventListener('load', schedule, true);
  grid.addEventListener('error', schedule, true);
  document.addEventListener('visibilitychange', pageVisibility);
  window.addEventListener('resize', schedule, { passive: true });
  reduced.addEventListener('change', motionPreference);
  schedule();

  return {
    refresh: schedule,
    registerImage,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      stopMotions();
      for (const card of images.keys()) forgetImage(card);
      imageObserver.disconnect();
      resize.disconnect();
      children.disconnect();
      visibility.disconnect();
      grid.removeEventListener('load', schedule, true);
      grid.removeEventListener('error', schedule, true);
      document.removeEventListener('visibilitychange', pageVisibility);
      window.removeEventListener('resize', schedule);
      reduced.removeEventListener('change', motionPreference);
      for (const [card, original] of originals) Object.assign(card.style, original);
      originals.clear();
      previous.clear();
      grid.style.height = originalHeight;
      grid.style.position = originalPosition;
    },
  };
}
