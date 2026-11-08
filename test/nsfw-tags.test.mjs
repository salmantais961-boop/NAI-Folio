import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyWorkNSFW } from '../public/nsfw-tags.js';

test('classifies explicit standalone tags and reports distinct matches in prompt order', () => {
  const result = classifyWorkNSFW({
    prompt: '1girl，NSFW、{pussy} | girl, 1.15::rating: explicit, oral_sex:: | boy, penis',
    settings: { characters: [
      { enabled: true, prompt: 'Character 1: NSFW, source#handjob' },
      { prompt: 'girl|target#（dick:1.25），射精' },
    ] },
  });
  assert.deepEqual(result, {
    nsfw: true, matches: ['nsfw', 'pussy', 'rating:explicit', 'oral sex', 'penis', 'handjob', 'dick', '射精'],
  });
});

test('innocent substrings, names, clothes, demographics and unclear tags do not match', () => {
  const prompt = 'Essex, Dick Grayson, pussy willow, pussycat, cockpit, cumberland, middlesex, analysis, ' +
    'cocktail dress, sex symbol, sexual dimorphism, mixed-sex bathing, sex differences, red hair, ' +
    'nude lipstick, sexy pose, medium breasts, bikini, lingerie, topless male, nsfw artist, pantyless, ' +
    'no panties, public, exhibition, breasts squeezed together, ' +
    'artist:penis, !macro:nsfw!, no penis, no nudity, rating:sensitive, rating:questionable';
  assert.deepEqual(classifyWorkNSFW({ prompt }), { nsfw: false, matches: [] });
});

test('reads only positive image and enabled character captions, including old recipes', () => {
  const record = {
    negative: 'nsfw, sex',
    filename: 'dick.png',
    galleryTags: ['porn'],
    settings: { characters: [
      { enabled: false, prompt: 'penis' },
      { negative: 'pussy' },
      null,
    ] },
  };
  assert.deepEqual(classifyWorkNSFW(record), { nsfw: false, matches: [] });
  assert.deepEqual(classifyWorkNSFW({ ...record, settings: { characters: [{ prompt: 'sex' }] } }),
    { nsfw: true, matches: ['sex'] });
  for (const old of [undefined, {}, { prompt: null, settings: { characters: {} } }]) {
    assert.deepEqual(classifyWorkNSFW(old), { nsfw: false, matches: [] });
  }
});

test('handles NAI numeric groups across tag delimiters and ignores suppressed terms', () => {
  const prompt = 'portrait, -1.2::nude, pussy::, 0::sex::, (penis:-0.1), ' +
    '[rating_explicit], 0.4::piledriver (sex), year 2024::, portrait';
  assert.deepEqual(classifyWorkNSFW({ prompt }).matches, ['rating:explicit', 'piledriver (sex)']);
  assert.equal(classifyWorkNSFW({ prompt: 'R-18；裸体' }).nsfw, true);
});

test('only pixel edits can inherit verified source hits', () => {
  const sourceNsfwTags = ['breast grab', 'exhibitionism', 'pantyless', 3, 'breast grab'];
  for (const work of [{ mode: 'upscale' }, { settings: { mode: 'augment' } }]) {
    assert.deepEqual(classifyWorkNSFW({ ...work, sourceNsfwTags, prompt: 'breast_fondling' }), {
      nsfw: true, matches: ['breast fondling', 'breast grab', 'exhibitionism'],
    });
  }
  for (const mode of ['generate', 'img2img', 'inpaint']) {
    assert.deepEqual(classifyWorkNSFW({ mode, sourceNsfwTags }), { nsfw: false, matches: [] });
  }
});

test('recognizes explicit positive descriptions while respecting negation and word boundaries', () => {
  const prompt = 'Two adults having sex on a bed. One is performing oral sex. A figure with exposed genitals.';
  assert.deepEqual(classifyWorkNSFW({ prompt }).matches, ['having sex', 'oral sex', 'exposed genitals']);
  for (const safe of [
    'two people having sex education classes', 'without exposed genitals', 'a poster with no visible genitals',
    'two adults are not having sex', "two adults aren't having sex", 'a talk discussing performing oral sex',
    'no explicit content, no nudity', 'Pussy Willow and Dick Grayson in Essex', 'they are having sextuplets',
  ]) assert.equal(classifyWorkNSFW({ prompt: safe }).nsfw, false, safe);
  assert.deepEqual(classifyWorkNSFW({
    prompt: 'One couple is not having sex but another is engaging in sexual intercourse.',
  }).matches, ['sexual intercourse']);
});

test('finds explicit components inside modified tags, weights and multi-character captions', () => {
  for (const prompt of ['penis under clothes', 'PENIS_UNDER_CLOTHES', '1.2::{penis-under-clothes}::',
    '2girls | girl, portrait | girl, naked under a cloak', 'fully dressed with visible 阴茎轮廓',
    'micropenis outline', 'nakedbody', 'uncensored blowjobs']) {
    assert.equal(classifyWorkNSFW({ prompt }).nsfw, true, prompt);
  }
  const result = classifyWorkNSFW({ settings: { characters: [{ prompt: 'clothed, detailed_chastity_cage_rendering' }] } });
  assert.deepEqual(result.matches, ['chastity cage']);
  assert.deepEqual(classifyWorkNSFW({ prompt: 'naked mole rat alongside a penis under a long coat' }).matches, ['penis']);
  assert.deepEqual(classifyWorkNSFW({ prompt: 'no background and a patterned shibari harness' }).matches, ['shibari']);
});

test('preserves neutral compounds and excluded terms when checking components', () => {
  for (const prompt of ['seen with the naked eye', 'a road snaked around the hill', 'rear-naked choke', 'sextant on a cockpit dashboard',
    'no depiction of penis under clothes', 'without nudity or exposed genitals', '没有任何露出阴茎的描写',
    '-2::penis under clothes, shibari harness::, stage costume', 'artist:Dick Grayson',
    'an explicit instruction to draw a face', 'fuchsia pussy-bow blouse']) {
    assert.equal(classifyWorkNSFW({ prompt }).nsfw, false, prompt);
  }
  assert.equal(classifyWorkNSFW({ prompt: 'portrait', negative: 'penis under clothes' }).nsfw, false);
});
