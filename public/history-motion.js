/** One ink capsule follows the selected proof. Kept outside the list so history
 * sorting, pending handoffs and deletion never treat it as an artwork. */
export function mountHistoryMotion(host) {
  const shell = host.closest('.history-shell') || host.parentElement;
  const track = document.createElement('div');
  track.className = 'hm-track';
  track.setAttribute('aria-hidden', 'true');
  const marker = document.createElement('i');
  marker.className = 'hm-marker';
  marker.hidden = true;
  track.append(marker);
  shell.append(track);
  shell.classList.add('hm-enabled');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0,
    animateNext = false,
    motion = null,
    previous = null,
    observed = null;
  const resize = new ResizeObserver(() => schedule(false));
  resize.observe(host);
  function cancel() {
    motion?.cancel();
    motion = null;
  }
  function sync(animate) {
    frame = 0;
    const selected = host.querySelector('.history-item[data-selected="true"]');
    const artwork = selected?.querySelector('.hp-surface, .history-open img');
    if (observed !== artwork) {
      if (observed) resize.unobserve(observed);
      observed = artwork;
      if (observed) resize.observe(observed);
    }
    if (!artwork || !host.clientHeight || !host.clientWidth) {
      cancel();
      marker.hidden = true;
      previous = null;
      delete track.dataset.current;
      return;
    }
    Object.assign(track.style, {
      left: host.offsetLeft + host.clientLeft + 'px',
      top: host.offsetTop + host.clientTop + 'px',
      width: host.clientWidth + 'px',
      height: host.clientHeight + 'px',
    });
    const bounds = host.getBoundingClientRect(),
      picture = artwork.getBoundingClientRect();
    const scale = bounds.height / host.offsetHeight || 1;
    const target = {
      top: (picture.top - bounds.top) / scale - host.clientTop + 4,
      height: Math.max(12, picture.height / scale - 8),
    };
    const id = selected.querySelector('.history-open')?.dataset.workId || 'pending';
    const changed =
      previous &&
      (previous.id !== id ||
        Math.abs(previous.top - target.top) > 0.5 ||
        Math.abs(previous.height - target.height) > 0.5);
    const style = getComputedStyle(marker);
    const from = {
      top: parseFloat(style.top) || target.top,
      height: parseFloat(style.height) || target.height,
    };
    if (!changed && motion) return;
    cancel();
    marker.hidden = false;
    marker.style.top = target.top + 'px';
    marker.style.height = target.height + 'px';
    track.dataset.current = id;
    previous = { ...target, id };
    if (!animate || reduced.matches || !changed) return;
    const bridgeTop = Math.min(from.top, target.top),
      bridgeBottom = Math.max(from.top + from.height, target.top + target.height);
    const animation = marker.animate(
      [
        { top: from.top + 'px', height: from.height + 'px', width: '3px' },
        { top: bridgeTop + 'px', height: bridgeBottom - bridgeTop + 'px', width: '2.25px', offset: 0.42 },
        { top: target.top + 'px', height: target.height + 'px', width: '3px' },
      ],
      { duration: 460, easing: 'cubic-bezier(.22,.68,.18,1)' },
    );
    motion = animation;
    animation.onfinish = () => {
      if (motion === animation) motion = null;
    };
  }
  function schedule(animate) {
    animateNext ||= animate;
    if (!frame)
      frame = requestAnimationFrame(() => {
        const value = animateNext;
        animateNext = false;
        sync(value);
      });
  }
  const mutation = new MutationObserver(() => schedule(true));
  mutation.observe(host, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-selected'],
  });
  const scroll = () => {
    animateNext = false;
    cancelAnimationFrame(frame);
    frame = 0;
    sync(false);
  };
  const load = () => schedule(false);
  const preference = () => {
    if (reduced.matches) {
      cancel();
      sync(false);
    }
  };
  host.addEventListener('scroll', scroll, { passive: true });
  host.addEventListener('load', load, true);
  reduced.addEventListener('change', preference);
  schedule(false);
  return {
    refresh: () => schedule(false),
    destroy() {
      cancelAnimationFrame(frame);
      cancel();
      mutation.disconnect();
      resize.disconnect();
      host.removeEventListener('scroll', scroll);
      host.removeEventListener('load', load, true);
      reduced.removeEventListener('change', preference);
      track.remove();
      shell.classList.remove('hm-enabled');
    },
  };
}
