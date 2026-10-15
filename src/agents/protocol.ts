import { randomUUID } from "node:crypto";

export type AgentRole = "orchestrator" | "planner" | "researcher" | "coder" | "tester" | "security" | "reviewer" | "specialist";
export type AgentMessageKind = "task" | "proposal" | "evidence" | "handoff" | "review" | "status" | "result";

export interface AgentIdentity {
  id: string;
  role: AgentRole;
  /** Host-granted capabilities. Never populate this from an agent message. */
  capabilities: readonly string[];
}
export interface AgentTaskScope {
  jobId: string;
  objective: string;
  allowedTools: readonly string[];
  workspaceRoot?: string;
  maxHops: number;
  deadlineEpochMs?: number;
}
export interface AgentMessage<T = unknown> {
  version: 1;
  id: string;
  correlationId: string;
  jobId: string;
  from: string;
  to: string;
  kind: AgentMessageKind;
  createdAt: number;
  /** Payload is untrusted data, never an implicit tool command. */
  payload: T;
  evidenceIds?: string[];
}
export interface CoordinationLimits {
  maxMessages: number;
  maxHops: number;
  maxPayloadBytes: number;
  maxAgeMs: number;
}
export const DEFAULT_COORDINATION_LIMITS: Readonly<CoordinationLimits> = Object.freeze({
  maxMessages: 80, maxHops: 8, maxPayloadBytes: 64 * 1024, maxAgeMs: 10 * 60 * 1000,
});
export class CoordinationError extends Error {
  constructor(message: string, readonly code: "INVALID_MESSAGE" | "SCOPE_VIOLATION" | "BUDGET_EXCEEDED" | "CANCELLED" | "POLICY_DENIED") {
    super(message); this.name = "CoordinationError";
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function payloadSize(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8"); }
  catch { return Number.POSITIVE_INFINITY; }
}
export function createAgentMessage<T>(input: Omit<AgentMessage<T>, "version" | "id" | "createdAt"> & { id?: string; createdAt?: number }): AgentMessage<T> {
  return {
    version: 1, id: input.id ?? randomUUID(), createdAt: input.createdAt ?? Date.now(),
    correlationId: input.correlationId, jobId: input.jobId, from: input.from, to: input.to,
    kind: input.kind, payload: input.payload,
    ...(input.evidenceIds ? { evidenceIds: [...input.evidenceIds] } : {}),
  };
}
export function validateAgentMessage(
  message: unknown, scope: AgentTaskScope, registeredAgents: ReadonlyMap<string, AgentIdentity>,
  limits: CoordinationLimits = DEFAULT_COORDINATION_LIMITS, now = Date.now(),
): asserts message is AgentMessage {
  if (!validCoordinationLimits(limits)) {
    throw new CoordinationError("Invalid coordination limits.", "BUDGET_EXCEEDED");
  }
  if (!isRecord(message) || message.version !== 1 ||
      typeof message.id !== "string" || !message.id || message.id.length > 256 ||
      typeof message.correlationId !== "string" || !message.correlationId || message.correlationId.length > 256 ||
      typeof message.jobId !== "string" || !message.jobId || message.jobId.length > 256 ||
      typeof message.from !== "string" || !message.from || message.from.length > 256 ||
      typeof message.to !== "string" || !message.to || message.to.length > 256 ||
      !["task", "proposal", "evidence", "handoff", "review", "status", "result"].includes(String(message.kind)) ||
      typeof message.createdAt !== "number" || !Number.isFinite(message.createdAt) || !("payload" in message)) {
    throw new CoordinationError("Invalid agent message envelope.", "INVALID_MESSAGE");
  }
  if (message.jobId !== scope.jobId) throw new CoordinationError("Message belongs to a different job.", "SCOPE_VIOLATION");
  if (!registeredAgents.has(message.from) || !registeredAgents.has(message.to)) throw new CoordinationError("Sender or recipient is not registered.", "POLICY_DENIED");
  if (message.createdAt > now + 30_000 || now - message.createdAt > limits.maxAgeMs) throw new CoordinationError("Message is expired or timestamp is invalid.", "INVALID_MESSAGE");
  if (payloadSize(message.payload) > limits.maxPayloadBytes) throw new CoordinationError("Message payload exceeds configured limit.", "BUDGET_EXCEEDED");
  if (scope.deadlineEpochMs !== undefined && now > scope.deadlineEpochMs) throw new CoordinationError("Task deadline has passed.", "BUDGET_EXCEEDED");
  if (scope.maxHops < 0 || scope.maxHops > limits.maxHops) throw new CoordinationError("Task hop limit exceeds policy.", "BUDGET_EXCEEDED");
  if (message.evidenceIds !== undefined && (!Array.isArray(message.evidenceIds) || message.evidenceIds.length > 256 || message.evidenceIds.some(id => typeof id !== "string" || !id || id.length > 256))) {
    throw new CoordinationError("Evidence references must be bounded non-empty strings.", "INVALID_MESSAGE");
  }
}
function validCoordinationLimits(limits: CoordinationLimits): boolean {
  return Number.isSafeInteger(limits.maxMessages) && limits.maxMessages >= 1 &&
    Number.isSafeInteger(limits.maxHops) && limits.maxHops >= 0 &&
    Number.isSafeInteger(limits.maxPayloadBytes) && limits.maxPayloadBytes >= 1 &&
    Number.isSafeInteger(limits.maxAgeMs) && limits.maxAgeMs >= 1;
}
/** Bounded in-memory queue. Durable deployments must persist deduplication with the queue. */
export class AgentMessageBus {
  private readonly queue: AgentMessage[] = [];
  private readonly seen = new Set<string>();
  private closed = false;
  constructor(private readonly scope: AgentTaskScope, private readonly agents: ReadonlyMap<string, AgentIdentity>, private readonly limits: CoordinationLimits = DEFAULT_COORDINATION_LIMITS) {}
  publish(message: AgentMessage, now = Date.now()): void {
    if (this.closed) throw new CoordinationError("Agent message bus is closed.", "CANCELLED");
    validateAgentMessage(message, this.scope, this.agents, this.limits, now);
    if (this.seen.has(message.id)) throw new CoordinationError("Duplicate message ID.", "INVALID_MESSAGE");
    if (this.queue.length >= this.limits.maxMessages) throw new CoordinationError("Message budget exceeded.", "BUDGET_EXCEEDED");
    // Snapshot the envelope at publication time. Retaining caller-owned objects
    // would let a sender mutate a queued message after validation.
    let snapshot: AgentMessage;
    try {
      snapshot = JSON.parse(JSON.stringify(message)) as AgentMessage;
    } catch {
      throw new CoordinationError("Message cannot be safely serialized.", "INVALID_MESSAGE");
    }
    validateAgentMessage(snapshot, this.scope, this.agents, this.limits, now);
    this.seen.add(snapshot.id);
    this.queue.push(snapshot);
  }
  takeFor(agentId: string, now = Date.now()): AgentMessage | undefined {
    if (this.closed) throw new CoordinationError("Agent message bus is closed.", "CANCELLED");
    if (!this.agents.has(agentId)) throw new CoordinationError("Recipient is not registered.", "POLICY_DENIED");
    const index = this.queue.findIndex(message => message.to === agentId);
    if (index < 0) return undefined;
    const [message] = this.queue.splice(index, 1);
    // A message may have become stale while queued, so re-check freshness and
    // the job deadline at consumption, not only at publication.
    validateAgentMessage(message, this.scope, this.agents, this.limits, now);
    return message;
  }
  pendingCount(): number { return this.queue.length; }
  close(): void { this.closed = true; this.queue.length = 0; }
  isClosed(): boolean { return this.closed; }
}
