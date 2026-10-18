import os from "node:os";
import path from "node:path";
import { createSofiaAgentDependencies } from "../models/factory.js";
import { createSofiaApi } from "./server.js";
import { FileRunRecordStore } from "./run-record-store.js";
import { FileUsageStore } from "./usage.js";

function positiveInteger(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(name + " must be an integer between 1 and " + maximum + ".");
  }
  return value;
}

const token = process.env.SOFIA_API_KEY?.trim();
if (!token) throw new Error("SOFIA_API_KEY must be provided by the deployment secret store.");
const host = process.env.SOFIA_API_HOST?.trim() || "127.0.0.1";
const port = positiveInteger("SOFIA_API_PORT", 3000, 65_535);
const workspace = path.resolve(process.env.SOFIA_WORKSPACE || process.cwd());
const stateDirectory = path.resolve(
  process.env.SOFIA_STATE_DIR || path.join(os.homedir(), ".sofia", "state"),
);
const allowedOrigins = (process.env.SOFIA_ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const scopes = (process.env.SOFIA_API_KEY_SCOPES || "agent:run,agent:read")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const server = createSofiaApi(createSofiaAgentDependencies(workspace), {
  apiKeys: { [token]: scopes },
  allowedOrigins,
  runStore: new FileRunRecordStore(path.join(stateDirectory, "runs")),
  usageStore: new FileUsageStore(path.join(stateDirectory, "usage")),
  maxRunsPerKeyPerDay: positiveInteger("SOFIA_API_MAX_RUNS_PER_KEY_PER_DAY", 100, 1_000_000),
  maxToolCallsPerKeyPerDay: positiveInteger("SOFIA_API_MAX_TOOL_CALLS_PER_KEY_PER_DAY", 1000, 10_000_000),
  maxConcurrentRunsPerKey: positiveInteger("SOFIA_API_MAX_CONCURRENT_RUNS_PER_KEY", 4, 256),
  requestTimeoutMs: positiveInteger("SOFIA_API_REQUEST_TIMEOUT_MS", 120_000, 2_147_483_647),
  readinessCheck: () => true,
});

server.on("error", (error) => {
  console.error(JSON.stringify({ level: "error", event: "api.server_error", errorClass: error.name, code: "code" in error ? error.code : undefined }));
  process.exitCode = 1;
});
server.listen(port, host, () => {
  console.log(JSON.stringify({
    level: "info",
    event: "api.started",
    host,
    port,
    workspace,
    stateDirectory,
    readyPath: "/ready",
  }));
});

const shutdown = (signal: string) => {
  console.log(JSON.stringify({ level: "info", event: "api.shutdown", signal }));
  server.close((error) => {
    if (error) {
      console.error(JSON.stringify({ level: "error", event: "api.shutdown_error", errorClass: error.name }));
      process.exitCode = 1;
    }
  });
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
