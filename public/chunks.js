import { importedChunks } from './imported-chunks.js';

const storageKey = 'folio.prompt.chunks';
const importKey = 'folio.prompt.imported.folio-starters.v1';
const starters = [
  { name: '柔和侧光', category: '光影', text: 'soft lighting, sidelighting, rim light' },
  { name: '空气透视', category: '构图', text: 'atmospheric perspective, depth of field' },
  { name: '清透色彩', category: '色彩', text: 'soft colors, pastel colors' },
];
const changes = new EventTarget();
function addImportedChunks(rows) {
  const merged = [...rows];
  const byName = new Map(rows.map((row) => [row.name, row]));
  for (const block of importedChunks) {
    let name = block.name;
    let suffix = 1;
    while (byName.has(name)) {
      const existing = byName.get(name);
      if (!existing.retired && existing.text === block.text) break;
      name = block.name + (suffix === 1 ? '（导入）' : '（导入 ' + suffix + '）');
      suffix++;
    }
    if (byName.has(name)) continue;
    const added = { ...block, name };
    byName.set(name, added);
    merged.push(added);
  }
  return merged;
}
function readStoredLibrary() {
  let rows = starters;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw !== null) {
      const saved = JSON.parse(raw);
      if (!Array.isArray(saved)) return addImportedChunks(starters);
      rows = saved.filter((r) => typeof r?.name === 'string' && typeof r?.text === 'string');
      if (localStorage.getItem(importKey) === '1') return rows;
    }
  } catch {
    return addImportedChunks(rows);
  }
  const merged = addImportedChunks(rows);
  try {
    localStorage.setItem(storageKey, JSON.stringify(merged));
    localStorage.setItem(importKey, '1');
  } catch {
    /* The complete library is still available when storage is full. */
  }
  return merged;
}
function stableChunkId(name) {
  let a = 2166136261,
    b = 5381;
  for (const letter of name) {
    a = Math.imul(a ^ letter.codePointAt(0), 16777619);
    b = Math.imul(b, 33) ^ letter.codePointAt(0);
  }
  return 'block-' + (a >>> 0).toString(36) + '-' + (b >>> 0).toString(36);
}
function readLibrary() {
  return readStoredLibrary().map((record) => ({ ...record, id: record.id || stableChunkId(record.name) }));
}
let records = readLibrary();
globalThis.addEventListener?.('storage', (e) => {
  if (e.key === storageKey || e.key === null) {
    records = readLibrary();
    changes.dispatchEvent(new Event('change'));
  }
});
export const listChunks = () => records.filter((r) => !r.retired);
export function readChunks() {
  records = readLibrary();
  return listChunks();
}
export function watchChunks(fn) {
  changes.addEventListener('change', fn);
  return () => changes.removeEventListener('change', fn);
}
const needle = (s) => s.toLocaleLowerCase().replaceAll('_', ' ').trim();
export function findChunks(query = '') {
  const q = needle(query);
  return listChunks()
    .filter((c) => [c.name, c.category || '', c.text].some((s) => needle(s).includes(q)))
    .sort((a, b) => Number(needle(b.name).startsWith(q)) - Number(needle(a.name).startsWith(q)));
}
export const reference = (name) => '!macro:' + name + '!';
export function expandChunks(text, library = records) {
  const byName = new Map(library.map((r) => [r.name, r.text]));
  const memo = new Map();
  function expand(input, path) {
    if (typeof input !== 'string' || input.length > 100000 || path.length > 16)
      throw Error('提示词片段嵌套过深或内容过长。');
    const output = [];
    let length = 0,
      end = 0;
    function append(part) {
      length += part.length;
      if (length > 100000) throw Error('展开后的提示词过长。');
      output.push(part);
    }
    for (const match of input.matchAll(/!macro:([^!\n]+)!/g)) {
      append(input.slice(end, match.index));
      end = match.index + match[0].length;
      const name = match[1];
      if (!byName.has(name)) throw Error('找不到提示词片段「' + name + '」。');
      if (path.includes(name)) throw Error('提示词片段「' + name + '」循环引用。');
      if (!memo.has(name)) memo.set(name, expand(byName.get(name), [...path, name]));
      append(memo.get(name));
    }
    append(input.slice(end));
    return output.join('');
  }
  return expand(text, []);
}
export function expandPrompt(text, library = records) {
  return expandChunks(text, library).replace(/\|\|([\s\S]*?)\|\|/g, (_, body) => {
    const choices = body.split('|');
    return choices[Math.floor(Math.random() * choices.length)].trim();
  });
}

