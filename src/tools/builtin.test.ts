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


test("web tools reject private destinations before making network requests", async () => {
  const tools = createBuiltinTools();
  const fetchTool = tools.find((item) => item.name === "web.fetch");
  assert.ok(fetchTool);
  await assert.rejects(
    fetchTool.execute({ url: "https://127.0.0.1/admin" }, { runtime: {} as ToolContext["runtime"] }),
    /private network/,
  );
});

test("web tools require network opt-in and an explicit host allowlist", async () => {
  const previousNetwork = process.env.SOFIA_ALLOW_NETWORK;
  const previousHosts = process.env.SOFIA_ALLOWED_HOSTS;
  try {
    process.env.SOFIA_ALLOW_NETWORK = "false";
    process.env.SOFIA_ALLOWED_HOSTS = "example.com";
    const fetchTool = createBuiltinTools().find((item) => item.name === "web.fetch");
    assert.ok(fetchTool);
    await assert.rejects(
      fetchTool.execute({ url: "https://example.com/" }, { runtime: {} as ToolContext["runtime"] }),
      /Network access is disabled/,
    );
    process.env.SOFIA_ALLOW_NETWORK = "true";
    await assert.rejects(
      fetchTool.execute({ url: "https://not-allowed.example/" }, { runtime: {} as ToolContext["runtime"] }),
      /SOFIA_ALLOWED_HOSTS/,
    );
  } finally {
    if (previousNetwork === undefined) delete process.env.SOFIA_ALLOW_NETWORK;
    else process.env.SOFIA_ALLOW_NETWORK = previousNetwork;
    if (previousHosts === undefined) delete process.env.SOFIA_ALLOWED_HOSTS;
    else process.env.SOFIA_ALLOWED_HOSTS = previousHosts;
  }
});


test("web.fetch decodes HTML entities once and strips script tags with spaced closing delimiters", async () => {
  const previousNetwork = process.env.SOFIA_ALLOW_NETWORK;
  const previousHosts = process.env.SOFIA_ALLOWED_HOSTS;
  const originalFetch = globalThis.fetch;
  try {
    process.env.SOFIA_ALLOW_NETWORK = "true";
    process.env.SOFIA_ALLOWED_HOSTS = "example.com";
    globalThis.fetch = async () => new Response(
      "<html><body>&amp;lt;safe&amp;gt;<script>alert(1)</script > visible text</body></html>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
    const fetchTool = createBuiltinTools().find((item) => item.name === "web.fetch");
    assert.ok(fetchTool);
    const result = await fetchTool.execute(
      { url: "https://example.com/" },
      { runtime: {} as ToolContext["runtime"] },
    ) as { text: string };
    assert.equal(result.text, "&lt;safe&gt; visible text");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousNetwork === undefined) delete process.env.SOFIA_ALLOW_NETWORK;
    else process.env.SOFIA_ALLOW_NETWORK = previousNetwork;
    if (previousHosts === undefined) delete process.env.SOFIA_ALLOWED_HOSTS;
    else process.env.SOFIA_ALLOWED_HOSTS = previousHosts;
  }
});
