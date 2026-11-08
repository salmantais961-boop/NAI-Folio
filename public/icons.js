const paths = {
  tag: '<path d="M3.5 4.5v6.2l9.1 9.1a1.8 1.8 0 0 0 2.5 0l5-5a1.8 1.8 0 0 0 0-2.5l-9.1-9.1H4.8a1.3 1.3 0 0 0-1.3 1.3Z"/><circle cx="7.7" cy="7.4" r="1"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  bookmark: '<path d="M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4-6 4Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  lineage:
    '<rect x="2.5" y="8.5" width="6" height="7" rx="1.8"/><rect x="15.5" y="2.5" width="6" height="6" rx="1.8"/><rect x="15.5" y="15.5" width="6" height="6" rx="1.8"/><path d="M8.5 12H12V5.5h3.5M12 12v6.5h3.5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  pixels: '<path d="M3.5 3.5h7v7h-7zM13.5 13.5h7v7h-7zM14 6h4v4h-4zM6 14h4v4H6z"/>',
  'archive-grid':
    '<rect x="3" y="3" width="7" height="7" rx=".8"/><rect x="14" y="3" width="7" height="7" rx=".8"/><rect x="3" y="14" width="7" height="7" rx=".8"/><rect x="14" y="14" width="7" height="7" rx=".8"/>',
  'arrow-up-right': '<path d="M6 18 18 6M6 6h12v12"/>',
  moon: '<path d="M20 15.3A8.6 8.6 0 0 1 8.7 4a8.7 8.7 0 1 0 11.4 11.3Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  maximize: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
  'image-plus':
    '<path d="M13 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7M15 6h7m-3.5-3.5v7M3 16l5-5 4 4 2-2 6 6"/><circle cx="7" cy="8" r="1"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4"/>',
  feather: '<path d="m4 20 10-10m-8 8 1-7 7-7a4.2 4.2 0 0 1 6 6l-7 7-7 1Zm6-5h4"/>',
  pen: '<path d="m4 20 2-6L16 4a2 2 0 0 1 4 4L10 18l-6 2Zm10-14 4 4"/>',
  user: '<circle cx="12" cy="8" r="3.3"/><path d="M5 20v-2a7 7 0 0 1 14 0v2"/>',
  sliders:
    '<path d="M3 6h9m4 0h5M3 12h3m4 0h11M3 18h11m4 0h3"/><circle cx="14" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  spark: '<path d="m12 2 2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2Z"/>',
  r18: '<use href="/rating-18.svg#mark" width="24" height="24"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
};
export function setIcon(el, name) {
  el.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    paths[name] +
    '</svg>';
}
export function loadIcons() {
  document.querySelectorAll('[data-icon]').forEach((el) => setIcon(el, el.dataset.icon));
}
export function createRatingBadge(matches) {
  const badge = document.createElement('span');
  badge.className = 'nsfw-badge';
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', 'R18 · NSFW 图像');
  badge.title = 'R18 · META 命中 ' + matches.join('、');
  setIcon(badge, 'r18');
  return badge;
}
