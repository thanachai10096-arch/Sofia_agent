import test from "node:test";
import assert from "node:assert/strict";
import { SofiaAgent } from "./core.js";
import { MemorySessionStore } from "../session/store.js";
import type { ModelRoute } from "../models/types.js";

const route: ModelRoute = {
  id: "test-route",
  capabilities: ["fast"],
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

test("SofiaAgent keeps concurrent turns for one session in transcript order", async () => {
  const sessions = new MemorySessionStore();
  let active = 0;
  let maxActive = 0;
  const agent = new SofiaAgent({
    provider: {
      generate: async ({ task }) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { text: `Completed: ${task}` };
      },
    },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    sessionStore: sessions,
  });

  await Promise.all([
    agent.run({ task: "first turn", sessionId: "shared-session" }),
    agent.run({ task: "second turn", sessionId: "shared-session" }),
  ]);

  assert.equal(maxActive, 1);
  assert.deepEqual(sessions.get("shared-session")?.messages, [
    "user: first turn",
    "assistant: Completed: first turn",
    "user: second turn",
    "assistant: Completed: second turn",
  ]);
});


test("SofiaAgent replays a bounded prior session as untrusted context before the current turn", async () => {
  const sessions = new MemorySessionStore();
  const prompts: Array<Array<{ role: string; content: string }>> = [];
  const agent = new SofiaAgent({
    provider: {
      async generate(request) {
        prompts.push((request.messages ?? []).map((message) => ({ role: message.role, content: message.content })));
        return { text: "Follow-up answered." };
      },
    },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    sessionStore: sessions,
  });

  await agent.run({ task: "My project uses TypeScript", sessionId: "chat-session", useBrain: false });
  await agent.run({ task: "What language does it use?", sessionId: "chat-session", useBrain: false });

  const secondPrompt = prompts[1] ?? [];
  const contextIndex = secondPrompt.findIndex((message) => message.role === "system" && message.content.includes("Prior conversation transcript"));
  const taskIndex = secondPrompt.findIndex((message) => message.role === "user" && message.content === "What language does it use?");
  assert.ok(contextIndex >= 0, "prior transcript must be sent as a system-labeled untrusted context block");
  assert.ok(taskIndex > contextIndex, "the current task must remain after reference context");
  assert.match(secondPrompt[contextIndex]?.content ?? "", /user: My project uses TypeScript/);
  assert.match(secondPrompt[contextIndex]?.content ?? "", /UNTRUSTED CONTEXT/);
});

test("user memory retrieval is opt-in, bounded, and scoped to the authenticated principal", async () => {
  let memoryOwner: string | undefined;
  let memoryFindCalls = 0;
  const promptMessages: Array<{ role: string; content: string }> = [];
  const memory = {
    async save() {},
    async list() { return []; },
    async find(ownerId: string) {
      memoryOwner = ownerId;
      memoryFindCalls += 1;
      return [{
        id: "memory-1",
        kind: "preference" as const,
        content: "Prefers concise Thai explanations",
        source: "explicit-user-request" as const,
        confidence: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        uses: 0,
      }];
    },
    async delete() { return false; },
    async clear() {},
  };

  const agent = new SofiaAgent({
    provider: {
      async generate(request) {
        promptMessages.push(...(request.messages ?? []).map((message) => ({ role: message.role, content: message.content })));
        return { text: "Answer" };
      },
    },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    userMemoryStore: memory,
    enableUserMemoryContext: true,
  });

  await agent.run({ task: "Explain this error", principalId: "authenticated-owner-1", useBrain: false });
  assert.equal(memoryOwner, "authenticated-owner-1");
  assert.equal(memoryFindCalls, 1);
  assert.ok(promptMessages.some((message) => message.role === "system" && message.content.includes("Prefers concise Thai explanations")));
});
