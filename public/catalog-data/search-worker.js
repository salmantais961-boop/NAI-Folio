/* The source indexes are loaded lazily off the UI thread. Rows are ordered by
   usage (or editorial selection for an empty picker) before relevance scoring. */
const files = new Map();
const edition = new URL(self.location.href).searchParams.get('edition');
const catalogRoot = edition && /^[a-f0-9-]{36}$/.test(edition)
  ? new URL('local/' + edition + '/', self.location.href)
  : new URL('.', self.location.href);
const normalize = (value) =>
  String(value || '')
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/\s+/g, ' ')
    .trim();

function getFile(name, optional = false) {
  if (!files.has(name)) {
    const pending = fetch(new URL(name + '.json', catalogRoot))
      .then((response) => {
        if (optional && response.status === 404) return {};
        if (!response.ok) throw new Error('本地索引暂时无法读取');
        return response.json();
      })
      .catch((error) => {
        files.delete(name);
        throw error;
      });
    files.set(name, pending);
  }
  return files.get(name);
}

let characterIndex;

// Only the character catalog may establish identity. General tags, fuzzy
// matches, series names and translated display names are never inferred here.
function getCharacterIndex() {
  if (!characterIndex) {
    characterIndex = getFile('character')
      .then((rows) => {
        if (!Array.isArray(rows) || !rows.length) throw new Error('角色索引为空');
        const canonical = new Map();
        const aliases = new Map();
        for (const row of rows) {
          if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
          const key = normalize(row[0]);
          if (!key) continue;
          const item = {
            id: 'tag:' + key.replaceAll(' ', '_'),
            name: typeof row[3] === 'string' && row[3].trim() ? row[3].trim() : row[0].trim(),
          };
          canonical.set(key, item);
          if (typeof row[8] !== 'string') continue;
          for (const alias of row[8].split('|').map(normalize).filter(Boolean)) {
            // An ambiguous alias must not silently identify the wrong person.
            if (!aliases.has(alias)) aliases.set(alias, item);
            else if (aliases.get(alias)?.id !== item.id) aliases.set(alias, null);
          }
        }
        if (!canonical.size) throw new Error('角色索引格式无效');
        for (const [alias, item] of aliases) if (item && !canonical.has(alias)) canonical.set(alias, item);
        return canonical;
      })
      .catch((error) => {
        characterIndex = null;
        files.delete('character');
        throw error;
      });
  }
  return characterIndex;
}

function characterTokens(texts) {
  const tokens = new Set();
  for (const text of Array.isArray(texts) ? texts : []) {
    if (typeof text !== 'string') continue;
    for (let token of text.split(/[,，、\r\n|]/)) {
      token = token.trim();
      // Strip only NAI boundary syntax; keep parentheses that disambiguate names.
      let previous;
      do {
        previous = token;
        token = token
          .replace(/^[\[{]+\s*|\s*[\]}]+$/g, '')
          .replace(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*::\s*/, '')
          .replace(/\s*::$/, '')
          .replace(/^character\s*:\s*/i, '')
          .trim();
      } while (token !== previous);
      if (token) tokens.add(normalize(token));
    }
  }
  return tokens;
}

async function findExactCharacters(texts) {
  const tokens = characterTokens(texts);
  if (!tokens.size) return [];
  const index = await getCharacterIndex();
  const matches = new Map();
  for (const token of tokens) {
    const item = index.get(token);
    if (item) matches.set(item.id, item);
  }
  return [...matches.values()];
}

function relevance(needle, words, key, translation, aliases, series, translatedSeries) {
  const zh = translation.toLowerCase();
  if (key === needle || zh === needle) return 0;
  if (key.startsWith(needle) || zh.startsWith(needle)) return 1;
  if (aliases && aliases.split('|').includes(needle)) return 1;
  if (key.includes(' ' + needle) || key.includes('(' + needle)) return 2;
  if (key.includes(needle) || zh.includes(needle) || aliases?.includes(needle)) return 3;
  if (series && (series.includes(needle) || translatedSeries.includes(needle))) return 4;
  if (
    words.length > 1 &&
    words.every(
      (word) =>
        key.includes(word) || zh.includes(word) || series?.includes(word) || translatedSeries?.includes(word),
    )
  )
    return 5;
  return -1;
}

