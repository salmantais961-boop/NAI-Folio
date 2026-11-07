import { sweepRemoval } from './image-removal.js';

// A red card is a reversible choice. Only its own second activation calls remove.
export function mountRemovalConfirmation(remove) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let armed = null;
  const retracting = new Map();
  const visibility = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) forget(entry.target);
    }
  });

  function restoreButton(entry) {
    entry.events.abort();
    delete entry.card.dataset.removalArmed;
    entry.open.removeAttribute('aria-busy');
    entry.open.setAttribute('aria-label', entry.label);
    if (entry.title === null) entry.open.removeAttribute('title');
    else entry.open.title = entry.title;
  }
  function clearWash(entry) {
    visibility.unobserve(entry.card);
    retracting.delete(entry.card);
    if (entry.sweep) {
      entry.sweep.onfinish = null;
      entry.sweep.cancel();
    }
    entry.wash.remove();
  }
  function cancel(card, immediate = false) {
    if (!armed || (card && armed.card !== card)) return;
    const entry = armed;
    armed = null;
    restoreButton(entry);
    if (immediate || reduced.matches || document.hidden || !entry.sweep?.currentTime) {
      clearWash(entry);
      return;
    }
    // Run the same clip backwards from its current edge, including when the
    // user dismisses a card before the opening sweep has reached the right.
    retracting.set(entry.card, entry);
    entry.sweep.onfinish = () => {
      if (retracting.get(entry.card) === entry) clearWash(entry);
    };
    entry.sweep.reverse();
  }
  function forget(card) {
    cancel(card, true);
    const entry = retracting.get(card);
    if (entry) clearWash(entry);
  }
  function arm(card, work, open, surface = open) {
    if (!card || !work || !surface || card.hasAttribute('data-removal-armed')) return;
    cancel();
    let effect = retracting.get(card);
    if (effect) {
      retracting.delete(card);
      effect.sweep.onfinish = null;
      effect.sweep.updatePlaybackRate(1);
      effect.sweep.play();
    } else {
      effect = sweepRemoval(surface, { inset: '0', borderRadius: 'inherit' }, !reduced.matches);
    }
    const events = new AbortController(), { signal } = events;
    const entry = {
      card, open, events, label: open.getAttribute('aria-label'), title: open.getAttribute('title'),
      wash: effect.wash, sweep: effect.sweep,
    };
    armed = entry;
    card.dataset.removalArmed = '';
    open.setAttribute('aria-label', '确认删除此作品，按 Escape 取消');
    open.title = '再次点击删除 · Esc 取消';
    open.focus({ preventScroll: true });
    visibility.observe(card);

    open.addEventListener('click', async event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (armed !== entry) return;
      visibility.unobserve(card);
      armed = null;
      entry.sweep?.cancel();
      open.setAttribute('aria-busy', 'true');
      try {
        await remove(work);
      } finally {
        // The retiring card owns the red surface until its fade completes.
        if (card.hasAttribute('data-departing')) events.abort();
        else {
          restoreButton(entry);
          clearWash(entry);
        }
      }
    }, { capture: true, signal });
    const outside = event => {
      if (armed === entry && !card.contains(event.target)) cancel();
    };
    document.addEventListener('pointerdown', outside, { capture: true, signal });
    document.addEventListener('focusin', outside, { capture: true, signal });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || armed !== entry) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }, { capture: true, signal });
  }
  reduced.addEventListener('change', () => {
    if (!reduced.matches) return;
    for (const entry of retracting.values()) clearWash(entry);
    armed?.sweep?.finish();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    cancel(null, true);
    for (const entry of retracting.values()) clearWash(entry);
  });
  return { arm, cancel, forget };
}
