import assert from "node:assert/strict";
import test from "node:test";
import { InMemorySkillLedger, type LearnedSkillCandidate } from "./learning.js";

const candidate = (fields: string[]): LearnedSkillCandidate => ({
  name: "repair-runtime_error",
  trigger: "runtime failure",
  category: "runtime_error",
  strategy: "fix-implementation",
  procedure: ["inspect evidence", "verify repair"],
  verification: ["test"],
  evidenceIds: ["evidence-1"],
  dsl: { version: 1, operation: "project-fields", fields },
});

test("skill ledger snapshots untrusted DSL data on record and list", () => {
  const ledger = new InMemorySkillLedger();
  const original = candidate(["name"]);
  ledger.record(original);
  (original.dsl as { fields: string[] }).fields[0] = "secret";
  const firstRead = ledger.list();
  assert.deepEqual((firstRead[0]?.dsl as { fields: string[] }).fields, ["name"]);
  (firstRead[0]!.dsl as { fields: string[] }).fields[0] = "mutated";
  assert.deepEqual((ledger.list()[0]?.dsl as { fields: string[] }).fields, ["name"]);
});

test("different declarative plans do not collide in the skill ledger", () => {
  const ledger = new InMemorySkillLedger();
  ledger.record(candidate(["name"]));
  ledger.record(candidate(["status"]));
  assert.equal(ledger.list().length, 2);
});
