import assert from "node:assert/strict";
import test from "node:test";

import { InMemorySkillLedger, type LearnedSkillCandidate } from "./learning.js";

test("in-memory skill ledger isolates stored candidates from caller mutation", () => {
  const candidate: LearnedSkillCandidate = {
    name: "repair-runtime_error",
    trigger: "runtime failure",
    category: "runtime_error",
    strategy: "inspect-evidence",
    procedure: ["inspect evidence", "verify the repair"],
    verification: ["test"],
    evidenceIds: ["run-1"],
  };
  const ledger = new InMemorySkillLedger();

  ledger.record(candidate);
  candidate.name = "mutated";
  candidate.procedure.push("untrusted extra step");
  candidate.verification[0] = "build";
  candidate.evidenceIds.push("forged-run");

  const stored = ledger.list()[0];
  assert.ok(stored);
  assert.equal(stored.name, "repair-runtime_error");
  assert.deepEqual(stored.procedure, ["inspect evidence", "verify the repair"]);
  assert.deepEqual(stored.verification, ["test"]);
  assert.deepEqual(stored.evidenceIds, ["run-1"]);
});

test("in-memory skill ledger returns defensive copies from list", () => {
  const ledger = new InMemorySkillLedger();
  ledger.record({
    name: "repair-runtime_error",
    trigger: "runtime failure",
    category: "runtime_error",
    strategy: "inspect-evidence",
    procedure: ["inspect evidence", "verify the repair"],
    verification: ["test"],
    evidenceIds: ["run-1"],
  });

  const returned = ledger.list()[0];
  assert.ok(returned);
  returned.name = "mutated";
  returned.procedure.push("injected step");
  returned.verification.pop();
  returned.evidenceIds[0] = "forged-run";

  const fresh = ledger.list()[0];
  assert.ok(fresh);
  assert.equal(fresh.name, "repair-runtime_error");
  assert.deepEqual(fresh.procedure, ["inspect evidence", "verify the repair"]);
  assert.deepEqual(fresh.verification, ["test"]);
  assert.deepEqual(fresh.evidenceIds, ["run-1"]);
});
