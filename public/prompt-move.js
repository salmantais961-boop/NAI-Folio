// Move only complete macro atoms. Drop points stay outside enclosing prompt
// groups so a moved block never inherits an unrelated destination weight.
export function promptMoveParts(text) {
  const parts = [];
  let start = 0,
    depth = 0,
    numeric = false;
  const finish = (end) => {
    const raw = text.slice(start, end),
      value = raw.trim();
    if (value) {
      const from = start + raw.indexOf(value);
      parts.push({ from, to: from + value.length, text: value });
    }
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text.startsWith('!macro:', i)) {
      const end = text.indexOf('!', i + 7);
      if (end >= 0) {
        i = end;
        continue;
      }
    }
    if (text.startsWith('||', i)) {
      const end = text.indexOf('||', i + 2);
      if (end >= 0) {
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith('::', i)) {
      let p = i - 1;
      while (p >= start && /[.\d]/.test(text[p])) p--;
      numeric = !numeric && p < i - 1 && /\d/.test(text[i - 1]);
      if (!numeric) depth = 0;
      i++;
      continue;
    }
    if ('{[('.includes(text[i])) {
      depth++;
      continue;
    }
    if ('}])'.includes(text[i])) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (!numeric && !depth && /[,，、\n|]/.test(text[i])) {
      finish(i);
      start = i + 1;
    }
  }
  finish(text.length);
  return { parts, closed: depth === 0 && !numeric };
}

function unwrapWhole(text) {
  let body = text.trim();
  for (;;) {
    const numeric = /^-?(?:\d+(?:\.\d*)?|\.\d+)::([\s\S]*)::$/.exec(body);
    if (numeric && !numeric[1].includes('::')) {
      body = numeric[1].trim();
      continue;
    }
    const left = body[0],
      right = left === '{' ? '}' : left === '[' ? ']' : '';
    if (!right || body.at(-1) !== right) return body;
    let depth = 0,
      whole = true;
    for (let i = 0; i < body.length - 1; i++) {
      if (body[i] === '\\') {
        i++;
        continue;
      }
      if (body[i] === left) depth++;
      if (body[i] === right) depth--;
      if (depth === 0) {
        whole = false;
        break;
      }
    }
    if (!whole) return body;
    body = body.slice(1, -1).trim();
  }
}

function weightedMacro(macro, weight, model) {
  if (!Number.isFinite(weight) || Math.abs(weight - 1) < 1e-10) return macro;
  if (!model || /nai-diffusion-(?:[4-9]|\d{2,})/.test(model)) return String(weight) + '::' + macro + '::';
  const depth = Math.max(-140, Math.min(140, Math.round(Math.log(weight) / Math.log(1.05))));
  return (
    (depth > 0 ? '{' : '[').repeat(Math.abs(depth)) + macro + (depth > 0 ? '}' : ']').repeat(Math.abs(depth))
  );
}

export function macroMoveSource(text, from, { weight = 1, model } = {}) {
  const match = /^!macro:[^!\n]+!/.exec(text.slice(from));
  if (!match) return null;
  const parsed = promptMoveParts(text);
  if (!parsed.closed) return null;
  const macro = match[0],
    to = from + macro.length;
  const part = parsed.parts.find((item) => from >= item.from && to <= item.to);
  if (!part || part.text.includes('||')) return null;
  if (unwrapWhole(part.text) === macro)
    return { from: part.from, to: part.to, text: part.text, macro, isolated: true };
  return { from, to, text: weightedMacro(macro, weight, model), macro, isolated: false };
}

export function macroDropStops(text) {
  const { parts } = promptMoveParts(text);
  return [...new Set([0, ...parts.flatMap((part) => [part.from, part.to]), text.length])].sort((a, b) => a - b);
}

export function moveMacro(text, source, target) {
  if (!source || (target >= source.from && target <= source.to)) return null;
  if (!macroDropStops(text).includes(target)) return null;
  let from = source.from,
    to = source.to;
  // Remove one neighboring delimiter, preserving all other prompt text and
  // wrappers verbatim. A single macro in its own wrapper moves that wrapper.
  const right = /^[ \t]*[,，、][ \t]*/.exec(text.slice(to));
  const left = /[,，、][ \t]*$/.exec(text.slice(0, from));
  if (right) to += right[0].length;
  else if (left) from -= left[0].length;
  else if (source.isolated) {
    const afterLine = /^[ \t]*\n/.exec(text.slice(to));
    const beforeLine = /\n[ \t]*$/.exec(text.slice(0, from));
    if (afterLine) to += afterLine[0].length;
    else if (beforeLine) from -= beforeLine[0].length;
  }
  const remaining = text.slice(0, from) + text.slice(to);
  const at = target >= to ? target - (to - from) : target > from ? from : target;
  const before = remaining.slice(0, at),
    after = remaining.slice(at);
  const leading = !before.trim() || /[,，、\n|]\s*$/.test(before) ? '' : ', ';
  const trailing = !after.trim() || /^\s*[,，、\n|]/.test(after) ? '' : ', ';
  const inserted = leading + source.text + trailing;
  const value = before + inserted + after;
  if (value === text) return null;
  return { value, from: at + leading.length, to: at + leading.length + source.text.length };
}
