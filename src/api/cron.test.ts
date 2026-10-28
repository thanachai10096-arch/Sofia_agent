import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createSofiaApi } from "./server.js";
import type { AgentDependencies } from "../agent/types.js";
import type { JobRecord, JobRuntime } from "../brain/job-runtime.js";

test("cron API enforces scopes and isolates schedules by authenticated owner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sofia-cron-api-test-"));
  const previousStateDir = process.env.SOFIA_STATE_DIR;
  process.env.SOFIA_STATE_DIR = root;
  const runtime = {
    async submit(input: { task: string; ownerKeyId?: string }) {
      return { id: "api-job", status: "queued", task: input.task, ownerKeyId: input.ownerKeyId } as JobRecord;
    },
    async get() { return undefined; },
    async cancel() { return true; },
    async list() { return []; },
    async resume() { throw new Error("unused"); },
  } as unknown as JobRuntime;
  const deps = {
    provider: {},
    router: { select() { throw new Error("unused"); }, markUnhealthy() {} },
    reviewer: { async review() { return { approved: true, reason: "unused" }; } },
    jobRuntime: runtime,
  } as unknown as AgentDependencies;
  const server = createSofiaApi(deps, {
    apiKeys: {
      "alice-token": ["cron:read", "cron:manage"],
      "bob-token": ["cron:read"],
      "no-cron-token": ["agent:run"],
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const base = "http://127.0.0.1:" + address.port;
    const call = async (token: string, method: string, url: string, body?: unknown) => {
      const response = await fetch(base + url, {
        method,
        headers: { authorization: "Bearer " + token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };

    assert.equal((await call("no-cron-token", "GET", "/v1/cron/schedules")).status, 403);
    assert.equal((await call("bob-token", "POST", "/v1/cron/schedules", {
      name: "denied", task: "task", cron: "* * * * *", timeZone: "UTC",
    })).status, 403);

    const created = await call("alice-token", "POST", "/v1/cron/schedules", {
      name: "api schedule", task: "safe scheduled task", cron: "* * * * *", timeZone: "UTC",
    });
    assert.equal(created.status, 201);
    const id = String(created.body.id);
    assert.equal(created.body.ownerKeyId.length > 0, true);

    const aliceList = await call("alice-token", "GET", "/v1/cron/schedules");
    const bobList = await call("bob-token", "GET", "/v1/cron/schedules");
    assert.equal(aliceList.body.schedules.length, 1);
    assert.equal(bobList.body.schedules.length, 0);
    assert.equal((await call("bob-token", "GET", "/v1/cron/schedules/" + id + "/history")).status, 403);
    assert.equal((await call("bob-token", "DELETE", "/v1/cron/schedules/" + id)).status, 403);

    assert.equal((await call("alice-token", "POST", "/v1/cron/schedules/" + id + "/disable")).body.status, "disabled");
    assert.equal((await call("alice-token", "POST", "/v1/cron/schedules/" + id + "/enable")).body.status, "enabled");
    assert.equal((await call("alice-token", "GET", "/v1/cron/schedules/" + id + "/history")).status, 200);
    assert.equal((await call("alice-token", "DELETE", "/v1/cron/schedules/" + id)).body.status, "disabled");
    assert.equal((await call("alice-token", "POST", "/v1/cron/schedules", {
      name: "invalid", task: "task", cron: "not a cron", timeZone: "UTC",
    })).status, 400);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousStateDir === undefined) delete process.env.SOFIA_STATE_DIR;
    else process.env.SOFIA_STATE_DIR = previousStateDir;
    // Windows can briefly keep newly-created scheduler files visible after the HTTP
    // server closes. Retry transient directory-not-empty/handle errors instead of
    // making the cross-platform suite fail on cleanup timing alone.
    let cleanupError: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        cleanupError = undefined;
        break;
      } catch (error) {
        cleanupError = error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    if (cleanupError) throw cleanupError;
  }
});
