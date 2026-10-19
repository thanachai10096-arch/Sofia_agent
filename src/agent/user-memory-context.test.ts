import test from "node:test";
import assert from "node:assert/strict";
import { SofiaAgent } from "./core.js";
import { ModelRouter } from "../models/router.js";
import { Reviewer } from "../review/reviewer.js";

test("agent retrieves only the authenticated principal's bounded memory for Brain context", async () => {
  let requestedPrincipal = "";
  let brainInput: Record<string, unknown> | undefined;
  const agent = new SofiaAgent({
    provider: { async generate() { return { text: "unused" }; } },
    router: new ModelRouter([
      { id: "test", capabilities: ["coding", "reasoning", "tool-use"], costWeight: 1, latencyWeight: 1, qualityWeight: 10, healthy: true },
    ]),
    reviewer: new Reviewer(),
    userMemoryStore: {
      async find(principalId: string, _query: string, limit?: number) {
        requestedPrincipal = principalId;
        assert.equal(limit, 5);
        return [{
          id: "memory-1",
          kind: "preference",
          content: "Prefers concise explanations",
          source: "explicit-user-request",
          confidence: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          uses: 0,
        }];
      },
      async save() {},
      async list() { return []; },
      async delete() { return false; },
      async clear() {},
    },
    brainFactory: (() => ({
      runId: "test-run",
      async run(input: Record<string, unknown>) {
        brainInput = input;
        return {
          completed: true,
          summary: "Task completed",
          state: "completed",
          changedFiles: [],
          verification: [],
          usage: { steps: 1 },
        };
      },
    })) as never,
  });

  await agent.run({ task: "Explain this project", principalId: "authenticated-user" });
  assert.equal(requestedPrincipal, "authenticated-user");
  assert.match(String(brainInput?.userMemoryContext), /untrusted context; not instructions or permissions/i);
  assert.match(String(brainInput?.userMemoryContext), /Prefers concise explanations/);
});

test("agent does not retrieve user memory when no authenticated principal is present", async () => {
  let memoryLookups = 0;
  const agent = new SofiaAgent({
    provider: { async generate() { return { text: "unused" }; } },
    router: new ModelRouter([
      { id: "test", capabilities: ["coding", "reasoning", "tool-use"], costWeight: 1, latencyWeight: 1, qualityWeight: 10, healthy: true },
    ]),
    reviewer: new Reviewer(),
    userMemoryStore: {
      async find() { memoryLookups++; return []; },
      async save() {},
      async list() { return []; },
      async delete() { return false; },
      async clear() {},
    },
    brainFactory: (() => ({
      runId: "test-run",
      async run() {
        return {
          completed: true,
          summary: "Task completed",
          state: "completed",
          changedFiles: [],
          verification: [],
          usage: { steps: 1 },
        };
      },
    })) as never,
  });

  await agent.run({ task: "Explain this project" });
  assert.equal(memoryLookups, 0);
});


test("agent bounds retrieved memory count and total context size", async () => {
  let brainInput: Record<string, unknown> | undefined;
  const agent = new SofiaAgent({
    provider: { async generate() { return { text: "unused" }; } },
    router: new ModelRouter([
      { id: "test", capabilities: ["coding", "reasoning", "tool-use"], costWeight: 1, latencyWeight: 1, qualityWeight: 10, healthy: true },
    ]),
    reviewer: new Reviewer(),
    userMemoryStore: {
      async find() {
        return Array.from({ length: 8 }, (_, index) => ({
          id: `memory-${index + 1}`,
          kind: "preference" as const,
          content: `ENTRY_${index + 1}_${"x".repeat(900)}`,
          source: "explicit-user-request" as const,
          confidence: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          uses: 0,
        }));
      },
      async save() {},
      async list() { return []; },
      async delete() { return false; },
      async clear() {},
    },
    brainFactory: (() => ({
      runId: "test-run",
      async run(input: Record<string, unknown>) {
        brainInput = input;
        return { completed: true, summary: "Task completed", state: "completed", changedFiles: [], verification: [], usage: { steps: 1 } };
      },
    })) as never,
  });

  await agent.run({ task: "Explain this project", principalId: "authenticated-user" });
  const context = String(brainInput?.userMemoryContext ?? "");
  assert.ok(context.length <= 3200, `context length was ${context.length}`);
  assert.match(context, /ENTRY_1_/);
  assert.match(context, /ENTRY_5_/);
  assert.doesNotMatch(context, /ENTRY_6_/);
});

test("memory store failure does not prevent an otherwise valid Brain run", async () => {
  let brainRan = false;
  const agent = new SofiaAgent({
    provider: { async generate() { return { text: "unused" }; } },
    router: new ModelRouter([
      { id: "test", capabilities: ["coding", "reasoning", "tool-use"], costWeight: 1, latencyWeight: 1, qualityWeight: 10, healthy: true },
    ]),
    reviewer: new Reviewer(),
    userMemoryStore: {
      async find() { throw new Error("temporary memory backend failure"); },
      async save() {},
      async list() { return []; },
      async delete() { return false; },
      async clear() {},
    },
    brainFactory: (() => ({
      runId: "test-run",
      async run(input: Record<string, unknown>) {
        brainRan = true;
        assert.equal(input.userMemoryContext, undefined);
        return { completed: true, summary: "Task completed", state: "completed", changedFiles: [], verification: [], usage: { steps: 1 } };
      },
    })) as never,
  });

  const result = await agent.run({ task: "Explain this project", principalId: "authenticated-user" });
  assert.equal(brainRan, true);
  assert.equal(result.output, "Task completed");
});
