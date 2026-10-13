import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContainerSandbox } from "../dist/sandbox.js";

const image = process.env.SOFIA_SANDBOX_IMAGE;
if (!image || !/@sha256:[a-f0-9]{64}$/i.test(image)) {
  throw new Error("SOFIA_SANDBOX_IMAGE must be a preloaded SHA-256-pinned image.");
}

const parent = await mkdtemp(path.join(os.tmpdir(), "sofia-container-live-smoke-"));
const workspaceRoot = path.join(parent, "workspace");
await import("node:fs/promises").then(({ mkdir }) => mkdir(workspaceRoot));
const hostSecret = path.join(parent, "host-secret.txt");
await writeFile(hostSecret, "host-only-secret");
const sandbox = new ContainerSandbox({ image });
const limits = {
  workspaceRoot,
  timeoutMs: 15_000,
  maxOutputBytes: 128 * 1024,
  allowNetwork: false,
};

try {
  const probe = [
    "const fs = require('node:fs');",
    "const status = fs.readFileSync('/proc/self/status', 'utf8');",
    "const cap = status.match(/^CapEff:\\s+([0-9a-f]+)$/m)?.[1] ?? '';",
    "const noNewPrivs = status.match(/^NoNewPrivs:\\s+(\\d+)$/m)?.[1] ?? '';",
    "process.stdout.write(JSON.stringify({ cwd: process.cwd(), cap, noNewPrivs }));",
  ].join(" ");
  const security = await sandbox.run("node", ["-e", probe], limits);
  assert.equal(security.code, 0, security.stderr);
  const status = JSON.parse(security.stdout);
  assert.equal(status.cwd, "/workspace");
  assert.match(status.cap, /^0+$/);
  assert.equal(status.noNewPrivs, "1");

  const write = await sandbox.run("node", ["-e", "require('node:fs').writeFileSync('/workspace/created.txt', 'workspace-write-ok')"], limits);
  assert.equal(write.code, 0, write.stderr);
  assert.equal(await readFile(path.join(workspaceRoot, "created.txt"), "utf8"), "workspace-write-ok");

  const outsideRead = await sandbox.run("node", ["-e", "require('node:fs').readFileSync(process.argv[1], 'utf8')", hostSecret], limits);
  assert.notEqual(outsideRead.code, 0, "container unexpectedly read a host file outside the workspace mount");

  const rootWrite = await sandbox.run("node", ["-e", "try { require('node:fs').writeFileSync('/sofia-rootfs-write-test', 'bad'); process.exit(1) } catch { process.exit(0) }"], limits);
  assert.equal(rootWrite.code, 0, "container root filesystem was unexpectedly writable");

  const networkProbe = "const net=require('node:net');const s=net.connect({host:'1.1.1.1',port:443});s.setTimeout(1500);s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));s.on('timeout',()=>process.exit(0));setTimeout(()=>process.exit(0),2500)";
  const network = await sandbox.run("node", ["-e", networkProbe], limits);
  assert.equal(network.code, 0, "container established an outbound TCP connection despite network=none");

  process.stdout.write("Docker container isolation smoke passed: capabilities dropped, no-new-privileges active, workspace writable, host file outside workspace inaccessible, rootfs read-only, outbound TCP blocked.\n");
} finally {
  await rm(parent, { recursive: true, force: true });
}
