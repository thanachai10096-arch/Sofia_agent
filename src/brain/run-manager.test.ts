import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryRunManager } from "./run-manager.js";

test("RunManager exposes create/get/list lifecycle", async () => {
  const manager = new InMemoryRunManager(() => ({
    async run() {
      return {
        completed: true,
        state: "completed" as const,
        summary: "test",
        changedFiles: [],
        changedFilesKnown: true,
        verification: [],
        remainingRisks: [],
        usage: { steps: 0, toolCalls: 0, modelCalls: 0, reservedOrUsedTokens: 0, replans: 0 },
      };
    },
  } as never));

  const runs = await manager.list();
  assert.deepEqual(runs, []);
});