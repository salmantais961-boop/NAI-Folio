import test from 'node:test';
import assert from 'node:assert/strict';
import { createStepProgress, advanceStepProgress, summarizeStepProgress } from '../public/proof-progress.js';

test('stream progress uses only numeric returned steps and preserves their raw index', () => {
  let state = createStepProgress({ totalSteps: 23 });
  for (const frame of [{}, { step: null }, { step: '4' }, { step: -1 }, { step: 2.5 }, null])
    state = advanceStepProgress(state, frame);
  assert.deepEqual(summarizeStepProgress(state), {
    known: false,
    reported: 0,
    total: 23,
    ratio: null,
    percent: null,
  });
  state = advanceStepProgress(state, { step: 0, sample: 0 });
  assert.equal(summarizeStepProgress(state).percent, 0);
  state = advanceStepProgress(state, { step: 4, sample: 0 });
  assert.equal(summarizeStepProgress(state).reported, 4);
  assert.equal(summarizeStepProgress(state).percent, 17);
});

test('batch progress accumulates observed samples only and ignores duplicate/backward frames', () => {
  let state = createStepProgress({ totalSteps: 14, samples: 2 });
  for (const frame of [
    { step: 4, sample: 0 },
    { step: 2, sample: 0 },
    { step: 4, sample: 0 },
    { step: 7, sample: 1 },
    { step: 14, sample: 2 },
  ])
    state = advanceStepProgress(state, frame);
  assert.deepEqual(summarizeStepProgress(state), {
    known: true,
    reported: 11,
    total: 28,
    ratio: 11 / 28,
    percent: 39,
  });
});

test('unknown or conflicting totals do not invent percentages, and raw final step waits for a result', () => {
  assert.equal(summarizeStepProgress(advanceStepProgress(createStepProgress(), { step: 8 })).percent, null);
  const state = advanceStepProgress(createStepProgress({ totalSteps: 14 }), { step: 14 });
  assert.equal(summarizeStepProgress(state).ratio, 1);
  assert.equal(summarizeStepProgress(state).percent, null);
  const conflict = summarizeStepProgress(advanceStepProgress(state, { step: 15 }));
  assert.equal(conflict.total, null);
  assert.equal(conflict.percent, null);
});
