import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileAutonomyJobStore } from "./job-store.js";
import { AutonomyJobSupervisor } from "./job-supervisor.js";

test("supervisor resolves trusted adapters and persists completed research", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-autonomy-supervisor-"));
  try {
    const store = new FileAutonomyJobStore("supervisor-test", root);
    const job = await store.enqueue({ principalId: "tenant-1", kind: "research", payload: { topic: "runtime" } });
    let resolved = false;
    let receivedPrincipal = "";
    const supervisor = new AutonomyJobSupervisor({
      store,
      executor: {
        runResearch: async (request) => {
          receivedPrincipal = request.principalId;
          return { completed: true, stoppedBy: "no-knowledge-gap", cycles: [] };
        },
      },
      resolveAdapters: async () => {
        resolved = true;
        return {
          observe: async () => ({ signal: "x", sourceIds: [] }),
          identifyGaps: async () => [],
          researchLocally: async () => ({ summary: "x", sourceIds: [], confidence: 1 }),
          formulateHypothesis: async () => ({ statement: "x", successMetric: "x" }),
          experiment: async () => ({ passed: true, summary: "x", benchmarkBefore: 0, benchmarkAfter: 1, safetyIncidents: 0, rollbackAvailable: true }),
          recordLearning: async () => undefined,
        };
      },
      sandboxAvailable: async () => false,
      budgetContext: () => ({}),
      isKilled: async () => false,
      leaseMs: 3_000,
    });
    const completed = await supervisor.runNext("worker-1", new AbortController().signal);
    assert.equal(resolved, true);
    assert.equal(receivedPrincipal, "tenant-1");
    assert.equal(completed?.id, job.id);
    assert.equal(completed?.status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor records bounded retryable failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-autonomy-supervisor-"));
  try {
    const store = new FileAutonomyJobStore("supervisor-test", root);
    const job = await store.enqueue({ principalId: "tenant-1", kind: "research", payload: {}, maxAttempts: 1 });
    const supervisor = new AutonomyJobSupervisor({
      store,
      executor: { runResearch: async () => { throw new Error("research adapter unavailable"); } },
      resolveAdapters: async () => { throw new Error("postgres://admin:secret-password@db.internal resolver failure"); },
      sandboxAvailable: async () => false,
      budgetContext: () => ({}),
      isKilled: async () => false,
      leaseMs: 3_000,
    });
    const failed = await supervisor.runNext("worker-1", new AbortController().signal);
    assert.equal(failed?.id, job.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error, "Autonomy job failed.");
    assert.equal(failed?.error?.includes("secret-password"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supervisor passes persisted checkpoint to the runtime after worker recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-autonomy-resume-"));
  try {
    const store = new FileAutonomyJobStore("resume-test", root);
    const job = await store.enqueue({ principalId: "tenant-1", kind: "research", payload: {} });
    await store.claimNext("worker-old", 1_000);
    const prior = [{
      cycle: 1,
      question: "prior",
      finding: { summary: "prior finding", sourceIds: [], confidence: 0.9 },
      hypothesis: { statement: "prior hypothesis", successMetric: "prior metric" },
      status: "learned" as const,
    }];
    await store.saveCheckpoint("tenant-1", job.id, "worker-old", { nextCycle: 2, cycles: prior });
    await store.recoverExpired(new Date(Date.now() + 2_000));
    let resumedAt = 0;
    let priorCount = 0;
    const supervisor = new AutonomyJobSupervisor({
      store,
      executor: {
        runResearch: async (request) => {
          resumedAt = request.startCycle ?? 0;
          priorCount = request.previousCycles?.length ?? 0;
          return { completed: true, stoppedBy: "cycle-budget", cycles: request.previousCycles ?? [] };
        },
      },
      resolveAdapters: async () => ({
        observe: async () => ({ signal: "x", sourceIds: [] }),
        identifyGaps: async () => [],
        researchLocally: async () => ({ summary: "x", sourceIds: [], confidence: 1 }),
        formulateHypothesis: async () => ({ statement: "x", successMetric: "x" }),
        experiment: async () => ({ passed: true, summary: "x", benchmarkBefore: 0, benchmarkAfter: 1, safetyIncidents: 0, rollbackAvailable: true }),
        recordLearning: async () => undefined,
      }),
      sandboxAvailable: async () => false,
      budgetContext: () => ({}),
      isKilled: async () => false,
      leaseMs: 3_000,
    });
    const result = await supervisor.runNext("worker-new", new AbortController().signal);
    assert.equal(resumedAt, 2);
    assert.equal(priorCount, 1);
    assert.equal(result?.status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host kill switch cancels a claimed job before research starts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-autonomy-killswitch-"));
  try {
    const store = new FileAutonomyJobStore("kill-switch-test", root);
    const job = await store.enqueue({ principalId: "tenant-1", kind: "research", payload: {} });
    let executed = false;
    const supervisor = new AutonomyJobSupervisor({
      store,
      executor: { runResearch: async () => { executed = true; return { completed: true, stoppedBy: "cycle-budget", cycles: [] }; } },
      resolveAdapters: async () => ({
        observe: async () => ({ signal: "x", sourceIds: [] }),
        identifyGaps: async () => [],
        researchLocally: async () => ({ summary: "x", sourceIds: [], confidence: 1 }),
        formulateHypothesis: async () => ({ statement: "x", successMetric: "x" }),
        experiment: async () => ({ passed: true, summary: "x", benchmarkBefore: 0, benchmarkAfter: 1, safetyIncidents: 0, rollbackAvailable: true }),
        recordLearning: async () => undefined,
      }),
      sandboxAvailable: async () => false,
      budgetContext: () => ({}),
      isKilled: async () => true,
      leaseMs: 3_000,
      killSwitchPollMs: 1_000,
    });
    const result = await supervisor.runNext("worker-1", new AbortController().signal);
    assert.equal(result?.id, job.id);
    assert.equal(result?.status, "cancelled");
    assert.equal(executed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker session exits cleanly when host requests shutdown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-autonomy-worker-session-"));
  try {
    const store = new FileAutonomyJobStore("worker-session-test", root);
    const supervisor = new AutonomyJobSupervisor({
      store,
      executor: { runResearch: async () => ({ completed: true, stoppedBy: "cycle-budget", cycles: [] }) },
      resolveAdapters: async () => ({
        observe: async () => ({ signal: "x", sourceIds: [] }),
        identifyGaps: async () => [],
        researchLocally: async () => ({ summary: "x", sourceIds: [], confidence: 1 }),
        formulateHypothesis: async () => ({ statement: "x", successMetric: "x" }),
        experiment: async () => ({ passed: true, summary: "x", benchmarkBefore: 0, benchmarkAfter: 1, safetyIncidents: 0, rollbackAvailable: true }),
        recordLearning: async () => undefined,
      }),
      sandboxAvailable: async () => false,
      budgetContext: () => ({}),
      isKilled: async () => false,
    });
    const controller = new AbortController();
    controller.abort();
    const result = await supervisor.runUntilStopped("worker-1", controller.signal);
    assert.deepEqual(result, { processed: 0, infrastructureErrors: 0, stoppedBy: "aborted" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
