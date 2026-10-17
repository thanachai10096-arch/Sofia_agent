import test from "node:test";
import assert from "node:assert/strict";
import { SofiaAgent } from "./core.js";
import { MemorySessionStore } from "../session/store.js";

const route = {
  id: "test-route",
  capabilities: ["fast" as const],
  costWeight: 1,
  latencyWeight: 1,
  qualityWeight: 1,
  healthy: true,
};

test("SofiaAgent records user and assistant turns when a session store is configured", async () => {
  const sessions = new MemorySessionStore();
  const agent = new SofiaAgent({
    provider: { generate: async () => ({ text: "Task completed." }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    sessionStore: sessions,
  });

  const result = await agent.run({ task: "Do a small task", sessionId: "conversation-1" });
  assert.equal(result.output, "Task completed.");
  assert.deepEqual(sessions.get("conversation-1")?.messages, [
    "user: Do a small task",
    "assistant: Task completed.",
  ]);
});

test("SofiaAgent does not create a session unless sessionId is provided", async () => {
  const sessions = new MemorySessionStore();
  const agent = new SofiaAgent({
    provider: { generate: async () => ({ text: "Task completed." }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    sessionStore: sessions,
  });

  await agent.run({ task: "Do not persist this turn" });
  assert.equal(sessions.get("conversation-1"), undefined);
});
