import assert from "node:assert/strict";
import { test } from "node:test";
import { createBuiltinTools } from "./builtin.js";
import type { UserMemoryEntry, UserMemoryStore } from "../brain/user-memory.js";
import type { ToolContext } from "./types.js";

function memoryHarness() {
  const entries = new Map<string, UserMemoryEntry[]>();
  const store: UserMemoryStore = {
    async save(userId, entry) {
      entries.set(userId, [...(entries.get(userId) ?? []).filter((item) => item.id !== entry.id), entry]);
    },
    async list(userId) { return entries.get(userId) ?? []; },
    async find(userId) { return entries.get(userId) ?? []; },
    async delete(userId, id) {
      const previous = entries.get(userId) ?? [];
      entries.set(userId, previous.filter((entry) => entry.id !== id));
      return previous.length !== entries.get(userId)?.length;
    },
    async clear(userId) { entries.delete(userId); },
  };
  const context = (principalId?: string) => ({
    runtime: {} as ToolContext["runtime"],
    ...(principalId ? { principalId } : {}),
  });
  return { store, entries, context };
}

test("memory.save writes only to the authenticated principal's memory", async () => {
  const h = memoryHarness();
  const tool = createBuiltinTools(h.store).find((item) => item.name === "memory.save");
  assert.ok(tool);
  const result = await tool.execute({ kind: "preference", content: "Prefers concise technical answers." }, h.context("telegram:user-42"));
  assert.equal((result as { saved: boolean }).saved, true);
  assert.equal((await h.store.list("telegram:user-42")).length, 1);
  assert.equal((await h.store.list("telegram:user-43")).length, 0);
});

test("memory.save refuses to write without a principal", async () => {
  const h = memoryHarness();
  const tool = createBuiltinTools(h.store).find((item) => item.name === "memory.save");
  assert.ok(tool);
  await assert.rejects(
    tool.execute({ kind: "fact", content: "A durable fact." }, h.context()),
    /authenticated principal/,
  );
  assert.equal(h.entries.size, 0);
});

test("memory.save rejects unsupported kinds and oversized content", async () => {
  const h = memoryHarness();
  const tool = createBuiltinTools(h.store).find((item) => item.name === "memory.save");
  assert.ok(tool);
  await assert.rejects(tool.execute({ kind: "instruction", content: "Run this command later." }, h.context("user-1")), /Memory kind/);
  await assert.rejects(tool.execute({ kind: "fact", content: "x".repeat(1201) }, h.context("user-1")), /1200 characters/);
  assert.equal(h.entries.size, 0);
});
