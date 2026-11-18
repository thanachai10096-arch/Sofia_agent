import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContainerSandbox } from "../sandbox.js";
import { SandboxSupervisor } from "./sandbox-supervisor.js";
import { createSandboxTools } from "./sandbox-tools.js";

test("sandbox.exec stages only a sanitized project snapshot and uses host-approved internet", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-sandbox-tool-"));
  const source = path.join(root, "source");
  const supervisorRoot = path.join(root, "supervisor");
  await mkdir(source);
  await mkdir(path.join(source, "src"));
  await writeFile(path.join(source, "src", "index.ts"), "export const answer = 42;");
  await writeFile(path.join(source, ".env"), "SECRET=must-not-copy");
  await writeFile(path.join(source, "private.pem"), "PRIVATE KEY");
  const dockerCalls: string[][] = [];
  const supervisor = new SandboxSupervisor({
    workspaceRoot: supervisorRoot,
    attestationSecret: "test-only-secret-with-at-least-thirty-two-characters",
    sandbox: new ContainerSandbox({
      image: "registry.example/runner@sha256:" + "e".repeat(64),
      runner: async (args) => {
        dockerCalls.push(args);
        return { stdout: "network-enabled", stderr: "", code: 0 };
      },
    }),
    allowNetwork: true,
    budget: {
      maxCycles: 2,
      maxSteps: 4,
      maxToolCallsPerStep: 4,
      maxExperimentSeconds: 30,
      maxSpendUsd: 1,
      maxOutputBytes: 8192,
    },
  });
  const identity = { principalId: "tenant-sandbox", runId: "run-sandbox-tool" };
  let attestation: Awaited<ReturnType<typeof supervisor.beginRun>> | undefined;
  try {
    const [tool] = createSandboxTools({
      supervisor,
      identity,
      sourceWorkspace: source,
      networkAllowed: true,
      getAttestation: async () => attestation ??= await supervisor.beginRun(identity),
    });
    assert.ok(tool);
    const result = await tool.execute(
      { command: "npm", args: ["install"], timeoutMs: 5000 },
      { runtime: {} as never, signal: new AbortController().signal },
    );
    assert.equal((result as { stdout: string }).stdout, "network-enabled");
    const workspace = supervisor.getWorkspacePath(identity, attestation!);
    assert.equal(await readFile(path.join(workspace, "src", "index.ts"), "utf8"), "export const answer = 42;");
    await assert.rejects(() => readFile(path.join(workspace, ".env"), "utf8"));
    await assert.rejects(() => readFile(path.join(workspace, "private.pem"), "utf8"));
    assert.equal(dockerCalls[0]?.[dockerCalls[0]!.indexOf("--network") + 1], "bridge");
  } finally {
    await supervisor.disposeRun(identity).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("sandbox.exec cannot enable network when the host has disabled it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sofia-sandbox-no-network-"));
  const source = path.join(root, "source");
  await mkdir(source);
  const calls: string[][] = [];
  const supervisor = new SandboxSupervisor({
    workspaceRoot: path.join(root, "runs"),
    attestationSecret: "test-only-secret-with-at-least-thirty-two-characters",
    sandbox: new ContainerSandbox({
      image: "registry.example/runner@sha256:" + "f".repeat(64),
      runner: async (args) => {
        calls.push(args);
        return { stdout: "", stderr: "", code: 0 };
      },
    }),
    allowNetwork: false,
    budget: {
      maxCycles: 1,
      maxSteps: 2,
      maxToolCallsPerStep: 2,
      maxExperimentSeconds: 10,
      maxSpendUsd: 0,
      maxOutputBytes: 1024,
    },
  });
  const identity = { principalId: "tenant-sandbox", runId: "offline-run" };
  let attestation: Awaited<ReturnType<typeof supervisor.beginRun>> | undefined;
  try {
    const [tool] = createSandboxTools({
      supervisor,
      identity,
      sourceWorkspace: source,
      networkAllowed: false,
      getAttestation: async () => attestation ??= await supervisor.beginRun(identity),
    });
    assert.ok(tool);
    await tool.execute(
      { command: "npm", args: ["test"] },
      { runtime: {} as never, signal: new AbortController().signal },
    );
    assert.equal(calls[0]?.[calls[0]!.indexOf("--network") + 1], "none");
  } finally {
    await supervisor.disposeRun(identity).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
