const nativeWindow = window.__FOLIO_DESKTOP__ && window.__TAURI__?.window?.getCurrentWindow();
if (nativeWindow) mountWindow(nativeWindow);
else location.replace('/index.html');

function mountWindow(appWindow) {
  const root = document.documentElement;
  const frame = document.querySelector('#desktop-workspace');
  const controls = document.querySelector('.window-controls');
  const sizeButton = controls.querySelector('[data-window-action="maximize"]');
  const feedback = document.querySelector('.window-feedback');
  let feedbackTimer;

  function reportFailure() {
    feedback.textContent = '窗口操作未完成，请重试。';
    feedback.hidden = false;
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => { feedback.hidden = true; }, 2400);
  }

  let sizeCheck = 0;
  async function syncWindowSize() {
    const check = ++sizeCheck;
    const maximized = await appWindow.isMaximized();
    if (check !== sizeCheck) return;
    root.toggleAttribute('data-maximized', maximized);
    const label = maximized ? '还原窗口' : '最大化';
    sizeButton.setAttribute('aria-label', label);
    sizeButton.title = label;
  }
  let resizeFrame = 0;
  function afterResize() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => syncWindowSize().catch(reportFailure));
  }
  let acting = false;
  async function act(action) {
    if (acting) return;
    acting = true;
    try {
      if (action === 'minimize') await appWindow.minimize();
      if (action === 'close') await appWindow.close();
      if (action === 'maximize') {
        await appWindow.toggleMaximize();
        await syncWindowSize();
      }
    } catch {
      reportFailure();
    } finally {
      acting = false;
    }
  }
  controls.addEventListener('click', (event) => {
    const button = event.target.closest('[data-window-action]');
    if (button) void act(button.dataset.windowAction);
  });
  void syncWindowSize().catch(reportFailure);
  window.addEventListener('resize', afterResize);
  // The close button either quits or keeps Folio in the tray (set in Settings,
  // which lives in the workspace frame and shares this origin's storage).
  const invoke = window.__TAURI__?.core?.invoke;
  function syncCloseAction() {
    let action = 'quit';
    try {
      action = localStorage.getItem('folio.close-action') === 'tray' ? 'tray' : 'quit';
    } catch {}
    invoke?.('set_close_action', { action }).catch(reportFailure);
  }
  syncCloseAction();
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === 'folio.close-action') syncCloseAction();
  });
  // Tray menu choices (open a page, a chat, settings…) are carried out by the workspace.
  let trayReady = false;
  const pendingTray = [];
  function flushTray() {
    if (!trayReady) return;
    for (const payload of pendingTray.splice(0))
      frame.contentWindow?.postMessage({ type: 'folio:tray', ...payload }, location.origin);
  }
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.type !== 'folio:tray-ready') return;
    trayReady = true;
    flushTray();
  });
  void window.__TAURI__?.event
    ?.listen('folio:tray', ({ payload }) => {
      pendingTray.push(payload);
      flushTray();
    })
    .catch(reportFailure);
  void appWindow.onFocusChanged(({ payload }) => {
    root.toggleAttribute('data-unfocused', !payload);
  }).catch(reportFailure);

  function enableTitleDrag(header) {
    let held = null;
    const isGrip = target => !target.closest('.fw-viewport, button, a, form, input, select, textarea, label, [role="button"], [contenteditable]');
    header.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.isPrimary || !isGrip(event.target)) return;
      held = { id: event.pointerId, x: event.clientX, y: event.clientY };
      header.setPointerCapture(event.pointerId);
    });
    header.addEventListener('pointermove', (event) => {
      if (!held || held.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - held.x, event.clientY - held.y) < 3) return;
      held = null;
      header.releasePointerCapture(event.pointerId);
      void appWindow.startDragging().catch(reportFailure);
    });
    header.addEventListener('lostpointercapture', () => { held = null; });
    header.addEventListener('dblclick', (event) => {
      if (event.button === 0 && isGrip(event.target)) void act('maximize');
    });
  }

  const resizers = document.querySelector('.window-resizers');
  for (const direction of ['North', 'NorthEast', 'East', 'SouthEast', 'South', 'SouthWest', 'West', 'NorthWest']) {
    const edge = document.createElement('i');
    edge.dataset.edge = direction;
    resizers.append(edge);
  }
  resizers.addEventListener('pointerdown', (event) => {
    const edge = event.target.dataset.edge;
    if (event.button !== 0 || !edge || root.hasAttribute('data-maximized')) return;
    event.preventDefault();
    void appWindow.startResizeDragging(edge).catch(reportFailure);
  });

  // The app takes the entire window. Only the three native controls overlay
  // the frame; its existing navigation, account button and dialogs stay live.
  let observer;
  let headerSize;
  function followWorkspace() {
    observer?.disconnect();
    headerSize?.disconnect();
    const doc = frame.contentDocument;
    if (!doc?.getElementById('app')) return;
    const masthead = doc.querySelector('.app-top');
    enableTitleDrag(masthead);
    function sync() {
      const modal = doc.querySelector('dialog:modal');
      const right = doc.documentElement.clientWidth > 760 ? 14 : 8;
      const scrollbarWidth = frame.clientWidth - doc.documentElement.clientWidth;
      const headerRect = masthead.getBoundingClientRect();
      const center = modal ? 20 : Math.max(18, headerRect.top + headerRect.height / 2);
      root.dataset.theme = doc.documentElement.dataset.theme || 'light';
      controls.toggleAttribute('data-on-backdrop', !!modal && !modal.matches('.pv-dialog'));
      root.style.setProperty('--controls-center', center + 'px');
      root.style.setProperty('--controls-right', (right + scrollbarWidth) + 'px');
      doc.documentElement.style.setProperty('--desktop-controls-right', right + 'px');
    }
    sync();
    observer = new MutationObserver(sync);
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    observer.observe(doc.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
    headerSize = new ResizeObserver(sync);
    headerSize.observe(masthead);
    headerSize.observe(doc.documentElement);
  }
  try { root.dataset.theme = localStorage.getItem('folio.theme') || 'light'; } catch {}
  const opening = document.querySelector('.desktop-opening');
  frame.inert = true;
  enableTitleDrag(opening);
  frame.addEventListener('load', followWorkspace);
  let workspaceReady;
  function loadWorkspace() {
    if (!workspaceReady) {
      workspaceReady = new Promise(resolve => {
        const ready = () => {
          if (frame.contentDocument?.URL === 'about:blank') return;
          frame.removeEventListener('load', ready);
          resolve();
        };
        frame.addEventListener('load', ready);
      });
      frame.src = '/index.html';
    }
    return workspaceReady;
  }
  async function open() {
    try {
      const { playDesktopOpening } = await import('./desktop-first-run-startup.js');
      await playDesktopOpening(opening, loadWorkspace);
    } catch {
      feedback.textContent = '启动引导暂时无法显示，可在设置中连接账户。';
      feedback.hidden = false;
      clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(() => { feedback.hidden = true; }, 4000);
    }
    await loadWorkspace();
    opening.remove();
    frame.inert = false;
  }
  void open();
}
