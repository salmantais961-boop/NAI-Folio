import { button, element, icon } from './desktop-agent-elements.js';

const states = {
  queued: '排队中',
  running: '执行中',
  done: '已完成',
  error: '失败',
  cancelled: '已停止',
  skipped: '已跳过',
  unconfirmed: '未记录返回',
};
const numberFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 });
function duration(row, until = row.endedAt) {
  if (!Number.isFinite(row.startedAt) || !Number.isFinite(until)) return '';
  const ms = Math.max(0, until - row.startedAt);
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60_000) return numberFormat.format(ms / 1000) + ' s';
  return Math.floor(ms / 60_000) + ' 分 ' + Math.round((ms % 60_000) / 1000) + ' 秒';
}
function observedState(row, live) {
  if (!live && (row.state === 'queued' || row.state === 'running')) return 'unconfirmed';
  return Object.hasOwn(states, row.state) ? row.state : 'unconfirmed';
}

// The runner supplies pre-redacted display strings, independent of the model's private reasoning.
export function recordToolEvent(turn, row) {
  if (!row || typeof row.id !== 'string' || typeof row.name !== 'string' || !Object.hasOwn(states, row.state))
    return false;
  const rows = (turn.tools ??= []);
  const i = rows.findIndex((old) => old.id === row.id);
  if (i >= 0) rows[i] = row;
  else rows.push(row);
  return true;
}
export function endToolEvents(turn) {
  for (const row of turn.tools || []) {
    if (row.state !== 'queued' && row.state !== 'running') continue;
    row.state = turn.state === 'cancelled' ? 'cancelled' : row.state === 'queued' ? 'skipped' : 'unconfirmed';
    row.endedAt ??= Date.now();
  }
}

function codeSection(label, onCopyFailure) {
  const group = element('div', 'da-trace-payload');
  const head = element('div', 'da-trace-payload-head');
  const code = element('code');
  const copy = button(
    '复制' + label,
    'copy',
    async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        copy.dataset.copied = 'true';
        copy.setAttribute('aria-label', '已复制' + label);
        copy.title = '已复制';
        setTimeout(() => {
          delete copy.dataset.copied;
          copy.setAttribute('aria-label', '复制' + label);
          copy.title = '复制' + label;
        }, 1300);
      } catch {
        onCopyFailure('未能写入剪贴板，可选中下方文本复制。');
      }
    },
    'da-trace-copy',
  );
  const note = element('small');
  head.append(element('span', '', label), note, copy);
  const pre = element('pre');
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', label);
  pre.append(code);
  group.append(head, pre);
  return {
    group,
    update(value, truncated) {
      if (code.textContent !== value) code.textContent = value;
      note.textContent = truncated ? '已截取' : '';
      copy.disabled = !value;
    },
  };
}

function makeCall(notice) {
  const item = element('details', 'da-trace-call');
  const summary = element('summary', 'da-trace-row');
  const dot = element('i', 'da-trace-dot');
  dot.setAttribute('aria-hidden', 'true');
  const name = element('code', 'da-trace-name'),
    state = element('span', 'da-trace-state');
  const time = element('span', 'da-trace-time');
  summary.append(dot, name, state, time, icon('chevron'));
  const panel = element('div', 'da-trace-body');
  item.append(summary, panel);
  // Large argument/result strings are only inserted into the DOM when this call is opened.
  let model, input, output;
  function paintData() {
    if (!item.open || !model) return;
    if (!input) {
      input = codeSection('调用', notice);
      output = codeSection('返回', notice);
      panel.append(input.group, output.group);
    }
    input.update(model.name + '(' + (model.argumentsText ?? '{}') + ')', model.argumentsTruncated);
    output.group.hidden = typeof model.resultText !== 'string';
    if (!output.group.hidden) output.update(model.resultText, model.resultTruncated);
  }
  item.addEventListener('toggle', paintData);
  return {
    item,
    tick(now) {
      if (item.dataset.state !== 'running') return;
      time.textContent = duration(model, now);
    },
    update(row, live) {
      model = row;
      const display = observedState(row, live);
      item.dataset.state = display;
      name.textContent = row.name;
      name.title = row.name;
      state.textContent = states[display];
      time.textContent = duration(row, display === 'running' ? Date.now() : row.endedAt);
      paintData();
    },
  };
}

export function createToolTrace(live, notice) {
  const root = element('details', 'da-trace');
  root.open = live;
  const summary = element('summary', 'da-trace-summary');
  const amount = element('span', 'da-trace-count');
  const rail = element('div', 'da-trace-rail');
  rail.setAttribute('aria-hidden', 'true');
  summary.append(icon('tools'), element('strong', '', '工具调用'), rail, amount, icon('chevron'));
  const list = element('div', 'da-trace-groups');
  root.append(summary, list);
  const groups = new Map(),
    calls = new Map();
  let clock;
  function stopClock() {
    clearInterval(clock);
    clock = undefined;
  }

  return {
    root,
    update(rows, active) {
      let complete = 0;
      for (const row of rows) {
        const state = observedState(row, active);
        if (state !== 'running' && state !== 'queued') complete++;
        let call = calls.get(row.id);
        if (!call) {
          const round = row.round || 1;
          if (!groups.has(round)) {
            const group = element('section', 'da-trace-round');
            group.append(element('h4', '', '第 ' + round + ' 轮'));
            list.append(group);
            groups.set(round, group);
          }
          call = makeCall(notice);
          groups.get(round).append(call.item);
          call.bar = element('i', 'da-trace-segment');
          rail.append(call.bar);
          calls.set(row.id, call);
        }
        call.update(row, active);
        call.bar.dataset.state = state;
        call.bar.title = row.name + ' · ' + states[state] + (duration(row) ? ' · ' + duration(row) : '');
        const delta =
          Number.isFinite(row.startedAt) && Number.isFinite(row.endedAt) ? row.endedAt - row.startedAt : 0;
        call.bar.style.flexGrow = String(Math.max(20, delta));
      }
      amount.textContent = (active ? complete + ' / ' : '') + rows.length + ' 次';
      if (active && rows.some((row) => row.state === 'running')) {
        clock ??= setInterval(() => {
          if (!root.isConnected) {
            stopClock();
            return;
          }
          if (root.open && !document.hidden) for (const call of calls.values()) call.tick(Date.now());
        }, 500);
      } else stopClock();
    },
  };
}
