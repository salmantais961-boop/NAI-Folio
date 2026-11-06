function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

/** A presentation-only strip entry. Completed works remain owned by studio/archive storage. */
export function mountPendingHistory(host, { onOpen } = {}) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let tile = null;
  let surface = null;
  let previewImage = null;
  let generation = 0;
  let previewRevision = 0;
  let finishing = null;
  let destroyed = false;
  let selected = true;
  const handoffs = new Map();

  function clearHandoffs() {
    for (const [ghost, animation] of handoffs) {
      animation.cancel();
      ghost.remove();
    }
    handoffs.clear();
  }

  function cancel() {
    generation++;
    previewRevision++;
    tile?.remove();
    tile = surface = previewImage = null;
    finishing = null;
  }

  function sync() {
    if (!tile || destroyed) return;
    host.querySelector('.history-empty')?.remove();
    if (finishing) {
      // Match by value rather than interpolating work IDs into a CSS selector.
      const open = [...host.querySelectorAll('.history-open')].find(
        (button) => button.dataset.workId === finishing,
      );
      const result = open?.closest('.history-item');
      if (result) {
        const ghost = surface.cloneNode(true);
        ghost.classList.add('hp-handoff');
        ghost.setAttribute('aria-hidden', 'true');
        cancel();
        host.prepend(result);
        if (!reduced.matches) {
          const target = open.querySelector('img') || open;
          const frame = target.getBoundingClientRect();
          const outer = result.getBoundingClientRect();
          Object.assign(ghost.style, {
            left: frame.left - outer.left + 'px',
            top: frame.top - outer.top + 'px',
            width: frame.width + 'px',
            height: frame.height + 'px',
            margin: '0',
            borderRadius: getComputedStyle(target).borderRadius,
          });
          result.append(ghost);
          const animation = ghost.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: 280,
            easing: 'cubic-bezier(.22,.61,.36,1)',
            fill: 'forwards',
          });
          handoffs.set(ghost, animation);
          animation.onfinish = () => {
            ghost.remove();
            handoffs.delete(ghost);
          };
        }
        return;
      }
    }
    if (host.firstElementChild !== tile) host.prepend(tile);
  }

  function begin({ width = 832, height = 1216, count = 1, mode = 'generate' } = {}) {
    if (destroyed) return;
    cancel();
    clearHandoffs();
    const w = Number.isFinite(Number(width)) && Number(width) > 0 ? Number(width) : 832;
    const h = Number.isFinite(Number(height)) && Number(height) > 0 ? Number(height) : 1216;
    const amount = Math.max(1, Math.min(64, Math.floor(Number(count) || 1)));
    const label = mode === 'upscale' ? '放大中' : mode === 'augment' ? '处理中' : '生成中';
    tile = node('div', 'history-item history-pending');
    tile.dataset.pending = 'true';
    tile.setAttribute('aria-label', label + ' · ' + amount + ' 张 · ' + w + ' × ' + h);
    tile.dataset.selected = String(selected);
    tile.style.setProperty('--hp-aspect', w + ' / ' + h);
    const open = node('button', 'hp-open');
    open.type = 'button';
    open.setAttribute('aria-label', '查看正在生成的图像 · ' + w + ' × ' + h);
    open.setAttribute('aria-pressed', String(selected));
    open.title = '返回正在生成的图像';
    open.onclick = () => onOpen?.();
    surface = node('div', 'hp-surface');
    surface.setAttribute('aria-hidden', 'true');
    previewImage = node('img', 'hp-image');
    previewImage.alt = '';
    previewImage.hidden = true;
    const grain = node('span', 'hp-grain');
    const flower = node('i', 'hp-flower folio-mark');
    surface.append(grain, flower, previewImage);
    const status = node('small', 'hp-label');
    status.append(node('i', 'hp-dot'), document.createTextNode(label + (amount > 1 ? ' · ' + amount : '')));
    open.append(surface, status);
    tile.append(open);
    sync();
    // Keep the new active entry visible without changing the page's scroll position.
    host.scrollTop = 0;
  }

  async function preview(url) {
    if (!tile || finishing || destroyed || typeof url !== 'string' || !url) return false;
    const token = generation;
    const revision = ++previewRevision;
    const decoded = new Image();
    decoded.src = url;
    try {
      await decoded.decode();
    } catch {
      return false;
    }
    if (token !== generation || revision !== previewRevision || !tile || finishing) return false;
    previewImage.src = url;
    previewImage.hidden = false;
    tile.dataset.preview = 'true';
    surface.dataset.preview = 'true';
    return true;
  }

  function complete(workId) {
    if (!tile || destroyed || !workId) return;
    finishing = String(workId);
    previewRevision++;
  }

  function visibility() {
    if (tile) tile.classList.toggle('hp-suspended', document.hidden);
  }
  function preference() {
    if (reduced.matches) clearHandoffs();
  }
  document.addEventListener('visibilitychange', visibility);
  reduced.addEventListener('change', preference);
  return {
    begin,
    preview,
    complete,
    sync,
    cancel,
    select(value) {
      selected = Boolean(value);
      if (tile) {
        tile.dataset.selected = String(selected);
        tile.querySelector('.hp-open')?.setAttribute('aria-pressed', String(selected));
      }
    },
    get active() {
      return !!tile;
    },
    get completingId() {
      return finishing;
    },
    destroy() {
      destroyed = true;
      cancel();
      clearHandoffs();
      document.removeEventListener('visibilitychange', visibility);
      reduced.removeEventListener('change', preference);
    },
  };
}
