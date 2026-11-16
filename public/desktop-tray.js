// Only the trusted desktop frame can dispatch native tray navigation. Keeping
// this separate also makes shortcuts testable without the native window shell.
export function mountTrayNavigation({ openAgent, navigate, settings, theme, onError }) {
  if (window.parent === window) return () => {};
  let queue = Promise.resolve();
  const actions = {
    studio: () => navigate('studio'),
    archive: () => navigate('archive'),
    atlas: () => navigate('atlas'),
    lab: () => navigate('lab'),
    agent: () => openAgent(),
    thread: async id => { if (typeof id === 'string' && id) await (await openAgent()).openThread(id); },
    threads: async () => (await openAgent()).openHistory(),
    'new-chat': async () => (await openAgent()).newChat(),
    'agent-settings': async () => (await openAgent()).openSettings(),
    settings,
    theme,
  };
  const receive = event => {
    if (event.source !== window.parent || event.origin !== location.origin || event.data?.type !== 'folio:tray') return;
    const { action, id } = event.data;
    if (!Object.hasOwn(actions, action)) return;
    // Wait for an Agent import or database read before a following selection.
    queue = queue.then(() => actions[action](id)).catch(onError);
  };
  window.addEventListener('message', receive);
  window.parent.postMessage({ type: 'folio:tray-ready' }, location.origin);
  return () => window.removeEventListener('message', receive);
}
