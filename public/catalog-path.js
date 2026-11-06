// A cover is always a raster file served from this catalog's covers directory.
export function isLocalCover(path) {
  if (typeof path !== 'string' || !path.startsWith('covers/') || !/\.(webp|png|jpe?g|avif)$/i.test(path)) return false;
  return path.split('/').every((part) => part && !part.startsWith('.') && /^[\p{L}\p{N}_ .()-]+$/u.test(part));
}
