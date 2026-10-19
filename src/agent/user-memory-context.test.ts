import test from "node:test";
import assert from "node:assert/strict";
import { SofiaAgent } from "../src/agent/core.js";
import { ModelRouter } from "../src/models/router.js";
import { Reviewer } from "../src/review/reviewer.js";

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
      async find(principalId, _query, limit) {
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
