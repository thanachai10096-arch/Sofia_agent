import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillFeedbackLedger, type SkillFeedbackInput } from "./skill-feedback.js";
import { openTenantSkillFeedbackStore } from "./sqlite-skill-feedback-store.js";
import { createTenantResourceResolver } from "../platform/tenant-resolver.js";
const input: SkillFeedbackInput = {
  scope: "project-a", actor: "trusted-host", skillName: "repair-build", skillVersion: "v1",
  candidateDigest: "a".repeat(64), outcome: "succeeded", evidenceIds: ["run-1"],
  safetyIncidentCount: 0, idempotencyKey: "execution-1",
};
test("tenant SQLite feedback survives restart and preserves idempotency", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-skill-feedback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resolver = createTenantResourceResolver(root), context = await resolver.resolve("principal-a");
  const firstStore = await openTenantSkillFeedbackStore(resolver, context);
  const first = await new SkillFeedbackLedger(firstStore).record(input);
  firstStore.close();
  const reopened = await openTenantSkillFeedbackStore(resolver, context);
  t.after(() => reopened.close());
  const ledger = new SkillFeedbackLedger(reopened), retry = await ledger.record(input);
  assert.equal(first.recorded, true); assert.equal(retry.recorded, false);
  assert.equal(retry.feedback.id, first.feedback.id);
  assert.equal((await ledger.summarize(input.scope, input.skillName, input.skillVersion))?.total, 1);
  await assert.rejects(() => ledger.record({ ...input, outcome: "failed" }), /idempotency key/u);
});
test("tenant feedback databases are physically isolated", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-skill-feedback-tenants-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resolver = createTenantResourceResolver(root);
  const a = await openTenantSkillFeedbackStore(resolver, await resolver.resolve("principal-a"));
  const b = await openTenantSkillFeedbackStore(resolver, await resolver.resolve("principal-b"));
  t.after(() => { a.close(); b.close(); });
  await new SkillFeedbackLedger(a).record(input);
  assert.equal(await new SkillFeedbackLedger(b).summarize(input.scope, input.skillName, input.skillVersion), null);
});
test("tenant feedback store rejects forged resolver contexts", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-skill-feedback-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resolver = createTenantResourceResolver(root), context = await resolver.resolve("principal-a");
  await assert.rejects(() => openTenantSkillFeedbackStore(resolver, { ...context }), /Untrusted or foreign tenant context/u);
});

test("concurrent duplicate executions are recorded exactly once", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sofia-skill-feedback-concurrent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resolver = createTenantResourceResolver(root);
  const store = await openTenantSkillFeedbackStore(resolver, await resolver.resolve("principal-a"));
  t.after(() => store.close());
  const ledger = new SkillFeedbackLedger(store);
  const results = await Promise.all(Array.from({ length: 12 }, () => ledger.record(input)));
  assert.equal(results.filter((result) => result.recorded).length, 1);
  assert.equal((await ledger.summarize(input.scope, input.skillName, input.skillVersion))?.total, 1);
});
