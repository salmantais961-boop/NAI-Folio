import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCharacterSections, planCharacterMigration } from '../public/character-sections.js';

test('moves English and Chinese role sections while preserving global and negative text byte-for-byte', () => {
  const source =
    'masterpiece, outdoors\nCharacter 1:\nblue hair, blue eyes\nCharacter 2： red hair, cape\nGlobal prompt: sunset\n负面提示词：bad anatomy';
  const result = parseCharacterSections(source);
  assert.deepEqual(
    result.sections.map(({ number, prompt }) => ({ number, prompt })),
    [
      { number: 1, prompt: 'blue hair, blue eyes' },
      { number: 2, prompt: 'red hair, cape' },
    ],
  );
  assert.equal(result.remaining, 'masterpiece, outdoors\nGlobal prompt: sunset\n负面提示词：bad anatomy');
  assert.equal(parseCharacterSections('角色1：\n短发, 红眼\n角色 3: 白衣').sections.length, 2);
});
test('leaves empty headers, prose, inline tags, fenced examples and unfinished weighted groups intact', () => {
  for (const source of [
    'Character 1:',
    'Character 1:\n , , ',
    'a Character 1: blue eyes',
    'portrait, Character 1: blue eyes',
    'Character 0: blue eyes',
    'Character name: eyes',
    '```\nCharacter 1: blue eyes\n```',
    '{{global\nCharacter 1: blue eyes}}',
    '||global\nCharacter 1: blue eyes||',
    'Negative prompt:\nCharacter 1: bad eyes',
    'Character 1: {{blue eyes',
    'Character 1: 1.2::blue eyes',
  ])
    assert.equal(parseCharacterSections(source), null, source);
  const result = parseCharacterSections('Character 1:\nCharacter 2: blue eyes');
  assert.equal(result.remaining, 'Character 1:\n');
  assert.equal(result.sections.length, 1);
});
test('resumes only after an explicit positive/global boundary and permits escaped bracket tags', () => {
  const result = parseCharacterSections(
    'Negative: lowres\nCharacter 1: bad eyes\nGlobal: outdoor\n角色2: red eyes, \\[tag\\]',
  );
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].number, 2);
  assert.equal(result.remaining, 'Negative: lowres\nCharacter 1: bad eyes\nGlobal: outdoor\n');
});
test('keeps macro references, numeric and brace weights verbatim', () => {
  const result = parseCharacterSections(
    'base\r\nCharacter 1：\r\n1.4::!macro:Silver!::, {{cape}}, [smile]\r\nNegative: lowres',
  );
  assert.equal(result.sections[0].prompt, '1.4::!macro:Silver!::, {{cape}}, [smile]');
  assert.equal(result.remaining, 'base\r\nNegative: lowres');
});
test('capacity planning is atomic, fills only truly empty slots and preserves existing roles/media', () => {
  const settings = {
    source: { data: 'keep' },
    characters: [
      { prompt: 'existing', negative: 'keep', x: 0.2, y: 0.6, enabled: false },
      { prompt: '', negative: '', x: 0.8, y: 0.4, enabled: false },
      { prompt: '', negative: 'occupied', x: 0.4, y: 0.3, enabled: true },
    ],
  };
  const before = structuredClone(settings);
  const { sections } = parseCharacterSections('角色1: red eyes\nCharacter 2: cape');
  assert.throws(() => planCharacterMigration(settings, sections, 0), /不支持/);
  assert.throws(() => planCharacterMigration(settings, sections, 3), /不足/);
  assert.throws(
    () =>
      planCharacterMigration({ characters: Array.from({ length: 7 }, () => ({ prompt: '' })) }, sections, 6),
    /上限/,
  );
  assert.deepEqual(settings, before);
  const result = planCharacterMigration(settings, sections, 4);
  assert.deepEqual(
    result.migrated.map((item) => item.slot),
    [1, 3],
  );
  assert.deepEqual(result.characters[0], before.characters[0]);
  assert.deepEqual(result.characters[2], before.characters[2]);
  assert.equal(result.characters[1].x, 0.8);
  assert.equal(result.characters[1].enabled, true);
  assert.deepEqual(settings, before);
});
