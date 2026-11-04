import test from "node:test";
import assert from "node:assert/strict";
import { buildSkillCandidate } from "./learning.js";

test("learned skill triggers never persist raw failure or user-provided text", () => {
  const privateDiagnostic = "customer-email@example.com /home/alice/private.txt API_KEY=super-secret-value";
  const candidate = buildSkillCandidate({
    category: "type_error",
    strategy: "fix-implementation",
    message: privateDiagnostic,
    evidenceIds: ["run-123"],
  });

  assert.equal(candidate.trigger, "Detected type_error during a verified repair.");
  assert.doesNotMatch(candidate.trigger, /customer-email|private\.txt|super-secret-value/);
  assert.deepEqual(candidate.procedure, [
    "inspect trusted failure evidence",
    "apply the selected repair strategy",
    "run the trusted verification that failed",
    "confirm the full task verification passes",
  ]);
  assert.deepEqual(candidate.evidenceIds, ["run-123"]);
});
