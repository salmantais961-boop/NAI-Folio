// Local provenance only: no image content or account credentials leave the browser.
export const LINEAGE_VERSION = 1;
const mediaKeys = new Set(['source', 'mask', 'references']);
const basicKeys = ['model', 'dataset', 'medium'];
const parameterKeys = [
  'steps',
  'scale',
  'sampler',
  'cfgRescale',
  'noiseSchedule',
  'batch',
  'quality',
  'uc',
  'strength',
  'noise',
  'enhance',
  'transparent',
  'variety',
  'decrisper',
  'smea',
  'legacyUC',
  'focusInpaint',
  'normalizeVibes',
  'tool',
  'toolPrompt',
  'emotion',
  'defry',
  'blur',
];
const labels = {
  generate: '文生图',
  img2img: '图生图',
  inpaint: '局部重绘',
  upscale: '超分放大',
  'bg-removal': '去除背景',
  lineart: '提取线稿',
  sketch: '铅笔草图',
  colorize: '线稿上色',
  emotion: '调整表情',
  declutter: '清除文字',
  'declutter-keep-bubbles': '清字并保留气泡',
};

export function operationName(work) {
  const settings = work.settings || {},
    mode = work.mode || settings.mode || 'generate';
  if (mode === 'augment') return labels[settings.tool] || '导演工具';
  if (mode === 'img2img' && settings.enhance && settings.enhance !== 'off')
    return settings.enhance === 'max' ? 'Max Enhance' : '增强';
  return labels[mode] || '生成图像';
}

export function snapshotWork(work) {
  const settings = Object.fromEntries(
    Object.entries(work.settings || {}).filter(([key]) => !mediaKeys.has(key)),
  );
  return {
    id: work.id,
    created: work.created,
    prompt: work.prompt || '',
    negative: work.negative || '',
    settings: structuredClone(settings),
    width: work.width,
    height: work.height,
    mode: work.mode || settings.mode,
    modelLabel: work.modelLabel,
    filename: work.filename,
    operation: operationName(work),
    legacy: work.lineageVersion !== LINEAGE_VERSION,
    external: work.external === true,
    characterIds: normalizeCharacterIds(work.characterIds),
    characterLabels: characterLabels(work.characterIds, work.characterLabels),
  };
}

export function normalizeCharacterIds(values) {
  if (!Array.isArray(values)) return [];
  return [
    ...new Set(
      values.flatMap((value) => {
        if (typeof value !== 'string' || value.length > 300) return [];
        const match = value.trim().match(/^(oc|tag):(.+)$/i);
        if (!match || !match[2].trim() || /[\r\n\u0000-\u001f]/.test(match[2])) return [];
        return [match[1].toLowerCase() + ':' + match[2].trim().toLowerCase().replace(/\s+/g, '_')];
      }),
    ),
  ].sort();
}
function characterLabels(ids, source = {}) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const labels = Object.fromEntries(
    Object.entries(source).flatMap(([id, value]) => {
      const normalized = normalizeCharacterIds([id])[0];
      return normalized && typeof value === 'string' && value.trim()
        ? [[normalized, value.trim().slice(0, 160)]]
        : [];
    }),
  );
  return Object.fromEntries(
    normalizeCharacterIds(ids)
      .filter((id) => labels[id])
      .map((id) => [id, labels[id]]),
  );
}
function sharedCharacters(left, right) {
  const other = new Set(normalizeCharacterIds(right.characterIds));
  return normalizeCharacterIds(left.characterIds).filter((id) => other.has(id));
}
export function characterEdges(work, previous = [], limit = 3) {
  if (!normalizeCharacterIds(work.characterIds).length) return [];
  const unique = new Map();
  for (const candidate of previous) {
    if (!candidate?.id || candidate.id === work.id || unique.has(candidate.id)) continue;
    const characters = sharedCharacters(work, candidate);
    if (characters.length) unique.set(candidate.id, { candidate, characters });
  }
  return [...unique.values()]
    .sort(
      (a, b) =>
        b.characters.length - a.characters.length || (b.candidate.created || 0) - (a.candidate.created || 0),
    )
    .slice(0, Math.max(0, Math.min(10, limit)))
    .map(({ candidate, characters }) => ({
      id: `${candidate.id}:${work.id}:character`,
      source: candidate.id,
      target: work.id,
      type: 'character',
      label: characters.length > 1 ? `共同角色 · ${characters.length} 位` : '同一角色',
      strength: 1,
      characters,
      characterLabels: characterLabels(characters, { ...candidate.characterLabels, ...work.characterLabels }),
    }));
}

