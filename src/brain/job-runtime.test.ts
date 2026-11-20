import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DurableJobRuntime } from "./job-runtime.js";
import type { SofiaBrain } from "./executor.js";


test("DurableJobRuntime atomically deduplicates concurrent submissions by owner and idempotency key", async () => {
  const namespace = "job-runtime-idempotency-" + randomUUID();
  let executions = 0;
  let started!: () => void;
  const didStart = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const brain = {
    run: async () => {
      executions += 1;
      started();
      await gate;
      return { completed: true, state: "completed" };
    },
  } as unknown as SofiaBrain;
  const firstRuntime = new DurableJobRuntime(() => brain, undefined, namespace);
  const secondRuntime = new DurableJobRuntime(() => brain, undefined, namespace);
  const submission = {
    task: "send one notification",
    ownerKeyId: "owner-a",
    idempotencyId: createHash("sha256").update("owner-a:key-123").digest("hex"),
    requestFingerprint: createHash("sha256").update("same-request").digest("hex"),
  };
  const [first, second] = await Promise.all([
    firstRuntime.submit(submission),
    secondRuntime.submit(submission),
  ]);
  assert.equal(first.id, second.id, "both callers must receive the same durable job");
  await didStart;
  assert.equal(executions, 1, "only the process that atomically created the record may dispatch it");
  release();
  await firstRuntime.close();
  await secondRuntime.close();
  assert.equal((await firstRuntime.get(first.id))?.status, "completed");
});

test("DurableJobRuntime rejects reuse of an idempotency key for a different request", async () => {
  const namespace = "job-runtime-idempotency-conflict-" + randomUUID();
  const brain = {
    run: async () => ({ completed: true, state: "completed" }),
  } as unknown as SofiaBrain;
  const runtime = new DurableJobRuntime(() => brain, undefined, namespace);
  const idempotencyId = createHash("sha256").update("owner-a:key-456").digest("hex");
  await runtime.submit({
    task: "first task",
    ownerKeyId: "owner-a",
    idempotencyId,
    requestFingerprint: createHash("sha256").update("first").digest("hex"),
  });
  await assert.rejects(() => runtime.submit({
    task: "different task",
    ownerKeyId: "owner-a",
    idempotencyId,
    requestFingerprint: createHash("sha256").update("second").digest("hex"),
  }), /idempotency_key_reused_with_different_request/);
  await runtime.close();
});

test("DurableJobRuntime marks an interrupted persisted job recoverable after restart", async () => {
  const namespace = "job-runtime-restart-" + randomUUID();
  const hangingBrain = {
    run: () => new Promise(() => undefined),
  } as unknown as SofiaBrain;

  const firstRuntime = new DurableJobRuntime(() => hangingBrain, undefined, namespace);
  const submitted = await firstRuntime.submit({ task: "recover after process restart" });

  // Wait until the worker has atomically claimed the job, then simulate a crashed
  // worker by expiring its lease in the persisted record.
  let active = await firstRuntime.get(submitted.id);
  for (let attempt = 0; attempt < 100 && active?.status !== "running"; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    active = await firstRuntime.get(submitted.id);
  }
  assert.equal(active?.status, "running");
  const stateFile = path.join(os.tmpdir(), "sofia-agents-jobs", createHash("sha256").update(namespace).digest("hex") + ".json");
  const records = JSON.parse(await readFile(stateFile, "utf8")) as Array<{ id: string; leaseExpiresAt?: string }>;
  const saved = records.find((item) => item.id === submitted.id);
  assert.ok(saved);
  saved.leaseExpiresAt = new Date(0).toISOString();
  await writeFile(stateFile + ".test-tmp", JSON.stringify(records, null, 2), "utf8");
  await (await import("node:fs/promises")).rename(stateFile + ".test-tmp", stateFile);

  const restartedRuntime = new DurableJobRuntime(() => hangingBrain, undefined, namespace);
  const recovered = await restartedRuntime.get(submitted.id);

  assert.equal(recovered?.status, "failed");
  assert.match(recovered?.error ?? "", /interrupted|lease expired/i);
});


test("DurableJobRuntime cancels an active run and persists the terminal state", async () => {
  const namespace = "job-runtime-cancel-" + randomUUID();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const brain = {
    run: async ({ signal }: { signal?: AbortSignal }) => {
      started();
      if (!signal) throw new Error("Runtime did not pass an abort signal");
      if (signal.aborted) return { completed: false, state: "cancelled" };
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { completed: false, state: "cancelled" };
    },
  } as unknown as SofiaBrain;

  const runtime = new DurableJobRuntime(() => brain, undefined, namespace);
  const submitted = await runtime.submit({ task: "cancel an active run" });
  await running;
  assert.equal(await runtime.cancel(submitted.id), true);

  let finalRecord = await runtime.get(submitted.id);
  for (let attempt = 0; attempt < 20 && finalRecord?.status === "running"; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    finalRecord = await runtime.get(submitted.id);
  }
  assert.equal(finalRecord?.status, "cancelled");

  const restartedRuntime = new DurableJobRuntime(() => brain, undefined, namespace);
  assert.equal((await restartedRuntime.get(submitted.id))?.status, "cancelled");
});

test("DurableJobRuntime rejects resume when a job has no saved checkpoint", async () => {
  const namespace = "job-runtime-no-checkpoint-" + randomUUID();
  const brain = {
    run: async () => ({ completed: false, state: "failed" }),
  } as unknown as SofiaBrain;
  const runtime = new DurableJobRuntime(() => brain, undefined, namespace);
  const submitted = await runtime.submit({ task: "no checkpoint available" });

  // submit() starts execution asynchronously; wait until the run has settled before
  // asserting that resume rejects for a missing checkpoint rather than a live run.
  let current = await runtime.get(submitted.id);
  for (let attempt = 0; attempt < 100 && current?.status !== "failed"; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    current = await runtime.get(submitted.id);
  }
  assert.equal(current?.status, "failed");
  await assert.rejects(() => runtime.resume(submitted.id), /no resumable snapshot/i);
});


