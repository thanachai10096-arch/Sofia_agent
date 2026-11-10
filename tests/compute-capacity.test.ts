import test from "node:test";
import assert from "node:assert/strict";
import { checkComputeCapacity, validateComputeCapacityLimits } from "../src/platform/compute-capacity.js";

const limits = {
  maxConcurrentJobs: 3,
  maxQueuedJobs: 10,
  maxTaskRuntimeMs: 60_000,
  maxMemoryMb: 2048,
  maxDiskMb: 4096,
};

test("admits a task within concurrency, queue, runtime, memory, and disk limits", () => {
  assert.deepEqual(checkComputeCapacity(limits, {
    activeJobs: 1,
    queuedJobs: 2,
    estimatedRuntimeMs: 30_000,
    estimatedMemoryMb: 1024,
    estimatedDiskMb: 2048,
  }), { admitted: true, reason: "request is within configured admission limits" });
});

test("rejects work when concurrency or queue capacity is reached", () => {
  assert.match(checkComputeCapacity(limits, { activeJobs: 3, queuedJobs: 0 }).reason, /concurrent job limit/);
  assert.match(checkComputeCapacity(limits, { activeJobs: 0, queuedJobs: 10 }).reason, /queue capacity/);
});

test("rejects runtime, memory, and disk estimates beyond configured limits", () => {
  assert.match(checkComputeCapacity(limits, { activeJobs: 0, queuedJobs: 0, estimatedRuntimeMs: 60_001 }).reason, /runtime/);
  assert.match(checkComputeCapacity(limits, { activeJobs: 0, queuedJobs: 0, estimatedMemoryMb: 2049 }).reason, /memory/);
  assert.match(checkComputeCapacity(limits, { activeJobs: 0, queuedJobs: 0, estimatedDiskMb: 4097 }).reason, /disk/);
});

test("fails closed when disk estimates are supplied without a disk limit", () => {
  const { maxDiskMb: _ignored, ...withoutDiskLimit } = limits;
  assert.match(checkComputeCapacity(withoutDiskLimit, {
    activeJobs: 0, queuedJobs: 0, estimatedDiskMb: 1,
  }).reason, /no disk limit/);
});

test("rejects invalid limits and negative capacity counters", () => {
  assert.throws(() => validateComputeCapacityLimits({ ...limits, maxConcurrentJobs: 0 }), /maxConcurrentJobs/);
  assert.match(checkComputeCapacity(limits, { activeJobs: -1, queuedJobs: 0 }).reason, /non-negative/);
  assert.match(checkComputeCapacity(limits, { activeJobs: 0, queuedJobs: 0, estimatedMemoryMb: Number.NaN }).reason, /memory/);
});
