import { normalizeProfile, profileHeaders, readProfiles, writeProfiles } from './account-profiles.js';
import { api, element, explain, option } from './desktop-agent-elements.js';
import { getPreferences, saveSetupProfile } from './desktop-agent-store.js';

export async function hasFirstRunConnections() {
  try {
    if (readProfiles().profiles.length) return true;
    if ((await indexedDB.databases()).some((db) => db.name === 'folio-desktop-agent')) {
      if ((await getPreferences())?.profiles?.length) return true;
    }
  } catch { return true; }
  try {
    const status = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(2200) });
    return status.ok && (await status.json()).configured === true;
  } catch { return false; }
}

function input(type, hint = '') {
  const node = element('input', 'ffr-input');
  node.type = type;
  node.autocomplete = 'off';
  node.autocapitalize = 'off';
  node.spellcheck = false;
  node.placeholder = hint;
  return node;
}
function field(label, control) {
  const wrap = element('label', 'ffr-field');
  control.setAttribute('aria-label', label);
  wrap.append(element('span', 'ffr-field-label', label), control);
  return wrap;
}
function action(label, className = 'ffr-utility') {
  const node = element('button', className, label);
  node.type = 'button';
  return node;
}
function note(message) { return element('p', 'ffr-hint', message); }
function fail(control, message) {
  control.focus();
  throw Error(message);
}

