// Deliberately conservative: a role marker must start its own line, outside
// weighted groups and fenced examples. Ordinary tags containing ':' stay put.
const roleHeader = /^[\t ]*(?:character[\t ]+([1-9]\d{0,2})|角色[\t ]*([1-9]\d{0,2}))[\t ]*[:：][\t ]*(.*)$/iu;
const boundaryHeader =
  /^[\t ]*(?:(?:global|base|main)(?:[\t ]+(?:prompt|positive))?|(?:negative|positive)(?:[\t ]+prompt)?|undesired[\t ]+content|全局(?:正向)?(?:提示词)?|主(?:正向)?提示词|正向(?:提示词)?|负面(?:提示词)?|负向(?:提示词)?)[\t ]*[:：]/iu;

function balanced(text) {
  const stack = [];
  let weighted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text.startsWith('||', i)) {
      const end = text.indexOf('||', i + 2);
      if (end < 0) return false;
      i = end + 1;
      continue;
    }
    if (text.startsWith('!macro:', i)) {
      const end = text.indexOf('!', i + 7);
      if (end < 0) return false;
      i = end;
      continue;
    }
    const char = text[i];
    if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) return false;
    } else if (text.startsWith('::', i)) {
      if (weighted) weighted = false;
      else if (/(?:^|[\s,，{[])[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text.slice(0, i))) weighted = true;
      else return false;
      i++;
    }
  }
  return !stack.length && !weighted;
}

export function parseCharacterSections(value) {
  const source = String(value ?? '');
  if (!source || source.length > 100000) return null;
  const markers = [];
  let offset = 0,
    fenced = false,
    negative = false;
  for (const line of source.match(/[^\n]*(?:\n|$)/gu) || []) {
    if (!line) continue;
    const text = line.replace(/[\r\n]+$/u, '');
    if (/^[\t ]*(?:```|~~~)/u.test(text)) fenced = !fenced;
    if (!fenced) {
      const role = text.match(roleHeader);
      if (role && !negative && balanced(source.slice(0, offset))) {
        const colon = text.search(/[:：]/u);
        markers.push({
          type: 'role',
          from: offset,
          bodyStart: offset + colon + 1,
          number: Number(role[1] || role[2]),
        });
      } else if (boundaryHeader.test(text)) {
        markers.push({ type: 'boundary', from: offset });
        negative = /^[\t ]*(?:negative|undesired|负面|负向)/iu.test(text);
      }
    }
    offset += line.length;
  }
  const sections = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    if (marker.type !== 'role') continue;
    const to = markers[i + 1]?.from ?? source.length;
    const prompt = source.slice(marker.bodyStart, to).trim();
    if (!prompt || !balanced(prompt) || /^[\s,，;；]+$/u.test(prompt)) continue;
    sections.push({ from: marker.from, to, number: marker.number, name: '角色 ' + marker.number, prompt });
  }
  if (!sections.length) return null;
  let remaining = '',
    cursor = 0;
  for (const section of sections) {
    remaining += source.slice(cursor, section.from);
    cursor = section.to;
  }
  remaining += source.slice(cursor);
  return { source, remaining, sections };
}

export function planCharacterMigration(settings, sections, capacity) {
  if (!capacity) throw Error('当前模型不支持多角色，角色段落已保留在原文。请先切换到 V4 或更新模型。');
  const characters = (settings.characters || []).map((character) => ({ ...character }));
  if (characters.length > capacity)
    throw Error(`当前角色数量已超过模型的 ${capacity} 个上限，原文已完整保留。请先整理多角色栏。`);
  const free = characters.reduce(
    (count, character) => count + (!character.prompt?.trim() && !character.negative?.trim() ? 1 : 0),
    0,
  );
  if (sections.length > Math.max(0, capacity - characters.length) + free)
    throw Error(`检测到 ${sections.length} 个角色，但当前模型剩余位置不足；原文已完整保留。`);
  const migrated = [];
  for (const section of sections) {
    let slot = characters.findIndex((character) => !character.prompt?.trim() && !character.negative?.trim());
    if (slot < 0) {
      slot = characters.length;
      characters.push({ negative: '', x: 0.5, y: 0.5, enabled: true });
    }
    characters[slot] = { ...characters[slot], prompt: section.prompt, enabled: true };
    migrated.push({ ...section, slot, expected: { ...characters[slot] } });
  }
  return { characters, migrated };
}
