import { ContainerSandbox } from "../sandbox.js";
import { createRemoteSandboxRunnerServer } from "./remote-runner-server.js";
import { LinuxQuotaWorkspaceProvisioner } from "./linux-quota-workspace-provisioner.js";

const image = process.env.SOFIA_RUNNER_SANDBOX_IMAGE?.trim();
const token = process.env.SOFIA_REMOTE_SANDBOX_TOKEN;
const quotaHelper = process.env.SOFIA_RUNNER_QUOTA_HELPER?.trim();
const tempRoot = process.env.SOFIA_RUNNER_TEMP_ROOT?.trim();
const maxWorkspaceBytes = Number(process.env.SOFIA_RUNNER_MAX_WORKSPACE_BYTES ?? 536870912);
if (!image) throw new Error("SOFIA_RUNNER_SANDBOX_IMAGE is required.");
if (!token) throw new Error("SOFIA_REMOTE_SANDBOX_TOKEN is required.");
if (!quotaHelper) throw new Error("SOFIA_RUNNER_QUOTA_HELPER is required.");
if (!tempRoot) throw new Error("SOFIA_RUNNER_TEMP_ROOT must point to a dedicated quota-enabled filesystem root.");

const server = createRemoteSandboxRunnerServer({
  token,
  sandbox: new ContainerSandbox({ image }),
  tempRoot,
  workspaceProvisioner: new LinuxQuotaWorkspaceProvisioner({
    helperPath: quotaHelper,
    workspaceRoot: tempRoot,
    maxWorkspaceBytes,
  }),
  maxConcurrentRuns: Number(process.env.SOFIA_RUNNER_MAX_CONCURRENCY ?? 2),
  maxRequestBytes: Number(process.env.SOFIA_RUNNER_MAX_REQUEST_BYTES ?? 146800640),
  maxSnapshotBytes: Number(process.env.SOFIA_RUNNER_MAX_SNAPSHOT_BYTES ?? 104857600),
  maxTimeoutMs: Number(process.env.SOFIA_RUNNER_MAX_TIMEOUT_MS ?? 300000),
  allowNetwork: process.env.SOFIA_RUNNER_ALLOW_NETWORK === "true",
  publicInternetEgressEnforced: process.env.SOFIA_RUNNER_PUBLIC_EGRESS_ENFORCED === "true",
  // The helper must be installed and configured by the dedicated Linux host operator.
});

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");
server.listen(port, "0.0.0.0");

const shutdown = () => {
  server.close((error) => {
    if (error) process.exitCode = 1;
  });
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
