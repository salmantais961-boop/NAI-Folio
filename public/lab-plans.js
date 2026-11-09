import { capabilities, initial, MODELS, SAMPLERS, seedNumber, requestFor } from './controls-model.js';
import { resolvePromptReferences } from './chunks.js';

const maximumPlans = 64;
const turn = Math.PI * 2;
const goldenStep = (Math.sqrt(5) - 1) / 2;
const separators = /[,，、\n]/u;
const laneHeader = /^[\t ]*(?:(?:character|角色)\s*\d+|(?:positive|negative|base|global|main)(?:\s+prompt)?|undesired content|正向提示词|负面提示词|全局提示词)\s*[:：][\t ]*/gimu;

function modelProfile(model) {
  if (!MODELS.some(([id]) => id === model)) throw Error('请选择有效的 NAI 模型。');
  return capabilities({ model, mode: 'generate' });
}

function weightText(tag, weight, cap) {
  if (!Number.isFinite(weight) || Math.abs(weight) > 1e6) throw Error('权重超出可计算范围，请降低数值。');
  if (weight === 1) return tag;
  if (cap.family === 'v4' && weight < 0) throw Error('当前 V4 模型不支持负权重，请使用 V4.5 或 V5。');
  if (cap.modern) {
    const value = Number(weight.toFixed(6));
    if (weight && !value) throw Error('权重低于六位小数的精度，请调整输入。');
    return value === 1 ? tag : value + '::' + tag + '::';
  }
  if (weight <= 0) throw Error('V3 仅支持正权重。');
  const layers = Math.round(Math.log(weight) / Math.log(1.05));
  if (Math.abs(layers) > 80) throw Error('V3 需要过多层括号，请缩小权重范围或选择新版模型。');
  return layers > 0 ? '{'.repeat(layers) + tag + '}'.repeat(layers)
    : '['.repeat(-layers) + tag + ']'.repeat(-layers);
}

// Record complete syntax spans once. Random choices and macro references
// remain independent occurrences; parenthesized character names can contain commas.
function syntaxSpans(text, headerEnds) {
  const spans = new Map(), emphasis = [], parens = [];
  const pattern = /\\[\s\S]|!macro:[^!\n]+!|!macro:|\|\|[\s\S]*?\|\||\|\||[+-]?(?:\d+(?:\.\d*)?|\.\d+)::|::|[{}\[\]()]/gu;
  for (const match of text.matchAll(pattern)) {
    const token = match[0], from = match.index, end = from + token.length;
    if (token === '!macro:' || token === '||') throw Error('发现未闭合的词块或随机分支。');
    if (token.startsWith('\\') || token.startsWith('!') || token.startsWith('||')) {
      spans.set(from, { end, opaque: !token.startsWith('\\') });
      continue;
    }
    if (token === '(' || token === ')') {
      if (token === '(') parens.push(from);
      else if (parens.length) spans.set(parens.pop(), { end });
      continue;
    }
    let closeAt = from;
    if (token.endsWith('::') && token !== '::') {
      let previous = from - 1;
      while (previous >= 0 && /[\t ]/u.test(text[previous])) previous--;
      // Digits at the end of a name (such as year 2025::) belong to that name.
      let next = end;
      while (next < text.length && /[\t ]/u.test(text[next])) next++;
      const finalNumber = emphasis.at(-1)?.closing === '::' &&
        (next === text.length || /[,，、\n|｜}\]]/u.test(text[next]));
      if (!finalNumber && (headerEnds.has(from) || previous < 0 || /[,，、\n|｜{\[]/u.test(text[previous]) ||
          text.slice(previous - 1, previous + 1) === '::')) {
        emphasis.push({ from, inner: end, closing: '::', factor: Number(token.slice(0, -2)) });
        continue;
      }
      closeAt = end - 2;
    } else if (token === '{' || token === '[') {
      emphasis.push({ from, inner: end, closing: token === '{' ? '}' : ']', factor: token === '{' ? 1.05 : 1 / 1.05 });
      continue;
    }
    const group = emphasis.pop();
    if (!group || group.closing !== (token.endsWith('::') ? '::' : token)) throw Error('权重组未正确闭合，请检查 ::、{} 和 []。');
    spans.set(group.from, { ...group, closeAt, end });
  }
  if (emphasis.length) throw Error('发现未闭合的权重组，请检查 ::、{} 和 []。');
  return spans;
}

