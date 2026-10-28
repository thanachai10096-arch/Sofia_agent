import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { SofiaAgent } from "../agent/core.js";
import type { AgentDependencies } from "../agent/types.js";
import type { DesktopCapability } from "../desktop/types.js";
import type { AgentRunInput, AgentRunResponse, AgentRunStatus, SofiaApiConfig } from "./types.js";
import { UsageLimiter } from "./usage.js";
import { idempotencyFingerprint } from "./idempotency.js";
import { handleDiscordInteractionHttpRequest } from "../integrations/messaging/discord-http-route.js";
import { handleSlackEventsHttpRequest } from "../integrations/messaging/slack-http-route.js";
import { handleLineWebhookHttpRequest } from "../integrations/messaging/line-http-route.js";
import { handleWhatsAppWebhookHttpRequest } from "../integrations/messaging/whatsapp-http-route.js";
import { validateAgentRunInput } from "./validation.js";
import type { RunRecord } from "./run-record-store.js";
import { CronScheduler, type CronScheduleInput } from "../brain/cron-scheduler.js";
import { createCronTools } from "../brain/cron-tools.js";
import type { MapToolRegistry } from "../tools/types.js";
import { createUserMemoryEntry, type UserMemoryKind } from "../brain/user-memory.js";
import type { ContinuousWorkRecord } from "../brain/continuous-work.js";

