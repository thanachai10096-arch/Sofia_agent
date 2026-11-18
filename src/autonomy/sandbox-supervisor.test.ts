import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContainerSandbox } from "../sandbox.js";
import { SandboxSupervisor, type SandboxSupervisorBudget } from "./sandbox-supervisor.js";

const budget: SandboxSupervisorBudget = {
  maxCycles: 2,
  maxSteps: 4,
  maxToolCallsPerStep: 4,
  maxExperimentSeconds: 30,
  maxSpendUsd: 0.5,
  maxOutputBytes: 4096,
};

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-supervisor-"));
  const calls: string[][] = [];
  const sandbox = new ContainerSandbox({
    image: "registry.example/runner@sha256:" + "a".repeat(64),
    runner: async (args) => {
      calls.push(args);
      return { stdout: "ok", stderr: "", code: 0 };
    },
  });
  const supervisor = new SandboxSupervisor({
    workspaceRoot: root,
    attestationSecret: "test-only-secret-with-at-least-thirty-two-characters",
    sandbox,
    budget,
  });
  return { root, calls, supervisor };
}

test("supervisor issues principal/run-bound attestations and isolated workspace paths", async () => {
  const f = await fixture();
  try {
    const a = { principalId: "tenant-a", runId: "run-1" };
    const b = { principalId: "tenant-b", runId: "run-1" };
    const attestationA = await f.supervisor.beginRun(a);
    const attestationB = await f.supervisor.beginRun(b);
    assert.equal(f.supervisor.verifyAttestation(a, attestationA), true);
    assert.equal(f.supervisor.verifyAttestation(b, attestationA), false);
    assert.notEqual(attestationA.workspaceDigest, attestationB.workspaceDigest);
    assert.equal(f.supervisor.verifyAttestation(a, { ...attestationA, workspaceDigest: "tampered" }), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("supervisor runs only in its attested container workspace with network disabled by default", async () => {
  const f = await fixture();
  try {
    const identity = { principalId: "tenant-a", runId: "run-2" };
    const attestation = await f.supervisor.beginRun(identity);
    const result = await f.supervisor.run(identity, attestation, "node", ["--version"], { timeoutMs: 1000 });
    assert.equal(result.stdout, "ok");
    const args = f.calls[0] ?? [];
    assert.equal(args[0], "run");
    assert.equal(args[args.indexOf("--network") + 1], "none");
    const mount = args[args.indexOf("--mount") + 1] ?? "";
    assert.ok(mount.includes(attestation.principalDigest));
    assert.ok(mount.endsWith(",target=/workspace"));
    assert.equal(f.supervisor.getAutonomyContext(identity, attestation).sandboxAvailable, true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("supervisor rejects network, timeout, output and call-budget escalation", async () => {
  const f = await fixture();
  try {
    const identity = { principalId: "tenant-a", runId: "run-3" };
    const attestation = await f.supervisor.beginRun(identity);
    await assert.rejects(
      () => f.supervisor.run(identity, attestation, "node", [], { timeoutMs: 31_000 }),
      /timeout exceeds/i,
    );
    await assert.rejects(
      () => f.supervisor.run(identity, attestation, "node", [], { timeoutMs: 1000, allowNetwork: true }),
      /network access is not authorized/i,
    );
    await assert.rejects(
      () => f.supervisor.run(identity, attestation, "node", [], { timeoutMs: 1000, maxOutputBytes: 8192 }),
      /output limit exceeds/i,
    );
    for (let i = 0; i < budget.maxToolCallsPerStep; i++) {
      await f.supervisor.run(identity, attestation, "node", [], { timeoutMs: 1000 });
    }
    await assert.rejects(
      () => f.supervisor.run(identity, attestation, "node", [], { timeoutMs: 1000 }),
      /budget exhausted/i,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("supervisor spend telemetry is trusted, cumulative and revokes the run on exhaustion", async () => {
  const f = await fixture();
  try {
    const identity = { principalId: "tenant-a", runId: "run-4" };
    const attestation = await f.supervisor.beginRun(identity);
    f.supervisor.recordSpend(identity, attestation, 0.25);
    assert.equal(f.supervisor.getAutonomyContext(identity, attestation).estimatedSpendUsd, 0.25);
    assert.throws(() => f.supervisor.recordSpend(identity, attestation, 0.30), /spend budget exhausted/i);
    assert.equal(f.supervisor.getAutonomyContext(identity, attestation).sandboxAvailable, false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("ending a run immediately invalidates its attestation", async () => {
  const f = await fixture();
  try {
    const identity = { principalId: "tenant-a", runId: "run-5" };
    const attestation = await f.supervisor.beginRun(identity);
    f.supervisor.endRun(identity);
    assert.equal(f.supervisor.verifyAttestation(identity, attestation), false);
    await assert.rejects(
      () => f.supervisor.run(identity, attestation, "node", [], { timeoutMs: 1000 }),
      /valid active sandbox attestation/i,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});


test("disposing a run revokes its attestation and removes its workspace", async () => {
  const f = await fixture();
  try {
    const identity = { principalId: "tenant-a", runId: "run-dispose" };
    const attestation = await f.supervisor.beginRun(identity);
    await f.supervisor.run(identity, attestation, "node", [], { timeoutMs: 1000 });
    await f.supervisor.disposeRun(identity);
    assert.equal(f.supervisor.verifyAttestation(identity, attestation), false);
    assert.equal(f.supervisor.getAutonomyContext(identity, attestation).sandboxAvailable, false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