function readTags(text) {
  if (text.length > 100000) throw Error('提示词超过 100,000 字符，请分段处理。');
  const headers = new Map([...text.matchAll(laneHeader)].map(m => [m.index, m[0]]));
  const spans = syntaxSpans(text, new Set([...headers].map(([offset, header]) => offset + header.length)));
  const lanes = [];
  let lane = { start: 0, prefix: '', tags: [] }, axis;

  function read(from, to, factor, depth) {
    if (depth > 100) throw Error('提示词权重嵌套过深。');
    let at = from, opaque = false;
    function finish(end) {
      const raw = text.slice(at, end);
      const name = raw.trim();
      if (!name) return;
      if (depth === 0) axis = { name };
      const start = at + (raw.length - raw.trimStart().length);
      const span = spans.get(start);
      if (span?.factor !== undefined && span.end === start + name.length) {
        read(span.inner, span.closeAt, factor * span.factor, depth + 1);
      } else {
        // Mixed emphasis inside a tag cannot be replaced by one scalar.
        const literal = name.toLowerCase().replace(/^(artist|character)\s*:\s*/u, '$1:');
        const key = /^(?:._.|<[^<>]+>_<[^<>]+>)$/u.test(literal) ? literal : literal.replaceAll('_', ' ').replace(/\s+/gu, ' ');
        lane.tags.push({ name, weight: factor, key: opaque ? null : key, axis });
      }
    }
    for (let i = from; i < to;) {
      const header = headers.get(i);
      const pipe = text[i] === '|' || text[i] === '｜';
      const span = spans.get(i);
      if (span && span.end <= to) {
        opaque ||= Boolean(span.opaque || span.factor !== undefined);
        i = span.end;
        continue;
      }
      if (!header && !pipe && !separators.test(text[i])) { i++; continue; }
      finish(i);
      opaque = false;
      if (header || pipe) {
        if (depth) throw Error('请在权重组外分隔角色或提示词区段。');
        const prefix = header || text[i];
        lanes.push({ ...lane, original: text.slice(lane.start, i) });
        i += prefix.length;
        lane = { start: i, prefix, tags: [] };
      } else i++;
      at = i;
    }
    finish(to);
  }
  read(0, text.length, 1, 0);
  lanes.push({ ...lane, original: text.slice(lane.start) });
  return lanes;
}

export function mergeLabTags(text, model = initial.model) {
  const cap = modelProfile(model);
  const lanes = readTags(String(text ?? ''));
  let before = 0, after = 0;
  const output = lanes.map(({ tags, original, prefix }) => {
    before += tags.length;
    const terms = [], seen = new Map();
    for (const tag of tags) {
      const energy = tag.weight * Math.abs(tag.weight);
      const existing = tag.key && seen.get(tag.key);
      if (existing) {
        existing.energy += energy;
        existing.count++;
      } else {
        const term = { ...tag, energy, count: 1 };
        if (tag.key) seen.set(tag.key, term);
        terms.push(term);
      }
    }
    after += terms.length;
    if (terms.length === tags.length) return prefix + original;
    const leading = original.match(/^\s*/u)[0], trailing = original.match(/\s*$/u)[0];
    return prefix + leading + terms.map(term => {
      const weight = term.count === 1 ? term.weight : Math.sign(term.energy) * Math.sqrt(Math.abs(term.energy));
      return weightText(term.name, weight, cap);
    }).join(', ') + trailing;
  });
  return { text: output.join(''), before, after, merged: before - after };
}

function baseSettings(settings, seed) {
  const base = { ...initial, ...settings, seed: seed ?? settings?.seed ?? seedNumber(),
    mode: 'generate', batch: 1, quality: 'off', uc: 'none', characters: [], useCoords: false,
    references: [], source: null, mask: null, enhance: 'off' };
  const cap = modelProfile(base.model);
  if (!Number.isInteger(base.seed) || base.seed < 0 || base.seed > 0xffffffff) throw Error('种子应为 0–4294967295 的整数。');
  if (cap.v5) base.noiseSchedule = 'karras';
  if (cap.medium && base.medium) Object.assign(base, { sampler: 'k_euler_ancestral', steps: 14, cfgRescale: 0 });
  return base;
}