/** Resolve one submitted caption and record only the chunks actually selected. */
export function resolvePromptReferences(text, library = records) {
  const byName = new Map(library.map((row) => [row.name, row]));
  const used = new Map();
  let visits = 0;
  function resolve(input, path) {
    if (typeof input !== 'string' || input.length > 100000 || path.length > 16 || ++visits > 100000)
      throw Error('提示词片段嵌套过深或内容过长。');
    // Choose before walking references: a discarded alternative may contain a
    // different OC, a missing chunk, or even a cycle, none of which is submitted.
    const selected = input.replace(/\|\|([\s\S]*?)\|\|/g, (_, body) => {
      const choices = body.split('|');
      return choices[Math.floor(Math.random() * choices.length)].trim();
    });
    const output = [];
    let length = 0,
      end = 0;
    function append(part) {
      length += part.length;
      if (length > 100000) throw Error('展开后的提示词过长。');
      output.push(part);
    }
    for (const match of selected.matchAll(/!macro:([^!\n]+)!/g)) {
      append(selected.slice(end, match.index));
      end = match.index + match[0].length;
      const name = match[1],
        row = byName.get(name);
      if (!row) throw Error('找不到提示词片段「' + name + '」。');
      if (path.includes(name)) throw Error('提示词片段「' + name + '」循环引用。');
      if (!row.retired) {
        const id = row.id || stableChunkId(row.name);
        if (!used.has(id)) used.set(id, { ...row, id });
      }
      // Each occurrence gets its own random choice, as in expandPrompt. Do not
      // memoize a randomized body and accidentally couple repeated occurrences.
      append(resolve(row.text, [...path, name]));
    }
    append(selected.slice(end));
    return output.join('');
  }
  const resolved = resolve(text, []);
  // Complete syntax must live in one caption or chunk. Joining fragments into a
  // new expression after expansion would cause a second, untracked random draw.
  if (/\|\|[\s\S]*?\|\||!macro:([^!\n]+)!/.test(resolved))
    throw Error('请将完整的随机候选或词块引用写在同一段提示词中，不要跨词块拼接。');
  return { text: resolved, chunks: [...used.values()] };
}
function commit(next, detail) {
  localStorage.setItem(storageKey, JSON.stringify(next));
  records = next;
  changes.dispatchEvent(new CustomEvent('change', { detail }));
}
export function saveChunk(previous, data) {
  const name = data.name.trim(),
    text = data.text.trim(),
    category = data.category.trim() || '我的';
  if (!name || name.length > 60 || /[!\n\r]/.test(name))
    throw Error('名称应为 1–60 个字符，不能含换行或感叹号。');
  if (!text) throw Error('请填写这个词块的提示词。');
  if (category.length > 30) throw Error('分组名最多 30 个字符。');
  const current = readLibrary();
  const old = current.find((record) => !record.retired && record.name === previous);
  if (previous && !current.some((r) => !r.retired && r.name === previous))
    throw Error('该词块已在其他窗口更改，请刷新列表。');
  if (name !== previous && current.some((r) => !r.retired && r.name === name))
    throw Error('已有同名词块，请更换名称。');
  let next = current.filter((r) => r.name !== name && r.name !== previous);
  let storedText = text,
    detail;
  if (previous && previous !== name) {
    const oldRef = reference(previous),
      newRef = reference(name);
    // Old recipes can still resolve their original names. New prompts display
    // the new name and other saved blocks are updated together in one write.
    next = next.map((r) => ({ ...r, text: r.text.replaceAll(oldRef, () => newRef) }));
    storedText = text.replaceAll(oldRef, () => newRef);
    next.push({ name: previous, text: newRef, retired: true });
    detail = { from: oldRef, to: newRef };
  }
  next.unshift({
    name,
    category,
    text: storedText,
    id: old?.id || data.id || crypto.randomUUID(),
    ...(data.atlasId || old?.atlasId ? { atlasId: data.atlasId || old.atlasId } : {}),
    ...(['oc', 'example'].includes(data.kind || old?.kind) ? { kind: data.kind || old.kind } : {}),
  });
  expandChunks(reference(name), next);
  commit(next, detail);
  return name;
}

export function updateChunkLink(id, { atlasId, kind } = {}) {
  const current = readLibrary(),
    target = current.find((row) => !row.retired && row.id === id);
  if (!target || (target.atlasId === atlasId && target.kind === kind)) return;
  if (atlasId != null && typeof atlasId !== 'string') throw Error('词块关联无效。');
  if (kind != null && !['oc', 'example'].includes(kind)) throw Error('词块类型无效。');
  commit(current.map((row) => (row.id === id && !row.retired ? { ...row, atlasId, kind } : row)));
}

