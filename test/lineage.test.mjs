import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LINEAGE_VERSION,
  promptDifference,
  appendReuse,
  activeReuses,
  createLineageRecords,
  buildLineageGraph,
  pruneLineage,
  snapshotWork,
  normalizeCharacterIds,
  characterEdges,
  reuseToken,
} from '../public/lineage-core.js';

const work = (id, prompt = '1girl, rain, city, night, long hair, blue eyes', extra = {}) => ({
  id,
  created: Number(id.replace(/\D/g, '')) || 1,
  prompt,
  negative: 'lowres',
  mode: 'generate',
  width: 832,
  height: 1216,
  lineageVersion: LINEAGE_VERSION,
  settings: { model: 'nai-diffusion-5-full', width: 832, height: 1216, seed: 14, steps: 28 },
  ...extra,
});

test('tag changes preserve weights, lanes, duplicates and character prompts', () => {
  assert.equal(
    promptDifference(work('1'), work('2', 'night, 1girl, city, rain, long hair, blue eyes')).count,
    0,
  );
  const changed = promptDifference(work('1'), work('2', '1girl, snow, city, night, long hair, blue eyes'));
  assert.equal(changed.count, 1);
  assert.deepEqual(changed.added, ['正向 · snow']);
  assert.deepEqual(changed.removed, ['正向 · rain']);
  assert.equal(changed.similar, true);
  assert.equal(promptDifference(work('1', '1.2::rain::'), work('2', 'rain')).count, 1);
  assert.equal(promptDifference({ prompt: 'a, a' }, { prompt: 'a' }).count, 1);
  assert.equal(promptDifference({ prompt: 'a' }, { negative: 'a' }).similar, false);
  assert.equal(promptDifference({ prompt: '' }, { prompt: '' }).exact, false);
  assert.equal(
    promptDifference(
      { settings: { characters: [{ prompt: 'blue hair', enabled: true }] } },
      { settings: { characters: [{ prompt: 'red hair', enabled: true }] } },
    ).count,
    1,
  );
});

test('similarity includes at most five changes with shared content, no inference on old works', () => {
  const old = work('1', undefined, { lineageVersion: undefined });
  const base = work('2', 'a, b, c, d, e, f, g');
  const exact = work('3', base.prompt);
  const five = work('4', 'a, b, h, i, j, k, l');
  const six = work('5', 'a, h, i, j, k, l, m');
  assert.equal(createLineageRecords([work('6', old.prompt)], { previous: [old] }).at(-1).edges.length, 0);
  const strength = (record) => record.edges.find((edge) => edge.type === 'similar')?.strength;
  const exactNode = createLineageRecords([exact], { previous: [base] }).at(-1);
  const fiveNode = createLineageRecords([five], { previous: [base] }).at(-1);
  assert.ok(strength(exactNode) > strength(fiveNode));
  assert.equal(fiveNode.edges[0].changes.count, 5);
  assert.equal(createLineageRecords([six], { previous: [base] }).at(-1).edges.length, 0);
  const unrelated = work('7', 'other, totally, unrelated', { negative: '' });
  assert.equal(createLineageRecords([unrelated], { previous: [base] }).at(-1).edges.length, 0);
});

test('edit/reuse parents are explicit snapshots and same-batch branches are stable', () => {
  const old = work('1', undefined, { lineageVersion: undefined });
  const previous = work('2');
  const reuse = appendReuse([], previous, ['seed'], { settings: { seed: 14 } });
  const batch = [work('3', undefined, { mode: 'upscale' }), work('4', undefined, { mode: 'upscale' })];
  const records = createLineageRecords(batch, {
    previous: [old, previous],
    reuses: reuse,
    source: { workId: old.id },
  });
  const root = records.find((node) => node.id === old.id);
  assert.equal(root.legacy, true);
  assert.deepEqual(root.edges, []);
  const child = records.find((node) => node.id === '3');
  assert.deepEqual(
    child.edges.map((edge) => edge.type),
    ['edit', 'reuse'],
  );
  assert.equal(child.edges[0].label, '超分放大');
  assert.deepEqual(child.edges[1].groups, ['seed']);
  assert.equal(records.find((node) => node.id === '4').edges.find((edge) => edge.type === 'batch').source, '3');
  assert.equal(JSON.stringify(records).includes('blob'), false);
});