export function makeFirstRunFields() {
  const initial = readProfiles();
  let savedNai = initial.profiles.find((p) => p.id === initial.activeId);
  const nai = { id: crypto.randomUUID(), provider: savedNai?.provider || 'official', address: savedNai?.imageBase || '', key: '' };
  const llm = { id: crypto.randomUUID(), preset: 'deepseek', address: '', key: '', model: '' };
  let presets, step;
  function mountStep(kind, host) {
    step?.destroy();
    const lifecycle = new AbortController();
    const signal = lifecycle.signal;
    const status = element('p', 'ffr-status');
    status.setAttribute('role', 'status');
    status.hidden = true;
    let lookup, dispose = () => {};
    function cancelLookup() {
      lookup?.abort();
      lookup = null;
      status.hidden = true;
      status.textContent = '';
    }
    function runLookup(btn, message, fn) {
      cancelLookup();
      const controller = new AbortController();
      lookup = controller;
      btn.disabled = true;
      status.textContent = message;
      status.hidden = false;
      fn(AbortSignal.any([signal, controller.signal])).then((result) => {
        if (lookup === controller && !signal.aborted) status.textContent = result;
      }).catch((e) => {
        if (lookup === controller && !signal.aborted) status.textContent = explain(e, [nai.key, llm.key]);
      }).finally(() => {
        if (lookup === controller) lookup = null;
        btn.disabled = false;
      });
    }
    function destroy() {
      lifecycle.abort();
      cancelLookup();
      dispose();
    }
    const key = input('password', '粘贴 API Key');
    key.classList.add('ffr-key');
    const keyField = field('API Key', key);
    host.replaceChildren();
    if (kind === 'nai') {
      const modes = element('div', 'ffr-modes');
      modes.setAttribute('role', 'group');
      modes.setAttribute('aria-label', 'NovelAI 连接方式');
      const official = action('官方 API', 'ffr-mode'), relay = action('中转站', 'ffr-mode');
      modes.append(official, relay);
      const address = input('text', 'https://…');
      address.inputMode = 'url';
      const addressField = field('中转站地址', address);
      const probe = action('检测连接'), tools = element('div', 'ffr-tools');
      tools.append(probe);
      host.append(modes, addressField, keyField, tools, status, note('密钥保存在这台电脑。检测连接只查询账户状态。'));
      const sameDestination = () => savedNai?.provider === nai.provider &&
        (nai.provider === 'official' || address.value.trim() === savedNai.imageBase);
      function refreshHint() {
        key.placeholder = sameDestination() ? '已保存，留空沿用当前密钥' : '粘贴 API Key';
        key.setAttribute('aria-required', String(!sameDestination()));
      }
      function applyMode(mode) {
        if (mode !== nai.provider) {
          nai.key = '';
          cancelLookup();
        }
        nai.provider = mode;
        official.setAttribute('aria-pressed', String(mode === 'official'));
        relay.setAttribute('aria-pressed', String(mode === 'relay'));
        addressField.hidden = mode !== 'relay';
        address.disabled = addressField.hidden;
        address.value = nai.address;
        key.value = nai.key;
        refreshHint();
      }
      function draft() {
        if (nai.provider === 'relay' && !address.value.trim()) fail(address, '请填写中转站提供的 NAI API 地址。');
        const token = key.value.trim() || (sameDestination() ? savedNai.token : '');
        if (!token) fail(key, '请填写当前连接的 API Key。');
        return normalizeProfile({ id: nai.id, provider: nai.provider, token, imageBase: address.value,
          accountBase: sameDestination() ? savedNai.accountBase : '', name: sameDestination() ? savedNai.name : '' });
      }
      official.onclick = () => applyMode('official');
      relay.onclick = () => applyMode('relay');
      applyMode(nai.provider);
      address.oninput = () => {
        if (nai.key) { nai.key = ''; key.value = ''; }
        nai.address = address.value;
        refreshHint();
        cancelLookup();
      };
      key.oninput = () => { nai.key = key.value; cancelLookup(); };
      probe.onclick = () => runLookup(probe, '正在查询账户…', async (requestSignal) => {
        const profile = draft();
        const response = await fetch('/api/account', {headers: profileHeaders(profile), cache: 'no-store', signal: requestSignal});
        const info = await response.json().catch(() => ({}));
        if (!response.ok || typeof info.active !== 'boolean') throw Error(info.error || '账户验证失败，请检查地址与密钥。');
        return info.accountAvailable === false ? '该中转站不提供账户查询，首次生图时会验证密钥。' : '账户连接成功。';
      });
      dispose = () => { key.value = ''; };
      step = { destroy, async submit() {
        signal.throwIfAborted();
        const profile = draft();
        const save = () => {
          signal.throwIfAborted();
          const saved = readProfiles().profiles;
          const same = saved.find((p) => p.provider === profile.provider && p.imageBase === profile.imageBase &&
            p.accountBase === profile.accountBase && p.token === profile.token);
          if (same) {
            writeProfiles(saved, same.id);
            savedNai = same;
          } else {
            const next = saved.filter((p) => p.id !== profile.id);
            writeProfiles([...next, profile], profile.id);
            savedNai = profile;
          }
          nai.key = '';
        };
        if (navigator.locks) await navigator.locks.request('folio.setup.nai', {signal}, save);
        else save();
      } };
    } else {
      const service = element('select', 'ffr-select'), model = input('text', '填写或拉取模型 ID');
      const address = input('text', 'https://…');
      address.inputMode = 'url';
      const addressField = field('API 地址', address);
      const row = element('div', 'ffr-row');
      row.append(field('服务商', service), field('模型 ID', model));
      const tools = element('div', 'ffr-tools'), pull = action('拉取模型');
      const choices = element('select', 'ffr-select'), choiceField = field('已拉取的模型', choices);
      tools.append(pull);
      choiceField.hidden = addressField.hidden = true;
      key.value = llm.key;
      model.value = llm.model;
      service.disabled = true;
      service.append(option('', '读取连接方式…'));
      host.append(row, addressField, keyField, tools, choiceField, status, note('密钥保存在这台电脑。模型 ID 可手动填写，也可从服务商拉取。'));
      const current = () => presets?.find((p) => p.id === llm.preset);
      function update() {
        const choice = current();
        const editableAddress = ['custom', 'lmstudio', 'ollama'].includes(llm.preset);
        address.value = llm.address || choice.baseUrl;
        addressField.hidden = !editableAddress;
        address.disabled = !editableAddress;
        key.placeholder = choice.needsKey ? '粘贴 API Key' : '按服务商要求填写，可留空';
        key.setAttribute('aria-required', String(choice.needsKey));
      }
      // A slow reply from a previous step must never resurrect an old form.
      const load = async () => {
        if (!presets) {
          const response = await api('presets', null, signal);
          signal.throwIfAborted();
          if (!Array.isArray(response.presets) || !response.presets.length) throw Error('没有读取到可用的模型服务商。');
          presets = response.presets;
        }
        if (!current()) llm.preset = presets[0].id;
        service.replaceChildren(...presets.map((p) => option(p.id, p.label)));
        service.value = llm.preset;
        service.disabled = false;
        update();
      };
      const loading = load().catch((e) => {
        if (!signal.aborted) {
          status.textContent = explain(e); status.hidden = false;
        }
      });
      service.onchange = () => {
        cancelLookup();
        llm.preset = service.value;
        llm.key = llm.address = llm.model = key.value = model.value = '';
        choices.replaceChildren(); choiceField.hidden = true;
        update();
      };
      key.oninput = () => { llm.key = key.value; cancelLookup(); choiceField.hidden = true; };
      model.oninput = () => { llm.model = model.value; };
      address.oninput = () => {
        llm.address = address.value;
        llm.key = key.value = '';
        cancelLookup();
        choiceField.hidden = true;
      };
      choices.onchange = () => { if (choices.value) llm.model = model.value = choices.value; };
      async function normalized(signal, requireModel) {
        await loading;
        signal.throwIfAborted();
        if (!current()) await load();
        const preset = current();
        if (!preset) throw Error('模型服务尚未就绪，请返回后重试。');
        if (!address.value.trim()) fail(address, '请填写模型接口的地址。');
        if (preset.needsKey && !key.value.trim()) fail(key, '请填写服务商的 API Key。');
        if (requireModel && !model.value.trim()) fail(model, '请填写或选择模型 ID。');
        const profile = { id: llm.id, name: preset.label, preset: preset.id, protocol: preset.protocol,
          baseUrl: address.value.trim(), model: model.value.trim(), apiKey: key.value.trim(), remember: true };
        const checked = await api('normalize', {provider: profile}, signal);
        signal.throwIfAborted();
        return { ...profile, baseUrl: checked.baseUrl, protocol: checked.protocol, exactRoot: checked.exactRoot };
      }
      pull.onclick = () => runLookup(pull, '正在读取模型列表…', async (requestSignal) => {
        const profile = await normalized(requestSignal, false);
        const {models} = await api('models', {provider: profile}, requestSignal);
        requestSignal.throwIfAborted();
        const ids = [...new Set((models || []).filter((id) => typeof id === 'string' && id))];
        if (!ids.length) throw Error('服务商未返回模型，可手动填写模型 ID。');
        choices.replaceChildren(option('', '选择模型'), ...ids.map((id) => option(id, id)));
        choiceField.hidden = false;
        if (ids.includes(model.value)) choices.value = model.value;
        else if (ids.length === 1 && !model.value.trim()) llm.model = model.value = choices.value = ids[0];
        return '已读取 ' + ids.length + ' 个模型。';
      });
      dispose = () => { key.value = ''; };
      step = { destroy, async submit() {
        const profile = await normalized(signal, true);
        await saveSetupProfile(profile);
      } };
    }
    return step;
  }
  return { mountStep, destroy() {
    step?.destroy();
    step = null;
    savedNai = null;
    nai.key = llm.key = '';
  } };
}
