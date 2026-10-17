import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { SofiaAgent } from "../agent/core.js";
import type { AgentDependencies } from "../agent/types.js";
import type { DesktopCapability } from "../desktop/types.js";
import type { AgentRunInput, AgentRunResponse, AgentRunStatus, SofiaApiConfig } from "./types.js";
import { UsageLimiter } from "./usage.js";
import { idempotencyFingerprint } from "./idempotency.js";
import { handleDiscordInteractionHttpRequest } from "../integrations/messaging/discord-http-route.js";
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
  idempotencyKeyHash?: string;
  requestFingerprint?: string;
  toolQuotaExceeded?: boolean;
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
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const hashedKeys = config.apiKeyHashes ?? {};
  // Prefer hash-only configuration; retain the legacy map for backward compatibility.
  const scopes = Object.prototype.hasOwnProperty.call(hashedKeys, tokenHash)
    ? hashedKeys[tokenHash]
    : Object.prototype.hasOwnProperty.call(config.apiKeys, token)
      ? config.apiKeys[token]
      : undefined;
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) return null;
  return { keyId: tokenHash.slice(0, 32), scopes };
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

/** Keep provider/tool exception details out of client responses and persisted run records. */
function publicAgentError(): string {
  return "Agent execution failed.";
}

export function createSofiaApi(deps: AgentDependencies, config: SofiaApiConfig) {
  const agent = new SofiaAgent(deps);
  const maxBytes = integerSetting("maxBodyBytes", config.maxBodyBytes, 1_000_000, 1, 10_000_000);
  const discordRoute = config.discordInteractionRoute;
  const discordRoutePath = discordRoute?.path ?? "/v1/integrations/discord/interactions";
  const discordMaxBodyBytes = discordRoute?.maxBodyBytes ?? 1_000_000;
  if (discordRoute && (!discordRoutePath.startsWith("/") || discordRoutePath.includes("?") || discordRoutePath.includes("#"))) {
    throw new Error("Discord interaction route path must be an absolute path without query or fragment.");
  }
  if (discordRoute && (!Number.isSafeInteger(discordMaxBodyBytes) || discordMaxBodyBytes < 1 || discordMaxBodyBytes > 1_000_000)) {
    throw new Error("Discord interaction route maxBodyBytes must be between 1 and 1000000.");
  }
  const maxRunsPerKeyPerDay = integerSetting("maxRunsPerKeyPerDay", config.maxRunsPerKeyPerDay, 100, 0, 1_000_000);
  const maxToolCallsPerKeyPerDay = integerSetting("maxToolCallsPerKeyPerDay", config.maxToolCallsPerKeyPerDay, 1000, 0, 1_000_000);
  const usage = new UsageLimiter(maxRunsPerKeyPerDay, maxToolCallsPerKeyPerDay, config.usageStore);
  const runs = new Map<string, ActiveRun>();
  const idempotency = new Map<string, { runId: string; fingerprint: string }>();
  const runStore = config.runStore;
  const recordForRun = (run: ActiveRun): RunRecord => ({
    id: run.id, status: run.status,
    ...(run.result ? { result: run.result as unknown as import("../agent/types.js").AgentResult } : {}),
    ...(run.error ? { error: run.error } : {}), createdAt: run.createdAt, updatedAt: run.updatedAt,
    ownerKeyId: run.ownerKeyId, desktopCapabilities: [...run.desktopCapabilities],
    ...(run.idempotencyKeyHash ? { idempotencyKeyHash: run.idempotencyKeyHash } : {}),
    ...(run.requestFingerprint ? { requestFingerprint: run.requestFingerprint } : {}),
  });
  const persist = (run: ActiveRun) => {
    if (!runStore) return;
    const record = recordForRun(run);
    void Promise.resolve().then(() => runStore.save(record)).catch((error: unknown) => {
      // Store failures must be observable without creating an unhandled rejection.
      console.error("[sofia] failed to persist run record", error instanceof Error ? error.message : "unknown error");
    });
  };
  const persistDurably = async (run: ActiveRun): Promise<void> => {
    if (runStore) await runStore.save(recordForRun(run));
  };
  if (runStore) for (const record of runStore.loadAllSync().sort((a, b) => a.createdAt - b.createdAt)) {
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
      ...(record.idempotencyKeyHash ? { idempotencyKeyHash: record.idempotencyKeyHash } : {}),
      ...(record.requestFingerprint ? { requestFingerprint: record.requestFingerprint } : {}),
    };
    runs.set(run.id, run);
    if (run.idempotencyKeyHash && run.requestFingerprint) {
      idempotency.set(run.ownerKeyId + ":" + run.idempotencyKeyHash, { runId: run.id, fingerprint: run.requestFingerprint });
    }
    if (interrupted) persist(run);
  }
  const activeByKey = new Map<string, number>();
  const requestTimeoutMs = integerSetting("requestTimeoutMs", config.requestTimeoutMs, 120_000, 1, 2_147_483_647);
  const maxConcurrentRunsPerKey = integerSetting("maxConcurrentRunsPerKey", config.maxConcurrentRunsPerKey, 4, 0, 256);
  const reserveActive = (keyId: string): boolean => {
    const active = activeByKey.get(keyId) ?? 0;
    if (active >= maxConcurrentRunsPerKey) return false;
    activeByKey.set(keyId, active + 1);
    return true;
  };
  const releaseActive = (keyId: string): void => {
    const current = activeByKey.get(keyId) ?? 0;
    if (current <= 1) activeByKey.delete(keyId);
    else activeByKey.set(keyId, current - 1);
  };
  const retention = integerSetting("runRetentionMs", config.runRetentionMs, 24 * 60 * 60 * 1000, 0, 365 * 24 * 60 * 60 * 1000);
  let lastPruneAt = 0;
  const authFailures = new Map<string, { count: number; windowStartedAt: number; blockedUntil: number }>();
  const authWindowMs = 60_000;
  const authBlockMs = 60_000;
  const authFailureLimit = 10;

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
      let timedOut = false;
      const timer = setTimeout(() => {
        if (!run.controller.signal.aborted) {
          timedOut = true;
          run.controller.abort(new Error("Run timed out."));
        }
      }, requestTimeoutMs);
      try {
        const result = await agent.run({
          principalId: run.ownerKeyId,
          desktopCapabilities: run.desktopCapabilities,
          task: input.task,
          ...(input.context !== undefined ? { context: typeof input.context === "string" ? input.context : JSON.stringify(input.context) } : {}),
          ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
          ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria) } : {}),
          signal: run.controller.signal,
          onEvent: (event) => {
            if (event.type === "tool.started" && !usage.recordToolCalls(run.ownerKeyId)) {
              run.toolQuotaExceeded = true;
              run.controller.abort(new Error("API tool-call quota exceeded."));
            }
          },
        });
        if (run.controller.signal.aborted) {
          run.status = timedOut || run.toolQuotaExceeded ? "failed" : "cancelled";
          run.error ??= timedOut ? "Run timed out." : run.toolQuotaExceeded ? "API tool-call quota exceeded." : "Run cancelled.";
        } else {
          run.result = result;
          run.status = "completed";
        }
      } catch (error) {
        if (run.controller.signal.aborted) {
          run.status = timedOut || run.toolQuotaExceeded ? "failed" : "cancelled";
          run.error = timedOut ? "Run timed out." : run.toolQuotaExceeded ? "API tool-call quota exceeded." : "Run cancelled.";
        } else {
          run.status = "failed";
          run.error = publicAgentError();
        }
      } finally {
        clearTimeout(timer);
        run.updatedAt = Date.now();
        persist(run);
        releaseActive(run.ownerKeyId);
      }
    })();
  };

  const prune = () => {
    const cutoff = Date.now() - retention;
    for (const [id, run] of runs) {
      if (run.updatedAt < cutoff && !["queued", "running"].includes(run.status)) { runs.delete(id); if (runStore) void runStore.remove(id); }
    }
    for (const [key, entry] of idempotency) {
      if (!runs.has(entry.runId)) idempotency.delete(key);
    }
  };

  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
    try {
      if (discordRoute && requestPath === discordRoutePath) {
        await handleDiscordInteractionHttpRequest(req, res, discordRoute.transport, discordMaxBodyBytes);
        return;
      }

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

      if (req.method === "GET" && requestPath === "/health") {
        return json(res, 200, {
          ok: true,
          service: "sofia-agent-api",
          version: "v1",
          capabilities: { mobile: true, asyncRuns: true, stream: true },
        }, origin, config);
      }

      if (!requestPath.startsWith("/v1/")) return json(res, 404, { error: "not_found" }, origin, config);

      const clientAddress = req.socket.remoteAddress ?? "unknown";
      const now = Date.now();
      const previousFailure = authFailures.get(clientAddress);
      if (previousFailure && previousFailure.blockedUntil > now) {
        res.setHeader("retry-after", String(Math.max(1, Math.ceil((previousFailure.blockedUntil - now) / 1000))));
        return json(res, 429, { error: "authentication_rate_limited" }, origin, config);
      }
      const currentFailure = !previousFailure || now - previousFailure.windowStartedAt >= authWindowMs
        ? { count: 0, windowStartedAt: now, blockedUntil: 0 }
        : previousFailure;
      const auth = authenticate(req, config);
      if (!auth) {
        currentFailure.count += 1;
        if (currentFailure.count >= authFailureLimit) currentFailure.blockedUntil = now + authBlockMs;
        authFailures.set(clientAddress, currentFailure);
        if (authFailures.size > 10_000) {
          const oldest = authFailures.keys().next().value;
          if (oldest !== undefined && oldest !== clientAddress) authFailures.delete(oldest);
        }
        return json(res, 401, { error: "unauthorized" }, origin, config);
      }
      authFailures.delete(clientAddress);

      // Authorization scopes are enforced at the API boundary, not merely used to
      // derive desktop capabilities. Admin scopes do not implicitly grant run access.
      const isRunRequest = req.method === "POST" && (requestPath === "/v1/agent/runs" || requestPath === "/v1/agent/runs/stream" || requestPath === "/v1/jobs");
      if (isRunRequest && !auth.scopes.includes("agent:run")) {
        return json(res, 403, { error: "forbidden", requiredScope: "agent:run" }, origin, config);
      }
      const isJobReadRequest = req.method === "GET" && (requestPath === "/v1/jobs" || (requestPath.startsWith("/v1/jobs/") === true && !requestPath.endsWith("/resume") && !requestPath.endsWith("/cancel")));
      if (isJobReadRequest && !auth.scopes.some((scope) => scope === "agent:read" || scope === "agent:run")) {
        return json(res, 403, { error: "forbidden", requiredScope: "agent:read" }, origin, config);
      }
      const isRunRead = req.method === "GET" && pathId(requestPath) !== null;
      if (isRunRead && !auth.scopes.some((scope) => scope === "agent:read" || scope === "agent:run")) {
        return json(res, 403, { error: "forbidden", requiredScope: "agent:read" }, origin, config);
      }
      const isRunCancellation = req.method === "DELETE" && pathId(requestPath) !== null;
      if (isRunCancellation && !auth.scopes.includes("agent:run")) {
        return json(res, 403, { error: "forbidden", requiredScope: "agent:run" }, origin, config);
      }
      const isJobMutation = req.method === "POST" && requestPath.startsWith("/v1/jobs/") === true && (requestPath.endsWith("/resume") || requestPath.endsWith("/cancel"));
      if (isJobMutation && !auth.scopes.includes("agent:run")) {
        return json(res, 403, { error: "forbidden", requiredScope: "agent:run" }, origin, config);
      }

      const adminScope = config.securityAdminScope ?? "security:admin";
      const isSecurityAdmin = auth.scopes.includes(adminScope);
      if (req.method === "GET" && requestPath === "/v1/learning/diagnostics") {
        if (!isSecurityAdmin) return json(res, 403, { error: "forbidden" }, origin, config);
        if (!deps.learningDiagnostics) return json(res, 503, { error: "learning_diagnostics_unavailable" }, origin, config);
        return json(res, 200, deps.learningDiagnostics(), origin, config);
      }
      if (req.method === "GET" && requestPath === "/v1/security/status") {
        if (!isSecurityAdmin) return json(res, 403, { error: "forbidden" }, origin, config);
        return json(res, 200, {
          ...deps.securityController?.status?.(),
          auditEvents: deps.securityAudit && "list" in deps.securityAudit ? (deps.securityAudit as { list: () => unknown[] }).list().length : 0,
        }, origin, config);
      }
      if (req.method === "POST" && requestPath === "/v1/security/kill") {
        if (!isSecurityAdmin) return json(res, 403, { error: "forbidden" }, origin, config);
        const input = (await body(req, maxBytes)) as { reason?: unknown };
        deps.securityController?.kill(typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : "Security administrator activated kill switch.");
        return json(res, 202, { ok: true, status: deps.securityController?.status?.() }, origin, config);
      }
      if (req.method === "POST" && requestPath === "/v1/security/revive") {
        if (!isSecurityAdmin) return json(res, 403, { error: "forbidden" }, origin, config);
        deps.securityController?.revive();
        return json(res, 200, { ok: true, status: deps.securityController?.status?.() }, origin, config);
      }
      if (req.method === "GET" && requestPath === "/v1/security/audit") {
        if (!isSecurityAdmin) return json(res, 403, { error: "forbidden" }, origin, config);
        const events = deps.securityAudit && "list" in deps.securityAudit ? (deps.securityAudit as { list: () => unknown[] }).list() : [];
        return json(res, 200, { events }, origin, config);
      }

      const id = pathId(requestPath);
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

      if (req.method === "POST" && requestPath === "/v1/agent/runs/stream") {
        const parsed = validateAgentRunInput(await body(req, maxBytes));
        if (!parsed.valid) return json(res, 400, { error: parsed.error }, origin, config);
        const input = parsed.input;
        if (!input.task?.trim()) return json(res, 400, { error: "task_required" }, origin, config);
        try { usage.consume(auth.keyId); } catch {
          return json(res, 429, { error: "quota_exceeded" }, origin, config);
        }
        if (!reserveActive(auth.keyId)) {
          res.setHeader("retry-after", "2");
          return json(res, 429, { error: "concurrency_limit", retryAfterMs: 2000 }, origin, config);
        }
        const runId = randomUUID();
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          if (!controller.signal.aborted) {
            timedOut = true;
            controller.abort(new Error("Run timed out."));
          }
        }, requestTimeoutMs);
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
        let toolQuotaExceeded = false;
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
            onEvent: (event) => {
              send({ type: "event", runId, event });
              if (event.type === "tool.started" && !usage.recordToolCalls(auth.keyId)) {
                toolQuotaExceeded = true;
                controller.abort(new Error("API tool-call quota exceeded."));
              }
            },
          });
          if (controller.signal.aborted) throw new Error(timedOut ? "Run timed out." : toolQuotaExceeded ? "API tool-call quota exceeded." : "Run cancelled.");
          run.result = result;
          run.status = "completed";
          send({ type: "result", runId, status: "completed", result: run.result });
        } catch (error) {
          run.status = timedOut || toolQuotaExceeded ? "failed" : controller.signal.aborted ? "cancelled" : "failed";
          run.error = timedOut ? "Run timed out." : toolQuotaExceeded ? "API tool-call quota exceeded." : controller.signal.aborted ? "Run cancelled." : publicAgentError();
          send({ type: "error", runId, status: run.status, error: run.error });
        } finally {
          releaseActive(auth.keyId);
        }
        send({ type: "done", runId });
        run.updatedAt = Date.now();
        persist(run);
        clearTimeout(timer);
        res.off("close", abortOnDisconnect);
        if (!res.destroyed) return res.end();
        return;
      }

      if (req.method === "POST" && requestPath === "/v1/agent/runs") {
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
          const idempotencyKeyHash = idempotencyKey ? createHash("sha256").update(idempotencyKey).digest("hex") : undefined;
          const idempotencyId = idempotencyKeyHash ? auth.keyId + ":" + idempotencyKeyHash : undefined;
          const requestFingerprint = idempotencyFingerprint({
            task: input.task,
            ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
            ...(input.context !== undefined ? { context: input.context } : {}),
            ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
            ...(input.acceptanceCriteria !== undefined ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
          });
          if (idempotencyId) {
            const existing = idempotency.get(idempotencyId);
            const existingRun = existing ? runs.get(existing.runId) : undefined;
            if (existing && existingRun && existing.fingerprint !== requestFingerprint) {
              return json(res, 409, { error: "idempotency_key_reused", message: "This idempotency key was already used with a different request." }, origin, config);
            }
            if (existingRun) return json(res, 200, publicResponse(existingRun), origin, config);
            if (existing) idempotency.delete(idempotencyId);
          }
          try { usage.consume(auth.keyId); } catch (error) {
            return json(res, 429, { error: "quota_exceeded", message: error instanceof Error ? error.message : "Quota exceeded" }, origin, config);
          }
          if (!reserveActive(auth.keyId)) {
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
            desktopCapabilities: desktopCapabilitiesFromScopes(auth.scopes),
            ...(idempotencyKeyHash ? { idempotencyKeyHash } : {}),
            ...(idempotencyId ? { requestFingerprint } : {}),
          };
          runs.set(runId, run);
          if (idempotencyId) idempotency.set(idempotencyId, { runId, fingerprint: requestFingerprint });
          try {
            // Persist the accepted queued state before returning 202 so a restart cannot lose its idempotency key.
            await persistDurably(run);
          } catch {
            runs.delete(runId);
            if (idempotencyId) idempotency.delete(idempotencyId);
            releaseActive(auth.keyId);
            return json(res, 503, { error: "run_persistence_unavailable" }, origin, config);
          }
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
        if (!reserveActive(auth.keyId)) {
          res.setHeader("retry-after", "2");
          return json(res, 429, { error: "concurrency_limit", retryAfterMs: 2000 }, origin, config);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error("Run timed out.")), requestTimeoutMs);
        const runId = randomUUID();
        let toolQuotaExceeded = false;
        try {
          const result = await agent.run({
            principalId: auth.keyId,
            desktopCapabilities: desktopCapabilitiesFromScopes(auth.scopes),
            task: input.task,
            ...(input.context !== undefined ? { context: typeof input.context === "string" ? input.context : JSON.stringify(input.context) } : {}),
            ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
            ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria) } : {}),
            signal: controller.signal,
            onEvent: (event) => {
              if (event.type === "tool.started" && !usage.recordToolCalls(auth.keyId)) {
                toolQuotaExceeded = true;
                controller.abort(new Error("API tool-call quota exceeded."));
              }
            },
          });
          if (controller.signal.aborted) {
            if (toolQuotaExceeded) return json(res, 429, { id: runId, status: "failed", error: "API tool-call quota exceeded." }, origin, config);
            return json(res, 504, { id: runId, status: "failed", error: "Request timed out or was cancelled." }, origin, config);
          }
          return json(res, 200, { id: runId, status: "completed", result }, origin, config);
        } catch (error) {
          if (controller.signal.aborted && toolQuotaExceeded) {
            return json(res, 429, { id: runId, status: "failed", error: "API tool-call quota exceeded." }, origin, config);
          }
          return json(res, controller.signal.aborted ? 504 : 502, {
            id: runId,
            status: "failed",
            error: controller.signal.aborted ? "Request timed out or was cancelled." : publicAgentError(),
          }, origin, config);
        } finally {
          clearTimeout(timer);
          releaseActive(auth.keyId);
        }
      }

      const jobMatch = requestPath.match(/^\/v1\/jobs\/([^/]+)(?:\/(resume|cancel))?$/);
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

      if (req.method === "GET" && requestPath === "/v1/jobs") {
        if (!deps.jobRuntime) return json(res, 503, { error: "job_runtime_unavailable" }, origin, config);
        const jobs = (await deps.jobRuntime.list()).filter((item) => item.ownerKeyId === auth.keyId);
        return json(res, 200, { jobs }, origin, config);
      }

      if (req.method === "POST" && requestPath === "/v1/jobs") {
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

      if (req.method === "GET" && requestPath.startsWith("/v1/usage")) {
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
