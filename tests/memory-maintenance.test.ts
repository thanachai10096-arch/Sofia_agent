import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeMemoryEntries, normalizeMemoryForComparison } from "../src/brain/memory-maintenance.js";

test("memory maintenance detects exact duplicates without changing source text", () => {
  const report = analyzeMemoryEntries([
    { id: "a", kind: "preference", content: "Prefers concise answers." },
    { id: "b", kind: "preference", content: "  PREFERS concise answers! " },
    { id: "c", kind: "fact", content: "Prefers concise answers." },
  ]);
  assert.deepEqual(report.duplicates, [{ kind: "preference", ids: ["a", "b"] }]);
  assert.equal(report.scanned, 3);
});

test("similar memories are surfaced as review candidates, not merged", () => {
  const report = analyzeMemoryEntries([
    { id: "old", kind: "preference", content: "Prefers concise answers in technical explanations" },
    { id: "new", kind: "preference", content: "Prefers concise answers for technical explanations" },
  ]);
  assert.equal(report.reviewPairs.length, 1);
  assert.equal(report.reviewPairs[0]?.reason, "similar-content");
  assert.deepEqual(report.reviewPairs[0] && [report.reviewPairs[0].firstId, report.reviewPairs[0].secondId], ["old", "new"]);
});

test("maintenance is scoped by kind and bounded", () => {
  const report = analyzeMemoryEntries([
    { id: "a", kind: "fact", content: "Uses TypeScript for backend agent systems" },
    { id: "b", kind: "goal", content: "Uses TypeScript for backend agent systems" },
    { id: "c", kind: "fact", content: "Uses TypeScript for backend agent systems" },
  ], { maxRecords: 2 });
  assert.equal(report.scanned, 2);
  assert.deepEqual(report.duplicates, []);
  assert.deepEqual(normalizeMemoryForComparison("  HELLO—World! "), "hello world");
});

test("short or empty records do not produce noisy similarity candidates", () => {
  const report = analyzeMemoryEntries([
    { id: "a", kind: "fact", content: "AI" },
    { id: "b", kind: "fact", content: "AI" },
    { id: "invalid", kind: "fact", content: "" },
  ]);
  assert.equal(report.scanned, 2);
  assert.deepEqual(report.reviewPairs, []);
});