test('deleted images and their connections disappear; no deleted placeholder is retained', () => {
  const a = work('1'),
    b = work('2'),
    c = work('3');
  const records = new Map();
  for (const [batch, previous, source] of [
    [[a], [], null],
    [[b], [a], { workId: a.id }],
    [[c], [a, b], { workId: b.id }],
  ])
    for (const node of createLineageRecords(batch, { previous, source, known: records }))
      records.set(node.id, node);
  const graph = buildLineageGraph(c, records, [a, c]);
  assert.equal(graph.nodes.length, 2);
  assert.equal(
    graph.nodes.find((node) => node.id === b.id),
    undefined,
  );
  assert.equal(
    graph.edges.some((edge) => edge.source === b.id || edge.target === b.id),
    false,
  );
  const cleaned = pruneLineage([...records.values()], [b.id]);
  assert.equal(
    cleaned.some((node) => node.id === b.id),
    false,
  );
  assert.equal(
    cleaned.flatMap((node) => node.edges).some((edge) => edge.source === b.id || edge.target === b.id),
    false,
  );
  assert.deepEqual(
    new Set(buildLineageGraph(a, records, [a, c]).nodes.map((node) => node.id)),
    new Set(['1', '3']),
  );
});

test('reuse history keeps the latest three distinct confirmed sources and ignores abandoned fields', () => {
  let history = [];
  for (let i = 1; i <= 4; i++)
    history = appendReuse(history, work(String(i)), ['seed'], { settings: { seed: i } });
  assert.deepEqual(
    history.map((entry) => entry.id),
    ['4', '3', '2'],
  );
  history = appendReuse(history, work('3'), ['prompt'], { prompt: 'a, b, c' });
  assert.deepEqual(
    history.map((entry) => entry.id),
    ['3', '4', '2'],
  );
  assert.equal(activeReuses(history, { prompt: 'a, b, d', settings: { seed: 7 } }).length, 1);
  assert.equal(activeReuses(history, { prompt: 'unrelated', settings: { seed: 7 } }).length, 0);
});

test('new prompt variants link to the pre-upscale original, preserving actual META source separately', () => {
  const a = work('1'),
    enlarged = work('2', a.prompt, { mode: 'upscale' }),
    again = work('3', a.prompt, { mode: 'upscale' });
  const known = new Map();
  for (const [batch, previous, source] of [
    [[a], [], null],
    [[enlarged], [a], { workId: a.id }],
    [[again], [a, enlarged], { workId: enlarged.id }],
  ]) {
    for (const record of createLineageRecords(batch, { previous, known, source })) known.set(record.id, record);
  }
  assert.equal(known.get(enlarged.id).edges.filter((edge) => edge.type === 'similar').length, 0);
  const changed = work('4', a.prompt + ', umbrella');
  const reuses = appendReuse([], again, ['prompt'], { prompt: again.prompt });
  const node = createLineageRecords([changed], { previous: [again, enlarged, a], known, reuses }).at(-1);
  assert.deepEqual(
    node.edges.filter((edge) => edge.type === 'similar').map((edge) => edge.source),
    [a.id],
  );
  assert.equal(node.edges.find((edge) => edge.type === 'reuse').source, again.id);
  assert.equal(node.edges.find((edge) => edge.type === 'similar').changes.count, 1);
  const withOriginalReuse = createLineageRecords([changed], {
    previous: [again, enlarged, a],
    known,
    reuses: appendReuse(reuses, a, ['seed'], { settings: { seed: a.settings.seed } }),
  }).at(-1);
  assert.deepEqual(
    withOriginalReuse.edges.filter((edge) => edge.type === 'similar').map((edge) => edge.source),
    [a.id],
  );
  // Deleted originals cannot be resurrected by a stale lineage snapshot.
  const withoutOriginal = createLineageRecords([changed], { previous: [again, enlarged], known, reuses }).at(
    -1,
  );
  assert.deepEqual(
    withoutOriginal.edges.filter((edge) => edge.type === 'similar').map((edge) => edge.source),
    [],
  );
});