test("DurableJobRuntime resumes a saved checkpoint and passes it to the brain", async () => {
  const namespace = "job-runtime-resume-" + randomUUID();
  const { DurableJobRuntime: Runtime } = await import("./job-runtime.js");
  const snapshot = {
    version: 1,
    runId: "resume-run-" + randomUUID(),
    task: "resume checkpoint",
    understanding: {},
    plan: {},
    acceptanceCriteria: [],
    completedStepIds: ["step-1"],
    checkpointId: "checkpoint-1",
    usage: { steps: 1, toolCalls: 0, modelCalls: 1, reservedOrUsedTokens: 0, replans: 0 },
    observations: [],
    diagnoses: [],
    decisions: [],
    recoveryRounds: 0,
    trace: [],
  } as unknown as import("./run-state.js").BrainRunSnapshot;

  let calls = 0;
  let receivedResume: import("./run-state.js").BrainRunSnapshot | undefined;
  const runtime = new Runtime(({ onRunSnapshot }) => ({
    run: async (input: { resume?: import("./run-state.js").BrainRunSnapshot }) => {
      calls += 1;
      if (input.resume) {
        receivedResume = input.resume;
        return { completed: true, state: "completed" };
      }
      await onRunSnapshot?.(snapshot);
      return { completed: false, state: "failed" };
    },
  } as unknown as SofiaBrain), undefined, namespace);

  const submitted = await runtime.submit({ task: "resume checkpoint" });
  let current = await runtime.get(submitted.id);
  for (let attempt = 0; attempt < 100 && current?.status !== "failed"; attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    current = await runtime.get(submitted.id);
  }

  assert.equal(current?.status, "failed");
  assert.equal(current?.snapshot?.checkpointId, "checkpoint-1");

  let resumed: Awaited<ReturnType<typeof runtime.resume>> | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      resumed = await runtime.resume(submitted.id);
      break;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Job is already running") throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.ok(resumed, "job execution should release its controller before resume");
  assert.equal(resumed.status, "completed");
  assert.equal(calls, 2);
  assert.equal(receivedResume?.checkpointId, "checkpoint-1");
  assert.equal((await runtime.get(submitted.id))?.status, "completed");
  assert.equal((await runtime.list()).find((item) => item.id === submitted.id)?.status, "completed");
});

test("DurableJobRuntime reserves the resume lock before asynchronous job lookup", async () => {
  const namespace = "job-runtime-resume-lock-" + randomUUID();
  const runtime = new DurableJobRuntime(() => ({
    run: async () => ({ completed: true, state: "completed" }),
  } as unknown as SofiaBrain), undefined, namespace);

  const results = await Promise.allSettled([
    runtime.resume("missing-job"),
    runtime.resume("missing-job"),
  ]);

  assert.equal(results.filter((result) => result.status === "rejected").length, 2);
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
  assert.equal(errors.filter((message) => message === "Unknown job").length, 1);
  assert.equal(errors.filter((message) => message === "Job is already being resumed").length, 1);
});



test("DurableJobRuntime prevents two callers from executing the same checkpoint concurrently", async () => {
  const namespace = "job-runtime-duplicate-resume-" + randomUUID();
  const snapshot = {
    version: 1,
    runId: "duplicate-resume-" + randomUUID(),
    task: "duplicate resume",
    understanding: {},
    plan: {},
    acceptanceCriteria: [],
    completedStepIds: [],
    checkpointId: "duplicate-checkpoint",
    usage: { steps: 0, toolCalls: 0, modelCalls: 0, reservedOrUsedTokens: 0, replans: 0 },
    observations: [],
    diagnoses: [],
    decisions: [],
    recoveryRounds: 0,
    trace: [],
  } as unknown as import("./run-state.js").BrainRunSnapshot;

  let callCount = 0;
  let resumed!: () => void;
  const resumeStarted = new Promise<void>((resolve) => { resumed = resolve; });
  let release!: () => void;
  const releaseResume = new Promise<void>((resolve) => { release = resolve; });
  const runtime = new DurableJobRuntime(({ onRunSnapshot }) => ({
    run: async (input: { resume?: import("./run-state.js").BrainRunSnapshot }) => {
      callCount += 1;
      if (!input.resume) {
        await onRunSnapshot?.(snapshot);
        return { completed: false, state: "failed" };
      }
      resumed();
      await releaseResume;
      return { completed: true, state: "completed" };
    },
  } as unknown as SofiaBrain), undefined, namespace);

  const submitted = await runtime.submit({ task: "duplicate resume" });
  let current = await runtime.get(submitted.id);
  for (let attempt = 0; attempt < 100 && current?.status !== "failed"; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    current = await runtime.get(submitted.id);
  }
  assert.equal(current?.status, "failed");
  assert.equal(current?.snapshot?.checkpointId, snapshot.checkpointId);

  const first = runtime.resume(submitted.id);
  await resumeStarted;
  await assert.rejects(
    () => runtime.resume(submitted.id),
    /already being resumed/i,
  );
  assert.equal(callCount, 2, "only one resumed brain execution should start");
  release();
  const result = await first;
  assert.equal(result.status, "completed");
  assert.equal(callCount, 2);
});

test("DurableJobRuntime rejects resume for a cancelled job even when a checkpoint exists", async () => {
  const namespace = "job-runtime-cancelled-resume-" + randomUUID();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const snapshot = {
    version: 1,
    runId: "cancelled-resume-" + randomUUID(),
    task: "cancelled checkpoint",
    understanding: {},
    plan: {},
    acceptanceCriteria: [],
    completedStepIds: [],
    checkpointId: "cancelled-checkpoint",
    usage: { steps: 0, toolCalls: 0, modelCalls: 0, reservedOrUsedTokens: 0, replans: 0 },
    observations: [],
    diagnoses: [],
    decisions: [],
    recoveryRounds: 0,
    trace: [],
  } as unknown as import("./run-state.js").BrainRunSnapshot;

  const brain = {
    run: async ({ signal }: { signal?: AbortSignal }) => {
      started();
      if (!signal) throw new Error("Runtime did not pass an abort signal");
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { completed: false, state: "cancelled" };
    },
  } as unknown as SofiaBrain;
  const runtime = new DurableJobRuntime(({ onRunSnapshot }) => {
    void onRunSnapshot?.(snapshot);
    return brain;
  }, undefined, namespace);

  const submitted = await runtime.submit({ task: "cancelled checkpoint" });
  await running;
  assert.equal(await runtime.cancel(submitted.id), true);
  let current = await runtime.get(submitted.id);
  for (let attempt = 0; attempt < 50 && current?.status !== "cancelled"; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    current = await runtime.get(submitted.id);
  }
  assert.equal(current?.status, "cancelled");
  assert.ok(current?.snapshot, "cancelled job should retain its checkpoint");
  await assert.rejects(() => runtime.resume(submitted.id), /cancelled jobs cannot be resumed/i);
});

test("DurableJobRuntime preserves a resumable embedded checkpoint when the snapshot store fails", async () => {
  const namespace = "job-runtime-snapshot-store-failure-" + randomUUID();
  const snapshot = {
    version: 1,
    runId: "snapshot-fallback-" + randomUUID(),
    task: "checkpoint fallback",
    understanding: {},
    plan: {},
    acceptanceCriteria: [],
    completedStepIds: ["step-1"],
    checkpointId: "embedded-fallback-checkpoint",
    usage: { steps: 1, toolCalls: 0, modelCalls: 1, reservedOrUsedTokens: 0, replans: 0 },
    observations: [],
    diagnoses: [],
    decisions: [],
    recoveryRounds: 0,
    trace: [],
  } as unknown as import("./run-state.js").BrainRunSnapshot;
  const unavailableStore = {
    async save() { throw new Error("snapshot disk unavailable"); },
    async load() { return undefined; },
    async delete() {},
  };
  const runtime = new DurableJobRuntime(({ onRunSnapshot }) => ({
    run: async () => {
      await onRunSnapshot?.(snapshot);
      return { completed: false, state: "failed" };
    },
  } as unknown as SofiaBrain), unavailableStore, namespace);

  const submitted = await runtime.submit({ task: "checkpoint fallback" });
  let current = await runtime.get(submitted.id);
  for (let attempt = 0; attempt < 100 && current?.status !== "failed"; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    current = await runtime.get(submitted.id);
  }
  assert.equal(current?.status, "failed");
  assert.equal(current?.snapshot?.checkpointId, snapshot.checkpointId);

  const restarted = new DurableJobRuntime(() => ({
    run: async () => ({ completed: false, state: "failed" }),
  } as unknown as SofiaBrain), unavailableStore, namespace);
  const recovered = await restarted.get(submitted.id);
  assert.equal(recovered?.snapshot?.checkpointId, snapshot.checkpointId);
});


