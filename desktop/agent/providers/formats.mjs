import { randomUUID } from 'node:crypto';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const toolId = () => 'call_' + randomUUID().replaceAll('-', '');

function call(name, args, id) {
  if (typeof name !== 'string' || !name) throw Error('模型返回了缺少名称的工具调用。');
  const rawArguments = typeof args === 'string' ? args : undefined;
  if (rawArguments !== undefined) {
    try { args = JSON.parse(args); } catch { throw Error('模型返回了不完整的工具参数，请重试。'); }
  }
  if (args == null) args = {};
  if (!record(args)) throw Error('模型的工具参数必须是 JSON 对象。');
  return { id: typeof id === 'string' && id ? id : toolId(), name, arguments: args,
    ...(rawArguments === undefined ? {} : {rawArguments}) };
}

function answer(content, toolCalls, scope, continuation) {
  const result = { role: 'assistant', content: content || '', toolCalls };
  if (continuation) result.continuation = { scope, data: continuation };
  return result;
}

function retained(message, scope) {
  return message.continuation?.scope === scope ? message.continuation.data : undefined;
}

function functions(tools) {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function openAIToolMessages(messages, scope) {
  return messages.map(m => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'user' && m.images?.length) return {
      role: 'user', content: [
        ...m.images.map(url => ({ type: 'image_url', image_url: { url } })),
        ...(m.content ? [{ type: 'text', text: m.content }] : []),
      ],
    };
    if (m.role === 'user') return { role: 'user', content: m.content };
    const out = { role: 'assistant', content: m.content || null };
    if (m.toolCalls?.length) {
      out.tool_calls = m.toolCalls.map(c => ({
        id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      }));
    }
    const reasoning = retained(m, scope);
    if (typeof reasoning?.reasoning_content === 'string') out.reasoning_content = reasoning.reasoning_content;
    if (Array.isArray(reasoning?.reasoning_details)) out.reasoning_details = reasoning.reasoning_details;
    return out;
  });
}

const chatCompletions = {
  path: () => 'chat/completions',
  build({ config, system, messages, tools, scope, maxTokens }) {
    const history = openAIToolMessages(messages, scope);
    if (system) history.unshift({ role: 'system', content: system });
    const body = { model: config.model, messages: history, stream: false };
    if (maxTokens) {
      // The official API rejects legacy max_tokens for reasoning models.
      const field = new URL(config.baseUrl).hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens';
      body[field] = maxTokens;
    }
    if (tools.length) body.tools = functions(tools).map(f => ({ type: 'function', function: f }));
    return body;
  },
  read(json, scope) {
    const m = json.choices?.[0]?.message;
    if (!record(m)) throw Error('服务没有返回 Chat Completions 消息。');
    const calls = (m.tool_calls || []).map(c => call(c.function?.name, c.function?.arguments, c.id));
    // DeepSeek and OpenRouter may require the original reasoning fields on the next tool turn.
    const reasoning = {};
    if (calls.length && typeof m.reasoning_content === 'string') reasoning.reasoning_content = m.reasoning_content;
    if (calls.length && Array.isArray(m.reasoning_details)) reasoning.reasoning_details = m.reasoning_details;
    const content = Array.isArray(m.content) ? m.content.map(p => p.text || '').join('') : m.content;
    return answer(typeof content === 'string' ? content : m.refusal, calls, scope, Object.keys(reasoning).length ? reasoning : null);
  },
};

const responses = {
  path: () => 'responses',
  build({ config, system, messages, tools, scope, maxTokens }) {
    const input = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
        continue;
      }
      const prior = retained(m, scope);
      if (m.role === 'assistant' && Array.isArray(prior)) {
        input.push(...prior);
        continue;
      }
      if (m.images?.length) input.push({ role: 'user', content: [
        ...m.images.map(url => ({ type: 'input_image', image_url: url })),
        ...(m.content ? [{ type: 'input_text', text: m.content }] : []),
      ] });
      else if (m.content) input.push({ role: m.role, content: m.content });
      for (const c of m.toolCalls || []) input.push({ type: 'function_call', name: c.name, arguments: JSON.stringify(c.arguments), call_id: c.id });
    }
    const body = { model: config.model, input, store: false, include: ['reasoning.encrypted_content'] };
    if (system) body.instructions = system;
    if (maxTokens) body.max_output_tokens = maxTokens;
    if (tools.length) body.tools = functions(tools).map(f => ({ type: 'function', ...f, strict: false }));
    return body;
  },
  read(json, scope) {
    if (json.status === 'failed' || !Array.isArray(json.output)) throw Error('服务没有返回有效的 Responses 结果。');
    const calls = [], text = [], prior = [];
    for (const item of json.output) {
      if (item.type === 'function_call') calls.push(call(item.name, item.arguments, item.call_id));
      if (item.type === 'message') {
        for (const p of item.content || []) text.push(p.text || p.refusal || '');
      }
      if (['reasoning', 'message', 'function_call'].includes(item.type)) prior.push(item);
    }
    return answer(text.join(''), calls, scope, calls.length ? prior : null);
  },
};

