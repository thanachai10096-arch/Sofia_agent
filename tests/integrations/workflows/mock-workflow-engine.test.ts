import assert from "node:assert/strict";
import test from "node:test";
import { MockWorkflowEngine } from "../../../src/integrations/workflows/mock-workflow-engine.js";

test("mock engine rejects workflow IDs outside its configured allowlist", async () => {
  const engine = new MockWorkflowEngine({ workflows: new Map() });
  await assert.rejects(
    engine.start({
      workflowId: "untrusted",
      input: {},
      idempotencyKey: "message-1",
      correlationId: "corr-1",
    }),
    /workflow_not_allowlisted/,
  );
});

test("mock engine deduplicates concurrent starts before invoking the handler twice", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const engine = new MockWorkflowEngine({
    workflows: new Map([["daily-report", async () => {
      calls++;
      await gate;
      return { generated: true };
    }]]),
  });
  const request = {
    workflowId: "daily-report",
    input: { range: "today" },
    idempotencyKey: "telegram-update-77",
    correlationId: "corr-77",
  };

  const firstPromise = engine.start(request);
  const secondPromise = engine.start(request);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();

  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(first.executionId, second.executionId);
  assert.equal(first.status, "succeeded");
  assert.equal(calls, 1);
  assert.deepEqual(await engine.getStatus(first.executionId), {
    executionId: first.executionId,
    workflowId: "daily-report",
    status: "succeeded",
    output: { generated: true },
  });
});

test("mock engine records cancellation and does not report success", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const engine = new MockWorkflowEngine({
    workflows: new Map([["slow-task", async () => {
      await gate;
      return { shouldNotSucceed: true };
    }]]),
  });

  const pending = engine.start({
    workflowId: "slow-task",
    input: {},
    idempotencyKey: "cancel-me",
    correlationId: "corr-cancel",
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort(new Error("cancel requested"));
  release();

  await assert.rejects(pending, /cancel requested/);
  const status = await engine.getStatus("mock-execution-1");
  assert.equal(status?.status, "cancelled");
  assert.equal(status?.safeErrorCode, "cancelled");
  assert.equal(status && "output" in status, false);
});

test("mock engine returns no status for an unknown execution ID", async () => {
  const engine = new MockWorkflowEngine({ workflows: new Map() });
  assert.equal(await engine.getStatus("not-owned"), undefined);
});

test("mock engine requires a non-empty idempotency and correlation identity", async () => {
  const engine = new MockWorkflowEngine({
    workflows: new Map([["daily-report", async () => ({ ok: true })]]),
  });
  await assert.rejects(
    engine.start({
      workflowId: "daily-report",
      input: {},
      idempotencyKey: " ",
      correlationId: "corr-1",
    }),
    /workflow_request_identity_required/,
  );
});
