export const normalizeSearch = (text) =>
  String(text || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[_\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function distanceWithin(left, right, limit) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    let best = i;
    for (let j = 1; j <= right.length; j++) {
      next[j] = Math.min(
        next[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + Number(left[i - 1] !== right[j - 1]),
      );
      best = Math.min(best, next[j]);
    }
    if (best > limit) return limit + 1;
    previous = next;
  }
  return previous[right.length];
}

/** Score is 0..1 (higher is closer), -1 means no match. All query words must match. */
export function fuzzyScore(text, query) {
  const source = normalizeSearch(Array.isArray(text) ? text.join(' ') : text),
    search = normalizeSearch(query);
  if (!search) return 1;
  if (!source) return -1;
  if (source === search) return 1;
  if (source.includes(search)) return 0.96;
  const words = source.split(' '),
    terms = [...new Set(search.split(' '))];
  let total = 0;
  for (const term of terms) {
    if (source.includes(term)) {
      total += 0.9;
      continue;
    }
    if (term.length < 4) return -1;
    const allowance = term.length >= 8 ? 2 : 1;
    let best = -1;
    for (const word of words) {
      if (Math.abs(word.length - term.length) > allowance) continue;
      const distance = distanceWithin(term, word, allowance);
      if (distance <= allowance) best = Math.max(best, 0.8 - distance * 0.15);
    }
    if (best < 0) return -1;
    total += best;
  }
  return total / terms.length;
}

export function searchItems(items, query, getText) {
  if (!normalizeSearch(query)) return [...items];
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(getText(item), query) }))
    .filter((result) => result.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}
