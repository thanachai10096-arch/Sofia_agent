import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { SofiaAgent } from "../agent/core.js";
import type { AgentDependencies } from "../agent/types.js";
import type { DesktopCapability } from "../desktop/types.js";
import type { AgentRunInput, AgentRunResponse, AgentRunStatus, SofiaApiConfig } from "./types.js";
import { UsageLimiter } from "./usage.js";
import { validateAgentRunInput } from "./validation.js";
import type { RunRecord } from "./run-record-store.js";
import { ConversationService } from "../conversation/session.js";

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
  conversationId?: string;
  assistantMessageId?: string;
  events: import("../agent/types.js").AgentEvent[];
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
      passed: (value as { passed?: unknown } | null)?.passed === true,
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
  const conversations = config.conversationStore ? new ConversationService(config.conversationStore) : undefined;
  const toRunRecord = (run: ActiveRun): RunRecord => ({
    id: run.id, status: run.status,
    ...(run.result ? { result: run.result as unknown as import("../agent/types.js").AgentResult } : {}),
    ...(run.error ? { error: run.error } : {}), createdAt: run.createdAt, updatedAt: run.updatedAt,
    ownerKeyId: run.ownerKeyId, desktopCapabilities: [...run.desktopCapabilities],
    ...(run.conversationId ? { conversationId: run.conversationId } : {}),
    ...(run.assistantMessageId ? { assistantMessageId: run.assistantMessageId } : {}),
    events: [...run.events],
  });
  const persist = (run: ActiveRun) => {
    if (runStore) void runStore.save(toRunRecord(run)).catch(() => undefined);
  };
  const persistRequired = async (run: ActiveRun) => {
    if (runStore) await runStore.save(toRunRecord(run));
  };
  if (runStore) for (const record of runStore.loadAllSync()) {
    const interrupted = record.status === "queued" || record.status === "running";
    const validStatus = ["queued","running","completed","failed","cancelled"].includes(record.status);
    if (!validStatus || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt) ||
        !Array.isArray(record.desktopCapabilities) || !record.desktopCapabilities.every((x) => typeof x === "string")) {
      void runStore.remove(record.id).catch(() => undefined); continue;
    }
    const run: ActiveRun = {
      id: record.id, status: interrupted ? "failed" : record.status,
      ...(record.result ? { result: record.result as unknown as AgentRunResponse["result"] } : {}),
      ...(interrupted ? { error: "Run interrupted by server restart." } : record.error ? { error: record.error } : {}),
      controller: new AbortController(), createdAt: record.createdAt,
      updatedAt: interrupted ? Date.now() : record.updatedAt, ownerKeyId: record.ownerKeyId,
      desktopCapabilities: record.desktopCapabilities as DesktopCapability[],
      ...(record.conversationId ? { conversationId: record.conversationId } : {}),
      ...(record.assistantMessageId ? { assistantMessageId: record.assistantMessageId } : {}),
      events: [...(record.events ?? [])],
    };
    runs.set(run.id, run); if (interrupted) persist(run);
  }
  const idempotency = new Map<string, string>();
  const activeByKey = new Map<string, number>();
  const activeConversationTurns = new Set<string>();
  const runSubscribers = new Map<string, Set<(event: import("../agent/types.js").AgentEvent) => void>>();
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

  const startRun = (run: ActiveRun, input: AgentRunInput, onSettled?: (run: ActiveRun) => void) => {
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
          onEvent: (event) => {
            run.events.push(event);
            if (run.events.length > 500) run.events.shift();
            persist(run);
            for (const subscriber of runSubscribers.get(run.id) ?? []) subscriber(event);
          },
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
        onSettled?.(run);
        const current = activeByKey.get(run.ownerKeyId) ?? 1;
        if (current <= 1) activeByKey.delete(run.ownerKeyId); else activeByKey.set(run.ownerKeyId, current - 1);
      }
    })();
  };

  const prune = () => {
    const cutoff = Date.now() - retention;
    for (const [id, run] of runs) {
      if (run.updatedAt < cutoff && !["queued", "running"].includes(run.status)) { runs.delete(id); if (runStore) void runStore.remove(id).catch(() => undefined); }
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

      // Conversation storage endpoints are optional until a durable store is configured.
      // The authenticated API key hash is the owner boundary; client-supplied owner IDs are ignored.
      if (req.url === "/v1/conversations" && (req.method === "GET" || req.method === "POST")) {
        if (!conversations) return json(res, 503, { error: "conversation_store_unavailable" }, origin, config);
        if (req.method === "GET") {
          if (!auth.scopes.some((scope) => scope === "agent:read" || scope === "agent:run")) {
            return json(res, 403, { error: "forbidden", requiredScope: "agent:read" }, origin, config);
          }
          return json(res, 200, { conversations: conversations.list(auth.keyId) }, origin, config);
        }
        if (!auth.scopes.includes("agent:run")) {
          return json(res, 403, { error: "forbidden", requiredScope: "agent:run" }, origin, config);
        }
        const input = await body(req, maxBytes) as { title?: unknown } | null;
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          return json(res, 400, { error: "invalid_request_body" }, origin, config);
        }
        if (input.title !== undefined && typeof input.title !== "string") {
          return json(res, 400, { error: "invalid_title" }, origin, config);
        }
        try {
          return json(res, 201, { conversation: conversations.create(auth.keyId, typeof input.title === "string" ? input.title : undefined) }, origin, config);
        } catch (error) {
          return json(res, 400, { error: "invalid_conversation", message: error instanceof Error ? error.message : "Invalid conversation" }, origin, config);
        }
      }

      const conversationStreamMatch = req.url?.split("?")[0]?.match(/^\/v1\/conversations\/([0-9a-f-]{36})\/turns\/([0-9a-f-]{36})\/stream$/i);
      if (conversationStreamMatch && req.method === "GET") {
        if (!conversations) return json(res, 503, { error: "conversation_store_unavailable" }, origin, config);
        if (!auth.scopes.some((scope) => scope === "agent:read" || scope === "agent:run")) {
          return json(res, 403, { error: "forbidden", requiredScope: "agent:read" }, origin, config);
        }
        const conversationId = conversationStreamMatch[1]!;
        const runId = conversationStreamMatch[2]!;
        const conversation = conversations.get(auth.keyId, conversationId);
        const run = runs.get(runId);
        if (!conversation || !run || run.ownerKeyId !== auth.keyId || run.conversationId !== conversationId) {
          return json(res, 404, { error: "conversation_turn_not_found" }, origin, config);
        }
        res.writeHead(200, {
          ...headers(origin, config),
          "content-type": "text/event-stream; charset=utf-8",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        const send = (value: unknown) => {
          if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(value)}\n\n`);
        };
        for (const [index, event] of run.events.entries()) send({ type: "event", runId, sequence: index, event });
        const sendTerminal = () => {
          const latest = runs.get(runId);
          if (!latest) return;
          if (latest.status === "completed" || latest.status === "failed" || latest.status === "cancelled") {
            const session = conversations.get(auth.keyId, conversationId);
            const assistantMessage = latest.assistantMessageId
              ? session?.messages.find((message) => message.id === latest.assistantMessageId)
              : undefined;
            send({
              type: "status",
              runId,
              status: latest.status,
              ...(assistantMessage ? { assistantMessage } : {}),
              ...(latest.result ? { result: latest.result } : {}),
              ...(latest.error ? { error: latest.error } : {}),
            });
            if (!res.writableEnded && !res.destroyed) res.end();
            return true;
          }
          return false;
        };
        if (sendTerminal()) return;
        const subscribers = runSubscribers.get(runId) ?? new Set<(event: import("../agent/types.js").AgentEvent) => void>();
        const subscriber = (event: import("../agent/types.js").AgentEvent) => send({ type: "event", runId, event });
        subscribers.add(subscriber);
        runSubscribers.set(runId, subscribers);
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const cleanup = () => {
          if (heartbeat) clearInterval(heartbeat);
          subscribers.delete(subscriber);
          if (subscribers.size === 0) runSubscribers.delete(runId);
        };
        heartbeat = setInterval(() => {
          if (res.destroyed || res.writableEnded) return;
          res.write(": keep-alive\n\n");
          if (sendTerminal()) cleanup();
        }, 10_000);
        res.on("close", cleanup);
        return;
      }

      const conversationTurnMatch = req.url?.split("?")[0]?.match(/^\/v1\/conversations\/([0-9a-f-]{36})\/turns\/([0-9a-f-]{36})$/i);
      if (conversationTurnMatch && req.method === "GET") {
        if (!conversations) return json(res, 503, { error: "conversation_store_unavailable" }, origin, config);
        if (!auth.scopes.some((scope) => scope === "agent:read" || scope === "agent:run")) {
          return json(res, 403, { error: "forbidden", requiredScope: "agent:read" }, origin, config);
        }
        const conversationId = conversationTurnMatch[1]!;
        const runId = conversationTurnMatch[2]!;
        const conversation = conversations.get(auth.keyId, conversationId);
        const run = runs.get(runId);
        if (!conversation || !run || run.ownerKeyId !== auth.keyId || run.conversationId !== conversationId) {
          return json(res, 404, { error: "conversation_turn_not_found" }, origin, config);
        }
        const assistantMessage = run.status === "completed" && run.assistantMessageId
          ? conversation.messages.find((message) => message.id === run.assistantMessageId)
          : undefined;
        return json(res, 200, {
          conversationId,
          runId,
          status: run.status,
          ...(assistantMessage ? { assistantMessage } : {}),
          ...(run.result ? { result: run.result } : {}),
          ...(run.error ? { error: run.error } : {}),
        }, origin, config);
      }

      const conversationPath = req.url?.split("?")[0]?.split("/") ?? [];
      const conversationMatch = conversationPath[1] === "v1" && conversationPath[2] === "conversations" && conversationPath.length >= 4 && conversationPath.length <= 5 && (conversationPath.length === 4 || conversationPath[4] === "messages") && /^[0-9a-f-]{36}$/i.test(conversationPath[3] ?? "")
        ? [req.url ?? "", conversationPath[3] ?? "", conversationPath.length === 5 ? "messages" : undefined]
        : null;
      if (conversationMatch) {
        if (!conversations) return json(res, 503, { error: "conversation_store_unavailable" }, origin, config);
        const conversationId = conversationMatch[1] ?? "";
        const messagesPath = conversationMatch[2] === "messages";
        if (req.method === "GET" && !messagesPath) {
          if (!auth.scopes.some((scope) => scope === "agent:read" || scope === "agent:run")) {
            return json(res, 403, { error: "forbidden", requiredScope: "agent:read" }, origin, config);
          }
          const conversation = conversations.get(auth.keyId, conversationId);
          return conversation ? json(res, 200, { conversation }, origin, config) : json(res, 404, { error: "conversation_not_found" }, origin, config);
        }
        if (!auth.scopes.includes("agent:run")) {
          return json(res, 403, { error: "forbidden", requiredScope: "agent:run" }, origin, config);
        }
        if (req.method === "DELETE" && !messagesPath) {
          return conversations.delete(auth.keyId, conversationId)
            ? json(res, 200, { ok: true }, origin, config)
            : json(res, 404, { error: "conversation_not_found" }, origin, config);
        }
        if (req.method === "DELETE" && messagesPath) {
          try { return json(res, 200, { conversation: conversations.clear(auth.keyId, conversationId) }, origin, config); }
          catch { return json(res, 404, { error: "conversation_not_found" }, origin, config); }
        }
        if (req.method === "POST" && messagesPath) {
          const input = await body(req, maxBytes) as { role?: unknown; content?: unknown } | null;
          // Clients may submit only user messages; assistant/tool messages are server-owned.
          if (!input || typeof input !== "object" || Array.isArray(input) || input.role !== "user" || typeof input.content !== "string") {
            return json(res, 400, { error: "user_message_required" }, origin, config);
          }
          const asyncTurn = (input as { async?: unknown }).async === true;
          const conversationTurnKey = auth.keyId + ":" + conversationId;
          if (activeConversationTurns.has(conversationTurnKey)) {
            res.setHeader("retry-after", "1");
            return json(res, 409, { error: "conversation_turn_in_progress", retryAfterMs: 1000 }, origin, config);
          }
          // Check capacity before consuming quota or mutating conversation history.
          // No await occurs between this check and the later increment.
          const active = activeByKey.get(auth.keyId) ?? 0;
          if (active >= maxConcurrentRunsPerKey) {
            res.setHeader("retry-after", "2");
            return json(res, 429, { error: "concurrency_limit", retryAfterMs: 2000 }, origin, config);
          }
          try {
            conversations.validateAppend(auth.keyId, conversationId, { role: "user", content: input.content });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Invalid conversation message.";
            const status = /not found/i.test(message) ? 404 : 400;
            return json(res, status, { error: status === 404 ? "conversation_not_found" : "invalid_message", message }, origin, config);
          }
          try {
            usage.consume(auth.keyId);
          } catch (error) {
            return json(res, 429, { error: "quota_exceeded", message: error instanceof Error ? error.message : "Quota exceeded" }, origin, config);
          }
          let userMessage;
          try {
            userMessage = conversations.append(auth.keyId, conversationId, { role: "user", content: input.content });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Invalid conversation message.";
            const status = /not found/i.test(message) ? 404 : 400;
            return json(res, status, { error: status === 404 ? "conversation_not_found" : "invalid_message", message }, origin, config);
          }

          // Route the user's natural-language turn through the existing Sofia Agent.
          // The conversation layer stores context; it does not introduce a second planner.
          const context = conversations.buildContext(auth.keyId, conversationId);
          // One active generation per conversation preserves user/assistant turn order.
          activeConversationTurns.add(conversationTurnKey);
          // Count synchronous and asynchronous conversation turns against the same
          // per-key limit used by the ordinary run endpoints.
          activeByKey.set(auth.keyId, active + 1);
          if (asyncTurn) {
            const runId = randomUUID();
            const run: ActiveRun = {
              id: runId,
              status: "queued",
              controller: new AbortController(),
              createdAt: Date.now(),
              updatedAt: Date.now(),
              ownerKeyId: auth.keyId,
              desktopCapabilities: desktopCapabilitiesFromScopes(auth.scopes),
              conversationId,
              events: [],
            };
            runs.set(runId, run);
            try {
              await persistRequired(run);
            } catch {
              runs.delete(runId);
              try { conversations.removeMessage(auth.keyId, conversationId, userMessage.id); } catch { /* best-effort rollback if the conversation store itself failed */ }
              usage.refundRun(auth.keyId);
              activeConversationTurns.delete(conversationTurnKey);
              const current = activeByKey.get(auth.keyId) ?? 1;
              if (current <= 1) activeByKey.delete(auth.keyId); else activeByKey.set(auth.keyId, current - 1);
              return json(res, 503, { error: "run_persistence_unavailable" }, origin, config);
            }
            startRun(run, {
              task: input.content,
              context: JSON.stringify(context.messages),
            }, (settled) => {
              try {
                if (settled.status !== "completed" || !settled.result || settled.assistantMessageId) return;
                try {
                  const assistant = conversations.appendAssistantResponse(auth.keyId, conversationId, settled.result.output, userMessage.id);
                  if (assistant) {
                    settled.assistantMessageId = assistant.id;
                    settled.updatedAt = Date.now();
                    persist(settled);
                  }
                } catch {
                  // Keep the run result available; a deleted conversation must not fail the run.
                }
              } finally {
                activeConversationTurns.delete(conversationTurnKey);
              }
            });
            return json(res, 202, {
              conversationId,
              userMessage,
              run: publicResponse(run),
              pollUrl: `/v1/conversations/${conversationId}/turns/${runId}`,
              contextTruncated: context.truncated,
            }, origin, config);
          }
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
          try {
            const result = await agent.run({
              principalId: auth.keyId,
              desktopCapabilities: desktopCapabilitiesFromScopes(auth.scopes),
              task: input.content,
              context: JSON.stringify(context.messages),
              signal: controller.signal,
            });
            if (controller.signal.aborted) {
              return json(res, 504, { error: "conversation_turn_timeout", userMessage }, origin, config);
            }
            const assistantMessage = conversations.appendAssistantResponse(auth.keyId, conversationId, result.output, userMessage.id);
            return json(res, 200, {
              conversationId,
              userMessage,
              ...(assistantMessage ? { assistantMessage } : {}),
              result,
              contextTruncated: context.truncated,
            }, origin, config);
          } catch (error) {
            return json(res, controller.signal.aborted ? 504 : 502, {
              error: controller.signal.aborted ? "conversation_turn_timeout" : "conversation_turn_failed",
              message: controller.signal.aborted ? "Sofia did not finish before the request timeout." : error instanceof Error ? error.message : "Agent failed",
              conversationId,
              userMessage,
            }, origin, config);
          } finally {
            clearTimeout(timer);
            activeConversationTurns.delete(conversationTurnKey);
            const current = activeByKey.get(auth.keyId) ?? 1;
            if (current <= 1) activeByKey.delete(auth.keyId);
            else activeByKey.set(auth.keyId, current - 1);
          }
        }
        return json(res, 405, { error: "method_not_allowed" }, origin, config);
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
        const run: ActiveRun = { id: runId, status: "queued", controller, createdAt: Date.now(), updatedAt: Date.now(), ownerKeyId: auth.keyId, desktopCapabilities: desktopCapabilitiesFromScopes(auth.scopes), events: [] };
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
            onEvent: (event) => {
              run.events.push(event);
              if (run.events.length > 500) run.events.shift();
              send({ type: "event", runId, event });
            },
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
            events: [],
          };
          runs.set(runId, run);
          try {
            await persistRequired(run);
          } catch {
            runs.delete(runId);
            return json(res, 503, { error: "run_persistence_unavailable" }, origin, config);
          }
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
