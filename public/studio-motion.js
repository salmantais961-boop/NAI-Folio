// Return to the atelier as a short sequence of paper layers, leaving the shared
// masthead and canvas ground still. Only visible content participates.
export function mountStudioEntrance(root) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const animations = new Set();
  let frame = 0;
  function cancel() {
    cancelAnimationFrame(frame);
    frame = 0;
    for (const animation of animations) animation.cancel();
    animations.clear();
  }
  function animate(node, delay, distance = 14, fade = true) {
    if (!node || !node.getClientRects().length) return;
    const rect = node.getBoundingClientRect();
    if (rect.bottom < 56 || rect.top >= innerHeight || rect.right < 0 || rect.left >= innerWidth) return;
    const animation = node.animate(
      [
        { translate: `0 ${distance}px`, opacity: fade ? 0.18 : 1 },
        { translate: '0 0', opacity: 1 },
      ],
      { duration: 460, delay, easing: 'cubic-bezier(.16,.8,.23,1)', fill: 'both' },
    );
    animations.add(animation);
    animation.finished.then(
      () => {
        animations.delete(animation);
        animation.cancel();
      },
      () => {},
    );
  }
  function play() {
    cancel();
    if (reduced.matches || root.hidden) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (root.hidden) return;
      const compose = root.querySelector('.compose-scroll');
      let order = 0;
      for (const item of compose?.children || []) {
        if (item.hidden || item.getBoundingClientRect().bottom <= compose.getBoundingClientRect().top) continue;
        animate(item, Math.min(order++, 4) * 38, 12);
      }
      animate(root.querySelector('.proof-head'), 35, 15);
      animate(root.querySelector('#canvas-stage'), 65, 20, false);
      animate(root.querySelector('.proof-foot'), 110, 10);
      animate(root.querySelector('.history-shell'), 90, 16);
      animate(root.querySelector('.generate-foot'), 100, 12);
      const library = root.querySelector('#block-library-slot');
      if (library && !library.hidden) animate(library, 55, 12);
    });
  }
  // An entrance must never slow the first edit or override a pointer gesture.
  root.addEventListener('pointerdown', cancel, { passive: true });
  root.addEventListener('keydown', cancel);
  reduced.addEventListener('change', cancel);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancel();
  });
  return { play, cancel };
}
