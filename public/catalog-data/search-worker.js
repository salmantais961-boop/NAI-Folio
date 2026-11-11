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

function getFile(name, optional = false, base = catalogRoot) {
  if (!files.has(name)) {
    const pending = fetch(new URL(name + '.json', base))
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

let tagIndex;

function getTagIndex() {
  if (!tagIndex) {
    tagIndex = getFile('tags').then(rows => {
      const entries = rows.map(row => {
        const literal = row[0].trim().toLowerCase();
        const key = literal.includes('_') ? normalize(literal) : literal;
        const zh = normalize(row[1]);
        const category = row[2] || 0;
        // A translated character name may carry its series in one trailing qualifier.
        const shortName = [1, 3, 4].includes(category)
          ? zh.match(/^([^()（）]+?)\s*(?:（[^（）()]+）|\([^（）()]+\))$/)?.[1].trim() : '';
        const aliases = row[4] ? row[4].split('|').map(normalize).filter(Boolean) : null;
        return { row, key, literal, zh, category, shortName, aliases };
      });
      // Imports can arrive in any order. Each match tier then retains usage order.
      entries.sort((a, b) => (b.row[3] || 0) - (a.row[3] || 0));
      const byName = new Map();
      for (const entry of entries) byName.set(entry.literal, entry);
      for (const entry of entries) {
        if (entry.key !== entry.literal && !byName.has(entry.key)) byName.set(entry.key, entry);
      }
      return { entries, byName };
    }).catch(error => {
      tagIndex = null;
      files.delete('tags');
      throw error;
    });
  }
  return tagIndex;
}

function searchTags(index, query, category, offset, limit) {
  const literal = query.trim().toLowerCase();
  const needle = normalize(literal);
  const words = needle.split(' ');
  const wordStart = ' ' + needle, qualifiedStart = '(' + needle, wholeWord = wordStart + ' ';
  const buckets = Array.from({ length: 14 }, () => []);
  const pageEnd = offset + limit;
  // Only the most used entity gets the shorthand boost. A single letter/digit
  // is a broad search, not a request for every artist named "A" or "2".
  let promoteShortName = needle.length >= 2 && /\p{Script=Han}/u.test(needle);
  let count = 0;
  for (const { row, key, literal: name, zh, category: kind, shortName, aliases } of index.entries) {
    if (category !== null && kind !== category) continue;
    const other = kind === 0 ? 0 : 1;
    let score;
    if (!literal) score = other;
    else if (literal === name) score = other;
    else if (!needle) continue;
    else if (key === needle || zh === needle) score = 2 + other;
    else if (aliases?.includes(needle)) score = 4 + other;
    else if (promoteShortName && shortName === needle) {
      promoteShortName = false;
      score = 4 + other;
    }
    // Within a strong match, put general terms first. A whole word such as
    // "hair" in "long hair" is as precise as the start of "hair ornament".
    else if (key.startsWith(needle) || zh.startsWith(needle) || key.endsWith(wordStart) || key.includes(wholeWord))
      score = 6 + 2 * other;
    else if (key.includes(wordStart) || key.includes(qualifiedStart) || aliases?.some(alias => alias.startsWith(needle)))
      score = 7 + 2 * other;
    else if (key.includes(needle) || zh.includes(needle) || aliases?.some(alias => alias.includes(needle)))
      score = 10 + other;
    else if (words.length > 1 && words.every(word => key.includes(word) || zh.includes(word)))
      score = 12 + other;
    else continue;
    count++;
    if (buckets[score].length < pageEnd) buckets[score].push(row);
  }
  return { count, results: buckets.flat().slice(offset, pageEnd) };
}

// Load only the selected tag's shard. Four recent shards cover backtracking
// without permanently retaining the entire decoded pair graph in a tab.
const pairShards = new Set();
async function countedPairs(key) {
  let hash = 2166136261;
  for (const char of key) hash = Math.imul(hash ^ char.codePointAt(0), 16777619);
  const path = 'cooccurrence/' + (hash & 15).toString(16).padStart(2, '0');
  pairShards.delete(path);
  pairShards.add(path);
  if (pairShards.size > 4) {
    const oldest = pairShards.values().next().value;
    files.delete(oldest);
    pairShards.delete(oldest);
  }
  // Imported dictionaries can filter candidates, but only bundled public samples count.
  const rows = await getFile(path, true, self.location.href).catch(() => ({}));
  return rows && Object.hasOwn(rows, key) ? rows[key] : null;
}

async function relatedTags(index, query, exclude, limit) {
  const literal = query.trim().toLowerCase();
  const seed = index.byName.get(literal) || index.byName.get(normalize(literal));
  if (!seed) return { results: [] };

  const pairs = await countedPairs(seed.literal);
  if (!Array.isArray(pairs) || !Number.isSafeInteger(pairs[0]) || pairs[0] <= 0 || !Array.isArray(pairs[1]))
    return { results: [] };
  const [sampleSize, neighbours] = pairs;
  const used = characterTokens(exclude);
  used.add(seed.key);
  const results = [];
  const evidence = Object.create(null);
  // The shard already ranks public pairs by category and association strength.
  for (const pair of neighbours) {
    if (!Array.isArray(pair)) continue;
    const [name, shared] = pair;
    const item = index.byName.get(name);
    if (!item || used.has(item.key) || !Number.isSafeInteger(shared) || shared <= 0 || shared > sampleSize) continue;
    results.push(item.row);
    evidence[item.row[0]] = { shared };
    used.add(item.key);
    if (results.length === limit) break;
  }
  return results.length ? { results, recommendation: 'cooccurrence', evidence, sampleSize } : { results };
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
    if (kind === 'tags' || kind === 'related-tags') {
      const index = await getTagIndex();
      if (recent.get(channel) !== id) {
        self.postMessage({ id, stale: true });
        return;
      }
      const page = kind === 'tags'
        ? searchTags(index, query, category, offset, limit)
        : await relatedTags(index, query, data.exclude, limit);
      self.postMessage(recent.get(channel) === id
        ? { id, count: page.results.length, ...page } : { id, stale: true });
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
    if (!needle) {
      count = rows.length;
      buckets[0] = rows.slice(offset, pageEnd);
    } else {
      for (const row of rows) {
        const score = relevance(
          needle,
          words,
          row[0],
          row[3] || '',
          row[8] || '',
          (row[4] || '').toLowerCase(),
          row[9] || '',
        );
        if (score < 0) continue;
        count++;
        if (buckets[score].length < pageEnd) buckets[score].push(row);
      }
    }
    let results = buckets.flat();
    if (needle) results = results.slice(offset, pageEnd);
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
