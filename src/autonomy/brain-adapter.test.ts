import assert from "node:assert/strict";
import test from "node:test";
import { createBrainAutonomyAuthorizer } from "./brain-adapter.js";
import { defaultAutonomyProfile } from "./controller.js";

const request = {
  runId: "run-1",
  principalId: "tenant-1",
  toolCall: { tool: "workspace.write_file", input: { path: "notes.txt", content: "hello" } },
  effects: ["write"],
} as const;

test("Brain adapter requires an explicit host-owned tool classification", async () => {
  let contextCalls = 0;
  const authorize = createBrainAutonomyAuthorizer({
    classifyTool: () => undefined,
    getTrustedContext: async () => { contextCalls += 1; return {}; },
  });
  const decision = await authorize(request);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /no explicit host-owned autonomy classification/i);
  assert.equal(contextCalls, 0);
});

test("Brain adapter does not infer sandbox isolation from write effects", async () => {
  const authorize = createBrainAutonomyAuthorizer({
    classifyTool: () => "edit_sandbox",
    getTrustedContext: async () => ({
      sandboxAvailable: false,
      remainingCycles: 8,
      remainingSteps: 40,
      remainingToolCalls: 8,
      experimentSeconds: 300,
      estimatedSpendUsd: 0,
    }),
  });
  const decision = await authorize(request);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /isolated sandbox is required/i);
});

test("Brain adapter permits cognitive actions without granting tool effects", async () => {
  const authorize = createBrainAutonomyAuthorizer({
    classifyTool: () => "research_local",
    getTrustedContext: async () => ({}),
  });
  assert.equal((await authorize(request)).allowed, true);
});

test("Brain adapter keeps production and secret actions approval-gated", async () => {
  for (const action of ["deploy_production", "external_side_effect", "read_secret"] as const) {
    const authorize = createBrainAutonomyAuthorizer({
      profile: { ...defaultAutonomyProfile, networkResearch: true },
      classifyTool: () => action,
      getTrustedContext: async () => ({
        sandboxAvailable: true,
        networkAllowedByExecutionPolicy: true,
        remainingCycles: 8,
        remainingSteps: 40,
        remainingToolCalls: 8,
        experimentSeconds: 300,
        estimatedSpendUsd: 0,
      }),
    });
    const decision = await authorize(request);
    assert.equal(decision.allowed, false, action);
    assert.match(decision.reason, /explicit human approval/i);
  }
});

test("Brain adapter fails closed when trusted context provider throws", async () => {
  const authorize = createBrainAutonomyAuthorizer({
    classifyTool: () => "edit_sandbox",
    getTrustedContext: async () => { throw new Error("unavailable"); },
  });
  const decision = await authorize(request);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /trusted runtime context is unavailable/i);
});
