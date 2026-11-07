import { plates, two } from './plates.js';

const $ = (id) => document.getElementById(id);
const cover = $('cover');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const exitDuration = 420;
const period = (5000 - exitDuration) / plates.length;
const lettering = cover.querySelector('.cover-mast h1');
const title = lettering.textContent;
lettering.setAttribute('aria-label', title);
lettering.replaceChildren(
  ...Array.from(title, (letter) => {
    const span = document.createElement('span');
    span.className = 'cover-letter';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = letter;
    return span;
  }),
);
const motions = new Map();
function typeset(element, offset = 12, delay = 0, horizontal = false) {
  if (!element || reduced.matches) return;
  motions.get(element)?.cancel();
  const animation = element.animate(
    [
      { opacity: 0, translate: horizontal ? `${offset}px 0` : `0 ${offset}px` },
      { opacity: 1, translate: '0 0' },
    ],
    { duration: 480, delay, easing: 'cubic-bezier(.19,1,.22,1)', fill: 'backwards' },
  );
  motions.set(element, animation);
  animation.onfinish = () => {
    if (motions.get(element) === animation) motions.delete(element);
  };
}
for (const plate of plates) {
  const preload = new Image();
  preload.src = plate.src;
}
let index = 0,
  elapsed = 0,
  previous = 0,
  frame = 0;
let paused = reduced.matches,
  showing = false;
let seen = false;
try {
  seen = sessionStorage.getItem('folio.entered') === '1';
  $('opening-pref').checked = localStorage.getItem('folio.show-opening') === '1';
} catch {}
$('opening-pref').onchange = () => {
  try {
    localStorage.setItem('folio.show-opening', $('opening-pref').checked ? '1' : '0');
  } catch {}
};
function syncPause() {
  const label = paused ? '继续播放' : '暂停播放';
  $('pause-cover').textContent = paused ? '▷' : 'Ⅱ';
  $('pause-cover').title = label;
  $('pause-cover').setAttribute('aria-label', label);
}
function spread(i, carry = 0) {
  index = i;
  elapsed = carry;
  const item = plates[i],
    no = two(i + 1);
  $('spread').className = 'spread-layout ' + item.format;
  const next = $('spread-img').cloneNode(false);
  next.src = item.src;
  next.alt = item.alt;
  $('spread-img').replaceWith(next);
  $('stamp-number').textContent = no;
  $('spread-eyebrow').textContent = 'PLATE ' + no + '  /  ' + item.tone;
  $('plate-title').textContent = $('plate-imprint').textContent = item.title;
  $('plate-cn').textContent = $('foot-cn').textContent = item.cn;
  typeset($('spread-eyebrow'), -12, 35, true);
  typeset($('plate-title'), 22, 85);
  typeset($('plate-cn'), 12, 135);
  typeset($('plate-imprint'), 10, 75, true);
  typeset($('foot-cn'), 8, 110, true);
  typeset($('stamp-number'), -8, 65);
  $('swatches').replaceChildren(
    ...item.swatches.map((color) => {
      const n = document.createElement('i');
      n.style.background = color;
      return n;
    }),
  );
  document
    .querySelectorAll('[data-slide]')
    .forEach((btn) => btn.setAttribute('aria-current', String(Number(btn.dataset.slide) === index)));
}
function tick(now) {
  if (!showing) return;
  if (!paused && !document.hidden && previous) elapsed += Math.min(now - previous, 180);
  previous = now;
  $('progress-line').style.transform =
    'scaleX(' + (index + Math.min(1, elapsed / period)) / plates.length + ')';
  if (elapsed >= period) {
    if (index === plates.length - 1) return enter();
    spread(index + 1, elapsed - period);
  }
  frame = requestAnimationFrame(tick);
}
function enter(immediate = false) {
  if (!showing) return;
  showing = false;
  cancelAnimationFrame(frame);
  try {
    sessionStorage.setItem('folio.entered', '1');
  } catch {}
  $('app').hidden = false;
  if (!immediate && !reduced.matches) document.dispatchEvent(new Event('folio:enter'));
  const close = () => {
    cover.hidden = true;
    cover.classList.remove('closing');
    document.body.classList.remove('is-cover');
    if (!immediate) $('studio-nav').focus({ preventScroll: true });
  };
  if (immediate || reduced.matches) close();
  else {
    cover.classList.add('closing');
    setTimeout(close, exitDuration);
  }
}
function replay() {
  showing = true;
  paused = reduced.matches;
  syncPause();
  previous = performance.now();
  for (const animation of motions.values()) animation.cancel();
  motions.clear();
  cover.hidden = false;
  document.body.classList.add('is-cover');
  $('app').hidden = true;
  spread(0);
  lettering.querySelectorAll('.cover-letter').forEach((letter, i) => typeset(letter, 23, i * 22));
  typeset(cover.querySelector('.mast-kicker'), -14, 70, true);
  typeset(cover.querySelector('.mast-note'), 16, 150, true);
  typeset(cover.querySelector('.cover-brand'), -10, 35, true);
  $('enter-cover').focus({ preventScroll: true });
  window.scrollTo(0, 0);
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(tick);
}
$('enter-cover').onclick = () => enter();
$('replay').onclick = replay;
$('pause-cover').onclick = () => {
  paused = !paused;
  syncPause();
};
$('plate-nav').onclick = (e) => {
  const btn = e.target.closest('[data-slide]');
  if (!btn) return;
  paused = true;
  syncPause();
  spread(Number(btn.dataset.slide));
};
document.addEventListener('keydown', (e) => {
  if (!showing) return;
  if (e.key === 'Escape') enter();
  if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault();
    paused = true;
    syncPause();
    spread((index + (e.key === 'ArrowLeft' ? -1 : 1) + plates.length) % plates.length);
  }
});
if (!seen && $('opening-pref').checked) replay();
reduced.addEventListener('change', () => {
  if (reduced.matches) {
    for (const animation of motions.values()) animation.cancel();
    motions.clear();
  }
});