let tagRowsByName;

async function relatedTags(query, exclude, limit) {
  const seed = normalize(query);
  if (!seed) return [];
  const [relations, appearances] = await Promise.all([
    getFile('related-tags', true), getFile('character-details', true),
  ]);
  const appearance = Object.hasOwn(appearances, seed) ? appearances[seed] : [];
  const related = Object.hasOwn(relations, seed) ? relations[seed] : [];
  if (!appearance.length && !related.length) return [];

  const rows = await getFile('tags');
  if (!tagRowsByName) {
    tagRowsByName = new Map();
    for (const row of rows) tagRowsByName.set(row[0], row);
  }
  const used = characterTokens(exclude);
  used.add(seed);
  const result = [];
  for (const name of [...appearance, ...related]) {
    const key = normalize(name);
    if (!key || used.has(key)) continue;
    used.add(key);
    result.push(tagRowsByName.get(key) || [key, '', 0]);
    if (result.length === limit) break;
  }
  return result;
}

const recent = new Map();
self.onmessage = async ({ data }) => {
  const { id, kind, query = '', offset = 0, channel = kind, category = null } = data;
  const limit = kind === 'tags' || kind === 'related-tags'
    ? Math.min(20, Math.max(1, data.limit || 20))
    : data.limit || 8;
  // Provenance requests are independent jobs: never cancel them when another
  // request arrives, and never let them invalidate the suggestion/picker lanes.
  if (kind === 'exact-characters') {
    try {
      self.postMessage({ id, characters: await findExactCharacters(data.texts) });
    } catch {
      self.postMessage({
        id,
        error: '本地角色索引暂时无法读取，本次无法识别角色关联',
        code: 'CHARACTER_INDEX_UNAVAILABLE',
      });
    }
    return;
  }
  recent.set(channel, id);
  try {
    if (kind === 'related-tags') {
      const results = await relatedTags(query, data.exclude, limit);
      self.postMessage(recent.get(channel) === id ? { id, count: results.length, results } : { id, stale: true });
      return;
    }
    const rows = await getFile(kind);
    if (recent.get(channel) !== id) {
      self.postMessage({ id, stale: true });
      return;
    }
    const needle = normalize(query);
    const words = needle.split(' ').filter(Boolean);
    const buckets = Array.from({ length: 6 }, () => []);
    const pageEnd = offset + limit;
    let count = 0;
    if (!needle && kind !== 'tags') {
      count = rows.length;
      buckets[0] = rows.slice(offset, pageEnd);
    } else {
      for (const row of rows) {
        const isTag = kind === 'tags';
        if (isTag && category !== null && (row[2] || 0) !== category) continue;
        const score = relevance(
          needle,
          words,
          row[0],
          (isTag ? row[1] : row[3]) || '',
          (isTag ? row[4] : row[8]) || '',
          isTag ? '' : (row[4] || '').toLowerCase(),
          isTag ? '' : row[9] || '',
        );
        if (score < 0) continue;
        count++;
        if (buckets[score].length < pageEnd) buckets[score].push(row);
      }
    }
    let results = buckets.flat();
    if (needle || kind === 'tags') results = results.slice(offset, pageEnd);
    let details, detailsUnavailable;
    if (kind === 'character' && data.includeDetails) {
      try {
        const all = await getFile('character-details');
        details = Object.fromEntries(
          results.map((row) => [
            row[0],
            Array.isArray(all?.[row[0]]) ? all[row[0]].filter((tag) => typeof tag === 'string') : [],
          ]),
        );
      } catch {
        detailsUnavailable = true;
      }
      if (recent.get(channel) !== id) {
        self.postMessage({ id, stale: true });
        return;
      }
    }
    self.postMessage({ id, count, results, details, detailsUnavailable });
  } catch (error) {
    self.postMessage({ id, error: error.message || '无法读取本地索引' });
  }
};
