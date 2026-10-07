import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { SofiaAgent } from "../agent/core.js";
import type { AgentDependencies } from "../agent/types.js";
import type { AgentRunInput, AgentRunResponse, SofiaApiConfig } from "./types.js";
import { UsageLimiter } from "./usage.js";

function headers(origin?: string) {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(origin ? { "access-control-allow-origin": origin, "vary": "Origin" } : {}),
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

function json(res: ServerResponse, status: number, body: unknown, origin?: string) {
  res.writeHead(status, headers(origin));
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.from(chunk as Buffer);
    size += b.length;
    if (size > maxBytes) throw new Error("Request body too large.");
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function authenticate(req: IncomingMessage, config: SofiaApiConfig) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !config.apiKeys[token]) return null;
  return { keyId: token, scopes: config.apiKeys[token] };
}

export function createSofiaApi(deps: AgentDependencies, config: SofiaApiConfig) {
  const agent = new SofiaAgent(deps);
  const maxBytes = config.maxBodyBytes ?? 1_000_000;
  const usage = new UsageLimiter(config.maxRunsPerKeyPerDay ?? 100, config.maxToolCallsPerKeyPerDay ?? 1000);

  return createServer(async (req, res) => {
    try {
      const requestOrigin = req.headers.origin;
      const allowedOrigin =
        requestOrigin && (
          config.allowedOrigins?.includes("*") ||
          config.allowedOrigins?.includes(requestOrigin)
        )
          ? requestOrigin
          : undefined;

      if (requestOrigin && config.allowedOrigins && !allowedOrigin) {
        return json(res, 403, { error: "origin_not_allowed" });
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204, headers(allowedOrigin));
        return res.end();
      }

      if (req.method === "GET" && req.url === "/health") {
        return json(res, 200, { ok: true, service: "sofia-agent-api", version: "v1" }, allowedOrigin);
      }

      if (!req.url?.startsWith("/v1/")) return json(res, 404, { error: "not_found" }, allowedOrigin);

      const auth = authenticate(req, config);
      if (!auth) return json(res, 401, { error: "unauthorized" }, allowedOrigin);

      if (req.method === "POST" && req.url === "/v1/agent/runs/stream") {
        const input = (await body(req, maxBytes)) as AgentRunInput;
        if (!input.task?.trim()) return json(res, 400, { error: "task_required" }, allowedOrigin);
        try { usage.consume(auth.keyId); } catch (error) { return json(res, 429, { error: "quota_exceeded" }, allowedOrigin); }
        const id = randomUUID();
        const controller = new AbortController();
        req.on("aborted", () => controller.abort(new Error("Client disconnected.")));
        res.on("close", () => {
          if (!res.writableEnded) controller.abort(new Error("Client disconnected."));
        });
        res.writeHead(200, { ...headers(), "content-type": "text/event-stream; charset=utf-8", "connection": "keep-alive" });
        const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        try {
          const result = await agent.run({
            task: input.task,
            ...(input.context
              ? {
                  context:
                    typeof input.context === "string"
                      ? input.context
                      : JSON.stringify(input.context),
                }
              : {}),
            ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
            signal: controller.signal,
            ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
            onEvent: (event) => send({ type: "event", runId: id, event }),
          });
          send({ type: "result", runId: id, status: "completed", result });
        } catch (error) {
          send({ type: "error", runId: id, status: "failed", error: error instanceof Error ? error.message : "Agent failed" });
        }
        send({ type: "done", runId: id });
        return res.end();
      }

      if (req.method === "POST" && req.url === "/v1/agent/runs") {
        const input = (await body(req, maxBytes)) as AgentRunInput;
        if (!input.task?.trim()) return json(res, 400, { error: "task_required" }, allowedOrigin);

        const id = randomUUID();
        const controller = new AbortController();
        req.on("aborted", () => controller.abort(new Error("Client disconnected.")));
        res.on("close", () => {
          if (!res.writableEnded) controller.abort(new Error("Client disconnected."));
        });
        try { usage.consume(auth.keyId); } catch (error) { return json(res, 429, { error: "quota_exceeded", message: error instanceof Error ? error.message : "Quota exceeded" }, allowedOrigin); }
        try {
          const result = await agent.run({
            task: input.task,
            ...(input.context
              ? {
                  context:
                    typeof input.context === "string"
                      ? input.context
                      : JSON.stringify(input.context),
                }
              : {}),
            ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
            signal: controller.signal,
            ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
          });
          const response: AgentRunResponse = { id, status: "completed", result };
          return json(res, 200, response, allowedOrigin);
        } catch (error) {
          const response: AgentRunResponse = {
            id,
            status: "failed",
            error: error instanceof Error ? error.message : "Agent failed",
          };
          return json(res, 502, response, allowedOrigin);
        }
      }

      if (req.method === "GET" && req.url.startsWith("/v1/usage")) return json(res, 200, usage.get(auth.keyId), allowedOrigin);
      return json(res, 404, { error: "not_found" }, allowedOrigin);
    } catch (error) {
      return json(res, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}
