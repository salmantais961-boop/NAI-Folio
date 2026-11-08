export function parseWorkTags(value) {
  const tags = new Map();
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (typeof entry !== 'string') continue;
    for (const part of entry.split(/[,，、\r\n]+/u)) {
      const tag = part.trim().replace(/\s+/gu, ' ');
      const key = tag.normalize('NFKC').toLowerCase();
      if (key && !tags.has(key)) tags.set(key, tag);
    }
  }
  return [...tags.values()];
}

export function archiveSearchText(work) {
  return [
    work.prompt || '',
    ...(work.settings?.characters || [])
      .filter((character) => character.enabled !== false)
      .map((character) => character.prompt || ''),
    ...(work.galleryTags || []),
  ];
}