function appendBlocks(history, role, blocks, field) {
  const last = history.at(-1);
  if (last?.role === role) last[field].push(...blocks);
  else history.push({ role, [field]: [...blocks] });
}

const anthropic = {
  path: () => 'messages',
  build({ config, system, messages, tools, scope, maxTokens }) {
    const history = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        appendBlocks(history, 'user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }], 'content');
      } else {
        let blocks = retained(m, scope);
        if (!Array.isArray(blocks)) {
          blocks = (m.images || []).map(url => ({ type: 'image', source: {
            type: 'base64', media_type: url.slice(5, url.indexOf(';')), data: url.slice(url.indexOf(',') + 1),
          } }));
          if (m.content) blocks.push({ type: 'text', text: m.content });
          for (const c of m.toolCalls || []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
        }
        appendBlocks(history, m.role, blocks, 'content');
      }
    }
    const body = { model: config.model, max_tokens: maxTokens || 4096, messages: history };
    if (system) body.system = system;
    if (tools.length) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    return body;
  },
  read(json, scope) {
    if (!Array.isArray(json.content)) throw Error('服务没有返回 Claude 消息内容。');
    const calls = json.content.filter(p => p.type === 'tool_use').map(p => call(p.name, p.input, p.id));
    const text = json.content.filter(p => p.type === 'text').map(p => p.text).join('');
    return answer(text, calls, scope, calls.length ? json.content : null);
  },
};

const gemini = {
  path: config => 'models/' + encodeURIComponent(config.model.replace(/^models\//, '')) + ':generateContent',
  build({ system, messages, tools, scope, maxTokens }) {
    const contents = [], callNames = new Map(), nativeIds = new Set();
    for (const m of messages) {
      if (m.role === 'tool') {
        const response = { name: m.name || callNames.get(m.toolCallId), response: { result: m.content } };
        if (nativeIds.has(m.toolCallId)) response.id = m.toolCallId;
        appendBlocks(contents, 'user', [{ functionResponse: response }], 'parts');
        continue;
      }
      let parts = retained(m, scope);
      for (const c of m.toolCalls || []) callNames.set(c.id, c.name);
      if (Array.isArray(parts)) {
        for (const p of parts) if (p.functionCall?.id) nativeIds.add(p.functionCall.id);
      } else {
        parts = (m.images || []).map(url => ({ inlineData: {
          mimeType: url.slice(5, url.indexOf(';')), data: url.slice(url.indexOf(',') + 1),
        } }));
        if (m.content) parts.push({ text: m.content });
        for (const c of m.toolCalls || []) parts.push({ functionCall: { name: c.name, args: c.arguments } });
      }
      appendBlocks(contents, m.role === 'assistant' ? 'model' : 'user', parts, 'parts');
    }
    const body = { contents };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (maxTokens) body.generationConfig = { maxOutputTokens: maxTokens };
    if (tools.length) body.tools = [{ functionDeclarations: tools.map(t => ({
      name: t.name, description: t.description, parametersJsonSchema: t.parameters,
    })) }];
    return body;
  },
  read(json, scope) {
    const parts = json.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) throw Error('Gemini 没有返回可用的候选消息，请检查模型或内容限制。');
    const calls = parts.filter(p => p.functionCall).map(({ functionCall: c }) => call(c.name, c.args, c.id));
    const text = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
    return answer(text, calls, scope, parts.some(p => p.thoughtSignature) || calls.length ? parts : null);
  },
};

const ollama = {
  path: () => 'chat',
  build({ config, system, messages, tools, scope, maxTokens }) {
    const names = new Map();
    const history = messages.map(m => {
      if (m.role === 'tool') return { role: 'tool', tool_name: m.name || names.get(m.toolCallId), content: m.content };
      const out = { role: m.role, content: m.content };
      if (m.images?.length) out.images = m.images.map(url => url.slice(url.indexOf(',') + 1));
      if (m.toolCalls?.length) {
        out.tool_calls = m.toolCalls.map(c => {
          names.set(c.id, c.name);
          return { function: { name: c.name, arguments: c.arguments } };
        });
      }
      const thinking = retained(m, scope);
      if (thinking) out.thinking = thinking;
      return out;
    });
    if (system) history.unshift({ role: 'system', content: system });
    const body = { model: config.model, messages: history, stream: false };
    if (maxTokens) body.options = { num_predict: maxTokens };
    if (tools.length) body.tools = functions(tools).map(f => ({ type: 'function', function: f }));
    return body;
  },
  read(json, scope) {
    const m = json.message;
    if (!record(m)) throw Error('Ollama 没有返回对话消息。');
    const calls = (m.tool_calls || []).map(c => call(c.function?.name, c.function?.arguments, c.id));
    return answer(m.content, calls, scope, calls.length ? m.thinking : null);
  },
};

export const formats = Object.freeze({ 'chat-completions': chatCompletions, responses, anthropic, gemini, ollama });
