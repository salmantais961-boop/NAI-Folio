import { mountDotGrid } from './vendor/dot-grid.js';
import { getHideNSFW } from './content-preferences.js';

const NS = 'http://www.w3.org/2000/svg';
const GROUP_HEADER = 50,
  IMAGE_GAP = 4;
const POSITION_KEY = 'folio.lineage.positions.v1';
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const date = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const groups = {
  basic: '基础 META',
  prompt: '正向提示词',
  positive: '正向提示词',
  negative: '负向提示词',
  seed: '种子',
  size: '尺寸',
  dimensions: '尺寸',
  parameters: '生成参数',
  settings: '生成参数',
  model: '模型',
  media: '参考图像',
  characters: '角色提示词',
};
const labels = {
  model: '模型',
  medium: '运算强度',
  dataset: '数据集',
  steps: 'Steps',
  scale: 'CFG',
  sampler: '采样器',
  seed: '种子',
  width: '宽度',
  height: '高度',
  strength: '重绘强度',
  noise: '噪声',
  cfgRescale: 'CFG Rescale',
  noiseSchedule: '噪声计划',
  mode: '模式',
  tool: '导演工具',
  enhance: '增强',
  quality: '质量标签',
  uc: '负面预设',
  batch: '张数',
  smea: 'SMEA',
};
const edgeNames = {
  edit: '图像修改',
  reuse: 'META 复用',
  similar: '提示词相近',
  character: '同一角色',
  batch: '同批生成',
};
const dashed = (type) => type === 'similar' || type === 'character';
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function icon(path) {
  const n = document.createElementNS(NS, 'svg');
  n.setAttribute('viewBox', '0 0 24 24');
  n.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', path);
  n.append(p);
  return n;
}
function button(label, path, cls = '') {
  const n = el('button', cls);
  n.type = 'button';
  n.title = label;
  n.setAttribute('aria-label', label);
  if (path) n.append(icon(path));
  else n.textContent = label;
  return n;
}
function time(value) {
  return Number.isFinite(Number(value)) && value ? date.format(new Date(Number(value))) : '时间未记录';
}
function valueText(value) {
  if (value == null || value === '') return '—';
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function operation(node) {
  return typeof node.operation === 'object'
    ? node.operation.label || node.operation.type || '生成'
    : node.operation || (node.legacy ? '此前作品' : '生成');
}

// Chronological topological columns; malformed cycles become their own later column.
// One node stays one node even when several META sources converge on it.
function arrange(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map(nodes.map((n) => [n.id, []]));
  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  for (const edge of edges)
    if (byId.has(edge.source) && byId.has(edge.target) && edge.source !== edge.target) {
      incoming.get(edge.target).push(edge.source);
      outgoing.get(edge.source).push(edge.target);
    }
  const compare = (a, b) =>
    (Number(byId.get(a).created) || 0) - (Number(byId.get(b).created) || 0) ||
    String(a).localeCompare(String(b));
  const degree = new Map([...incoming].map(([id, parents]) => [id, parents.length]));
  const queue = nodes
    .filter((n) => !degree.get(n.id))
    .map((n) => n.id)
    .sort(compare);
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  const visited = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of outgoing.get(id)) {
      depth.set(next, Math.max(depth.get(next), depth.get(id) + 1));
      degree.set(next, degree.get(next) - 1);
      if (degree.get(next) === 0) {
        queue.push(next);
        queue.sort(compare);
      }
    }
  }
  let last = Math.max(0, ...depth.values());
  for (const n of nodes.filter((n) => !visited.has(n.id)).sort((a, b) => compare(a.id, b.id)))
    depth.set(n.id, ++last);
  const columns = new Map();
  for (const n of nodes) {
    const d = depth.get(n.id);
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(n);
  }
  const positions = new Map();
  const columnHeight = (column) => column.reduce((sum, n) => sum + n.height + 48, -48);
  const height = Math.max(1, ...[...columns.values()].map(columnHeight));
  let left = 56;
  for (const [d, column] of [...columns].sort((a, b) => a[0] - b[0])) {
    const center = (n) => {
      const parents = incoming
        .get(n.id)
        .map((id) => positions.get(id)?.y)
        .filter(Number.isFinite);
      return parents.length ? parents.reduce((a, b) => a + b) / parents.length : height / 2;
    };
    column.sort((a, b) => center(a) - center(b) || compare(a.id, b.id));
    let top = (height - columnHeight(column)) / 2 + 80;
    for (const n of column) {
      positions.set(n.id, { x: left, y: top, width: n.width, height: n.height, column: d });
      top += n.height + 48;
    }
    left += Math.max(...column.map((n) => n.width)) + 140;
  }
  return { positions, width: left - 84, height: height + 160 };
}

function roundedRoute(points) {
  let path = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1],
      point = points[i],
      next = points[i + 1];
    const before = Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    const after = Math.hypot(next[0] - point[0], next[1] - point[1]);
    if (!before || !after) continue;
    const radius = Math.min(18, before / 2, after / 2);
    const enter = [
      point[0] - ((point[0] - previous[0]) * radius) / before,
      point[1] - ((point[1] - previous[1]) * radius) / before,
    ];
    const leave = [
      point[0] + ((next[0] - point[0]) * radius) / after,
      point[1] + ((next[1] - point[1]) * radius) / after,
    ];
    path += ` L${enter[0]},${enter[1]} Q${point[0]},${point[1]} ${leave[0]},${leave[1]}`;
  }
  return path + ` L${points.at(-1)[0]},${points.at(-1)[1]}`;
}