test('upscale normalization stops at a real creative edit rather than skipping the whole editing chain', () => {
  const a = work('1'),
    edited = work('2', a.prompt + ', umbrella', { mode: 'inpaint' }),
    enlarged = work('3', edited.prompt, { mode: 'upscale' });
  const known = new Map();
  for (const [item, previous, source] of [
    [a, [], null],
    [edited, [a], { workId: a.id }],
    [enlarged, [a, edited], { workId: edited.id }],
  ])
    for (const record of createLineageRecords([item], { previous, known, source }))
      known.set(record.id, record);
  const next = work('4', edited.prompt + ', evening');
  const edges = createLineageRecords([next], { previous: [a, edited, enlarged], known }).at(-1).edges;
  assert.equal(edges[0].source, edited.id);
  assert.equal(edges[0].changes.count, 1);
});

test('exact prompts share a stable group regardless of seed or output size; changed weights stay separate', () => {
  const a = work('1'),
    b = work('2', a.prompt.split(', ').reverse().join(', '), { settings: { seed: 99 } }),
    c = work('3', a.prompt.replace('rain', '1.2::rain::'));
  const records = new Map();
  for (const [item, previous] of [
    [a, []],
    [b, [a]],
    [c, [a, b]],
  ])
    for (const node of createLineageRecords([item], { previous, known: records })) records.set(node.id, node);
  const graph = buildLineageGraph(a, records, [a, b, c]);
  assert.equal(graph.groups.length, 2);
  const shared = graph.groups.find((group) => group.memberIds.includes(a.id));
  assert.deepEqual(shared.memberIds, [a.id, b.id]);
  const afterDelete = buildLineageGraph(b, records, [b, c]);
  assert.equal(afterDelete.groups.find((group) => group.memberIds.includes(b.id)).id, shared.id);
});

test('graphs normalize already recorded upscale similarities without changing explicit reuse history', () => {
  const a = work('1'),
    b = work('2', a.prompt, { mode: 'upscale' }),
    c = work('3', a.prompt + ', umbrella');
  const records = new Map();
  for (const [item, previous, source] of [
    [a, [], null],
    [b, [a], { workId: a.id }],
    [c, [a, b], null],
  ])
    for (const node of createLineageRecords([item], { previous, known: records, source }))
      records.set(node.id, node);
  records.get(c.id).edges.push({ id: 'old-upscale-similarity', source: b.id, target: c.id, type: 'similar' });
  const graph = buildLineageGraph(c, records, [a, b, c]);
  assert.deepEqual(
    graph.edges.filter((edge) => edge.type === 'similar').map((edge) => edge.source),
    [a.id],
  );
});

test('stale draft snapshots cannot restore deleted artwork as a reuse or edit parent', () => {
  const removed = work('1'),
    next = work('2');
  const reuses = appendReuse([], removed, ['seed'], { settings: { seed: 14 } });
  const records = createLineageRecords([next], { reuses, source: { workId: removed.id, snapshot: removed } });
  assert.deepEqual(
    records.map((node) => node.id),
    [next.id],
  );
  assert.deepEqual(records[0].edges, []);
});

test('abandoned prompts are not kept alive by empty negative captions or a matching default model', () => {
  const source = work('1', 'a, b, c, d, e, f, g, h, i, j', { negative: '' });
  const history = appendReuse([], source, ['prompt', 'negative', 'basic'], {
    prompt: source.prompt,
    negative: '',
    settings: { model: source.settings.model },
  });
  assert.deepEqual(
    activeReuses(history, {
      prompt: 'u, v, w, x, y, z, orange, apple, ocean, cat',
      negative: '',
      settings: { model: source.settings.model },
    }),
    [],
  );
  assert.deepEqual(
    activeReuses(appendReuse([], source, ['basic'], { settings: { model: source.settings.model } }), source),
    [],
  );
});