test("DurableJobRuntime recovers a persisted running job across an actual Node.js process restart", async () => {
  const namespace = "job-runtime-real-process-restart-" + randomUUID();
  const startScript = `
    import { DurableJobRuntime } from "./src/brain/job-runtime.ts";
    const namespace = ${JSON.stringify(namespace)};
    const runtime = new DurableJobRuntime(() => ({
      run: async () => new Promise(() => undefined),
    }), undefined, namespace);
    const job = await runtime.submit({ task: "recover across process restart" });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await runtime.get(job.id);
      if (current?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Let the atomic state-file replacement finish before this worker exits.
    await new Promise((resolve) => setTimeout(resolve, 40));
    process.stdout.write(job.id);
  `;
  const start = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", startScript], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(start.status, 0, start.stderr || "first worker should exit cleanly");
  const jobId = start.stdout.trim();
  assert.ok(jobId, "first worker should print the persisted job ID");

  const recoveryStateFile = path.join(os.tmpdir(), "sofia-agents-jobs", createHash("sha256").update(namespace).digest("hex") + ".json");
  const recoveryRecords = JSON.parse(await readFile(recoveryStateFile, "utf8")) as Array<{ id: string; leaseExpiresAt?: string }>;
  const interrupted = recoveryRecords.find((item) => item.id === jobId);
  assert.ok(interrupted);
  interrupted.leaseExpiresAt = new Date(0).toISOString();
  await writeFile(recoveryStateFile + ".test-tmp", JSON.stringify(recoveryRecords, null, 2), "utf8");
  await (await import("node:fs/promises")).rename(recoveryStateFile + ".test-tmp", recoveryStateFile);

  const recoverScript = `
    import { DurableJobRuntime } from "./src/brain/job-runtime.ts";
    const runtime = new DurableJobRuntime(() => ({
      run: async () => ({ completed: true, state: "completed" }),
    }), undefined, ${JSON.stringify(namespace)});
    const job = await runtime.get(${JSON.stringify(jobId)});
    process.stdout.write(JSON.stringify({ status: job?.status, error: job?.error }));
  `;
  const recovered = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", recoverScript], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(recovered.status, 0, recovered.stderr || "recovery worker should exit cleanly");
  const record = JSON.parse(recovered.stdout) as { status?: string; error?: string };
  assert.equal(record.status, "failed");
  assert.match(record.error ?? "", /interrupted|lease expired/i);
});


test("DurableJobRuntime stores job state with owner-only file permissions on POSIX", async () => {
  const namespace = "job-runtime-private-state-" + randomUUID();
  const runtime = new DurableJobRuntime(() => ({
    run: async () => new Promise(() => undefined),
  } as unknown as SofiaBrain), undefined, namespace);
  await runtime.submit({ task: "private persisted job" });
  await new Promise<void>((resolve) => setTimeout(resolve, 40));

  const file = path.join(
    os.tmpdir(),
    "sofia-agents-jobs",
    createHash("sha256").update(namespace).digest("hex") + ".json",
  );
  try {
    if (process.platform !== "win32") {
      assert.equal((await stat(file)).mode & 0o777, 0o600, "job state must not be readable by other local users");
    }
  } finally {
    await rm(file, { force: true });
  }
});


test("DurableJobRuntime resumes a saved checkpoint after a real process restart", async () => {
  const namespace = "job-runtime-resume-real-restart-" + randomUUID();
  const startScript = `
    import { DurableJobRuntime } from "./src/brain/job-runtime.ts";
    const namespace = ${JSON.stringify(namespace)};
    const checkpointId = "restart-checkpoint";
    const snapshot = {
      version: 1,
      runId: "run-" + checkpointId,
      task: "resume after process restart",
      understanding: {},
      plan: {},
      acceptanceCriteria: [],
      completedStepIds: ["step-1"],
      checkpointId,
      usage: { steps: 1, toolCalls: 0, modelCalls: 1, reservedOrUsedTokens: 0, replans: 0 },
      observations: [],
      diagnoses: [],
      decisions: [],
      recoveryRounds: 0,
      trace: [],
    };
    const runtime = new DurableJobRuntime(({ onRunSnapshot }) => ({
      run: async () => {
        await onRunSnapshot(snapshot);
        return new Promise(() => undefined);
      },
    }), undefined, namespace);
    const job = await runtime.submit({ task: "resume after process restart" });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await runtime.get(job.id);
      if (current?.snapshot?.checkpointId === checkpointId) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    process.stdout.write(job.id);
  `;
  const started = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", startScript], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(started.status, 0, started.stderr || "checkpoint worker should exit cleanly");
  const jobId = started.stdout.trim();
  assert.ok(jobId, "checkpoint worker should print its job ID");

  const resumeStateFile = path.join(os.tmpdir(), "sofia-agents-jobs", createHash("sha256").update(namespace).digest("hex") + ".json");
  const resumeRecords = JSON.parse(await readFile(resumeStateFile, "utf8")) as Array<{ id: string; leaseExpiresAt?: string }>;
  const resumable = resumeRecords.find((item) => item.id === jobId);
  assert.ok(resumable);
  resumable.leaseExpiresAt = new Date(0).toISOString();
  await writeFile(resumeStateFile + ".test-tmp", JSON.stringify(resumeRecords, null, 2), "utf8");
  await (await import("node:fs/promises")).rename(resumeStateFile + ".test-tmp", resumeStateFile);

  const resumeScript = `
    import { DurableJobRuntime } from "./src/brain/job-runtime.ts";
    const runtime = new DurableJobRuntime(() => ({
      run: async (input) => ({
        completed: Boolean(input.resume),
        state: input.resume ? "completed" : "failed",
        output: input.resume?.checkpointId,
      }),
    }), undefined, ${JSON.stringify(namespace)});
    const job = await runtime.resume(${JSON.stringify(jobId)});
    process.stdout.write(JSON.stringify({ status: job.status, checkpointId: job.result?.output }));
  `;
  const resumed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", resumeScript], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(resumed.status, 0, resumed.stderr || "resume worker should exit cleanly");
  const result = JSON.parse(resumed.stdout) as { status?: string; checkpointId?: string };
  assert.equal(result.status, "completed");
  assert.equal(result.checkpointId, "restart-checkpoint");
});


