import { fadeRemovedTile } from './image-removal.js';

// Lay out the complete archive from metadata so the scrollbar represents the
// whole collection. Only cards near the viewport need DOM nodes or listeners.
export function mountArchiveLayout(grid, { createCard, updateCard, getURL, onUnmount }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const measured = new WeakMap();
  const mounted = new Map();
  const departures = new Map();
  const originalHeight = grid.style.height;
  let works = [], lanes = [], places = new Map();
  let dirty = true, gridWidth = 0, frame = 0, active = null, destroyed = false;
  let reflowAfterDelete = false, heightMotion = null;
  const reflowTiming = { duration: 310, easing: 'cubic-bezier(.22,.61,.36,1)' };

  function schedule() {
    if (!destroyed && !frame && !document.hidden) frame = requestAnimationFrame(paint);
  }

  function release(state) {
    if (active === state.job) active = null;
    state.job = null;
    state.enter?.cancel();
    state.enter = null;
    if (state.image.hasAttribute('src')) state.image.removeAttribute('src');
    state.card.dataset.imageState = 'idle';
    state.card.removeAttribute('aria-busy');
  }

  function unmount(state) {
    onUnmount?.(state.card);
    release(state);
    state.flip?.animation.cancel();
    state.card.remove();
    mounted.delete(state.work.id);
  }

  function finishDeparture(id) {
    const exit = departures.get(id);
    if (!exit) return;
    departures.delete(id);
    exit.fade.cancel();
    onUnmount?.(exit.state.card);
    release(exit.state);
    exit.state.card.remove();
  }

  // Transfer the actual card out of the virtualizer only after the database
  // deletion succeeds. Its decoded image and red confirmation stay in place.
  function depart(id) {
    const state = mounted.get(id);
    if (!state || reduced.matches || document.hidden || !onScreen(state.card)) return false;
    const { card, place, flip } = state;
    const remaining = 1 - (flip?.animation.effect.getComputedTiming().progress ?? 1);
    mounted.delete(id);
    if (state.job && active === state.job) active = null;
    state.job = null;
    state.enter?.cancel();
    flip?.animation.cancel();
    card.style.left = place.left + (flip?.x || 0) * remaining + 'px';
    card.style.top = place.top + (flip?.y || 0) * remaining + 'px';
    card.inert = true;
    card.setAttribute('aria-hidden', 'true');
    card.dataset.departing = '';
    grid.append(card);
    const fade = fadeRemovedTile(card);
    departures.set(id, { state, fade });
    fade.onfinish = () => {
      if (departures.get(id)?.fade === fade) finishDeparture(id);
    };
    reflowAfterDelete = true;
    return true;
  }

  function stopDepartures() {
    for (const id of departures.keys()) finishDeparture(id);
    heightMotion?.cancel();
    heightMotion = null;
    reflowAfterDelete = false;
  }

  function suspend() {
    stopDepartures();
    for (const state of mounted.values()) unmount(state);
  }

  function geometry() {
    const width = grid.clientWidth;
    if (!width || document.hidden) return false;
    if (!dirty && width === gridWidth) return true;
    const css = getComputedStyle(grid);
    const gap = parseFloat(css.getPropertyValue('--archive-gap')) || 0;
    const count = Math.max(1, parseInt(css.getPropertyValue('--archive-columns'), 10) || 1);
    const columnWidth = (width - (count - 1) * gap) / count;
    const bottoms = Array(count).fill(0);
    lanes = Array.from({ length: count }, () => []);
    places = new Map();
    for (const [index, work] of works.entries()) {
      const { width: w, height: h } = measured.get(work) || work;
      const known = Number(w) > 0 && Number(h) > 0;
      const imageWidth = known ? Number(w) : 3, imageHeight = known ? Number(h) : 4;
      const column = bottoms.indexOf(Math.min(...bottoms));
      const top = bottoms[column], bottom = top + columnWidth * imageHeight / imageWidth;
      const place = { work, index, columnWidth, imageWidth, imageHeight, top, bottom, left: column * (columnWidth + gap) };
      places.set(work.id, place);
      lanes[column].push(place);
      bottoms[column] = bottom + gap;
    }
    const height = Math.max(0, Math.max(...bottoms) - gap);
    const nextHeight = works.length ? height + 'px' : originalHeight;
    if (grid.style.height !== nextHeight) {
      // If the last row was on screen, an instant height reduction would
      // clamp scrollY and make the whole viewport jump during the reflow.
      const before = reflowAfterDelete ? grid.offsetHeight : 0;
      heightMotion?.cancel();
      heightMotion = null;
      grid.style.height = nextHeight;
      if (before > height + 1 && !reduced.matches && width === gridWidth) {
        let delay = 0;
        for (const { fade } of departures.values())
          delay = Math.max(delay, fade.effect.getComputedTiming().endTime - (fade.currentTime || 0));
        const motion = grid.animate([{ minHeight: before + 'px' }, { minHeight: height + 'px' }], {
          ...reflowTiming, delay, fill: 'backwards',
        });
        heightMotion = motion;
        motion.onfinish = () => { if (heightMotion === motion) heightMotion = null; };
      }
    }
    reflowAfterDelete = false;
    dirty = false;
    gridWidth = width;
    return true;
  }

  // Each lane is monotonic, so a scroll through a large archive only visits
  // the handful of rows around the new scroll position.
  function nearby(top, bottom) {
    const result = [];
    for (const lane of lanes) {
      let low = 0, high = lane.length;
      while (low < high) {
        const mid = low + Math.floor((high - low) / 2);
        if (lane[mid].bottom <= top) low = mid + 1;
        else high = mid;
      }
      for (let i = low; i < lane.length && lane[i].top < bottom; i++) result.push(lane[i]);
    }
    return result.sort((a, b) => a.index - b.index);
  }

  function mount(place) {
    const card = createCard(place.work, place.index);
    const image = card.querySelector('.archive-open img');
    const state = { work: place.work, card, image, place: null, job: null, enter: null, flip: null };
    card.dataset.imageState = 'idle';
    image.decoding = 'async';
    image.loading = 'eager';
    mounted.set(place.work.id, state);
    grid.append(card);
    return state;
  }

  function position(state, place) {
    const old = state.place;
    if (old === place) return;
    const { card, image } = state;
    card.style.width = place.columnWidth + 'px';
    card.style.left = place.left + 'px';
    card.style.top = place.top + 'px';
    image.width = place.imageWidth;
    image.height = place.imageHeight;
    if (old) updateCard(card, place.work, place.index);
    state.place = place;

    if (old && !reduced.matches && Math.abs(old.columnWidth - place.columnWidth) < 0.5) {
      if (old.left === place.left && old.top === place.top) return;
      const prev = state.flip;
      const progress = prev?.animation.effect.getComputedTiming().progress ?? 1;
      const x = old.left - place.left + (prev?.x || 0) * (1 - progress);
      const y = old.top - place.top + (prev?.y || 0) * (1 - progress);
      prev?.animation.cancel();
      state.flip = null;
      if (Math.abs(x) > 0.5 || Math.abs(y) > 0.5) {
        const animation = card.animate([{ translate: x + 'px ' + y + 'px' }, { translate: '0 0' }], reflowTiming);
        state.flip = { animation, x, y };
        animation.onfinish = () => {
          if (state.flip?.animation === animation) state.flip = null;
          schedule();
        };
      }
    } else if (state.flip) {
      state.flip.animation.cancel();
      state.flip = null;
    }
  }

  function onScreen(card) {
    const box = card.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.top < innerHeight && box.bottom > 0 &&
      box.left < innerWidth && box.right > 0;
  }

  async function load(state) {
    const { image, card, work } = state;
    const job = {};
    active = state.job = job;
    card.dataset.imageState = 'loading';
    card.setAttribute('aria-busy', 'true');
    try {
      image.src = getURL(work);
      await image.decode();
      if (state.job !== job) return;
      if (document.hidden || !onScreen(card)) { release(state); return; }
      const width = image.naturalWidth, height = image.naturalHeight;
      if (width && height && (state.place.imageWidth !== width || state.place.imageHeight !== height)) {
        measured.set(work, { width, height });
        dirty = true;
      }
      card.dataset.imageState = 'ready';
      if (!reduced.matches) {
        state.enter = image.parentElement.animate([
          { opacity: 0, transform: 'translate3d(0, 20px, 0) scale(.985)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' },
        ], { duration: 540, easing: 'cubic-bezier(.2,.75,.2,1)' });
      }
    } catch {
      if (state.job === job) card.dataset.imageState = 'error';
    } finally {
      if (state.job === job) {
        state.job = null;
        card.removeAttribute('aria-busy');
      }
      if (active === job) active = null;
      schedule();
    }
  }

  function paint() {
    frame = 0;
    if (!geometry()) { suspend(); return; }
    const rect = grid.getBoundingClientRect();
    const top = -rect.top, bottom = innerHeight - rect.top;
    const buffer = Math.min(320, innerHeight / 2);
    const rows = nearby(top - buffer, bottom + buffer);
    const needed = new Set(rows.map(place => place.work.id));
    const visible = rows.filter(place => place.bottom > top && place.top < bottom);
    const inView = new Set(visible.map(place => place.work.id));

    for (const [id, state] of mounted) {
      const place = places.get(id);
      // A previously visible tile can have an offscreen destination after a
      // tall card is removed. Keep its existing pixels until it slides out.
      const movingOut = !inView.has(id) && place && !reduced.matches && state.card.dataset.imageState === 'ready' &&
        (state.flip || state.place?.top !== place.top || state.place?.left !== place.left) && onScreen(state.card);
      if (!place || state.work !== place.work ||
          (!needed.has(id) && !movingOut && !state.card.contains(document.activeElement))) {
        unmount(state);
      } else {
        if (!inView.has(id) && !movingOut && state.card.dataset.imageState !== 'idle') release(state);
        position(state, place);
      }
    }

    // Create shells in small batches, visible rows first. The extra shells
    // support keyboard focus across viewport edges; they never start a load.
    const priority = visible.concat(rows.filter(place => !inView.has(place.work.id)));
    let added = 0;
    for (const place of priority) {
      if (mounted.has(place.work.id)) continue;
      if (added === 6) { schedule(); break; }
      position(mount(place), place);
      added++;
    }
    // Keep tab order in sync even when scrolling upwards or changing sort.
    let next = grid.firstElementChild;
    for (const state of [...mounted.values()].sort((a, b) => a.place.index - b.place.index)) {
      if (next !== state.card) grid.insertBefore(state.card, next);
      next = state.card.nextElementSibling;
    }

    // At most one original is being fetched/decoded. Re-evaluate the viewport
    // before each start instead of finishing a backlog from an earlier scroll.
    if (!active) {
      for (const place of visible) {
        const state = mounted.get(place.work.id);
        if (state?.card.dataset.imageState === 'idle' && onScreen(state.card)) {
          void load(state);
          break;
        }
      }
    }
  }

  function setWorks(next) {
    works = next;
    dirty = true;
    // Establish the full height before navigation restores this screen's scroll.
    geometry();
    schedule();
  }

  function focusWork(id) {
    if (!geometry()) return false;
    const place = places.get(id);
    if (!place) return false;
    const rect = grid.getBoundingClientRect();
    if (rect.top + place.top >= innerHeight || rect.top + place.bottom <= 0)
      window.scrollTo({ top: scrollY + rect.top + place.top - innerHeight / 3, behavior: 'instant' });
    const state = mounted.get(id) || mount(place);
    position(state, place);
    state.card.querySelector('.archive-open').focus({ preventScroll: true });
    schedule();
    return true;
  }

  const resize = new ResizeObserver(schedule);
  resize.observe(grid);
  const onVisibility = () => {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; suspend(); }
    else schedule();
  };
  function motionChange() {
    if (reduced.matches) {
      stopDepartures();
      for (const state of mounted.values()) {
        state.enter?.cancel();
        state.flip?.animation.cancel();
        state.flip = null;
      }
    }
    schedule();
  }
  // Column counts also change at viewport breakpoints even if width stays fixed.
  function viewportChange() { stopDepartures(); dirty = true; schedule(); }
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', viewportChange, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  reduced.addEventListener('change', motionChange);
  return {
    setWorks, focusWork, depart, finishDeparture, refresh: schedule,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      suspend();
      resize.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', viewportChange);
      document.removeEventListener('visibilitychange', onVisibility);
      reduced.removeEventListener('change', motionChange);
      grid.style.height = originalHeight;
    },
  };
}
