import { readChunks, reference, resolvePromptReferences, watchChunks } from './chunks.js';
import { joinFrozenBlocks } from './desktop-agent-run.js';
import { button, element, explain, icon } from './desktop-agent-elements.js';
import { settingsPanel } from './desktop-agent-settings.js';
import { reasoningEfforts } from './agent-effort.mjs';
import { createToolTrace, endToolEvents, recordToolEvent } from './desktop-agent-trace.js';
import { replyFooter, signature } from './desktop-agent-reply.js';
import { webSearchProviderFor } from './agent-web-search.js';
import * as store from './desktop-agent-store.js';

const emptyConfig = () => ({
  profiles: [],
  activeId: '',
  plugins: { skillPaths: [], extensionPaths: [], mcpServers: {} },
});
const sessionKey = 'folio.desktop-agent.last-thread';
const threadName = (item) => item?.title || '新对话';
const lockLane = (lock) => (lock.lane === 'negative' ? 'negative' : 'positive');
const laneName = (lane) => (lane === 'negative' ? '负面' : '正向');
const lockKey = (id, lane) => lane + ':' + id;
function lockSummary(locks, className) {
  const band = element('span', className);
  for (const lane of ['positive', 'negative']) {
    const names = locks.filter((c) => lockLane(c) === lane).map((c) => c.name);
    if (!names.length) continue;
    const group = element('span', 'da-lane-summary');
    group.dataset.lane = lane;
    group.append(icon('lock'), document.createTextNode(laneName(lane) + ' · ' + names.join('、')));
    band.append(group);
  }
  return band;
}
const modelLabel = (profile) => profile?.model || '连接模型';
const effortNames = {
  auto: '自动',
  low: '低',
  medium: '中',
  high: '高',
  max: '最大',
  xhigh: '超高',
  on: '开启',
  off: '关闭',
};
function effortFor(profile, conversation) {
  const options = profile?.model ? reasoningEfforts(profile) : ['auto'];
  const requested = conversation?.reasoningEffort || 'auto';
  return { options, selected: options.includes(requested) ? requested : 'auto' };
}
const displayTime = (stamp) =>
  new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(stamp);
function dateLabel(stamp) {
  const date = new Date(stamp),
    today = new Date();
  if (date.toDateString() === today.toDateString()) return '今天';
  today.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return '昨天';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}
