import { MODELS, SAMPLERS } from './controls-model.js';

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  element.className = className;
  if (text != null) element.textContent = text;
  return element;
};

// A compact colophon for the displayed image. The display never changes the draft
// until an explicit reuse action is chosen.
export function mountProofNotebook({ host, notify, onUseRecipe, onUseSeed, onReturnGeneration }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let work = null,
    draft = {},
    generation = { active: false, viewing: false, completedWork: null };
  const animations = new Map();
  const heading = node('div', 'pn-heading');
  const caption = node('span', 'pn-caption', '下一张 · 配方札记');
  const returnButton = node('button', 'pn-return');
  returnButton.type = 'button';
  returnButton.hidden = true;
  returnButton.append(node('i', 'pn-signal'), node('span', 'pn-return-copy'));
  returnButton.onclick = () => onReturnGeneration?.();
  heading.append(caption, returnButton);
  const stats = node('div', 'pn-stats');
  const fields = new Map();
  for (const [key, title] of [
    ['model', '模型'],
    ['size', '画幅'],
    ['steps', 'STEPS'],
    ['scale', 'CFG'],
    ['sampler', '采样'],
  ]) {
    const cell = node('span', 'pn-stat');
    const value = node('b', 'pn-value', '—');
    value.dataset.pn = key;
    cell.append(node('small', '', title), value);
    fields.set(key, value);
    stats.append(cell);
  }
  const actions = node('div', 'pn-actions');
  const button = (key, title, action) => {
    const el = node('button', 'pn-action', title);
    el.type = 'button';
    el.dataset.pnAction = key;
    el.onclick = action;
    actions.append(el);
    return el;
  };
  const details = node('div', 'pn-details');
  details.id = 'proof-prompt-details';
  details.hidden = true;
  const promptText = node('p', 'pn-prompt');
  const negativeText = node('p', 'pn-negative');
  details.append(
    node('span', 'pn-detail-label', 'PROMPT'),
    promptText,
    node('span', 'pn-detail-label', 'UNDESIRED'),
    negativeText,
  );
  const detailButton = button('details', '提示词札记', () => {
    const open = details.hidden;
    details.hidden = !open;
    detailButton.setAttribute('aria-expanded', String(open));
    detailButton.textContent = open ? '收起札记' : '提示词札记';
    if (open && !reduced.matches) {
      details.animate(
        [
          { opacity: 0, translate: '0 5px' },
          { opacity: 1, translate: '0 0' },
        ],
        { duration: 230, easing: 'cubic-bezier(.2,.75,.25,1)' },
      );
    }
  });
  detailButton.setAttribute('aria-expanded', 'false');
  detailButton.setAttribute('aria-controls', details.id);
  const copyButton = button('copy', '复制提示词', async () => {
    if (!work) return;
    try {
      await navigator.clipboard.writeText(work.prompt || '');
      notify?.('已复制这张作品的正向提示词');
      copyButton.dataset.done = 'true';
      setTimeout(() => delete copyButton.dataset.done, 1400);
    } catch {
      notify?.('未能访问剪贴板，可展开札记后选择复制。');
    }
  });
  const reuseButton = button('reuse', '复用配方 ↗', async () => {
    const selected = work;
    if (!selected || reuseButton.disabled) return;
    reuseButton.disabled = true;
    try {
      await onUseRecipe?.(selected);
    } catch (error) {
      notify?.(error.message || '配方暂时无法载入');
    } finally {
      reuseButton.disabled = !work;
    }
  });
  const seedButton = button('seed', '沿用种子', () => {
    const seed = work?.settings?.seed;
    if (seed != null) onUseSeed?.(seed);
  });
  const hint = node('span', 'pn-hint', 'Ctrl + Enter 生成 · 滚轮缩放 · F 沉浸查看');
  actions.append(hint);
  host.append(heading, stats, actions, details);

  function replaceValue(element, text) {
    if (element.textContent === text) return;
    const old = element.textContent;
    animations.get(element)?.cancel();
    element.textContent = text;
    element.title = text;
    if (reduced.matches || old === '—' || !element.getClientRects().length) return;
    const animation = element.animate(
      [
        { opacity: 0.2, translate: '0 5px' },
        { opacity: 1, translate: '0 0' },
      ],
      { duration: 220, easing: 'cubic-bezier(.2,.75,.25,1)' },
    );
    animations.set(element, animation);
    animation.onfinish = () => {
      if (animations.get(element) === animation) animations.delete(element);
    };
  }
  function paint() {
    const settings =
      work?.settings || (generation.active && generation.viewing ? generation.settings : null) || draft;
    const mode = work?.mode || settings.mode;
    const noSampling = mode === 'augment' || mode === 'upscale';
    const medium = settings.model === 'nai-diffusion-5-full' && settings.medium;
    caption.textContent = work
      ? '当前作品 · 配方札记'
      : generation.active && generation.viewing
        ? '本次生成 · 配方札记'
        : '下一张 · 配方札记';
    const width = work?.width || settings.width,
      height = work?.height || settings.height;
    const data = {
      model: work?.modelLabel || MODELS.find(([id]) => id === settings.model)?.[1] || '—',
      size: width && height ? `${width} × ${height}` : '—',
      steps: noSampling ? '—' : String(medium ? 14 : (settings.steps ?? '—')),
      scale: noSampling ? '—' : String(settings.scale ?? '—'),
      sampler: noSampling
        ? mode === 'upscale'
          ? '2× 超分'
          : '导演工具'
        : SAMPLERS[medium ? 'k_euler_ancestral' : settings.sampler] || settings.sampler || '—',
    };
    for (const [key, value] of fields) replaceValue(value, data[key]);
    for (const el of [detailButton, copyButton, reuseButton]) el.hidden = !work;
    seedButton.hidden = work?.settings?.seed == null;
    seedButton.title = work?.settings?.seed != null ? '将 ' + work.settings.seed + ' 设为下一次生成的种子' : '';
    hint.hidden = !!work;
    if (!work) {
      details.hidden = true;
      detailButton.setAttribute('aria-expanded', 'false');
      detailButton.textContent = '提示词札记';
    }
    promptText.textContent = work?.prompt || '未记录正向提示词';
    negativeText.textContent = work?.negative || '未记录负面提示词';
    const background = generation.active && !generation.viewing;
    const completed =
      !generation.active && generation.completedWork && generation.completedWork.id !== work?.id;
    returnButton.hidden = !background && !completed;
    returnButton.dataset.state = background ? 'running' : 'complete';
    returnButton.querySelector('.pn-return-copy').textContent = background
      ? '返回生成现场 ↗'
      : '新作已完成 · 查看 ↗';
  }
  const preference = () => {
    if (reduced.matches) {
      for (const animation of animations.values()) animation.cancel();
      animations.clear();
    }
  };
  reduced.addEventListener('change', preference);
  paint();
  return {
    setWork(next) {
      if (work?.id !== next?.id) {
        details.hidden = true;
        detailButton.setAttribute('aria-expanded', 'false');
        detailButton.textContent = '提示词札记';
      }
      work = next || null;
      paint();
    },
    setDraft(settings) {
      draft = settings || {};
      paint();
    },
    setGeneration(next) {
      generation = { ...generation, ...next };
      paint();
    },
    destroy() {
      for (const animation of animations.values()) animation.cancel();
      reduced.removeEventListener('change', preference);
      host.replaceChildren();
    },
  };
}
