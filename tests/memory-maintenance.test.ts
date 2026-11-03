import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeMemoryEntries, detectMemoryConflicts, normalizeMemoryForComparison } from "../src/brain/memory-maintenance.js";

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


test("conflict review detects explicit English negation", () => {
  const result = detectMemoryConflicts([
    { id: "a", kind: "preference", content: "User prefers concise technical answers" },
    { id: "b", kind: "preference", content: "User does not prefer concise technical answers" },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.reason, "opposite-negation");
});

test("conflict review detects Thai negation and respects kind boundaries", () => {
  const result = detectMemoryConflicts([
    { id: "a", kind: "preference", content: "ผู้ใช้ชอบคำตอบภาษาไทยแบบกระชับ" },
    { id: "b", kind: "preference", content: "ผู้ใช้ไม่ชอบคำตอบภาษาไทยแบบกระชับ" },
    { id: "c", kind: "fact", content: "ผู้ใช้ไม่ชอบคำตอบภาษาไทยแบบกระชับ" },
  ]);
  assert.equal(result.length, 1);
  assert.deepEqual([result[0]?.firstId, result[0]?.secondId], ["a", "b"]);
});

test("conflict review is bounded and ignores unrelated text", () => {
  const entries = [
    { id: "a", kind: "fact", content: "Uses TypeScript for backend agent systems" },
    { id: "b", kind: "fact", content: "Does not prefer concise technical answers" },
    { id: "c", kind: "fact", content: "Does not use TypeScript for backend agent systems" },
  ];
  assert.deepEqual(detectMemoryConflicts(entries, { maxPairs: 0 }), []);
  const result = detectMemoryConflicts(entries);
  assert.equal(result.length, 1);
  assert.deepEqual([result[0]?.firstId, result[0]?.secondId], ["a", "c"]);
});


test("consolidation report combines review signals and flags old records without mutating them", async () => {
  const { analyzeMemoryConsolidation } = await import("../src/brain/memory-maintenance.js");
  const records = [
    { id: "old", kind: "preference", content: "User prefers concise technical answers", updatedAt: "2025-01-01T00:00:00.000Z" },
    { id: "changed", kind: "preference", content: "User does not prefer concise technical answers", updatedAt: "2026-10-31T00:00:00.000Z" },
    { id: "future", kind: "preference", content: "A future record should not be marked stale", updatedAt: "2027-01-01T00:00:00.000Z" },
    { id: "invalid-date", kind: "preference", content: "A record with invalid date", updatedAt: "not-a-date" },
  ];
  const before = structuredClone(records);
  const report = analyzeMemoryConsolidation(records, {
    now: "2026-11-01T00:00:00.000Z",
    staleAfterDays: 180,
  });
  assert.equal(report.maintenance.scanned, 4);
  assert.equal(report.conflicts.length, 1);
  assert.deepEqual(report.staleCandidates.map((item) => item.id), ["old"]);
  assert.deepEqual(records, before);
});

test("consolidation rejects invalid analysis time and respects scan bounds", async () => {
  const { analyzeMemoryConsolidation } = await import("../src/brain/memory-maintenance.js");
  assert.throws(() => analyzeMemoryConsolidation([], { now: "invalid" }));
  const report = analyzeMemoryConsolidation([
    { id: "a", kind: "fact", content: "one two three", updatedAt: "2020-01-01T00:00:00Z" },
    { id: "b", kind: "fact", content: "one two three", updatedAt: "2020-01-01T00:00:00Z" },
  ], { maxRecords: 1, now: "2026-11-01T00:00:00Z" });
  assert.equal(report.maintenance.scanned, 1);
  assert.deepEqual(report.maintenance.duplicates, []);
  assert.equal(report.staleCandidates.length, 1);
});


test("verified memory revalidation separates unverified knowledge from verified knowledge", async () => {
  const { analyzeVerifiedMemoryRevalidation } = await import("../src/brain/memory-maintenance.js");
  const records = [
    { id: "legacy", kind: "decision", updatedAt: "2026-10-01T00:00:00Z" },
    {
      id: "verified-old",
      kind: "repair",
      verification: {
        candidateId: "candidate-1",
        runId: "run-1",
        verifiedAt: "2026-01-01T00:00:00Z",
        evidenceIds: ["test-evidence"],
        checks: [{ name: "evidence", passed: true }, { name: "regression", passed: true }, { name: "policy", passed: true }],
      },
    },
    {
      id: "verified-new",
      kind: "convention",
      verification: {
        candidateId: "candidate-2",
        runId: "run-2",
        verifiedAt: "2026-10-31T00:00:00Z",
        evidenceIds: ["test-evidence-2"],
        checks: [{ name: "evidence", passed: true }, { name: "regression", passed: true }, { name: "policy", passed: true }],
      },
    },
    { id: "episode", kind: "episode" },
  ];
  const before = structuredClone(records);
  const report = analyzeVerifiedMemoryRevalidation(records, {
    now: "2026-11-01T00:00:00Z",
    revalidateAfterDays: 180,
  });
  assert.equal(report.scanned, 3);
  assert.equal(report.verified, 2);
  assert.equal(report.unverified, 1);
  assert.deepEqual(report.revalidationCandidates.map((item) => [item.id, item.reason]), [
    ["legacy", "missing-provenance"],
    ["verified-old", "verification-expired"],
  ]);
  assert.deepEqual(records, before);
});

test("verified memory revalidation flags incomplete or invalid provenance and respects bounds", async () => {
  const { analyzeVerifiedMemoryRevalidation } = await import("../src/brain/memory-maintenance.js");
  const report = analyzeVerifiedMemoryRevalidation([
    { id: "incomplete", kind: "decision", verification: { candidateId: "candidate" } },
    {
      id: "future",
      kind: "repair",
      verification: {
        candidateId: "candidate", runId: "run", verifiedAt: "2027-01-01T00:00:00Z",
        evidenceIds: ["evidence"],
        checks: [{ name: "evidence", passed: true }, { name: "regression", passed: true }, { name: "policy", passed: true }],
      },
    },
    { id: "ignored", kind: "decision" },
  ], { now: "2026-11-01T00:00:00Z", maxRecords: 2 });
  assert.equal(report.scanned, 2);
  assert.equal(report.unverified, 1);
  assert.equal(report.verified, 1);
  assert.deepEqual(report.revalidationCandidates.map((item) => item.reason), [
    "incomplete-provenance",
    "invalid-verification-time",
  ]);
  assert.throws(() => analyzeVerifiedMemoryRevalidation([], { now: "not-a-date" }));
});
