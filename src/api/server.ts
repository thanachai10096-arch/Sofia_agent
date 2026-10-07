import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { SofiaAgent } from "../agent/core.js";
import type { AgentDependencies } from "../agent/types.js";
import type { AgentRunInput, AgentRunResponse, AgentRunStatus, SofiaApiConfig } from "./types.js";
import { UsageLimiter } from "./usage.js";

interface ActiveRun {
  id: string;
  status: AgentRunStatus;
  result?: AgentRunResponse["result"];
  error?: string;
  controller: AbortController;
  createdAt: number;
  updatedAt: number;
}

function headers(origin: string | undefined, config: SofiaApiConfig) {
  const allowed = config.allowedOrigins;
  const allowOrigin =
    !allowed?.length || allowed.includes("*")
      ? "*"
      : origin && allowed.includes(origin)
        ? origin
        : allowed[0];
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-expose-headers": "retry-after",
    vary: "Origin",
  };
}

function json(res: ServerResponse, status: number, body: unknown, origin: string | undefined, config: SofiaApiConfig) {
  res.writeHead(status, headers(origin, config));
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

function pathId(url: string): string | null {
  const match = url.match(/^\/v1\/agent\/runs\/([^/?]+)$/);
  return match?.[1] ?? null;
}

export function createSofiaApi(deps: AgentDependencies, config: SofiaApiConfig) {
  const agent = new SofiaAgent(deps);
  const maxBytes = config.maxBodyBytes ?? 1_000_000;
  const usage = new UsageLimiter(config.maxRunsPerKeyPerDay ?? 100, config.maxToolCallsPerKeyPerDay ?? 1000);
  const runs = new Map<string, ActiveRun>();
  const retention = config.runRetentionMs ?? 24 * 60 * 60 * 1000;

  const publicResponse = (run: ActiveRun): AgentRunResponse => ({
    id: run.id,
    status: run.status,
    ...(run.result ? { result: run.result } : {}),
    ...(run.error ? { error: run.error } : {}),
  });

  const startRun = (run: ActiveRun, input: AgentRunInput) => {
    void (async () => {
      run.status = "running";
      run.updatedAt = Date.now();
      try {
        run.result = await agent.run({
          task: input.task,
          ...(input.context ? { context: input.context } : {}),
          ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
          signal: run.controller.signal,
        });
        run.status = "completed";
      } catch (error) {
        if (run.controller.signal.aborted) {
          run.status = "cancelled";
          run.error = "Run cancelled.";
        } else {
          run.status = "failed";
          run.error = error instanceof Error ? error.message : "Agent failed";
        }
      } finally {
        run.updatedAt = Date.now();
      }
    })();
  };

  const prune = () => {
    const cutoff = Date.now() - retention;
    for (const [id, run] of runs) {
      if (run.updatedAt < cutoff && !["queued", "running"].includes(run.status)) runs.delete(id);
    }
  };

  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    try {
      prune();

      if (req.method === "OPTIONS") {
        res.writeHead(204, headers(origin, config));
        return res.end();
      }

      if (req.method === "GET" && req.url === "/health") {
        return json(res, 200, {
          ok: true,
          service: "sofia-agent-api",
          version: "v1",
          capabilities: { mobile: true, asyncRuns: true, stream: true },
        }, origin, config);
      }

      if (!req.url?.startsWith("/v1/")) return json(res, 404, { error: "not_found" }, origin, config);

      const auth = authenticate(req, config);
      if (!auth) return json(res, 401, { error: "unauthorized" }, origin, config);

      const id = pathId(req.url);
      if (id && req.method === "GET") {
        const run = runs.get(id);
        if (!run) return json(res, 404, { error: "run_not_found" }, origin, config);
        return json(res, 200, publicResponse(run), origin, config);
      }

      if (id && req.method === "DELETE") {
        const run = runs.get(id);
        if (!run) return json(res, 404, { error: "run_not_found" }, origin, config);
        if (run.status === "queued" || run.status === "running") {
          run.controller.abort();
          run.status = "cancelled";
          run.updatedAt = Date.now();
        }
        return json(res, 200, publicResponse(run), origin, config);
      }

      if (req.method === "POST" && req.url === "/v1/agent/runs/stream") {
        const input = (await body(req, maxBytes)) as AgentRunInput;
        if (!input.task?.trim()) return json(res, 400, { error: "task_required" }, origin, config);
        try { usage.consume(auth.keyId); } catch {
          return json(res, 429, { error: "quota_exceeded" }, origin, config);
        }
        const runId = randomUUID();
        const controller = new AbortController();
        const run: ActiveRun = { id: runId, status: "queued", controller, createdAt: Date.now(), updatedAt: Date.now() };
        runs.set(runId, run);
        res.writeHead(200, {
          ...headers(origin, config),
          "content-type": "text/event-stream; charset=utf-8",
          connection: "keep-alive",
        });
        const send = (event: unknown) => {
          if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\\n\\n`);
        };
        try {
          run.status = "running";
          run.result = await agent.run({
            task: input.task,
            ...(input.context ? { context: input.context } : {}),
            ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
            signal: controller.signal,
            onEvent: (event) => send({ type: "event", runId, event }),
          });
          run.status = "completed";
          send({ type: "result", runId, status: "completed", result: run.result });
        } catch (error) {
          run.status = controller.signal.aborted ? "cancelled" : "failed";
          run.error = controller.signal.aborted ? "Run cancelled." : error instanceof Error ? error.message : "Agent failed";
          send({ type: "error", runId, status: run.status, error: run.error });
        }
        send({ type: "done", runId });
        run.updatedAt = Date.now();
        return res.end();
      }

      if (req.method === "POST" && req.url === "/v1/agent/runs") {
        const input = (await body(req, maxBytes)) as AgentRunInput;
        if (!input.task?.trim()) return json(res, 400, { error: "task_required" }, origin, config);

        try { usage.consume(auth.keyId); } catch (error) {
          return json(res, 429, { error: "quota_exceeded", message: error instanceof Error ? error.message : "Quota exceeded" }, origin, config);
        }

        // Async mode is the reliable path for phones: the browser may sleep,
        // change networks, or be backgrounded while Sofia continues server-side.
        if (input.async) {
          const runId = randomUUID();
          const run: ActiveRun = {
            id: runId,
            status: "queued",
            controller: new AbortController(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          runs.set(runId, run);
          startRun(run, input);
          return json(res, 202, publicResponse(run), origin, config);
        }

        const controller = new AbortController();
        const runId = randomUUID();
        try {
          const result = await agent.run({
            task: input.task,
            ...(input.context ? { context: input.context } : {}),
            ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
            signal: controller.signal,
          });
          return json(res, 200, { id: runId, status: "completed", result }, origin, config);
        } catch (error) {
          return json(res, 502, {
            id: runId,
            status: "failed",
            error: error instanceof Error ? error.message : "Agent failed",
          }, origin, config);
        }
      }

      if (req.method === "GET" && req.url.startsWith("/v1/usage")) {
        return json(res, 200, usage.get(auth.keyId), origin, config);
      }

      return json(res, 404, { error: "not_found" }, origin, config);
    } catch (error) {
      return json(res, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Unknown error",
      }, origin, config);
    }
  });
}