// Adjacent generations use soft direct curves. Cross-generation connections
// travel in their own outer lanes, never through an intermediate image card.
function routeConnections(layout, connections) {
  const links = connections
    .map((reasons) => ({
      reasons,
      edge: reasons.find((e) => e.type === 'edit') || reasons.find((e) => e.type === 'reuse') || reasons[0],
    }))
    .filter(({ edge }) => layout.positions.has(edge.source) && layout.positions.has(edge.target));
  const bySource = new Map(),
    byTarget = new Map();
  for (const link of links) {
    if (!bySource.has(link.edge.source)) bySource.set(link.edge.source, []);
    if (!byTarget.has(link.edge.target)) byTarget.set(link.edge.target, []);
    bySource.get(link.edge.source).push(link);
    byTarget.get(link.edge.target).push(link);
  }
  for (const [map, key] of [
    [bySource, 'target'],
    [byTarget, 'source'],
  ]) {
    for (const list of map.values())
      list.sort((a, b) => {
        const aa = layout.positions.get(a.edge[key]),
          bb = layout.positions.get(b.edge[key]);
        return aa.y - bb.y || aa.x - bb.x;
      });
  }
  const lanes = { top: [], bottom: [] };
  for (const link of links) {
    const a = layout.positions.get(link.edge.source),
      b = layout.positions.get(link.edge.target);
    const corridorLeft = Math.min(a.x + a.width, b.x),
      corridorRight = Math.max(a.x + a.width, b.x);
    const overlapsCorridor = [...layout.positions.entries()].some(
      ([id, p]) =>
        id !== link.edge.source &&
        id !== link.edge.target &&
        p.x < corridorRight &&
        p.x + p.width > corridorLeft &&
        p.y < Math.max(a.y + a.height, b.y + b.height) &&
        p.y + p.height > Math.min(a.y, b.y),
    );
    link.long = overlapsCorridor || b.x <= a.x + a.width + 35;
    if (!link.long) continue;
    link.side = dashed(link.edge.type) ? 'bottom' : 'top';
    const left = Math.min(a.x, b.x),
      right = Math.max(a.x + a.width, b.x + b.width);
    const side = lanes[link.side];
    let lane = side.findIndex((ranges) =>
      ranges.every((range) => right + 40 < range[0] || left - 40 > range[1]),
    );
    if (lane < 0) {
      lane = side.length;
      side.push([]);
    }
    side[lane].push([left, right]);
    link.lane = lane;
  }
  const top = Math.min(...[...layout.positions.values()].map((p) => p.y));
  const bottom = Math.max(...[...layout.positions.values()].map((p) => p.y + p.height));
  const labels = [];
  for (const link of links) {
    const a = layout.positions.get(link.edge.source),
      b = layout.positions.get(link.edge.target);
    const sources = bySource.get(link.edge.source),
      targets = byTarget.get(link.edge.target);
    const sourceIndex = sources.indexOf(link),
      targetIndex = targets.indexOf(link);
    const port = (position, index, count) =>
      Math.min(148, position.height / 2) +
      (index - (count - 1) / 2) * Math.min(18, 90 / Math.max(1, count - 1));
    const fromX = a.x + a.width,
      toX = b.x;
    const fromY = a.y + port(a, sourceIndex, sources.length),
      toY = b.y + port(b, targetIndex, targets.length);
    if (link.long) {
      const laneY = link.side === 'top' ? top - 30 - link.lane * 32 : bottom + 30 + link.lane * 32;
      const exitX = fromX + 20 + (sourceIndex % 4) * 8,
        enterX = toX - 20 - (targetIndex % 4) * 8;
      link.path = roundedRoute([
        [fromX, fromY],
        [exitX, fromY],
        [exitX, laneY],
        [enterX, laneY],
        [enterX, toY],
        [toX, toY],
      ]);
      link.labelX = (exitX + enterX) / 2;
      link.labelY = laneY - 9;
    } else {
      const bend = Math.max(40, Math.abs(toX - fromX) * 0.5);
      link.path = `M${fromX},${fromY} C${fromX + bend},${fromY} ${toX - bend},${toY} ${toX},${toY}`;
      link.labelX = (fromX + toX) / 2;
      link.labelY = (fromY + toY) / 2 - 10;
    }
    // Sibling connections can cross in one column gap. Keep their labels in
    // separate rows while retaining the connection's own curve and endpoints.
    const text = [
      ...new Set(link.reasons.map((reason) => reason.label || edgeNames[reason.type] || '关联')),
    ].join(' · ');
    link.label = text;
    const width = Math.min(170, text.length * 8);
    let attempts = 0;
    while (
      labels.some(
        (label) =>
          Math.abs(label.x - link.labelX) < (label.width + width) / 2 + 6 &&
          Math.abs(label.y - link.labelY) < 15,
      ) &&
      attempts++ < 20
    )
      link.labelY -= 17;
    labels.push({ x: link.labelX, y: link.labelY, width });
  }
  const left = Math.min(...[...layout.positions.values()].map((p) => p.x)) - 56;
  const right = Math.max(...[...layout.positions.values()].map((p) => p.x + p.width)) + 56;
  const upper = Math.min(top - 50, ...links.map((link) => link.labelY - 25));
  const lower = bottom + (lanes.bottom.length ? 30 + lanes.bottom.length * 32 : 0) + 50;
  layout.bounds = { left, top: upper, width: right - left, height: lower - upper };
  layout.width = Math.max(1, right);
  layout.height = Math.max(1, lower);
  return links;
}