// Record explicit references before expansion. Recursive references count too;
// typing matching plain tags never silently opts into an automatic example image.
export function referencedChunks(texts, library = records) {
  const byName = new Map(library.map((row) => [row.name, row]));
  const found = new Map(),
    visited = new Set();
  function visit(text, depth = 0) {
    if (depth > 16) return;
    for (const match of String(text || '').matchAll(/!macro:([^!\n]+)!/g)) {
      const row = byName.get(match[1]);
      if (!row || visited.has(row.name)) continue;
      visited.add(row.name);
      if (!row.retired) found.set(row.id || stableChunkId(row.name), row);
      visit(row.text, depth + 1);
    }
  }
  for (const text of Array.isArray(texts) ? texts : [texts]) visit(text);
  return [...found.values()];
}

function joinChunkText(parts) {
  let text = parts[0].trim();
  for (const part of parts.slice(1)) {
    let next = part.trim();
    if (/[,，、]$/.test(text)) text = text.slice(0, -1).trimEnd();
    if (/^[,，、]/.test(next)) next = next.slice(1).trimStart();
    text += ',\n' + next;
    if (text.length > 100000) throw Error('合并后的提示词超过 100,000 个字符，请减少选择。');
  }
  return text;
}

export function prepareChunkMerge(names) {
  if (!Array.isArray(names) || names.length < 2 || new Set(names).size !== names.length)
    throw Error('请选择至少两个不同的词块。');
  const library = readLibrary();
  const sources = names.map((name) => {
    const item = library.find((row) => !row.retired && row.name === name);
    if (!item) throw Error('源词块「' + name + '」已在其他窗口更改，请重新选择。');
    const expanded = expandChunks(reference(name), library);
    if (!expanded.trim()) throw Error('源词块「' + name + '」展开后没有提示词。');
    return { name, category: item.category || '我的', text: item.text, expanded };
  });
  return { sources, text: joinChunkText(sources.map((source) => source.expanded)) };
}

export function saveMergedChunk(merge, data) {
  if (!Array.isArray(merge?.sources) || merge.sources.length < 2) throw Error('请选择至少两个不同的词块。');
  const latest = prepareChunkMerge(merge.sources.map((source) => source.name));
  if (
    latest.sources.some(
      (source, index) =>
        source.text !== merge.sources[index].text || source.expanded !== merge.sources[index].expanded,
    )
  )
    throw Error('源词块已在其他窗口更改，请返回选块并重新预览。');
  // A merged block stores an independent snapshot. Random alternatives stay
  // literal, and repeated tags and emphasis remain exactly as the user wrote them.
  return saveChunk('', { ...data, text: expandChunks(data.text, readLibrary()) });
}
export function removeChunk(name, expectedId, expectedText) {
  const current = readLibrary(),
    target = current.find((r) => r.name === name && !r.retired);
  if (
    !target ||
    (expectedId != null && target.id !== expectedId) ||
    (expectedText != null && target.text !== expectedText)
  ) return false;
  let expanded;
  try {
    expanded = expandChunks(reference(name), current);
  } catch {
    expanded = target.text;
  } // Older libraries may refer to a previously deleted chunk.
  // Keep a snapshot under the historical name so archived recipes can open.
  const next = current.map((r) =>
    r.name === name
      ? { name, text: expanded, retired: true }
      : { ...r, text: r.text.replaceAll(reference(name), () => expanded) },
  );
  commit(next, { from: reference(name), to: expanded });
  return true;
}

/** Native editing transaction keeps toolbar changes on the textarea's undo stack. */
export function replaceEditorRange(field, from, to, value, selectStart, selectEnd) {
  if (field.promptEditor) {
    field.focus({ preventScroll: true });
    field.promptEditor.replace(from, to, value, selectStart, selectEnd);
    return;
  }
  field.focus({ preventScroll: true });
  field.setSelectionRange(from, to);
  let nativeEvent = false;
  const seen = () => {
    nativeEvent = true;
  };
  field.addEventListener('input', seen, { once: true });
  let ok = false;
  try {
    if (value !== '' || from !== to)
      ok = document.execCommand(value === '' ? 'delete' : 'insertText', false, value);
  } catch {}
  field.removeEventListener('input', seen);
  if (!ok && !nativeEvent) field.setRangeText(value, from, to, 'end');
  if (!nativeEvent) field.dispatchEvent(new Event('input', { bubbles: true }));
  const a = selectStart ?? from + value.length,
    b = selectEnd ?? a;
  field.setSelectionRange(a, b);
}
// Kept for older shells which still expose the library inside their recipe dialog.
export function initChunks(target) {
  const legacy = document.querySelector('#chunks');
  if (!legacy) return;
  const summary = document.createElement('summary');
  summary.textContent = '我的提示词块';
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = '打开词块库';
  open.onclick = async () => {
    const field = target();
    legacy.closest('dialog')?.close();
    (await import('./prompt-tools.js')).openBlockLibrary(field);
  };
  legacy.replaceChildren(summary, open);
}
