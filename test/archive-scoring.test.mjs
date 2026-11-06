import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankArchiveWorks, workScore } from '../public/archive-scoring.js';

test('scores rank descending with zero distinct from unscored and stable ties', () => {
  const rows = [
    { id: 'unrated' },
    { id: 'zero', score: 0 },
    { id: 'five-new', score: 5 },
    { id: 'three', score: 3 },
    { id: 'five-old', score: 5 },
    { id: 'invalid', score: 6 },
  ];
  assert.deepEqual(
    rankArchiveWorks(rows).map((x) => x.id),
    ['five-new', 'five-old', 'three', 'zero', 'unrated', 'invalid'],
  );
  assert.deepEqual(
    rows.map((x) => x.id),
    ['unrated', 'zero', 'five-new', 'three', 'five-old', 'invalid'],
  );
});
test('turning rating priority off restores the input chronology or search order', () => {
  const rows = [{ id: 'new' }, { id: 'old-high', score: 5 }];
  assert.deepEqual(rankArchiveWorks(rows, false), rows);
  assert.notEqual(rankArchiveWorks(rows, false), rows);
});
test('only stored numeric integer scores are displayed, preserving an explicit zero', () => {
  assert.equal(workScore({ score: 0 }), 0);
  for (const score of [null, undefined, '5', NaN, -1, 6, 2.5]) assert.equal(workScore({ score }), null);
});