function fixed(value, seed, field) {
  const text = String(value ?? '');
  let hash = seed;
  for (const ch of field + '\0' + text) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619);
  return resolvePromptReferences(text, undefined, randomStream(hash, 0)).text;
}

function validated(plans) {
  const first = plans[0];
  requestFor(first.settings, first.prompt, first.negative, { lockNegative: true });
  return plans;
}
function checkNegative(base, negative) {
  if (capabilities(base).medium && base.medium && negative.trim())
    throw Error('V5 Full · Medium 使用固定负面词。要指定负面词，请在工作台把运算强度切到 High。');
}

function randomStream(seed, round) {
  if (!Number.isSafeInteger(round) || round < 0) throw Error('实验轮次无效。');
  let state = (seed ^ Math.imul(round + 1, 0x9e3779b9)) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeArtistPlans({ artists, background = '', character = '', negative = '', settings = {}, round = 0, seed }) {
  const base = baseSettings(settings, seed), cap = capabilities(base);
  const random = randomStream(base.seed, round);
  const lines = (Array.isArray(artists) ? artists : String(artists ?? '').split(/\r?\n/u)).map(s => String(s).trim()).filter(Boolean);
  if (!lines.length) throw Error('先填一组画师或标签，再生成权重方案。');
  const groups = lines.map((name, index) => {
    const sections = readTags(fixed(name, base.seed, 'artist' + index));
    if (sections.length !== 1) throw Error('画师串里不能包含角色段，请把角色移到固定角色栏。');
    if (!sections[0].tags.some(tag => tag.weight !== 0)) throw Error('画师串不能为空或全为零权重。');
    return { name, tags: sections[0].tags };
  });
  // A single comma list is the common quick-entry form. Multiple lines let
  // a user bind several tags together and keep their internal weight ratios.
  let axes = groups;
  if (groups.length === 1) {
    const components = new Map();
    for (const tag of groups[0].tags) {
      if (!components.has(tag.axis)) components.set(tag.axis, { name: tag.axis.name, tags: [] });
      components.get(tag.axis).tags.push(tag);
    }
    axes = [...components.values()];
  }
  const backdrop = fixed(background, base.seed, 'background'), cast = fixed(character, base.seed, 'character');
  const uc = fixed(negative, base.seed, 'negative');
  checkNegative(base, uc);
  if ([backdrop, cast, uc].some(s => /[|｜]/u.test(s))) throw Error('画师实验固定一个角色，请分别填写角色、背景和负面词。');
  if (cast.trim() && cap.chars) base.characters = [{ enabled: true, prompt: cast, negative: '', x: .5, y: .5 }];
  const phaseOffset = random(), seen = new Set(), plans = [];
  for (let i = 0; plans.length < 10 && i < 200; i++) {
    const phase = turn * (phaseOffset + (i % 10) / 10 + Math.floor(i / 10) * goldenStep);
    const amplitude = .65 + .3 * random();
    let multipliers;
    if (axes.length <= 2) {
      // Stratify the sweep: each of ten rows explores a distinct intensity
      // interval, including when there is only one artist to strengthen.
      const t = ((i % 10) + .1 + .8 * random()) / 10;
      const smooth = .5 * t + .5 * t * t * (3 - 2 * t);
      const first = .4 + 1.2 * smooth;
      multipliers = axes.length === 1 ? [2 ** (2 * smooth - 1)] : [first, 2 - first];
    } else {
      const levels = axes.map((_, k) => Math.exp(amplitude * Math.cos(phase - turn * k / axes.length)));
      const mean = levels.reduce((sum, w) => sum + w, 0) / levels.length;
      multipliers = levels.map(w => .25 + .75 * w / mean);
    }
    const weights = axes.map((axis, k) => ({ name: axis.name, weight: Number(multipliers[k].toFixed(3)) }));
    const weighted = axes.flatMap((axis, k) => axis.tags.map(tag => weightText(tag.name, tag.weight * weights[k].weight, cap)));
    const prompt = [...weighted, backdrop, !cap.chars && cast].filter(Boolean).join(', ');
    if (seen.has(prompt)) continue;
    seen.add(prompt);
    const n = plans.length + 1;
    plans.push({ id: 'artist-' + base.seed + '-' + round + '-' + n, label: '权重方案 ' + n,
      prompt, negative: uc, settings: structuredClone(base), weights });
  }
  if (plans.length < 10) throw Error('这组权重在当前模型中无法区分出十种结果，请调整初始权重。');
  return validated(plans);
}

function numbers(value, fallback, min, max, integer, label) {
  const inputs = typeof value === 'string' ? value.trim().split(/[\s,，、;；]+/u)
    : Array.isArray(value) ? value : value == null ? [] : [value];
  const useDefault = !inputs.length || (inputs.length === 1 && inputs[0] === '');
  const list = (useDefault ? fallback : inputs).map(v =>
    (typeof v === 'number' || (typeof v === 'string' && v.trim())) ? Number(v) : NaN);
  if (list.some(v => !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))))
    throw Error(label + '应在 ' + min + '–' + max + ' 之间' + (integer ? '，并使用整数。' : '。'));
  return [...new Set(list)];
}

