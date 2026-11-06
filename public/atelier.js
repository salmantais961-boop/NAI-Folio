// The printed "ink strip" is sampled exclusively from the selected local image.
async function sampleInks(blob) {
  const bitmap = await createImageBitmap(blob, { resizeWidth: 56, resizeHeight: 56, resizeQuality: 'medium' });
  let pixels;
  try {
    const c = document.createElement('canvas');
    c.width = bitmap.width;
    c.height = bitmap.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    pixels = ctx.getImageData(0, 0, c.width, c.height).data;
  } finally {
    bitmap.close();
  }
  const histogram = new Map();
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 196) continue;
    const r = pixels[i],
      g = pixels[i + 1],
      b = pixels[i + 2],
      key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = histogram.get(key) || [0, 0, 0, 0];
    bucket[0] += r;
    bucket[1] += g;
    bucket[2] += b;
    bucket[3]++;
    histogram.set(key, bucket);
  }
  const colors = Array.from(histogram.values(), ([r, g, b, count]) => [r / count, g / count, b / count, count]);
  const gap = (a, b) => 0.27 * (a[0] - b[0]) ** 2 + 0.48 * (a[1] - b[1]) ** 2 + 0.25 * (a[2] - b[2]) ** 2;
  const chosen = [];
  // A colour needs both a visible area and a perceptible distance from earlier inks.
  for (let n = 0; n < 5 && colors.length; n++) {
    let best = null,
      score = 0;
    for (const c of colors) {
      const d = chosen.length ? Math.min(...chosen.map((p) => gap(c, p))) : 1;
      if (chosen.length && d < 220) continue;
      const s = c[3] ** 0.58 * d;
      if (s > score) {
        score = s;
        best = c;
      }
    }
    if (!best) break;
    chosen.push(best);
  }
  const light = (c) => c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114;
  return chosen
    .sort((a, b) => light(a) - light(b))
    .map(
      (c) =>
        '#' +
        c
          .slice(0, 3)
          .map((v) => Math.round(v).toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase(),
    );
}

function mountColumnGrip() {
  const grip = document.getElementById('column-grip');
  const ws = document.getElementById('studio');
  const media = matchMedia('(min-width: 1000px)');
  const side = grip.parentElement;
  let preferred = 0,
    drag = null,
    at = 0;
  try {
    preferred = Number(localStorage.getItem('folio.editor-width')) || 0;
  } catch {}
  const bounds = () => [332, Math.min(680, Math.floor(ws.clientWidth * 0.47))];
  function layout() {
    if (!media.matches || !ws.clientWidth) {
      ws.style.removeProperty('--user-side');
      return;
    }
    const [min, max] = bounds();
    if (preferred) ws.style.setProperty('--user-side', Math.max(min, Math.min(max, preferred)) + 'px');
    else ws.style.removeProperty('--user-side');
    grip.setAttribute('aria-valuemin', min);
    grip.setAttribute('aria-valuemax', max);
    grip.setAttribute('aria-valuenow', Math.round(side.getBoundingClientRect().width));
  }
  function persist() {
    try {
      if (preferred) localStorage.setItem('folio.editor-width', String(preferred));
      else localStorage.removeItem('folio.editor-width');
    } catch {}
  }
  function change(v) {
    const [min, max] = bounds();
    preferred = Math.round(Math.max(min, Math.min(max, v)));
    layout();
  }
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !media.matches) return;
    drag = e.pointerId;
    at = e.clientX - side.clientWidth;
    grip.setPointerCapture(drag);
    ws.classList.add('resizing');
  });
  grip.addEventListener('pointermove', (e) => {
    if (drag === e.pointerId) change(e.clientX - at);
  });
  grip.addEventListener('lostpointercapture', () => {
    drag = null;
    ws.classList.remove('resizing');
    persist();
  });
  grip.addEventListener('dblclick', () => {
    preferred = 0;
    layout();
    persist();
  });
  grip.addEventListener('keydown', (e) => {
    const [min, max] = bounds(),
      w = side.clientWidth,
      step = e.shiftKey ? 40 : 12;
    const width = { ArrowLeft: w - step, ArrowRight: w + step, Home: min, End: max }[e.key];
    if (width != null) {
      e.preventDefault();
      change(width);
      persist();
    }
  });
  new ResizeObserver(layout).observe(ws);
  layout();
}

