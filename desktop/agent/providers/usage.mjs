const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const plus = (a, b) => a === null || b === null ? null : a + b;

// Normalize only counters the provider actually returned. Some relays omit usage entirely.
export function readUsage(protocol, json, requestMs) {
  const u = json.usage || {};
  let input, output, total, generationMs;
  if (protocol === 'gemini') {
    const g = json.usageMetadata || {};
    input = plus(count(g.promptTokenCount), count(g.toolUsePromptTokenCount ?? 0));
    output = plus(count(g.candidatesTokenCount), count(g.thoughtsTokenCount ?? 0));
    total = count(g.totalTokenCount);
  } else if (protocol === 'ollama') {
    input = count(json.prompt_eval_count);
    output = count(json.eval_count);
    if (Number.isFinite(json.eval_duration) && json.eval_duration > 0) generationMs = json.eval_duration / 1e6;
  } else if (protocol === 'anthropic') {
    input = plus(plus(count(u.input_tokens), count(u.cache_creation_input_tokens ?? 0)), count(u.cache_read_input_tokens ?? 0));
    output = count(u.output_tokens);
  } else {
    input = count(u.input_tokens ?? u.prompt_tokens);
    output = count(u.output_tokens ?? u.completion_tokens);
    total = count(u.total_tokens);
  }
  total ??= plus(input, output);
  if (input === null && output === null && total === null) return null;
  return {
    inputTokens: input, outputTokens: output, totalTokens: total,
    durationMs: generationMs ?? requestMs, approximateTps: generationMs == null,
  };
}
