// Shared by the desktop UI and its Node sidecar. Omission always
// preserves the provider's default, including for profiles saved before this feature.
const standard = ['low', 'medium', 'high'];
const extended = [...standard, 'xhigh'];
const full = [...extended, 'max'];
const budgets = { low: 1024, medium: 4096, high: 8192, xhigh: 12288, max: 16384 };

function openaiLevels(model) {
  if (/^gpt-6(?:[.-]|$)/.test(model)) return full;
  if (/^gpt-5-pro(?:-|$)/.test(model) || /^o[13]-pro(?:-|$)/.test(model)) return ['high'];
  if (/^gpt-5\.[245]-pro(?:-|$)/.test(model)) return ['medium', 'high', 'xhigh'];
  if (/^gpt-5(?:\.\d+)?-(?:chat|instant|image|search|audio|realtime|transcribe)/.test(model)) return [];
  if (/^gpt-5\.[2-9](?:-|$)/.test(model) || /^gpt-5\.1-codex-max/.test(model)) return extended;
  if (/^(?:gpt-5(?:[.-]|$)|gpt-oss|o[134](?:-|$))/.test(model) && !/^o1-(?:mini|preview)/.test(model)) return standard;
  return [];
}

function effortControl(provider = {}) {
  const { preset = 'custom' } = provider;
  const protocol =
    provider.protocol ||
    { openai: 'responses', gemini: 'gemini', anthropic: 'anthropic', ollama: 'ollama' }[preset] ||
    'chat-completions';
  const model = String(provider.model || '')
    .toLowerCase()
    .split('/')
    .at(-1);
  if (!model) return ['none', []];
  // The same model ID can accept different wire parameters through a router.
  if (preset === 'deepseek' && /^(?:deepseek-(?:flash|v4(?:[.-]|$)))/.test(model)) {
    if (protocol === 'responses') return ['nested', ['off', 'low', 'high', 'max']];
    if (protocol === 'anthropic') return ['deepseek-messages', ['off', 'low', 'high', 'max']];
    if (protocol === 'chat-completions') return ['deepseek', ['off', 'low', 'high', 'max']];
  }
  if (protocol === 'anthropic') {
    if (/^claude-(?:opus|sonnet|haiku|fable|mythos)-5(?:-|$)|^claude-opus-4-[78]/.test(model))
      return ['adaptive', full];
    if (/^claude-(?:opus|sonnet)-4-6/.test(model) || /^claude-mythos-preview/.test(model))
      return ['adaptive', [...standard, 'max']];
    if (/^claude-(?:3-7-sonnet|(?:sonnet|opus|haiku)-4(?:-|$))/.test(model)) return ['claude-budget', standard];
    return ['none', []];
  }
  if (protocol === 'gemini') {
    if (/^gemini-3.*(?:image|tts|audio|robotics)/.test(model)) return ['none', []];
    if (/^gemini-3-pro(?:-|$)/.test(model)) return ['gemini-level', ['low', 'high']];
    if (/^gemini-3(?:[.-]|$)/.test(model)) return ['gemini-level', standard];
    if (/^gemini-2\.5-(?:flash|pro)(?:-|$)/.test(model) && !/(?:image|tts|audio|computer-use)/.test(model))
      return ['gemini-budget', model.startsWith('gemini-2.5-flash') ? ['off', ...standard] : standard];
    return ['none', []];
  }
  if (protocol === 'ollama') {
    if (/^gpt-oss(?:[:.-]|$)/.test(model)) return ['ollama', standard];
    if (/^qwen3(?:[.:-]|$)/.test(model) && !/(?:embedding|reranker|instruct|thinking|coder)/.test(model))
      return ['ollama', ['off', 'on']];
    return ['none', []];
  }
  if (!['responses', 'chat-completions'].includes(protocol)) return ['none', []];
  const canonical = protocol === 'responses' ? 'nested' : 'flat';
  if (preset === 'openrouter') {
    if (/^(?:gpt-4|gpt-3\.5|gpt-5(?:\.\d+)?-chat)/.test(model)) return ['none', []];
    return ['router', standard];
  }
  if (preset === 'xai') {
    if (/^grok-4\.[67](?:-|$)/.test(model)) return [canonical, extended];
    if (/^grok-4\.5(?:-|$)/.test(model)) return [canonical, standard];
    if (/^grok-4\.3(?:-|$)/.test(model)) return [canonical, ['off', ...standard]];
    if (/^grok-3-mini(?:-|$)/.test(model)) return [canonical, ['low', 'high']];
    return ['none', []];
  }
  if (preset === 'mistral') {
    if (/^mistral-large-4/.test(model)) return [canonical, standard];
    if (/^mistral-(?:small-2603|medium-3-5)/.test(model)) return [canonical, ['off', 'high']];
    if (/^zai-glm-5-3/.test(model)) return [canonical, ['low', 'high', 'max']];
    return ['none', []];
  }
  if (/^(qwen-cn|qwen-intl)$/.test(preset)) {
    if (/^qwen3\.8-max/.test(model)) return ['qwen-effort', ['off', 'low', 'medium', 'xhigh']];
    if (/^qwen3(?:[.-]|$)/.test(model) && !/thinking|instruct|coder|embedding|tts|omni|rerank/.test(model))
      return ['qwen-budget', ['off', ...standard]];
    return ['none', []];
  }
  if (preset === 'siliconflow') {
    if (/^(?:deepseek-v4|glm-5\.2)/.test(model)) return ['qwen-effort', ['off', 'high', 'max']];
    if (/^(?:qwen3(?:[.-]|$)|deepseek-r1)/.test(model) && !/embed|rerank|instruct|coder/.test(model))
      return ['qwen-budget', /deepseek-r1|thinking/.test(model) ? standard : ['off', ...standard]];
    return ['none', []];
  }
  if (preset === 'groq' && /^qwen/.test(model))
    return [canonical, model.includes('3.6') ? ['off', ...standard] : ['off']];
  const levels = openaiLevels(model);
  if (levels.length || /^(?:gpt-|o[134]-)/.test(model)) return [canonical, levels];
  // Deployment aliases on custom OpenAI-compatible endpoints need not contain
  // the upstream model name. Send the documented field so the gateway can validate it.
  if (preset === 'custom' || preset === 'lmstudio') return [canonical, standard];
  return ['none', []];
}

