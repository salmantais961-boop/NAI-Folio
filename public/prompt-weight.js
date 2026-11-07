import { promptMoveParts } from './prompt-move.js';

export function unwrap(text) {
  let body = text,
    layers = 0,
    offset = 0,
    weight = 1;
  const num = /^(-?(?:\d+(?:\.\d*)?|\.\d+))::([\s\S]*)::$/.exec(body);
  if (num && !num[2].includes('::')) {
    weight = Number(num[1]);
    body = num[2];
    offset = num[1].length + 2;
  }
  while ((body.startsWith('{') && body.endsWith('}')) || (body.startsWith('[') && body.endsWith(']'))) {
    const left = body[0],
      right = body.at(-1);
    let depth = 0,
      balanced = true;
    for (let i = 0; i < body.length - 1; i++) {
      if (body[i] === '\\') {
        i++;
        continue;
      }
      if (body[i] === left) depth++;
      else if (body[i] === right) depth--;
      if (depth === 0) {
        balanced = false;
        break;
      }
    }
    if (!balanced) break;
    layers += left === '{' ? 1 : -1;
    offset++;
    body = body.slice(1, -1);
  }
  return { body, weight: weight * 1.05 ** layers, layers, offset };
}

function wrapper(weight, cap) {
  if (weight === 1) return { open: '', close: '' };
  if (cap.numeric) return { open: Number(weight.toFixed(2)) + '::', close: '::' };
  const depth = Math.max(-80, Math.min(80, Math.round(Math.log(weight) / Math.log(1.05))));
  return {
    open: (depth > 0 ? '{' : '[').repeat(Math.abs(depth)),
    close: (depth > 0 ? '}' : ']').repeat(Math.abs(depth)),
  };
}

export function formatWeight(body, weight, cap) {
  if (!body.trim()) return body;
  const { open, close } = wrapper(weight, cap);
  return open + body + close;
}

// Treat the selection as a half-open interval. Visit the tags inside shared
// weights, keeping each original wrapper available for any untouched sibling.
export function weightSelectedTags(text, start, end, nextWeight, cap) {
  const affected = promptMoveParts(text).parts.filter(part => part.from < end && start < part.to);
  if (start >= end || !affected.length) return null;
  const from = affected[0].from, to = affected.at(-1).to;
  const groups = [];
  let gap = '';

  function visit(part, origin, hitFrom, hitTo, inherited) {
    const raw = part.text;
    const at = origin + part.from;
    const parsed = unwrap(raw);
    const weight = inherited.weight * parsed.weight;
    if (parsed.body !== raw) {
      const children = promptMoveParts(parsed.body).parts;
      if (children.length) {
        const bodyAt = at + parsed.offset;
        const emphasis = {
          weight,
          open: inherited.open + raw.slice(0, parsed.offset),
          close: raw.slice(parsed.offset + parsed.body.length) + inherited.close,
        };
        let cursor = 0;
        for (const child of children) {
          gap += parsed.body.slice(cursor, child.from);
          visit(
            child, bodyAt,
            child === children[0] ? hitFrom : bodyAt + child.from,
            child === children.at(-1) ? hitTo : bodyAt + child.to,
            emphasis,
          );
          cursor = child.to;
        }
        gap += parsed.body.slice(cursor);
        return;
      }
    }
    const selected = hitFrom < end && start < hitTo;
    const { open, close } = selected ? wrapper(nextWeight(weight), cap) : inherited;
    const last = groups.at(-1);
    if (last && last.selected === selected && last.open === open && last.close === close && !/[|｜\n]/.test(gap)) {
      last.body += gap + raw;
    } else {
      groups.push({ gap, open, close, body: raw, selected });
    }
    gap = '';
  }

  let cursor = from;
  const plain = { weight: 1, open: '', close: '' };
  for (const part of affected) {
    gap += text.slice(cursor, part.from);
    visit(part, 0, part.from, part.to, plain);
    cursor = part.to;
  }
  let replacement = '', selectedFrom, selectedTo;
  for (const group of groups) {
    replacement += group.gap;
    if (group.selected) selectedFrom ??= from + replacement.length;
    replacement += group.open + group.body + group.close;
    if (group.selected) selectedTo = from + replacement.length;
  }
  if (selectedFrom === undefined) return null;
  return { from, to, replacement: replacement + gap, selectedFrom, selectedTo };
}
