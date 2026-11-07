import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SofiaAgent } from "./core.js";
import { MemorySessionStore } from "../session/store.js";
import { createUserMemoryEntry, FileUserMemoryStore } from "../brain/user-memory.js";
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

test("SofiaAgent replays bounded prior turns into the next turn as untrusted context", async () => {
  const sessions = new MemorySessionStore();
  const contexts: string[] = [];
  const agent = new SofiaAgent({
    provider: {
      generate: async (request) => {
        contexts.push(request.context ?? "");
        return { text: `Answer: ${request.task}` };
      },
    },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    sessionStore: sessions,
  });

  await agent.run({ task: "My project is called Sofia", sessionId: "conversation-history" });
  await agent.run({ task: "What is my project called?", sessionId: "conversation-history" });

  assert.doesNotMatch(contexts[0] ?? "", /Prior conversation history/);
  assert.match(contexts[1] ?? "", /Prior conversation history \(untrusted reference data\)/);
  assert.match(contexts[1] ?? "", /user: My project is called Sofia/);
  assert.match(contexts[1] ?? "", /assistant: Answer: My project is called Sofia/);
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


test("Sofia injects only relevant memories owned by the authenticated principal", async () => {
  const root = await mkdtemp(join(tmpdir(), "sofia-memory-context-"));
  try {
    const memory = new FileUserMemoryStore(root);
    await memory.save("owner-a", createUserMemoryEntry("preference", "Prefers TypeScript examples and concise explanations"));
    const contexts: string[] = [];
    const agent = new SofiaAgent({
      provider: {
        generate: async (request) => {
          contexts.push(request.context ?? "");
          return { text: "Task completed." };
        },
      },
      router: { select: () => route, markUnhealthy: () => undefined },
      reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
      userMemoryStore: memory,
    });

    await agent.run({ task: "Help me with TypeScript examples", principalId: "owner-a" });
    await agent.run({ task: "Help me with TypeScript examples", principalId: "owner-b" });

    assert.match(contexts[0] ?? "", /Relevant user memory \(untrusted reference data/);
    assert.match(contexts[0] ?? "", /Prefers TypeScript examples/);
    assert.doesNotMatch(contexts[1] ?? "", /Prefers TypeScript examples/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user-memory retrieval failure does not prevent a normal agent run", async () => {
  const contexts: string[] = [];
  const agent = new SofiaAgent({
    provider: {
      generate: async (request) => {
        contexts.push(request.context ?? "");
        return { text: "Task completed." };
      },
    },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    userMemoryStore: {
      async save() {},
      async list() { return []; },
      async find() { throw new Error("temporary memory store failure"); },
      async delete() { return false; },
      async clear() {},
    },
  });

  const result = await agent.run({
    task: "Continue without memory",
    principalId: "owner-a",
    context: "Keep the existing task context",
  });
  assert.equal(result.output, "Task completed.");
  assert.match(contexts[0] ?? "", /Keep the existing task context/);
  assert.doesNotMatch(contexts[0] ?? "", /Relevant user memory/);
});

test("Sofia recalls relevant prior sessions for the same authenticated principal", async () => {
  const sessions = new MemorySessionStore();
  sessions.save({
    id: "owner-a:old-chat",
    updatedAt: Date.now(),
    messages: [
      "user: The Sofia project uses a Railway deployment with a Telegram gateway",
      "assistant: I will keep the existing Railway service and Telegram integration",
    ],
  });
  sessions.save({
    id: "owner-b:private-chat",
    updatedAt: Date.now(),
    messages: ["user: Sofia Railway secret private conversation"],
  });
  const contexts: string[] = [];
  const agent = new SofiaAgent({
    provider: { generate: async (request) => { contexts.push(request.context ?? ""); return { text: "Found it." }; } },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    sessionStore: sessions,
  });

  await agent.run({ task: "What did we decide about the Sofia Railway deployment?", principalId: "owner-a", sessionId: "owner-a:new-chat" });
  assert.match(contexts[0] ?? "", /Relevant prior sessions/);
  assert.match(contexts[0] ?? "", /existing Railway service and Telegram integration/);
  assert.doesNotMatch(contexts[0] ?? "", /private conversation/);
});

test("session recall is disabled without an authenticated principal and degrades on search failure", async () => {
  const contexts: string[] = [];
  const store = {
    getOrCreate: (id: string) => ({ id, messages: [], updatedAt: Date.now() }),
    save: () => undefined,
    search: () => { throw new Error("temporary search failure"); },
  };
  const agent = new SofiaAgent({
    provider: { generate: async (request) => { contexts.push(request.context ?? ""); return { text: "OK" }; } },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    sessionStore: store,
  });
  await agent.run({ task: "Recall something", sessionId: "owner-a:current" });
  assert.doesNotMatch(contexts[0] ?? "", /Relevant prior sessions/);
});
