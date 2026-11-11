// A live halftone of actual preview pixels. Motion describes waiting, never progress.
// Artwork URLs remain owned by the caller and are never revoked here.
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const ease = (value) => 1 - Math.pow(1 - clamp(value, 0, 1), 3);
const mix = (a, b, amount) => a + (b - a) * amount;
const settle = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

export function mountGenerationAtmosphere(stage) {
  const viewer = stage.querySelector('.pv-window');
  const sheet = viewer?.querySelector('.pv-sheet');
  const artwork = sheet?.querySelector('.pv-image');
  const surface = document.createElement('div');
  surface.className = 'ga-atmosphere';
  surface.hidden = true;
  surface.setAttribute('aria-hidden', 'true');
  const paper = document.createElement('div');
  paper.className = 'ga-paper';
  const wash = document.createElement('canvas');
  wash.className = 'ga-wash';
  const dots = document.createElement('canvas');
  dots.className = 'ga-dots';
  surface.append(paper, wash, dots);
  stage.append(surface);
  const context = dots.getContext('2d', { alpha: true });
  const washContext = wash.getContext('2d', { alpha: true });
  const sample = document.createElement('canvas');
  const sampleContext = sample.getContext('2d', { willReadFrequently: true });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const themeRoot = document.documentElement;
  let active = false;
  let renderable = false;
  let disposed = false;
  let finishing = false;
  let finishReady = false;
  let hasPreview = false;
  let generation = 0;
  let imageVersion = 0;
  let frame = 0;
  let lastTime = 0;
  let elapsed = 0;
  let finishElapsed = 0;
  let entryCutoff = Infinity;
  let sourceURL = '';
  let finalURL = '';
  let naturalWidth = 832;
  let naturalHeight = 1216;
  let columns = 48;
  let rows = 70;
  let targets = new Float32Array();
  let colors = new Float32Array();
  let entryDelays = new Float32Array();
  // Per-cell fill strings, rebuilt only when the rounded colour changes. The
  // field settles within a second, so frames reuse them instead of formatting
  // thousands of rgba() strings.
  let styles = [];
  let styleKeys = new Int32Array();
  let image = null;
  let ambientPalette = null;
  let dark = themeRoot.dataset.theme === 'dark';

  function neutral() {
    // Smooth quiet colour fields, deliberately abstract until real pixels arrive.
    const palette =
      ambientPalette ||
      (dark
        ? [
            [128, 128, 175],
            [107, 159, 155],
            [185, 155, 128],
          ]
        : [
            [143, 137, 190],
            [112, 165, 160],
            [203, 176, 134],
          ]);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const index = (y * columns + x) * 4;
        const a = (Math.sin((x / columns) * 4.1 + (y / rows) * 3.7) + 1) / 2;
        const b = (Math.cos((x / columns) * 3.4 - (y / rows) * 5.6) + 1) * 0.31;
        for (let c = 0; c < 3; c++)
          targets[index + c] = mix(mix(palette[0][c], palette[1][c], a), palette[2][c], b);
        targets[index + 3] = 0.55;
      }
    }
    if (!hasPreview) colors.set(targets);
    updateWash();
  }

  function grid() {
    const ratio = naturalWidth / naturalHeight;
    const count = matchMedia('(pointer: coarse)').matches ? 2600 : 3900;
    columns = clamp(Math.round(Math.sqrt(count * ratio)), 15, 112);
    rows = clamp(Math.round(columns / ratio), 15, 112);
    // Extreme aspect ratios still keep a finite, inexpensive sampling grid.
    if (columns * rows > 4500) rows = Math.floor(4500 / columns);
    targets = new Float32Array(columns * rows * 4);
    colors = new Float32Array(targets.length);
    entryDelays = new Float32Array(columns * rows);
    styles = new Array(columns * rows);
    styleKeys = new Int32Array(columns * rows).fill(-1);
    // A quiet diagonal reveal, with small cell-to-cell offsets instead of rows
    // switching on together. The whole field settles in about 650ms after its pause.
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const noise = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
        const sweep = ((x + 0.5) / columns) * 0.56 + ((y + 0.5) / rows) * 0.44;
        entryDelays[y * columns + x] = 120 + sweep * 375 + (noise - Math.floor(noise)) * 45;
      }
    }
    sample.width = wash.width = columns;
    sample.height = wash.height = rows;
    neutral();
    colors.set(targets);
    if (image) samplePixels(image);
  }

  function updateWash() {
    const pixels = washContext.createImageData(columns, rows);
    for (let i = 0; i < targets.length; i += 4) {
      pixels.data[i] = targets[i];
      pixels.data[i + 1] = targets[i + 1];
      pixels.data[i + 2] = targets[i + 2];
      pixels.data[i + 3] = 255;
    }
    washContext.putImageData(pixels, 0, 0);
  }

  function samplePixels(decoded) {
    sampleContext.clearRect(0, 0, columns, rows);
    // Read the root token directly: a contained child's computed background can
    // still reflect the previous theme during a style-invalidation microtask.
    sampleContext.fillStyle =
      getComputedStyle(themeRoot).getPropertyValue('--proof-paper').trim() || (dark ? '#cfd3d8' : '#e2e4e7');
    sampleContext.fillRect(0, 0, columns, rows);
    sampleContext.drawImage(decoded, 0, 0, columns, rows);
    const pixels = sampleContext.getImageData(0, 0, columns, rows).data;
    // Only this decorative sample is composited; source artwork/alpha is untouched.
    for (let i = 0; i < pixels.length; i += 4) {
      for (let c = 0; c < 3; c++) targets[i + c] = pixels[i + c];
      targets[i + 3] = (targets[i] * 0.2126 + targets[i + 1] * 0.7152 + targets[i + 2] * 0.0722) / 255;
    }
    updateWash();
  }

  function attach() {
    if (!active) return;
    const attached =
      sheet &&
      viewer &&
      !viewer.hidden &&
      (!artwork?.hidden || viewer.dataset.preparing === 'true') &&
      sheet.clientWidth > 0;
    const parent = attached ? sheet : stage;
    if (surface.parentElement !== parent) parent.append(surface);
    surface.classList.toggle('ga-attached', Boolean(attached));
    surface.classList.toggle('ga-floating', !attached);
    if (!attached) {
      const availableWidth = Math.max(1, stage.clientWidth - 8);
      const availableHeight = Math.max(1, stage.clientHeight - 8);
      const scale = Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight);
      surface.style.width = Math.round(naturalWidth * scale) + 'px';
      surface.style.height = Math.round(naturalHeight * scale) + 'px';
    } else {
      surface.style.removeProperty('width');
      surface.style.removeProperty('height');
    }
    const width = surface.clientWidth;
    const height = surface.clientHeight;
    renderable = width > 0 && height > 0;
    if (!renderable) {
      cancelAnimationFrame(frame);
      frame = lastTime = 0;
      return;
    }
    const ratio = Math.min(
      devicePixelRatio || 1,
      1.6,
      1500 / Math.max(width, height),
      Math.sqrt(1100000 / (width * height)),
    );
    const w = Math.max(1, Math.round(width * ratio));
    const h = Math.max(1, Math.round(height * ratio));
    if (dots.width !== w || dots.height !== h) {
      dots.width = w;
      dots.height = h;
    }
    if (reduced.matches) draw(0);
    schedule();
  }

  function draw(delta) {
    if (!active || !context) return;
    const width = dots.width;
    const height = dots.height;
    const stepX = width / columns;
    const stepY = height / rows;
    const step = Math.min(stepX, stepY);
    const t = elapsed / 1000;
    const completion = finishReady ? clamp(finishElapsed / 1120, 0, 1) : 0;
    const washEnter = reduced.matches ? 1 : ease((elapsed - 120) / 650);
    const blend = reduced.matches ? 1 : 1 - Math.exp(-Math.max(delta, 1) / 220);
    const motion = reduced.matches ? 0 : 1;
    const shade = hasPreview ? 1 : 0.7;
    context.clearRect(0, 0, width, height);
    for (let i = 0; i < colors.length; i++) colors[i] = mix(colors[i], targets[i], blend);
    // Draw beyond every edge so a travelling wave never exposes an empty gutter.
    const overscan = 3;
    for (let y = -overscan; y < rows + overscan; y++) {
      for (let x = -overscan; x < columns + overscan; x++) {
        const index = (clamp(y, 0, rows - 1) * columns + clamp(x, 0, columns - 1)) * 4;
        const delay = entryDelays[index / 4];
        const enter = reduced.matches ? 1 : delay > entryCutoff ? 0 : settle((elapsed - delay) / 230);
        const nx = (x + 0.5) / columns;
        const ny = (y + 0.5) / rows;
        const dx = nx - 0.42;
        const dy = ny - 0.48;
        const distance = Math.hypot(dx, dy);
        // A long diagonal swell and a slower circular wave move the lattice together.
        const wave = Math.sin(ny * 10.2 - nx * 4.8 - t * 1.65);
        const ripple = Math.sin(distance * 19 - t * 1.35);
        const braid = Math.sin(ny * 6.2 + nx * 6.6 + t * 0.85);
        const motionX = (wave * 0.78 + ripple * dx * 0.62) * step * motion;
        const motionY = (braid * 0.57 + ripple * dy * 0.62) * step * motion;
        const exit = finishReady ? ease((completion - distance * 0.24) / 0.78) : 0;
        const pulse = 1 + Math.sin(Math.min(1, completion * 2.7) * Math.PI) * 0.2;
        const density = 0.19 + (1 - colors[index + 3]) * 0.25;
        const swell = 0.84 + (wave + 1) * 0.1 + (ripple + 1) * 0.035;
        const radius = step * density * swell * pulse * (1 - exit) * enter;
        if (radius < 0.13) continue;
        const cell = index / 4;
        const r = Math.round(colors[index]), g = Math.round(colors[index + 1]), b = Math.round(colors[index + 2]);
        const key = (r << 16) | (g << 8) | b;
        if (styleKeys[cell] !== key) {
          styleKeys[cell] = key;
          styles[cell] = `rgb(${r},${g},${b})`;
        }
        context.fillStyle = styles[cell];
        context.globalAlpha = shade * (0.84 + braid * 0.1) * (1 - exit * 0.45);
        const release = Math.sin(exit * Math.PI) * step * 1.4;
        context.beginPath();
        context.arc(
          (x + 0.5) * stepX + motionX + dx * release,
          (y + 0.5) * stepY + motionY + dy * release,
          radius,
          0,
          Math.PI * 2,
        );
        context.fill();
      }
    }
    context.globalAlpha = 1;
    const veil = 1 - ease((completion - 0.08) / 0.7);
    paper.style.opacity = String((hasPreview ? 0.97 : 1) * veil);
    wash.style.opacity = String((hasPreview ? 0.5 : 0) * veil * washEnter);
    if (finishing && !reduced.matches && completion > 0.06 && completion < 0.88) {
      // One restrained light ripple marks arrival; the artwork stays the focal point.
      const spread = ease((completion - 0.06) / 0.82);
      const alpha = Math.sin(spread * Math.PI) * 0.13;
      const centerIndex = (Math.floor(rows / 2) * columns + Math.floor(columns / 2)) * 4;
      context.strokeStyle = `rgba(${Math.round(colors[centerIndex])},${Math.round(colors[centerIndex + 1])},${Math.round(colors[centerIndex + 2])},${alpha})`;
      context.lineWidth = Math.max(0.75, step * 0.12);
      context.beginPath();
      context.ellipse(
        width * 0.5,
        height * 0.5,
        width * (0.16 + spread * 0.46),
        height * (0.16 + spread * 0.46),
        0,
        0,
        Math.PI * 2,
      );
      context.stroke();
    }
  }

  function tick(now) {
    frame = 0;
    if (!active || !renderable || document.hidden || disposed || reduced.matches) return;
    if (!lastTime) lastTime = now;
    const delta = Math.min(80, now - lastTime);
    if (delta < 30) return schedule();
    lastTime = now;
    elapsed += delta;
    if (finishReady) finishElapsed += delta;
    draw(delta);
    if (finishReady && finishElapsed >= 1120) {
      // The viewer owns image decoding. Keep our final veil until its source is ready.
      if (!finalURL || artwork?.getAttribute('src') === finalURL || finishElapsed > 2100) return cancel();
    }
    schedule();
  }

  function schedule() {
    if (!frame && active && renderable && !disposed && !document.hidden && !reduced.matches)
      frame = requestAnimationFrame(tick);
  }

  async function loadPixels(url, isFinal = false, paletteOnly = false) {
    if (!url || !active || disposed) return false;
    if (!isFinal && sourceURL === url && hasPreview) return true;
    sourceURL = url;
    const ticket = ++imageVersion;
    const run = generation;
    const decoded = new Image();
    decoded.src = url;
    try {
      await decoded.decode();
      if (!active || run !== generation || ticket !== imageVersion || disposed) return false;
      if (paletteOnly) {
        samplePixels(decoded);
        const bins = new Map();
        for (let i = 0; i < targets.length; i += 4) {
          const rgb = Array.from(targets.slice(i, i + 3));
          const key = rgb.map((v) => Math.round(v / 48)).join(',');
          const bin = bins.get(key) || { count: 0, rgb: [0, 0, 0] };
          bin.count++;
          for (let c = 0; c < 3; c++) bin.rgb[c] += rgb[c];
          bins.set(key, bin);
        }
        const candidates = [...bins.values()]
          .sort((a, b) => b.count - a.count)
          .map((bin) => bin.rgb.map((v) => v / bin.count));
        ambientPalette = candidates
          .filter((rgb, i) => i === 0 || Math.hypot(...rgb.map((v, c) => v - candidates[0][c])) > 75)
          .slice(0, 3);
        while (ambientPalette.length < 3) ambientPalette.push(ambientPalette[0] || [145, 145, 160]);
        neutral();
        if (reduced.matches) draw(0);
        return true;
      }
      const ratioChanged =
        Math.abs(naturalWidth / naturalHeight / (decoded.naturalWidth / decoded.naturalHeight) - 1) > 0.035;
      naturalWidth = decoded.naturalWidth;
      naturalHeight = decoded.naturalHeight;
      image = decoded;
      if (ratioChanged) grid();
      else samplePixels(decoded);
      hasPreview = true;
      surface.dataset.phase = isFinal ? 'complete' : 'preview';
      attach();
      if (reduced.matches) {
        colors.set(targets);
        draw(0);
      }
      return true;
    } catch {
      // A tainted or interrupted decorative sample never prevents the real result.
      if (run === generation && ticket === imageVersion) {
        image = null;
        sample.width = columns;
      }
      return false;
    }
  }

  function begin({ width = 832, height = 1216, mode = 'generate', url = '' } = {}) {
    if (disposed || !context || !sampleContext || !washContext) return;
    cancel();
    active = true;
    generation++;
    naturalWidth = Math.max(1, Number(width) || 832);
    naturalHeight = Math.max(1, Number(height) || 1216);
    surface.hidden = false;
    surface.dataset.phase = 'waiting';
    surface.dataset.mode = mode;
    stage.classList.add('ga-generating');
    sheet?.classList.add('ga-generating-sheet');
    dark = themeRoot.dataset.theme === 'dark';
    grid();
    attach();
    draw(0);
    if (url) void loadPixels(url, false, true);
    schedule();
  }

  function preview(url) {
    if (!active || finishing) return Promise.resolve(false);
    return loadPixels(url);
  }

  async function complete(url) {
    if (!active || disposed || finishing) return;
    const run = generation;
    finishing = true;
    finalURL = url || '';
    // Start the dissolve only once the final colour sample has been decoded.
    if (url) await loadPixels(url, true);
    if (!active || generation !== run || disposed) return;
    surface.dataset.phase = 'complete';
    finishElapsed = 0;
    // A very fast result should not start new decorative dots after it arrives.
    // Dots already appearing may finish their soft growth as they dissolve.
    entryCutoff = elapsed;
    finishReady = true;
    if (reduced.matches) return cancel();
    schedule();
  }

  function cancel() {
    active = false;
    renderable = false;
    finishing = false;
    finishReady = false;
    generation++;
    imageVersion++;
    cancelAnimationFrame(frame);
    frame = lastTime = elapsed = finishElapsed = 0;
    entryCutoff = Infinity;
    hasPreview = false;
    image = null;
    ambientPalette = null;
    sourceURL = finalURL = '';
    surface.hidden = true;
    stage.classList.remove('ga-generating');
    sheet?.classList.remove('ga-generating-sheet');
    if (surface.parentElement !== stage) stage.append(surface);
  }

  function visibility() {
    cancelAnimationFrame(frame);
    frame = lastTime = 0;
    if (!document.hidden) {
      attach();
      schedule();
    }
  }
  function motionPreference() {
    cancelAnimationFrame(frame);
    frame = lastTime = 0;
    if (finishing && reduced.matches) cancel();
    else if (active) {
      colors.set(targets);
      draw(0);
      schedule();
    }
  }
  const sizeObserver = new ResizeObserver(attach);
  sizeObserver.observe(stage);
  if (sheet) sizeObserver.observe(sheet);
  const viewerObserver = new MutationObserver(attach);
  // The viewer moves between the stage and its immersive dialog without changing
  // the artwork. Observe that move as well as source/size changes.
  viewerObserver.observe(stage, { childList: true });
  if (viewer)
    viewerObserver.observe(viewer, { attributes: true, attributeFilter: ['hidden', 'data-preparing'] });
  if (artwork) viewerObserver.observe(artwork, { attributes: true, attributeFilter: ['src', 'hidden'] });
  const themeObserver = new MutationObserver(() => {
    dark = themeRoot.dataset.theme === 'dark';
    if (active) {
      if (image) samplePixels(image);
      else neutral();
      if (reduced.matches) draw(0);
    }
  });
  themeObserver.observe(themeRoot, { attributes: true, attributeFilter: ['data-theme'] });
  document.addEventListener('visibilitychange', visibility);
  reduced.addEventListener('change', motionPreference);

  function destroy() {
    cancel();
    disposed = true;
    sizeObserver.disconnect();
    viewerObserver.disconnect();
    themeObserver.disconnect();
    document.removeEventListener('visibilitychange', visibility);
    reduced.removeEventListener('change', motionPreference);
    surface.remove();
  }
  return { begin, preview, complete, cancel, destroy };
}
