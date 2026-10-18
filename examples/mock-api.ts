import os from "node:os";
import path from "node:path";
import { createSofiaApi } from "../src/api/server.js";
import { FileRunRecordStore } from "../src/api/run-record-store.js";
import { FileUsageStore } from "../src/api/usage.js";
import { loadExecutionPolicyFromEnv } from "../src/security/policy.js";
import type { AgentDependencies } from "../src/agent/types.js";
import type { ModelProvider, ModelRoute } from "../src/models/types.js";

const token = process.env.SOFIA_API_KEY;
if (!token) throw new Error("Set SOFIA_API_KEY to a high-entropy test token before starting the mock API.");

const route: ModelRoute = {
  id: "mock",
  capabilities: ["fast", "reasoning"],
  costWeight: 0,
  latencyWeight: 0,
  qualityWeight: 0,
  healthy: true,
};
const provider: ModelProvider = {
  async generate(request) {
    const output = "Mock response only. No external model was called. Task received: " + request.task;
    return {
      text: output,
      assistantMessage: { role: "assistant", content: output },
    };
  },
};
const dependencies: AgentDependencies = {
  provider,
  router: { select: () => route, markUnhealthy: () => undefined },
  reviewer: { async review() { return { approved: true, reason: "Deterministic mock review." }; } },
  policy: loadExecutionPolicyFromEnv(),
};

const stateDirectory = path.resolve(process.env.SOFIA_STATE_DIR || path.join(os.tmpdir(), "sofia-mock-api-state"));
const server = createSofiaApi(dependencies, {
  apiKeys: { [token]: ["agent:run", "agent:read"] },
  allowedOrigins: [],
  runStore: new FileRunRecordStore(path.join(stateDirectory, "runs")),
  usageStore: new FileUsageStore(path.join(stateDirectory, "usage")),
  readinessCheck: () => true,
});
const port = Number(process.env.SOFIA_API_PORT || "3000");
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("SOFIA_API_PORT must be a valid TCP port.");
server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ level: "info", event: "mock_api.started", host: "127.0.0.1", port }));
});
process.once("SIGINT", () => server.close());
process.once("SIGTERM", () => server.close());