test("DurableJobRuntime preserves concurrent submissions from independent runtime instances", async () => {
  const namespace = "job-runtime-concurrent-workers-" + randomUUID();
  const runtimes = Array.from({ length: 12 }, () => new DurableJobRuntime(() => ({
    run: async () => new Promise(() => undefined),
  } as unknown as SofiaBrain), undefined, namespace));

  const submitted = await Promise.all(runtimes.map((runtime, index) =>
    runtime.submit({ task: "concurrent worker submission " + index }),
  ));
  const reader = new DurableJobRuntime(() => ({
    run: async () => new Promise(() => undefined),
  } as unknown as SofiaBrain), undefined, namespace);
  const persisted = await reader.list();
  const persistedIds = new Set(persisted.map((record) => record.id));

  assert.equal(persisted.length, submitted.length, "no job records should be lost to concurrent read-modify-write");
  for (const job of submitted) assert.ok(persistedIds.has(job.id), "missing persisted job " + job.id);

  const file = path.join(
    os.tmpdir(),
    "sofia-agents-jobs",
    createHash("sha256").update(namespace).digest("hex") + ".json",
  );
  await rm(file, { force: true });
  await rm(file + ".lock", { force: true });
});


test("DurableJobRuntime preserves submissions from separate Node.js processes", async () => {
  const namespace = "job-runtime-process-concurrency-" + randomUUID();
  const workerCount = 4;
  const jobsPerWorker = 4;
  const workerScript = `
    import { DurableJobRuntime } from "./src/brain/job-runtime.ts";
    const namespace = ${JSON.stringify(namespace)};
    const runtime = new DurableJobRuntime(() => ({
      run: async () => new Promise(() => undefined),
    }), undefined, namespace);
    const jobs = await Promise.all(Array.from({ length: ${jobsPerWorker} }, (_, index) =>
      runtime.submit({ task: "process worker " + process.pid + " job " + index }),
    ));
    process.stdout.write(JSON.stringify(jobs.map((job) => job.id)));
  `;

  const runWorker = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", workerScript], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr || `worker exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });

  const workerOutputs = await Promise.all(Array.from({ length: workerCount }, runWorker));
  const submittedIds = workerOutputs.flatMap((output) => JSON.parse(output) as string[]);
  const reader = new DurableJobRuntime(() => ({
    run: async () => new Promise(() => undefined),
  } as unknown as SofiaBrain), undefined, namespace);
  const persisted = await reader.list();
  const persistedIds = new Set(persisted.map((record) => record.id));

  assert.equal(submittedIds.length, workerCount * jobsPerWorker);
  assert.equal(persisted.length, submittedIds.length, "cross-process writes must not lose job records");
  for (const id of submittedIds) assert.ok(persistedIds.has(id), "missing job submitted by child process " + id);

  const file = path.join(
    os.tmpdir(),
    "sofia-agents-jobs",
    createHash("sha256").update(namespace).digest("hex") + ".json",
  );
  await rm(file, { force: true });
  await rm(file + ".lock", { force: true });
});


test("DurableJobRuntime admits only one resumed execution across separate processes", async () => {
  const namespace = "job-runtime-single-claim-" + randomUUID();
  const markerFile = path.join(os.tmpdir(), namespace + ".started");
  const snapshot = {
    version: 1,
    runId: "lease-test-" + randomUUID(),
    task: "prove single worker claim",
    understanding: {},
    plan: {},
    acceptanceCriteria: [],
    completedStepIds: [],
    checkpointId: "lease-checkpoint",
    usage: { steps: 0, toolCalls: 0, modelCalls: 0, reservedOrUsedTokens: 0, replans: 0 },
    observations: [],
    diagnoses: [],
    decisions: [],
    recoveryRounds: 0,
    trace: [],
  } as unknown as import("./run-state.js").BrainRunSnapshot;

  const seedRuntime = new DurableJobRuntime(({ onRunSnapshot }) => ({
    run: async () => {
      await onRunSnapshot?.(snapshot);
      return { completed: false, state: "failed" };
    },
  } as unknown as SofiaBrain), undefined, namespace);
  const seeded = await seedRuntime.submit({ task: "prove single worker claim" });
  let seedRecord = await seedRuntime.get(seeded.id);
  for (let attempt = 0; attempt < 100 && seedRecord?.status !== "failed"; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    seedRecord = await seedRuntime.get(seeded.id);
  }
  assert.equal(seedRecord?.status, "failed");
  assert.equal(seedRecord?.snapshot?.checkpointId, snapshot.checkpointId);

  const workerScript = `
    import { appendFile } from "node:fs/promises";
    import { DurableJobRuntime } from "./src/brain/job-runtime.ts";
    const runtime = new DurableJobRuntime(() => ({
      run: async (input) => {
        if (!input.resume) throw new Error("expected a resume checkpoint");
        await appendFile(${JSON.stringify(markerFile)}, process.pid + "\\n");
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { completed: true, state: "completed" };
      },
    }), undefined, ${JSON.stringify(namespace)});
    try {
      const result = await runtime.resume(${JSON.stringify(seeded.id)});
      process.stdout.write(JSON.stringify({ status: result.status }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  `;

  const runWorker = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", workerScript], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(stderr || `worker exited with code ${code}`));
      else resolve(stdout);
    });
  });

  try {
    const results = await Promise.all([runWorker(), runWorker()]);
    const started = (await readFile(markerFile, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(started.length, 1, "only one process may execute the same checkpoint");
    assert.equal(results.filter((result) => JSON.parse(result).status === "completed").length, 1);
    assert.equal(results.filter((result) => JSON.parse(result).status !== "completed").length, 1);
  } finally {
    const stateFile = path.join(os.tmpdir(), "sofia-agents-jobs", createHash("sha256").update(namespace).digest("hex") + ".json");
    await rm(stateFile, { force: true });
    await rm(stateFile + ".lock", { force: true });
    await rm(markerFile, { force: true });
  }
});


