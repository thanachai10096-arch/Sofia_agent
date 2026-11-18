import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { RemoteSandbox } from "../sandbox.js";
import { createRemoteSandboxRunnerServer } from "./remote-runner-server.js";
import type { Sandbox } from "../sandbox.js";

const TOKEN = "runner-test-token-with-at-least-thirty-two-characters";

test("remote runner authenticates requests and executes isolated snapshot round trips", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-runner-server-test-"));
  const sandbox: Sandbox = {
    isolation: "container",
    async run(command, args, limits) {
      assert.equal(command, "node");
      assert.deepEqual(args, ["verify.js"]);
      assert.equal(limits.allowNetwork, false);
      await writeFile(path.join(limits.workspaceRoot, "src", "answer.ts"), "export const answer = 42;");
      return { stdout: "verified", stderr: "", code: 0 };
    },
  };
  const server = createRemoteSandboxRunnerServer({
    token: TOKEN,
    sandbox,
    tempRoot: path.join(root, "runs"),
    allowNetwork: false,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = "http://127.0.0.1:" + address.port;
  const project = path.join(root, "project");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(project, "src"), { recursive: true }));
  await writeFile(path.join(project, "verify.js"), "console.log('ok')");
  await writeFile(path.join(project, "src", "answer.ts"), "export const answer = 0;");
  try {
    const client = new RemoteSandbox({ endpoint, token: TOKEN });
    const result = await client.run("node", ["verify.js"], {
      timeoutMs: 5_000,
      maxOutputBytes: 8_192,
      allowNetwork: false,
      workspaceRoot: project,
    });
    assert.equal(result.stdout, "verified");
    assert.equal(result.code, 0);
    assert.equal(await readFile(path.join(project, "src", "answer.ts"), "utf8"), "export const answer = 42;");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("remote runner rejects unauthenticated calls and unsafe snapshot paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-runner-auth-test-"));
  const sandbox: Sandbox = {
    isolation: "container",
    async run() { throw new Error("must not execute"); },
  };
  const server = createRemoteSandboxRunnerServer({ token: TOKEN, sandbox, tempRoot: root });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = "http://127.0.0.1:" + address.port + "/v1/sandbox/execute";
  try {
    const unauthorized = await fetch(url, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    const invalidPath = await fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + TOKEN,
        "content-type": "application/json",
        "x-sofia-request-id": requestId,
      },
      body: JSON.stringify({
        protocolVersion: 1,
        requestId,
        workspaceDigest: "a".repeat(64),
        command: "true",
        args: [],
        cwd: ".",
        timeoutMs: 1000,
        maxOutputBytes: 1024,
        allowNetwork: false,
        files: [{ path: "../outside", contentBase64: "eA==" }],
      }),
    });
    assert.equal(invalidPath.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("remote runner refuses network mode without a confirmed egress firewall", () => {
  const sandbox: Sandbox = {
    isolation: "container",
    async run() { return { stdout: "", stderr: "", code: 0 }; },
  };
  assert.throws(
    () => createRemoteSandboxRunnerServer({ token: TOKEN, sandbox, allowNetwork: true }),
    /egress firewall/,
  );
});
