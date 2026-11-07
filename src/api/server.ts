import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SofiaAgent } from "../agent/core.js";
import type { AgentDependencies } from "../agent/types.js";
import type { DesktopCapability } from "../desktop/types.js";
import type { AgentRunInput, AgentRunResponse, AgentRunStatus, SofiaApiConfig } from "./types.js";
import { UsageLimiter } from "./usage.js";
import { idempotencyFingerprint } from "./idempotency.js";
import { handleDiscordInteractionHttpRequest } from "../integrations/messaging/discord-http-route.js";
import { validateAgentRunInput } from "./validation.js";
import type { RunRecord } from "./run-record-store.js";
import { CronScheduler, type CronScheduleInput } from "../brain/cron-scheduler.js";
import { createUserMemoryEntry, type UserMemoryKind } from "../brain/user-memory.js";

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
  /** Hashed owner-scoped idempotency key; raw client key is never persisted. */
  idempotencyId?: string;
  requestFingerprint?: string;
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
    "access-control-allow-headers": "authorization, content-type, idempotency-key",
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
    "desktop:remote:app:launch": "app:launch",
    "desktop:remote:input:control": "input:control",
  };
  const remoteEnabled = scopes.includes("desktop:connect");
  return [...new Set(scopes
    .filter((scope) => remoteEnabled || !scope.startsWith("desktop:remote:"))
    .map((scope) => mapping[scope])
    .filter((capability): capability is DesktopCapability => capability !== undefined))];
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  return (header ?? "").split(";").map((part) => part.trim())
    .find((part) => part.startsWith(name + "="))?.slice(name.length + 1);
}
function safeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk as Buffer);
    size += part.length;
    if (size > maxBytes) throw new Error("Request body too large.");
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}
function sameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof host !== "string" || host.includes(",")) return false;
  if (typeof origin !== "string") return req.headers["sec-fetch-site"] === "same-origin";
  try {
    const parsed = new URL(origin);
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    return parsed.host.toLowerCase() === host.toLowerCase() &&
      (parsed.protocol === "https:" || (local && parsed.protocol === "http:"));
  } catch { return false; }
}
function setWorkspaceCookies(res: ServerResponse, sessionCookie: string, csrf: string): void {
  res.setHeader("set-cookie", [
    sessionCookie,
    "__Host-sofia_csrf=" + csrf + "; Path=/; Secure; SameSite=Strict; Max-Age=28800",
  ]);
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
  const usage = new UsageLimiter(maxRunsPerKeyPerDay, maxToolCallsPerKeyPerDay, config.usageStorePath);
  const countToolCall = (keyId: string, controller: AbortController, event: { type: string }): boolean => {
    if (event.type !== "tool.started") return true;
    try { usage.consumeToolCall(keyId); return true; }
    catch { controller.abort(new Error("API tool-call quota exceeded.")); return false; }
  };
  const cronScheduler = deps.jobRuntime ? new CronScheduler(deps.jobRuntime) : undefined;
  let cronTimer: NodeJS.Timeout | undefined;
  let cronClosed = false;
  const runs = new Map<string, ActiveRun>();
  const runStore = config.runStore;
  const persist = (run: ActiveRun): Promise<void> => {
    if (!runStore) return Promise.resolve();
    const record: RunRecord = {
      id: run.id, status: run.status,
      ...(run.result ? { result: run.result as unknown as import("../agent/types.js").AgentResult } : {}),
      ...(run.error ? { error: run.error } : {}), createdAt: run.createdAt, updatedAt: run.updatedAt,
      ownerKeyId: run.ownerKeyId, desktopCapabilities: [...run.desktopCapabilities],
      ...(run.idempotencyId ? { idempotencyId: run.idempotencyId } : {}),
      ...(run.requestFingerprint ? { requestFingerprint: run.requestFingerprint } : {}),
    };
    return runStore.save(record);
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
      ...(record.idempotencyId ? { idempotencyId: record.idempotencyId } : {}),
      ...(record.requestFingerprint ? { requestFingerprint: record.requestFingerprint } : {}),
    };
    runs.set(run.id, run); if (interrupted) void persist(run).catch(() => undefined);
  }
  const idempotency = new Map<string, { runId: string; fingerprint: string }>();
  // Rehydrate replay protection from durable run records after a server restart.
  for (const run of runs.values()) {
    if (run.idempotencyId && run.requestFingerprint) {
      idempotency.set(run.idempotencyId, { runId: run.id, fingerprint: run.requestFingerprint });
    }
  }
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

  const modelSelectionError = (input: AgentRunInput): { status: number; error: string } | undefined => {
    const requested = input.modelRouteId?.trim();
    if (!requested || requested === "auto") return undefined;
    const routes = deps.router.listRoutes?.();
    if (!routes) return { status: 503, error: "model_selection_unavailable" };
    const route = routes.find((item) => item.id === requested);
    if (!route) return { status: 400, error: "invalid_model_route" };
    if (!route.healthy) return { status: 409, error: "model_route_unavailable" };
    return undefined;
  };

  const startRun = (run: ActiveRun, input: AgentRunInput) => {
    void (async () => {
      run.status = "running";
      run.updatedAt = Date.now();
      void persist(run).catch(() => undefined);
      const timer = setTimeout(() => run.controller.abort(), requestTimeoutMs);
      try {
        const result = await agent.run({
          principalId: run.ownerKeyId,
          desktopCapabilities: run.desktopCapabilities,
          task: input.task,
          ...(input.modelRouteId !== undefined ? { modelRouteId: input.modelRouteId } : {}),
          ...(input.sessionId !== undefined ? { sessionId: `${run.ownerKeyId}:${input.sessionId}` } : {}),
          ...(input.context !== undefined ? { context: typeof input.context === "string" ? input.context : JSON.stringify(input.context) } : {}),
          ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
          ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria) } : {}),
          signal: run.controller.signal,
          onEvent: (event) => { countToolCall(run.ownerKeyId, run.controller, event); },
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
          run.error = run.controller.signal.reason instanceof Error ? run.controller.signal.reason.message : "Run cancelled.";
        } else {
          run.status = "failed";
          run.error = error instanceof Error ? error.message : "Agent failed";
        }
      } finally {
        clearTimeout(timer);
        run.updatedAt = Date.now();
        void persist(run).catch(() => undefined);
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
    for (const [key, entry] of idempotency) {
      if (!runs.has(entry.runId)) idempotency.delete(key);
    }
  };

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    try {
      const workspaceAuth = config.workspaceAuth;
      const workspaceRoot = "/workspace";
      if (workspaceAuth && req.url && (req.url === workspaceRoot || req.url.startsWith(workspaceRoot + "/"))) {
        const pathname = new URL(req.url, "http://sofia.local").pathname;
        if (req.method === "GET" && (pathname === workspaceRoot || pathname === workspaceRoot + "/")) {
          const identity = workspaceAuth.authenticate(req.headers.cookie);
          res.writeHead(302, {
            location: workspaceRoot + (identity ? "/index.html" : "/login.html"),
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          });
          return res.end();
        }
        if (req.method === "GET" && pathname === workspaceRoot + "/auth/login") {
          try {
            const login = await workspaceAuth.beginLogin();
            res.writeHead(302, { location: login.url, "cache-control": "no-store", "referrer-policy": "no-referrer" });
            return res.end();
          } catch {
            return json(res, 503, { error: "workspace_identity_provider_unavailable" }, undefined, config);
          }
        }
        if (req.method === "GET" && pathname === workspaceRoot + "/auth/callback") {
          const callback = new URL(req.url, "http://sofia.local");
          const code = callback.searchParams.get("code") ?? "";
          const state = callback.searchParams.get("state") ?? "";
          if (callback.searchParams.has("error")) {
            res.writeHead(302, { location: workspaceRoot + "/?auth=failed", "cache-control": "no-store", "referrer-policy": "no-referrer" });
            return res.end();
          }
          try {
            const identity = await workspaceAuth.completeLogin(code, state);
            const csrf = randomBytes(32).toString("base64url");
            setWorkspaceCookies(res, workspaceAuth.sessionCookie(identity.sessionId, Math.floor((identity.expiresAt - Date.now()) / 1000)), csrf);
            res.writeHead(302, { location: workspaceRoot + "/", "cache-control": "no-store", "referrer-policy": "no-referrer" });
            return res.end();
          } catch {
            res.writeHead(302, { location: workspaceRoot + "/?auth=failed", "cache-control": "no-store", "referrer-policy": "no-referrer" });
            return res.end();
          }
        }
        if (req.method === "GET" && pathname === workspaceRoot + "/auth/session") {
          const identity = workspaceAuth.authenticate(req.headers.cookie);
          return identity
            ? json(res, 200, { authenticated: true, expiresAt: identity.expiresAt }, origin, config)
            : json(res, 401, { error: "workspace_sign_in_required" }, origin, config);
        }
        if (req.method === "POST" && pathname === workspaceRoot + "/auth/logout") {
          if (!sameOriginRequest(req)) return json(res, 403, { error: "workspace_origin_rejected" }, origin, config);
          const csrfCookie = cookieValue(req.headers.cookie, "__Host-sofia_csrf");
          const csrfHeader = req.headers["x-csrf-token"];
          if (!csrfCookie || typeof csrfHeader !== "string" || !safeEqualText(csrfCookie, csrfHeader)) {
            return json(res, 403, { error: "workspace_csrf_rejected" }, origin, config);
          }
          const identity = workspaceAuth.authenticate(req.headers.cookie);
          if (identity) workspaceAuth.revoke(identity.sessionId);
          res.writeHead(204, { "set-cookie": [workspaceAuth.clearCookie(), "__Host-sofia_csrf=; Path=/; Secure; SameSite=Strict; Max-Age=0"], "cache-control": "no-store" });
          return res.end();
        }
        if (pathname.startsWith("/workspace/") && req.method === "GET") {
          const asset = pathname.slice((workspaceRoot + "/").length);
          const allowedAssets = new Set(["index.html", "login.html", "login.js", "workspace.css", "workspace.js", "manifest.webmanifest", "sofia-icon.svg", "service-worker.js"]);
          if (!allowedAssets.has(asset)) return json(res, 404, { error: "not_found" }, origin, config);
          const identity = workspaceAuth.authenticate(req.headers.cookie);
          if (asset === "index.html" && !identity) {
            res.writeHead(302, { location: workspaceRoot + "/login.html", "cache-control": "no-store", "referrer-policy": "no-referrer" });
            return res.end();
          }
          if (asset === "login.html" && identity) {
            res.writeHead(302, { location: workspaceRoot + "/index.html", "cache-control": "no-store" });
            return res.end();
          }
          const directory = path.resolve(config.workspaceStaticDirectory ?? path.resolve(process.cwd(), "web/mobile-workspace"));
          const file = path.resolve(directory, asset);
          if (!file.startsWith(directory + path.sep)) return json(res, 404, { error: "not_found" }, origin, config);
          try {
            if (asset === "index.html" && !workspaceAuth.authenticate(req.headers.cookie)) {
            res.writeHead(302, { location: workspaceRoot + "/auth/login", "cache-control": "no-store", "referrer-policy": "no-referrer" });
            return res.end();
          }
          const content = readFileSync(file);
            const types: Record<string, string> = {
              ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
              ".js": "text/javascript; charset=utf-8", ".webmanifest": "application/manifest+json",
              ".svg": "image/svg+xml",
            };
            res.writeHead(200, {
              "content-type": types[path.extname(file)] ?? "application/octet-stream",
              "cache-control": asset === "index.html" ? "no-store" : "public, max-age=300",
              "x-content-type-options": "nosniff",
              "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
              ...(asset === "service-worker.js" ? { "service-worker-allowed": "/workspace/" } : {}),
            });
            return res.end(content);
          } catch { return json(res, 404, { error: "workspace_asset_not_found" }, origin, config); }
        }
      }

      if (workspaceAuth && req.url?.startsWith("/api/sofia/")) {
        const identity = workspaceAuth.authenticate(req.headers.cookie);
        if (!identity) return json(res, 401, { error: "workspace_sign_in_required" }, origin, config);
        if (!config.workspaceApiKey) return json(res, 503, { error: "workspace_bff_unavailable" }, origin, config);
        if (!sameOriginRequest(req)) return json(res, 403, { error: "workspace_origin_rejected" }, origin, config);
        const csrfCookie = cookieValue(req.headers.cookie, "__Host-sofia_csrf");
        const csrfHeader = req.headers["x-csrf-token"];
        if (req.method !== "GET" && (!csrfCookie || typeof csrfHeader !== "string" || !safeEqualText(csrfCookie, csrfHeader))) {
          return json(res, 403, { error: "workspace_csrf_rejected" }, origin, config);
        }
        const upstreamPath = req.url.slice("/api/sofia".length);
        const upstreamUrl = new URL(upstreamPath, "http://sofia.local");
        const allowedPath = /^\/v1\/(?:browser\/cloud\/sessions(?:\/[0-9a-f-]{36}(?:\/(?:navigate|action|screenshot))?)?|agent\/runs(?:\/[0-9a-f-]{36})?|approvals(?:\/audit|\/[0-9a-f-]{36}\/decision)?)$/i.test(upstreamUrl.pathname);
        if (!allowedPath || !["GET", "POST", "DELETE"].includes(req.method ?? "")) {
          return json(res, 404, { error: "workspace_route_not_allowed" }, origin, config);
        }
        const address = server.address();
        if (!address || typeof address === "string") return json(res, 503, { error: "workspace_upstream_unavailable" }, origin, config);
        try {
          const requestBody = req.method === "GET" || req.method === "DELETE" ? undefined : await readRawBody(req, maxBytes);
          const upstream = await fetch("http://127.0.0.1:" + address.port + upstreamUrl.pathname + upstreamUrl.search, {
            method: req.method,
            headers: {
              authorization: "Bearer " + config.workspaceApiKey,
              ...(requestBody ? { "content-type": req.headers["content-type"] ?? "application/json" } : {}),
              accept: "application/json",
            },
            ...(requestBody ? { body: requestBody } : {}),
          });
          const responseBody = Buffer.from(await upstream.arrayBuffer());
          res.writeHead(upstream.status, {
            "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
            "cache-control": "no-store",
            ...(upstream.headers.get("retry-after") ? { "retry-after": upstream.headers.get("retry-after")! } : {}),
            "x-content-type-options": "nosniff",
          });
          return res.end(responseBody);
        } catch {
          return json(res, 502, { error: "workspace_upstream_failed" }, origin, config);
        }
      }

      if (discordRoute && req.url === discordRoutePath) {
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

      if (req.method === "GET" && req.url === "/health") {
        return json(res, 200, {
          ok: true,
          service: "sofia-agent-api",
          version: "v1",
          capabilities: { mobile: true, asyncRuns: true, stream: true },
        }, origin, config);
      }

      if (!req.url?.startsWith("/v1/")) return json(res, 404, { error: "not_found" }, origin, config);

      const requestUrl = new URL(req.url ?? "/", "http://sofia.local");
      const desktopPath = requestUrl.pathname;
      const desktopBroker = config.desktopCommandBroker;

      // The companion uses a separate short-lived bearer token. It never receives
      // the owner's Sofia API key and can only poll/complete its own claimed work.
      if (desktopBroker && desktopPath === "/v1/desktop/companion/commands" && req.method === "GET") {
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
        if (!token) return json(res, 401, { error: "unauthorized" }, origin, config);
        try {
          const command = desktopBroker.poll(token);
          return json(res, 200, { command }, origin, config);
        } catch {
          return json(res, 401, { error: "desktop_companion_unauthorized" }, origin, config);
        }
      }

      const completeMatch = desktopPath.match(/^\/v1\/desktop\/companion\/commands\/([0-9a-f-]{36})\/complete$/i);
      if (desktopBroker && completeMatch && req.method === "POST") {
        const header = req.headers.authorization ?? "";
        const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
        if (!token) return json(res, 401, { error: "unauthorized" }, origin, config);
        const raw = await body(req, maxBytes);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json(res, 400, { error: "invalid_desktop_completion" }, origin, config);
        const input = raw as Record<string, unknown>;
        if (input.error !== undefined && (typeof input.error !== "string" || input.error.length > 1000)) {
          return json(res, 400, { error: "invalid_desktop_completion" }, origin, config);
        }
        let resultSize = 0;
        try { resultSize = Buffer.byteLength(JSON.stringify(input.result ?? null), "utf8"); } catch {
          return json(res, 400, { error: "invalid_desktop_completion" }, origin, config);
        }
        if (resultSize > maxBytes) return json(res, 413, { error: "desktop_result_too_large" }, origin, config);
        try {
          const completed = desktopBroker.complete(token, completeMatch[1]!, input.result ?? null, input.error as string | undefined);
          return completed
            ? json(res, 200, { completed: true }, origin, config)
            : json(res, 404, { error: "desktop_command_not_found" }, origin, config);
        } catch {
          return json(res, 401, { error: "desktop_companion_unauthorized" }, origin, config);
        }
      }

      const auth = authenticate(req, config);
      if (!auth) return json(res, 401, { error: "unauthorized" }, origin, config);

      // Approval Inbox is deliberately separate from run permissions. Reading and
      // deciding approvals require explicit scopes and are always owner-bound.
      if (requestUrl.pathname === "/v1/approvals/audit" && req.method === "GET") {
        if (!auth.scopes.includes("approval:read") && !auth.scopes.includes("approval:decide")) {
          return json(res, 403, { error: "forbidden", requiredScope: "approval:read" }, origin, config);
        }
        if (!config.approvalAuditStore) return json(res, 503, { error: "approval_audit_unavailable" }, origin, config);
        const rawLimit = Number(requestUrl.searchParams.get("limit") ?? "50");
        const limit = Number.isSafeInteger(rawLimit) ? Math.max(1, Math.min(100, rawLimit)) : 50;
        return json(res, 200, { events: config.approvalAuditStore.list(auth.keyId, limit) }, origin, config);
      }

      if (requestUrl.pathname === "/v1/approvals" || requestUrl.pathname.startsWith("/v1/approvals/")) {
        const inbox = config.approvalInbox;
        if (!inbox) return json(res, 503, { error: "approval_inbox_unavailable" }, origin, config);
        if (req.method === "GET" && requestUrl.pathname === "/v1/approvals") {
          if (!auth.scopes.includes("approval:read") && !auth.scopes.includes("approval:decide")) {
            return json(res, 403, { error: "forbidden", requiredScope: "approval:read" }, origin, config);
          }
          return json(res, 200, { approvals: inbox.list(auth.keyId) }, origin, config);
        }
        const approvalMatch = requestUrl.pathname.match(/^\/v1\/approvals\/([0-9a-f-]{36})\/decision$/i);
        if (req.method === "POST" && approvalMatch) {
          if (!auth.scopes.includes("approval:decide")) {
            return json(res, 403, { error: "forbidden", requiredScope: "approval:decide" }, origin, config);
          }
          const raw = await body(req, maxBytes);
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return json(res, 400, { error: "invalid_approval_decision" }, origin, config);
          }
          const input = raw as Record<string, unknown>;
          if ((input.decision !== "approve" && input.decision !== "deny") ||
              typeof input.actionHash !== "string" || !/^[a-f0-9]{64}$/i.test(input.actionHash)) {
            return json(res, 400, { error: "invalid_approval_decision" }, origin, config);
          }
          const decided = inbox.decide(auth.keyId, approvalMatch[1]!, input.actionHash, input.decision);
          return decided
            ? json(res, 200, { decided: true }, origin, config)
            : json(res, 409, { error: "approval_expired_or_not_found" }, origin, config);
        }
        return json(res, 404, { error: "approval_not_found" }, origin, config);
      }

      // Cloud browser sessions let phone-only users interact with a private,
      // ephemeral browser hosted alongside Sofia. Every operation is owner-scoped.
      if (requestUrl.pathname.startsWith("/v1/browser/cloud/")) {
        const manager = config.cloudBrowserSessions;
        if (!manager) return json(res, 503, { error: "cloud_browser_unavailable" }, origin, config);
        if (!auth.scopes.includes("browser:cloud")) {
          return json(res, 403, { error: "forbidden", requiredScope: "browser:cloud" }, origin, config);
        }
        const basePath = "/v1/browser/cloud/sessions";
        if (requestUrl.pathname === basePath && req.method === "POST") {
          try {
            const session = await manager.create(auth.keyId);
            return json(res, 201, { session }, origin, config);
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            const limited = message.includes("limit reached");
            return json(res, limited ? 429 : 503, { error: limited ? "cloud_browser_session_limit" : "cloud_browser_start_failed" }, origin, config);
          }
        }
        const match = requestUrl.pathname.match(/^\/v1\/browser\/cloud\/sessions\/([0-9a-f-]{36})(?:\/(navigate|action|screenshot))?$/i);
        if (!match) return json(res, 404, { error: "cloud_browser_session_not_found" }, origin, config);
        const sessionId = match[1]!;
        const operation = match[2];
        try {
          if (!operation && req.method === "GET") {
            return json(res, 200, await manager.status(auth.keyId, sessionId), origin, config);
          }
          if (operation === "navigate" && req.method === "POST") {
            const raw = await body(req, maxBytes);
            if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof (raw as Record<string, unknown>).url !== "string") {
              return json(res, 400, { error: "invalid_cloud_browser_navigation" }, origin, config);
            }
            return json(res, 200, await manager.navigate(auth.keyId, sessionId, (raw as { url: string }).url), origin, config);
          }
          if (operation === "action" && req.method === "POST") {
            const raw = await body(req, maxBytes);
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json(res, 400, { error: "invalid_cloud_browser_action" }, origin, config);
            return json(res, 200, await manager.act(auth.keyId, sessionId, raw as Record<string, unknown>), origin, config);
          }
          if (operation === "screenshot" && req.method === "GET") {
            return json(res, 200, await manager.screenshot(auth.keyId, sessionId), origin, config);
          }
          if (!operation && req.method === "DELETE") {
            await manager.close(auth.keyId, sessionId);
            return json(res, 200, { closed: true }, origin, config);
          }
          return json(res, 405, { error: "method_not_allowed" }, origin, config);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          const notFound = message.includes("not found");
          const tooLarge = message.includes("too large");
          return json(res, notFound ? 404 : tooLarge ? 413 : 400, {
            error: notFound ? "cloud_browser_session_not_found" : tooLarge ? "cloud_browser_screenshot_too_large" : "cloud_browser_action_rejected",
          }, origin, config);
        }
      }

      if (desktopPath.startsWith("/v1/desktop/")) {
        if (!desktopBroker) return json(res, 503, { error: "desktop_companion_unavailable" }, origin, config);
        if (!auth.scopes.includes("desktop:connect")) {
          return json(res, 403, { error: "forbidden", requiredScope: "desktop:connect" }, origin, config);
        }
        if (desktopPath === "/v1/desktop/companion/connect" && req.method === "POST") {
          const session = desktopBroker.connect(auth.keyId);
          return json(res, 201, { token: session.token, connectedAt: session.connectedAt }, origin, config);
        }
        if (desktopPath === "/v1/desktop/companion/status" && req.method === "GET") {
          return json(res, 200, desktopBroker.getStatus(auth.keyId), origin, config);
        }
        if (desktopPath === "/v1/desktop/companion/disconnect" && req.method === "POST") {
          desktopBroker.disconnect(auth.keyId);
          return json(res, 200, { disconnected: true }, origin, config);
        }
        return json(res, 404, { error: "not_found" }, origin, config);
      }

      const isMemoryRequest = requestUrl.pathname === "/v1/memory" || requestUrl.pathname.startsWith("/v1/memory/");
      if (isMemoryRequest) {
        if (!deps.userMemoryStore) return json(res, 503, { error: "user_memory_unavailable" }, origin, config);
        if (req.method === "GET") {
          if (!auth.scopes.includes("memory:read")) return json(res, 403, { error: "forbidden", requiredScope: "memory:read" }, origin, config);
          const query = requestUrl.searchParams.get("q")?.trim() ?? "";
          if (query.length > 1000) return json(res, 400, { error: "memory_query_too_long" }, origin, config);
          const rawLimit = Number(requestUrl.searchParams.get("limit") ?? "8");
          const limit = Number.isSafeInteger(rawLimit) ? Math.max(1, Math.min(20, rawLimit)) : 8;
          const memories = query
            ? await deps.userMemoryStore.find(auth.keyId, query, limit)
            : (await deps.userMemoryStore.list(auth.keyId)).slice(0, 200);
          return json(res, 200, { memories }, origin, config);
        }
        if (req.method === "POST" && requestUrl.pathname === "/v1/memory") {
          if (!auth.scopes.includes("memory:write")) return json(res, 403, { error: "forbidden", requiredScope: "memory:write" }, origin, config);
          const raw = await body(req, maxBytes);
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json(res, 400, { error: "invalid_memory_entry" }, origin, config);
          const input = raw as Record<string, unknown>;
          const kinds = ["preference", "fact", "goal", "instruction"];
          if (typeof input.kind !== "string" || !kinds.includes(input.kind) ||
              typeof input.content !== "string" || input.content.trim().length < 3 || input.content.length > 1200) {
            return json(res, 400, { error: "invalid_memory_entry" }, origin, config);
          }
          try {
            const entry = createUserMemoryEntry(input.kind as UserMemoryKind, input.content);
            await deps.userMemoryStore.save(auth.keyId, entry);
            const saved = (await deps.userMemoryStore.list(auth.keyId)).find((item) => item.id === entry.id);
            if (!saved) return json(res, 500, { error: "memory_write_failed" }, origin, config);
            return json(res, 201, { memory: saved }, origin, config);
          } catch {
            return json(res, 400, { error: "memory_entry_rejected" }, origin, config);
          }
        }
        if (req.method === "DELETE" && requestUrl.pathname === "/v1/memory") {
          if (!auth.scopes.includes("memory:write")) return json(res, 403, { error: "forbidden", requiredScope: "memory:write" }, origin, config);
          await deps.userMemoryStore.clear(auth.keyId);
          return json(res, 200, { cleared: true }, origin, config);
        }
        const memoryIdMatch = requestUrl.pathname.match(/^\/v1\/memory\/([^/]+)$/);
        if (req.method === "DELETE" && memoryIdMatch) {
          if (!auth.scopes.includes("memory:write")) return json(res, 403, { error: "forbidden", requiredScope: "memory:write" }, origin, config);
          let memoryId: string;
          try { memoryId = decodeURIComponent(memoryIdMatch[1]!); } catch { return json(res, 400, { error: "invalid_memory_id" }, origin, config); }
          if (!memoryId || memoryId.length > 256) return json(res, 400, { error: "invalid_memory_id" }, origin, config);
          const deleted = await deps.userMemoryStore.delete(auth.keyId, memoryId);
          return deleted ? json(res, 200, { deleted: true }, origin, config) : json(res, 404, { error: "memory_not_found" }, origin, config);
        }
        return json(res, 405, { error: "method_not_allowed" }, origin, config);
      }

      const isCronRequest = requestUrl.pathname.startsWith("/v1/cron/");
      if (isCronRequest && !deps.jobRuntime) return json(res, 503, { error: "cron_scheduler_unavailable" }, origin, config);
      if (isCronRequest && req.method === "GET" && !auth.scopes.some(scope => scope === "cron:read" || scope === "cron:manage")) {
        return json(res, 403, { error: "forbidden", requiredScope: "cron:read" }, origin, config);
      }
      if (isCronRequest && req.method !== "GET" && !auth.scopes.includes("cron:manage")) {
        return json(res, 403, { error: "forbidden", requiredScope: "cron:manage" }, origin, config);
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

      const adminScope = config.securityAdminScope ?? "security:admin";
      const isSecurityAdmin = auth.scopes.includes(adminScope);
      if (req.method === "GET" && req.url === "/v1/models") {
        const routes = deps.router.listRoutes?.();
        if (!routes) return json(res, 503, { error: "model_selection_unavailable" }, origin, config);
        return json(res, 200, {
          automaticSelection: true,
          models: routes.map((route) => ({
            id: route.id,
            model: route.model ?? route.id,
            capabilities: [...route.capabilities],
            healthy: route.healthy,
          })),
        }, origin, config);
      }
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
        let run = runs.get(id);
        // During a rolling restart, the request may reach a new API process
        // whose in-memory map has not seen a run accepted by the previous one.
        // Rehydrate from the shared persistent store, and refresh newer records
        // so status polling follows updates written by the original process.
        const stored = runStore?.load?.(id);
        if (stored && (!run || stored.updatedAt > run.updatedAt)) {
          run = {
            id: stored.id,
            status: stored.status,
            ...(stored.result ? { result: stored.result as unknown as AgentRunResponse["result"] } : {}),
            ...(stored.error ? { error: stored.error } : {}),
            controller: new AbortController(),
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            ownerKeyId: stored.ownerKeyId,
            desktopCapabilities: stored.desktopCapabilities as DesktopCapability[],
            ...(stored.idempotencyId ? { idempotencyId: stored.idempotencyId } : {}),
            ...(stored.requestFingerprint ? { requestFingerprint: stored.requestFingerprint } : {}),
          };
          runs.set(id, run);
        }
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
          void persist(run).catch(() => undefined);
        }
        return json(res, 200, publicResponse(run), origin, config);
      }

      if (req.method === "POST" && req.url === "/v1/agent/runs/stream") {
        const parsed = validateAgentRunInput(await body(req, maxBytes));
        if (!parsed.valid) return json(res, 400, { error: parsed.error }, origin, config);
        const input = parsed.input;
        const selectionError = modelSelectionError(input);
        if (selectionError) return json(res, selectionError.status, { error: selectionError.error }, origin, config);
        if (!input.task?.trim()) return json(res, 400, { error: "task_required" }, origin, config);
        try { usage.consume(auth.keyId); } catch {
          return json(res, 429, { error: "quota_exceeded" }, origin, config);
        }
        const runId = randomUUID();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        const run: ActiveRun = { id: runId, status: "queued", controller, createdAt: Date.now(), updatedAt: Date.now(), ownerKeyId: auth.keyId, desktopCapabilities: desktopCapabilitiesFromScopes(auth.scopes) };
        runs.set(runId, run);
        void persist(run).catch(() => undefined);
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
            ...(input.modelRouteId !== undefined ? { modelRouteId: input.modelRouteId } : {}),
            ...(input.sessionId !== undefined ? { sessionId: `${auth.keyId}:${input.sessionId}` } : {}),
            ...(input.context !== undefined ? { context: typeof input.context === "string" ? input.context : JSON.stringify(input.context) } : {}),
            ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
            ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria) } : {}),
            signal: controller.signal,
            onEvent: (event) => {
              if (!countToolCall(auth.keyId, controller, event)) return;
              send({ type: "event", runId, event });
            },
          });
          if (controller.signal.aborted) throw new Error("Run cancelled.");
          run.result = result;
          run.status = "completed";
          send({ type: "result", runId, status: "completed", result: run.result });
        } catch (error) {
          run.status = controller.signal.aborted ? "cancelled" : "failed";
          run.error = controller.signal.aborted
            ? controller.signal.reason instanceof Error ? controller.signal.reason.message : "Run cancelled."
            : error instanceof Error ? error.message : "Agent failed";
          send({ type: "error", runId, status: run.status, error: run.error });
        }
        send({ type: "done", runId });
        run.updatedAt = Date.now();
        void persist(run).catch(() => undefined);
        clearTimeout(timer);
        res.off("close", abortOnDisconnect);
        if (!res.destroyed) return res.end();
        return;
      }

      if (req.method === "POST" && req.url === "/v1/agent/runs") {
        const parsed = validateAgentRunInput(await body(req, maxBytes));
        if (!parsed.valid) return json(res, 400, { error: parsed.error }, origin, config);
        const input = parsed.input;
        const selectionError = modelSelectionError(input);
        if (selectionError) return json(res, selectionError.status, { error: selectionError.error }, origin, config);
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
          // Hash the owner-scoped key so raw idempotency tokens never reach disk.
          const idempotencyId = idempotencyKey
            ? createHash("sha256").update(auth.keyId).update(":").update(idempotencyKey).digest("hex")
            : undefined;
          const requestFingerprint = idempotencyFingerprint({
            task: input.task,
            ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
            ...(input.context !== undefined ? { context: input.context } : {}),
            ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
            ...(input.modelRouteId !== undefined ? { modelRouteId: input.modelRouteId } : {}),
            ...(input.acceptanceCriteria !== undefined ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
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
            ...(idempotencyId ? { idempotencyId, requestFingerprint } : {}),
          };
          runs.set(runId, run);
          try {
            // A 202 response is an acceptance promise: persist the queued record
            // before acknowledging so a following status poll cannot race the disk write.
            await persist(run);
          } catch {
            runs.delete(runId);
            return json(res, 503, { error: "run_persistence_unavailable" }, origin, config);
          }
          if (idempotencyId) idempotency.set(idempotencyId, { runId, fingerprint: requestFingerprint });
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
            ...(input.modelRouteId !== undefined ? { modelRouteId: input.modelRouteId } : {}),
            ...(input.sessionId !== undefined ? { sessionId: `${auth.keyId}:${input.sessionId}` } : {}),
            ...(input.context !== undefined ? { context: typeof input.context === "string" ? input.context : JSON.stringify(input.context) } : {}),
            ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
            ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria) } : {}),
            signal: controller.signal,
            onEvent: (event) => { countToolCall(auth.keyId, controller, event); },
          });
          if (controller.signal.aborted) {
            const reason = controller.signal.reason instanceof Error ? controller.signal.reason.message : "Request timed out or was cancelled.";
            return json(res, reason === "API tool-call quota exceeded." ? 429 : 504, { id: runId, status: "failed", error: reason }, origin, config);
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

      if (isCronRequest && cronScheduler) {
        const schedulePath = "/v1/cron/schedules";
        const historyMatch = requestUrl.pathname.match(/^\/v1\/cron\/schedules\/([^/]+)\/history$/);
        const actionMatch = requestUrl.pathname.match(/^\/v1\/cron\/schedules\/([^/]+)\/(enable|disable)$/);
        if (req.method === "GET" && requestUrl.pathname === schedulePath) {
          return json(res, 200, { schedules: await cronScheduler.list(auth.keyId) }, origin, config);
        }
        if (req.method === "POST" && requestUrl.pathname === schedulePath) {
          const raw = await body(req, maxBytes);
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json(res, 400, { error: "invalid_cron_schedule" }, origin, config);
          const input = raw as Record<string, unknown>;
          if (typeof input.name !== "string" || input.name.length > 200 ||
              typeof input.task !== "string" || input.task.length > 20_000 ||
              typeof input.timeZone !== "string" || input.timeZone.length > 100) {
            return json(res, 400, { error: "invalid_cron_schedule", message: "name, task and timeZone are required and must be within limits" }, origin, config);
          }
          if (input.cron !== undefined && typeof input.cron !== "string") return json(res, 400, { error: "invalid_cron_schedule", message: "cron must be a string" }, origin, config);
          if (input.runAt !== undefined && typeof input.runAt !== "string") return json(res, 400, { error: "invalid_cron_schedule", message: "runAt must be a string" }, origin, config);
          if (input.misfirePolicy !== undefined && input.misfirePolicy !== "skip" && input.misfirePolicy !== "run-once") {
            return json(res, 400, { error: "invalid_cron_schedule", message: "misfirePolicy must be skip or run-once" }, origin, config);
          }
          if (input.maxRetries !== undefined && (!Number.isInteger(input.maxRetries) || Number(input.maxRetries) < 0 || Number(input.maxRetries) > 10)) {
            return json(res, 400, { error: "invalid_cron_schedule", message: "maxRetries must be an integer from 0 to 10" }, origin, config);
          }
          if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || Number(input.timeoutMs) < 1_000 || Number(input.timeoutMs) > 3_600_000)) {
            return json(res, 400, { error: "invalid_cron_schedule", message: "timeoutMs must be an integer from 1000 to 3600000" }, origin, config);
          }
          if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
            return json(res, 400, { error: "invalid_cron_schedule", message: "enabled must be a boolean" }, origin, config);
          }
          const scheduleInput: CronScheduleInput = {
            name: input.name, task: input.task, timeZone: input.timeZone, ownerKeyId: auth.keyId,
            ...(typeof input.cron === "string" ? { cron: input.cron } : {}),
            ...(typeof input.runAt === "string" ? { runAt: input.runAt } : {}),
            ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
            ...(input.misfirePolicy === "skip" || input.misfirePolicy === "run-once" ? { misfirePolicy: input.misfirePolicy } : {}),
            ...(typeof input.maxRetries === "number" ? { maxRetries: input.maxRetries } : {}),
            ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
          };
          try {
            const created = await cronScheduler.create(scheduleInput, auth.keyId);
            return json(res, 201, created, origin, config);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Invalid cron schedule";
            return json(res, message.startsWith("Schedule quota exceeded") ? 429 : 400, { error: message.startsWith("Schedule quota exceeded") ? "quota_exceeded" : "invalid_cron_schedule", message }, origin, config);
          }
        }
        if (historyMatch && req.method === "GET") {
          try {
            return json(res, 200, { history: await cronScheduler.history(historyMatch[1]!, auth.keyId) }, origin, config);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Cron history unavailable";
            const status = message === "Unknown cron schedule" ? 404 : message.startsWith("Not authorized") ? 403 : 400;
            return json(res, status, { error: "cron_history_unavailable", message }, origin, config);
          }
        }
        if (actionMatch && req.method === "POST") {
          try {
            const updated = await cronScheduler.setEnabled(actionMatch[1]!, actionMatch[2] === "enable", auth.keyId);
            return json(res, 200, updated, origin, config);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Cron schedule update failed";
            const status = message === "Unknown cron schedule" ? 404 : message.startsWith("Not authorized") ? 403 : 400;
            return json(res, status, { error: "cron_schedule_update_failed", message }, origin, config);
          }
        }
        const cancelMatch = requestUrl.pathname.match(/^\/v1\/cron\/schedules\/([^/]+)$/);
        if (cancelMatch && req.method === "DELETE") {
          try {
            const cancelled = await cronScheduler.cancel(cancelMatch[1]!, auth.keyId);
            return cancelled
              ? json(res, 200, { id: cancelMatch[1], status: "disabled" }, origin, config)
              : json(res, 404, { error: "cron_schedule_not_found" }, origin, config);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Cron schedule cancellation failed";
            const status = message.startsWith("Not authorized") ? 403 : 400;
            return json(res, status, { error: "cron_schedule_cancel_failed", message }, origin, config);
          }
        }
        return json(res, 404, { error: "not_found" }, origin, config);
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
        const selectionError = modelSelectionError(input);
        if (selectionError) return json(res, selectionError.status, { error: selectionError.error }, origin, config);
        if (!input.task?.trim()) return json(res, 400, { error: "task_required" }, origin, config);
        try { usage.consume(auth.keyId); } catch { return json(res, 429, { error: "quota_exceeded" }, origin, config); }
        try {
          const job = await deps.jobRuntime.submit({
            task: input.task,
            ...(input.modelRouteId !== undefined ? { modelRouteId: input.modelRouteId } : {}),
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
  if (cronScheduler) {
    server.on("listening", () => {
      void (async () => {
        try {
          await cronScheduler.recover();
          if (cronClosed) return;
          await cronScheduler.tick();
          if (cronClosed) return;
          cronTimer = setInterval(() => { void cronScheduler.tick().catch(() => undefined); }, 1_000);
        } catch {
          // Fail closed: do not dispatch scheduled work if recovery could not complete.
        }
      })();
    });
    server.on("close", () => {
      cronClosed = true;
      if (cronTimer) clearInterval(cronTimer);
      cronTimer = undefined;
    });
  }
  return server;
}
