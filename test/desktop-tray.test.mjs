import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTrayNavigation } from '../public/desktop-tray.js';

test('tray navigation trusts only its parent and serializes Agent initialization', async () => {
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  let receive;
  const calls = [];
  const parent = { postMessage: message => calls.push(message.type) };
  globalThis.window = {
    parent,
    addEventListener: (_, handler) => { receive = handler; },
    removeEventListener: (_, handler) => { assert.equal(handler, receive); receive = null; },
  };
  globalThis.location = { origin: 'http://tauri.localhost' };
  let release;
  const loading = new Promise(resolve => { release = resolve; });
  const errors = [];
  const send = (action, id, overrides = {}) => receive({
    source: parent, origin: location.origin, data: { type: 'folio:tray', action, id }, ...overrides,
  });
  try {
    const dispose = mountTrayNavigation({
      openAgent: async () => {
        calls.push('loading');
        await loading;
        return {
          openThread: id => { calls.push(id); throw Error('deleted'); },
          openHistory: () => calls.push('history'),
          newChat: () => calls.push('new'),
          openSettings: () => calls.push('agent-settings'),
        };
      },
      navigate: screen => calls.push(screen),
      settings: () => calls.push('settings'),
      theme: () => calls.push('theme'),
      onError: error => errors.push(error.message),
    });
    send('archive', null, { origin: 'https://untrusted.example' });
    send('archive', null, { source: {} });
    send('__proto__');
    send('thread', 'deleted-thread');
    send('threads');
    send('new-chat');
    send('agent-settings');
    send('lab');
    send('settings');
    send('theme');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['folio:tray-ready', 'loading']);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, ['deleted']);
    assert.deepEqual(calls, ['folio:tray-ready', 'loading', 'deleted-thread', 'loading', 'history', 'loading', 'new', 'loading', 'agent-settings', 'lab', 'settings', 'theme']);
    dispose();
    assert.equal(receive, null);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});