export function reasoningEfforts(provider) {
  return ['auto', ...effortControl(provider)[1]];
}

export function applyReasoningEffort(body, provider, effort) {
  if (effort == null || effort === 'auto') return;
  const [control, levels] = effortControl(provider);
  if (!levels.includes(effort)) throw Error('当前模型不支持所选思考强度，请重新选择或使用自动。');
  const apiEffort = effort === 'off' ? 'none' : effort;
  const budget = budgets[effort];
  if (control === 'router') {
    body.reasoning = { effort: apiEffort };
    body.provider = { ...body.provider, require_parameters: true };
  } else if (control === 'nested') body.reasoning = { ...body.reasoning, effort: apiEffort };
  else if (control === 'flat') body.reasoning_effort = apiEffort;
  else if (control === 'adaptive') {
    body.thinking = { type: 'adaptive' };
    body.output_config = { ...body.output_config, effort };
  } else if (control === 'claude-budget') {
    body.thinking = { type: 'enabled', budget_tokens: budget };
  } else if (control === 'gemini-level' || control === 'gemini-budget') {
    body.generationConfig ??= {};
    body.generationConfig.thinkingConfig =
      control === 'gemini-level'
        ? { thinkingLevel: effort.toUpperCase() }
        : { thinkingBudget: effort === 'off' ? 0 : budget };
  } else if (control === 'ollama') {
    body.think = effort === 'off' ? false : effort === 'on' ? true : effort;
  } else if (control === 'deepseek' || control === 'deepseek-messages') {
    body.thinking = { type: effort === 'off' ? 'disabled' : 'enabled' };
    if (effort !== 'off') {
      if (control === 'deepseek') body.reasoning_effort = effort;
      else body.output_config = { ...body.output_config, effort };
    }
  } else if (control === 'qwen-budget' || control === 'qwen-effort') {
    body.enable_thinking = effort !== 'off';
    if (control === 'qwen-effort' && effort !== 'off') body.reasoning_effort = effort;
    else if (budget) body.thinking_budget = budget;
  }
  // These APIs count thinking and visible text in one output ceiling. Reserve
  // headroom for the existing answer/tool-call budget when thinking is selected.
  if (budget && provider.preset !== 'siliconflow') {
    for (const [obj, key] of [
      [body, 'max_tokens'],
      [body, 'max_completion_tokens'],
      [body, 'max_output_tokens'],
      [body.generationConfig, 'maxOutputTokens'],
      [body.options, 'num_predict'],
    ]) {
      if (Number.isInteger(obj?.[key])) obj[key] += budget;
    }
  }
}
