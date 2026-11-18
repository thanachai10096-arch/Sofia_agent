import assert from "node:assert/strict";
import test from "node:test";
import { runRailwayAutonomyWorker } from "./railway-worker.js";

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