export function makeSamplerPlans({ prompt, negative = '', settings = {}, samplers, steps, scales, random = false, count = 10, round = 0, seed }) {
  const base = baseSettings(settings, seed), shuffle = randomStream(base.seed, round);
  const positive = fixed(prompt, base.seed, 'prompt'), uc = fixed(negative, base.seed, 'negative');
  if (!positive.trim()) throw Error('先填写固定正向提示词。');
  checkNegative(base, uc);
  const medium = capabilities(base).medium && base.medium;
  const available = medium ? ['k_euler_ancestral'] : Object.keys(SAMPLERS);
  const selected = [...new Set(samplers ?? (random ? available : [base.sampler]))];
  if (!selected.length) throw Error('请至少选择一种采样器。');
  if (selected.some(id => !available.includes(id)))
    throw Error(medium ? 'Medium 只支持 Euler Ancestral。' : '存在未支持的采样器。');
  const stepValues = numbers(steps, random && !medium
    ? [-6, 0, 6].map(n => Math.max(1, Math.min(50, base.steps + n))) : [base.steps], 1, 50, true, '步数');
  const cfgValues = numbers(scales, random
    ? [-1.5, -.75, 0, .75, 1.5].map(n => Math.max(0, Math.min(10, Number((base.scale + n).toFixed(2))))) : [base.scale], 0, 10, false, 'CFG');
  if (medium && stepValues.some(s => s !== 14)) throw Error('Medium 的采样步数固定为 14。');
  const size = selected.length * stepValues.length * cfgValues.length;
  if (!random && size > maximumPlans) throw Error('本次可比较至多 64 组，请减少参数组合。');
  if (random && (!Number.isInteger(count) || count < 1 || count > maximumPlans)) throw Error('每轮随机抽取 1–64 个方案。');
  // Sample combination indices without replacement, without allocating the
  // entire Cartesian product when a user supplies a long parameter list.
  const limit = random ? Math.min(count, size) : size;
  const swapped = new Map(), plans = [];
  for (let i = 0; i < limit; i++) {
    const draw = random ? i + Math.floor(shuffle() * (size - i)) : i;
    const index = swapped.get(draw) ?? draw;
    swapped.set(draw, swapped.get(i) ?? i);
    const sampler = selected[Math.floor(index / (stepValues.length * cfgValues.length))];
    const step = stepValues[Math.floor(index / cfgValues.length) % stepValues.length];
    const cfg = cfgValues[index % cfgValues.length];
    plans.push({ id: 'sample-' + base.seed + '-' + round + '-' + index, label: SAMPLERS[sampler],
      prompt: positive, negative: uc, settings: { ...base, sampler, steps: step, scale: cfg }, weights: [] });
  }
  return validated(plans);
}
