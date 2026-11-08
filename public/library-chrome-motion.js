// Only the two proof information bands participate. Freeze their existing DOM
// geometry while the library changes grid tracks, so container-query wrapping
// cannot teleport controls. Text is repositioned and reflowed, never scaled.
const parts = [
  '.proof-head',
  '.proof-mast',
  '#proof-actions',
  '.pa-strip',
  '.pa-strip > *',
  '.pa-button > *',
  '.proof-foot',
  '.proof-dock-info',
  '.proof-summary',
  '#proof-status-slot',
  '.proof-activity',
  '.proof-activity > *',
  '.activity-copy > *',
  '#ink-palette',
  '#proof-notebook',
  '.pn-heading',
  '.pn-heading > *',
  '.pn-stats',
  '.pn-stat',
  '.pn-actions',
  '.pn-actions > *',
  '.pn-details',
  '.proof-progress',
  '.pp-reading',
  '.pp-track',
  '.proof-dock-tools',
  '#proof-view-tools',
  '.proof-utilities',
  '.proof-utilities > *',
].join(',');

export function captureProofChrome(studio) {
  const proof = studio.querySelector('.proof-panel');
  const nodes = [...proof.querySelectorAll(parts)];
  const selected = new Set(nodes);
  return nodes.map((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    let parent = element.parentElement;
    while (parent !== proof && !selected.has(parent)) parent = parent.parentElement;
    const anchor = parent.getBoundingClientRect();
    return {
      element,
      parent,
      root: parent === proof,
      visible: rect.width > 0 && rect.height > 0 && style.display !== 'none',
      display: style.display,
      left: rect.left - anchor.left - parent.clientLeft,
      top: rect.top - anchor.top - parent.clientTop,
      width: rect.width,
      height: rect.height,
      opacity: style.opacity,
    };
  });
}

export function moveProofChrome(studio, before, timing) {
  // Read the dock's new natural height before the morph takes its rows out of flow.
  // Keep that target for the hand-off back to its normal height transition.
  studio.classList.add('blocks-chrome-morph');
  const after = captureProofChrome(studio);
  const dock = studio.querySelector('.proof-foot');
  dock.style.setProperty('--dock-height', getComputedStyle(dock).height);
  const originals = new Map(before.map((entry) => [entry.element, entry]));
  const stableContents = new Set(
    after
      .filter((entry) =>
        after.every((child) => {
          if (child.element === entry.element || !entry.element.contains(child.element)) return true;
          const old = originals.get(child.element);
          return (
            old &&
            old.visible === child.visible &&
            ['left', 'top', 'width', 'height'].every((key) => Math.abs(old[key] - child[key]) < 0.1)
          );
        }),
      )
      .map((entry) => entry.element),
  );
  const cleanups = [],
    animations = [];
  for (const end of after) {
    const element = end.element,
      start = originals.get(element);
    if (!start || (!start.visible && !end.visible)) continue;
    let ancestor = end.parent,
      nestedInStableGroup = false;
    while (originals.has(ancestor)) {
      if (stableContents.has(ancestor)) {
        nestedInStableGroup = true;
        break;
      }
      ancestor = originals.get(ancestor).parent;
    }
    if (nestedInStableGroup) continue;
    const from = start.visible ? start : end;
    const to = end.visible ? end : start;
    const saved = new Map();
    function set(name, value) {
      saved.set(name, [element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]);
      element.style.setProperty(name, value, 'important');
    }
    set('position', end.root ? 'relative' : 'absolute');
    set('box-sizing', 'border-box');
    set('min-width', '0');
    set('max-width', 'none');
    set('min-height', '0');
    set('max-height', 'none');
    set('display', end.visible ? end.display : start.display);
    if (end.root) {
      set('align-self', 'flex-start');
      set('margin-right', '0');
    } else {
      set('margin', '0');
      set('grid-area', 'auto');
      set('align-self', 'auto');
      set('justify-self', 'auto');
    }
    const frame = (state, visible) => ({
      [end.root ? 'marginLeft' : 'left']: state.left + 'px',
      ...(end.root ? {} : { top: state.top + 'px' }),
      width: state.width + 'px',
      height: state.height + 'px',
      opacity: visible ? state.opacity : 0,
    });
    animations.push(element.animate([frame(from, start.visible), frame(to, end.visible)], timing));
    cleanups.push(() => {
      for (const [name, [value, priority]] of saved) {
        if (value) element.style.setProperty(name, value, priority);
        else element.style.removeProperty(name);
      }
    });
  }
  return () => {
    for (const animation of animations) animation.cancel();
    for (const cleanup of cleanups) cleanup();
    studio.classList.remove('blocks-chrome-morph');
  };
}
