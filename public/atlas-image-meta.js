import { getWork } from './archive-store.js';
import { classifyWorkNSFW, NSFW_RULES_VERSION } from './nsfw-tags.js';
import { getHideNSFW } from './content-preferences.js';
import { readPngRecipe } from './png-recipe.js';
import { createRatingBadge } from './icons.js';

// An OC description or saved prompt belongs to the reusable entry, not its cover.
const blobMatches = new WeakMap();
const storedCovers = new WeakMap();
const pendingMatches = new WeakMap();
let pendingPng = Promise.resolve();

// Only objects read from IndexedDB may write an upgraded result back. An
// unsaved editor draft can share an entry ID while previewing a replacement.
export function trackStoredCover(entry, save) {
  if (entry?.blob && entry.imageNsfwVersion !== NSFW_RULES_VERSION) storedCovers.set(entry, save);
  return entry;
}

export function atlasImageMatches(entry) {
  if (!entry?.blob) return Promise.resolve([]);
  if (entry.imageNsfwVersion === NSFW_RULES_VERSION && Array.isArray(entry.imageNsfwTags))
    return Promise.resolve(entry.imageNsfwTags);
  const { blob, sourceWorkId, updated } = entry;
  const pending = pendingMatches.get(entry);
  if (pending?.blob === blob && pending.sourceWorkId === sourceWorkId) return pending.promise;
  const promise = (async () => {
    const source = sourceWorkId && await getWork(sourceWorkId);
    const previous = Array.isArray(entry.imageNsfwTags) ? entry.imageNsfwTags : [];
    const matches = source ? classifyWorkNSFW(source).matches : [...new Set([...previous, ...await pngMatches(blob)])];
    if (entry.blob === blob && entry.sourceWorkId === sourceWorkId && entry.updated === updated) {
      const save = storedCovers.get(entry);
      if (save) {
        // A cache-write failure must not prevent showing the freshly computed result.
        await save(entry, matches).catch(() => {});
        storedCovers.delete(entry);
      }
      entry.imageNsfwTags = matches;
      entry.imageNsfwVersion = NSFW_RULES_VERSION;
    }
    return matches;
  })();
  pendingMatches.set(entry, { blob, sourceWorkId, promise });
  promise.catch(() => {
    if (pendingMatches.get(entry)?.promise === promise) pendingMatches.delete(entry);
  });
  return promise;
}

function pngMatches(blob) {
  if (blob.type && blob.type !== 'image/png') return Promise.resolve([]);
  if (blobMatches.has(blob)) return blobMatches.get(blob);
  // A stealth PNG reader decodes a bitmap. Keep only one such read in flight.
  const read = pendingPng.then(async () => {
    try { return classifyWorkNSFW(await readPngRecipe(blob)).matches; }
    catch { return []; } // Ordinary illustrations may have no NovelAI metadata.
  });
  pendingPng = read;
  blobMatches.set(blob, read);
  return read;
}

export function markAtlasImage(host, matches) {
  const hidden = matches.length > 0 && getHideNSFW();
  host.toggleAttribute('data-sensitive-image', matches.length > 0);
  host.toggleAttribute('data-sensitive-hidden', hidden);
  const badge = host.querySelector(':scope > .nsfw-badge');
  if (!matches.length || hidden) badge?.remove();
  else if (!badge) host.append(createRatingBadge(matches));
  return hidden;
}
