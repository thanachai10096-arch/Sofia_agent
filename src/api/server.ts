import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { SofiaAgent } from "../agent/core.js";
import type { AgentDependencies } from "../agent/types.js";
import type { AgentRunInput, AgentRunResponse, SofiaApiConfig } from "./types.js";

function headers() {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, headers());
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

  return createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, headers());
        return res.end();
      }

      if (req.method === "GET" && req.url === "/health") {
        return json(res, 200, { ok: true, service: "sofia-agent-api", version: "v1" });
      }

      if (!req.url?.startsWith("/v1/")) return json(res, 404, { error: "not_found" });

      const auth = authenticate(req, config);
      if (!auth) return json(res, 401, { error: "unauthorized" });

      if (req.method === "POST" && req.url === "/v1/agent/runs") {
        const input = (await body(req, maxBytes)) as AgentRunInput;
        if (!input.task?.trim()) return json(res, 400, { error: "task_required" });

        const id = randomUUID();
        try {
          const result = await agent.run({
            task: input.task,
            ...(input.context ? { context: input.context } : {}),
            ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
          });
          const response: AgentRunResponse = { id, status: "completed", result };
          return json(res, 200, response);
        } catch (error) {
          const response: AgentRunResponse = {
            id,
            status: "failed",
            error: error instanceof Error ? error.message : "Agent failed",
          };
          return json(res, 502, response);
        }
      }

      return json(res, 404, { error: "not_found" });
    } catch (error) {
      return json(res, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}
