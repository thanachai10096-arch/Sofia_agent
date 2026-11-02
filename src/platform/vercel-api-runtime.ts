import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createSofiaAgentDependencies } from "../models/factory.js";
import { createSofiaApi } from "../api/server.js";
import { FileRunRecordStore } from "../api/run-record-store.js";

let cached:
  | { server: ReturnType<typeof createSofiaApi>; apiKey: string }
  | undefined;

/**
 * One warm-instance Sofia Core for Vercel Node Functions.
 *
 * IMPORTANT: this adapter uses Vercel's writable temporary filesystem only.
 * It is suitable for Preview smoke tests, not durable production jobs or
 * multi-instance persistence. Replace the file stores with shared transactional
 * storage and move long-running execution to Vercel Workflows/Queues before
 * production use.
 */
function getRuntime(): { server: ReturnType<typeof createSofiaApi>; apiKey: string } {
  if (cached) return cached;

  const apiKey = process.env.SOFIA_INTERNAL_API_KEY?.trim();
  if (!apiKey || apiKey.length < 32) {
    throw new Error("SOFIA_INTERNAL_API_KEY must be configured for the Vercel-hosted Sofia Core.");
  }

  const tempRoot = os.tmpdir();
  const workspace = path.resolve(
    process.env.SOFIA_WORKSPACE?.trim() || path.join(tempRoot, "sofia-agent-workspace"),
  );
  const stateRoot = path.resolve(
    process.env.SOFIA_STATE_DIR?.trim() || path.join(tempRoot, "sofia-agent-state"),
  );
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  process.env.SOFIA_STATE_DIR = stateRoot;

  const dependencies = createSofiaAgentDependencies(workspace);
  const runDirectory = path.join(workspace, ".sofia", "api-runs");
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });

  const scopes = (process.env.SOFIA_API_SCOPES || "agent:run,agent:read")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);

  const server = createSofiaApi(dependencies, {
    apiKeys: { [apiKey]: scopes },
    allowedOrigins: (process.env.SOFIA_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    runStore: new FileRunRecordStore(runDirectory),
    usageStorePath: path.join(stateRoot, "api-usage.json"),
  });

  cached = { server, apiKey };
  return cached;
}

/** Dispatch a Vercel /api/v1/* request through Sofia's existing HTTP API router. */
export function handleSofiaVercelRequest(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const runtime = getRuntime();
  const originalUrl = request.url || "/";
  if (originalUrl === "/api/v1") request.url = "/v1";
  else if (originalUrl.startsWith("/api/v1/")) request.url = originalUrl.slice(4);
  runtime.server.emit("request", request, response);
}
