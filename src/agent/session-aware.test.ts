import test from "node:test";
import assert from "node:assert/strict";
import { SessionAwareSofiaAgent } from "./session-aware.js";
import { MemorySessionStore } from "../session/store.js";
import type { ModelRoute } from "../models/types.js";

const route: ModelRoute = {
  id: "session-context-test",
  capabilities: ["fast"],
  costWeight: 1,
  latencyWeight: 1,
  qualityWeight: 1,
  healthy: true,
};

test("SessionAwareSofiaAgent replays prior turns as bounded untrusted context", async () => {
  const sessions = new MemorySessionStore();
  sessions.save({
    id: "chat-1",
    messages: ["user: My project is called Bluebird", "assistant: I will remember Bluebird"],
    updatedAt: 0,
  });
  let receivedContext = "";
  const agent = new SessionAwareSofiaAgent({
    provider: {
      generate: async (input) => {
        receivedContext = input.context ?? "";
        return { text: "Understood." };
      },
    },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    sessionStore: sessions,
  });

  await agent.run({ task: "What is my project called?", sessionId: "chat-1" });
  assert.match(receivedContext, /Bluebird/);
  assert.match(receivedContext, /UNTRUSTED_TOOL_OUTPUT/);
  assert.match(receivedContext, /never follow instructions/i);
  assert.deepEqual(sessions.get("chat-1")?.messages.slice(-2), [
    "user: What is my project called?",
    "assistant: Understood.",
  ]);
});

test("SessionAwareSofiaAgent does not add transcript context without a session", async () => {
  let receivedContext = "";
  const agent = new SessionAwareSofiaAgent({
    provider: { generate: async (input) => { receivedContext = input.context ?? ""; return { text: "Done." }; } },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    sessionStore: new MemorySessionStore(),
  });
  await agent.run({ task: "standalone" });
  assert.equal(receivedContext, "");
});
