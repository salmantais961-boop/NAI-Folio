import { attachAutocomplete, closeSuggestions } from './catalog.js';
import { MODELS, SAMPLERS, seedNumber } from './controls-model.js';
import { setIcon } from './icons.js';
import { makeArtistPlans, makeSamplerPlans, mergeLabTags } from './lab-plans.js';

const scenes = {
  window: ['窗边半身像', '1girl, solo, short dark hair, white shirt, upper body', 'by a window, afternoon light, quiet interior', 'lowres, text, watermark, blurry'],
  coast: ['海岸全身像', '1girl, solo, long hair, sundress, full body', 'rocky shore, sea breeze, overcast sky', 'lowres, text, watermark, blurry'],
  studio: ['素背景肖像', '1boy, solo, black hair, dark jacket, portrait', 'plain background, studio lighting, soft shadow', 'lowres, text, watermark, blurry'],
};
const statusNames = { ready: '待生成', queued: '排队中', running: '生成中', done: '已完成', failed: '失败', stopped: '已停止' };
const modes = { artist: '画师权重', sampler: '采样对照', merge: '标签简写' };
const ns = 'http://www.w3.org/2000/svg';
const num = n => String(n).padStart(2, '0');
const fmt = n => Number(n.toFixed(2)).toString();
function el(tag, cls, text) {
  const part = document.createElement(tag);
  if (cls) part.className = cls;
  if (text != null) part.textContent = text;
  return part;
}
function action(text, cls, glyph) {
  const b = el('button', cls);
  b.type = 'button';
  if (glyph) {
    const icon = el('span', 'lab-icon');
    setIcon(icon, glyph);
    b.append(icon);
  }
  b.append(el('span', '', text));
  return b;
}
function field(title, control) {
  const wrap = el('label', 'lab-field');
  wrap.append(el('span', 'lab-field-name', title), control);
  return wrap;
}
function makeText(value, placeholder, rows = 2) {
  const box = el('textarea');
  box.rows = rows;
  box.spellcheck = false;
  box.placeholder = placeholder;
  box.value = value;
  attachAutocomplete(box);
  return box;
}
function input(type, value) {
  const box = el('input');
  box.type = type;
  box.value = value;
  return box;
}
function svg(tag, attrs) {
  const node = document.createElementNS(ns, tag);
  for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, val);
  return node;
}
function color(i) {
  return 'var(--lab-ink-' + (i % 6) + ')';
}
function weightChart(records, offset) {
  const axes = records[0]?.plan.weights || [];
  if (!axes.length) return null;
  const chart = el('figure', 'lab-chart');
  const caption = el('figcaption', 'lab-chart-head');
  caption.append(el('strong', '', '权重曲线'), el('span', '', '方案 ' + num(offset + 1) + ' — ' + num(offset + records.length)));
  const plotted = axes.slice(0, 6);
  const values = records.flatMap(r => r.plan.weights.slice(0, plotted.length).map(w => w.weight));
  const low = Math.min(...values, 0.65), high = Math.max(...values, 1.35);
  const paper = el('div', 'lab-plot');
  const plot = svg('svg', { viewBox: '0 0 640 90', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const y = v => 5 + 80 * (high - v) / (high - low);
  [high, 1, low].forEach(value => plot.append(svg('line', { x1: 0, x2: 640, y1: y(value), y2: y(value), class: 'lab-grid-line' })));
  plotted.forEach((axis, a) => {
    const pts = records.map((r, i) => [i * 640 / Math.max(1, records.length - 1), y(r.plan.weights[a].weight)]);
    let d = 'M' + pts[0].join(',');
    pts.slice(1).forEach(([x, v], k) => {
      const mid = (pts[k][0] + x) / 2;
      d += ' C' + mid + ',' + pts[k][1] + ' ' + mid + ',' + v + ' ' + x + ',' + v;
    });
    if (!a) plot.append(svg('path', { d: d + ' L640 90 L0 90 Z', fill: color(a), opacity: '.065' }));
    plot.append(svg('path', { d, stroke: color(a), fill: 'none', 'stroke-width': a ? '1.65' : '2.2', 'vector-effect': 'non-scaling-stroke' }));
  });
  const scale = el('div', 'lab-plot-scale');
  scale.append(el('span', '', fmt(high) + '×'), el('span', '', fmt(low) + '×'));
  paper.append(plot, scale);
  const legend = el('div', 'lab-legend');
  plotted.forEach((axis, i) => {
    const key = el('span', '', axis.name);
    key.style.setProperty('--lab-series', color(i));
    key.title = axis.name;
    legend.append(key);
  });
  if (axes.length > plotted.length) legend.append(el('small', '', '显示前 6 组'));
  chart.append(caption, paper, legend);
  return chart;
}

export function mountLab(host, { getSettings, runPlan, getWork, getWorkUrl, onOpenWork, estimate, notify }) {
  host.classList.add('lab-page');
  let mode = 'artist', running = null, timer = 0, merged = null, shown = false;
  let serial = 0, inspected = null, lastBasis = '', pending = false;
  const sessions = {
    artist: { round: 0, rows: [], error: '' }, sampler: { round: 0, rows: [], error: '' },
  };
  const resultLog = [];
  const resultCards = new Map();
  const heading = el('header', 'lab-masthead');
  const title = el('h1', '', '实验室');
  title.append(el('i', '', 'Laboratory'), el('b', 'blue-dot', '.'));
  const basis = el('div', 'lab-basis');
  heading.append(title, basis);
  const tabs = el('div', 'lab-tabs');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', '实验类型');
  Object.entries(modes).forEach(([key, name]) => {
    const b = action(name, 'lab-tab', { artist: 'feather', sampler: 'sliders', merge: 'tag' }[key]);
    b.dataset.mode = key;
    b.onclick = () => switchMode(key);
    tabs.append(b);
  });
  const layout = el('div', 'lab-layout');
  const form = el('section', 'lab-form');
  form.setAttribute('aria-label', '实验条件');
  const paper = el('section', 'lab-sheet');
  paper.setAttribute('aria-label', '实验方案与成图');
  const artistFields = el('div', 'lab-fields'), samplerFields = el('div', 'lab-fields'), mergeFields = el('div', 'lab-fields');
  const artists = makeText('artist:alphonse mucha\nartist:katsushika hokusai\nartist:gustav klimt', '每行一组画师，也可输入一条逗号分隔的画师串', 3);
  const character = makeText(scenes.window[1], '角色、发型、服装与姿态');
  const background = makeText(scenes.window[2], '场所、构图与光线');
  const negative = makeText(scenes.window[3], '每张图共同避开的元素');
  const preset = el('select');
  preset.setAttribute('aria-label', '固定条件预设');
  preset.add(new Option('自定义', ''));
  Object.entries(scenes).forEach(([key, parts]) => preset.add(new Option(parts[0], key)));
  preset.value = 'window';
  const fixedHead = el('div', 'lab-form-head');
  fixedHead.append(el('h3', '', '固定条件'), preset);
  const artistHead = el('div', 'lab-form-head');
  artistHead.append(el('h2', '', '画师配比'), el('i', '', 'Mix'));
  const artistLabel = field('画师串', artists);
  artistLabel.append(el('small', 'lab-note', '每行一组，组内用逗号分隔。'));
  artistFields.append(artistHead, artistLabel, fixedHead, field('单一角色', character), field('背景', background), field('通用负面提示词', negative));

  const prompt = makeText('1girl, portrait, window light, quiet interior', '输入此次对照使用的正向提示词', 3);
  const undesired = makeText(scenes.window[3], '输入固定的负面提示词');
  const manual = input('radio', 'manual'), random = input('radio', 'random');
  manual.name = random.name = 'lab-sampler-method';
  manual.checked = true;
  const method = el('div', 'lab-segments');
  for (const [radio, text] of [[manual, '手动组合'], [random, '随机采样']]) {
    const lbl = el('label');
    lbl.append(radio, el('span', '', text));
    method.append(lbl);
  }
  const samplerList = el('div', 'lab-samplers');
  for (const [key, name] of Object.entries(SAMPLERS)) {
    const lbl = el('label'), check = input('checkbox', key);
    check.checked = ['k_euler_ancestral', 'k_dpmpp_2m'].includes(key);
    lbl.append(check, el('span', '', name));
    samplerList.append(lbl);
  }
  const steps = input('text', '20, 28'), cfg = input('text', '5, 7'), draws = input('number', '6');
  steps.placeholder = '例如 20, 28'; cfg.placeholder = '例如 5, 7';
  draws.min = '1'; draws.max = '64';
  const ranges = el('div', 'lab-field-pair');
  ranges.append(field('步数 / Steps', steps), field('引导 / CFG', cfg));
  const drawField = field('随机方案数', draws);
  const paramHead = el('div', 'lab-form-head');
  paramHead.append(el('h2', '', '固定提示词'), el('i', '', 'Sample'));
  samplerFields.append(paramHead, field('正向提示词', prompt), field('负面提示词', undesired), el('h3', 'lab-form-divider', '参数组合'), method, samplerList, ranges, drawField);
  const seed = input('number', '');
  seed.min = '0'; seed.max = String(0xffffffff); seed.step = '1';
  const seedCell = el('div', 'lab-seed');
  const dice = action('换种子', 'lab-text-button');
  dice.title = '为整批方案换一个固定种子';
  seedCell.append(field('对照种子 / Seed', seed), dice);
  const mergeHead = el('div', 'lab-form-head');
  mergeHead.append(el('h2', '', '原始提示词'), el('i', '', 'Edit'));
  const mergeInput = makeText('0.8::artist:alphonse mucha::, portrait, 0.6::artist:alphonse mucha::, soft light', '粘贴需要归并的画师串或标签', 6);
  mergeFields.append(mergeHead, field('待归并的标签', mergeInput), el('p', 'lab-note', '重复标签按权重平方和近似合并，反向权重按平方强度抵消。'));
  form.append(artistFields, samplerFields, mergeFields, seedCell);

  const sheetHead = el('div', 'lab-sheet-head');
  const sheetTitle = el('h2'), detail = el('p', 'lab-sheet-caption');
  const caption = el('div'); caption.append(sheetTitle, detail);
  const more = action('再取 10 组', 'lab-secondary', 'pixels');
  sheetHead.append(caption, more);
  const overview = el('div', 'lab-overview');
  const boardHead = el('div', 'lab-board-head'), boardMeta = el('span');
  const selectAll = action('全选', 'lab-text-button');
  boardHead.append(boardMeta, selectAll);
  const board = el('div', 'lab-board');
  const message = el('p', 'lab-message');
  message.setAttribute('role', 'status');
  const dock = el('div', 'lab-run-dock');
  const runSummary = el('div', 'lab-run-summary');
  const runTitle = el('strong'), runMeta = el('small');
  runSummary.append(runTitle, runMeta);
  const generate = action('生成所选方案', 'lab-primary', 'arrow-up-right');
  const cancel = action('停止批次', 'lab-secondary', 'x');
  dock.append(runSummary, generate, cancel);
  const mergeOutput = el('div', 'lab-merge-output'), mergeSummary = el('div', 'lab-merge-summary');
  const mergedText = el('pre', 'lab-merged-text');
  mergedText.tabIndex = 0; mergedText.setAttribute('aria-label', '简写后的提示词');
  const copy = action('复制简写', 'lab-primary');
  const toArtist = action('用于画师实验', 'lab-secondary', 'arrow-up-right');
  const apply = el('div', 'lab-output-actions'); apply.append(copy, toArtist);
  mergeOutput.append(mergeSummary, mergedText, apply);
  paper.append(sheetHead, overview, boardHead, board, mergeOutput, message, dock);
  const results = el('section', 'lab-results');
  const resultGrid = el('div', 'lab-result-grid');
  const resultHeading = el('div', 'lab-result-heading');
  const resultCount = el('small');
  resultHeading.append(el('h2', '', '本次成图'), el('i', '', 'Contact sheet.'), resultCount);
  results.append(resultHeading, resultGrid);
  layout.append(form, paper);
  host.append(heading, tabs, layout, results);
  const feedback = text => { message.textContent = text; message.hidden = !text; };
  const session = () => sessions[mode];
  function renderBasis() {
    const base = getSettings();
    const name = MODELS.find(([id]) => id === base.model)?.[1] || base.model;
    basis.replaceChildren(el('span', '', '工作台参数'), el('strong', '', name + '  /  ' + base.width + ' × ' + base.height));
    return base;
  }
  function updatePanels() {
    host.dataset.labMode = mode;
    for (const b of tabs.children) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    artistFields.hidden = mode !== 'artist'; samplerFields.hidden = mode !== 'sampler';
    mergeFields.hidden = mode !== 'merge'; mergeOutput.hidden = mode !== 'merge';
    seedCell.hidden = mode === 'merge'; dock.hidden = mode === 'merge'; drawField.hidden = !random.checked;
    board.hidden = boardHead.hidden = overview.hidden = mode === 'merge';
    more.hidden = mode === 'merge' || mode === 'sampler' && !random.checked;
    more.lastElementChild.textContent = mode === 'artist' ? '再取 10 组' : '追加随机方案';
    sheetTitle.textContent = mode === 'merge' ? '归并结果' : '方案清单';
    detail.textContent = {artist:'同一场景与种子，对照各组画师的影响。', sampler:'固定描述与种子，只改变选定的采样参数。', merge:'相同标签归为一项，保留各自的有效权重。'}[mode];
  }
  function generatePlans(batchRound, base) {
    const seedText = seed.value.trim(), commonSeed = Number(seedText);
    if (!seedText || !Number.isInteger(commonSeed) || commonSeed < 0 || commonSeed > 0xffffffff)
      throw Error('请输入 0 至 4294967295 的整数种子。');
    const options = { settings: base, round: batchRound, seed: commonSeed };
    if (mode === 'artist') return makeArtistPlans({ ...options, artists: artists.value, character: character.value, background: background.value, negative: negative.value });
    return makeSamplerPlans({
      ...options, prompt: prompt.value, negative: undesired.value, random: random.checked,
      samplers: [...samplerList.querySelectorAll('input:checked')].map(box => box.value),
      steps: steps.value, scales: cfg.value, count: Number(draws.value),
    });
  }
  function rebuild(append = false) {
    clearTimeout(timer); pending = false;
    if (running) return;
    const base = renderBasis();
    feedback('');
    if (mode === 'merge') { renderMerge(base); return; }
    const state = session();
    if (!append) { state.round = 0; state.rows = []; inspected = null; }
    try {
      const plans = generatePlans(append ? state.round + 1 : 0, base);
      const prior = new Set(state.rows.map(r => r.signature));
      let added = 0;
      for (const plan of plans) {
        const signature = JSON.stringify([plan.prompt,plan.negative,plan.settings.sampler,plan.settings.steps,plan.settings.scale]);
        if (prior.has(signature)) continue;
        prior.add(signature);
        state.rows.push({ key: ++serial, plan, signature, selected: !append, status:'ready' });
        added++;
      }
      if (append) state.round++;
      state.error = '';
      if (!added) feedback(mode === 'sampler' ? '这一轮没有新的参数组合，可扩展参数范围或再次抽取。' : '这一轮与已有方案重合，可调整画师串或再次取样。');
    } catch (err) {
      if (!append) state.error = err.message;
      feedback(err.message);
    }
    renderPlans();
  }
  function renderMerge(base) {
    try {
      merged = mergeLabTags(mergeInput.value, base.model);
      if (!mergeInput.value.trim()) merged = null;
    } catch (err) { merged = null; feedback(err.message); }
    mergeSummary.replaceChildren();
    if (merged) {
      mergeSummary.append(el('strong', '', merged.before + ' → ' + merged.after), el('span', '', '标签 / 合并 ' + merged.merged + ' 项'));
    }
    mergedText.textContent = merged?.text || '输入标签后，简写结果会出现在这里。';
    copy.disabled = toArtist.disabled = !merged?.text.trim();
  }
  function enqueuePreview() {
    if (running) return;
    clearTimeout(timer);
    pending = true; generate.disabled = true; more.disabled = true;
    if (mode === 'merge') copy.disabled = toArtist.disabled = true;
    timer = setTimeout(() => rebuild(), 170);
  }
  function switchMode(next) {
    if (mode === next || running) return;
    closeSuggestions(); clearTimeout(timer);
    if (pending) rebuild();
    const old = mode;
    mode = next;
    updatePanels(); feedback('');
    paper.classList.remove('lab-change');
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      requestAnimationFrame(() => { if (mode !== old) paper.classList.add('lab-change'); });
    }
    if (mode === 'merge' || !session().rows.length) rebuild();
    else { renderBasis(); renderPlans(); }
  }
  function renderPlans() {
    const state = session(), rows = state.rows;
    if (state.error) feedback(state.error);
    overview.replaceChildren();
    if (rows.length && mode === 'artist') {
      const group = rows.slice(-10);
      const chart = weightChart(group, rows.length - group.length);
      if (chart) overview.append(chart);
    } else if (rows.length && mode === 'sampler') {
      const figures = el('dl', 'lab-statistics');
      const values = rows.map(r => r.plan.settings);
      const range = key => {
        const valuesForKey = values.map(s => s[key]);
        const min = Math.min(...valuesForKey), max = Math.max(...valuesForKey);
        return min === max ? min : min + ' – ' + max;
      };
      for (const [title, value] of [['采样器', new Set(values.map(s => s.sampler)).size], ['步数范围', range('steps')], ['引导范围', range('scale')]]) {
        const group = el('div'); group.append(el('dt', '', title), el('dd', '', value)); figures.append(group);
      }
      overview.append(figures);
    }
    const fragment = document.createDocumentFragment();
    rows.forEach((record, i) => {
      const { plan } = record;
      const card = el('article', 'lab-plan');
      card.dataset.status = record.status;
      const selection = el('label', 'lab-plan-label');
      const box = input('checkbox', String(record.key));
      box.checked = record.selected; box.disabled = Boolean(running) || record.status === 'done';
      box.setAttribute('aria-label', '选择方案 ' + num(i + 1));
      const index = el('span', 'lab-plan-index', num(i + 1));
      const info = el('span', 'lab-plan-info');
      let name = plan.label;
      if (mode === 'artist') {
        const dominant = plan.weights.reduce((best, part) => part.weight > best.weight ? part : best);
        name = dominant.name.replace(/^artist:\s*/i, '');
      }
      const planName = el('strong', '', name);
      planName.title = name;
      info.append(planName, el('small', '', mode === 'artist'
        ? plan.weights.map(w => fmt(w.weight) + '×').join('  /  ')
        : plan.settings.steps + ' 步  /  CFG ' + plan.settings.scale));
      selection.append(box, index, info);
      card.dataset.selected = String(record.selected);
      box.onchange = () => { record.selected = box.checked; card.dataset.selected = String(box.checked); renderRun(); };
      const show = action(inspected === record.key ? '收起' : '详情', 'lab-inspect');
      show.setAttribute('aria-label', '方案 ' + num(i + 1) + ' 详情');
      show.setAttribute('aria-expanded', String(inspected === record.key));
      show.onclick = () => { inspected = inspected === record.key ? null : record.key; renderPlans(); board.querySelector('[data-key="' + record.key + '"] .lab-inspect')?.focus({preventScroll:true}); };
      card.dataset.key = record.key;
      card.append(selection, show);
      if (record.status !== 'ready') card.append(el('small', 'lab-plan-state', statusNames[record.status]));
      if (inspected === record.key) {
        const desc = el('dl', 'lab-plan-detail');
        const lane = (plan.settings.characters || []).filter(c => c.enabled !== false).map(c => c.prompt).join('\n');
        const meta = plan.settings.width + ' × ' + plan.settings.height + '  /  ' + plan.settings.steps + ' 步  /  CFG ' + plan.settings.scale + '  /  ' + (SAMPLERS[plan.settings.sampler] || plan.settings.sampler);
        for (const [title, value] of [['参数', meta],['种子', plan.settings.seed],['正向',plan.prompt], ['角色',lane],['负面',plan.negative],['状态',record.error || record.note]]) {
          if (value === undefined || value === null || value === '') continue;
          desc.append(el('dt','',title),el('dd','',value));
        }
        card.append(desc);
      }
      fragment.append(card);
    });
    board.replaceChildren(fragment);
    boardMeta.textContent = num(rows.length) + ' 组方案';
    renderRun();
  }
  function renderRun() {
    const rows = session().rows, selected = rows.filter(r => r.selected && r.status !== 'done');
    const selectable = rows.filter(r => r.status !== 'done');
    generate.disabled = !!running || pending || !selected.length;
    generate.hidden = !!running;
    cancel.hidden = !running;
    cancel.disabled = Boolean(running?.controller.signal.aborted);
    cancel.lastElementChild.textContent = cancel.disabled ? '正在停止…' : '停止批次';
    selectAll.textContent = selectable.length && selected.length === selectable.length ? '清除选择' : '全选';
    selectAll.disabled = !!running || !selectable.length || pending;
    more.disabled = !!running || pending || !rows.length;
    if (running) {
      runTitle.textContent = '生成中 · ' + running.finished + ' / ' + running.total;
      runMeta.textContent = running.controller.signal.aborted ? '等待当前请求停止' : '完成的图片会自动进入作品集';
    } else {
      runTitle.textContent = '已选 ' + selected.length + ' 张';
      const price = selected.length && estimate?.(selected.map(r => r.plan));
      runMeta.textContent = price || '按方案逐张生成';
    }
    dock.style.setProperty('--lab-progress', running ? (100 * running.finished / running.total) + '%' : '0%');
    dock.toggleAttribute('data-running', !!running);
  }
  function renderResults() {
    const visible = new Set();
    let cursor = resultGrid.firstElementChild;
    for (const item of resultLog) {
      const work = getWork(item.id);
      if (!work) continue;
      visible.add(item.id);
      let card = resultCards.get(item.id);
      if (!card) {
        card = el('button', 'lab-result-card');
        card.type = 'button';
        card.onclick = () => { const saved = getWork(item.id); if (saved) onOpenWork(saved); };
        const img = el('img');
        img.src = getWorkUrl(work);
        img.alt = item.label + '成图';
        img.loading = 'lazy'; img.decoding = 'async';
        if (work.width && work.height) { img.width = work.width; img.height = work.height; }
        const cap = el('span', 'lab-result-caption');
        cap.append(el('strong','',item.label),el('small','',item.meta));
        card.append(img,cap); resultCards.set(item.id, card);
      }
      if (card !== cursor) resultGrid.insertBefore(card, cursor);
      cursor = card.nextElementSibling;
    }
    for (const [id, card] of resultCards) {
      if (!visible.has(id)) { card.remove(); resultCards.delete(id); }
    }
    results.hidden = !visible.size;
    resultCount.textContent = num(visible.size) + ' 张';
  }
  function lockForm(locked) {
    form.inert = locked;
    form.setAttribute('aria-disabled', String(locked));
    for (const b of tabs.children) b.disabled = locked;
  }
  async function run() {
    if (running || pending || mode === 'merge') return;
    const list = session().rows.filter(r => r.selected && r.status !== 'done');
    if (!list.length) return;
    closeSuggestions(); feedback('');
    const controller = new AbortController();
    running = { controller, finished: 0, total: list.length };
    lockForm(true);
    for (const r of list) { r.status = 'queued'; r.error = ''; }
    try {
      for (const r of list) {
        if (controller.signal.aborted) break;
        r.status = 'running'; renderPlans();
        try {
          const result = await runPlan(r.plan, {signal:controller.signal});
          if (!result?.workIds?.length && !result?.generatedCount)
            throw Error(controller.signal.aborted ? '已停止批次。' : '此次请求没有返回成图。');
          r.status = 'done'; r.selected = false; running.finished++;
          if (!result.workIds?.length) r.note = result.text;
          const s = r.plan.settings;
          for (const id of result.workIds || []) resultLog.unshift({
            id, label: r.plan.label, meta: (SAMPLERS[s.sampler] || s.sampler) + ' · ' + s.steps + ' 步 · CFG ' + s.scale,
          });
          renderResults();
        } catch (error) {
          const stopped = controller.signal.aborted;
          r.status = stopped ? 'stopped' : 'failed'; r.error = stopped ? '' : String(error?.message || error);
          feedback(stopped ? '批次已停止，已完成的作品可在下方查看。' : '批次已停在「' + r.plan.label + '」 · ' + r.error);
          break;
        }
      }
      if (controller.signal.aborted) feedback('批次已停止，已完成 ' + running.finished + ' 张。');
      else if (running.finished === running.total) feedback('批次完成，已生成 ' + running.finished + ' 张。');
    } finally {
      for (const r of list) if (r.status === 'queued') r.status = 'ready';
      running = null; lockForm(false); renderPlans();
    }
  }
  selectAll.onclick = () => {
    const selectable = session().rows.filter(r => r.status !== 'done');
    const next = !selectable.every(r => r.selected);
    selectable.forEach(r => r.selected = next); renderPlans();
  };
  generate.onclick = run; cancel.onclick = () => { running?.controller.abort(); renderRun(); };
  more.onclick = () => rebuild(true);
  preset.onchange = () => {
    const scene = scenes[preset.value]; if (!scene) return;
    [character.value,background.value,negative.value] = scene.slice(1);
    enqueuePreview();
  };
  for (const box of [character, background, negative]) box.addEventListener('input', () => { preset.value = ''; });
  const invalidateOtherSeed = () => {
    if (mode !== 'artist') sessions.artist.rows = [];
    if (mode !== 'sampler') sessions.sampler.rows = [];
  };
  seed.addEventListener('input', invalidateOtherSeed);
  dice.onclick = () => { seed.value = String(seedNumber()); invalidateOtherSeed(); rebuild(); };
  form.addEventListener('input', event => {
    if (event.target !== preset) enqueuePreview();
    if (event.target === manual || event.target === random) updatePanels();
  });
  copy.onclick = async () => {
    if (!merged) return;
    try { await navigator.clipboard.writeText(merged.text); notify?.('已复制简写后的提示词'); }
    catch { const range = document.createRange(); range.selectNodeContents(mergedText); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); feedback('已选中结果，可以复制。'); }
  };
  toArtist.onclick = () => { if (merged) { artists.value = merged.text; sessions.artist.rows = []; switchMode('artist'); } };
  function enter() {
    const base = renderBasis();
    if (!lastBasis && base.model === 'nai-diffusion-5-full' && base.medium) {
      negative.value = undesired.value = '';
      preset.value = '';
      steps.value = '14';
      for (const box of samplerList.querySelectorAll('input')) box.checked = box.value === 'k_euler_ancestral';
    }
    if (!seed.value) seed.value = String(base.seed ?? seedNumber());
    const basisKey = JSON.stringify(base);
    if (!running && basisKey !== lastBasis) {
      sessions.artist.rows = []; sessions.sampler.rows = [];
      lastBasis = basisKey;
    }
    updatePanels();
    if (!running && (mode === 'merge' || !session().rows.length)) rebuild();
    else if (mode !== 'merge') renderPlans();
    renderResults();
    if (!shown && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      heading.animate([{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}],{duration:340,easing:'cubic-bezier(.22,.72,.26,1)'});
    shown = true;
  }
  return { enter, leave() { shown = false; closeSuggestions(); } };
}