interface ActiveRun {
  id: string;
  status: AgentRunStatus;
  result?: AgentRunResponse["result"];
  error?: string;
  controller: AbortController;
  /** Sticky in-memory cancellation intent; late results cannot clear it. */
  cancelRequested?: boolean;
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

function isCancellationRequested(run: ActiveRun): boolean {
  return run.cancelRequested === true || run.status === "cancelled" || run.controller.signal.aborted;
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

function verifyMessagingContext(input: AgentRunInput, config: SofiaApiConfig): import("../brain/types.js").NotificationTarget | null | undefined {
  const context = input._messagingContext;
  if (context === undefined) return undefined;
  const secret = config.messagingContextSecret?.trim();
  if (!secret || secret.length < 32 || !context || typeof context !== "object") return null;
  const platforms = new Set(["telegram", "discord", "slack", "line", "whatsapp", "matrix"]);
  if (!platforms.has(context.platform) || ![context.userId, context.conversationId, context.messageId].every(value => typeof value === "string" && value.length > 0 && value.length <= 512) ||
      typeof context.taskHash !== "string" || !/^[a-f0-9]{64}$/.test(context.taskHash) || typeof context.signature !== "string" || !/^[a-f0-9]{64}$/.test(context.signature)) return null;
  if (createHash("sha256").update(input.task).digest("hex") !== context.taskHash) return null;
  const unsigned = { platform: context.platform, userId: context.userId, conversationId: context.conversationId, messageId: context.messageId, taskHash: context.taskHash };
  const expected = createHmac("sha256", secret).update(JSON.stringify(unsigned)).digest();
  const supplied = Buffer.from(context.signature, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  return { platform: context.platform, userId: context.userId, conversationId: context.conversationId };
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
  const slackRoute = config.slackEventsRoute;
  const slackRoutePath = slackRoute?.path ?? "/v1/integrations/slack/events";
  const slackMaxBodyBytes = slackRoute?.maxBodyBytes ?? 1_000_000;
  if (slackRoute && (!slackRoutePath.startsWith("/") || slackRoutePath.includes("?") || slackRoutePath.includes("#"))) {
    throw new Error("Slack Events route path must be an absolute path without query or fragment.");
  }
  if (slackRoute && (!Number.isSafeInteger(slackMaxBodyBytes) || slackMaxBodyBytes < 1 || slackMaxBodyBytes > 1_000_000)) {
    throw new Error("Slack Events route maxBodyBytes must be between 1 and 1000000.");
  }
  if (slackRoute && discordRoute && slackRoutePath === discordRoutePath) {
    throw new Error("Discord and Slack messaging routes must use different paths.");
  }
  const lineRoute = config.lineWebhookRoute;
  const lineRoutePath = lineRoute?.path ?? "/v1/integrations/line/webhook";
  const lineMaxBodyBytes = lineRoute?.maxBodyBytes ?? 1_000_000;
  if (lineRoute && (!lineRoutePath.startsWith("/") || lineRoutePath.includes("?") || lineRoutePath.includes("#"))) {
    throw new Error("LINE webhook route path must be an absolute path without query or fragment.");
  }
  if (lineRoute && (!Number.isSafeInteger(lineMaxBodyBytes) || lineMaxBodyBytes < 1 || lineMaxBodyBytes > 1_000_000)) {
    throw new Error("LINE webhook route maxBodyBytes must be between 1 and 1000000.");
  }
  if (lineRoute && ((discordRoute && lineRoutePath === discordRoutePath) ||
      (slackRoute && lineRoutePath === slackRoutePath))) {
    throw new Error("Discord, Slack, and LINE messaging routes must use different paths.");
  }
  const whatsAppRoute = config.whatsAppWebhookRoute;
  const whatsAppRoutePath = whatsAppRoute?.path ?? "/v1/integrations/whatsapp/webhook";
  const whatsAppMaxBodyBytes = whatsAppRoute?.maxBodyBytes ?? 1_000_000;
  if (whatsAppRoute && (!whatsAppRoutePath.startsWith("/") || whatsAppRoutePath.includes("#") ||
      whatsAppRoutePath.includes("?"))) {
    throw new Error("WhatsApp webhook route path must be an absolute path without query or fragment.");
  }
  if (whatsAppRoute && (!Number.isSafeInteger(whatsAppMaxBodyBytes) || whatsAppMaxBodyBytes < 1 || whatsAppMaxBodyBytes > 1_000_000)) {
    throw new Error("WhatsApp webhook route maxBodyBytes must be between 1 and 1000000.");
  }
  if (whatsAppRoute && ((discordRoute && whatsAppRoutePath === discordRoutePath) ||
      (slackRoute && whatsAppRoutePath === slackRoutePath) ||
      (lineRoute && whatsAppRoutePath === lineRoutePath))) {
    throw new Error("Discord, Slack, LINE, and WhatsApp messaging routes must use different paths.");
  }
  const maxRunsPerKeyPerDay = integerSetting("maxRunsPerKeyPerDay", config.maxRunsPerKeyPerDay, 100, 0, 1_000_000);
  const maxToolCallsPerKeyPerDay = integerSetting("maxToolCallsPerKeyPerDay", config.maxToolCallsPerKeyPerDay, 1000, 0, 1_000_000);
  const usage = new UsageLimiter(maxRunsPerKeyPerDay, maxToolCallsPerKeyPerDay, config.usageStorePath);
  const countToolCall = (keyId: string, controller: AbortController, event: { type: string }): boolean => {
    if (event.type !== "tool.started") return true;
    try { usage.consumeToolCall(keyId); return true; }
    catch { controller.abort(new Error("API tool-call quota exceeded.")); return false; }
  };
  const countBrainUsage = (keyId: string, event: { type: string; metadata?: Record<string, unknown> }): void => {
    if (event.type !== "model.completed" || !event.metadata?.usage || typeof event.metadata.usage !== "object") return;
    const metrics = event.metadata.usage as Record<string, unknown>;
    if (!Number.isSafeInteger(metrics.modelCalls) || !Number.isSafeInteger(metrics.reservedOrUsedTokens) ||
        (metrics.modelCalls as number) < 0 || (metrics.reservedOrUsedTokens as number) < 0) return;
    const providerInputTokens = metrics.providerInputTokens;
    const providerOutputTokens = metrics.providerOutputTokens;
    const providerUsageCalls = metrics.providerUsageCalls;
    const configuredCostNanoUsd = metrics.configuredCostNanoUsd;
    const hasProviderUsage = Number.isSafeInteger(providerInputTokens) && (providerInputTokens as number) >= 0 &&
      Number.isSafeInteger(providerOutputTokens) && (providerOutputTokens as number) >= 0 &&
      Number.isSafeInteger(providerUsageCalls) && (providerUsageCalls as number) >= 0;
    const hasConfiguredCost = typeof configuredCostNanoUsd === "string" &&
      /^(0|[1-9][0-9]*)$/.test(configuredCostNanoUsd);
    try {
      usage.recordBrainUsage(keyId, {
        modelCalls: metrics.modelCalls as number,
        reservedOrUsedTokens: metrics.reservedOrUsedTokens as number,
        ...(hasProviderUsage ? { providerInputTokens: providerInputTokens as number, providerOutputTokens: providerOutputTokens as number, providerUsageCalls: providerUsageCalls as number } : {}),
        ...(hasConfiguredCost && hasProviderUsage ? { configuredCostNanoUsd: configuredCostNanoUsd as string } : {}),
      });
    } catch {
      // Usage reporting must not turn a successful agent run into a failed run.
    }
  };
  const cronScheduler = deps.jobRuntime ? new CronScheduler(deps.jobRuntime, { onExecutionFinished: config.onCronExecutionFinished }) : undefined;
  // Register the agent-facing scheduler tool against the same scheduler instance that the API ticks.
  // Keep this API-only: local CLI sessions do not run the background scheduler loop.
  if (cronScheduler && deps.tools && !deps.tools.get("schedule_task")) {
    (deps.tools as MapToolRegistry).addTools(createCronTools(cronScheduler));
  }
  let cronTimer: NodeJS.Timeout | undefined;
  let cronClosed = false;
  const runs = new Map<string, ActiveRun>();
  const runStore = config.runStore;
  const persist = (run: ActiveRun) => {
    if (!runStore) return;
    const record: RunRecord = {
      id: run.id, status: run.cancelRequested ? "cancelled" : run.status,
      ...(run.result ? { result: run.result as unknown as import("../agent/types.js").AgentResult } : {}),
      ...(run.error ? { error: run.error } : {}), createdAt: run.createdAt, updatedAt: run.updatedAt,
      ownerKeyId: run.ownerKeyId, desktopCapabilities: [...run.desktopCapabilities],
      ...(run.idempotencyId ? { idempotencyId: run.idempotencyId } : {}),
      ...(run.requestFingerprint ? { requestFingerprint: run.requestFingerprint } : {}),
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
      ...(record.idempotencyId ? { idempotencyId: record.idempotencyId } : {}),
      ...(record.requestFingerprint ? { requestFingerprint: record.requestFingerprint } : {}),
    };
    runs.set(run.id, run); if (interrupted) persist(run);
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

  const startRun = (run: ActiveRun, input: AgentRunInput) => {
    void (async () => {
      run.status = "running";
      run.updatedAt = Date.now();
      persist(run);
      const timer = setTimeout(() => run.controller.abort(), requestTimeoutMs);
      try {
        const result = await agent.run({
          principalId: input._trustedMessagingTarget ? input._trustedMessagingTarget.platform + ":" + input._trustedMessagingTarget.userId : run.ownerKeyId,
          ...(input._trustedMessagingTarget ? { notificationTarget: input._trustedMessagingTarget } : {}),
          desktopCapabilities: run.desktopCapabilities,
          task: input.task,
          ...(input.sessionId !== undefined ? { sessionId: `${run.ownerKeyId}:${input.sessionId}` } : {}),
          ...(input.context !== undefined ? { context: typeof input.context === "string" ? input.context : JSON.stringify(input.context) } : {}),
          ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
          ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria) } : {}),
          signal: run.controller.signal,
          onEvent: (event) => { countToolCall(run.ownerKeyId, run.controller, event); countBrainUsage(run.ownerKeyId, event); },
        });
        // Cancellation is terminal: a late agent result must never overwrite it,
        // even if the underlying agent ignores the abort signal until it returns.
        if (isCancellationRequested(run)) {
          run.status = "cancelled";
          run.error ??= run.controller.signal.reason instanceof Error
            ? run.controller.signal.reason.message
            : "Run cancelled.";
        } else {
          run.result = result;
          run.status = "completed";
        }
      } catch (error) {
        if (isCancellationRequested(run)) {
          run.status = "cancelled";
          run.error ??= run.controller.signal.reason instanceof Error
            ? run.controller.signal.reason.message
            : "Run cancelled.";
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
    for (const [key, entry] of idempotency) {
      if (!runs.has(entry.runId)) idempotency.delete(key);
    }
  };

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    try {
      if (discordRoute && req.url === discordRoutePath) {
        await handleDiscordInteractionHttpRequest(req, res, discordRoute.transport, discordMaxBodyBytes);
        return;
      }
      if (slackRoute && req.url === slackRoutePath) {
        await handleSlackEventsHttpRequest(req, res, slackRoute.transport, slackMaxBodyBytes);
        return;
      }
      if (lineRoute && req.url === lineRoutePath) {
        await handleLineWebhookHttpRequest(req, res, lineRoute.transport, lineMaxBodyBytes);
        return;
      }
      if (whatsAppRoute && req.url && new URL(req.url, "http://localhost").pathname === whatsAppRoutePath) {
        await handleWhatsAppWebhookHttpRequest(req, res, whatsAppRoute.transport, req.url, whatsAppMaxBodyBytes);
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

      const auth = authenticate(req, config);
      if (!auth) return json(res, 401, { error: "unauthorized" }, origin, config);

      const requestUrl = new URL(req.url ?? "/", "http://sofia.local");
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

      if (requestUrl.pathname === "/v1/continuous-work/chat") {
        if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" }, origin, config);
        if (!auth.scopes.includes("agent:run")) return json(res, 403, { error: "forbidden", requiredScope: "agent:run" }, origin, config);
        const supervisor = config.continuousWorkSupervisor;
        if (!supervisor) return json(res, 503, { error: "continuous_work_unavailable" }, origin, config);
        const raw = await body(req, maxBytes);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json(res, 400, { error: "invalid_chat_action" }, origin, config);
        const envelope = raw as Record<string, unknown>;
        if (typeof envelope.signedTask !== "string" || envelope.signedTask.length > 8_000 ||
            !envelope._messagingContext || typeof envelope._messagingContext !== "object" || Array.isArray(envelope._messagingContext)) {
          return json(res, 400, { error: "invalid_chat_action" }, origin, config);
        }
        const target = verifyMessagingContext({
          task: envelope.signedTask,
          _messagingContext: envelope._messagingContext as AgentRunInput["_messagingContext"],
        }, config);
        if (!target) return json(res, 401, { error: "invalid_messaging_context" }, origin, config);
        let actionInput: unknown;
        try { actionInput = JSON.parse(envelope.signedTask); }
        catch { return json(res, 400, { error: "invalid_chat_action" }, origin, config); }
        if (!actionInput || typeof actionInput !== "object" || Array.isArray(actionInput)) return json(res, 400, { error: "invalid_chat_action" }, origin, config);
        const action = actionInput as Record<string, unknown>;
        const allowedFields = new Set(["action", "task", "workId"]);
        if (Object.keys(action).some((key) => !allowedFields.has(key)) ||
            !["create", "list", "status", "resume", "continue", "pause", "stop"].includes(String(action.action))) {
          return json(res, 400, { error: "invalid_chat_action" }, origin, config);
        }
        const owner = "chat:" + createHash("sha256").update(JSON.stringify([target.platform, target.userId])).digest("hex");
        if (action.action === "create") {
          if (typeof action.task !== "string" || !action.task.trim() || action.task.length > 4_000 || action.workId !== undefined) {
            return json(res, 400, { error: "task_required" }, origin, config);
          }
          try {
            const work = await supervisor.create(owner, action.task);
            return json(res, 201, { work }, origin, config);
          } catch (error) {
            return json(res, 400, { error: error instanceof Error ? error.message : "invalid_continuous_work" }, origin, config);
          }
        }
        if (action.task !== undefined || (action.action === "list" && action.workId !== undefined)) {
          return json(res, 400, { error: "invalid_chat_action" }, origin, config);
        }
        if (action.action === "list") return json(res, 200, { work: await supervisor.list(owner) }, origin, config);
        if (typeof action.workId !== "string" || !action.workId.trim() || action.workId.length > 128 || action.workId.includes("/")) {
          return json(res, 400, { error: "work_id_required" }, origin, config);
        }
        const workId = action.workId;
        const current = await supervisor.get(workId, owner);
        if (!current) return json(res, 404, { error: "continuous_work_not_found" }, origin, config);
        if (action.action === "status") return json(res, 200, { work: current }, origin, config);
        if (action.action === "continue") {
          const started = await supervisor.runContinuously(workId, owner);
          return started ? json(res, 202, { accepted: true, workId, mode: "continuous" }, origin, config)
            : json(res, 409, { error: "continuous_work_not_startable", status: current.status }, origin, config);
        }
        if (action.action === "resume") {
          if (supervisor.isContinuous(workId)) return json(res, 409, { error: "continuous_work_mode_active" }, origin, config);
          if (current.status === "active" && supervisor.isRunning(workId)) return json(res, 409, { error: "continuous_work_already_active" }, origin, config);
          if (current.status === "stopped" || current.status === "completed") return json(res, 409, { error: "continuous_work_terminal", status: current.status }, origin, config);
          void supervisor.resume(workId, owner).catch(() => undefined);
          return json(res, 202, { accepted: true, workId, status: "active" }, origin, config);
        }
        if (action.action === "pause" || action.action === "stop") {
          const changed = action.action === "pause" ? await supervisor.pause(workId, owner) : await supervisor.stop(workId, owner);
          const latest = await supervisor.get(workId, owner);
          return changed && latest ? json(res, 200, { work: latest }, origin, config)
            : json(res, 409, { error: "continuous_work_not_changeable", status: latest?.status }, origin, config);
        }
        return json(res, 400, { error: "invalid_chat_action" }, origin, config);
      }

      const continuousWorkMatch = requestUrl.pathname.match(/^\/v1\/continuous-work(?:\/([^/]+)(?:\/(resume|continue|pause|stop))?)?$/);
      if (continuousWorkMatch) {
        const supervisor = config.continuousWorkSupervisor;
        if (!supervisor) return json(res, 503, { error: "continuous_work_unavailable" }, origin, config);
        const encodedId = continuousWorkMatch[1];
        let workId: string | undefined;
        if (encodedId) {
          try { workId = decodeURIComponent(encodedId); }
          catch { return json(res, 400, { error: "invalid_continuous_work_id" }, origin, config); }
          if (!workId || workId.length > 128 || workId.includes("/")) {
            return json(res, 400, { error: "invalid_continuous_work_id" }, origin, config);
          }
        }
        if (req.method === "GET") {
          if (!auth.scopes.some((scope) => scope === "agent:read" || scope === "agent:run")) {
            return json(res, 403, { error: "forbidden", requiredScope: "agent:read" }, origin, config);
          }
          if (workId) {
            const record = await supervisor.get(workId, auth.keyId);
            return record
              ? json(res, 200, { work: record }, origin, config)
              : json(res, 404, { error: "continuous_work_not_found" }, origin, config);
          }
          return json(res, 200, { work: await supervisor.list(auth.keyId) }, origin, config);
        }
        if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" }, origin, config);
        if (!auth.scopes.includes("agent:run")) {
          return json(res, 403, { error: "forbidden", requiredScope: "agent:run" }, origin, config);
        }
        const action = continuousWorkMatch[2];
        if (!workId) {
          if (action) return json(res, 400, { error: "continuous_work_id_required" }, origin, config);
          const raw = await body(req, maxBytes);
          if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof (raw as Record<string, unknown>).task !== "string") {
            return json(res, 400, { error: "task_required" }, origin, config);
          }
          try {
            const record = await supervisor.create(auth.keyId, (raw as { task: string }).task);
            return json(res, 201, { work: record }, origin, config);
          } catch (error) {
            return json(res, 400, { error: error instanceof Error ? error.message : "invalid_continuous_work" }, origin, config);
          }
        }
        const current = await supervisor.get(workId, auth.keyId);
        if (!current) return json(res, 404, { error: "continuous_work_not_found" }, origin, config);
        if (action === "continue") {
          const started = await supervisor.runContinuously(workId, auth.keyId);
          return started
            ? json(res, 202, { accepted: true, workId, mode: "continuous" }, origin, config)
            : json(res, 409, { error: "continuous_work_not_startable", status: current.status }, origin, config);
        }
        if (action === "resume") {
          if (supervisor.isContinuous(workId)) return json(res, 409, { error: "continuous_work_mode_active" }, origin, config);
          if (current.status === "active" && supervisor.isRunning(workId)) return json(res, 409, { error: "continuous_work_already_active" }, origin, config);
          if (current.status === "stopped" || current.status === "completed") {
            return json(res, 409, { error: "continuous_work_terminal", status: current.status }, origin, config);
          }
          // Start bounded work asynchronously; clients poll GET for durable progress.
          void supervisor.resume(workId, auth.keyId).catch(() => undefined);
          return json(res, 202, { accepted: true, workId, status: "active" }, origin, config);
        }
        if (action === "pause" || action === "stop") {
          const changed = action === "pause"
            ? await supervisor.pause(workId, auth.keyId)
            : await supervisor.stop(workId, auth.keyId);
          const latest: ContinuousWorkRecord | undefined = await supervisor.get(workId, auth.keyId);
          return changed && latest
            ? json(res, 200, { work: latest }, origin, config)
            : json(res, 409, { error: "continuous_work_not_changeable", status: latest?.status }, origin, config);
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
          run.cancelRequested = true;
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
        const trustedMessagingTarget = verifyMessagingContext(input, config);
        if (input._messagingContext !== undefined && !trustedMessagingTarget) return json(res, 403, { error: "invalid_messaging_context" }, origin, config);
        input._trustedMessagingTarget = trustedMessagingTarget ?? undefined;

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
            principalId: input._trustedMessagingTarget ? input._trustedMessagingTarget.platform + ":" + input._trustedMessagingTarget.userId : auth.keyId,
            ...(input._trustedMessagingTarget ? { notificationTarget: input._trustedMessagingTarget } : {}),
            desktopCapabilities: desktopCapabilitiesFromScopes(auth.scopes),
            task: input.task,
            ...(input.sessionId !== undefined ? { sessionId: `${auth.keyId}:${input.sessionId}` } : {}),
            ...(input.context !== undefined ? { context: typeof input.context === "string" ? input.context : JSON.stringify(input.context) } : {}),
            ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
            ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria) } : {}),
            signal: controller.signal,
            onEvent: (event) => {
              if (!countToolCall(auth.keyId, controller, event)) return;
              countBrainUsage(auth.keyId, event);
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
        const trustedMessagingTarget = verifyMessagingContext(input, config);
        if (input._messagingContext !== undefined && !trustedMessagingTarget) return json(res, 403, { error: "invalid_messaging_context" }, origin, config);
        input._trustedMessagingTarget = trustedMessagingTarget ?? undefined;

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
          persist(run);
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
            principalId: input._trustedMessagingTarget ? input._trustedMessagingTarget.platform + ":" + input._trustedMessagingTarget.userId : auth.keyId,
            ...(input._trustedMessagingTarget ? { notificationTarget: input._trustedMessagingTarget } : {}),
            desktopCapabilities: desktopCapabilitiesFromScopes(auth.scopes),
            task: input.task,
            ...(input.sessionId !== undefined ? { sessionId: `${auth.keyId}:${input.sessionId}` } : {}),
            ...(input.context !== undefined ? { context: typeof input.context === "string" ? input.context : JSON.stringify(input.context) } : {}),
            ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
            ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria) } : {}),
            signal: controller.signal,
            onEvent: (event) => { countToolCall(auth.keyId, controller, event); countBrainUsage(auth.keyId, event); },
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

      if ((isCronRequest && cronScheduler) || requestUrl.pathname === "/v1/model-profile") {
        if (requestUrl.pathname === "/v1/model-profile") {
          const profileStore = deps.modelProfileStore;
          if (!profileStore) return json(res, 503, { error: "model_profile_storage_not_configured" }, origin, config);
          if (req.method === "GET") {
            if (!auth.scopes.includes("model:profile:read")) return json(res, 403, { error: "forbidden", requiredScope: "model:profile:read" }, origin, config);
            try {
              return json(res, 200, { profile: await profileStore.getMetadata(auth.keyId) ?? null }, origin, config);
            } catch {
              return json(res, 500, { error: "model_profile_unavailable" }, origin, config);
            }
          }
          if (req.method === "PUT") {
            if (!auth.scopes.includes("model:profile:write")) return json(res, 403, { error: "forbidden", requiredScope: "model:profile:write" }, origin, config);
            const raw = await body(req, maxBytes);
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json(res, 400, { error: "invalid_model_profile" }, origin, config);
            const value = raw as Record<string, unknown>;
            if (typeof value.provider !== "string" || !["openai-compatible", "gemini", "openrouter"].includes(value.provider) ||
                typeof value.model !== "string" || typeof value.apiKey !== "string" ||
                (value.baseUrl !== undefined && typeof value.baseUrl !== "string")) {
              return json(res, 400, { error: "invalid_model_profile", message: "provider, model, and apiKey are required; baseUrl is only for openai-compatible." }, origin, config);
            }
            try {
              const profile = await profileStore.set(auth.keyId, {
                provider: value.provider as import("../models/profile-store.js").UserModelProvider,
                model: value.model,
                apiKey: value.apiKey,
                ...(typeof value.baseUrl === "string" ? { baseUrl: value.baseUrl } : {}),
              });
              return json(res, 200, { profile }, origin, config);
            } catch (error) {
              const message = error instanceof Error ? error.message : "";
              const validationError = /^(Unsupported model provider|model must|apiKey must|baseUrl must|Built-in providers|A supported provider)/.test(message);
              return json(res, validationError ? 400 : 500, validationError ? { error: "invalid_model_profile", message } : { error: "model_profile_unavailable" }, origin, config);
            }
          }
          if (req.method === "DELETE") {
            if (!auth.scopes.includes("model:profile:write")) return json(res, 403, { error: "forbidden", requiredScope: "model:profile:write" }, origin, config);
            try {
              return json(res, 200, { deleted: await profileStore.delete(auth.keyId) }, origin, config);
            } catch {
              return json(res, 500, { error: "model_profile_unavailable" }, origin, config);
            }
          }
          res.setHeader("allow", "GET, PUT, DELETE");
          return json(res, 405, { error: "method_not_allowed" }, origin, config);
        }

        if (!cronScheduler) return json(res, 404, { error: "not_found" }, origin, config);
        const scheduler = cronScheduler;
        if (!scheduler) return json(res, 503, { error: "cron_scheduler_unavailable" }, origin, config);
        const schedulePath = "/v1/cron/schedules";
        const historyMatch = requestUrl.pathname.match(/^\/v1\/cron\/schedules\/([^/]+)\/history$/);
        const actionMatch = requestUrl.pathname.match(/^\/v1\/cron\/schedules\/([^/]+)\/(enable|disable)$/);
        if (req.method === "GET" && requestUrl.pathname === schedulePath) {
          return json(res, 200, { schedules: await scheduler.list(auth.keyId) }, origin, config);
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
            const created = await scheduler.create(scheduleInput, auth.keyId);
            return json(res, 201, created, origin, config);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Invalid cron schedule";
            return json(res, message.startsWith("Schedule quota exceeded") ? 429 : 400, { error: message.startsWith("Schedule quota exceeded") ? "quota_exceeded" : "invalid_cron_schedule", message }, origin, config);
          }
        }
        if (historyMatch && req.method === "GET") {
          try {
            return json(res, 200, { history: await scheduler.history(historyMatch[1]!, auth.keyId) }, origin, config);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Cron history unavailable";
            const status = message === "Unknown cron schedule" ? 404 : message.startsWith("Not authorized") ? 403 : 400;
            return json(res, status, { error: "cron_history_unavailable", message }, origin, config);
          }
        }
        if (actionMatch && req.method === "POST") {
          try {
            const updated = await scheduler.setEnabled(actionMatch[1]!, actionMatch[2] === "enable", auth.keyId);
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
            const cancelled = await scheduler.cancel(cancelMatch[1]!, auth.keyId);
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

      if (req.method === "GET" && new URL(req.url, "http://sofia.local").pathname === "/v1/usage") {
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
