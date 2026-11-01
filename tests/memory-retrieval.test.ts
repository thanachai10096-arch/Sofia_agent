import { test } from "node:test";
import assert from "node:assert/strict";
import { rankMemoryDocuments } from "../src/brain/memory-retrieval.js";

test("hybrid retrieval ranks exact phrase and word matches above weak matches", () => {
  const docs = [
    { id: "weak", kind: "fact", content: "Works with unrelated infrastructure and services" },
    { id: "strong", kind: "preference", content: "Prefers TypeScript for Sofia agent runtime" },
  ];
  const result = rankMemoryDocuments(docs, "Prefers TypeScript Sofia agent");
  assert.equal(result[0]?.entry.id, "strong");
});

test("character n-grams retrieve Thai text without whitespace segmentation", () => {
  const docs = [
    { id: "thai", kind: "preference", content: "ผู้ใช้ต้องการให้โซเฟียตอบภาษาไทยและทำงานต่อเนื่อง" },
    { id: "other", kind: "fact", content: "ใช้ Python ทำ data analysis" },
  ];
  const result = rankMemoryDocuments(docs, "โซเฟียตอบไทย");
  assert.equal(result[0]?.entry.id, "thai");
});

test("retrieval is bounded and irrelevant records do not match", () => {
  const docs = Array.from({ length: 10 }, (_, i) => ({
    id: String(i), kind: "fact", content: "unrelated gardening and cooking notes",
  }));
  assert.deepEqual(rankMemoryDocuments(docs, "quantum agent orchestration"), []);
  assert.equal(rankMemoryDocuments(docs, "gardening", { maxDocuments: 3 }).length, 3);
});

test("empty queries return no memories", () => {
  assert.deepEqual(rankMemoryDocuments([{ id: "x", kind: "fact", content: "something" }], "   "), []);
});
