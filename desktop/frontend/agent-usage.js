// Count every successful model round in a reply. Time spent searching or drawing is excluded.
export function replyUsage() {
  let inputTokens = 0, outputTokens = 0, totalTokens = 0, durationMs = 0, approximateTps = false;
  function sum(soFar, value) {
    return soFar !== null && Number.isSafeInteger(value) && value >= 0 ? soFar + value : null;
  }
  return (round) => {
    inputTokens = sum(inputTokens, round?.inputTokens);
    outputTokens = sum(outputTokens, round?.outputTokens);
    totalTokens = sum(totalTokens, round?.totalTokens);
    durationMs = Number.isFinite(round?.durationMs) && round.durationMs > 0 ? durationMs + round.durationMs : NaN;
    approximateTps ||= round?.approximateTps !== false;
    const tps = outputTokens !== null && durationMs > 0 ? outputTokens / (durationMs / 1000) : null;
    return { inputTokens, outputTokens, totalTokens, tps, approximateTps };
  };
}
