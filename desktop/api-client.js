// Loaded before the studio's modules in a packaged WebView only.
(() => {
  if (!['http://tauri.localhost', 'https://tauri.localhost'].includes(location.origin)) return;
  let config = window.__FOLIO_DESKTOP__;
  if (!config && window !== window.parent) {
    try {
      if (window.parent.location.origin === location.origin) config = window.parent.__FOLIO_DESKTOP__;
    } catch { return; }
  }
  if (!config || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(config.apiBase) ||
      !/^[a-zA-Z0-9_-]{32,128}$/.test(config.token)) return;
  const { apiBase, token } = config;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const supplied = input instanceof Request;
    const url = new URL(supplied ? input.url : input, document.baseURI);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return nativeFetch(input, init);
    let options = init;
    if (supplied) {
      const request = new Request(input, init);
      options = {
        method: request.method, headers: request.headers, signal: request.signal, cache: request.cache,
        // Sending a ReadableStream upload over the loopback HTTP/1 connection
        // is unsupported in Chromium. Ordinary studio JSON skips this copy.
        body: request.body ? await request.arrayBuffer() : undefined,
      };
    }
    const headers = new Headers(options?.headers);
    headers.set('x-folio-desktop', token);
    return nativeFetch(apiBase + url.pathname + url.search, {
      ...options, headers, mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    });
  };
})();
