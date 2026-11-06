import { BRAND_PATH, BRAND_VIEWBOX, BRAND_FILL_RULE } from './brand-shape.js';

// Use the same static silhouette everywhere, including marks mounted later by
// model controls, generation status and the archive. No motion is attached.
const svgNS = 'http://www.w3.org/2000/svg';
function mount(mark) {
  if (mark.hasAttribute('data-brand-static')) return;
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'brand-flower');
  svg.setAttribute('viewBox', BRAND_VIEWBOX);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', BRAND_PATH);
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('fill-rule', BRAND_FILL_RULE);
  svg.append(path);
  mark.replaceChildren(svg);
  mark.setAttribute('data-brand-static', '');
}
function collect(root) {
  if (!(root instanceof Element)) return;
  if (root.matches('.folio-mark')) mount(root);
  for (const mark of root.querySelectorAll('.folio-mark')) mount(mark);
}
collect(document.documentElement);
new MutationObserver((records) => {
  for (const record of records) for (const node of record.addedNodes) collect(node);
}).observe(document.documentElement, { childList: true, subtree: true });
