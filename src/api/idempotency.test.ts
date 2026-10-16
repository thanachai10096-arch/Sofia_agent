import assert from "node:assert/strict";
import test from "node:test";
import { idempotencyFingerprint } from "./idempotency.js";

test("fingerprints are stable when object key order changes", () => {
  assert.equal(
    idempotencyFingerprint({ task: "build", context: { b: 2, a: 1 } }),
    idempotencyFingerprint({ context: { a: 1, b: 2 }, task: "build" }),
  );
});

test("fingerprints differ when meaningful request values differ", () => {
  assert.notEqual(idempotencyFingerprint({ task: "build" }), idempotencyFingerprint({ task: "delete" }));
  assert.notEqual(idempotencyFingerprint({ task: "build", maxSteps: 2 }), idempotencyFingerprint({ task: "build", maxSteps: 3 }));
});

test("array order is preserved because it may affect execution semantics", () => {
  assert.notEqual(idempotencyFingerprint({ steps: ["inspect", "build"] }), idempotencyFingerprint({ steps: ["build", "inspect"] }));
});

test("undefined top-level input is rejected", () => {
  assert.throws(() => idempotencyFingerprint(undefined), /undefined request/);
});
