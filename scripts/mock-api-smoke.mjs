import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port.");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

const port = await availablePort();
const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "sofia-mock-api-smoke-"));
const token = "mock-api-smoke-token-with-enough-entropy";
const child = spawn(process.execPath, [
  path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
  "examples/mock-api.ts",
], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SOFIA_API_KEY: token,
    SOFIA_API_PORT: String(port),
    SOFIA_STATE_DIR: stateDirectory,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
child.stderr.on("data", (chunk) => { logs += chunk.toString(); });

try {
  const deadline = Date.now() + 10_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Mock API exited before becoming healthy.");
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/health");
      if (response.ok) { healthy = true; break; }
    } catch { /* Wait for the child process to start listening. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(healthy, true, "mock API should start within ten seconds");
  const response = await fetch("http://127.0.0.1:" + port + "/v1/agent/runs", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ task: "smoke test", async: false }),
  });
  assert.equal(response.status, 200, logs);
  const payload = await response.json();
  assert.match(JSON.stringify(payload), /Mock response only/);
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  await rm(stateDirectory, { recursive: true, force: true });
}
