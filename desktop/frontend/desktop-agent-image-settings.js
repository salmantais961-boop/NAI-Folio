import { MODELS, SAMPLERS, capabilities } from './controls-model.js';
import { IMAGE_SIZES, UC, matchImageSize } from './controls-presets.js';
import { button, element, field, icon, option } from './desktop-agent-elements.js';

const storageKey = 'folio.desktop-agent.image-settings.v1';
const keys = ['model', 'dataset', 'medium', 'width', 'height', 'steps', 'sampler', 'scale', 'seed', 'stream'];
const orientations = { portrait: '竖幅', landscape: '横幅', square: '方形' };

function imageFields(settings) {
  const values = Object.fromEntries(keys.map((key) => [key, settings[key]]));
  const { model, dataset, width, height, steps, sampler, scale, seed } = values;
  if (!MODELS.some(([id]) => id === model) || !Object.hasOwn(SAMPLERS, sampler))
    throw Error('请选择有效的生图模型和采样器。');
  if (
    ![width, height].every((n) => Number.isInteger(n) && n >= 64 && n <= 4096 && n % 64 === 0) ||
    width * height > 3145728
  )
    throw Error('宽、高须为 64 的倍数，合计最多 3,145,728 像素。');
  if (
    !Number.isInteger(steps) ||
    steps < 1 ||
    steps > 50 ||
    !Number.isFinite(scale) ||
    scale < 0 ||
    scale > 10
  )
    throw Error('采样步数范围为 1–50，CFG 范围为 0–10。');
  if (seed !== null && (!Number.isInteger(seed) || seed < 0 || seed > 4294967295))
    throw Error('种子须为 0–4294967295 的整数，留空即可随机。');
  const cap = capabilities(values);
  values.dataset =
    cap.modern && (dataset === 'furry' || (dataset === 'background' && cap.family !== 'v4'))
      ? dataset
      : 'anime';
  values.medium = cap.medium && values.medium === true;
  values.stream = cap.modern && values.stream === true;
  return values;
}

