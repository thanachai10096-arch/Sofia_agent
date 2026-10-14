import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { SofiaAgent } from "../agent/core.js";
import type { AgentDependencies } from "../agent/types.js";
import type { DesktopCapability } from "../desktop/types.js";
import type { AgentRunInput, AgentRunResponse, AgentRunStatus, SofiaApiConfig } from "./types.js";
import { UsageLimiter } from "./usage.js";
import { validateAgentRunInput } from "./validation.js";
import type { RunRecord } from "./run-record-store.js";

interface ActiveRun {
  id: string;
  status: AgentRunStatus;
  result?: AgentRunResponse["result"];
  error?: string;
  controller: AbortController;
  createdAt: number;
  updatedAt: number;
  ownerKeyId: string;
  desktopCapabilities: DesktopCapability[];
}

function headers(origin: string | undefined, config: SofiaApiConfig) {
  const allowed = config.allowedOrigins;
  const allowOrigin =
    allowed?.includes("*")
      ? "*"
      : origin && allowed?.includes(origin)
        ? origin
        : undefined;
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(allowOrigin ? { "access-control-allow-origin": allowOrigin } : {}),
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
  // Reject inherited object properties and malformed scope values.
  if (!token || !Object.prototype.hasOwnProperty.call(config.apiKeys, token)) return null;
  const scopes = config.apiKeys[token];
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) return null;
  return { keyId: createHash("sha256").update(token).digest("hex").slice(0, 32), scopes };
}

function desktopCapabilitiesFromScopes(scopes: readonly string[]): DesktopCapability[] {
  const mapping: Record<string, DesktopCapability> = {
    "desktop:discover": "system:discover",
    "desktop:workspace:list": "workspace:list",
    "desktop:workspace:read": "workspace:read",
    "desktop:workspace:write": "workspace:write",
    "desktop:process:execute": "process:execute",
  };
  return [...new Set(scopes.map((scope) => mapping[scope]).filter((capability): capability is DesktopCapability => capability !== undefined))];
}

function normalizeContext(context: AgentRunInput["context"]): string | undefined {
  if (context === undefined) return undefined;
  return typeof context === "string" ? context : JSON.stringify(context);
}

function normalizeAcceptanceCriteria(input: AgentRunInput["acceptanceCriteria"]): import("../brain/types.js").AcceptanceCriterion[] | undefined {
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

function integerSetting(
  name: string,
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error("Invalid Sofia API configuration: " + name + " must be an integer between " + minimum + " and " + maximum + ".");
  }
  return resolved;
}

function pathId(url: string): string | null {
  const match = url.match(/^\/v1\/agent\/runs\/([^/?]+)$/);
  return match?.[1] ?? null;
}