// Keep weights, character slots and positive/negative lanes distinct. Commas inside
// escaped tag names are literal; order and harmless whitespace do not change a tag.
function tags(text, lane) {
  return String(text || '')
    .split(/(?<!\\)[,\n]+/u)
    .map((tag) => tag.trim().replace(/\s+/gu, ' ').toLowerCase())
    .filter(Boolean)
    .map((tag) => ({ key: lane + ':' + tag, tag, lane }));
}
function promptTags(work) {
  const list = [...tags(work.prompt, '正向'), ...tags(work.negative, '负向')];
  for (const [i, character] of (work.settings?.characters || []).entries()) {
    if (character.enabled === false) continue;
    list.push(
      ...tags(character.prompt, `角色 ${i + 1} 正向`),
      ...tags(character.negative, `角色 ${i + 1} 负向`),
    );
  }
  return list;
}
export function promptDifference(before, after) {
  const left = promptTags(before),
    right = promptTags(after),
    remaining = new Map();
  for (const item of left) {
    if (!remaining.has(item.key)) remaining.set(item.key, []);
    remaining.get(item.key).push(item);
  }
  const added = [];
  let shared = 0;
  for (const item of right) {
    const entries = remaining.get(item.key);
    if (entries?.length) {
      entries.pop();
      shared++;
    } else added.push(item);
  }
  const removed = [...remaining.values()].flat();
  // One replacement is one changed tag, while retaining both sides for inspection.
  const count = Math.max(added.length, removed.length);
  const display = (item) => `${item.lane} · ${item.tag}`;
  return {
    count,
    added: added.map(display),
    removed: removed.map(display),
    shared,
    exact: count === 0 && left.length > 0,
    similar: left.length > 0 && right.length > 0 && shared > 0 && count <= 5,
  };
}

export function appendReuse(history, work, groups, patch) {
  if (!work?.id || !groups?.length) return history || [];
  const settings = Object.fromEntries(
    Object.entries(patch.settings || {}).filter(([key]) => !mediaKeys.has(key)),
  );
  const next = {
    id: work.id,
    reuseId: crypto.randomUUID(),
    groups: [...groups],
    at: Date.now(),
    ...(groups.includes('media') ? { mediaSignature: mediaSignature(patch.settings || {}) } : {}),
    snapshot: snapshotWork(work),
    patch: {
      ...(typeof patch.prompt === 'string' ? { prompt: patch.prompt } : {}),
      ...(typeof patch.negative === 'string' ? { negative: patch.negative } : {}),
      settings,
    },
  };
  return [next, ...(history || []).filter((item) => item.id !== work.id)].slice(0, 3);
}

