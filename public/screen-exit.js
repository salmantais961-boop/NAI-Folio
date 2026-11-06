// A brief paper-like departure for deliberate navigation. State-changing actions
// still switch immediately, so focusing an imported role never waits on motion.
export function mountScreenExit() {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let active = null;
  function cancel() {
    if (!active) return;
    const previous = active;
    active = null;
    previous.animation.cancel();
    previous.node.style.pointerEvents = previous.pointerEvents;
  }
  function finish(entry) {
    if (active !== entry) return;
    active = null;
    entry.node.style.pointerEvents = entry.pointerEvents;
    entry.commit();
    entry.animation.cancel();
  }
  function play(node, commit) {
    cancel();
    if (reduced.matches || document.hidden || !node?.getClientRects().length) {
      commit();
      return;
    }
    const opacity = getComputedStyle(node).opacity;
    const animation = node.animate(
      [
        { translate: '0 0', opacity },
        { translate: '0 -8px', opacity: 0.32 },
      ],
      { duration: 170, easing: 'cubic-bezier(.4,0,.66,.55)', fill: 'both' },
    );
    const entry = { node, commit, animation, pointerEvents: node.style.pointerEvents };
    active = entry;
    node.style.pointerEvents = 'none';
    animation.finished.then(
      () => finish(entry),
      () => {},
    );
  }
  reduced.addEventListener('change', () => {
    if (active) finish(active);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && active) finish(active);
  });
  return { play, cancel };
}
