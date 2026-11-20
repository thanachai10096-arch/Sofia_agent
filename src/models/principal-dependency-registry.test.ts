import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createSofiaPrincipalDependencyRegistry } from "./factory.js";
import type { AgentDependencies } from "../agent/types.js";

test("principal dependency registry single-flights creation and isolates workspaces", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-principal-registry-"));
  const created: string[] = [];
  const closed: string[] = [];
  try {
    const registry = createSofiaPrincipalDependencyRegistry(
      path.join(temp, "tenants"),
      undefined,
      async (workspace) => {
        created.push(workspace);
        await new Promise<void>((resolve) => setImmediate(resolve));
        return {
          closeSessionStore: () => { closed.push(workspace); },
        } as unknown as AgentDependencies & { closeSessionStore: () => void };
      },
    );

    const [aliceFirst, aliceSecond, bob] = await Promise.all([
      registry.forPrincipal("api-key:alice"),
      registry.forPrincipal("api-key:alice"),
      registry.forPrincipal("api-key:bob"),
    ]);

    assert.equal(aliceFirst, aliceSecond, "concurrent requests for one principal share one dependency graph");
    assert.notEqual(aliceFirst, bob, "different principals receive different dependency graphs");
    assert.equal(created.length, 2, "each principal is initialized exactly once");
    assert.notEqual(created[0], created[1], "each principal is assigned a separate workspace");
    assert.equal(created.some((workspace) => workspace.includes("alice") || workspace.includes("bob")), false);
    assert.equal(registry.size, 2);

    await registry.close();
    assert.equal(closed.length, 2, "all initialized dependency graphs are closed exactly once");
    assert.deepEqual(new Set(closed), new Set(created));
    assert.equal(registry.size, 0);
    await assert.rejects(() => registry.forPrincipal("api-key:alice"), /registry is closed/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("principal dependency registry evicts failed initialization so it can be retried", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "sofia-principal-registry-retry-"));
  let attempts = 0;
  try {
    const registry = createSofiaPrincipalDependencyRegistry(
      path.join(temp, "tenants"),
      undefined,
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary database startup failure");
        return { closeSessionStore: () => undefined } as unknown as AgentDependencies & { closeSessionStore: () => void };
      },
    );

    await assert.rejects(() => registry.forPrincipal("api-key:retry"), /temporary database startup failure/);
    const recovered = await registry.forPrincipal("api-key:retry");
    assert.ok(recovered);
    assert.equal(attempts, 2);
    await registry.close();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