export function reuseToken(entry) {
  return entry.reuseId || `${entry.id}:${entry.at ?? 'legacy'}`;
}
function relatedPrompt(before, after) {
  if (!String(before || '').trim() || !String(after || '').trim()) return false;
  const change = promptDifference({ prompt: before }, { prompt: after });
  const overlap = change.shared / Math.max(1, change.shared + change.count);
  return change.exact || change.similar || (change.shared >= 3 && overlap >= 0.75);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function sameFields(patch, submitted, keys) {
  const selected = keys.filter((key) => Object.hasOwn(patch, key));
  return selected.length > 0 && selected.every((key) => same(patch[key], submitted[key]));
}
function mediaSignature(settings) {
  const values = [
    settings.source?.data || '',
    settings.mask || '',
    ...(settings.references || [])
      .filter((item) => item.enabled !== false)
      .map((item) => [item.kind, item.data || item.v3 || '']),
  ];
  if (!values[0] && !values[1] && values.length <= 2) return null;
  const text = JSON.stringify(values);
  let a = 2166136261,
    b = 5381;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return `${text.length}:${a >>> 0}:${b >>> 0}`;
}
function selectedReuseGroups(entry, submitted, currentMedia) {
  const patch = entry.patch || {},
    settings = patch.settings || {},
    target = submitted.settings || {};
  const requested = [
    ...new Set(
      (entry.groups || []).map(
        (group) =>
          ({ positive: 'prompt', dimensions: 'size', settings: 'parameters', model: 'basic' })[group] || group,
      ),
    ),
  ];
  const retained = requested.filter((group) => {
    if (group === 'prompt' || group === 'negative') return relatedPrompt(patch[group], submitted[group]);
    if (group === 'seed') return Number.isFinite(settings.seed) && same(settings.seed, target.seed);
    if (group === 'size')
      return (
        settings.width > 0 &&
        settings.height > 0 &&
        sameFields(settings, target, ['width', 'height']) &&
        Object.hasOwn(settings, 'width') &&
        Object.hasOwn(settings, 'height')
      );
    if (group === 'parameters') return sameFields(settings, target, parameterKeys);
    if (group === 'basic') return sameFields(settings, target, basicKeys);
    if (group === 'media') return Boolean(entry.mediaSignature && entry.mediaSignature === currentMedia);
    if (group === 'characters') {
      const source = settings.characters?.filter((character) => character.enabled !== false) || [];
      const destination = target.characters?.filter((character) => character.enabled !== false) || [];
      if (!source.length || source.length !== destination.length) return false;
      const meaningful = source.some(
        (character) => String(character.prompt || '').trim() || String(character.negative || '').trim(),
      );
      return (
        meaningful &&
        same(settings.useCoords, target.useCoords) &&
        source.every((character, index) => {
          const other = destination[index];
          return (
            ['x', 'y'].every((key) => same(character[key], other[key])) &&
            ['prompt', 'negative'].every(
              (lane) =>
                (!String(character[lane] || '').trim() && !String(other[lane] || '').trim()) ||
                relatedPrompt(character[lane], other[lane]),
            )
          );
        })
      );
    }
    return false;
  });
  // Merely retaining a default model/dataset is not evidence that a composition
  // still derives from this image. Explicit meaningful fields must survive too.
  return retained.some((group) => group !== 'basic') ? retained : [];
}

export function activeReuses(history, submitted) {
  const currentMedia = (history || []).some((entry) => entry.groups?.includes('media'))
    ? mediaSignature(submitted.settings || {})
    : null;
  return (history || []).slice(0, 3).flatMap((entry) => {
    const groups = selectedReuseGroups(entry, submitted, currentMedia);
    return groups.length ? [{ ...entry, groups }] : [];
  });
}

// Upscaling is an output variant of its source, not a new prompt-comparison root.
// Follow only documented editing edges: never infer ancestry from matching sizes.
export function similarityOrigin(work, known, previousById = new Map()) {
  let origin = work;
  const seen = new Set();
  while ((origin.mode || origin.settings?.mode) === 'upscale' && !seen.has(origin.id)) {
    seen.add(origin.id);
    const record = known.get(origin.id) || origin;
    const source = record.edges?.find((edge) => edge.type === 'edit')?.source;
    const parent = previousById.get(source) || known.get(source);
    if (!parent || seen.has(parent.id)) break;
    origin = parent;
  }
  return origin;
}

export function createLineageRecords(batch, { previous = [], known = new Map(), reuses = [], source } = {}) {
  const records = new Map(),
    previousById = new Map(previous.map((work) => [work.id, work]));
  function parent(id, fallback) {
    if (!id) return null;
    const existing = known.get(id) || records.get(id);
    if (existing && (previousById.has(id) || existing.external)) return existing;
    const work = previousById.get(id);
    // A stale draft must not resurrect an image removed in another tab/session.
    // Only explicitly imported external metadata may exist without an archive work.
    const node = work ? snapshotWork(work) : fallback?.external ? fallback : null;
    if (!node) return null;
    const record = { ...node, version: LINEAGE_VERSION, edges: [] };
    records.set(id, record);
    return record;
  }
  for (const [index, work] of batch.entries()) {
    const record = { ...snapshotWork(work), legacy: false, version: LINEAGE_VERSION, edges: [] };
    const edge = (id, type, label, strength, detail = {}) => {
      if (id === work.id || !id) return;
      record.edges.push({
        id: `${id}:${work.id}:${type}`,
        source: id,
        target: work.id,
        type,
        label,
        strength,
        ...detail,
      });
    };
    if (source?.workId) {
      const origin = parent(source.workId, source.snapshot);
      if (origin) edge(origin.id, 'edit', record.operation, 1, { changes: promptDifference(origin, work) });
    }
    for (const entry of reuses) {
      const origin = parent(entry.id, entry.snapshot);
      if (origin)
        edge(origin.id, 'reuse', '复用 META', 1, {
          groups: entry.groups,
          changes: promptDifference(origin, work),
        });
    }
    if (index > 0) edge(batch[0].id, 'batch', '同批生成', 1);
    const direct = new Set(
      record.edges.filter((item) => item.type === 'edit' || item.type === 'batch').map((item) => item.source),
    );
    const origins = new Map();
    if (record.mode !== 'upscale')
      for (const candidate of previous) {
        if (candidate.lineageVersion !== LINEAGE_VERSION) continue;
        const other = similarityOrigin(candidate, known, previousById);
        if (
          (!previousById.has(other.id) && !other.external) ||
          (other.mode || other.settings?.mode) === 'upscale'
        )
          continue;
        if (direct.has(other.id)) continue;
        const recency = Math.max(Number(candidate.created) || 0, origins.get(other.id)?.recency || 0);
        origins.set(other.id, { other, recency, changes: promptDifference(other, work) });
      }
    const candidates = [...origins.values()]
      .filter(({ changes }) => changes.similar)
      .sort((a, b) => a.changes.count - b.changes.count || b.recency - a.recency)
      .slice(0, 3);
    for (const { other, changes } of candidates) {
      parent(other.id);
      edge(
        other.id,
        'similar',
        changes.exact ? '相同提示词' : `相似 · ${changes.count} 项改动`,
        changes.exact ? 1 : 0.95 - changes.count * 0.12,
        { changes },
      );
    }
    for (const connection of characterEdges(work, previous)) {
      if (parent(connection.source)) record.edges.push(connection);
    }
    records.set(work.id, record);
  }
  return [...records.values()];
}

export function buildLineageGraph(focus, records, works) {
  const current = new Map(works.map((work) => [work.id, work]));
  if (!current.has(focus.id) && !focus.external) return { focusId: null, nodes: [], groups: [], edges: [] };
  const all = records instanceof Map ? [...records.values()] : records;
  const byId = new Map(
    all.filter((record) => current.has(record.id) || record.external).map((record) => [record.id, record]),
  );
  if (!byId.has(focus.id)) byId.set(focus.id, { ...snapshotWork(focus), edges: [] });
  const normalized = new Map();
  for (const saved of [...byId.values()].flatMap((record) => record.edges || [])) {
    if (!byId.has(saved.source) || !byId.has(saved.target)) continue;
    let edge = saved;
    if (edge.type === 'reuse') {
      const source = byId.get(edge.source),
        target = byId.get(edge.target);
      const groups = (edge.groups || []).filter((group) => {
        if (group === 'prompt' || group === 'positive') return relatedPrompt(source.prompt, target.prompt);
        if (group === 'negative') return relatedPrompt(source.negative, target.negative);
        if (group === 'characters') {
          const change = promptDifference(
            { settings: { characters: source.settings?.characters } },
            { settings: { characters: target.settings?.characters } },
          );
          return (
            change.exact || change.similar || change.shared / Math.max(1, change.shared + change.count) >= 0.75
          );
        }
        return true;
      });
      const meaningful = groups.filter((group) => group !== 'basic' && group !== 'model');
      const oldChange = edge.changes;
      const clearlyUnrelated =
        oldChange?.count > 5 &&
        (oldChange.shared || 0) / Math.max(1, (oldChange.shared || 0) + oldChange.count) < 0.75;
      if (
        (Array.isArray(edge.groups) && !meaningful.length) ||
        (!Array.isArray(edge.groups) && clearlyUnrelated)
      )
        continue;
      edge = { ...edge, ...(Array.isArray(edge.groups) ? { groups } : {}) };
    }
    if (edge.type === 'character') {
      const source = byId.get(edge.source),
        target = byId.get(edge.target),
        characters = sharedCharacters(source, target);
      if (!characters.length) continue;
      edge = {
        ...edge,
        characters,
        label: characters.length > 1 ? `共同角色 · ${characters.length} 位` : '同一角色',
        characterLabels: characterLabels(characters, { ...source.characterLabels, ...target.characterLabels }),
      };
    }
    if (edge.type === 'similar') {
      const target = byId.get(edge.target);
      if ((target.mode || target.settings?.mode) === 'upscale') continue;
      const source = similarityOrigin(byId.get(edge.source), byId, current);
      if (source.id === target.id || (source.mode || source.settings?.mode) === 'upscale') continue;
      const changes = promptDifference(source, target);
      if (!changes.similar) continue;
      edge = {
        ...edge,
        source: source.id,
        id: `${source.id}:${target.id}:similar`,
        changes,
        label: changes.exact ? '相同提示词' : `相似 · ${changes.count} 项改动`,
        strength: changes.exact ? 1 : 0.95 - changes.count * 0.12,
      };
    }
    normalized.set(edge.id, edge);
  }
  const allEdges = [...normalized.values()];
  const adjacent = new Map();
  for (const edge of allEdges) {
    for (const [from, to] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ]) {
      if (!adjacent.has(from)) adjacent.set(from, []);
      adjacent.get(from).push(to);
    }
  }
  const ids = new Set([focus.id]),
    queue = [focus.id];
  for (let i = 0; i < queue.length; i++)
    for (const id of adjacent.get(queue[i]) || []) {
      if (!ids.has(id)) {
        ids.add(id);
        queue.push(id);
      }
    }
  const nodes = [...ids].map((id) => {
    const record = byId.get(id) || { id, edges: [] },
      work = current.get(id);
    return { ...record, work, edges: undefined };
  });
  const grouped = new Map();
  for (const node of nodes) {
    const identity = promptTags(node)
      .map((tag) => tag.key)
      .sort();
    const key = identity.length ? JSON.stringify(identity) : 'empty:' + node.id;
    if (!grouped.has(key)) {
      // Two independent 32-bit hashes keep group coordinates stable when another
      // image joins the same prompt group; prompt text is not put in storage keys.
      let a = 2166136261,
        b = 5381;
      for (let i = 0; i < key.length; i++) {
        a = Math.imul(a ^ key.charCodeAt(i), 16777619);
        b = Math.imul(b, 33) ^ key.charCodeAt(i);
      }
      grouped.set(key, {
        id: 'prompt-' + (a >>> 0).toString(36) + '-' + (b >>> 0).toString(36),
        memberIds: [],
        prompt: node.prompt || '',
        negative: node.negative || '',
      });
    }
    grouped.get(key).memberIds.push(node.id);
  }
  for (const group of grouped.values())
    group.memberIds.sort((a, b) => (byId.get(a).created || 0) - (byId.get(b).created || 0));
  return {
    focusId: focus.id,
    nodes,
    groups: [...grouped.values()],
    edges: allEdges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
  };
}

export function pruneLineage(records, ids) {
  const removed = new Set(ids);
  return records
    .filter((record) => !removed.has(record.id))
    .map((record) => ({
      ...record,
      edges: (record.edges || []).filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)),
    }));
}
