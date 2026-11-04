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

test("separate SofiaAgent instances append concurrent turns without losing transcript updates", async () => {
  const sessions = new MemorySessionStore();
  const createAgent = (output: string, delayMs: number) => new SofiaAgent({
    provider: {
      generate: async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { text: output };
      },
    },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    sessionStore: sessions,
  });
  const first = createAgent("first result", 20);
  const second = createAgent("second result", 1);

  await Promise.all([
    first.run({ task: "first request", sessionId: "multi-agent-session" }),
    second.run({ task: "second request", sessionId: "multi-agent-session" }),
  ]);

  const messages = sessions.get("multi-agent-session")?.messages ?? [];
  assert.ok(messages.includes("user: first request"));
  assert.ok(messages.includes("assistant: first result"));
  assert.ok(messages.includes("user: second request"));
  assert.ok(messages.includes("assistant: second result"));
  assert.equal(messages.length, 4);
});

test("SofiaAgent preserves compatibility with legacy session stores without appendMessages", async () => {
  const sessions = new Map<string, { id: string; messages: string[]; updatedAt: number }>();
  const legacyStore = {
    getOrCreate(id: string) {
      const existing = sessions.get(id);
      if (existing) return existing;
      const created = { id, messages: [], updatedAt: Date.now() };
      sessions.set(id, created);
      return created;
    },
    save(session: { id: string; messages: string[]; updatedAt: number }) {
      session.updatedAt = Date.now();
      sessions.set(session.id, session);
    },
  };
  const agent = new SofiaAgent({
    provider: { generate: async () => ({ text: "Legacy adapter works." }) },
    router: { select: () => route, markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "Output verified." }) },
    sessionStore: legacyStore,
  });

  await agent.run({ task: "legacy adapter request", sessionId: "legacy-session" });
  assert.deepEqual(sessions.get("legacy-session")?.messages, [
    "user: legacy adapter request",
    "assistant: Legacy adapter works.",
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
