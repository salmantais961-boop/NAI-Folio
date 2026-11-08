import { api, button, element, explain, field, icon, option } from './desktop-agent-elements.js';
import { isDeepSeekConnection, webSearchProviderFor } from './agent-web-search.js';

const protocolNames = {
  'chat-completions': 'OpenAI Chat Completions',
  responses: 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
  gemini: 'Google Gemini',
  ollama: 'Ollama',
};
function input(type, value, placeholder = '') {
  const node = element('input', 'da-input');
  node.type = type;
  node.value = value || '';
  node.placeholder = placeholder;
  node.autocomplete = 'off';
  node.spellcheck = false;
  return node;
}
function textArea(value, placeholder, rows) {
  const node = element('textarea', 'da-input da-code-input');
  node.rows = rows;
  node.value = value;
  node.placeholder = placeholder;
  node.spellcheck = false;
  return node;
}
function sectionTitle(name) {
  return element('h3', 'da-section-title', name);
}
function getPaths(text) {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

function webSearchSettings(config, draft) {
  const saved = draft ?? config.plugins?.webSearch;
  const root = element('section', 'da-web-search');
  const title = element('div', 'da-web-search-head'), status = element('small', 'da-web-search-status');
  title.append(element('strong', '', 'DeepSeek 联网检索'), status);
  const label = element('label', 'da-check'), toggle = element('input');
  toggle.type = 'checkbox';
  toggle.checked = saved?.enabled !== false;
  label.append(toggle, element('span', '', '允许 Agent 搜索和读取网页'));
  const picker = element('select');
  picker.append(option('', '自动选择已有 DeepSeek 连接'));
  const profiles = config.profiles.filter(isDeepSeekConnection);
  for (const p of profiles) picker.append(option(p.id, p.name || p.model || 'DeepSeek'));
  if (saved?.profileId && !profiles.some((p) => p.id === saved.profileId))
    picker.append(option(saved.profileId, '此前选择的连接已移除'));
  picker.value = saved?.profileId || '';
  const note = element('p', 'da-small-note');
  const read = () => ({ enabled: toggle.checked, profileId: picker.value });
  function refresh() {
    const available = Boolean(webSearchProviderFor(config, read()));
    picker.disabled = !toggle.checked || !picker.value && profiles.length < 1;
    status.textContent = toggle.checked ? (available ? '就绪' : '待配置') : '已关闭';
    note.textContent = toggle.checked && !available
      ? '在「模型连接」中添加官方 DeepSeek 连接并填入密钥，即可用于网页检索。'
      : '复用该连接的密钥。搜索和网页抓取由 DeepSeek 按调用计费。';
  }
  toggle.onchange = picker.onchange = refresh;
  refresh();
  root.append(title, label, field('检索连接', picker), note);
  return { root, read };
}

// Explicit validation is the only action in this panel which executes configured MCP servers/extensions.
export function settingsPanel(
  container,
  { getConfig, saveProfile, removeProfile, savePlugins, close, openConnection },
) {
  const page = element('div', 'da-settings');
  const tabs = element('div', 'da-tabs');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Agent 设置分类');
  const body = element('div', 'da-settings-body');
  const result = element('p', 'da-result');
  result.setAttribute('role', 'status');
  const controller = new AbortController();
  let activeRequest,
    current = 'models',
    selected = getConfig().activeId || '',
    catalog,
    readPluginDraft,
    pluginDraft,
    initVersion = 0;

  function showResult(text = '', failed = false) {
    result.textContent = text;
    result.toggleAttribute('data-error', failed);
  }
  function abortRequest() {
    activeRequest?.abort();
    activeRequest = null;
  }
  async function busy(trigger, fn, secrets) {
    abortRequest();
    const c = new AbortController();
    activeRequest = c;
    trigger.disabled = true;
    trigger.setAttribute('aria-busy', 'true');
    showResult();
    try {
      await fn(c.signal);
    } catch (err) {
      if (!c.signal.aborted) showResult(explain(err, secrets), true);
    } finally {
      trigger.disabled = false;
      trigger.removeAttribute('aria-busy');
      if (activeRequest === c) activeRequest = null;
    }
  }
  const modelTab = button('模型连接', null, () => switchTab('models'), 'da-tab');
  const plugTab = button('技能与工具', null, () => switchTab('plugins'), 'da-tab');
  tabs.append(modelTab, plugTab);
  page.append(tabs, body, result);
  container.replaceChildren(page);
  async function switchTab(value) {
    abortRequest();
    if (current === 'plugins' && readPluginDraft) {
      pluginDraft = readPluginDraft();
      readPluginDraft = null;
    }
    const version = ++initVersion;
    current = value;
    modelTab.setAttribute('aria-pressed', String(value === 'models'));
    plugTab.setAttribute('aria-pressed', String(value === 'plugins'));
    showResult();
    if (value === 'plugins') {
      pluginsPage();
      return;
    }
    body.replaceChildren();
    if (!catalog) {
      showResult('正在读取支持的接口…');
      try {
        catalog = (await api('presets', null, controller.signal)).presets;
      } catch (e) {
        if (controller.signal.aborted || version !== initVersion) return;
        showResult(explain(e), true);
        body.append(button('重新读取接口', null, () => switchTab('models'), 'da-text-button'));
        return;
      }
    }
    if (controller.signal.aborted || current !== 'models' || version !== initVersion) return;
    showResult();
    modelsPage();
  }

  function modelsPage() {
    abortRequest();
    showResult();
    body.replaceChildren();
    const config = getConfig(),
      editing = config.profiles.find((p) => p.id === selected);
    const presets = Array.isArray(catalog) ? catalog : [];
    if (!presets.length) {
      showResult('服务没有返回可用接口。', true);
      return;
    }
    if (config.profiles.length) {
      const band = element('div', 'da-profile-bar'),
        picker = element('select');
      picker.setAttribute('aria-label', '选择已有模型连接');
      for (const p of config.profiles)
        picker.append(option(p.id, (p.id === config.activeId ? '使用中 · ' : '') + (p.name || p.model)));
      if (!editing) picker.append(option('', '新连接'));
      picker.value = editing?.id || '';
      picker.onchange = () => {
        selected = picker.value;
        modelsPage();
      };
      band.append(
        picker,
        button('添加模型连接', 'plus', () => {
          selected = '';
          modelsPage();
        }),
      );
      body.append(band);
    }
    const preset = element('select'),
      protocol = element('select');
    for (const p of presets) preset.append(option(p.id, p.label));
    preset.value = presets.some((p) => p.id === editing?.preset) ? editing.preset : presets[0].id;
    for (const key of new Set(presets.map((p) => p.protocol)))
      protocol.append(option(key, protocolNames[key] || key));
    const currentPreset = () => presets.find((p) => p.id === preset.value);
    protocol.value = editing?.protocol || currentPreset().protocol;
    const name = input('text', editing?.name, '例如：日常创作');
    name.maxLength = 80;
    const address = input('text', editing?.baseUrl || currentPreset().baseUrl, 'https://…');
    address.inputMode = 'url';
    const key = input('password', editing?.apiKey, '本地服务可以留空');
    const model = input('text', editing?.model, '输入模型 ID，或从服务商拉取');
    const remember = element('input');
    remember.type = 'checkbox';
    remember.checked = Boolean(editing?.remember);
    const rememberLabel = element('label', 'da-check');
    rememberLabel.append(remember, element('span', '', '在这台设备保存此密钥'));
    const modelChoices = element('div', 'da-model-choices');
    const provider = () => ({
      id: editing?.id || '',
      name: name.value.trim() || currentPreset().label,
      preset: preset.value,
      protocol: protocol.value,
      baseUrl: address.value.trim(),
      apiKey: key.value.trim(),
      model: model.value.trim(),
      remember: remember.checked,
    });
    const end = element('div', 'da-actions');
    let fieldEpoch = 0,
      exactRoot = editing?.exactRoot === true;
    const plainTools = element('input');
    plainTools.type = 'checkbox';
    plainTools.checked = editing?.toolMode === 'text';
    const plainLabel = element('label', 'da-check');
    plainLabel.append(plainTools, element('span', '', '使用文本工具协议（兼容无函数调用的模型）'));
    const markEdited = () => {
      fieldEpoch++;
      abortRequest();
      showResult();
    };
    for (const el of [address, key, model, name]) el.addEventListener('input', markEdited);
    address.addEventListener('input', () => {
      exactRoot = false;
    });
    protocol.onchange = () => {
      exactRoot = false;
      markEdited();
    };
    preset.onchange = () => {
      markEdited();
      exactRoot = false;
      key.value = '';
      remember.checked = false;
      address.value = currentPreset().baseUrl || '';
      protocol.value = currentPreset().protocol;
      model.value = '';
      modelChoices.replaceChildren();
    };
    const normalized = async (signal) => {
      const spec = provider();
      const value = await api('normalize', { provider: { ...spec, exactRoot } }, signal);
      if (signal.aborted) throw new DOMException('', 'AbortError');
      address.value = value.baseUrl;
      exactRoot = Boolean(value.exactRoot);
      return {
        ...spec,
        baseUrl: value.baseUrl,
        protocol: value.protocol || spec.protocol,
        exactRoot,
        toolMode: plainTools.checked ? 'text' : 'auto',
      };
    };
    address.addEventListener('blur', async () => {
      if (!address.value.trim()) return;
      const epoch = fieldEpoch,
        original = address.value;
      try {
        const spec = provider();
        const value = await api(
          'normalize',
          { provider: { preset: spec.preset, protocol: spec.protocol, baseUrl: original, exactRoot } },
          controller.signal,
        );
        if (epoch === fieldEpoch && address.value === original && address.isConnected) {
          address.value = value.baseUrl;
          exactRoot = Boolean(value.exactRoot);
        }
      } catch {
        /* Save, list and test show actionable validation for an incomplete address. */
      }
    });
    const fetchModels = button(
      '拉取模型',
      'plug',
      () =>
        busy(
          fetchModels,
          async (signal) => {
            const spec = await normalized(signal);
            const { models } = await api('models', { provider: spec }, signal);
            if (signal.aborted) return;
            const list = [...new Set((models || []).filter((m) => typeof m === 'string' && m))];
            modelChoices.replaceChildren();
            if (!list.length) {
              showResult('未返回模型，可以手动填写模型 ID。');
              return;
            }
            const search = input('search', '', '筛选 ' + list.length + ' 个模型');
            search.setAttribute('aria-label', '筛选模型');
            const choices = element('select');
            choices.setAttribute('aria-label', '选择拉取到的模型');
            function filter() {
              const matched = list.filter((id) => id.toLowerCase().includes(search.value.trim().toLowerCase()));
              choices.replaceChildren(option('', matched.length ? '选一个模型' : '没有匹配的模型'));
              for (const id of matched) choices.append(option(id, id));
              choices.disabled = !matched.length;
            }
            choices.onchange = () => {
              if (choices.value) {
                model.value = choices.value;
                modelChoices.replaceChildren();
                showResult();
              }
            };
            search.oninput = filter;
            filter();
            modelChoices.append(search, choices);
            showResult('已读取 ' + list.length + ' 个模型。');
          },
          [key.value],
        ),
      'da-secondary',
      true,
    );
    const test = button(
      '检测连接',
      null,
      () =>
        busy(
          test,
          async (signal) => {
            const spec = await normalized(signal);
            if (!spec.model) throw Error('请先填写或选择要检测的模型。');
            const reply = await api('test', { provider: spec }, signal);
            if (reply.ok === false) throw Error('模型未能完成连接检测。');
            if (!signal.aborted) showResult('连接成功 · ' + (reply.model || spec.model));
          },
          [key.value],
        ),
      'da-secondary',
    );
    const save = button(
      '保存并使用',
      null,
      () =>
        busy(
          save,
          async (signal) => {
            const spec = await normalized(signal);
            if (!spec.model) throw Error('请填写或选择模型 ID。');
            await saveProfile({ ...spec, id: spec.id || crypto.randomUUID() });
            if (!signal.aborted) close();
          },
          [key.value],
        ),
      'da-primary',
    );
    end.append(save);
    if (editing) {
      let armed = false;
      const del = button(
        '删除连接',
        'trash',
        () => {
          if (armed) {
            void busy(del, async () => {
              await removeProfile(editing.id);
              selected = getConfig().activeId || '';
              modelsPage();
            }, []);
          } else {
            armed = true;
            del.lastChild.textContent = '确认删除';
            del.setAttribute('aria-label', '确认删除连接');
          }
        },
        'da-text-button',
        true,
      );
      end.append(del);
    }
    const actions = element('div', 'da-actions');
    actions.append(fetchModels, test);
    const advanced = element('details', 'da-fold'),
      detailHead = element('summary', '', '连接名称与协议');
    advanced.append(detailHead, field('连接名称', name), field('API 协议', protocol), plainLabel);
    body.append(
      field('服务商', preset),
      field('API 地址', address),
      field('API Key', key),
      rememberLabel,
      field('模型', model),
      actions,
      modelChoices,
      advanced,
      end,
    );
    const nai = button('NovelAI 生图账户', 'arrow-up-right', openConnection, 'da-account-link', true);
    body.append(nai);
  }
  function pluginsPage() {
    body.replaceChildren();
    const saved = getConfig().plugins || {};
    const webSearch = webSearchSettings(getConfig(), pluginDraft?.webSearch);
    const skills = textArea(
      pluginDraft?.skills ?? (saved.skillPaths || []).join('\n'),
      '每行一个 SKILL.md 或技能目录的完整路径',
      2,
    );
    const extensions = textArea(
      pluginDraft?.extensions ?? (saved.extensionPaths || []).join('\n'),
      '每行一个本地扩展路径',
      2,
    );
    const servers = textArea(
      pluginDraft?.servers ??
        (Object.keys(saved.mcpServers || {}).length ? JSON.stringify(saved.mcpServers, null, 2) : ''),
      '{ "服务名称": { "url": "https://…" } }',
      5,
    );
    const discovered = element('div', 'da-discovered');
    readPluginDraft = () => ({
      webSearch: webSearch.read(),
      skills: skills.value,
      extensions: extensions.value,
      servers: servers.value,
    });
    function config() {
      let parsed;
      try {
        parsed = servers.value.trim() ? JSON.parse(servers.value) : {};
      } catch {
        throw Error('MCP 配置需要是有效的 JSON，请检查逗号和引号。');
      }
      const mcpServers = parsed?.mcpServers ?? parsed;
      if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers))
        throw Error('MCP 配置应按服务名称填写。');
      return {
        webSearch: webSearch.read(),
        skillPaths: getPaths(skills.value),
        extensionPaths: getPaths(extensions.value),
        mcpServers,
      };
    }
    for (const ctrl of [skills, extensions, servers])
      ctrl.oninput = () => {
        abortRequest();
        discovered.replaceChildren();
        showResult();
      };
    const check = button(
      '读取技能与工具',
      'plug',
      () =>
        busy(
          check,
          async (signal) => {
            const {
              skills: foundSkills = [],
              tools = [],
              issues = [],
            } = await api('plugins', { plugins: config(), webSearchProvider: webSearchProviderFor(getConfig(), webSearch.read()) }, signal);
            if (signal.aborted) return;
            discovered.replaceChildren();
            for (const [label, rows] of [
              ['可用技能', foundSkills],
              ['可用工具', tools],
            ]) {
              if (!rows.length) continue;
              discovered.append(sectionTitle(label + ' · ' + rows.length));
              const list = element('ul', 'da-inventory');
              for (const row of rows) {
                const li = element('li');
                li.append(element('strong', '', row.name), element('p', '', row.description || ''));
                list.append(li);
              }
              discovered.append(list);
            }
            for (const issue of issues)
              discovered.append(
                element(
                  'p',
                  'da-issue',
                  (issue.source ? issue.source + ' · ' : '') + (issue.message || '无法加载'),
                ),
              );
            showResult(
              foundSkills.length || tools.length
                ? '已读取当前配置。'
                : issues.length
                  ? '部分配置需要检查。'
                  : '当前配置没有提供技能或工具。',
            );
          },
          [],
        ),
      'da-secondary',
      true,
    );
    const save = button(
      '保存配置',
      null,
      () =>
        busy(save, async () => {
          await savePlugins(config());
          showResult('已保存，将在下一条消息中使用。');
        }, []),
      'da-primary',
    );
    const actions = element('div', 'da-actions');
    actions.append(check, save);
    body.append(
      webSearch.root,
      field('Skills · 文件或目录', skills),
      field('Pi 工具扩展', extensions),
      field('MCP 服务 · JSON', servers),
      element('p', 'da-small-note', '本地扩展和 stdio 服务可以运行代码。只添加你信任的文件或服务。'),
      actions,
      discovered,
    );
  }
  void switchTab('models');
  return () => {
    controller.abort();
    abortRequest();
  };
}
