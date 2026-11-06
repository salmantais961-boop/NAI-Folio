// Local FLIP handoffs for deliberate composition changes. No global resize
// listener: normal disclosure height animation already moves its neighbours.
const motions = new WeakMap();
const targets = [
  ['intro', '.panel-intro'],
  ['usage', '#usage-summary'],
  ['model', '#model-controls'],
  ['prompt', '.prompt-section'],
  ['source', '#controls > .fc-source'],
  ['characters', '#controls > [data-section="characters"]'],
  ['references', '#controls > [data-section="references"]'],
  ['notice', '#controls > .fc-notice'],
  ['dock', '.generate-foot'],
];
function nodes(root) {
  return targets.map(([key, selector]) => [key, root.querySelector(selector)]).filter(([, node]) => node);
}
export function captureComposeLayout(root) {
  const editor = root.querySelector('.compose-scroll');
  return {
    panelScroll: root.scrollTop,
    editorScroll: editor?.scrollTop || 0,
    windowScroll: scrollY,
    items: new Map(
      nodes(root)
        .filter(([, node]) => node.getClientRects().length)
        .map(([key, node]) => [
          key,
          {
            top: node.getBoundingClientRect().top,
            bottom: node.getBoundingClientRect().bottom,
            inEditor: editor?.contains(node),
          },
        ]),
    ),
  };
}
export function cancelComposeLayout(root) {
  const running = motions.get(root);
  if (running) for (const animation of running.values()) animation.cancel();
  motions.delete(root);
  delete root.dataset.cmLayout;
}
export function followComposeLayout(root, before, { duration = 270, ignoreScroll = true } = {}) {
  if (!before || !root.getClientRects().length || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cancelComposeLayout(root);
    return;
  }
  cancelComposeLayout(root);
  const editor = root.querySelector('.compose-scroll');
  const bounds = root.getBoundingClientRect();
  const running = new Map();
  for (const [key, node] of nodes(root)) {
    const old = before.items.get(key);
    if (!old || !node.getClientRects().length) continue;
    const rect = node.getBoundingClientRect();
    const scrollDelta = ignoreScroll
      ? root.scrollTop -
        before.panelScroll +
        scrollY -
        before.windowScroll +
        (old.inEditor && editor?.contains(node) ? editor.scrollTop - before.editorScroll : 0)
      : 0;
    const dy = old.top - rect.top - scrollDelta;
    if (
      Math.abs(dy) < 1 ||
      Math.max(old.bottom, rect.bottom) < bounds.top ||
      Math.min(old.top, rect.top) > bounds.bottom
    )
      continue;
    const animation = node.animate([{ translate: `0 ${dy}px` }, { translate: '0 0' }], {
      duration,
      easing: 'cubic-bezier(.2,.75,.25,1)',
    });
    running.set(node, animation);
    animation.finished.then(
      () => {
        if (motions.get(root) !== running) return;
        running.delete(node);
        if (!running.size) {
          motions.delete(root);
          delete root.dataset.cmLayout;
        }
      },
      () => {},
    );
  }
  if (running.size) {
    motions.set(root, running);
    root.dataset.cmLayout = '';
  }
}