export function createSofiaApi(deps: AgentDependencies, config: SofiaApiConfig) {
  const agent = new SofiaAgent(deps);
  const maxBytes = integerSetting("maxBodyBytes", config.maxBodyBytes, 1_000_000, 1, 10_000_000);
  const maxRunsPerKeyPerDay = integerSetting("maxRunsPerKeyPerDay", config.maxRunsPerKeyPerDay, 100, 0, 1_000_000);
  const maxToolCallsPerKeyPerDay = integerSetting("maxToolCallsPerKeyPerDay", config.maxToolCallsPerKeyPerDay, 1000, 0, 1_000_000);
  const usage = new UsageLimiter(maxRunsPerKeyPerDay, maxToolCallsPerKeyPerDay);
  const runs = new Map<string, ActiveRun>();
  const runStore = config.runStore;
  const persist = (run: ActiveRun) => {
    if (!runStore) return;
    const record: RunRecord = {
      id: run.id, status: run.status,
      ...(run.result ? { result: run.result as unknown as import("../agent/types.js").AgentResult } : {}),
      ...(run.error ? { error: run.error } : {}), createdAt: run.createdAt, updatedAt: run.updatedAt,
      ownerKeyId: run.ownerKeyId, desktopCapabilities: [...run.desktopCapabilities],
    };
    void runStore.save(record);
  };
  if (runStore) for (const record of runStore.loadAllSync()) {
    const interrupted = record.status === "queued" || record.status === "running";
    const validStatus = ["queued","running","completed","failed","cancelled"].includes(record.status);
    if (!validStatus || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt) ||
        !Array.isArray(record.desktopCapabilities) || !record.desktopCapabilities.every((x) => typeof x === "string")) {
      void runStore.remove(record.id); continue;
    }
    const run: ActiveRun = {
      id: record.id, status: interrupted ? "failed" : record.status,
      ...(record.result ? { result: record.result as unknown as AgentRunResponse["result"] } : {}),
      ...(interrupted ? { error: "Run interrupted by server restart." } : record.error ? { error: record.error } : {}),
      controller: new AbortController(), createdAt: record.createdAt,
      updatedAt: interrupted ? Date.now() : record.updatedAt, ownerKeyId: record.ownerKeyId,
      desktopCapabilities: record.desktopCapabilities as DesktopCapability[],
    };
    runs.set(run.id, run); if (interrupted) persist(run);
  }
  const idempotency = new Map<string, string>();
  const activeByKey = new Map<string, number>();
  const requestTimeoutMs = integerSetting("requestTimeoutMs", config.requestTimeoutMs, 120_000, 1, 2_147_483_647);
  const maxConcurrentRunsPerKey = integerSetting("maxConcurrentRunsPerKey", config.maxConcurrentRunsPerKey, 4, 0, 256);
  const retention = integerSetting("runRetentionMs", config.runRetentionMs, 24 * 60 * 60 * 1000, 0, 365 * 24 * 60 * 60 * 1000);
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
      persist(run);
      const timer = setTimeout(() => run.controller.abort(), requestTimeoutMs);
      try {
        const result = await agent.run({
          principalId: run.ownerKeyId,
          desktopCapabilities: run.desktopCapabilities,
          task: input.task,
          ...(input.context !== undefined ? { context: typeof input.context === "string" ? input.context : JSON.stringify(input.context) } : {}),
          ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
          ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria) } : {}),
          signal: run.controller.signal,
        });
        if (run.controller.signal.aborted) {
          run.status = "cancelled";
          run.error ??= "Run cancelled.";
        } else {
          run.result = result;
          run.status = "completed";
        }
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
        persist(run);
        const current = activeByKey.get(run.ownerKeyId) ?? 1;
        if (current <= 1) activeByKey.delete(run.ownerKeyId); else activeByKey.set(run.ownerKeyId, current - 1);
      }
    })();
  };

  const prune = () => {
    const cutoff = Date.now() - retention;
    for (const [id, run] of runs) {
      if (run.updatedAt < cutoff && !["queued", "running"].includes(run.status)) { runs.delete(id); if (runStore) void runStore.remove(id); }
    }
    for (const [key, runId] of idempotency) {
      if (!runs.has(runId)) idempotency.delete(key);
    }
  };

  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    try {
      if (Date.now() - lastPruneAt > 30_000) { lastPruneAt = Date.now(); prune(); }

      if (req.method === "OPTIONS") {
        const allowed = config.allowedOrigins;
        if (origin && allowed?.length && !allowed.includes("*") && !allowed.includes(origin)) {
          res.writeHead(403, { "cache-control": "no-store", vary: "Origin" });
          return res.end();
        }
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

      const parsedUrl = new URL(req.url ?? "/", "http://sofia.local");
      const pathname = parsedUrl.pathname;
      const isMemoryRead = req.method === "GET" && pathname === "/v1/memory";
      const isMemoryMutation = req.method === "DELETE" &&
        (pathname === "/v1/memory" || /^\\/v1\\/memory\\/[^/]+$/.test(pathname));
      if (isMemoryRead && !auth.scopes.some((scope) => scope === "agent:read" || scope === "agent:run")) {
        return json(res, 403, { error: "forbidden", requiredScope: "agent:read" }, origin, config);
      }
      if (isMemoryMutation && !auth.scopes.includes("agent:run")) {
        return json(res, 403, { error: "forbidden", requiredScope: "agent:run" }, origin, config);
      }

      // Authorization scopes are enforced at the API boundary, not merely used to
      // derive desktop capabilities. Admin scopes do not implicitly grant run access.
      const isRunRequest = req.method === "POST" && (req.url === "/v1/agent/runs" || req.url === "/v1/agent/runs/stream" || req.url === "/v1/jobs");
      if (isRunRequest && !auth.scopes.includes("agent:run")) {
        return json(res, 403, { error: "forbidden", requiredScope: "agent:run" }, origin, config);
      }
      const isJobReadRequest = req.method === "GET" && (req.url === "/v1/jobs" || (req.url?.startsWith("/v1/jobs/") === true && !req.url.endsWith("/resume") && !req.url.endsWith("/cancel")));
      if (isJobReadRequest && !auth.scopes.some((scope) => scope === "agent:read" || scope === "agent:run")) {
        return json(res, 403, { error: "forbidden", requiredScope: "agent:read" }, origin, config);
      }
      const isRunRead = req.method === "GET" && pathId(req.url ?? "") !== null;
      if (isRunRead && !auth.scopes.some((scope) => scope === "agent:read" || scope === "agent:run")) {
        return json(res, 403, { error: "forbidden", requiredScope: "agent:read" }, origin, config);
      }
      const isRunCancellation = req.method === "DELETE" && pathId(req.url ?? "") !== null;
      if (isRunCancellation && !auth.scopes.includes("agent:run")) {
        return json(res, 403, { error: "forbidden", requiredScope: "agent:run" }, origin, config);
      }
      const isJobMutation = req.method === "POST" && req.url?.startsWith("/v1/jobs/") === true && (req.url.endsWith("/resume") || req.url.endsWith("/cancel"));
      if (isJobMutation && !auth.scopes.includes("agent:run")) {
        return json(res, 403, { error: "forbidden", requiredScope: "agent:run" }, origin, config);
      }

      if (isMemoryRead) {
        if (!deps.userMemory) return json(res, 503, { error: "user_memory_unavailable" }, origin, config);
        const query = parsedUrl.searchParams.get("q")?.slice(0, 200) ?? "";
        const entries = query
          ? await deps.userMemory.find(auth.keyId, query, 20)
          : await deps.userMemory.list(auth.keyId);
        return json(res, 200, {
          entries: [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50),
        }, origin, config);
      }
      if (isMemoryMutation) {
        if (!deps.userMemory) return json(res, 503, { error: "user_memory_unavailable" }, origin, config);
        if (pathname === "/v1/memory") {
          await deps.userMemory.clear(auth.keyId);
          return json(res, 200, { ok: true, cleared: true }, origin, config);
        }
        let memoryId: string;
        try {
          memoryId = decodeURIComponent(pathname.slice("/v1/memory/".length));
        } catch {
          return json(res, 400, { error: "invalid_memory_id" }, origin, config);
        }
        const deleted = await deps.userMemory.delete(auth.keyId, memoryId);
        if (!deleted) return json(res, 404, { error: "memory_not_found" }, origin, config);
        return json(res, 200, { ok: true, deleted: true }, origin, config);
      }

      const adminScope = config.securityAdminScope ?? "security:admin";
      const isSecurityAdmin = auth.scopes.includes(adminScope);
      if (req.method === "GET" && req.url === "/v1/learning/diagnostics") {
        if (!isSecurityAdmin) return json(res, 403, { error: "forbidden" }, origin, config);
        if (!deps.learningDiagnostics) return json(res, 503, { error: "learning_diagnostics_unavailable" }, origin, config);
        return json(res, 200, deps.learningDiagnostics(), origin, config);
      }
      if (req.method === "GET" && req.url === "/v1/security/status") {
        if (!isSecurityAdmin) return json(res, 403, { error: "forbidden" }, origin, config);
        return json(res, 200, {
          ...deps.securityController?.status?.(),
          auditEvents: deps.securityAudit && "list" in deps.securityAudit ? (deps.securityAudit as { list: () => unknown[] }).list().length : 0,
        }, origin, config);
      }
      if (req.method === "POST" && req.url === "/v1/security/kill") {
        if (!isSecurityAdmin) return json(res, 403, { error: "forbidden" }, origin, config);
        const input = (await body(req, maxBytes)) as { reason?: unknown };
        deps.securityController?.kill(typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : "Security administrator activated kill switch.");
        return json(res, 202, { ok: true, status: deps.securityController?.status?.() }, origin, config);
      }
      if (req.method === "POST" && req.url === "/v1/security/revive") {
        if (!isSecurityAdmin) return json(res, 403, { error: "forbidden" }, origin, config);
        deps.securityController?.revive();
        return json(res, 200, { ok: true, status: deps.securityController?.status?.() }, origin, config);
      }
      if (req.method === "GET" && req.url === "/v1/security/audit") {
        if (!isSecurityAdmin) return json(res, 403, { error: "forbidden" }, origin, config);
        const events = deps.securityAudit && "list" in deps.securityAudit ? (deps.securityAudit as { list: () => unknown[] }).list() : [];
        return json(res, 200, { events }, origin, config);
      }

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
          persist(run);
        }
        return json(res, 200, publicResponse(run), origin, config);
      }

      if (req.method === "POST" && req.url === "/v1/agent/runs/stream") {
        const parsed = validateAgentRunInput(await body(req, maxBytes));
        if (!parsed.valid) return json(res, 400, { error: parsed.error }, origin, config);
        const input = parsed.input;
        if (!input.task?.trim()) return json(res, 400, { error: "task_required" }, origin, config);
        try { usage.consume(auth.keyId); } catch {
          return json(res, 429, { error: "quota_exceeded" }, origin, config);
        }
        const runId = randomUUID();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        const run: ActiveRun = { id: runId, status: "queued", controller, createdAt: Date.now(), updatedAt: Date.now(), ownerKeyId: auth.keyId, desktopCapabilities: desktopCapabilitiesFromScopes(auth.scopes) };
        runs.set(runId, run);
        persist(run);
        res.writeHead(200, {
          ...headers(origin, config),
          "content-type": "text/event-stream; charset=utf-8",
          connection: "keep-alive",
        });
        const send = (event: unknown) => {
          if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
        };
        const abortOnDisconnect = () => {
          if (!res.writableEnded) controller.abort(new Error("SSE client disconnected."));
        };
        res.on("close", abortOnDisconnect);
        try {
          run.status = "running";
          const result = await agent.run({
            principalId: auth.keyId,
            desktopCapabilities: desktopCapabilitiesFromScopes(auth.scopes),
            task: input.task,
            ...(input.context !== undefined ? { context: typeof input.context === "string" ? input.context : JSON.stringify(input.context) } : {}),
            ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
            ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria) } : {}),
            signal: controller.signal,
            onEvent: (event) => send({ type: "event", runId, event }),
          });
          if (controller.signal.aborted) throw new Error("Run cancelled.");
          run.result = result;
          run.status = "completed";
          send({ type: "result", runId, status: "completed", result: run.result });
        } catch (error) {
          run.status = controller.signal.aborted ? "cancelled" : "failed";
          run.error = controller.signal.aborted ? "Run cancelled." : error instanceof Error ? error.message : "Agent failed";
          send({ type: "error", runId, status: run.status, error: run.error });
        }
        send({ type: "done", runId });
        run.updatedAt = Date.now();
        persist(run);
        clearTimeout(timer);
        res.off("close", abortOnDisconnect);
        if (!res.destroyed) return res.end();
        return;
      }

      if (req.method === "POST" && req.url === "/v1/agent/runs") {
        const parsed = validateAgentRunInput(await body(req, maxBytes));
        if (!parsed.valid) return json(res, 400, { error: parsed.error }, origin, config);
        const input = parsed.input;
        if (!input.task?.trim()) return json(res, 400, { error: "task_required" }, origin, config);

        // Async mode is the reliable path for phones: the browser may sleep,
        // change networks, or be backgrounded while Sofia continues server-side.
        if (input.async) {
          const header = req.headers["idempotency-key"];
          const rawIdempotencyKey = Array.isArray(header) ? header[0] : header;
          const idempotencyKey = rawIdempotencyKey?.trim();
          if (idempotencyKey && (idempotencyKey.length > 128 || /[\x00-\x1f\x7f]/.test(idempotencyKey))) {
            return json(res, 400, { error: "invalid_idempotency_key" }, origin, config);
          }
          const idempotencyId = idempotencyKey ? `${auth.keyId}:${idempotencyKey}` : undefined;
          if (idempotencyId) {
            const existing = idempotency.get(idempotencyId);
            const existingRun = existing ? runs.get(existing) : undefined;
            if (existingRun) return json(res, 200, publicResponse(existingRun), origin, config);
            if (existing) idempotency.delete(idempotencyId);
          }
          const active = activeByKey.get(auth.keyId) ?? 0;
          if (active >= maxConcurrentRunsPerKey) {
            res.setHeader("retry-after", "2");
            return json(res, 429, { error: "concurrency_limit", retryAfterMs: 2000 }, origin, config);
          }
          try { usage.consume(auth.keyId); } catch (error) {
            return json(res, 429, { error: "quota_exceeded", message: error instanceof Error ? error.message : "Quota exceeded" }, origin, config);
          }
          const runId = randomUUID();
          const run: ActiveRun = {
            id: runId,
            status: "queued",
            controller: new AbortController(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ownerKeyId: auth.keyId,
            desktopCapabilities: desktopCapabilitiesFromScopes(auth.scopes),
          };
          runs.set(runId, run);
          persist(run);
          if (idempotencyId) idempotency.set(idempotencyId, runId);
          activeByKey.set(auth.keyId, active + 1);
          startRun(run, {
            ...input,
            ...(input.context !== undefined
              ? { context: typeof input.context === "string" ? input.context : JSON.stringify(input.context) }
              : {}),
            ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria) } : {}),
          });
          return json(res, 202, publicResponse(run), origin, config);
        }

        try { usage.consume(auth.keyId); } catch (error) {
          return json(res, 429, { error: "quota_exceeded", message: error instanceof Error ? error.message : "Quota exceeded" }, origin, config);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        const runId = randomUUID();
        try {
          const result = await agent.run({
            principalId: auth.keyId,
            desktopCapabilities: desktopCapabilitiesFromScopes(auth.scopes),
            task: input.task,
            ...(input.context !== undefined ? { context: typeof input.context === "string" ? input.context : JSON.stringify(input.context) } : {}),
            ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
            ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria) } : {}),
            signal: controller.signal,
          });
          if (controller.signal.aborted) {
            return json(res, 504, { id: runId, status: "failed", error: "Request timed out or was cancelled." }, origin, config);
          }
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
        if (!jobId) return json(res, 404, { error: "job_not_found" }, origin, config);
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
        const parsed = validateAgentRunInput(await body(req, maxBytes));
        if (!parsed.valid) return json(res, 400, { error: parsed.error }, origin, config);
        const input = parsed.input;
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
      if (error instanceof Error && error.message === "Request body too large.") {
        return json(res, 413, { error: "request_body_too_large" }, origin, config);
      }
      if (error instanceof SyntaxError) {
        return json(res, 400, { error: "invalid_json" }, origin, config);
      }
      return json(res, 500, { error: "internal_error" }, origin, config);
    }
  });
}
