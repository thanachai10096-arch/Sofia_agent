import assert from "node:assert/strict";
import test from "node:test";
import { createInternalRoute, estimatePromptTokensUpperBound } from "./model-route-adapter.js";
import type { ModelProvider, ModelRoute } from "../models/types.js";

test("route context estimate does not count UTF-8 bytes as tokens for Thai", () => {
  const value = { task: "สวัสดี" };
  const estimate = estimatePromptTokensUpperBound(value);
  const serialized = JSON.stringify(value);
  const characters = Array.from(serialized);
  const nonAscii = characters.filter((character) => character.codePointAt(0)! > 0x7f).length;
  const ascii = characters.length - nonAscii;
  assert.equal(estimate, Math.ceil(ascii / 3) + nonAscii);
  assert.ok(estimate < new TextEncoder().encode(serialized).byteLength);
});

test("route context estimate remains bounded for long mixed-language prompts", () => {
  const value = { task: "ช่วยตรวจระบบ Sofia Agent " + "ภาษาไทย English ".repeat(500) };
  const estimate = estimatePromptTokensUpperBound(value);
  assert.ok(Number.isSafeInteger(estimate));
  assert.ok(estimate > 1_000);
  assert.ok(estimate < 20_000);
});

test("internal route admits Thai prompt by estimated tokens rather than UTF-8 bytes", () => {
  const modelRoute: ModelRoute = {
    id: "test-route",
    capabilities: ["reasoning", "long-context"],
    costWeight: 1,
    latencyWeight: 1,
    qualityWeight: 1,
    healthy: true,
  };
  const provider = {
    async generate() {
      return { text: "{}", usage: { inputTokens: 10, outputTokens: 1 } };
    },
  } as unknown as ModelProvider;
  const internal = createInternalRoute({ modelProvider: provider, route: modelRoute });
  const prompt = {
    core: {
      instructions: "ตอบเป็น JSON เท่านั้น",
      task: "สวัสดี ช่วยตอบคำถามนี้",
      acceptanceCriteria: [],
      state: { phase: "understand" },
      toolSchemas: [],
    },
    evidence: [],
  };
  const prepared = internal.prepare(prompt);
  assert.ok(prepared.inputTokensUpperBound > 0);
  assert.ok(prepared.inputTokensUpperBound < new TextEncoder().encode(JSON.stringify({
    task: prompt.core.task,
    kind: "analysis",
    step: 1,
    context: JSON.stringify({
      phase: "understand",
      instructions: prompt.core.instructions,
      acceptanceCriteria: [],
      state: prompt.core.state,
      evidence: [],
    }),
    tools: [],
  })).byteLength);
});
