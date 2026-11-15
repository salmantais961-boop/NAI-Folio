// Native DOM adaptation of the supplied ThoughtLine component. Keep the line
// mounted across progress events so its timer, motion and disclosure stay stable.
const formatTime = ds => ds < 600
  ? `${(ds / 10).toFixed(1)}s`
  : `${Math.floor(ds / 600)}m ${((ds % 600) / 10).toFixed(1)}s`;
const spokenTime = ds => ds < 600
  ? `${(ds / 10).toFixed(1)} 秒`
  : `${Math.floor(ds / 600)} 分 ${((ds % 600) / 10).toFixed(1)} 秒`;
const paths = {
  sparkle: 'm12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3ZM20 2v4m-2-2h4',
  check: 'm5 12 4.5 4.5L19 7',
  chevron: 'm6 9 6 6 6-6',
  error: 'm7 7 10 10M17 7 7 17',
  stopped: 'M8 7v10M16 7v10',
};
function node(tag, className, text) {
  const el = document.createElement(tag);
  el.className = className;
  if (text != null) el.textContent = text;
  return el;
}
function glyph(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', paths[name]);
  svg.append(path);
  return svg;
}

export function createThoughtLine(initial = {}) {
  const options = {
    label: '思考中…', doneLabel: '已完成', glyph: 'flower', steps: [], content: null,
    collapsible: true, collapseOnSettle: true, working: true, showTimer: true,
    fontSize: 16, breathPeriod: 1.6, breathDepth: 0.45, shimmer: true,
    shimmerDuration: 1.8, settleDuration: 350, settleBlur: 2, ...initial,
  };
  const root = node('div', 'thought-line');
  const head = node('button', 'thought-line__head');
  head.type = 'button';
  const mark = node('span', 'thought-line__glyph');
  const stack = node('span', 'thought-line__label');
  const work = node('span', 'thought-line__text');
  const breath = node('span', 'thought-line__breath');
  const done = node('span', 'thought-line__text thought-line__text--done');
  work.append(breath);
  stack.append(work, done);
  const timer = node('span', 'thought-line__timer', '0.0s');
  const chevron = node('span', 'thought-line__chevron');
  chevron.append(glyph('chevron'));
  for (const el of [mark, stack, timer, chevron]) el.setAttribute('aria-hidden', 'true');
  head.append(mark, stack, timer, chevron);
  const announce = node('span', 'thought-line__sr');
  announce.setAttribute('role', 'status');
  announce.setAttribute('aria-atomic', 'true');
  const trace = node('div', 'thought-line__trace');
  trace.id = 'thought-trace-' + crypto.randomUUID();
  head.setAttribute('aria-controls', trace.id);
  const fold = node('div', 'thought-line__fold');
  const steps = node('ol', 'thought-line__steps');
  const content = node('div', 'thought-line__content');
  fold.append(steps, content);
  trace.append(fold);
  root.append(head, announce, trace);
  const rows = [];
  let open = options.working, working, clock, ds = 0, destroyed = false;
  let startedAt = options.startedAt ?? Date.now();
  let frame;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');

  function placeTimer() {
    if (destroyed) return;
    const active = working ? work : done;
    root.style.setProperty('--tl-shift', `${active.offsetWidth - stack.offsetWidth}px`);
  }
  const resize = new ResizeObserver(placeTimer);
  for (const el of [work, done, stack]) resize.observe(el);
  function paintTime() {
    const seconds = options.elapsed ?? (Date.now() - startedAt) / 1000;
    ds = Math.max(0, Math.floor((Number.isFinite(seconds) ? seconds : 0) * 10));
    timer.textContent = formatTime(ds);
  }
  function stopClock() {
    clearInterval(clock);
    clock = undefined;
  }
  function paintOpen() {
    const hasTrace = rows.length > 0 || content.childElementCount > 0;
    const toggle = hasTrace && options.collapsible;
    root.toggleAttribute('data-open', open && hasTrace);
    trace.toggleAttribute('data-open', open && hasTrace);
    trace.setAttribute('aria-hidden', String(!open || !hasTrace));
    trace.inert = !open || !hasTrace;
    head.toggleAttribute('data-toggle', toggle);
    head.setAttribute('aria-disabled', String(!toggle));
    head.tabIndex = toggle ? 0 : -1;
    if (toggle) head.setAttribute('aria-expanded', String(open));
    else head.removeAttribute('aria-expanded');
    chevron.toggleAttribute('data-on', toggle);
  }
  head.addEventListener('click', () => {
    if ((!rows.length && !content.childElementCount) || !options.collapsible) return;
    open = !open;
    paintOpen();
  });

  // Ease the turning mark home so every settled line rests at the same angle.
  function settleFlower() {
    const flower = mark.querySelector('.thought-line__flower');
    if (!flower || reduce.matches) return;
    const from = getComputedStyle(flower).transform;
    if (!from || from === 'none') return;
    queueMicrotask(() => {
      if (!flower.isConnected) return;
      flower.animate([{ transform: from }, { transform: 'none' }], {
        duration: 700,
        easing: 'cubic-bezier(.16, 1, .3, 1)',
      });
    });
  }
  function update(next = {}) {
    if (destroyed) return;
    const previous = working;
    if (previous === true && 'working' in next && !next.working) settleFlower();
    Object.assign(options, next);
    working = Boolean(options.working);
    if (options.startedAt != null) startedAt = options.startedAt;
    else if (previous === false && working) startedAt = Date.now();
    if (previous !== working) {
      if (working) open = true;
      else if (options.collapseOnSettle) open = false;
    }
    root.className = 'thought-line' + (options.className ? ' ' + options.className : '');
    root.toggleAttribute('data-working', working);
    root.dataset.state = options.state || (working ? 'running' : 'done');
    const vars = {
      font: `${options.fontSize}px`, settle: `${options.settleDuration}ms`, blur: `${options.settleBlur}px`,
      shimmer: `${options.shimmerDuration}s`, breath: `${options.breathPeriod}s`,
      trough: String(1 - Math.min(1, Math.max(0, options.breathDepth))),
      color: options.color || 'var(--mute, #6b6966)', glyph: options.glyphColor || 'currentColor',
    };
    for (const [key, value] of Object.entries(vars)) root.style.setProperty('--tl-' + key, value);
    if (mark.dataset.glyph !== options.glyph) {
      mark.dataset.glyph = options.glyph;
      mark.replaceChildren(options.glyph === 'flower' ? node('span', 'thought-line__flower')
        : options.glyph === 'dot' ? node('span', 'thought-line__dot') : glyph('sparkle'));
    }
    mark.hidden = options.glyph === 'none';
    breath.textContent = options.label;
    breath.toggleAttribute('data-shimmer', options.shimmer);
    done.textContent = options.doneLabel;
    work.toggleAttribute('data-active', working);
    done.toggleAttribute('data-active', !working);
    timer.hidden = !options.showTimer;
    timer.toggleAttribute('data-done', !working);
    chevron.hidden = !options.collapsible;

    const items = options.steps || [];
    for (let i = 0; i < items.length; i++) {
      const item = typeof items[i] === 'string' ? { text: items[i] } : items[i];
      const state = item.state || (!working || i < items.length - 1 ? 'done' : 'running');
      if (!rows[i]) {
        const row = node('li', 'thought-line__step');
        const dot = node('span', 'thought-line__mark');
        dot.setAttribute('aria-hidden', 'true');
        const text = node('span', 'thought-line__step-text');
        row.append(dot, text);
        steps.append(row);
        rows.push({ row, dot, text });
      }
      const { row, dot, text } = rows[i];
      text.textContent = item.text;
      row.toggleAttribute('data-done', state === 'done');
      if (row.dataset.state !== state) {
        row.dataset.state = state;
        dot.replaceChildren(state === 'running' ? node('i', 'thought-line__pulse')
          : glyph(state === 'done' ? 'check' : state === 'error' ? 'error' : 'stopped'));
      }
    }
    while (rows.length > items.length) rows.pop().row.remove();
    steps.hidden = !items.length;
    if (content.firstChild !== (options.content || null))
      content.replaceChildren(...(options.content ? [options.content] : []));
    paintOpen();
    paintTime();
    if (working && options.elapsed == null) {
      clock ??= setInterval(() => {
        if (!root.isConnected) { stopClock(); return; }
        if (!document.hidden) paintTime();
      }, 100);
    } else stopClock();
    head.setAttribute('aria-label', working ? options.label
      : options.doneLabel + (options.showTimer ? '，用时 ' + spokenTime(ds) : ''));
    if (announce.textContent !== head.getAttribute('aria-label'))
      announce.textContent = head.getAttribute('aria-label');
    if (previous === true && !working) options.onSettle?.(ds / 10);
    // Do not read layout for every status event; the observer handles size changes.
    if (previous !== working) {
      root.toggleAttribute('data-glide', previous != null && !reduce.matches);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(placeTimer);
    }
  }
  update();
  return {
    root, update,
    destroy() {
      destroyed = true;
      stopClock();
      cancelAnimationFrame(frame);
      resize.disconnect();
    },
  };
}
