import { promptMoveParts } from './prompt-move.js';

const separator = /[,，、\n|]/;

function protectedRanges(text) {
  const ranges = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    const macro = text.startsWith('!macro:', i),
      random = text.startsWith('||', i);
    if (!macro && !random) continue;
    const marker = macro ? '!' : '||',
      at = text.indexOf(marker, i + (macro ? 7 : 2));
    const end = at < 0 ? text.length : at + marker.length;
    ranges.push({ from: i, to: end });
    i = end - 1;
  }
  return ranges;
}

function balancedBrackets(text, protectedParts = []) {
  const stack = [];
  let protectedIndex = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    const protectedPart = protectedParts[protectedIndex];
    if (protectedPart?.from === i) {
      i = protectedPart.to - 1;
      protectedIndex++;
      continue;
    }
    const char = text[i];
    if ('{[('.includes(char)) stack.push(char);
    else if ('}])'.includes(char)) {
      if (stack.pop() !== { '}': '{', ']': '[', ')': '(' }[char]) return false;
    }
  }
  return !stack.length;
}

function trimBody(text) {
  let body = text.trim();
  // Keep separators outside the replaced interval. A body's final comma is
  // metadata, not permission to concatenate a macro with the following tag.
  while (body && separator.test(body.at(-1))) {
    let escapes = 0;
    for (let i = body.length - 2; i >= 0 && body[i] === '\\'; i--) escapes++;
    if (escapes % 2) break;
    body = body.slice(0, -1).trimEnd();
  }
  return body;
}

function wholeWeightBody(text) {
  const numeric = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)::)([\s\S]*)::$/.exec(text);
  if (numeric && !numeric[2].includes('::')) return { from: numeric[1].length, to: text.length - 2 };
  const close = { '{': '}', '[': ']' }[text[0]];
  if (!close || text.at(-1) !== close) return null;
  const protectedParts = protectedRanges(text);
  let depth = 0,
    protectedIndex = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    const protectedPart = protectedParts[protectedIndex];
    if (protectedPart?.from === i) {
      i = protectedPart.to - 1;
      protectedIndex++;
      continue;
    }
    if (text[i] === text[0]) depth++;
    if (text[i] === close) depth--;
    if (!depth && i < text.length - 1) return null;
  }
  return { from: 1, to: text.length - 1 };
}

/** Fold exact contiguous complete tag sequences while preserving source syntax.
 * Interior whitespace and every weight marker are deliberately significant.
 * Offsets in a folded body snap to the macro end; its leading boundary stays put.
 */
export function foldExactChunks(text, candidates) {
  if (typeof text !== 'string' || !text || !Array.isArray(candidates)) return null;
  const protectedParts = protectedRanges(text);
  if (!balancedBrackets(text, protectedParts)) return null;
  const unique = new Map();
  for (const [order, candidate] of candidates.entries()) {
    if (
      typeof candidate?.name !== 'string' ||
      !candidate.name.trim() ||
      /[!\r\n]/.test(candidate.name) ||
      typeof candidate.text !== 'string'
    )
      continue;
    if (protectedRanges(candidate.text).length) continue;
    const body = trimBody(candidate.text);
    if (!body || unique.has(body) || !balancedBrackets(body) || !promptMoveParts(body).closed) continue;
    unique.set(body, { name: candidate.name, body, order });
  }
  const blocks = [...unique.values()].sort((a, b) => b.body.length - a.body.length || a.order - b.order);
  if (!blocks.length) return null;
  const found = [],
    regions = [{ from: 0, to: text.length, depth: 0 }];
  for (let cursor = 0; cursor < regions.length; cursor++) {
    const region = regions[cursor],
      source = text.slice(region.from, region.to);
    const parsed = promptMoveParts(source);
    if (!parsed.closed) continue;
    const ends = new Set(parsed.parts.map((part) => region.from + part.to));
    for (const part of parsed.parts) {
      const from = region.from + part.from;
      for (const block of blocks) {
        const to = from + block.body.length;
        if (
          !ends.has(to) ||
          !text.startsWith(block.body, from) ||
          protectedParts.some((span) => from < span.to && to > span.from)
        )
          continue;
        found.push({ name: block.name, from, to, order: block.order });
      }
      if (region.depth < 256) {
        const body = wholeWeightBody(part.text);
        if (body && body.to > body.from)
          regions.push({ from: from + body.from, to: from + body.to, depth: region.depth + 1 });
      }
    }
  }
  // Prefer the longest whole body, even when a shorter match begins earlier.
  // A stable first-candidate tie-break prevents duplicate-body blocks flickering.
  found.sort((a, b) => b.to - b.from - (a.to - a.from) || a.order - b.order || a.from - b.from);
  const chosen = [];
  for (const match of found) {
    if (chosen.some((other) => match.from < other.to && match.to > other.from)) continue;
    chosen.push(match);
  }
  if (!chosen.length) return null;
  chosen.sort((a, b) => a.from - b.from);
  const output = [],
    matches = [];
  let previousEnd = 0,
    difference = 0;
  for (const { name, from, to } of chosen) {
    const replacement = '!macro:' + name + '!';
    output.push(text.slice(previousEnd, from), replacement);
    const newFrom = from + difference,
      newTo = newFrom + replacement.length;
    matches.push({ name, from, to, replacement, newFrom, newTo });
    previousEnd = to;
    difference += replacement.length - (to - from);
  }
  output.push(text.slice(previousEnd));
  const value = output.join('');
  return {
    value,
    matches,
    mapPosition(offset) {
      const position = Math.max(0, Math.min(text.length, Number.isFinite(offset) ? Math.trunc(offset) : 0));
      let shift = 0;
      for (const match of matches) {
        if (position < match.from) return position + shift;
        if (position === match.from) return match.newFrom;
        if (position <= match.to) return match.newTo;
        shift += match.replacement.length - (match.to - match.from);
      }
      return position + shift;
    },
  };
}
