import { i18nReady } from '/i18n.js';

// Folio tray menu. Renders the shortcuts and the three most recent Agent chats,
// reports its size so the shell can place it beside the cursor, and hands the
// chosen action back to the shell.
const invoke = window.__TAURI__?.core?.invoke;
const card = document.querySelector('.tm-card');
const icons = {
  show: '<rect x="3.5" y="4.5" width="17" height="14" rx="2.5"/><path d="M3.5 9h17"/>',
  studio: '<path d="m4 20 2-6L16 4a2 2 0 0 1 4 4L10 18l-6 2Zm10-14 4 4"/>',
  agent: '<path d="m12 3 2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2L12 3Z"/>',
  lab: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3"/><path d="M7.5 14h9"/>',
  archive:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  atlas: '<path d="M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4-6 4Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  theme: '<path d="M20 15.3A8.6 8.6 0 0 1 8.7 4a8.7 8.7 0 1 0 11.4 11.3Z"/>',
  settings:
    '<path d="M9.62 5.1L9.77 2.35L14.23 2.35L14.38 5.1A7.3 7.3 0 0 1 16.79 6.49L19.24 5.25L21.47 9.11L19.17 10.61A7.3 7.3 0 0 1 19.17 13.39L21.47 14.89L19.24 18.75L16.79 17.51A7.3 7.3 0 0 1 14.38 18.9L14.23 21.65L9.77 21.65L9.62 18.9A7.3 7.3 0 0 1 7.21 17.51L4.76 18.75L2.53 14.89L4.83 13.39A7.3 7.3 0 0 1 4.83 10.61L2.53 9.11L4.76 5.25L7.21 6.49A7.3 7.3 0 0 1 9.62 5.1Z"/><circle cx="12" cy="12" r="2.9"/>',
  quit: '<path d="M12 3v8M7.4 6.2a7 7 0 1 0 9.2 0"/>',
};

function svg(name) {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
  return span.firstChild;
}
function item(label, action, { icon, id, meta, className = '' } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tm-item ' + className;
  button.setAttribute('role', 'menuitem');
  button.dataset.action = action;
  if (id) button.dataset.id = id;
  if (icon) button.append(svg(icon));
  else {
    const dot = document.createElement('span');
    dot.className = 'tm-dot';
    dot.setAttribute('aria-hidden', 'true');
    button.append(dot);
  }
  const text = document.createElement('span');
  text.className = 'tm-text';
  text.textContent = label;
  if (action === 'thread') text.setAttribute('translate', 'no');
  button.append(text);
  if (meta) {
    const small = document.createElement('span');
    small.className = 'tm-meta';
    small.textContent = meta;
    button.append(small);
  }
  return button;
}
function block(className, text) {
  const node = document.createElement('div');
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

// Read recent chats without ever creating or upgrading the Agent's database.
function recentChats() {
  return new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open('folio-desktop-agent', 1);
    } catch {
      return resolve([]);
    }
    request.onupgradeneeded = () => request.transaction.abort();
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const db = request.result;
      try {
        const all = db.transaction('threads', 'readonly').objectStore('threads').getAll();
        all.onsuccess = () => {
          db.close();
          resolve(all.result.sort((a, b) => b.updated - a.updated));
        };
        all.onerror = () => {
          db.close();
          resolve([]);
        };
      } catch {
        db.close();
        resolve([]);
      }
    };
  });
}
function when(stamp) {
  if (!Number.isFinite(stamp)) return '';
  const date = new Date(stamp),
    now = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return date.toDateString() === now.toDateString()
    ? two(date.getHours()) + ':' + two(date.getMinutes())
    : date.getMonth() + 1 + '/' + date.getDate();
}

function applyTheme() {
  let theme = 'light';
  try {
    theme = localStorage.getItem('folio.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch {}
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

async function render() {
  applyTheme();
  const chats = await recentChats();
  const head = block('tm-head');
  const mark = block('tm-mark');
  const word = block('tm-wordmark');
  word.setAttribute('translate', 'no');
  word.innerHTML = 'Folio<i>.</i>';
  head.append(mark, word);
  const nodes = [
    head,
    item('显示 Folio', 'show', { icon: 'show' }),
    block('tm-rule'),
    item('工作台', 'studio', { icon: 'studio' }),
    item('Agent', 'agent', { icon: 'agent' }),
    item('实验室', 'lab', { icon: 'lab' }),
    item('作品集', 'archive', { icon: 'archive' }),
    item('万象集', 'atlas', { icon: 'atlas' }),
    block('tm-rule'),
    block('tm-label', '最近对话'),
  ];
  if (chats.length)
    for (const chat of chats.slice(0, 3))
      nodes.push(item(chat.title || '新对话', 'thread', { id: chat.id, meta: when(chat.updated), className: 'tm-chat' }));
  else nodes.push(block('tm-empty', '还没有对话'));
  if (chats.length > 3) nodes.push(item('更多...', 'threads', { className: 'tm-chat tm-more' }));
  nodes.push(
    item('新建对话', 'new-chat', { icon: 'plus' }),
    item('Agent 设置', 'agent-settings', { icon: 'settings' }),
    block('tm-rule'),
    item('切换深浅色', 'theme', { icon: 'theme' }),
    item('设置', 'settings', { icon: 'settings' }),
    item('退出 Folio', 'quit', { icon: 'quit', className: 'tm-quit' }),
  );
  card.replaceChildren(...nodes);
  card.hidden = false;
}

async function open() {
  await i18nReady;
  await render();
  // Hidden webviews can suspend animation frames. Measure without waiting for
  // one, otherwise the first right click may never show the menu.
  card.getBoundingClientRect();
  await document.fonts.ready;
  const box = card.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(document.body).paddingLeft) || 0;
  card.removeAttribute('data-open');
  await invoke?.('tray_menu_show', { width: Math.ceil(box.width + pad * 2), height: Math.ceil(card.scrollHeight + pad * 2) });
  card.getBoundingClientRect();
  card.setAttribute('data-open', '');
  card.querySelector('.tm-item')?.focus({ preventScroll: true });
}
window.__folioTrayOpen = () => void open();

card.addEventListener('click', (event) => {
  const button = event.target.closest('.tm-item');
  if (!button) return;
  void invoke?.('tray_action', { action: button.dataset.action, id: button.dataset.id || null });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void invoke?.('tray_menu_hide');
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) return;
  event.preventDefault();
  const items = [...card.querySelectorAll('.tm-item')];
  const index = items.indexOf(document.activeElement);
  const offset = event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1;
  const next = event.key === 'Home' ? items[0] : event.key === 'End' ? items.at(-1)
    : items[(index + offset + items.length) % items.length];
  next?.focus();
});
document.addEventListener('contextmenu', (event) => event.preventDefault());
void open();
