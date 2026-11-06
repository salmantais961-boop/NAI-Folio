export const IMAGE_SIZES = {
  normal: { label: 'Normal', portrait: [832, 1216], landscape: [1216, 832], square: [1024, 1024] },
  large: { label: 'Large', portrait: [1024, 1536], landscape: [1536, 1024], square: [1472, 1472] },
  wallpaper: { label: 'Wallpaper', portrait: [1088, 1920], landscape: [1920, 1088] },
  small: { label: 'Small', portrait: [512, 768], landscape: [768, 512], square: [640, 640] },
}

export function matchImageSize(width, height) {
  for (const [category, preset] of Object.entries(IMAGE_SIZES))
    for (const orientation of ['portrait', 'landscape', 'square'])
      if (preset[orientation]?.[0] === width && preset[orientation]?.[1] === height)
        return { category, orientation }
  return null
}

// Folio's editable negative prompts. Model keys match the generation controls.
const light = 'unreadable lettering, distracting watermark, compression blocks'
const heavy = light + ', tangled outlines, uneven facial features, broken perspective, cropped fingertips, duplicate objects'
const common = { heavy, light, none: '' }
const portrait = { ...common, humanFocus: heavy + ', misplaced joints, overlapping fingers, misaligned eyes' }
const extended = { ...portrait, furryFocus: heavy + ', merged paws, stray tails, irregular muzzle' }

export const UC = {
  'nai-diffusion-5-full': { ...extended },
  'nai-diffusion-5-curated': { ...extended },
  'nai-diffusion-4-5-full': { ...extended },
  'nai-diffusion-4-5-curated': { ...portrait },
  'nai-diffusion-4-full': { ...common },
  'nai-diffusion-4-curated-preview': { ...common },
  'nai-diffusion-3': { ...portrait },
  'nai-diffusion-furry-3': { ...common },
}
