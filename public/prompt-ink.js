import { mountPromptEditor } from './prompt-editor.js';

// Semantic runs retain exact raw text and weights. The visible editor turns
// macro runs into atomic print labels while the textarea stores their source.
const tokenPattern = /\\[\s\S]|!macro:[^!\n]+!|-?(?:\d+(?:\.\d+)?|\.\d+)::|::|[{}\[\],，、\n|]/g;
export const inkTone = (weight) =>
  weight < 0 ? 'negative' : Math.abs(weight - 1) < 1e-8 ? 'base' : weight > 1 ? 'strong' : 'weak';

export function inkRuns(text, model = 'nai-diffusion-5-full') {
  const modern = !model || /nai-diffusion-(?:[4-9]|\d{2,})/.test(model);
  const signed = modern && !/^nai-diffusion-4-(?:curated|full)/.test(model);
  const runs = [];
  let numeric = 1,
    depth = 0,
    activeNumber = false,
    end = 0;
  function push(value, kind) {
    if (value)
      runs.push({ value, kind, weight: numeric * Math.pow(1.05, Math.max(-140, Math.min(140, depth))) });
  }
  for (const match of text.matchAll(tokenPattern)) {
    push(text.slice(end, match.index), 'tag');
    const marker = match[0];
    end = match.index + marker.length;
    if (marker.startsWith('!macro:')) {
      push(marker, 'macro');
      continue;
    }
    if (marker.startsWith('\\')) {
      push(marker, 'tag');
      continue;
    }
    if (marker.endsWith('::')) {
      const prefix = marker.slice(0, -2);
      if (prefix && activeNumber) {
        // Digits at the end of a weighted tag (e.g. year 2024) are text.
        push(prefix, 'tag');
        push('::', 'syntax');
        activeNumber = false;
        numeric = 1;
        depth = 0;
      } else if (prefix) {
        const value = Number(prefix);
        activeNumber = true;
        numeric = modern && Number.isFinite(value) && (signed || value >= 0) ? value : 1;
        push(marker, modern && (signed || value >= 0) ? 'syntax' : 'unsupported');
      } else {
        push(marker, 'syntax');
        activeNumber = false;
        numeric = 1;
        depth = 0;
      }
      continue;
    }
    if (marker === '{' || marker === '[') {
      depth += marker === '{' ? 1 : -1;
      push(marker, 'syntax');
    } else if (marker === '}' || marker === ']') {
      push(marker, 'syntax');
      depth += marker === '}' ? -1 : 1;
    } else push(marker, 'separator');
  }
  push(text.slice(end), 'tag');
  return runs;
}

export function bindInk(field, getModel, signal) {
  return mountPromptEditor(field, { runs: inkRuns, tone: inkTone, getModel, signal });
}
