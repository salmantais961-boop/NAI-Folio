// The trace goes to IndexedDB. Strip credentials and attachments before notifying
// the UI; the original payloads remain available to the tool loop.
const limit = 24_000;
const hidden = '[已隐藏凭据]';
const secretField =
  /^(?:authorization|proxy-authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|client[-_]?secret|password|passwd|cookie|set-cookie|private[-_]?key|credentials?)$/i;

export function traceFormatter(provider, plugins, webSearchProvider) {
  const secretValues = [provider?.apiKey, webSearchProvider?.apiKey];
  for (const config of Object.values(plugins?.mcpServers || {})) {
    for (const [k, v] of Object.entries({ ...config?.headers, ...config?.env })) {
      if (typeof v === 'string' && /key|secret|token|auth|cookie|password|credential/i.test(k))
        secretValues.push(v, v.replace(/^Bearer\s+/i, ''));
    }
  }
  const secrets = [...new Set(secretValues)].filter((s) => typeof s === 'string' && s.length >= 4);
  function scrub(value) {
    let text = value
      .replace(/data:[\w+.\/-]+(?:;[^,\s]+)*;base64,[\w+/=-]+/gi, '[已省略二进制数据]')
      .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer ' + hidden)
      .replace(/([?&](?:access_token|token|api_?key|key|secret|signature|password)=)[^&\s]+/gi, '$1' + hidden)
      .replace(
        /((?:"|')?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password)(?:"|')?\s*[:=]\s*["']?)[^"'\s,;}]+/gi,
        '$1' + hidden,
      );
    for (const secret of secrets) text = text.replaceAll(secret, hidden);
    return text;
  }
  return function format(value) {
    let budget = limit,
      truncated = false;
    function walk(item, key = '', depth = 0) {
      if (secretField.test(key)) return hidden;
      if (budget <= 0 || depth > 16) {
        truncated = true;
        return '…';
      }
      budget -= 4;
      if (typeof item === 'string') {
        if (
          /^(?:data|blob|base64|b64_json|bytes|image|audio)$/i.test(key) &&
          item.length > 128 &&
          /^[\w+/=\s-]+$/.test(item)
        )
          return '[已省略二进制数据]';
        let text = scrub(item);
        if (text.length > budget) {
          text = text.slice(0, Math.max(0, budget)) + '…';
          truncated = true;
        }
        budget -= text.length;
        return text;
      }
      if (!item || typeof item !== 'object') return item;
      if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer || item instanceof Blob)
        return '[已省略二进制数据]';
      const result = Array.isArray(item) ? [] : Object.create(null);
      for (const [k, v] of Object.entries(item)) {
        if (budget <= 0) {
          truncated = true;
          break;
        }
        budget -= k.length;
        result[k] = walk(v, k, depth + 1);
      }
      return result;
    }
    const item = walk(value);
    const text = typeof item === 'string' ? item : (JSON.stringify(item, null, 2) ?? '');
    return {
      text: text.length > limit ? text.slice(0, limit) + '…' : text,
      truncated: truncated || text.length > limit,
    };
  };
}

export function traceBatch(calls, round, format, onEvent) {
  const queuedAt = Date.now();
  const rows = calls.map((call, index) => {
    const structured = call.arguments || {};
    const args = format(structured);
    // Chat Completions and Responses can supply the literal JSON string. Prefer
    // its original spacing if neither the arguments nor the raw text need redaction.
    if (
      typeof call.rawArguments === 'string' &&
      !args.truncated &&
      call.rawArguments.length <= limit &&
      args.text === JSON.stringify(structured, null, 2) &&
      !/(?:token|secret|cookie|password|authorization|api[-_]?key|credentials?|base64|b64_json)/i.test(
        call.rawArguments,
      )
    ) {
      const raw = format(call.rawArguments);
      if (!raw.truncated && raw.text === call.rawArguments) args.text = raw.text;
    }
    return {
      id: round + '-' + (index + 1),
      name: call.name,
      round,
      index: index + 1,
      state: 'queued',
      queuedAt,
      argumentsText: args.text,
      argumentsTruncated: args.truncated,
    };
  });
  const publish = (row) => onEvent({ type: 'tool', tool: { ...row } });
  rows.forEach(publish);
  function finish(index, state, result) {
    const row = rows[index];
    row.state = state;
    row.endedAt = Date.now();
    if (result !== undefined) {
      const value = format(result);
      row.resultText = value.text;
      row.resultTruncated = value.truncated;
    }
    publish(row);
  }
  return {
    start(index) {
      const row = rows[index];
      row.startedAt = Date.now();
      row.state = 'running';
      publish(row);
    },
    finish,
    close(error, aborted) {
      rows.forEach((row, i) => {
        if (row.state === 'running')
          finish(i, aborted ? 'cancelled' : 'error', {
            error: aborted ? '已取消' : error?.message || '工具未完成',
          });
        else if (row.state === 'queued') finish(i, aborted ? 'cancelled' : 'skipped');
      });
    },
  };
}
