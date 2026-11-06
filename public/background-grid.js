import { mountDotGrid } from './vendor/dot-grid.js';

// The user's Dot Grid preset, softened and confined to the image canvas.
const host = document.getElementById('background-grid');
const root = document.documentElement;
const options = () => ({
  dotSize: 4,
  gap: 27,
  strength: 0.3,
  tension: 0.35,
  glow: 0.35,
  stretch: 0.1,
  swell: 0.12,
  shockStrength: 0.45,
  shockRadius: 180,
  opacity: 0.65,
  intro: false,
  baseColor: getComputedStyle(host).getPropertyValue('--dot-base').trim(),
  activeColor: getComputedStyle(host).getPropertyValue('--dot-active').trim(),
});

// Keep a quiet static version on machines where WebGL2 is unavailable.
function mountStaticTexture(container) {
  const canvas = document.createElement('canvas');
  canvas.className = 'dot-grid__canvas';
  canvas.setAttribute('aria-hidden', 'true');
  container.append(canvas);
  const context = canvas.getContext('2d');
  let frame = 0;
  function draw() {
    frame = 0;
    if (!context || !container.clientWidth || !container.clientHeight) return;
    const width = container.clientWidth,
      height = container.clientHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.scale(dpr, dpr);
    context.fillStyle = options().baseColor;
    context.globalAlpha = options().opacity;
    const { dotSize, gap } = options();
    const cell = dotSize + gap;
    const columns = Math.max(1, Math.floor((width + gap) / cell));
    const rows = Math.max(1, Math.floor((height + gap) / cell));
    const startX = (width - (columns * cell - gap)) / 2 + dotSize / 2;
    const startY = (height - (rows * cell - gap)) / 2 + dotSize / 2;
    context.beginPath();
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        const x = startX + col * cell,
          y = startY + row * cell;
        context.moveTo(x + dotSize / 2, y);
        context.arc(x, y, dotSize / 2, 0, Math.PI * 2);
      }
    }
    context.fill();
  }
  const update = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };
  const size = new ResizeObserver(update);
  size.observe(container);
  update();
  return {
    update,
    destroy() {
      cancelAnimationFrame(frame);
      size.disconnect();
      canvas.remove();
    },
  };
}

if (host) {
  let renderer;
  try {
    renderer = mountDotGrid(host, options());
  } catch {
    /* A decorative layer cannot block the studio. */
  }
  const fallback = () => {
    if (host.dataset.renderer === 'static') return;
    renderer?.destroy();
    renderer = mountStaticTexture(host);
    host.dataset.renderer = 'static';
  };
  if (!renderer?.supported) fallback();
  else {
    host.dataset.renderer = 'webgl';
    host.addEventListener('dotgridcontextlost', fallback, { once: true });
  }
  const theme = new MutationObserver(() => renderer.update(options()));
  theme.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    theme.disconnect();
    host.removeEventListener('dotgridcontextlost', fallback);
    renderer.destroy();
  });
}