test("DurableJobRuntime serializes competing stale-lock reclamation without losing jobs", async () => {
  const namespace = "job-runtime-stale-lock-reclaim-" + randomUUID();
  const stateDirectory = path.join(os.tmpdir(), "sofia-agents-jobs");
  const stateFile = path.join(stateDirectory, createHash("sha256").update(namespace).digest("hex") + ".json");
  const lockFile = stateFile + ".lock";
  const reclaimFile = lockFile + ".reclaim";
  await mkdir(stateDirectory, { recursive: true });
  await Promise.all([
    rm(stateFile, { force: true }),
    rm(lockFile, { force: true }),
    rm(reclaimFile, { force: true }),
  ]);
  await writeFile(lockFile, JSON.stringify({
    token: "stale-test-owner",
    pid: 0,
    hostname: os.hostname(),
    createdAt: Date.now() - 180_000,
  }), { encoding: "utf8", mode: 0o600 });

  const runtimes = Array.from({ length: 8 }, () => new DurableJobRuntime(() => ({
    run: async () => { throw new Error("expected test worker failure"); },
  } as unknown as SofiaBrain), undefined, namespace));

  try {
    const submitted = await Promise.all(runtimes.map((runtime, index) =>
      runtime.submit({ task: "stale-lock reclaim submission " + index }),
    ));
    assert.equal(submitted.length, 8);

    let persisted: Array<{ id: string; status: string }> = [];
    let locksReleased = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        persisted = JSON.parse(await readFile(stateFile, "utf8")) as Array<{ id: string; status: string }>;
      } catch { /* wait for the first atomic state write */ }
      const allDurable = submitted.every((job) =>
        persisted.some((record) => record.id === job.id && ["failed", "completed", "cancelled"].includes(record.status)),
      );
      if (allDurable) {
        let lockExists = false;
        let reclaimExists = false;
        try { await stat(lockFile); lockExists = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        try { await stat(reclaimFile); reclaimExists = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        locksReleased = !lockExists && !reclaimExists;
        if (locksReleased) break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(persisted.length, submitted.length, "concurrent reclaimers must not lose job records");
    assert.deepEqual(new Set(persisted.map((record) => record.id)), new Set(submitted.map((job) => job.id)));
    assert.ok(locksReleased, "all state writes and stale-lock reclamation must finish before cleanup");
  } finally {
    await Promise.all([
      rm(stateFile, { force: true }),
      rm(lockFile, { force: true }),
      rm(reclaimFile, { force: true }),
    ]);
  }
});


test("DurableJobRuntime redacts credential-shaped values from persisted and reloaded jobs", async () => {
  const root = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "sofia-job-redaction-"));
  const previousRoot = process.env.SOFIA_STATE_DIR;
  process.env.SOFIA_STATE_DIR = root;
  const namespace = "job-redaction-" + randomUUID();
  const secret = "ghp_" + "B".repeat(36);
  const brain = {
    run: async () => ({ completed: true, state: "completed", summary: "result token=" + secret }),
  } as unknown as SofiaBrain;
  try {
    const runtime = new DurableJobRuntime(() => brain, undefined, namespace);
    const submitted = await runtime.submit({ task: "task token=" + secret });
    assert.ok(!JSON.stringify(submitted).includes(secret), "submit response must redact credential-shaped task content");
    assert.equal(submitted.leaseOwnerToken, undefined, "submit response must not expose lease ownership");
    let record = await runtime.get(submitted.id);
    for (let attempt = 0; attempt < 50 && record?.status !== "completed"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      record = await runtime.get(submitted.id);
    }
    assert.equal(record?.status, "completed");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const file = path.join(root, "sofia-agents-jobs", createHash("sha256").update(namespace).digest("hex") + ".json");
    const persisted = await readFile(file, "utf8");
    assert.ok(!persisted.includes(secret), "persisted job file must not contain credential-shaped values");

    const restarted = new DurableJobRuntime(() => brain, undefined, namespace);
    const loaded = await restarted.get(submitted.id);
    assert.ok(loaded);
    assert.ok(!JSON.stringify(loaded).includes(secret), "reloaded job data must remain redacted");
  } finally {
    if (previousRoot === undefined) delete process.env.SOFIA_STATE_DIR;
    else process.env.SOFIA_STATE_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});


test("DurableJobRuntime cross-process cancellation aborts the active lease owner", async () => {
  const root = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "sofia-job-cross-cancel-"));
  const previousRoot = process.env.SOFIA_STATE_DIR;
  process.env.SOFIA_STATE_DIR = root;
  const namespace = "cross-process-cancel-" + randomUUID();
  const script = `
    import { DurableJobRuntime } from "./src/brain/job-runtime.js";
    const namespace = ${JSON.stringify(namespace)};
    const brain = {
      run: async ({ signal }) => {
        process.stdout.write("started\\n");
        await new Promise((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", resolve, { once: true });
        });
        process.stdout.write("observed-abort\\n");
        return { completed: true, state: "completed", summary: "late result must be discarded after cross-process cancellation" };
      },
    };
    const runtime = new DurableJobRuntime(() => brain, undefined, namespace);
    const job = await runtime.submit({ task: "cross-process cancellation" });
    process.stdout.write("job:" + job.id + "\\n");
    const keepAlive = setInterval(() => {}, 1000);
    const deadline = Date.now() + 12000;
    let record;
    while (Date.now() < deadline) {
      record = await runtime.get(job.id);
      if (record && ["cancelled", "completed", "failed"].includes(record.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    clearInterval(keepAlive);
    process.stdout.write("final:" + (record?.status ?? "missing") + "\\n");
    process.exitCode = record?.status === "cancelled" ? 0 : 1;
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, SOFIA_STATE_DIR: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { errors += chunk; });
  try {
    const startedDeadline = Date.now() + 8_000;
    while (!(output.includes("started\n") && /job:([0-9a-f-]+)/i.test(output)) && Date.now() < startedDeadline) {
      if (child.exitCode !== null) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(output.includes("started\n"), "child worker must acquire its lease before cancellation: " + errors + " stdout=" + output);
    const jobId = /job:([0-9a-f-]+)/i.exec(output)?.[1];
    assert.ok(jobId, "child worker must report its job ID");
    const canceller = new DurableJobRuntime(() => ({
      run: async () => ({ completed: false, state: "failed", summary: "unused" }),
    } as unknown as SofiaBrain), undefined, namespace);
    assert.equal(await canceller.cancel(jobId), true);
    const finalDeadline = Date.now() + 10_000;
    while (!output.includes("final:cancelled\n") && Date.now() < finalDeadline) {
      if (child.exitCode !== null) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    const exitDeadline = Date.now() + 2_000;
    while (child.exitCode === null && Date.now() < exitDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    if (child.exitCode === null) {
      child.kill();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    assert.ok(output.includes("observed-abort\n"), "active worker must observe cancellation from another process");
    assert.ok(output.includes("final:cancelled\n"), "cancelled state must remain terminal even if the brain returns a late success");
    const persisted = await canceller.get(jobId);
    assert.equal(persisted?.status, "cancelled");
    assert.equal(persisted?.result, undefined, "late success must not overwrite a durable cancellation");
    assert.equal(child.exitCode, 0, errors || output);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    if (previousRoot === undefined) delete process.env.SOFIA_STATE_DIR;
    else process.env.SOFIA_STATE_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});


test("DurableJobRuntime never reclaims an old lock owned by another host", async () => {
  const root = path.join(os.tmpdir(), "sofia-job-foreign-lock-" + randomUUID());
  const previousRoot = process.env.SOFIA_STATE_DIR;
  process.env.SOFIA_STATE_DIR = root;
  const namespace = "job-runtime-foreign-host-lock-" + randomUUID();
  const stateDirectory = path.join(root, "sofia-agents-jobs");
  const stateFile = path.join(stateDirectory, createHash("sha256").update(namespace).digest("hex") + ".json");
  const lockFile = stateFile + ".lock";
  await mkdir(stateDirectory, { recursive: true });

  try {
    await writeFile(lockFile, JSON.stringify({
      token: "remote-owner-token",
      pid: 12345,
      hostname: "another-host-that-may-still-be-running",
      createdAt: Date.now() - 180_000,
    }), { encoding: "utf8", mode: 0o600 });

    const runtime = new DurableJobRuntime(() => ({
      run: async () => { throw new Error("the job must not start while a foreign lock exists"); },
    } as unknown as SofiaBrain), undefined, namespace);

    await assert.rejects(
      runtime.submit({ task: "must fail closed on foreign-host lock" }),
      /belongs to another host/,
    );
    const lock = JSON.parse(await readFile(lockFile, "utf8")) as { token?: string };
    assert.equal(lock.token, "remote-owner-token", "foreign lock must not be deleted based on age");
  } finally {
    if (previousRoot === undefined) delete process.env.SOFIA_STATE_DIR;
    else process.env.SOFIA_STATE_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});


test("DurableJobRuntime redacts secrets before writing snapshots to the separate RunStore", async () => {
  const root = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "sofia-job-runstore-redaction-"));
  const previousRoot = process.env.SOFIA_STATE_DIR;
  process.env.SOFIA_STATE_DIR = root;
  const namespace = "job-runstore-redaction-" + randomUUID();
  const stateDirectory = path.join(root, "sofia-agents-jobs");
  const stateFile = path.join(stateDirectory, createHash("sha256").update(namespace).digest("hex") + ".json");
  const lockFile = stateFile + ".lock";
  const secret = "ghp_" + "C".repeat(36);
  let savedSnapshot: import("./run-state.js").BrainRunSnapshot | undefined;
  const runStore = {
    save: async (snapshot: import("./run-state.js").BrainRunSnapshot) => { savedSnapshot = snapshot; },
    // Simulate a legacy RunStore file written before snapshot redaction existed.
    load: async () => snapshot,
    delete: async () => undefined,
  };
  const snapshot = {
    version: 1,
    runId: "redaction-run-" + randomUUID(),
    task: "task token=" + secret,
    understanding: {},
    plan: {},
    acceptanceCriteria: [],
    completedStepIds: [],
    checkpointId: "checkpoint-redaction",
    usage: { steps: 0, toolCalls: 0, modelCalls: 0, reservedOrUsedTokens: 0, replans: 0 },
    observations: [],
    diagnoses: [],
    decisions: [],
    recoveryRounds: 0,
    trace: [],
  } as unknown as import("./run-state.js").BrainRunSnapshot;
  try {
    const runtime = new DurableJobRuntime(({ onRunSnapshot }) => ({
      run: async () => {
        await onRunSnapshot?.(snapshot);
        return { completed: false, state: "failed" };
      },
    } as unknown as SofiaBrain), runStore, namespace);
    const submitted = await runtime.submit({ task: "task token=" + secret });
    let record = await runtime.get(submitted.id);
    for (let attempt = 0; attempt < 100 && record?.status !== "failed"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      record = await runtime.get(submitted.id);
    }
    assert.equal(record?.status, "failed");
    assert.ok(record);
    assert.ok(!JSON.stringify(record).includes(secret), "public job reads must redact credential-shaped content");
    assert.equal(record.leaseOwnerToken, undefined, "public job reads must not expose lease ownership");
    assert.ok(savedSnapshot);
    assert.ok(!JSON.stringify(savedSnapshot).includes(secret), "separate checkpoint store must receive redacted data");
    assert.ok(!JSON.stringify(record.snapshot).includes(secret), "job record must not retain the unredacted checkpoint");
    const listed = await runtime.list();
    assert.ok(!JSON.stringify(listed).includes(secret), "job listings must redact credential-shaped content");
    assert.ok(listed.every((job) => job.leaseOwnerToken === undefined), "job listings must not expose lease ownership");

    // get() may observe the in-memory terminal status just before the final
    // atomic state write and lock cleanup finish. Wait for the durable terminal
    // record and lock release before removing the temporary state directory.
    const cleanupDeadline = Date.now() + 5_000;
    let durableTerminal = false;
    let lockReleased = false;
    while (Date.now() < cleanupDeadline) {
      try {
        const persisted = JSON.parse(await readFile(stateFile, "utf8")) as Array<{ id: string; status: string }>;
        durableTerminal = persisted.some((job) => job.id === submitted.id && job.status === "failed");
      } catch { /* wait for the first durable state file */ }
      if (durableTerminal) {
        try { await stat(lockFile); lockReleased = false; }
        catch (error) { lockReleased = (error as NodeJS.ErrnoException).code === "ENOENT"; }
        if (lockReleased) break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(durableTerminal && lockReleased, "job state write and lock cleanup must finish before test cleanup");
  } finally {
    if (previousRoot === undefined) delete process.env.SOFIA_STATE_DIR;
    else process.env.SOFIA_STATE_DIR = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});


test("DurableJobRuntime preserves the selected model route on submitted jobs", async () => {
  const namespace = "job-runtime-model-route-" + randomUUID();
  let selectedRoute: string | undefined;
  const brain = {
    run: async () => ({ completed: true, state: "completed" }),
  } as unknown as SofiaBrain;
  const runtime = new DurableJobRuntime((options) => {
    selectedRoute = options.modelRouteId;
    return brain;
  }, undefined, namespace);

  const submitted = await runtime.submit({ task: "run with selected model", modelRouteId: "coding" });
  let current = await runtime.get(submitted.id);
  for (let attempt = 0; attempt < 100 && current?.status !== "completed"; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    current = await runtime.get(submitted.id);
  }

  assert.equal(selectedRoute, "coding");
  assert.equal(current?.modelRouteId, "coding");
  assert.equal(current?.status, "completed");
});


test("DurableJobRuntime owner-bound accessors reject cross-owner job control", async () => {
  const namespace = "job-runtime-owner-bound-" + randomUUID();
  const brain = {
    run: async () => ({ completed: false, state: "failed" }),
  } as unknown as SofiaBrain;
  const runtime = new DurableJobRuntime(() => brain, undefined, namespace);
  const submitted = await runtime.submit({ task: "owner-bound job", ownerKeyId: "principal-a" });

  let current = await runtime.get(submitted.id);
  for (let attempt = 0; attempt < 100 && current?.status !== "failed"; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    current = await runtime.get(submitted.id);
  }

  assert.equal((await runtime.getForOwner(submitted.id, "principal-a"))?.ownerKeyId, "principal-a");
  assert.equal(await runtime.getForOwner(submitted.id, "principal-b"), undefined);
  assert.equal(await runtime.cancelForOwner(submitted.id, "principal-b"), false);
  await assert.rejects(
    () => runtime.resumeForOwner(submitted.id, "principal-b"),
    /unknown job/i,
  );
  assert.equal((await runtime.get(submitted.id))?.status, "failed");
});


test("DurableJobRuntime close aborts active work, waits for shutdown, and rejects new submissions", async () => {
  const namespace = "job-runtime-close-" + randomUUID();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let observedAbort = false;
  const brain = {
    run: async ({ signal }: { signal?: AbortSignal }) => {
      started();
      if (!signal) throw new Error("Runtime did not pass an abort signal");
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      observedAbort = true;
      return { completed: false, state: "cancelled" };
    },
  } as unknown as SofiaBrain;
  const runtime = new DurableJobRuntime(() => brain, undefined, namespace);
  const submitted = await runtime.submit({ task: "shutdown active work" });
  await running;

  const firstClose = runtime.close();
  const secondClose = runtime.close();
  assert.equal(firstClose, secondClose);
  await Promise.all([firstClose, secondClose]);

  assert.equal(observedAbort, true);
  assert.equal((await runtime.get(submitted.id))?.status, "cancelled");
  await assert.rejects(
    runtime.submit({ task: "must not start after shutdown" }),
    /runtime is closed/i,
  );
});


test("DurableJobRuntime close waits for a submit already admitted but still persisting", async () => {
  const namespace = "job-runtime-close-admission-" + randomUUID();
  let brainStarted = false;
  const brain = {
    run: async () => {
      brainStarted = true;
      return { completed: true, state: "completed" };
    },
  } as unknown as SofiaBrain;
  const runtime = new DurableJobRuntime(() => brain, undefined, namespace);
  const internals = runtime as unknown as {
    state: { save: (record: import("./job-runtime.js").JobRecord) => Promise<boolean> };
  };
  const originalSave = internals.state.save.bind(internals.state);
  let enteredSave!: () => void;
  const saveEntered = new Promise<void>((resolve) => { enteredSave = resolve; });
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  internals.state.save = async (record) => {
    enteredSave();
    await saveGate;
    return originalSave(record);
  };

  try {
    const submitting = runtime.submit({ task: "submit racing with close" });
    await saveEntered;
    let closeFinished = false;
    const closing = runtime.close().then(() => { closeFinished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closeFinished, false, "close must wait for an admitted submit to finish persistence");

    releaseSave();
    const submitted = await submitting;
    await closing;
    assert.equal((await runtime.get(submitted.id))?.status, "cancelled");
    assert.equal(brainStarted, false, "a submission admitted before close must not dispatch after shutdown");
    await assert.rejects(runtime.submit({ task: "late submit" }), /runtime is closed/i);
  } finally {
    releaseSave();
  }
});


test("DurableJobRuntime close aborts a resumed execution without waiting on its admission", async () => {
  const namespace = "job-runtime-close-resume-" + randomUUID();
  const snapshot = {
    version: 1,
    runId: "close-resume-" + randomUUID(),
    task: "resume while shutting down",
    understanding: {},
    plan: {},
    acceptanceCriteria: [],
    completedStepIds: [],
    checkpointId: "close-resume-checkpoint",
    usage: { steps: 0, toolCalls: 0, modelCalls: 0, reservedOrUsedTokens: 0, replans: 0 },
    observations: [],
    diagnoses: [],
    decisions: [],
    recoveryRounds: 0,
    trace: [],
  } as unknown as import("./run-state.js").BrainRunSnapshot;

  let resumeStarted!: () => void;
  const resumedRunStarted = new Promise<void>((resolve) => { resumeStarted = resolve; });
  const brain = {
    run: async (input: {
      signal?: AbortSignal;
      resume?: import("./run-state.js").BrainRunSnapshot;
    }) => {
      if (!input.resume) {
        return { completed: false, state: "failed" };
      }
      resumeStarted();
      if (!input.signal) throw new Error("Runtime did not pass a resume abort signal");
      await new Promise<void>((resolve) => {
        if (input.signal!.aborted) resolve();
        else input.signal!.addEventListener("abort", () => resolve(), { once: true });
      });
      return { completed: false, state: "cancelled" };
    },
  } as unknown as SofiaBrain;
  const runtime = new DurableJobRuntime(() => brain, undefined, namespace);
  const first = await runtime.submit({ task: "resume while shutting down" });
  let current = await runtime.get(first.id);
  for (let attempt = 0; attempt < 100 && current?.status !== "failed"; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    current = await runtime.get(first.id);
  }
  assert.equal(current?.status, "failed");
  // Seed a valid checkpoint on the canonical persisted record for this lifecycle test.
  const internals = runtime as unknown as {
    jobs: Map<string, import("./job-runtime.js").JobRecord>;
    state: { save: (record: import("./job-runtime.js").JobRecord) => Promise<boolean> };
  };
  const record = internals.jobs.get(first.id);
  assert.ok(record);
  record.snapshot = snapshot;
  await internals.state.save(record);

  const resuming = runtime.resume(first.id);
  await resumedRunStarted;
  const closing = runtime.close();
  const resumed = await resuming;
  await closing;
  assert.equal(resumed.status, "cancelled");
  assert.equal((await runtime.get(first.id))?.status, "cancelled");
});


test("DurableJobRuntime dispatches queued jobs left behind by a stopped process", async () => {
  const namespace = "job-runtime-queued-recovery-" + randomUUID();
  const jobId = "queued-recovery-" + randomUUID();
  const stateDirectory = path.join(os.tmpdir(), "sofia-agents-jobs");
  const stateFile = path.join(
    stateDirectory,
    createHash("sha256").update(namespace).digest("hex") + ".json",
  );
  const now = new Date().toISOString();
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(stateFile, JSON.stringify([{
    id: jobId,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    task: "recover queued work after restart",
    context: "Use the existing customer workspace and preserve its settings.",
    rollbackOnFailure: true,
  }]), { encoding: "utf8", mode: 0o600 });

  let executions = 0;
  let recoveredInput: { task: string; context?: string; rollbackOnFailure?: boolean } | undefined;
  const brain = {
    run: async (input: { task: string; context?: string; rollbackOnFailure?: boolean }) => {
      executions += 1;
      recoveredInput = input;
      return { completed: true, state: "completed" };
    },
  } as unknown as SofiaBrain;
  const runtime = new DurableJobRuntime(() => brain, undefined, namespace);
  try {
    assert.equal(await runtime.recoverQueued(), 1);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const recovered = await runtime.get(jobId);
      if (recovered?.status === "completed") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await runtime.get(jobId))?.status, "completed");
    assert.equal(executions, 1);
    assert.equal(recoveredInput?.context, "Use the existing customer workspace and preserve its settings.");
    assert.equal(recoveredInput?.rollbackOnFailure, true);
    assert.equal(await runtime.recoverQueued(), 0, "terminal jobs must not be dispatched again");
  } finally {
    await runtime.close();
    await rm(stateFile, { force: true });
  }
});


test("DurableJobRuntime restores and resumes a checkpoint only for its persisted owner after restart", async () => {
  const namespace = "job-runtime-owner-restart-resume-" + randomUUID();
  const owner = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const otherOwner = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const snapshot = {
    version: 1,
    runId: "owner-restart-" + randomUUID(),
    task: "owner-bound restart resume",
    understanding: {},
    plan: {},
    acceptanceCriteria: [],
    completedStepIds: ["step-before-restart"],
    checkpointId: "owner-bound-checkpoint",
    usage: { steps: 1, toolCalls: 0, modelCalls: 1, reservedOrUsedTokens: 0, replans: 0 },
    observations: [],
    diagnoses: [],
    decisions: [],
    recoveryRounds: 0,
    trace: [],
  } as unknown as import("./run-state.js").BrainRunSnapshot;

  const firstRuntime = new DurableJobRuntime(({ onRunSnapshot }) => ({
    run: async () => {
      await onRunSnapshot?.(snapshot);
      return { completed: false, state: "failed" };
    },
  } as unknown as SofiaBrain), undefined, namespace);
  const submitted = await firstRuntime.submit({ task: snapshot.task, ownerKeyId: owner });

  let failed = await firstRuntime.get(submitted.id);
  for (let attempt = 0; attempt < 100 && failed?.status !== "failed"; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    failed = await firstRuntime.get(submitted.id);
  }
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.snapshot?.checkpointId, snapshot.checkpointId);
  await firstRuntime.close();

  let resumedPrincipal: string | undefined;
  let resumedCheckpoint: string | undefined;
  const restartedRuntime = new DurableJobRuntime(() => ({
    run: async (input: {
      principalId?: string;
      resume?: import("./run-state.js").BrainRunSnapshot;
    }) => {
      resumedPrincipal = input.principalId;
      resumedCheckpoint = input.resume?.checkpointId;
      return { completed: true, state: "completed" };
    },
  } as unknown as SofiaBrain), undefined, namespace);

  try {
    assert.equal(await restartedRuntime.getForOwner(submitted.id, otherOwner), undefined);
    await assert.rejects(
      () => restartedRuntime.resumeForOwner(submitted.id, otherOwner),
      /unknown job/i,
    );
    const completed = await restartedRuntime.resumeForOwner(submitted.id, owner);
    assert.equal(completed.status, "completed");
    assert.equal(resumedPrincipal, owner, "the persisted owner must become the Brain principal on resume");
    assert.equal(resumedCheckpoint, snapshot.checkpointId, "restart must resume from the persisted checkpoint");
    assert.equal((await restartedRuntime.getForOwner(submitted.id, owner))?.status, "completed");
    assert.equal(await restartedRuntime.getForOwner(submitted.id, otherOwner), undefined);
  } finally {
    await restartedRuntime.close();
  }
});


test("DurableJobRuntime recovers an owner-bound checkpoint after SIGKILL and rejects cross-owner resume", async () => {
  const namespace = "job-runtime-owner-sigkill-" + randomUUID();
  const owner = "cccccccccccccccccccccccccccccccc";
  const otherOwner = "dddddddddddddddddddddddddddddddd";
  const stateFile = path.join(
    os.tmpdir(),
    "sofia-agents-jobs",
    createHash("sha256").update(namespace).digest("hex") + ".json",
  );
  const childScript = `
    import { DurableJobRuntime } from "./src/brain/job-runtime.ts";
    const snapshot = {
      version: 1,
      runId: "sigkill-owner-run",
      task: "recover owner checkpoint after process crash",
      understanding: {},
      plan: {},
      acceptanceCriteria: [],
      completedStepIds: ["before-crash"],
      checkpointId: "sigkill-owner-checkpoint",
      usage: { steps: 1, toolCalls: 0, modelCalls: 1, reservedOrUsedTokens: 0, replans: 0 },
      observations: [],
      diagnoses: [],
      decisions: [],
      recoveryRounds: 0,
      trace: [],
    };
    const runtime = new DurableJobRuntime(({ onRunSnapshot }) => ({
      run: async () => {
        await onRunSnapshot(snapshot);
        process.stdout.write("CHECKPOINT_SAVED\\n");
        await new Promise((resolve) => setInterval(resolve, 60_000));
        return { completed: true, state: "completed" };
      },
    }), undefined, ${JSON.stringify(namespace)});
    await runtime.submit({
      task: "recover owner checkpoint after process crash",
      ownerKeyId: ${JSON.stringify(owner)},
    });
  `;

  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const checkpointSaved = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("child did not persist its checkpoint")), 15_000);
    child.stdout.on("data", () => {
      if (stdout.includes("CHECKPOINT_SAVED")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (!stdout.includes("CHECKPOINT_SAVED")) {
        clearTimeout(timeout);
        reject(new Error(stderr || `child exited before checkpoint (code=${code}, signal=${signal})`));
      }
    });
  });

  try {
    await checkpointSaved;
    child.kill("SIGKILL");
    await new Promise<void>((resolve, reject) => {
      child.once("close", () => resolve());
      child.once("error", reject);
    });

    const records = JSON.parse(await readFile(stateFile, "utf8")) as Array<{
      id: string;
      status: string;
      ownerKeyId?: string;
      leaseExpiresAt?: string;
      snapshot?: { checkpointId?: string };
    }>;
    const crashed = records.find((record) => record.ownerKeyId === owner);
    assert.ok(crashed, "the crashed job must remain persisted for its original owner");
    assert.equal(crashed.status, "running");
    assert.equal(crashed.snapshot?.checkpointId, "sigkill-owner-checkpoint");
    crashed.leaseExpiresAt = new Date(0).toISOString();
    const temporary = stateFile + ".test-tmp";
    await writeFile(temporary, JSON.stringify(records, null, 2), { encoding: "utf8", mode: 0o600 });
    await (await import("node:fs/promises")).rename(temporary, stateFile);

    let resumedPrincipal: string | undefined;
    let resumedCheckpoint: string | undefined;
    const restarted = new DurableJobRuntime(() => ({
      run: async (input: {
        principalId?: string;
        resume?: { checkpointId?: string };
      }) => {
        resumedPrincipal = input.principalId;
        resumedCheckpoint = input.resume?.checkpointId;
        return { completed: true, state: "completed" };
      },
    } as unknown as SofiaBrain), undefined, namespace);

    try {
      const recovered = await restarted.getForOwner(crashed.id, owner);
      assert.equal(recovered?.status, "failed", "expired running lease must be recovered as interrupted");
      assert.equal(recovered?.snapshot?.checkpointId, "sigkill-owner-checkpoint");
      assert.equal(await restarted.getForOwner(crashed.id, otherOwner), undefined);
      await assert.rejects(
        () => restarted.resumeForOwner(crashed.id, otherOwner),
        /unknown job/i,
      );
      const completed = await restarted.resumeForOwner(crashed.id, owner);
      assert.equal(completed.status, "completed");
      assert.equal(resumedPrincipal, owner);
      assert.equal(resumedCheckpoint, "sigkill-owner-checkpoint");
      assert.equal(await restarted.getForOwner(crashed.id, otherOwner), undefined);
    } finally {
      await restarted.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(stateFile, { force: true });
    await rm(stateFile + ".lock", { force: true });
    await rm(stateFile + ".test-tmp", { force: true });
  }
});