export function mountLineageCanvas({ getGraph, getImageUrl, onOpenWork, notify = () => {} }) {
  const dialog = el('dialog', 'lc-dialog');
  dialog.setAttribute('aria-label', '作品线索');
  const header = el('header', 'lc-head'),
    heading = el('div', 'lc-heading');
  heading.append(
    el('span', 'lc-eyebrow', 'FOLIO / CONNECTIONS'),
    el('h2', '', '线索'),
    el('i', '', 'Every image has a story.'),
  );
  const count = el('span', 'lc-count'),
    closeButton = button('关闭线索', 'm6 6 12 12M6 18 18 6', 'lc-close');
  const filters = el('div', 'lc-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', '筛选线索连接');
  let edgeFilter = 'all';
  for (const [value, label] of [
    ['all', '全部'],
    ['solid', '仅实线'],
    ['similar', '仅虚线'],
  ]) {
    const control = button(label, null);
    control.dataset.edgeFilter = value;
    control.setAttribute('aria-pressed', String(value === edgeFilter));
    control.onclick = () => {
      edgeFilter = value;
      for (const item of filters.children)
        item.setAttribute('aria-pressed', String(item.dataset.edgeFilter === value));
      renderConnections();
      paint();
    };
    filters.append(control);
  }
  header.append(heading, filters, count, closeButton);
  const body = el('div', 'lc-body'),
    viewport = el('div', 'lc-viewport'),
    backdrop = el('div', 'lc-dots'),
    world = el('div', 'lc-world');
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', '线索画布，拖动平移，滚轮缩放，方向键移动，0 适应所有节点');
  const svg = document.createElementNS(NS, 'svg');
  svg.classList.add('lc-links');
  svg.setAttribute('aria-hidden', 'true');
  const nodeLayer = el('div', 'lc-nodes');
  world.append(svg, nodeLayer);
  viewport.append(backdrop, world);
  const notice = el('div', 'lc-notice');
  notice.setAttribute('role', 'status');
  const tools = el('div', 'lc-tools');
  tools.setAttribute('role', 'toolbar');
  tools.setAttribute('aria-label', '线索画布工具');
  const minus = button('缩小画布', 'M5 12h14'),
    plus = button('放大画布', 'M5 12h14M12 5v14'),
    fitButton = button('适应全部线索', 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5'),
    centerButton = button('定位选中作品', 'M12 3v3m0 12v3M3 12h3m12 0h3M8 8h8v8H8z'),
    zoom = el('output', 'lc-zoom', '100%');
  zoom.setAttribute('aria-label', '画布缩放比例');
  tools.append(minus, zoom, plus, fitButton, centerButton);
  const legend = el('div', 'lc-legend');
  legend.append(el('span', 'lc-legend-solid', '修改 / 复用'), el('span', 'lc-legend-dashed', '相似 / 角色'));
  viewport.append(notice, tools, legend);
  const inspector = el('aside', 'lc-inspector');
  inspector.setAttribute('aria-label', '选中作品详情');
  body.append(viewport, inspector);
  dialog.append(header, body);
  document.body.append(dialog);
  const abort = new AbortController(),
    reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let graph = null,
    layout = null,
    selected = null,
    sourceWork = null,
    previousFocus = null,
    renderer = null,
    requestVersion = 0;
  let x = 0,
    y = 0,
    scale = 1,
    motion = null,
    resizeFrame = 0,
    suppressClickUntil = 0;
  const nodes = new Map(),
    images = new Map(),
    pointers = new Map();
  const groupCards = new Map(),
    memberFrames = new Map(),
    memberGroups = new Map(),
    defaultPositions = new Map();
  let groupList = [],
    connectionEdges = [],
    storedPositions = {},
    routeFrame = 0;
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) storedPositions = saved;
  } catch {}
  function savePositions() {
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify(storedPositions));
    } catch {}
  }
  let drag = null;
  const listener = (target, type, fn, options = {}) =>
    target.addEventListener(type, fn, { ...options, signal: abort.signal });
  const options = () => ({
    dotSize: 3,
    gap: 27,
    strength: 0.3,
    tension: 0.35,
    glow: 0.25,
    stretch: 0.1,
    swell: 0.12,
    shockStrength: 0.2,
    shockRadius: 140,
    opacity: 0.65,
    intro: false,
    clickShock: false,
    baseColor: getComputedStyle(backdrop).getPropertyValue('--dot-base').trim(),
    activeColor: getComputedStyle(backdrop).getPropertyValue('--dot-active').trim(),
  });
  function background() {
    renderer?.destroy();
    renderer = null;
    backdrop.replaceChildren();
    backdrop.removeAttribute('data-static');
    try {
      renderer = mountDotGrid(backdrop, options());
    } catch {}
    if (!renderer?.supported) {
      renderer?.destroy();
      renderer = null;
      backdrop.dataset.static = '';
    }
  }
  listener(backdrop, 'dotgridcontextlost', () => {
    renderer?.destroy();
    renderer = null;
    backdrop.dataset.static = '';
  });
  const theme = new MutationObserver(() => renderer?.update(options()));
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  function loadVisible() {
    if (!dialog.open || !layout) return;
    const width = viewport.clientWidth,
      height = viewport.clientHeight;
    for (const entry of images.values()) {
      const pos = layout.positions.get(entry.groupId);
      if (
        !entry.loaded &&
        pos &&
        (pos.x + entry.left + entry.width) * scale + x > 0 &&
        (pos.x + entry.left) * scale + x < width &&
        (pos.y + entry.top + entry.height) * scale + y > 0 &&
        (pos.y + entry.top) * scale + y < height
      ) {
        entry.loaded = true;
        try {
          const url = getImageUrl(entry.work);
          if (url) entry.image.src = url;
        } catch {
          entry.image.hidden = true;
        }
      }
    }
  }
  function paint() {
    world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    zoom.value = Math.round(scale * 100) + '%';
    loadVisible();
  }
  function stopMotion() {
    motion?.cancel();
    motion = null;
  }
  function move(nextX, nextY, nextScale, animate = false) {
    const from = getComputedStyle(world).transform;
    stopMotion();
    x = nextX;
    y = nextY;
    scale = clamp(nextScale, 0.08, 2.5);
    paint();
    if (animate && !reduced.matches && from !== 'none') {
      const animation = world.animate([{ transform: from }, { transform: world.style.transform }], {
        duration: 300,
        easing: 'cubic-bezier(.22,.75,.25,1)',
      });
      motion = animation;
      animation.onfinish = () => {
        if (motion === animation) motion = null;
      };
    }
  }
  function fit(animate = true, preferFocus = false) {
    if (!layout) return;
    const w = viewport.clientWidth,
      h = viewport.clientHeight;
    const bounds = layout.bounds;
    const s = Math.min(1, Math.max(0.08, Math.min((w - 52) / bounds.width, (h - 100) / bounds.height)));
    const selectedGroup = layout.positions.get(memberGroups.get(selected));
    if (preferFocus && (s < 0.55 || selectedGroup?.height > h - 100)) {
      scale = 0.85;
      center(selected, false);
      return;
    }
    move(
      (w - bounds.width * s) / 2 - bounds.left * s,
      (h - bounds.height * s) / 2 - bounds.top * s - 10,
      s,
      animate,
    );
  }
  function center(id = selected, animate = true) {
    const point = layout?.positions.get(memberGroups.get(id) || id);
    if (!point) return;
    const s = Math.max(0.75, Math.min(1, scale));
    const entry = memberFrames.get(id);
    const px =
      point.x +
      (point.width * s <= viewport.clientWidth - 12
        ? point.width / 2
        : entry
          ? entry.left + entry.width / 2
          : point.width / 2);
    const py =
      point.y +
      (point.height * s <= viewport.clientHeight - 100
        ? point.height / 2
        : entry
          ? entry.top + entry.height / 2
          : Math.min(point.height / 2, 160));
    move(viewport.clientWidth / 2 - px * s, viewport.clientHeight / 2 - py * s - 16, s, animate);
  }
  function zoomAt(next, clientX, clientY) {
    const r = viewport.getBoundingClientRect(),
      px = clientX - r.left,
      py = clientY - r.top;
    const s = clamp(next, 0.08, 2.5),
      ratio = s / scale;
    move(px - (px - x) * ratio, py - (py - y) * ratio, s);
  }
  function centerZoom(factor) {
    const r = viewport.getBoundingClientRect();
    zoomAt(scale * factor, r.left + r.width / 2, r.top + r.height / 2);
  }
  function changeSummary(edge) {
    if (edge.type === 'character') {
      const names = (edge.characters || []).map(
        (id) =>
          edge.characterLabels?.[id] || (id.startsWith('tag:') ? id.slice(4).replace(/_/g, ' ') : '原创角色'),
      );
      return names.length ? '共同角色：' + [...new Set(names)].join('、') : '角色身份一致';
    }
    const c = edge.changes;
    const changed = typeof c === 'number' ? c : (c?.count ?? c?.distance ?? edge.distance);
    if (edge.type === 'similar')
      return Number.isFinite(changed)
        ? changed === 0
          ? '提示词一致'
          : `约 ${changed} 条提示词改动`
        : '提示词相似';
    if (edge.type === 'reuse' && edge.groups?.length) return edge.groups.map((g) => groups[g] || g).join(' · ');
    return edge.label || edgeNames[edge.type] || '有关联';
  }
  function diffRow(host, label, before, after) {
    const row = el('div', 'lc-diff-row');
    row.append(
      el('span', '', label),
      el('del', '', valueText(before)),
      el('b', '', '→'),
      el('strong', '', valueText(after)),
    );
    host.append(row);
  }
  function renderInspector(node) {
    inspector.replaceChildren();
    const title = el('div', 'lc-detail-head');
    title.append(
      el('span', 'lc-eyebrow', 'SELECTED / ' + String(graph.nodes.indexOf(node) + 1).padStart(2, '0')),
      el('h3', '', operation(node)),
      el('small', '', time(node.created)),
    );
    inspector.append(title);
    const facts = el('dl', 'lc-facts');
    for (const [label, text] of [
      ['模型', node.modelLabel || node.settings?.model || '—'],
      ['尺寸', node.width && node.height ? `${node.width} × ${node.height}` : '—'],
      ['种子', valueText(node.settings?.seed)],
    ]) {
      facts.append(el('dt', '', label), el('dd', '', text));
    }
    inspector.append(facts);
    const group = groupList.find((item) => item.id === memberGroups.get(node.id));
    if (group?.members.length > 1) {
      const siblings = el('div', 'lc-siblings');
      siblings.append(el('span', '', `相同提示词 · ${group.members.length} 张`));
      for (const [index, member] of group.members.entries()) {
        const pick = button(String(index + 1).padStart(2, '0'), null);
        pick.setAttribute('aria-label', `选择同组第 ${index + 1} 张：${operation(member)}`);
        pick.setAttribute('aria-pressed', String(member.id === node.id));
        pick.onclick = () => {
          select(member.id);
          center(member.id);
        };
        siblings.append(pick);
      }
      inspector.append(siblings);
    }
    const related = graph.edges.filter((e) => e.target === node.id);
    const list = el('section', 'lc-relations');
    list.append(
      el(
        'h4',
        '',
        related.length
          ? `${related.some((edge) => edge.type === 'character') ? '关联线索' : '从这里而来'} · ${related.length}`
          : '记录起点',
      ),
    );
    if (!related.length)
      list.append(
        el(
          'p',
          'lc-muted',
          node.external
            ? '从外部文件复用的 META；从本次引用开始记录关联。'
            : node.legacy
              ? graph.edges.some((edge) => edge.source === node.id)
                ? '此前过程未追溯；从本次引用起记录后续变化。'
                : '此前作品未追溯。新修改或 META 复用将开始记录。'
              : '这张作品还没有上游线索。接下来的修改与复用会记录在这里。',
        ),
      );
    for (const edge of related) {
      const parent = graph.nodes.find((n) => n.id === edge.source);
      const relation = el('div', 'lc-relation');
      relation.dataset.type = edge.type;
      const link = button(edge.label || edgeNames[edge.type] || '相关作品', null, 'lc-relation-link');
      link.onclick = () => {
        select(edge.source);
        center(edge.source);
      };
      relation.append(link, el('p', '', changeSummary(edge)));
      if (edge.type === 'similar' && Number.isFinite(edge.strength)) {
        const strength = clamp(edge.strength <= 1 ? edge.strength : edge.strength / 100, 0, 1);
        const meter = el('span', 'lc-strength');
        meter.style.setProperty('--strength', strength);
        meter.setAttribute('aria-label', '关联强度 ' + Math.round(strength * 100) + '%');
        relation.append(meter, el('small', '', `关联强度 ${Math.round(strength * 100)}%`));
      }
      const added = edge.changes?.added,
        removed = edge.changes?.removed;
      if (Array.isArray(added) && added.length)
        relation.append(el('p', 'lc-added', '+ ' + added.map(valueText).join(', ')));
      if (Array.isArray(removed) && removed.length)
        relation.append(el('p', 'lc-removed', '− ' + removed.map(valueText).join(', ')));
      if (parent) {
        const diffs = el('div', 'lc-diffs');
        for (const key of Object.keys(labels))
          if (valueText(parent.settings?.[key]) !== valueText(node.settings?.[key]))
            diffRow(diffs, labels[key], parent.settings?.[key], node.settings?.[key]);
        if (parent.width !== node.width || parent.height !== node.height)
          diffRow(
            diffs,
            '成图尺寸',
            parent.width && parent.height ? `${parent.width}×${parent.height}` : null,
            node.width && node.height ? `${node.width}×${node.height}` : null,
          );
        if (diffs.childElementCount) {
          const details = el('details', 'lc-change-details');
          details.append(el('summary', '', `参数变化 · ${diffs.childElementCount}`), diffs);
          relation.append(details);
        }
      }
      list.append(relation);
    }
    inspector.append(list);
    for (const [label, key] of [
      ['正向提示词', 'prompt'],
      ['负向提示词', 'negative'],
    ]) {
      const details = el('details', 'lc-prompt');
      details.append(el('summary', '', label), el('p', '', node[key] || '未记录'));
      inspector.append(details);
    }
    const footer = el('div', 'lc-detail-foot');
    const openWork = button('查看这张作品', null, 'lc-open-work');
    openWork.disabled = !node.work || node.missing;
    openWork.onclick = () => {
      close();
      onOpenWork?.(node.work);
    };
    footer.append(
      openWork,
      el(
        'span',
        'lc-muted',
        node.missing
          ? '图片已删除，线索仍保留。'
          : node.external
            ? '外部 META 作为本次创作的来源。'
            : node.legacy
              ? '旧作品，仅记录更新后的关联。'
              : '保存在当前浏览器的本地记录。',
      ),
    );
    inspector.append(footer);
    inspector.scrollTop = 0;
  }
  function select(id) {
    const node = graph?.nodes.find((n) => n.id === id);
    if (!node) return;
    selected = id;
    for (const [key, card] of nodes) card.setAttribute('aria-pressed', String(key === id));
    for (const [key, card] of groupCards) card.classList.toggle('is-selected', key === memberGroups.get(id));
    for (const path of svg.querySelectorAll('path'))
      path.classList.toggle(
        'is-selected',
        path.dataset.source === memberGroups.get(id) || path.dataset.target === memberGroups.get(id),
      );
    renderInspector(node);
  }
  function renderConnections() {
    if (!graph || !layout) return;
    svg.replaceChildren();
    const connections = new Map();
    for (const edge of connectionEdges) {
      if ((edgeFilter === 'solid' && dashed(edge.type)) || (edgeFilter === 'similar' && !dashed(edge.type)))
        continue;
      const key = JSON.stringify([edge.source, edge.target, dashed(edge.type) ? edge.type : 'solid']);
      if (!connections.has(key)) connections.set(key, []);
      connections.get(key).push(edge);
    }
    const routes = routeConnections(layout, [...connections.values()]);
    world.style.width = layout.width + 'px';
    world.style.height = layout.height + 'px';
    svg.setAttribute('width', layout.width);
    svg.setAttribute('height', layout.height);
    svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
    for (const route of routes) {
      const { edge, reasons } = route;
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', route.path);
      path.dataset.type = edge.type;
      path.dataset.source = edge.source;
      path.dataset.target = edge.target;
      path.classList.toggle(
        'is-selected',
        edge.source === memberGroups.get(selected) || edge.target === memberGroups.get(selected),
      );
      const title = document.createElementNS(NS, 'title');
      title.textContent = reasons
        .map((reason) => (reason.label || edgeNames[reason.type]) + ' · ' + changeSummary(reason))
        .join(' / ');
      path.append(title);
      svg.append(path);
      const caption = document.createElementNS(NS, 'text');
      caption.setAttribute('x', route.labelX);
      caption.setAttribute('y', route.labelY);
      caption.setAttribute('text-anchor', 'middle');
      caption.dataset.type = edge.type;
      caption.textContent = route.label;
      svg.append(caption);
    }
    count.textContent = `${groupList.length} 组 · ${graph.nodes.length} 张图`;
  }
  function prepareGroups() {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const covered = new Set();
    const normalized = [];
    for (const group of Array.isArray(graph.groups) ? graph.groups : []) {
      const members = (Array.isArray(group.memberIds) ? group.memberIds : [])
        .filter((id) => byId.has(id) && !covered.has(id))
        .map((id) => byId.get(id));
      if (!members.length) continue;
      members.forEach((node) => covered.add(node.id));
      normalized.push({ id: String(group.id || 'group:' + members[0].id), members });
    }
    for (const node of graph.nodes)
      if (!covered.has(node.id)) normalized.push({ id: 'group:' + node.id, members: [node] });
    memberGroups.clear();
    memberFrames.clear();
    return normalized.map((group) => {
      group.members.sort((a, b) => (a.created || 0) - (b.created || 0));
      const count = group.members.length;
      group.width = count === 1 ? 250 : count <= 4 ? 420 : count <= 9 ? 560 : 640;
      for (const node of group.members) {
        memberGroups.set(node.id, group.id);
        const w = Number(node.width || node.work?.width),
          h = Number(node.height || node.work?.height);
        memberFrames.set(node.id, {
          groupId: group.id,
          aspect: w > 0 && h > 0 ? w / h : node.external ? 1.5 : 0.8,
        });
      }
      group.created = group.members[0].created;
      justifyGroup(group);
      return group;
    });
  }
  function justifyGroup(group) {
    const inner = group.width - 20,
      count = group.members.length,
      target = count <= 4 ? 190 : 205;
    const costs = Array(count + 1).fill(Infinity),
      breaks = Array(count).fill(1);
    costs[count] = 0;
    for (let start = count - 1; start >= 0; start--) {
      let aspect = 0;
      for (let end = start + 1; end <= Math.min(count, start + 6); end++) {
        aspect += memberFrames.get(group.members[end - 1].id).aspect;
        const length = end - start,
          height = (inner - IMAGE_GAP * (length - 1)) / aspect;
        const cost =
          (height - target) ** 2 +
          Math.max(0, 135 - height) ** 2 * 5 +
          Math.max(0, height - 360) ** 2 * 2 +
          (length === 1 && count > 1 ? target ** 2 * 0.15 : 0) +
          costs[end];
        if (cost < costs[start]) {
          costs[start] = cost;
          breaks[start] = length;
        }
      }
    }
    const rows = [];
    let top = GROUP_HEADER;
    for (let start = 0; start < count;) {
      const members = group.members.slice(start, start + breaks[start]);
      const sum = members.reduce((total, node) => total + memberFrames.get(node.id).aspect, 0);
      const height = (inner - IMAGE_GAP * (members.length - 1)) / sum;
      let left = 10;
      for (const [index, node] of members.entries()) {
        const frame = memberFrames.get(node.id);
        const width = index === members.length - 1 ? group.width - 10 - left : frame.aspect * height;
        Object.assign(frame, { left, top, width, height });
        left += width + IMAGE_GAP;
      }
      rows.push({ members, top, height });
      top += height + IMAGE_GAP;
      start += members.length;
    }
    group.rows = rows;
    group.height = top - IMAGE_GAP + 10;
  }
  function renderGroupRows(group) {
    const container = groupCards.get(group.id)?.querySelector('.lc-members');
    if (!container) return;
    const active = document.activeElement,
      focused = container.contains(active);
    const fragment = document.createDocumentFragment();
    for (const [index, row] of group.rows.entries()) {
      const host = el('div', 'lc-row');
      host.dataset.rowIndex = index;
      host.style.height = row.height + 'px';
      for (const node of row.members) {
        const frame = memberFrames.get(node.id),
          card = nodes.get(node.id);
        if (!card) continue;
        Object.assign(card.style, { width: frame.width + 'px', height: frame.height + 'px' });
        card.querySelector('.lc-photo').style.aspectRatio = `${frame.width} / ${frame.height}`;
        host.append(card);
      }
      fragment.append(host);
    }
    container.replaceChildren(fragment);
    if (focused && active?.isConnected) active.focus({ preventScroll: true });
  }
  function reflowMembers(group) {
    if (!layout || !groupCards.has(group.id)) return;
    justifyGroup(group);
    renderGroupRows(group);
    layout.positions.get(group.id).height = group.height;
    groupCards.get(group.id).style.height = group.height + 'px';
    if (!routeFrame)
      routeFrame = requestAnimationFrame(() => {
        routeFrame = 0;
        renderConnections();
        loadVisible();
      });
  }
  function updateGroupPosition(id, px, py, persist = false) {
    const position = layout?.positions.get(id),
      card = groupCards.get(id);
    if (!position || !card) return;
    position.x = clamp(px, -100000, 100000);
    position.y = clamp(py, -100000, 100000);
    card.style.left = position.x + 'px';
    card.style.top = position.y + 'px';
    if (!routeFrame)
      routeFrame = requestAnimationFrame(() => {
        routeFrame = 0;
        renderConnections();
        loadVisible();
      });
    if (persist) {
      storedPositions[id] = { x: position.x, y: position.y };
      savePositions();
    }
  }
  function render() {
    nodes.clear();
    images.clear();
    groupCards.clear();
    defaultPositions.clear();
    nodeLayer.replaceChildren();
    svg.replaceChildren();
    groupList = prepareGroups();
    connectionEdges = graph.edges
      .map((edge) => ({
        ...edge,
        source: memberGroups.get(edge.source),
        target: memberGroups.get(edge.target),
      }))
      .filter((edge) => edge.source && edge.target && edge.source !== edge.target);
    layout = arrange(groupList, connectionEdges);
    for (const [id, position] of layout.positions) {
      defaultPositions.set(id, { ...position });
      const stored = storedPositions[id];
      if (
        stored &&
        Number.isFinite(stored.x) &&
        Number.isFinite(stored.y) &&
        Math.abs(stored.x) <= 100000 &&
        Math.abs(stored.y) <= 100000
      ) {
        position.x = stored.x;
        position.y = stored.y;
      }
    }
    renderConnections();
    for (const group of groupList) {
      const position = layout.positions.get(group.id),
        shell = el('article', 'lc-group');
      shell.dataset.groupId = group.id;
      Object.assign(shell.style, {
        left: position.x + 'px',
        top: position.y + 'px',
        width: group.width + 'px',
        height: group.height + 'px',
      });
      const handle = button('拖动提示词组；方向键移动，Home 恢复自动位置', null, 'lc-group-handle');
      handle.textContent = '';
      handle.dataset.groupHandle = group.id;
      handle.append(
        icon('M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01'),
        el('span', '', group.members.length > 1 ? '相同提示词' : '提示词组'),
        el('small', '', String(group.members.length).padStart(2, '0') + ' 张'),
      );
      handle.onkeydown = (event) => {
        const steps = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
        if (steps[event.key]) {
          event.preventDefault();
          event.stopPropagation();
          const [dx, dy] = steps[event.key];
          updateGroupPosition(
            group.id,
            position.x + dx * (event.shiftKey ? 5 : 1),
            position.y + dy * (event.shiftKey ? 5 : 1),
            true,
          );
        } else if (event.key === 'Home') {
          event.preventDefault();
          const original = defaultPositions.get(group.id);
          delete storedPositions[group.id];
          savePositions();
          updateGroupPosition(group.id, original.x, original.y);
        }
      };
      const members = el('div', 'lc-members');
      for (const [index, node] of group.members.entries()) {
        const frame = memberFrames.get(node.id);
        const card = button(`${operation(node)}，${time(node.created)}，查看线索详情`, null, 'lc-node');
        card.textContent = '';
        card.dataset.nodeId = node.id;
        card.style.height = frame.height + 'px';
        if (node.missing) card.dataset.missing = '';
        const photo = el('div', 'lc-photo');
        photo.style.aspectRatio = `${frame.width} / ${frame.height}`;
        if (node.work && !node.missing) {
          const image = el('img');
          image.alt = '';
          image.decoding = 'async';
          image.draggable = false;
          image.addEventListener('load', () => {
            if (!layout || images.get(node.id)?.image !== image || !image.naturalWidth || !image.naturalHeight)
              return;
            const aspect = image.naturalWidth / image.naturalHeight;
            if (Math.abs(frame.aspect - aspect) > 0.00001) {
              frame.aspect = aspect;
              reflowMembers(group);
            }
          });
          image.addEventListener('error', () => {
            image.hidden = true;
            photo.dataset.empty = '';
          });
          photo.append(image);
          Object.assign(frame, { image, work: node.work, loaded: false });
          images.set(node.id, frame);
        } else {
          photo.dataset.empty = '';
          photo.append(
            el('span', '', node.missing ? '图像已删除' : node.external ? '外部 META' : '未保留原图'),
          );
        }
        const label = el('div', 'lc-node-label');
        label.append(el('strong', '', operation(node)), el('time', '', time(node.created)));
        const meta = el('div', 'lc-node-meta');
        meta.append(
          el('span', '', node.width && node.height ? `${node.width} × ${node.height}` : '尺寸未记录'),
          el('small', '', 'SEED ' + valueText(node.settings?.seed)),
        );
        card.append(photo, label, meta);
        card.onclick = () => {
          if (performance.now() >= suppressClickUntil) select(node.id);
        };
        card.addEventListener('focus', () => {
          viewport.scrollLeft = viewport.scrollTop = 0;
          const local = memberFrames.get(node.id),
            left = (position.x + (local?.left || 0)) * scale + x,
            top = (position.y + (local?.top || 0)) * scale + y;
          if (
            left < 0 ||
            top < 0 ||
            left + frame.width * scale > viewport.clientWidth ||
            top + frame.height * scale > viewport.clientHeight
          )
            center(node.id, false);
        });
        nodes.set(node.id, card);
        members.append(card);
      }
      shell.append(handle, members);
      groupCards.set(group.id, shell);
      nodeLayer.append(shell);
      renderGroupRows(group);
    }
    notice.textContent =
      graph.nodes.length <= 1 && graph.nodes[0]?.legacy
        ? '此前作品未追溯 · 新修改将从这里继续'
        : '拖动组标题整理线索 · 空白处平移画布';
    select(graph.focusId && nodes.has(graph.focusId) ? graph.focusId : graph.nodes[0]?.id);
    fit(false, true);
  }
  async function open(work) {
    const ticket = ++requestVersion;
    sourceWork = work;
    previousFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
    dialog.dataset.loading = '';
    notice.textContent = '正在整理线索…';
    count.textContent = '';
    nodeLayer.replaceChildren();
    svg.replaceChildren();
    inspector.replaceChildren();
    nodes.clear();
    images.clear();
    graph = layout = null;
    background();
    try {
      const result = await getGraph(work);
      if (ticket !== requestVersion || !dialog.open) return;
      graph = {
        ...result,
        nodes: Array.isArray(result?.nodes) ? result.nodes : [],
        edges: Array.isArray(result?.edges) ? result.edges : [],
      };
      delete dialog.dataset.loading;
      if (!graph.nodes.length) {
        notice.textContent = '这张作品暂时没有可读取的线索';
        return;
      }
      render();
      viewport.focus({ preventScroll: true });
      if (!reduced.matches)
        body.animate(
          [
            { opacity: 0.2, translate: '0 8px' },
            { opacity: 1, translate: '0 0' },
          ],
          { duration: 320, easing: 'cubic-bezier(.22,.75,.25,1)' },
        );
    } catch (error) {
      if (ticket === requestVersion) {
        delete dialog.dataset.loading;
        notice.textContent = '线索读取失败，请稍后再试';
        notify(error.message || '线索读取失败');
      }
    }
  }
  function cleanupClose() {
    ++requestVersion;
    stopMotion();
    renderer?.destroy();
    renderer = null;
    backdrop.replaceChildren();
    pointers.clear();
    drag = null;
    for (const entry of images.values()) entry.image.removeAttribute('src');
    images.clear();
    nodes.clear();
    groupCards.clear();
    memberFrames.clear();
    memberGroups.clear();
    defaultPositions.clear();
    groupList = [];
    connectionEdges = [];
    cancelAnimationFrame(routeFrame);
    routeFrame = 0;
    nodeLayer.replaceChildren();
    svg.replaceChildren();
    inspector.replaceChildren();
    graph = layout = sourceWork = null;
    delete viewport.dataset.dragging;
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
  function close() {
    if (dialog.open) {
      dialog.close();
      cleanupClose();
    }
  }
  listener(closeButton, 'click', close);
  listener(dialog, 'close', () => {
    // A close event is queued: it must not tear down a newly reopened canvas.
    if (!dialog.open) cleanupClose();
  });
  listener(dialog, 'click', (event) => {
    if (event.target === dialog) close();
  });
  listener(minus, 'click', () => centerZoom(1 / 1.2));
  listener(plus, 'click', () => centerZoom(1.2));
  listener(fitButton, 'click', () => fit());
  listener(centerButton, 'click', () => center());
  listener(
    viewport,
    'wheel',
    (event) => {
      event.preventDefault();
      zoomAt(scale * Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    },
    { passive: false },
  );
  function clearCanvasSelection() {
    const selection = document.getSelection();
    if (
      selection?.rangeCount &&
      (viewport.contains(selection.anchorNode) || viewport.contains(selection.focusNode))
    )
      selection.removeAllRanges();
  }
  function resetGesture(groupId = null) {
    const points = [...pointers.values()];
    if (!points.length) {
      drag = null;
      return;
    }
    const a = points[0],
      b = points[1],
      position = !b && groupId ? layout?.positions.get(groupId) : null;
    drag = {
      x,
      y,
      scale,
      px: b ? (a.x + b.x) / 2 : a.x,
      py: b ? (a.y + b.y) / 2 : a.y,
      distance: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0,
      moved: false,
      groupId: position ? groupId : null,
      groupX: position?.x,
      groupY: position?.y,
    };
  }
  function persistDraggedGroup() {
    if (!drag?.groupId || !drag.moved) return;
    const position = layout.positions.get(drag.groupId);
    storedPositions[drag.groupId] = { x: position.x, y: position.y };
    savePositions();
  }
  listener(viewport, 'dragstart', (event) => event.preventDefault());
  listener(viewport, 'selectstart', (event) => event.preventDefault());
  listener(viewport, 'pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('.lc-tools')) return;
    stopMotion();
    persistDraggedGroup();
    const handle = event.target.closest('[data-group-handle]');
    const onMember = event.target.closest('.lc-node');
    clearCanvasSelection();
    if (handle || !onMember) event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    resetGesture(pointers.size === 1 ? handle?.dataset.groupHandle : null);
    if (handle || !onMember || pointers.size > 1) viewport.setPointerCapture(event.pointerId);
    if (pointers.size > 1) suppressClickUntil = performance.now() + 250;
  });
  listener(
    viewport,
    'pointermove',
    (event) => {
      if (!pointers.has(event.pointerId) || !drag) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const points = [...pointers.values()],
        a = points[0],
        b = points[1];
      const px = b ? (a.x + b.x) / 2 : a.x,
        py = b ? (a.y + b.y) / 2 : a.y;
      if (Math.hypot(px - drag.px, py - drag.py) > 4 || b) {
        event.preventDefault();
        clearCanvasSelection();
        drag.moved = true;
        suppressClickUntil = performance.now() + 200;
        viewport.setPointerCapture(event.pointerId);
        viewport.dataset.dragging = drag.groupId ? 'group' : 'canvas';
        if (b && drag.distance) {
          const r = viewport.getBoundingClientRect(),
            next = clamp((drag.scale * Math.hypot(a.x - b.x, a.y - b.y)) / drag.distance, 0.08, 2.5),
            ratio = next / drag.scale;
          move(
            px - r.left - (drag.px - r.left - drag.x) * ratio,
            py - r.top - (drag.py - r.top - drag.y) * ratio,
            next,
          );
        } else if (drag.groupId)
          updateGroupPosition(
            drag.groupId,
            drag.groupX + (px - drag.px) / scale,
            drag.groupY + (py - drag.py) / scale,
          );
        else move(drag.x + px - drag.px, drag.y + py - drag.py, scale);
      }
    },
    { passive: false },
  );
  const end = (event) => {
    if (!pointers.has(event.pointerId)) return;
    if (drag?.moved) suppressClickUntil = performance.now() + 200;
    persistDraggedGroup();
    pointers.delete(event.pointerId);
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    resetGesture();
    delete viewport.dataset.dragging;
  };
  listener(viewport, 'pointerup', end);
  listener(viewport, 'pointercancel', end);
  listener(viewport, 'lostpointercapture', end);
  listener(viewport, 'keydown', (event) => {
    if (event.target !== viewport) return;
    const actions = {
      ArrowLeft: () => move(x + 60, y, scale),
      ArrowRight: () => move(x - 60, y, scale),
      ArrowUp: () => move(x, y + 60, scale),
      ArrowDown: () => move(x, y - 60, scale),
      0: () => fit(),
      Home: () => fit(),
      '+': () => centerZoom(1.2),
      '=': () => centerZoom(1.2),
      '-': () => centerZoom(1 / 1.2),
    };
    if (actions[event.key]) {
      event.preventDefault();
      actions[event.key]();
    }
  });
  const size = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      if (dialog.open && layout) {
        const point = layout.positions.get(memberGroups.get(selected));
        const cx = point ? (point.x + point.width / 2) * scale + x : 0;
        const cy = point ? (point.y + Math.min(point.height / 2, 160)) * scale + y : 0;
        if (point && (cx < 0 || cx > viewport.clientWidth || cy < 0 || cy > viewport.clientHeight))
          center(selected, false);
        else paint();
      }
    });
  });
  size.observe(viewport);
  listener(reduced, 'change', () => {
    if (reduced.matches) stopMotion();
  });
  listener(window, 'folio:content-preferences', () => {
    if (dialog.open && getHideNSFW()) close();
  });
  return {
    open,
    close,
    destroy() {
      close();
      cleanupClose();
      abort.abort();
      theme.disconnect();
      size.disconnect();
      cancelAnimationFrame(resizeFrame);
      dialog.remove();
      sourceWork = graph = layout = null;
    },
  };
}