test('reuse validity is assessed per selected group and only retained groups label the new connection', () => {
  const source = work('1', 'a, b, c, d, e, f, g, h, i, j');
  const history = appendReuse([], source, ['prompt', 'seed', 'size', 'parameters', 'basic'], {
    prompt: source.prompt,
    settings: { model: source.settings.model, seed: 14, width: 832, height: 1216, steps: 28, scale: 7 },
  });
  const target = {
    prompt: 'unrelated, completely, different',
    settings: { model: source.settings.model, seed: 14, width: 1024, height: 1216, steps: 30, scale: 7 },
  };
  const [retained] = activeReuses(history, target);
  assert.deepEqual(retained.groups, ['seed', 'basic']);
  assert.deepEqual(history[0].groups, ['prompt', 'seed', 'size', 'parameters', 'basic']);
  assert.deepEqual(activeReuses(history, { ...target, settings: { ...target.settings, seed: null } }), []);
  const onlyParameters = appendReuse([], source, ['parameters'], {
    settings: { steps: 28, scale: 7, sampler: 'k_euler' },
  });
  assert.equal(
    activeReuses(onlyParameters, { settings: { steps: 28, scale: 9, sampler: 'k_euler' } }).length,
    0,
  );
  assert.equal(
    activeReuses(onlyParameters, { settings: { steps: 28, scale: 7, sampler: 'k_euler' } }).length,
    1,
  );
  assert.equal(
    activeReuses(appendReuse([], source, ['seed'], { settings: { seed: null } }), { settings: { seed: null } })
      .length,
    0,
  );
});

test('large prompt expansions retain a real majority, but wholesale replacements do not', () => {
  const prompt = Array.from({ length: 30 }, (_, i) => 'tag' + i).join(', ');
  const history = appendReuse([], work('1', prompt), ['prompt'], { prompt });
  assert.equal(activeReuses(history, { prompt: prompt + ', a, b, c, d, e, f, g, h, i, j' }).length, 1);
  assert.equal(activeReuses(history, { prompt: 'tag1, a, b, c, d, e, f, g, h, i, j' }).length, 0);
});

test('media-only reuse checks compact media signatures and does not serialize image data', () => {
  const source = work('1');
  const settings = {
    source: { data: 'data:image/png;base64,IMAGE-A', width: 10, height: 10 },
    references: [],
    mode: 'img2img',
  };
  const history = appendReuse([], source, ['media'], { settings });
  assert.equal(activeReuses(history, { settings }).length, 1);
  assert.equal(
    activeReuses(history, {
      settings: { ...settings, source: { ...settings.source, data: 'data:image/png;base64,IMAGE-B' } },
    }).length,
    0,
  );
  assert.equal(JSON.stringify(history).includes('IMAGE-A'), false);
});

test('reuse tokens distinguish the same source selected again while an earlier request is running', () => {
  const source = work('1');
  const first = appendReuse([], source, ['seed'], { settings: { seed: 14 } });
  const submitted = new Set(first.map(reuseToken));
  const later = appendReuse(first, source, ['prompt'], { prompt: source.prompt });
  assert.notEqual(reuseToken(first[0]), reuseToken(later[0]));
  assert.equal(later.filter((entry) => !submitted.has(reuseToken(entry))).length, 1);
  assert.equal(first.filter((entry) => !submitted.has(reuseToken(entry))).length, 0);
  assert.notEqual(reuseToken({ id: '1', at: 10 }), reuseToken({ id: '1', at: 11 }));
});

test('read-time cleanup removes unrelated prompt-only reuse while preserving explicit seed use', () => {
  const source = work('1', 'a, b, c, d, e, f, g, h, i, j', { negative: '' });
  const target = work('2', 'u, v, w, x, y, z, orange, apple, ocean, cat', { negative: '' });
  const edge = {
    id: 'old-reuse',
    source: source.id,
    target: target.id,
    type: 'reuse',
    groups: ['prompt', 'negative', 'basic'],
    changes: promptDifference(source, target),
  };
  const records = [
    { ...snapshotWork(source), edges: [] },
    { ...snapshotWork(target), edges: [edge] },
  ];
  assert.deepEqual(buildLineageGraph(target, records, [source, target]).edges, []);
  records[1].edges = [{ ...edge, groups: ['prompt', 'seed', 'basic'] }];
  const kept = buildLineageGraph(target, records, [source, target]).edges;
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].groups, ['seed', 'basic']);
  const samePositive = {
    ...target,
    prompt: source.prompt,
    negative: 'one, two, three, four, five, six, seven, eight',
  };
  records[1] = {
    ...snapshotWork(samePositive),
    edges: [{ ...edge, groups: ['prompt'], changes: promptDifference(source, samePositive) }],
  };
  assert.equal(buildLineageGraph(samePositive, records, [source, samePositive]).edges.length, 1);
});

