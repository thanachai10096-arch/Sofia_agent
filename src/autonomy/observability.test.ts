import assert from "node:assert/strict";
import test from "node:test";
import {
  AutonomyObservability,
  InMemoryAutonomyEventStore,
  type AutonomyEventInput,
} from "./observability.js";

const event: AutonomyEventInput = {
  scope: "tenant-a", idempotencyKey: "job-1:complete",
  type: "job.completed", outcome: "succeeded", subjectId: "job-1",
  durationMs: 1250, resource: { cycles: 3, steps: 12, toolCalls: 7, spendUsd: 0.04 },
  occurredAt: "2026-11-20T10:00:00.000Z",
};

test("records bounded telemetry and aggregates outcomes and resources", async () => {
  const telemetry = new AutonomyObservability(new InMemoryAutonomyEventStore());
  await telemetry.record(event);
  await telemetry.record({
    ...event, idempotencyKey: "job-2:failed", type: "job.failed",
    outcome: "failed", durationMs: 500, resource: { cycles: 1 },
    occurredAt: "2026-11-20T11:00:00.000Z",
  });
  const summary = await telemetry.summarize("tenant-a");
  assert.equal(summary.total, 2);
  assert.equal(summary.byType["job.completed"], 1);
  assert.equal(summary.byOutcome.failed, 1);
  assert.equal(summary.duration.samples, 2);
  assert.equal(summary.duration.averageMs, 875);
  assert.equal(summary.duration.maxMs, 1250);
  assert.equal(summary.resources.cycles, 4);
  assert.equal(summary.resources.toolCalls, 7);
  assert.equal(summary.resources.spendUsd, 0.04);
  assert.equal(summary.latestEventAt, "2026-11-20T11:00:00.000Z");
});

test("idempotent retries do not duplicate events and reject altered payloads", async () => {
  const telemetry = new AutonomyObservability(new InMemoryAutonomyEventStore());
  assert.equal((await telemetry.record(event)).recorded, true);
  assert.equal((await telemetry.record(event)).recorded, false);
  await assert.rejects(
    () => telemetry.record({ ...event, outcome: "failed" }),
    /reused with different data/,
  );
  assert.equal((await telemetry.summarize("tenant-a")).total, 1);
});

test("telemetry is isolated by host-resolved tenant scope", async () => {
  const telemetry = new AutonomyObservability(new InMemoryAutonomyEventStore());
  await telemetry.record(event);
  assert.equal((await telemetry.list("tenant-b")).length, 0);
  assert.equal((await telemetry.summarize("tenant-b")).total, 0);
});

test("rejects free-form classifications, invalid counters and oversized queries", async () => {
  const telemetry = new AutonomyObservability(new InMemoryAutonomyEventStore());
  await assert.rejects(() => telemetry.record({ ...event, type: "prompt contents" as never }), /invalid/);
  await assert.rejects(() => telemetry.record({ ...event, durationMs: -1 }), /duration/);
  await assert.rejects(() => telemetry.record({ ...event, resource: { spendUsd: Number.NaN } }), /resource/);
  await assert.rejects(() => telemetry.list("tenant-a", 501), /query is invalid/);
});

test("concurrent duplicate writes are recorded once", async () => {
  const telemetry = new AutonomyObservability(new InMemoryAutonomyEventStore());
  const results = await Promise.all([
    telemetry.record(event), telemetry.record(event), telemetry.record(event),
  ]);
  assert.equal(results.filter((result) => result.recorded).length, 1);
  assert.equal((await telemetry.summarize("tenant-a")).total, 1);
});


test("runtime lifecycle audit is captured as privacy-bounded observability events", async () => {
  const telemetry = new AutonomyObservability(new InMemoryAutonomyEventStore());
  const { createAutonomyRuntimeAuditRecorder } = await import("./observability.js");
  const recordAudit = createAutonomyRuntimeAuditRecorder(telemetry);
  await recordAudit({
    type: "autonomy.research.started", principalId: "tenant-user-1",
    at: "2026-11-20T12:00:00.000Z",
  });
  await recordAudit({
    type: "autonomy.research.completed", principalId: "tenant-user-1",
    at: "2026-11-20T12:00:02.000Z", cycleCount: 2,
  });
  await recordAudit({
    type: "autonomy.research.failed", principalId: "tenant-user-2",
    at: "2026-11-20T12:01:00.000Z",
  });
  const first = await telemetry.summarize("tenant-user-1");
  assert.equal(first.total, 2);
  assert.equal(first.byType["research.started"], 1);
  assert.equal(first.byType["research.completed"], 1);
  assert.equal(first.resources.cycles, 2);
  const second = await telemetry.list("tenant-user-2");
  assert.equal(second.length, 1);
  assert.equal(second[0]?.outcome, "failed");
  assert.equal("error" in (second[0] ?? {}), false);
});
