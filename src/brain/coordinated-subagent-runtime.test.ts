import assert from "node:assert/strict";
import test from "node:test";
import { CoordinatedSubagentRuntime } from "./coordinated-subagent-runtime.js";
import type { SubagentRuntime } from "./subagents.js";

test("coordinated runtime preserves successful subagent results", async () => {
  const runtime: SubagentRuntime = {
    async run(request) {
      return { role: request.role, summary: "done", output: { task: request.task } };
    },
  };
  const bounded = new CoordinatedSubagentRuntime(runtime, { timeoutMs: 1000 });
  const result = await bounded.run({
    role: "explorer",
    task: "inspect repository",
    context: { safe: true },
    signal: new AbortController().signal,
  });
  assert.equal(result.summary, "done");
  assert.deepEqual(result.output, { task: "inspect repository" });
});

test("coordinated runtime surfaces timeout errors", async () => {
  const runtime: SubagentRuntime = {
    async run() {
      return new Promise((resolve) => setTimeout(() => resolve({
        role: "explorer", summary: "too late", output: null,
      }), 500));
    },
  };
  const bounded = new CoordinatedSubagentRuntime(runtime, { timeoutMs: 100 });
  await assert.rejects(
    bounded.run({ role: "explorer", task: "slow task", signal: new AbortController().signal }),
    /timed out/,
  );
});

test("coordinated runtime rejects oversized context before execution", async () => {
  let called = false;
  const runtime: SubagentRuntime = {
    async run(request) {
      called = true;
      return { role: request.role, summary: "unexpected", output: null };
    },
  };
  const bounded = new CoordinatedSubagentRuntime(runtime, { maxContextBytes: 256 });
  await assert.rejects(
    bounded.run({
      role: "explorer", task: "inspect", context: { data: "x".repeat(400) },
      signal: new AbortController().signal,
    }),
    /context exceeds configured size limit/,
  );
  assert.equal(called, false);
});


test("coordinator enforces one shared concurrency limit across concurrent run calls", async () => {
  let active = 0;
  let peak = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const runtime: SubagentRuntime = {
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
  };
  const bounded = new CoordinatedSubagentRuntime(runtime, { maxConcurrency: 1, timeoutMs: 2000 });
  const signal = () => new AbortController().signal;
  const first = bounded.run({ role: "explorer", task: "first", signal: signal() });
  const second = bounded.run({ role: "explorer", task: "second", signal: signal() });
  const third = bounded.run({ role: "explorer", task: "third", signal: signal() });

  // Let all calls enter the coordinator before releasing the first slot.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(active, 1);
  releaseFirst();
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(results.map((item) => item.summary), ["first", "second", "third"]);
  assert.equal(peak, 1, "concurrent runMany calls must share the same configured limit");
});

test("a queued subagent can be cancelled without consuming a concurrency slot", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const executed: string[] = [];
  const runtime: SubagentRuntime = {
    async run(request) {
      executed.push(request.task);
      if (request.task === "first") await firstGate;
      return { role: request.role, summary: request.task, output: null };
    },
  };
  const bounded = new CoordinatedSubagentRuntime(runtime, { maxConcurrency: 1, timeoutMs: 2000 });
  const first = bounded.run({ role: "explorer", task: "first", signal: new AbortController().signal });
  const queuedController = new AbortController();
  const queued = bounded.run({ role: "explorer", task: "cancelled-while-queued", signal: queuedController.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  queuedController.abort(new Error("cancel queued task"));
  await assert.rejects(queued, /cancel queued task/);
  releaseFirst();
  await first;
  assert.deepEqual(executed, ["first"]);
});
