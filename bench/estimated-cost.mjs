/** Explicit operator-supplied pricing only; this never queries providers or infers prices. */
export function readExplicitPricing(env) {
  const read = (name) => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === "") return null;
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(raw)) {
      throw new Error(name + " must be a non-negative decimal USD price per million tokens");
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(name + " is not a finite number");
    return value;
  };
  const inputUsdPerMillion = read("SOFIA_BENCH_INPUT_USD_PER_MILLION_TOKENS");
  const outputUsdPerMillion = read("SOFIA_BENCH_OUTPUT_USD_PER_MILLION_TOKENS");
  if ((inputUsdPerMillion === null) !== (outputUsdPerMillion === null)) {
    throw new Error("Set both SOFIA_BENCH_INPUT_USD_PER_MILLION_TOKENS and SOFIA_BENCH_OUTPUT_USD_PER_MILLION_TOKENS, or neither");
  }
  return inputUsdPerMillion === null ? null : { inputUsdPerMillion, outputUsdPerMillion };
}

/** Returns a list-price estimate only when explicit pricing and all usage exist. */
export function estimateCostUsd(rows, pricing) {
  if (!pricing || !rows.every((row) => row.usageReported &&
      Number.isSafeInteger(row.inputTokens) && row.inputTokens >= 0 &&
      Number.isSafeInteger(row.outputTokens) && row.outputTokens >= 0)) return null;
  return Number(rows.reduce((total, row) =>
    total + row.inputTokens * pricing.inputUsdPerMillion / 1_000_000
      + row.outputTokens * pricing.outputUsdPerMillion / 1_000_000, 0).toFixed(10));
}

/** Normalize common OpenAI-compatible usage fields; invalid counts remain unknown. */
export function readReportedUsage(usage) {
  const rawInputTokens = usage?.prompt_tokens ?? usage?.input_tokens;
  const rawOutputTokens = usage?.completion_tokens ?? usage?.output_tokens;
  const inputTokens = Number.isSafeInteger(rawInputTokens) && rawInputTokens >= 0 ? rawInputTokens : null;
  const outputTokens = Number.isSafeInteger(rawOutputTokens) && rawOutputTokens >= 0 ? rawOutputTokens : null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
    usageReported: inputTokens !== null && outputTokens !== null,
  };
}
