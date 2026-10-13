import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DurableJobRuntime } from "./job-runtime.js";
import type { SofiaBrain } from "./executor.js";

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