export function createImageSettings(workbench, onChange) {
  let saved, summary, caption, source;
  try {
    const value = JSON.parse(localStorage.getItem(storageKey));
    if (value) saved = imageFields(value);
  } catch {}
  function current() {
    const base = { ...workbench(), mode: 'generate', batch: 1 };
    if (!saved) return base;
    const settings = { ...base, ...saved, agentFixedFraming: true };
    if (!Object.hasOwn(UC[settings.model], settings.uc)) settings.uc = 'none';
    if (!capabilities(settings).v5 && settings.quality === 'light') settings.quality = 'standard';
    return settings;
  }
  function save(values) {
    const next = imageFields(values);
    localStorage.setItem(storageKey, JSON.stringify(next));
    saved = next;
    onChange?.();
  }
  function useSeed(seed) {
    if (!saved) return false;
    save({ ...saved, seed });
    return true;
  }
  function refresh() {
    if (!summary) return;
    const settings = current(),
      model = capabilities(settings).label;
    caption.textContent = model;
    source.textContent = settings.width + ' × ' + settings.height;
    summary.title = '生图设置 · ' + (saved ? 'Agent 专用' : '跟随工作台');
    summary.setAttribute('aria-label', summary.title + ' · ' + model + ' · ' + source.textContent);
  }
  function trigger(open) {
    summary = button('生图设置', 'sliders', open, 'da-image-trigger');
    caption = element('strong');
    source = element('small');
    summary.append(element('span', 'da-image-provider', 'NAI'), caption, source, icon('chevron'));
    refresh();
    return summary;
  }
  function open(container, done) {
    const draft = current();
    let category = matchImageSize(draft.width, draft.height)?.category || 'custom';
    let samplingOpen = false;
    const form = element('form', 'da-subpage da-image-panel');
    const paper = element('section', 'da-image-form');
    const result = element('p', 'da-result');
    result.setAttribute('role', 'status');
    const apply = button('应用到 Agent', 'check', null, 'da-primary', true);
    apply.type = 'submit';
    const actions = element('div', 'da-image-actions');
    actions.append(apply);
    if (saved)
      actions.append(
        button(
          '恢复跟随工作台',
          '',
          () => {
            try {
              localStorage.removeItem(storageKey);
              saved = null;
            onChange?.();
              done();
            } catch {
              result.textContent = '未能更新本机设置，请重试。';
            }
          },
          'da-text-button',
          true,
        ),
      );
    form.append(paper, result, actions);
    container.append(form);

    function select(label, entries, selected, update, disabled = false) {
      const node = element('select');
      for (const [id, name] of entries) node.append(option(id, name));
      node.value = selected;
      node.disabled = disabled;
      node.onchange = () => update(node.value);
      return field(label, node);
    }
    function numeric(label, key, min, max, step, value = draft[key], disabled = false) {
      const node = element('input', 'da-input');
      node.type = 'number';
      Object.assign(node, { min, max, step, disabled, value: value ?? '', required: key !== 'seed' });
      if (key === 'seed') node.placeholder = '随机';
      node.oninput = () => {
        draft[key] = node.value === '' && key === 'seed' ? null : node.valueAsNumber;
        if (key === 'width' || key === 'height') {
          category = matchImageSize(draft.width, draft.height)?.category || 'custom';
          paper.querySelector('select[aria-label="尺寸预设"]').value = category;
          updateRatios();
        }
      };
      return field(label, node);
    }
    function applySize(preset, orientation) {
      const sizes = IMAGE_SIZES[preset];
      if (!sizes) return;
      [draft.width, draft.height] = sizes[orientation] || sizes.portrait;
    }
    function updateRatios() {
      const group = paper.querySelector('.da-image-ratios');
      const match = matchImageSize(draft.width, draft.height);
      group.hidden = category === 'custom';
      for (const child of group.children) {
        child.disabled = !IMAGE_SIZES[category]?.[child.dataset.shape];
        child.setAttribute('aria-pressed', String(match?.orientation === child.dataset.shape));
      }
    }
    function draw() {
      const cap = capabilities(draft),
        medium = cap.medium && draft.medium;
      const engine = element('div', 'da-image-grid'),
        model = select(
          '生成模型',
          MODELS.map(([id, label]) => [id, label]),
          draft.model,
          (id) => {
            draft.model = id;
            if (capabilities(draft).family === 'v4' && draft.dataset === 'background')
              draft.dataset = 'anime';
            draw();
          },
        );
      model.classList.add('da-image-wide');
      engine.append(model);
      if (cap.modern)
        engine.append(
          select(
            '数据集',
            [
              ['anime', 'Anime'],
              ['furry', 'Furry'],
              ...(cap.family !== 'v4' ? [['background', 'Background']] : []),
            ],
            draft.dataset,
            (v) => {
              draft.dataset = v;
            },
          ),
        );
      if (cap.medium)
        engine.append(
          select(
            'NAI 运算强度',
            [
              ['high', 'High'],
              ['medium', 'Medium'],
            ],
            medium ? 'medium' : 'high',
            (v) => {
              draft.medium = v === 'medium';
              draw();
            },
          ),
        );
      const size = element('div', 'da-image-grid');
      const preset = select(
        '尺寸预设',
        [...Object.entries(IMAGE_SIZES).map(([id, p]) => [id, p.label]), ['custom', 'Custom']],
        category,
        (id) => {
          category = id;
          const orientation =
            draft.width === draft.height ? 'square' : draft.width > draft.height ? 'landscape' : 'portrait';
          applySize(id, orientation);
          draw();
        },
      );
      const ratios = element('div', 'da-image-ratios');
      ratios.setAttribute('role', 'group');
      ratios.setAttribute('aria-label', '画幅方向');
      for (const [key, label] of Object.entries(orientations)) {
        const toggle = button(
          label,
          '',
          () => {
            applySize(category, key);
            draw();
          },
          'da-image-ratio',
        );
        toggle.dataset.shape = key;
        ratios.append(toggle);
      }
      size.append(
        preset,
        ratios,
        numeric('宽度 / px', 'width', 64, 4096, 64),
        numeric('高度 / px', 'height', 64, 4096, 64),
      );
      const sampling = element('details', 'da-image-sampling');
      sampling.open = samplingOpen;
      sampling.ontoggle = () => {
        if (sampling.isConnected) samplingOpen = sampling.open;
      };
      const title = element('summary');
      title.append(element('b', '', '采样参数'), icon('chevron'));
      const fields = element('div', 'da-image-grid');
      fields.append(
        numeric('采样步数', 'steps', 1, 50, 1, medium ? 14 : draft.steps, medium),
        numeric('提示词引导 / CFG', 'scale', 0, 10, 0.1),
        select(
          '采样器',
          Object.entries(SAMPLERS),
          medium ? 'k_euler_ancestral' : draft.sampler,
          (v) => {
            draft.sampler = v;
          },
          medium,
        ),
        numeric('种子 / Seed', 'seed', 0, 4294967295, 1),
      );
      if (cap.modern)
        fields.append(
          select(
            '流式预览',
            [
              ['on', '开启'],
              ['off', '关闭'],
            ],
            draft.stream ? 'on' : 'off',
            (v) => {
              draft.stream = v === 'on';
            },
          ),
        );
      sampling.append(title, fields);
      const note = element(
        'p',
        'da-small-note',
        saved ? '当前使用本机保存的 Agent 生图设置。' : '当前跟随工作台。应用后，Agent 将使用这里的设置。',
      );
      paper.replaceChildren(note, engine, element('h3', 'da-section-title', '画幅'), size, sampling);
      updateRatios();
    }
    form.onsubmit = (e) => {
      e.preventDefault();
      try {
        save(draft);
        done();
      } catch (error) {
        result.textContent = error.message || '未能保存生图设置。';
      }
    };
    draw();
  }
  return { current, trigger, open, refresh, useSeed };
}
