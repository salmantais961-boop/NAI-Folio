import { setIcon } from './icons.js';

export function sweepRemoval(surface, placement, animate = true) {
  const wash = document.createElement('span');
  wash.className = 'image-delete-wash';
  setIcon(wash, 'trash');
  Object.assign(wash.style, placement);
  surface.append(wash);
  const sweep = animate ? wash.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0)' }], {
    duration: 190, easing: 'cubic-bezier(.36,.05,.22,1)', fill: 'both',
  }) : null;
  return { wash, sweep };
}

export function fadeRemovedTile(tile, delay = 0) {
  return tile.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: '5px 0' }], {
    delay, duration: 145, easing: 'ease-out', fill: 'both',
  });
}
