import { mountFolioSelects } from './folio-select.js';

const steps = {
  nai: { service: 'NovelAI', title: '连接图像服务', note: '选择官方服务或中转站，连接用于生图的账户。' },
  llm: { service: 'Agent', title: '连接语言模型', note: '选择用来对话、查角色和编写提示词的模型。' },
};

function el(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text) item.textContent = text;
  return item;
}

function action(label, className, type = 'button') {
  const item = el('button', className, label);
  item.type = type;
  return item;
}

const enterEase = 'cubic-bezier(.16,.74,.23,1)';
const travelEase = 'cubic-bezier(.65,0,.23,1)';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function animate(node, frames, duration, easing = enterEase) {
  if (reduced()) return Promise.resolve();
  return node.animate(frames, { duration, easing }).finished.catch(() => {});
}

function progress(kind) {
  const list = el('ol', 'fw-progress');
  list.setAttribute('aria-label', '初始设置进度');
  for (const [key, label] of [['nai', '图像'], ['llm', '对话']]) {
    const step = el('li', '', label);
    if (key === kind) step.setAttribute('aria-current', 'step');
    if (key === 'nai' && kind === 'llm') step.classList.add('fw-visited');
    list.append(step);
  }
  return list;
}

export async function runFirstRun(opening, fields, { initialStep = 'nai', intro, onStep, onFinish } = {}) {
  const brand = opening.querySelector('.desktop-signature');
  opening.classList.add('fw-onboarding');
  opening.removeAttribute('aria-hidden');
  opening.setAttribute('role', 'dialog');
  opening.setAttribute('aria-label', 'Folio 初始设置');
  brand.setAttribute('aria-hidden', 'true');
  opening.dataset.fwPhase = 'intro';
  opening.dataset.fwBrand = 'home';
  if (intro) await intro;
  else await animate(brand, [{ opacity: 0, filter: 'blur(10px)' }, { opacity: 1, filter: 'blur(0px)' }], 620);

  const layer = el('div', 'fw-viewport');
  layer.hidden = true;
  opening.append(layer);
  const raised = 'translateY(calc(var(--fw-brand-center) - 50dvh)) scale(var(--fw-brand-scale))';
  const home = 'translateY(0) scale(1)';
  const saved = new Set();
  let controls, selects, current, locked = true;
  let complete, failFlow;
  const finished = new Promise((resolve, reject) => { complete = resolve; failFlow = reject; });

  function releaseStep() {
    controls?.destroy?.();
    selects?.destroy();
    controls = selects = null;
  }
  function moveBrand(up) {
    opening.dataset.fwBrand = up ? 'raised' : 'home';
    return animate(brand, [{ transform: up ? home : raised }, { transform: up ? raised : home }],
      up ? 760 : 820, travelEase);
  }
  async function dismissStep(backwards = false) {
    if (!current) return;
    current.inert = true;
    await animate(current, [{ opacity: 1, transform: 'none' }, {
      opacity: 0, transform: 'translateY(' + (backwards ? 7 : -7) + 'px)',
    }], 135);
    releaseStep();
    current.remove();
    current = null;
  }
  async function showStep(kind, backwards = false) {
    if (current) await dismissStep(backwards);
    const page = el('section', 'fw-page');
    const copy = el('div', 'fw-copy');
    const word = el('div', 'fw-service', steps[kind].service);
    word.lang = 'en';
    const title = el('h1', 'fw-title', steps[kind].title);
    title.tabIndex = -1;
    copy.append(progress(kind), word, title, el('p', 'fw-note', steps[kind].note));

    const form = el('form', 'fw-form');
    form.noValidate = true;
    const fieldsRoot = el('div', 'fw-fields');
    const error = el('p', 'fw-error');
    error.setAttribute('role', 'alert');
    const buttons = el('div', 'fw-actions');
    const primary = action(kind === 'nai' ? '下一步' : '完成设置', 'fw-primary', 'submit');
    const skip = action('暂时跳过', 'fw-text');
    const back = action('上一步', 'fw-text fw-back');
    back.hidden = kind === 'nai';
    buttons.append(back, skip, primary);
    form.append(fieldsRoot, error, buttons);
    page.append(copy, form);
    layer.replaceChildren(page);
    layer.hidden = false;
    layer.scrollTop = 0;
    current = page;
    controls = fields.mountStep(kind, fieldsRoot);
    selects = mountFolioSelects(fieldsRoot);

    async function advance(save) {
      if (locked || current !== page) return;
      locked = true;
      error.textContent = '';
      for (const b of buttons.children) b.disabled = true;
      form.setAttribute('aria-busy', 'true');
      try {
        if (save) {
          await controls.submit();
          saved.add(kind);
        }
      } catch (e) {
        error.textContent = e?.message || '请检查连接设置后重试。';
        for (const b of buttons.children) b.disabled = false;
        form.removeAttribute('aria-busy');
        locked = false;
        return;
      }
      if (kind === 'nai') {
        onStep?.('llm');
        await showStep('llm');
      }
      else complete(saved.size ? 'complete' : 'skipped');
    }
    form.addEventListener('submit', event => { event.preventDefault(); void advance(true).catch(failFlow); });
    skip.onclick = () => void advance(false).catch(failFlow);
    back.onclick = () => {
      if (locked || current !== page) return;
      locked = true;
      void showStep('nai', true).catch(failFlow);
    };
    opening.dataset.fwPhase = kind;
    title.focus({ preventScroll: true });
    locked = false;
    void animate(copy, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], 360);
    void animate(form, [{ opacity: 0, transform: 'translateY(15px)' }, { opacity: 1, transform: 'none' }], 440);
  }
  try {
    opening.dataset.fwPhase = 'rise';
    const ascent = moveBrand(true);
    if (!reduced()) await wait(280);
    await showStep(initialStep === 'llm' ? 'llm' : 'nai');
    const [, result] = await Promise.all([ascent, finished]);
    const success = el('div', 'fw-success');
    async function celebrate() {
      await dismissStep();
      success.setAttribute('role', 'status');
      const mark = el('i', 'fw-success-mark');
      mark.setAttribute('aria-hidden', 'true');
      success.append(mark, el('h2', '', result === 'complete' ? '设置完成' : '已准备就绪'));
      layer.append(success);
      opening.dataset.fwPhase = 'success';
      await Promise.all([
        animate(success, [{ opacity: 0, transform: 'translateY(7px)' }, { opacity: 1, transform: 'none' }], 340),
        wait(reduced() ? 260 : 880),
      ]);
    }
    await Promise.all([onFinish?.(result), celebrate()]);
    await animate(success, [{ opacity: 1 }, { opacity: 0 }], 160);
    layer.hidden = true;
    opening.dataset.fwPhase = 'return';
    await moveBrand(false);
    opening.dataset.fwPhase = 'exit';
    await Promise.all([
      animate(brand, [
        { opacity: 1, filter: 'blur(0px)', transform: home },
        { opacity: 0, filter: 'blur(12px)', transform: 'scale(1.025)' },
      ], 510, 'cubic-bezier(.45,0,.75,.5)'),
      animate(opening, [
        { opacity: 1 }, { offset: .35, opacity: 1 }, { opacity: 0 },
      ], 510, 'ease-in'),
    ]);
    return result;
  } finally {
    releaseStep();
    fields.destroy?.();
  }
}