export function mountStudioFinish({ notify }) {
  mountColumnGrip();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const palette = document.getElementById('ink-palette'),
    edition = document.getElementById('proof-edition');
  const ws = document.getElementById('studio'),
    cache = new WeakMap();
  let active = null;
  const stage = document.getElementById('canvas-stage');
  const activity = document.createElement('div');
  activity.className = 'proof-activity';
  activity.hidden = true;
  activity.setAttribute('aria-hidden', 'true');
  activity.innerHTML =
    '<i class="activity-seal folio-mark"></i><span class="activity-copy"><span class="activity-label"></span><small class="activity-note"></small></span><time></time>';
  (document.getElementById('proof-status-slot') || stage).append(activity);
  let activityTimer,
    completeTimer,
    started = 0,
    developed = false,
    working = false,
    viewing = true,
    busyMode;
  const stopClock = () => clearInterval(activityTimer);
  const clock = () => {
    const seconds = Math.max(0, Math.floor((performance.now() - started) / 1000));
    activity.querySelector('time').textContent =
      String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  };
  function enter(el, delay = 0) {
    if (!el || reduced.matches || !el.getClientRects().length) return;
    el.animate(
      [
        { opacity: 0.25, transform: 'translateY(5px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      {
        duration: 310,
        delay,
        easing: 'cubic-bezier(.2,.75,.25,1)',
        fill: 'backwards',
      },
    );
  }
  const build = (tag, cl, text) =>
    Object.assign(document.createElement(tag), { className: cl, textContent: text });
  function renderInks(colors) {
    palette.replaceChildren();
    palette.hidden = !colors.length;
    if (!colors.length) return;
    const title = build('span', 'ink-label', '印色'),
      group = build('span', 'ink-register', '');
    for (const [index, color] of colors.entries()) {
      const button = build('button', 'ink-well', '');
      button.type = 'button';
      button.style.setProperty('--ink-well', color);
      button.style.setProperty('--swatch-order', index);
      button.title = '复制 ' + color;
      button.setAttribute('aria-label', '复制印色 ' + color);
      button.onclick = async () => {
        try {
          await navigator.clipboard.writeText(color);
          notify('已复制色值 ' + color);
        } catch {
          notify('色值：' + color);
        }
      };
      group.append(button);
    }
    palette.append(title, group);
    ws.style.setProperty('--plate-ink', colors[Math.floor((colors.length - 1) / 2)]);
    enter(palette);
  }
  function setProof(work, status, ordinal) {
    edition.textContent = work ? 'PLATE ' + String(ordinal).padStart(3, '0') : status || 'STUDIO';
    if (active === work) return;
    active = work;
    palette.hidden = true;
    palette.replaceChildren();
    ws.style.removeProperty('--plate-ink');
    if (!work?.blob) return;
    if (!cache.has(work.blob))
      cache.set(
        work.blob,
        sampleInks(work.blob).catch(() => []),
      );
    cache.get(work.blob).then((colors) => {
      if (active === work) renderInks(colors);
    });
  }
  return {
    enter,
    setProof,
    complete(label, { reveal = true } = {}) {
      stopClock();
      clock();
      developed = true;
      activity.dataset.state = 'complete';
      activity.querySelector('.activity-label').textContent = label;
      activity.querySelector('.activity-note').textContent = !reveal
        ? '新作已收入历史，当前查看保持不变。'
        : label === '超分完成'
          ? '再近一点，细节也动人。'
          : '想象，有了颜色。';
      ws.classList.toggle('is-developed', reveal);
      completeTimer = setTimeout(() => {
        activity.hidden = true;
        ws.classList.remove('is-developed');
        developed = false;
      }, 4200);
    },
    busy(value, mode) {
      working = Boolean(value);
      busyMode = mode;
      ws.classList.toggle('is-exposing', Boolean(value));
      stage.setAttribute('aria-busy', String(working && viewing));
      stopClock();
      if (value) {
        clearTimeout(completeTimer);
        ws.classList.remove('is-developed');
        developed = false;
        started = performance.now();
        activity.dataset.state = 'working';
        activity.querySelector('.activity-label').textContent =
          mode === 'upscale' ? '2× · 超分处理中' : mode === 'augment' ? '图像处理中' : '图像显影中';
        activity.querySelector('.activity-note').textContent = '';
        activity.hidden = false;
        clock();
        activityTimer = setInterval(clock, 1000);
        enter(activity);
      } else if (!developed) activity.hidden = true;
    },
    viewingGeneration(value) {
      viewing = Boolean(value);
      activity.dataset.background = String(!viewing);
      stage.setAttribute('aria-busy', String(working && viewing));
      if (working)
        activity.querySelector('.activity-label').textContent = !viewing
          ? '后台生成中'
          : busyMode === 'upscale'
            ? '2× · 超分处理中'
            : busyMode === 'augment'
              ? '图像处理中'
              : '图像显影中';
    },
  };
}
