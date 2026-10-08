import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFailure,
  diagnosisFromFailure,
  failureFingerprint,
  preferredStrategy,
} from "./failure-analysis.js";

test("classifies common compiler and environment failures deterministically", () => {
  assert.equal(classifyFailure("TS2339: Property x does not exist"), "type_error");
  assert.equal(classifyFailure("Cannot find module 'foo'"), "dependency_error");
  assert.equal(classifyFailure("EACCES: permission denied"), "permission_error");
  assert.equal(classifyFailure("command not found: pnpm"), "environment_error");
});

test("fingerprint ignores unstable numbers and paths", () => {
  const a = failureFingerprint({
    category: "type_error",
    message: String.raw`TS2322 at C:\repo\src\a.ts line 12`,
    source: "verification",
  });
  const b = failureFingerprint({
    category: "type_error",
    message: "TS2322 at /repo/src/a.ts line 99",
    source: "verification",
  });
  assert.equal(a, b);
});

test("repeated diagnosis is based on normalized failure evidence", () => {
  const first = diagnosisFromFailure(
    { category: "type_error", message: "TS2339 property x line 10", source: "verification" },
    [],
  );
  const second = diagnosisFromFailure(
    { category: "type_error", message: "TS2339 property x line 11", source: "verification" },
    [first],
  );
  assert.equal(second.repeated, 2);
});

test("strategy changes after implementation has already been attempted", () => {
  assert.equal(preferredStrategy("type_error", []), "fix-implementation");
  assert.equal(preferredStrategy("type_error", ["fix-implementation"]), "inspect-evidence");
  assert.equal(preferredStrategy("dependency_error", []), "fix-environment");
});