function flower() {
  const mark = element('span', 'da-flower');
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}
function prose(text) {
  const block = element('div', 'da-prose');
  // Compose short Markdown spans as DOM nodes; model output never becomes markup or executable URLs.
  for (const part of String(text || '').split(/(```[\s\S]*?(?:```|$))/g)) {
    if (part.startsWith('```')) {
      const pre = element('pre');
      pre.append(
        element(
          'code',
          '',
          part
            .replace(/^```[^\n]*\n?/, '')
            .replace(/```$/, '')
            .trimEnd(),
        ),
      );
      block.append(pre);
    } else {
      for (const bit of part.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)) {
        if (bit.startsWith('**') && bit.endsWith('**')) block.append(element('strong', '', bit.slice(2, -2)));
        else if (bit.startsWith('`') && bit.endsWith('`')) block.append(element('code', '', bit.slice(1, -1)));
        else block.append(document.createTextNode(bit));
      }
    }
  }
  return block;
}
function promptPlan(plan, locks, open) {
  const details = element('details', 'da-plan');
  details.open = open;
  const summary = element('summary'),
    heading = element('strong', '', '生图配方');
  summary.append(icon('note'), heading);
  if (Number.isFinite(plan.width) && Number.isFinite(plan.height))
    summary.append(element('small', '', plan.width + ' × ' + plan.height));
  summary.append(icon('chevron'));
  const list = element('dl');
  function add(title, value) {
    if (typeof value !== 'string' || !value.trim()) return;
    list.append(element('dt', '', title), element('dd', '', value));
  }
  add('正向提示词', plan.prompt);
  add(locks?.some((c) => lockLane(c) === 'negative') ? '负面提示词 · 已锁定' : '负面提示词', plan.negative);
  for (const [index, c] of (plan.characters || []).entries()) {
    add('角色 ' + (index + 1), c.prompt);
    add('角色 ' + (index + 1) + ' · 负向', c.negative);
  }
  details.append(summary, list);
  if (locks?.length) {
    details.append(lockSummary(locks, 'da-plan-locks'));
  }
  return details;
}
export function mountDesktopAgent(host, { run, openWork, openConnection, getNegativeSnapshot, imageSettings }) {
  host.classList.add('desktop-agent-host');
  const shell = element('section', 'da-shell');
  shell.setAttribute('aria-label', 'Agent 创作对话');
  const header = element('header', 'da-header'),
    body = element('div', 'da-main');
  const toast = element('div', 'da-notice');
  toast.setAttribute('role', 'status');
  toast.hidden = true;
  shell.append(header, body, toast);
  host.replaceChildren(shell);

  const lifetime = new AbortController();
  let config = emptyConfig(),
    thread = null,
    turns = [],
    view = 'chat',
    visible = false,
    initialized = false;
  let viewCleanup,
    selection = 0,
    draftTimer,
    toastTimer,
    activeJob,
    modelMenu,
    menuAnchor,
    renderCutoff = 0;
  let dest, input, send, modelButton, effortButton, locksButton, lockBand, composer, welcome;
  const replyHosts = new Map();
  let navigating;
  const channel =
    typeof BroadcastChannel === 'function' ? new BroadcastChannel('folio-desktop-agent-history') : null;
  function notice(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = !message;
    if (message)
      toastTimer = setTimeout(() => {
        toast.hidden = true;
      }, 6500);
  }
  const safe =
    (fn) =>
    (...args) =>
      Promise.resolve()
        .then(() => fn(...args))
        .catch((err) => notice(explain(err)));
  const active = () => config.profiles.find((p) => p.id === config.activeId);
  async function persist(next) {
    // A session-only key stays in this window's memory even when other settings change.
    await store.savePreferences({
      ...next,
      profiles: next.profiles.map((p) => ({ ...p, apiKey: p.remember ? p.apiKey : '' })),
    });
    config = next;
  }
  const rememberThread = (id) => {
    try {
      sessionStorage.setItem(sessionKey, id);
    } catch {}
  };
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = null;
    if (thread && input && view === 'chat' && input.value !== thread.draft) {
      const owner = thread,
        previous = owner.draft,
        value = input.value;
      owner.draft = value;
      return store.editThread(owner.id, { draft: value }).catch((error) => {
        if (owner.draft === value) owner.draft = previous;
        throw error;
      });
    }
  }
  function queueDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(safe(saveDraft), 320);
  }
  function closeMenu(focus = false) {
    if (!modelMenu) return;
    modelMenu.remove();
    modelMenu = null;
    menuAnchor?.setAttribute('aria-expanded', 'false');
    if (focus) menuAnchor?.focus();
    menuAnchor = null;
  }
  function enter(name, title) {
    void saveDraft()?.catch((err) => notice(explain(err)));
    viewCleanup?.();
    viewCleanup = null;
    closeMenu();
    view = name;
    input = null;
    dest = null;
    composer = null;
    replyHosts.clear();
    body.replaceChildren();
    header.replaceChildren();
    shell.dataset.view = name;
    if (name === 'chat') {
      const titleGroup = element('div', 'da-header-titles');
      const h = element('h1', 'da-masthead');
      h.append(element('em', '', 'Agent'));
      const wordmark = element('div', 'da-agent-wordmark');
      wordmark.append(h, element('span', 'da-header-imprint', signature));
      const sub = element('span', 'da-thread-title', threadName(thread));
      sub.title = threadName(thread);
      titleGroup.append(wordmark, sub);
      const actions = element('div', 'da-top-actions');
      actions.append(
        button('历史对话', 'history', safe(openHistory)),
        button('新建对话', 'plus', safe(createThread)),
        button('Agent 设置', 'sliders', openSettings),
      );
      header.append(titleGroup, actions);
    } else {
      const back = button('返回对话', 'back', () => {
        showChat();
        input?.focus({ preventScroll: true });
      });
      header.append(back, element('h2', 'da-subtitle', title));
      requestAnimationFrame(() => {
        if (view === name) back.focus({ preventScroll: true });
      });
    }
  }
  async function selectThread(id, preview) {
    const version = ++selection;
    const saving = saveDraft();
    if (preview) {
      input = null;
      thread = { ...preview };
      turns = [];
      showChat();
      input.focus({ preventScroll: true });
    }
    const loaded = Promise.all([store.getThread(id), store.getTurns(id), saving]);
    navigating = loaded;
    let record, messages;
    try {
      [record, messages] = await loaded;
    } finally {
      if (navigating === loaded) navigating = null;
    }
    if (version !== selection) return;
    if (!record) {
      const available = await store.listThreads();
      const first = available[0] || (await store.newThread());
      return selectThread(first.id);
    }
    if (preview && thread?.id === id) {
      turns = messages;
      thread.title = record.title;
      if (view === 'chat') {
        if (input.value === preview.draft && thread.draft === preview.draft) {
          input.value = record.draft;
          thread.draft = record.draft;
        }
        thread.locks = record.locks;
        if (thread.reasoningEffort === preview.reasoningEffort) thread.reasoningEffort = record.reasoningEffort;
        drawTranscript();
        paintComposer();
        resizeInput();
        goLatest(true);
      }
    } else {
      input = null;
      thread = record;
      turns = messages;
      showChat();
    }
    rememberThread(id);
    return record;
  }
  async function createThread() {
    const saving = saveDraft();
    if (
      thread &&
      activeJob?.threadId !== thread.id &&
      !thread.title &&
      !turns.length &&
      !thread.draft &&
      !thread.locks?.length &&
      (!thread.reasoningEffort || thread.reasoningEffort === 'auto')
    ) {
      if (view !== 'chat') showChat();
      input?.focus();
      await saving;
      return;
    }
    ++selection;
    const record = store.emptyThread(thread?.locks ?? []);
    const created = store.newThread(record);
    navigating = created;
    input = null;
    thread = record;
    turns = [];
    rememberThread(record.id);
    showChat();
    input.focus({ preventScroll: true });
    try {
      await Promise.all([created, saving]);
    } finally {
      if (navigating === created) navigating = null;
    }
    channel?.postMessage({ type: 'history' });
  }
  async function openHistory() {
    enter('history', '历史对话');
    const list = element('div', 'da-subpage da-history');
    body.append(list);
    const rows = await store.listThreads();
    if (view !== 'history' || !list.isConnected) return;
    const actions = element('div', 'da-subpage-lead');
    actions.append(button('新建对话', 'plus', safe(createThread), 'da-secondary', true));
    list.append(actions);
    let date = '';
    for (const row of rows) {
      if (!row.title && !row.draft && !row.locks?.length && row.id !== thread?.id) continue;
      const group = dateLabel(row.updated);
      if (group !== date) {
        list.append(element('h3', 'da-list-date', group));
        date = group;
      }
      const item = element('div', 'da-history-item');
      item.toggleAttribute('data-current', row.id === thread?.id);
      const choose = button(
        threadName(row),
        null,
        safe(() => selectThread(row.id, row)),
        'da-history-choose',
      );
      choose.append(element('time', '', displayTime(row.updated)));
      const rename = button('重命名对话', 'pen', () => {
        item.replaceChildren();
        const editor = element('input', 'da-input');
        editor.value = row.title;
        editor.maxLength = 80;
        editor.setAttribute('aria-label', '对话名称');
        const finish = safe(async () => {
          const title = editor.value.trim();
          if (!title) {
            editor.focus();
            return;
          }
          await store.editThread(row.id, { title });
          if (thread?.id === row.id) thread.title = title;
          channel?.postMessage({ type: 'history' });
          await openHistory();
        });
        editor.onkeydown = (e) => {
          if (e.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            void finish();
          }
          if (e.key === 'Escape') {
            e.stopPropagation();
            void openHistory();
          }
        };
        item.append(editor, button('保存名称', 'check', finish), button('取消改名', 'x', safe(openHistory)));
        editor.focus();
        editor.select();
      });
      const del = button('删除对话', 'trash', () => {
        item.replaceChildren(element('span', 'da-remove-label', '删除这段对话？'));
        item.append(
          button('取消', null, safe(openHistory), 'da-text-button'),
          button(
            '删除',
            null,
            safe(async () => {
              if (activeJob?.threadId === row.id) {
                notice('请先停止这条对话中的任务。');
                return;
              }
              await store.deleteThread(row.id);
              channel?.postMessage({ type: 'deleted', id: row.id });
              if (thread?.id === row.id) {
                thread = null;
                const first = (await store.listThreads())[0] || (await store.newThread());
                await selectThread(first.id);
              } else await openHistory();
            }),
            'da-delete',
          ),
        );
      });
      if (activeJob?.threadId === row.id) del.disabled = true;
      item.append(choose, rename, del);
      list.append(item);
    }
  }
  function openSettings() {
    enter('settings', 'Agent 设置');
    viewCleanup = settingsPanel(body, {
      getConfig: () => config,
      close: showChat,
      openConnection: () => openConnection(),
      saveProfile: async (p) => {
        await persist({
          ...config,
          profiles: [...config.profiles.filter((a) => a.id !== p.id), p],
          activeId: p.id,
        });
      },
      removeProfile: async (id) => {
        const profiles = config.profiles.filter((p) => p.id !== id);
        await persist({
          ...config,
          profiles,
          activeId: config.activeId === id ? profiles[0]?.id || '' : config.activeId,
        });
      },
      savePlugins: (plugins) => persist({ ...config, plugins }),
    });
  }
  async function saveLocks(locks) {
    const owner = thread,
      previous = owner.locks;
    owner.locks = locks;
    try {
      await store.editThread(owner.id, { locks });
    } catch (error) {
      if (owner.locks === locks) owner.locks = previous;
      throw error;
    }
  }
  function openLocks() {
    if (!thread) return;
    enter('locks', '锁定提示词块');
    const wrapper = element('div', 'da-subpage da-library');
    const searchBar = element('label', 'da-search');
    const search = element('input');
    search.type = 'search';
    search.placeholder = '搜索名称、分组或提示词';
    search.setAttribute('aria-label', '搜索词块');
    searchBar.append(icon('search'), search);
    let lane = 'positive';
    const lanes = element('div', 'da-lane-switch');
    lanes.setAttribute('role', 'group');
    lanes.setAttribute('aria-label', '词块锁定位置');
    const tabs = new Map();
    for (const slot of ['positive', 'negative']) {
      const tab = button(
        laneName(slot) + '词块',
        null,
        () => {
          lane = slot;
          render();
        },
        'da-lane-tab',
      );
      tab.dataset.lane = slot;
      tabs.set(slot, tab);
      lanes.append(tab);
    }
    const note = element('p', 'da-small-note');
    const list = element('div', 'da-library-list'),
      bottom = element('footer', 'da-library-foot'),
      count = element('span');
    const selected = new Map((thread.locks || []).map((c) => [lockKey(c.id, lockLane(c)), c]));
    const fixedPreview = element('details', 'da-frozen-preview');
    const fixedCopy = element('p');
    fixedPreview.append(element('summary', '', '查看锁定的负面提示词'), fixedCopy);
    const workbench = button(
      '锁定工作台当前负面',
      'lock',
      safe(async () => {
        if (!getNegativeSnapshot) return;
        const data = await getNegativeSnapshot();
        if (!data?.resolvedText?.trim()) {
          notice('工作台还没有可以锁定的负面提示词。');
          return;
        }
        if (!wrapper.isConnected || lane !== 'negative') return;
        selected.set(lockKey(data.id, lane), { ...data, lane });
        render();
      }),
      'da-use-negative',
      true,
    );
    const done = button(
      '应用到对话',
      null,
      safe(async () => {
        await saveLocks([...selected.values()]);
        showChat();
        input?.focus();
      }),
      'da-primary',
    );
    bottom.append(count, done);
    wrapper.append(lanes, note, workbench, fixedPreview, searchBar, list);
    body.append(wrapper, bottom);
    const render = () => {
      const all = readChunks().filter((c) => c.kind !== 'oc');
      for (const [slot, tab] of tabs) tab.setAttribute('aria-pressed', String(slot === lane));
      note.textContent =
        lane === 'negative'
          ? '锁定后，整张图只使用这里的负面词。角色栏也不会额外添加负面词。'
          : '选中的词块会逐字保留在这段对话的正向提示词里。';
      const chosen = [...selected.values()].filter((c) => lockLane(c) === lane);
      workbench.hidden = lane !== 'negative' || !getNegativeSnapshot;
      fixedPreview.hidden = lane !== 'negative' || !chosen.length;
      fixedCopy.textContent = lane === 'negative' ? joinFrozenBlocks(chosen) : '';
      // A lock keeps its chosen text even if the library block is subsequently edited or removed.
      const rows = [...chosen, ...all.filter((c) => !selected.has(lockKey(c.id, lane)))];
      const query = search.value.trim().toLowerCase();
      list.replaceChildren();
      for (const row of rows.filter((c) =>
        (c.name + ' ' + (c.category || '') + ' ' + c.text).toLowerCase().includes(query),
      )) {
        const choose = element('button', 'da-library-item');
        choose.type = 'button';
        const key = lockKey(row.id, lane);
        choose.dataset.lane = lane;
        choose.setAttribute('aria-pressed', String(selected.has(key)));
        const copy = element('span', 'da-library-copy');
        copy.append(element('strong', '', row.name), element('small', '', row.text));
        choose.append(copy, icon(selected.has(key) ? 'check' : 'plus'));
        choose.onclick = () => {
          if (selected.has(key)) selected.delete(key);
          else {
            let fixed;
            try {
              // Refresh the resolver's library, including aliases kept for renamed blocks.
              readChunks();
              fixed = resolvePromptReferences(reference(row.name));
            } catch (error) {
              notice(explain(error));
              return;
            }
            selected.set(key, {
              id: row.id,
              lane,
              name: row.name,
              text: row.text,
              category: row.category || '',
              resolvedText: fixed.text,
              resolvedChunks: fixed.chunks.map(({ id, name, text }) => ({ id, name, text })),
            });
          }
          const scroll = wrapper.scrollTop;
          render();
          wrapper.scrollTop = scroll;
          Array.from(list.children)
            .find((item) => item.firstElementChild?.firstElementChild?.textContent === row.name)
            ?.focus({ preventScroll: true });
        };
        list.append(choose);
      }
      if (!list.children.length)
        list.append(element('p', 'da-empty-list', query ? '没有匹配的词块。' : '词块库里还没有可锁定的提示词。'));
      const negativeCount = [...selected.values()].filter((c) => lockLane(c) === 'negative').length;
      count.textContent = '正向 ' + (selected.size - negativeCount) + ' · 负面 ' + negativeCount;
    };
    render();
    search.oninput = render;
    const unsubscribe = watchChunks(render);
    viewCleanup = unsubscribe;
  }
  function openModels() {
    if (modelMenu && menuAnchor === modelButton) {
      closeMenu(true);
      return;
    }
    closeMenu();
    if (!config.profiles.length) {
      openSettings();
      return;
    }
    modelMenu = element('div', 'da-model-menu');
    menuAnchor = modelButton;
    modelMenu.setAttribute('role', 'group');
    modelMenu.setAttribute('aria-label', '切换模型连接');
    for (const p of config.profiles) {
      const pick = button(
        p.name || p.model,
        null,
        safe(async () => {
          await persist({ ...config, activeId: p.id });
          closeMenu();
          paintComposer();
          modelButton.focus();
        }),
        'da-model-pick',
      );
      pick.append(element('small', '', p.model));
      pick.setAttribute('aria-pressed', String(p.id === config.activeId));
      if (p.id === config.activeId) pick.append(icon('check'));
      modelMenu.append(pick);
    }
    modelMenu.append(button('管理模型连接', 'sliders', openSettings, 'da-menu-manage', true));
    composer.append(modelMenu);
    modelButton.setAttribute('aria-expanded', 'true');
    modelMenu.querySelector('button')?.focus({ preventScroll: true });
  }
  function openEfforts() {
    if (modelMenu && menuAnchor === effortButton) {
      closeMenu(true);
      return;
    }
    closeMenu();
    const profile = active(),
      owner = thread;
    if (!profile || !owner) return;
    const { options, selected } = effortFor(profile, owner);
    if (options.length < 2) return;
    menuAnchor = effortButton;
    modelMenu = element('div', 'da-model-menu da-effort-menu');
    modelMenu.setAttribute('role', 'group');
    modelMenu.setAttribute('aria-label', '思考强度');
    modelMenu.append(element('strong', 'da-effort-heading', '思考强度'));
    for (const value of options) {
      const choice = button(
        effortNames[value] || value,
        null,
        safe(async () => {
          const previous = owner.reasoningEffort;
          owner.reasoningEffort = value;
          closeMenu(true);
          paintComposer();
          try {
            await store.editThread(owner.id, { reasoningEffort: value });
          } catch (e) {
            if (owner.reasoningEffort === value) owner.reasoningEffort = previous;
            if (thread === owner) paintComposer();
            throw e;
          }
        }),
        'da-effort-choice',
      );
      choice.setAttribute('aria-pressed', String(value === selected));
      choice.dataset.effort = value;
      if (value === selected) choice.append(icon('check'));
      modelMenu.append(choice);
    }
    modelMenu.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
      const choices = Array.from(modelMenu.querySelectorAll('button'));
      const i = choices.indexOf(document.activeElement);
      const next =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? choices.length - 1
            : (i + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1) + choices.length) % choices.length;
      e.preventDefault();
      choices[next].focus();
    });
    composer.append(modelMenu);
    effortButton.setAttribute('aria-expanded', 'true');
    modelMenu.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
  }
  function composeMessage() {
    composer = element('form', 'da-composer');
    lockBand = element('div', 'da-lock-band');
    input = element('textarea', 'da-message-input');
    input.rows = 2;
    input.value = thread?.draft || '';
    input.placeholder = '描述你想画的画面…';
    input.setAttribute('aria-label', '给 Folio Agent 发消息');
    input.title = 'Enter 发送，Shift + Enter 换行';
    input.spellcheck = false;
    const tools = element('div', 'da-compose-tools');
    locksButton = button('锁定词块', 'lock', openLocks, 'da-lock-trigger', true);
    modelButton = button('选择语言模型', 'plug', openModels, 'da-model-trigger');
    modelButton.setAttribute('aria-expanded', 'false');
    effortButton = button('思考强度', 'effort', openEfforts, 'da-effort-trigger');
    effortButton.setAttribute('aria-expanded', 'false');
    send = button('发送消息', 'send', null, 'da-send');
    send.onclick = () => {
      if (activeJob?.threadId === thread?.id) cancel();
      else void safe(submit)();
    };
    tools.append(locksButton, modelButton, effortButton, send);
    if (imageSettings) {
      composer.append(imageSettings.trigger(() => {
        enter('image-settings', '生图设置');
        viewCleanup = imageSettings.open(body, showChat);
      }));
    }
    composer.append(lockBand, input, tools);
    composer.onsubmit = (e) => {
      e.preventDefault();
      void safe(submit)();
    };
    input.oninput = () => {
      resizeInput();
      queueDraft();
      paintSend();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        e.stopPropagation();
        if (!activeJob) void safe(submit)();
      }
    };
    body.append(composer);
    paintComposer();
    requestAnimationFrame(resizeInput);
  }
  function resizeInput() {
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = Math.min(152, Math.max(50, input.scrollHeight)) + 'px';
  }
  function paintSend() {
    if (!send || !input) return;
    for (const retry of dest.querySelectorAll('.da-retry')) retry.disabled = Boolean(activeJob);
    const mine = activeJob?.threadId === thread?.id;
    const label = mine ? '停止本次任务' : activeJob ? '另一段对话正在运行' : '发送消息';
    send.disabled = mine ? activeJob.controller.signal.aborted : Boolean(activeJob) || !input.value.trim();
    send.setAttribute('aria-label', label);
    send.title = label;
    if (send.dataset.stopping !== String(mine)) {
      send.dataset.stopping = String(mine);
      send.replaceChildren(icon(mine ? 'stop' : 'send'));
    }
  }
  function paintComposer() {
    if (view !== 'chat' || !input) return;
    const p = active();
    modelButton.replaceChildren(icon('plug'), element('span', '', modelLabel(p)));
    modelButton.title = p ? p.name + ' · ' + p.model : '配置语言模型';
    const { options, selected } = effortFor(p, thread);
    effortButton.disabled = options.length < 2;
    effortButton.replaceChildren(icon('effort'), element('span', '', effortNames[selected] || selected));
    effortButton.setAttribute('aria-label', '思考强度 · ' + (effortNames[selected] || selected));
    effortButton.title = effortButton.disabled
      ? p
        ? '当前模型使用默认思考强度'
        : '选择语言模型后可设置思考强度'
      : effortButton.getAttribute('aria-label');
    lockBand.replaceChildren();
    lockBand.hidden = !thread?.locks?.length;
    for (const row of thread?.locks || []) {
      const remove = button(
        '解除' + laneName(lockLane(row)) + '锁定 ' + row.name,
        'x',
        safe(async () => {
          await saveLocks(thread.locks.filter((c) => c.id !== row.id || lockLane(c) !== lockLane(row)));
          paintComposer();
        }),
        'da-lock-remove',
      );
      const chip = element('span', 'da-lock-chip');
      chip.dataset.lane = lockLane(row);
      chip.title = row.resolvedText ?? row.text;
      chip.append(
        icon('lock'),
        element('small', 'da-chip-lane', laneName(lockLane(row))),
        element('span', '', row.name),
        remove,
      );
      lockBand.append(chip);
    }
    locksButton.setAttribute(
      'aria-label',
      '锁定提示词块' + (thread?.locks?.length ? '，已选 ' + thread.locks.length + ' 个' : ''),
    );
    paintSend();
  }
  function welcomePage() {
    welcome = element('div', 'da-welcome');
    const art = element('div', 'da-letter-art');
    art.setAttribute('aria-hidden', 'true');
    const sheet = element('span', 'da-letter-sheet');
    sheet.append(flower());
    art.append(element('i', 'da-letter-shadow'), sheet);
    welcome.append(
      art,
      element('h2', '', '想画些什么？'),
      element('p', '', '描述一个画面，或先锁定你常用的画风。'),
    );
    const ideas = element('div', 'da-ideas');
    for (const [title, prompt] of [
      ['画一处场景', '画一幅雨后的街角，路面映着刚亮起的暖色橱窗。'],
      ['让两位角色同框', '画一张两位角色同框的插画，左边的人物是……，右边的人物是……'],
    ]) {
      const choose = button(
        title,
        'arrow-up-right',
        () => {
          input.value = prompt;
          resizeInput();
          input.focus();
          queueDraft();
          paintSend();
        },
        'da-idea',
        true,
      );
      ideas.append(choose);
    }
    welcome.append(ideas);
    dest.append(welcome);
  }
  function goLatest(force = false) {
    const list = dest;
    if (!list) return;
    if (force || list.scrollHeight - list.scrollTop - list.clientHeight < 90)
      requestAnimationFrame(() => {
        if (dest === list) list.scrollTop = list.scrollHeight;
      });
  }
  function paintReply(turn, scroll = true) {
    const host = replyHosts.get(turn.id);
    if (!host) return;
    const reply = host.content;
    const near = dest.scrollHeight - dest.scrollTop - dest.clientHeight < 100;
    const live = turn.state === 'pending' && activeJob?.turn.id === turn.id;
    if (turn.tools?.length) {
      if (!host.trace) {
        host.trace = createToolTrace(live, notice);
        reply.before(host.trace.root);
      }
      host.trace.update(turn.tools, live);
    }
    const opened = Boolean(reply.querySelector('.da-plan[open]'));
    reply.replaceChildren();
    if (turn.answer) reply.append(prose(turn.answer));
    if (turn.plan) reply.append(promptPlan(turn.plan, turn.locks, opened));
    const ids = Array.isArray(turn.workIds) ? turn.workIds : [];
    if (ids.length) {
      const links = element('div', 'da-work-links');
      ids.forEach((id, i) =>
        links.append(
          button(
            ids.length > 1 ? '查看成图 ' + (i + 1) : '在画布中查看成图',
            'arrow-up-right',
            safe(async () => {
              if ((await openWork(id)) === false) notice('这张成图已从作品集中移除。');
            }),
            'da-work-link',
            true,
          ),
        ),
      );
      reply.append(links);
    }
    if (turn.state === 'pending') {
      const status = element('div', 'da-step');
      if (live) status.append(element('span', 'da-pulse'));
      status.append(document.createTextNode(live ? activeJob.progress : '这次对话尚未写入最终回复。'));
      reply.append(status);
    } else if (turn.error) {
      reply.append(element('p', 'da-error', turn.error));
    } else if (turn.state === 'cancelled') {
      reply.append(element('p', 'da-step', '本次任务已停止。'));
    }
    if (turn.state !== 'pending')
      reply.append(replyFooter(turn, {
        regenerate: safe(() => submit(turn)),
        busy: Boolean(activeJob),
        earlier: () => turns.at(-1)?.id !== turn.id,
        notice,
      }));
    if (scroll && near) goLatest(true);
  }
  function addTurn(turn, replace = false) {
    const part = element('article', 'da-turn');
    const meta = element('div', 'da-user-meta');
    meta.append(element('time', '', displayTime(turn.created)), document.createTextNode('你'));
    const question = element('p', 'da-question', turn.text);
    if (turn.locks?.length) {
      question.append(lockSummary(turn.locks, 'da-question-locks'));
    }
    const reply = element('div', 'da-reply');
    const mark = element('div', 'da-byline');
    mark.append(flower(), element('strong', '', 'Folio Agent'));
    if (turn.model) {
      const model =
        turn.model +
        (turn.reasoningEffort && turn.reasoningEffort !== 'auto'
          ? ' · 思考' + (effortNames[turn.reasoningEffort] || turn.reasoningEffort)
          : '');
      const label = element('span', 'da-by-model', model);
      label.title = model;
      mark.append(label);
    }
    const content = element('div', 'da-reply-content');
    reply.append(mark, content);
    part.append(meta, question, reply);
    const previous = replace && replyHosts.get(turn.id)?.content.closest('.da-turn');
    if (previous) previous.replaceWith(part);
    else dest.append(part);
    replyHosts.set(turn.id, { content });
    paintReply(activeJob?.turn.id === turn.id ? activeJob.turn : turn, false);
  }
  function showChat() {
    if (!thread) return;
    enter('chat');
    dest = element('div', 'da-transcript');
    dest.setAttribute('role', 'region');
    dest.setAttribute('aria-label', '对话记录');
    dest.tabIndex = 0;
    body.append(dest);
    drawTranscript();
    composeMessage();
    goLatest(true);
  }
  function drawTranscript() {
    welcome = null;
    // Older messages remain in IndexedDB and can be disclosed without constructing a huge DOM tree.
    renderCutoff = Math.max(0, turns.length - 28);
    const drawHistory = () => {
      dest.replaceChildren();
      replyHosts.clear();
      if (renderCutoff > 0) {
        dest.append(
          button(
            '查看较早的消息',
            null,
            () => {
              const old = dest.scrollHeight,
                position = dest.scrollTop;
              renderCutoff = Math.max(0, renderCutoff - 28);
              drawHistory();
              dest.scrollTop = position + dest.scrollHeight - old;
            },
            'da-earlier',
          ),
        );
      }
      if (!turns.length) welcomePage();
      else turns.slice(renderCutoff).forEach(addTurn);
    };
    drawHistory();
  }
  async function submit(source) {
    if (!initialized || !thread || view !== 'chat' || !input || activeJob) return;
    if (navigating) {
      const id = thread.id;
      await navigating;
      if (thread?.id !== id || activeJob || view !== 'chat') return;
    }
    const position = source ? turns.findIndex(t => t.id === source.id) : turns.length;
    if (position < 0 || (source && source.threadId !== thread.id)) return;
    const text = source ? source.text : input.value.trim();
    if (!text) return;
    if (!active()?.model) {
      await saveDraft();
      openSettings();
      notice('先选择一个用于对话的语言模型。');
      return;
    }
    const originalThread = thread,
      provider = structuredClone(active()),
      plugins = structuredClone(config.plugins);
    const reasoningEffort = effortFor(provider, thread).selected;
    provider.reasoningEffort = reasoningEffort;
    const locks = structuredClone((source ? source.locks : thread.locks) || []);
    const branch = source && position < turns.length - 1;
    const current = branch
      ? { ...store.emptyThread(), title: threadName(thread).slice(0, 74) + ' · 分支', locks, reasoningEffort }
      : thread;
    const replacing = Boolean(source && !branch);
    const prefix = turns.slice(0, position);
    const turn = {
      id: replacing ? source.id : crypto.randomUUID(),
      created: replacing ? source.created : Date.now(),
      threadId: current.id,
      text,
      state: 'pending',
      model: provider.model,
      reasoningEffort,
      tools: [],
      locks,
      answer: '',
      workIds: [],
    };
    const history = prefix
      .filter((t) => t.state === 'done')
      .slice(-20)
      .flatMap((t) => [
        { role: 'user', content: t.text },
        { role: 'assistant', content: t.answer, ...(t.plan ? { plan: t.plan } : {}) },
      ]);
    const controller = new AbortController();
    const job = { threadId: current.id, turn, controller, progress: '正在连接模型…' };
    activeJob = job;
    if (!source) {
      clearTimeout(draftTimer);
      draftTimer = null;
      input.value = '';
      current.draft = '';
      resizeInput();
    }
    paintSend();
    try {
      try {
        if (branch) {
          await saveDraft();
          const copied = await store.startBranch(originalThread.id, current, prefix, turn);
          if (thread?.id === originalThread.id && view === 'chat') {
            input = null;
            thread = current;
            turns = copied;
            rememberThread(current.id);
            showChat();
          }
        } else if (!replacing) await store.startTurn(turn);
      } catch (error) {
        if (!source && thread?.id === current.id && input && !input.value) {
          input.value = text;
          resizeInput();
          queueDraft();
        }
        throw error;
      }
      current.title ||= Array.from(text.replace(/\s+/g, ' ')).slice(0, 32).join('');
      if (thread?.id === current.id) {
        if (replacing) turns[position] = turn;
        else turns.push(turn);
        if (view === 'chat') {
          welcome?.remove();
          welcome = null;
          const cap = header.querySelector('.da-thread-title');
          cap.textContent = current.title;
          cap.title = current.title;
          addTurn(turn, replacing);
          if (!replacing) goLatest(true);
        }
      }
      const update = (event) => {
        if (activeJob !== job || (controller.signal.aborted && event.type !== 'tool')) return;
        if (event.type === 'tool' && recordToolEvent(turn, event.tool)) {
          if (!job.checkpointQueued && !replacing) {
            job.checkpointQueued = true;
            queueMicrotask(() => {
              job.checkpointQueued = false;
              if (turn.state === 'pending') void store.checkpointTools(turn.id, turn.tools).catch(() => {});
            });
          }
        }
        if (event.type === 'status') job.progress = event.text || job.progress;
        if (event.type === 'usage') turn.usage = event.usage;
        if (event.plan) turn.plan = event.plan;
        if (event.workIds) turn.workIds = Array.from(new Set([...turn.workIds, ...event.workIds]));
        if (view === 'chat' && thread?.id === turn.threadId) paintReply(turn);
      };
      try {
        const result = await run({
          text,
          history,
          lockedChunks: turn.locks,
          provider,
          reasoningEffort,
          plugins,
          webSearchProvider: webSearchProviderFor(config),
          signal: controller.signal,
          onEvent: update,
        });
        turn.answer = result.text || '';
        turn.usage = result.usage || turn.usage;
        turn.plan = result.plan || turn.plan;
        turn.workIds = Array.from(new Set([...turn.workIds, ...(result.workIds || [])]));
        turn.state = controller.signal.aborted ? 'cancelled' : 'done';
      } catch (err) {
        turn.state = controller.signal.aborted ? 'cancelled' : 'error';
        if (turn.state === 'error') turn.error = explain(err, [provider.apiKey]);
      }
      endToolEvents(turn);
      // Keep a previous successful reply intact when a retry fails or is stopped.
      if (replacing && source.state === 'done' && turn.state !== 'done' && !turn.workIds.length) {
        if (thread?.id === current.id) notice(turn.error || '已停止重新生成，已保留原回复。');
        job.restored = true;
      } else {
        try {
          await store.finishTurn(turn);
        } catch (error) {
          job.restored = replacing && source.state === 'done';
          throw error;
        }
      }
      channel?.postMessage({ type: 'turn', id: turn.threadId });
    } finally {
      if (activeJob === job) activeJob = null;
      if (thread?.id === turn.threadId) {
        const i = turns.findIndex((t) => t.id === turn.id);
        if (i !== -1) turns[i] = job.restored ? source : turn;
        if (view === 'chat') {
          if (job.restored) addTurn(source, true);
          else paintReply(turn);
        }
      }
      if (view === 'chat') paintSend();
    }
  }
  function cancel() {
    if (!activeJob) return;
    activeJob.progress = '正在停止…';
    activeJob.controller.abort();
    paintReply(activeJob.turn);
    paintSend();
  }
  shell.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (view === 'chat') void safe(submit)();
      return;
    }
    if (e.key === 'Escape') {
      if (modelMenu) {
        e.preventDefault();
        e.stopPropagation();
        closeMenu(true);
      } else if (view !== 'chat') {
        e.preventDefault();
        e.stopPropagation();
        showChat();
        input?.focus();
      }
    }
  });
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (modelMenu && !modelMenu.contains(e.target) && !menuAnchor?.contains(e.target)) closeMenu();
    },
    { signal: lifetime.signal },
  );
  window.addEventListener(
    'pagehide',
    () => {
      void saveDraft()?.catch(() => {});
    },
    { signal: lifetime.signal },
  );
  if (channel)
    channel.onmessage = safe(async (e) => {
      if (view === 'history') {
        await openHistory();
        return;
      }
      if (e.data?.id !== thread?.id || activeJob?.threadId === thread.id) return;
      if (e.data.type === 'deleted') await selectThread(thread.id);
      if (e.data.type === 'turn' && view === 'chat') {
        const id = thread.id,
          version = selection;
        const messages = await store.getTurns(id);
        if (thread?.id === id && selection === version && view === 'chat' && !activeJob) {
          const previous = dest.scrollTop,
            near = dest.scrollHeight - previous - dest.clientHeight < 90;
          turns = messages;
          drawTranscript();
          dest.scrollTop = previous;
          if (near) goLatest(true);
        }
      }
    });
  const ready = (async () => {
    const [prefs, rows] = await Promise.all([store.getPreferences(), store.listThreads()]);
    if (prefs) config = { ...emptyConfig(), ...prefs };
    let id;
    try {
      id = sessionStorage.getItem(sessionKey);
    } catch {}
    const record = rows.find((r) => r.id === id) || rows[0] || (await store.newThread());
    await selectThread(record.id);
    initialized = true;
  })().catch((err) => {
    body.replaceChildren(element('p', 'da-issue', '无法打开本机对话记录。' + explain(err)));
  });
  return {
    activate() {
      visible = true;
      imageSettings?.refresh();
      void ready.then(() => {
        if (visible && view === 'chat') {
          resizeInput();
          goLatest(true);
        }
      });
    },
    deactivate() {
      visible = false;
      closeMenu();
      void saveDraft()?.catch((err) => notice(explain(err)));
    },
    destroy() {
      lifetime.abort();
      viewCleanup?.();
      channel?.close();
      activeJob?.controller.abort();
      clearTimeout(toastTimer);
      void saveDraft()?.catch(() => {});
      host.replaceChildren();
    },
  };
}
