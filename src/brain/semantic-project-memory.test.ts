import test from "node:test";
import assert from "node:assert/strict";
import type { ProjectMemoryEntry, ProjectMemoryStore } from "./project-memory.js";
import { SemanticProjectMemorySearch } from "./semantic-project-memory.js";

function entry(id: string, content: string): ProjectMemoryEntry {
  return {
    id, project: "demo", kind: "convention", content, confidence: 0.9,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    uses: 0,
  };
}
function makeStore(entries: ProjectMemoryEntry[]): ProjectMemoryStore {
  return {
    async save() {},
    async list() { return entries; },
    async find(query) { return entries.filter(item => item.content.toLowerCase().includes(query.toLowerCase())); },
  };
}

test("semantic memory falls back to lexical retrieval when service is not configured", async () => {
  const store = makeStore([entry("1", "TypeScript build rules"), entry("2", "Python AI")]);
  const search = new SemanticProjectMemorySearch(store, { baseUrl: "", token: "" });
  assert.deepEqual((await search.find("TypeScript")).map(item => item.id), ["1"]);
});

test("semantic memory rejects insecure non-local HTTP service URLs", async () => {
  const store = makeStore([entry("1", "TypeScript build rules")]);
  let called = false;
  const search = new SemanticProjectMemorySearch(store, {
    baseUrl: "http://example.com", token: "test",
    fetchImpl: async () => { called = true; throw new Error("must not call"); },
  });
  assert.deepEqual((await search.find("build")).map(item => item.id), ["1"]);
  assert.equal(called, false);
});

test("semantic retrieval embeds candidates and returns reranker order", async () => {
  const store = makeStore([entry("a", "first document"), entry("b", "second document")]);
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/v1/embeddings")) {
      return new Response(JSON.stringify({
        model: "fake", dimensions: 2,
        embeddings: [[1, 0], [1, 0], [0.8, 0.2]],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      model: "fake", results: [{ index: 1, score: 0.99 }, { index: 0, score: 0.1 }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const search = new SemanticProjectMemorySearch(store, {
    baseUrl: "http://localhost:8000", token: "test", fetchImpl,
  });
  assert.deepEqual((await search.find("meaning")).map(item => item.id), ["b", "a"]);
  assert.equal(calls.length, 2);
});

test("semantic retrieval falls back if the Python service fails", async () => {
  const store = makeStore([entry("a", "find me"), entry("b", "other")]);
  const search = new SemanticProjectMemorySearch(store, {
    baseUrl: "https://ai.internal", token: "test",
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
  });
  assert.deepEqual((await search.find("find me")).map(item => item.id), ["a"]);
});

test("empty semantic queries return no results", async () => {
  const store = makeStore([entry("a", "anything")]);
  const search = new SemanticProjectMemorySearch(store, {
    baseUrl: "http://localhost:8000", token: "test",
    fetchImpl: async () => { throw new Error("must not call"); },
  });
  assert.deepEqual(await search.find("   "), []);
});