test('character identity is explicit, normalized and safely snapshotted without guessing from descriptions', () => {
  assert.deepEqual(
    normalizeCharacterIds(['OC:Alpha', 'oc:alpha', 'tag:Hatsune Miku', '1girl', null, 'tag:', 'oc:bad\nid']),
    ['oc:alpha', 'tag:hatsune_miku'],
  );
  const source = work('1', '1girl, long hair', {
    characterIds: ['oc:alpha', 'tag:hatsune_miku'],
    characterLabels: { 'oc:alpha': '青叶', 'tag:hatsune_miku': '初音未来', 'oc:unrelated': 'not copied' },
    settings: { source: { data: 'private-image' } },
  });
  const snapshot = snapshotWork(source);
  assert.deepEqual(snapshot.characterIds, ['oc:alpha', 'tag:hatsune_miku']);
  assert.deepEqual(snapshot.characterLabels, { 'oc:alpha': '青叶', 'tag:hatsune_miku': '初音未来' });
  assert.equal(JSON.stringify(snapshot).includes('private-image'), false);
  assert.deepEqual(characterEdges(work('2', '1girl, long hair'), [source]), []);
});

test('same characters create separate dashed relation data across unrelated prompts, capped at three sources', () => {
  const source = work('1', 'a, b, c, d, e, f, g, h, i, j', {
    negative: '',
    characterIds: ['oc:alpha', 'tag:hatsune_miku'],
    characterLabels: { 'oc:alpha': '青叶', 'tag:hatsune_miku': '初音未来' },
  });
  const target = work('2', 'u, v, w, x, y, z, orange, apple, ocean, cat', {
    negative: '',
    characterIds: ['tag:hatsune_miku', 'oc:alpha'],
    characterLabels: { 'oc:alpha': '青叶新名' },
  });
  const records = createLineageRecords([target], { previous: [source] });
  const node = records.find((record) => record.id === target.id);
  assert.equal(node.edges.length, 1);
  assert.equal(node.edges[0].type, 'character');
  assert.deepEqual(node.edges[0].characters, ['oc:alpha', 'tag:hatsune_miku']);
  assert.equal(node.edges[0].characterLabels['oc:alpha'], '青叶新名');
  assert.equal(node.edges[0].characterLabels['tag:hatsune_miku'], '初音未来');
  assert.equal(buildLineageGraph(target, records, [source, target]).edges[0].type, 'character');
  const many = Array.from({ length: 6 }, (_, i) =>
    work('old' + i, 'different', { characterIds: ['oc:alpha'] }),
  );
  assert.deepEqual(
    characterEdges(target, many).map((edge) => edge.source),
    ['old5', 'old4', 'old3'],
  );
  assert.deepEqual(characterEdges(target, [work('legacy', '1girl, long hair')]), []);
});

test('character links are not resurrected when a picture is deleted or an old record has no identity', () => {
  const source = work('1', undefined, { characterIds: ['oc:alpha'] });
  const target = work('2', undefined, { characterIds: ['oc:alpha'] });
  const records = createLineageRecords([target], { previous: [source] });
  assert.equal(buildLineageGraph(target, records, [target]).edges.length, 0);
  const old = records.map((record) =>
    record.id === source.id ? { ...record, characterIds: undefined } : record,
  );
  assert.equal(
    buildLineageGraph(target, old, [source, target]).edges.some((edge) => edge.type === 'character'),
    false,
  );
});
