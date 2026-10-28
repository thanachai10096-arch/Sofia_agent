import assert from "node:assert/strict";
import test from "node:test";
import { estimateCostUsd, readExplicitPricing } from "./estimated-cost.mjs";

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
