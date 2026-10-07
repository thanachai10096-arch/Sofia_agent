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
  ownerKeyId: string;
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

function normalizeContext(context: AgentRunInput["context"]): string | undefined {
  if (context === undefined) return undefined;
  return typeof context === "string" ? context : JSON.stringify(context);
}

function normalizeAcceptanceCriteria(input: AgentRunInput["acceptanceCriteria"]) {
  return input?.map((criterion) => ({
    id: criterion.id,
    description: criterion.description,
    probe: criterion.probe,
    evaluate: (value: unknown) => ({
      passed: Boolean((value as { passed?: unknown })?.passed),
      detail: "API acceptance probe",
    }),
  }));
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
  const idempotency = new Map<string, string>();
  const activeByKey = new Map<string, number>();
  const requestTimeoutMs = config.requestTimeoutMs ?? 120_000;
  const maxConcurrentRunsPerKey = config.maxConcurrentRunsPerKey ?? 4;
  const retention = config.runRetentionMs ?? 24 * 60 * 60 * 1000;
  let lastPruneAt = 0;

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
      const timer = setTimeout(() => run.controller.abort(), requestTimeoutMs);
      try {
        run.result = await agent.run({
          task: input.task,
          ...(input.context !== undefined ? { context: typeof input.context === "string" ? input.context : JSON.stringify(input.context) } : {}),
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
        clearTimeout(timer);
        run.updatedAt = Date.now();
        const current = activeByKey.get(run.ownerKeyId) ?? 1;
        if (current <= 1) activeByKey.delete(run.ownerKeyId); else activeByKey.set(run.ownerKeyId, current - 1);
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
      if (Date.now() - lastPruneAt > 30_000) { lastPruneAt = Date.now(); prune(); }

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
        if (!run || run.ownerKeyId !== auth.keyId) return json(res, 404, { error: "run_not_found" }, origin, config);
        return json(res, 200, publicResponse(run), origin, config);
      }

      if (id && req.method === "DELETE") {
        const run = runs.get(id);
        if (!run || run.ownerKeyId !== auth.keyId) return json(res, 404, { error: "run_not_found" }, origin, config);
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
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        const run: ActiveRun = { id: runId, status: "queued", controller, createdAt: Date.now(), updatedAt: Date.now(), ownerKeyId: auth.keyId };
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
            ...(input.context !== undefined ? { context: typeof input.context === "string" ? input.context : JSON.stringify(input.context) } : {}),
            ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
            ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
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
        clearTimeout(timer);
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
          const header = req.headers["idempotency-key"];
          const idempotencyKey = Array.isArray(header) ? header[0] : header;
          const idempotencyId = idempotencyKey ? `${auth.keyId}:${idempotencyKey}` : undefined;
          if (idempotencyId) {
            const existing = idempotency.get(idempotencyId);
            const existingRun = existing ? runs.get(existing) : undefined;
            if (existingRun) return json(res, 200, publicResponse(existingRun), origin, config);
          }
          const active = activeByKey.get(auth.keyId) ?? 0;
          if (active >= maxConcurrentRunsPerKey) {
            res.setHeader("retry-after", "2");
            return json(res, 429, { error: "concurrency_limit", retryAfterMs: 2000 }, origin, config);
          }
          const runId = randomUUID();
          const run: ActiveRun = {
            id: runId,
            status: "queued",
            controller: new AbortController(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ownerKeyId: auth.keyId,
          };
          runs.set(runId, run);
          if (idempotencyId) idempotency.set(idempotencyId, runId);
          activeByKey.set(auth.keyId, active + 1);
          startRun(run, {
            ...input,
            ...(input.context !== undefined
              ? { context: typeof input.context === "string" ? input.context : JSON.stringify(input.context) }
              : {}),
            ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
          });
          return json(res, 202, publicResponse(run), origin, config);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        const runId = randomUUID();
        try {
          const result = await agent.run({
            task: input.task,
            ...(input.context !== undefined ? { context: typeof input.context === "string" ? input.context : JSON.stringify(input.context) } : {}),
            ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
            ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
            signal: controller.signal,
          });
          return json(res, 200, { id: runId, status: "completed", result }, origin, config);
        } catch (error) {
          return json(res, 502, {
            id: runId,
            status: "failed",
            error: controller.signal.aborted ? "Request timed out or was cancelled." : error instanceof Error ? error.message : "Agent failed",
          }, origin, config);
        } finally {
          clearTimeout(timer);
        }
      }

      const jobMatch = req.url.match(/^\/v1\/jobs\/([^/]+)(?:\/(resume|cancel))?$/);
      if (jobMatch && deps.jobRuntime) {
        const jobId = jobMatch[1];
        const action = jobMatch[2];
        const job = await deps.jobRuntime.get(jobId);
        if (!job || job.ownerKeyId !== auth.keyId) {
          return json(res, 404, { error: "job_not_found" }, origin, config);
        }
        if (req.method === "GET" && !action) {
          return json(res, 200, job, origin, config);
        }
        if (req.method === "POST" && action === "resume") {
          try { return json(res, 202, await deps.jobRuntime.resume(jobId), origin, config); }
          catch (error) { return json(res, 409, { error: "job_resume_failed", message: error instanceof Error ? error.message : "Resume failed" }, origin, config); }
        }
        if (req.method === "POST" && action === "cancel") {
          const cancelled = await deps.jobRuntime.cancel(jobId);
          return cancelled ? json(res, 202, { id: jobId, status: "cancelled" }, origin, config) : json(res, 409, { error: "job_not_running" }, origin, config);
        }
      }

      if (req.method === "GET" && req.url === "/v1/jobs") {
        if (!deps.jobRuntime) return json(res, 503, { error: "job_runtime_unavailable" }, origin, config);
        const jobs = (await deps.jobRuntime.list()).filter((item) => item.ownerKeyId === auth.keyId);
        return json(res, 200, { jobs }, origin, config);
      }

      if (req.method === "POST" && req.url === "/v1/jobs") {
        if (!deps.jobRuntime) return json(res, 503, { error: "job_runtime_unavailable" }, origin, config);
        const input = (await body(req, maxBytes)) as AgentRunInput;
        if (!input.task?.trim()) return json(res, 400, { error: "task_required" }, origin, config);
        try { usage.consume(auth.keyId); } catch { return json(res, 429, { error: "quota_exceeded" }, origin, config); }
        try {
          const job = await deps.jobRuntime.submit({
            task: input.task,
            ownerKeyId: auth.keyId,
            ...(normalizeAcceptanceCriteria(input.acceptanceCriteria)?.length ? { acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria) } : {}),
          });
          return json(res, 202, job, origin, config);
        } catch (error) {
          return json(res, 502, { error: "job_submit_failed", message: error instanceof Error ? error.message : "Job submission failed" }, origin, config);
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
