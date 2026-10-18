import test from "node:test";
import assert from "node:assert/strict";
import { BoundedSubagentCoordinator } from "../src/brain/subagent-coordinator.js";
import type { SubagentRuntime } from "../src/brain/subagents.js";

test("bounded coordinator creates a fresh runtime per child and preserves result order", async () => {
  const created: string[] = [];
  const coordinator = new BoundedSubagentCoordinator((task) => {
    created.push(task.id);
    const runtime: SubagentRuntime = {
      async run(request) {
        return { role: request.role, summary: request.task, output: { context: request.context } };
      },
    };
    return runtime;
  }, { maxConcurrency: 2 });
  const results = await coordinator.runMany([
    { id: "one", role: "explorer", task: "first", context: { shared: { value: 1 } } },
    { id: "two", role: "tester", task: "second", context: { shared: { value: 2 } } },
  ], new AbortController().signal);
  assert.deepEqual(created, ["one", "two"]);
  assert.deepEqual(results.map((item) => item.taskId), ["one", "two"]);
  assert.equal(results[0]?.result?.summary, "first");
  assert.deepEqual((results[0]?.result?.output as { context: unknown }).context, { shared: { value: 1 } });
});

test("bounded coordinator rejects duplicate IDs and oversized contexts", async () => {
  const coordinator = new BoundedSubagentCoordinator(() => ({ run: async () => ({ role: "explorer", summary: "", output: null }) }), { maxContextBytes: 256 });
  await assert.rejects(coordinator.runMany([
    { id: "same", role: "explorer", task: "one" },
    { id: "same", role: "explorer", task: "two" },
  ], new AbortController().signal), /Duplicate/);
  const context = { data: "x".repeat(300) };
  const result = await coordinator.runMany([{ id: "large", role: "explorer", task: "large", context }], new AbortController().signal);
  assert.match(result[0]?.error ?? "", /size limit/);
});

test("bounded coordinator returns task failure without discarding sibling results", async () => {
  const coordinator = new BoundedSubagentCoordinator((task) => ({
    async run(request) {
      if (task.id === "bad") throw new Error("fixture failure");
      return { role: request.role, summary: "ok", output: null };
    },
  }));
  const results = await coordinator.runMany([
    { id: "bad", role: "debugger", task: "fail" },
    { id: "good", role: "reviewer", task: "succeed" },
  ], new AbortController().signal);
  assert.match(results[0]?.error ?? "", /fixture failure/);
  assert.equal(results[1]?.result?.summary, "ok");
});

test("bounded coordinator enforces parent cancellation and configured limits", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled by parent"));
  const coordinator = new BoundedSubagentCoordinator(() => ({ run: async () => ({ role: "explorer", summary: "", output: null }) }));
  const results = await coordinator.runMany([{ id: "cancelled", role: "explorer", task: "task" }], controller.signal);
  assert.match(results[0]?.error ?? "", /cancelled by parent/);
  assert.throws(() => new BoundedSubagentCoordinator(() => ({ run: async () => ({ role: "explorer", summary: "", output: null }) }), { maxConcurrency: 99 }), /maxConcurrency/);
});


test("coordinator enforces one shared concurrency limit across concurrent batches", async () => {
  let active = 0;
  let peak = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const coordinator = new BoundedSubagentCoordinator(() => ({
    async run(request) {
      active += 1;
      peak = Math.max(peak, active);
      try {
        if (request.task === "first") await firstGate;
        return { role: request.role, summary: request.task, output: null };
      } finally {
        active -= 1;
      }
    },
  }), { maxConcurrency: 1, timeoutMs: 2000 });

  const signal = () => new AbortController().signal;
  const first = coordinator.runMany([{ id: "first", role: "explorer", task: "first" }], signal());
  const second = coordinator.runMany([{ id: "second", role: "explorer", task: "second" }], signal());
  const third = coordinator.runMany([{ id: "third", role: "explorer", task: "third" }], signal());

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  releaseFirst();
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(results.map((batch) => batch[0]?.result?.summary), ["first", "second", "third"]);
  assert.equal(peak, 1, "maxConcurrency must apply across concurrent runMany calls");
});

test("coordinator removes cancelled tasks from the shared concurrency queue", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const executed: string[] = [];
  const coordinator = new BoundedSubagentCoordinator(() => ({
    async run(request) {
      executed.push(request.task);
      if (request.task === "first") await firstGate;
      return { role: request.role, summary: request.task, output: null };
    },
  }), { maxConcurrency: 1, timeoutMs: 2000 });

  const first = coordinator.runMany([{ id: "first", role: "explorer", task: "first" }], new AbortController().signal);
  const queuedController = new AbortController();
  const queued = coordinator.runMany(
    [{ id: "queued", role: "explorer", task: "cancelled while queued" }],
    queuedController.signal,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  queuedController.abort(new Error("cancel queued task"));
  const queuedResult = await queued;
  assert.match(queuedResult[0]?.error ?? "", /cancel queued task/);
  releaseFirst();
  await first;
  assert.deepEqual(executed, ["first"]);
});
