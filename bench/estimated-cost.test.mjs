import assert from "node:assert/strict";
import test from "node:test";
import { estimateCostUsd, readExplicitPricing, readReportedUsage } from "./estimated-cost.mjs";

test("calculates estimated list-price cost only from explicit prices and complete usage", () => {
  const pricing = readExplicitPricing({
    SOFIA_BENCH_INPUT_USD_PER_MILLION_TOKENS: "2.5",
    SOFIA_BENCH_OUTPUT_USD_PER_MILLION_TOKENS: "10",
  });
  assert.deepEqual(pricing, { inputUsdPerMillion: 2.5, outputUsdPerMillion: 10 });
  assert.equal(estimateCostUsd([{ inputTokens: 2000, outputTokens: 500, usageReported: true }], pricing), 0.01);
});

test("does not estimate cost when prices or provider usage are missing", () => {
  assert.equal(readExplicitPricing({}), null);
  assert.equal(estimateCostUsd([{ inputTokens: 10, outputTokens: 2, usageReported: true }], null), null);
  const pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
  assert.equal(estimateCostUsd([{ inputTokens: 10, outputTokens: null, usageReported: false }], pricing), null);
});

test("requires both explicit prices and rejects invalid values", () => {
  assert.throws(() => readExplicitPricing({ SOFIA_BENCH_INPUT_USD_PER_MILLION_TOKENS: "1" }), /Set both/);
  assert.throws(() => readExplicitPricing({
    SOFIA_BENCH_INPUT_USD_PER_MILLION_TOKENS: "-1",
    SOFIA_BENCH_OUTPUT_USD_PER_MILLION_TOKENS: "2",
  }), /non-negative decimal/);
});

test("accepts non-negative safe provider usage and treats invalid counts as unknown", () => {
  assert.deepEqual(readReportedUsage({ prompt_tokens: 12, completion_tokens: 4 }), {
    inputTokens: 12, outputTokens: 4, totalTokens: 16, usageReported: true,
  });
  assert.deepEqual(readReportedUsage({ input_tokens: 0, output_tokens: 0 }), {
    inputTokens: 0, outputTokens: 0, totalTokens: 0, usageReported: true,
  });
  for (const usage of [
    { prompt_tokens: -1, completion_tokens: 2 },
    { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 2 },
    { prompt_tokens: 1 },
    null,
  ]) {
    assert.equal(readReportedUsage(usage).usageReported, false);
    assert.equal(readReportedUsage(usage).totalTokens, null);
  }
});
