// Keep the output controls at their intrinsic height. On shorter screens the
// whole composition column takes over scrolling, instead of nesting a tiny
// scroll area inside the open sampling controls.
import { captureComposeLayout, followComposeLayout } from './compose-layout.js';
const mounts = new WeakMap();
export function mountGenerationDock(host) {
  if (!host) return;
  if (mounts.has(host)) return mounts.get(host);
  const foot = host.closest('.generate-foot');
  const panel = foot?.closest('.compose-panel');
  const editor = panel?.querySelector('.compose-scroll');
  if (!foot || !panel || !editor) return;
  let frame = 0;
  let savedEditorScroll = 0;
  const update = () => {
    frame = 0;
    if (!panel.getClientRects().length) return;
    const available = panel.clientHeight;
    const flowing = panel.classList.contains('gd-column-scroll');
    // Give the dock the same usable width whichever element owns the scrollbar.
    if (!flowing && editor.offsetWidth) {
      panel.style.setProperty('--compose-scroll-gutter', (editor.offsetWidth - editor.clientWidth) + 'px');
    }
    const minimumEditor = Math.min(260, available * 0.42);
    const needsFlow = foot.offsetHeight + 20 + minimumEditor > available;
    if (needsFlow === flowing) return;
    const before = captureComposeLayout(panel);
    const active = document.activeElement;
    const keep = panel.contains(active) && active !== panel ? active : null;
    const anchor = keep || foot;
    const anchorTop = anchor.getBoundingClientRect().top;
    if (needsFlow) savedEditorScroll = editor.scrollTop;
    panel.classList.toggle('gd-column-scroll', needsFlow);
    if (needsFlow) {
      panel.scrollTop = savedEditorScroll;
      panel.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    } else {
      panel.scrollTop = 0;
      editor.scrollTop = savedEditorScroll;
    }
    // Transfer the scroll root synchronously, keeping the active control in its
    // current place. A later scrollIntoView caused a second, visible jump.
    const disclosure = panel.querySelector('[data-cm-disclosing]');
    const animation = disclosure?.getAnimations().find((item) => item.playState === 'running');
    const remaining = animation
      ? Number(animation.effect.getTiming().duration) - Number(animation.currentTime || 0)
      : 270;
    followComposeLayout(panel, before, {
      ignoreScroll: false,
      duration: Math.max(80, Math.min(270, remaining)),
    });
  };
  const queue = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const observer = new ResizeObserver(queue);
  observer.observe(panel);
  observer.observe(foot);
  queue();
  const api = {
    refresh: queue,
    destroy() {
      observer.disconnect();
      cancelAnimationFrame(frame);
      panel.classList.remove('gd-column-scroll');
      mounts.delete(host);
    },
  };
  mounts.set(host, api);
  return api;
}
