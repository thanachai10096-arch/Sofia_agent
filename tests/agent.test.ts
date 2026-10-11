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


test("security kill switch aborts active model calls and blocks new runs", async () => {
  const { SecurityController } = await import("../src/security/controller.js");
  const securityController = new SecurityController();
  let markStarted!: () => void;
  let markAborted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
  const provider: ModelProvider = {
    generate(_request, _route, options) {
      const signal = options?.signal;
      assert.ok(signal, "agent must bind the security controller to the provider signal");
      markStarted();
      return new Promise((_, reject) => {
        const onAbort = () => {
          markAborted();
          reject(signal.reason ?? new Error("aborted"));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
  const agent = new SofiaAgent({
    provider,
    router: new ModelRouter([
      { id: "test", capabilities: ["coding", "reasoning", "tool-use"], costWeight: 1, latencyWeight: 1, qualityWeight: 10, healthy: true },
    ]),
    reviewer: new Reviewer(),
    securityController,
  });

  const pending = agent.run({ task: "wait for cancellation" });
  await started;
  securityController.kill("operator emergency stop");
  await aborted;
  await assert.rejects(pending, /operator emergency stop|aborted/i);
  await assert.rejects(agent.run({ task: "must not start" }), /kill switch is active/);
});
