import { setIcon } from './icons.js';

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
const localPaths = {
  regenerate: 'M5 10a7.25 7.25 0 1 1 .9 6.5M5 4.5V10h5.5',
  effort: 'M3 17v-3m4 3v-6m5 6V7m5 10V4m4 13v-8',
  tools: 'M6 5v11a2 2 0 0 0 2 2h3M6 8h4m2-3h7v5h-7zM13 15h7v5h-7z',
  copy: 'M8 8h11v12H8zM15 5V3H4v13h2',
  history: 'M4 10a8 8 0 1 1 .7 6M4 5v5h5M12 7.5v5l3.1 2',
  plus: 'M12 5v14M5 12h14',
  back: 'm13.5 5.5-6.5 6.5 6.5 6.5M7 12h13',
  send: 'M12 19V5m-6 6 6-6 6 6',
  stop: 'M7 7h10v10H7z',
  lock: 'M8 10V8a4 4 0 0 1 8 0v2M5.5 10h13v10h-13zM12 14v2.5',
  plug: 'M9 5v4m6-4v4M6 9h12m-2 0v3a4 4 0 0 1-8 0V9m4 7v4',
  chevron: 'm9 6 6 6-6 6',
  note: 'M5 4h14v16H5zM8.5 9h7M8.5 13h5',
};
export function icon(name) {
  const span = element('span', 'da-icon');
  span.setAttribute('aria-hidden', 'true');
  if (Object.hasOwn(localPaths, name)) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', localPaths[name]);
    svg.append(path);
    span.append(svg);
  } else setIcon(span, name);
  return span;
}
export function button(label, glyph, onClick, className = 'da-icon-button', withText = false) {
  const node = element('button', className);
  node.type = 'button';
  node.title = label;
  node.setAttribute('aria-label', label);
  if (glyph) node.append(icon(glyph));
  if (withText || !glyph) node.append(element('span', '', label));
  if (onClick) node.addEventListener('click', onClick);
  return node;
}
export function field(title, control) {
  const wrapper = element('label', 'da-field');
  wrapper.append(element('span', 'da-field-label', title), control);
  control.setAttribute('aria-label', title);
  return wrapper;
}
export function option(value, label) {
  const item = element('option', '', label);
  item.value = value;
  return item;
}
export function explain(error, secrets = []) {
  let msg = error?.message || '操作未完成，请再试一次。';
  for (const token of secrets) if (typeof token === 'string' && token) msg = msg.split(token).join('••••');
  return msg.substring(0, 600);
}
export async function api(action, body, signal) {
  const response = await fetch('/api/agent-' + action, {
    method: body == null ? 'GET' : 'POST',
    headers: body == null ? undefined : { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
    cache: 'no-store',
    signal,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Error(typeof data.error === 'string' ? data.error : 'Agent 服务返回 HTTP ' + response.status + '。');
  return data;
}
