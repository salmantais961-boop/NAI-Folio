import './desktop-api.js';

const progressKey = 'folio.desktop.first-run.v1';

function remember(value) {
  try { localStorage.setItem(progressKey, value); } catch {}
}

async function firstStep() {
  const marker = localStorage.getItem(progressKey);
  if (marker === 'done') return null;
  if (marker === 'active:llm') return 'llm';
  if (marker === 'active:nai') return 'nai';
  // Read before loading the iframe: the workbench itself creates these stores on its first visit.
  const databases = await indexedDB.databases();
  const existingWorkspace = databases.some(db => db.name === 'nai-folio' || db.name === 'nai-folio-atlas');
  if (!existingWorkspace && localStorage.getItem('folio.prompt.chunks') === null) {
    const { hasFirstRunConnections } = await import('./desktop-first-run-fields.js');
    if (!(await hasFirstRunConnections())) {
      remember('active:nai');
      return 'nai';
    }
  }
  remember('done');
  return null;
}

function loadGuideStyle() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./desktop-first-run.css', import.meta.url).href;
  return new Promise((resolve, reject) => {
    link.onload = resolve;
    link.onerror = () => reject(Error('无法读取首次引导样式。'));
    document.head.append(link);
  });
}

export async function playDesktopOpening(opening, loadWorkspace) {
  const mark = opening.querySelector('.desktop-signature');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  mark.style.opacity = '1';
  const intro = mark.animate([
    { opacity: 0, filter: reduced ? 'none' : 'blur(12px)', transform: reduced ? 'none' : 'translateY(5px) scale(.975)' },
    { opacity: 1, filter: 'none', transform: 'none' },
  ], { duration: reduced ? 120 : 680, easing: 'cubic-bezier(.16,.72,.24,1)' }).finished;
  const step = await firstStep();
  if (step) {
    const [{ runFirstRun }, { makeFirstRunFields }] = await Promise.all([
      import('./desktop-first-run.js'), import('./desktop-first-run-fields.js'), loadGuideStyle(),
    ]);
    await runFirstRun(opening, makeFirstRunFields(), {
      initialStep: step, intro,
      onStep(next) { if (next === 'llm') remember('active:llm'); },
      onFinish() { remember('done'); return loadWorkspace(); },
    });
    return;
  }
  await Promise.all([intro, loadWorkspace()]);
  mark.animate([
    { opacity: 1, filter: 'none' },
    { opacity: 0, filter: reduced ? 'none' : 'blur(9px)' },
  ], { delay: reduced ? 0 : 360, duration: reduced ? 120 : 540, fill: 'forwards', easing: 'ease-in' });
  await opening.animate([{ opacity: 1 }, { opacity: 0 }], {
    delay: reduced ? 0 : 630, duration: reduced ? 135 : 420, easing: 'ease-out', fill: 'forwards',
  }).finished;
}
