import test from "node:test";
import assert from "node:assert/strict";
import { SofiaAgent } from "../src/agent/core.js";
import { ModelRouter } from "../src/models/router.js";
import { Reviewer } from "../src/review/reviewer.js";
import type { ModelProvider } from "../src/models/types.js";

test("agent retries after reviewer rejection and succeeds on fallback", async () => {
  let calls = 0;
  const provider: ModelProvider = {
    async generate() {
      calls++;
      return { text: calls === 1 ? "TODO: not implemented" : "Implemented and verified." };
    },
  };

  const agent = new SofiaAgent({
    provider,
    router: new ModelRouter([
      { id: "primary", capabilities: ["coding", "reasoning", "tool-use"], costWeight: 2, latencyWeight: 2, qualityWeight: 9, healthy: true },
      { id: "fallback", capabilities: ["coding", "reasoning", "tool-use"], costWeight: 3, latencyWeight: 3, qualityWeight: 8, healthy: true },
    ]),
    reviewer: new Reviewer(),
  });

  const result = await agent.run({ task: "Fix the broken TypeScript build" });
  assert.equal(result.output, "Implemented and verified.");
  assert.equal(result.steps, 2);
});
