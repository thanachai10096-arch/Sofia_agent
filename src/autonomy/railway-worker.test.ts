import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { runRailwayAutonomyWorker, runRailwayAutonomyWorkerWithProcessSignals } from "./railway-worker.js";

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) previous.set(key, process.env[key]);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("Railway worker refuses to start unless explicitly enabled", async () => {
  await withEnv({
    SOFIA_AUTONOMY_WORKER_ENABLED: undefined,
    DATABASE_URL: "postgres://not-used",
  }, async () => {
    await assert.rejects(
      runRailwayAutonomyWorker({} as never, new AbortController().signal),
      /must be enabled explicitly/,
    );
  });
});

test("Railway worker requires a database URL before touching the pool", async () => {
  await withEnv({
    SOFIA_AUTONOMY_WORKER_ENABLED: "true",
    DATABASE_URL: undefined,
  }, async () => {
    await assert.rejects(
      runRailwayAutonomyWorker({} as never, new AbortController().signal),
      /DATABASE_URL is required/,
    );
  });
});

test("Railway worker fails closed when trusted host dependencies are incomplete", async () => {
  await withEnv({
    SOFIA_AUTONOMY_WORKER_ENABLED: "true",
    DATABASE_URL: "postgres://not-used",
  }, async () => {
    await assert.rejects(
      runRailwayAutonomyWorker({ pool: {} } as never, new AbortController().signal),
      /dependencies are incomplete/,
    );
  });
});


test("Railway worker validates the injected PostgreSQL pool before starting", async () => {
  await withEnv({
    SOFIA_AUTONOMY_WORKER_ENABLED: "true",
    DATABASE_URL: "postgres://configured",
  }, async () => {
    await assert.rejects(
      runRailwayAutonomyWorker({
        pool: { query: async () => { throw new Error("database unavailable"); }, connect: async () => { throw new Error("unused"); } },
        resolveAdapters: async () => { throw new Error("unused"); },
        sandboxAvailable: async () => false,
        budgetContext: () => ({}),
        isKilled: async () => false,
      }, new AbortController().signal),
      /database unavailable/,
    );
  });
});


test("Railway worker handles termination and closes its host-owned pool", async () => {
  await withEnv({
    SOFIA_AUTONOMY_WORKER_ENABLED: "true",
    DATABASE_URL: "postgres://configured",
  }, async () => {
    const signals = new EventEmitter();
    let closed = false;
    const pool = {
      query: async () => ({ rows: [{ "?column?": 1 }] }),
      connect: async () => { throw new Error("claim should not run after termination"); },
    };
    const pending = runRailwayAutonomyWorkerWithProcessSignals({
      pool,
      resolveAdapters: async () => { throw new Error("unused"); },
      sandboxAvailable: async () => false,
      budgetContext: () => ({}),
      isKilled: async () => false,
      closePool: async () => { closed = true; },
    }, signals);
    signals.emit("SIGTERM");
    const result = await pending;
    assert.equal(result.stoppedBy, "aborted");
    assert.equal(closed, true);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
    assert.equal(signals.listenerCount("SIGINT"), 0);
  });
});
