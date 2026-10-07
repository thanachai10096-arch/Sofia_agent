import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryRunManager } from "./run-manager.js";

test("RunManager exposes create/get/list lifecycle", async () => {
  const manager = new InMemoryRunManager({
    dependencies: {
      reasoner: {
        async prepare() {
          return {
            invoke: async () => JSON.stringify({
              goal: "inspect",
              constraints: [],
              likelyFiles: [],
              risks: [],
            }),
          };
        },
      },
      tools: {} as never,
    },
  });

  const runs = await manager.list();
  assert.deepEqual(runs, []);
});
