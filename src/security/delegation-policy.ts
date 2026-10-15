import type { AgentIdentity, AgentTaskScope } from "../agents/protocol.js";

export type DelegationDecision = { allowed: true; reason: string } | { allowed: false; reason: string };
export interface DelegationRequest {
  /** Host-authenticated principal; must match the active job scope when bound. */
  principalId?: string;
  requesterId: string; recipientId: string; jobId: string; requestedTools: readonly string[]; hop: number; purpose: string;
}
export interface DelegationPolicy {
  maxHops: number;
  maxDelegationsPerAgent: number;
  allowedRoles: ReadonlySet<string>;
  neverDelegateTools: ReadonlySet<string>;
}
export const DEFAULT_DELEGATION_POLICY: DelegationPolicy = {
  maxHops: 5, maxDelegationsPerAgent: 8,
  allowedRoles: new Set(["planner", "researcher", "coder", "tester", "security", "reviewer", "specialist"]),
  neverDelegateTools: new Set(["security.policy.update", "security.kill_switch.revive", "secrets.read", "credentials.export"]),
};
/** Authorizes coordination only; tool execution still requires the central Tool Gateway. */
export class DelegationAuthorizer {
  private readonly counts = new Map<string, number>();
  constructor(private readonly agents: ReadonlyMap<string, AgentIdentity>, private readonly scope: AgentTaskScope, private readonly policy: DelegationPolicy = DEFAULT_DELEGATION_POLICY) {}

  authorize(request: DelegationRequest): DelegationDecision {
    // Treat this boundary as runtime input: callers may be decoding model/tool output.
    if (!request || typeof request !== "object" ||
        typeof request.requesterId !== "string" || typeof request.recipientId !== "string" ||
        typeof request.jobId !== "string" || typeof request.purpose !== "string" ||
        !Array.isArray(request.requestedTools) ||
        !request.requestedTools.every((tool) => typeof tool === "string" && tool.length > 0)) {
      return { allowed: false, reason: "Malformed delegation request." };
    }
    if (!Number.isSafeInteger(request.hop) || request.hop < 0 ||
        !Number.isSafeInteger(this.policy.maxHops) || this.policy.maxHops < 0 ||
        !Number.isSafeInteger(this.scope.maxHops) || this.scope.maxHops < 0) {
      return { allowed: false, reason: "Invalid delegation hop budget." };
    }
    if (!Number.isSafeInteger(this.policy.maxDelegationsPerAgent) || this.policy.maxDelegationsPerAgent < 0) {
      return { allowed: false, reason: "Invalid delegation count budget." };
    }
    const requester = this.agents.get(request.requesterId);
    const recipient = this.agents.get(request.recipientId);
    if (!requester || !recipient) return { allowed: false, reason: "Unknown agent identity." };
    if (request.jobId !== this.scope.jobId) return { allowed: false, reason: "Delegation is outside the active job." };
    if (this.scope.principalId !== undefined && request.principalId !== this.scope.principalId) return { allowed: false, reason: "Delegation principal does not match the active job owner." };
    if (request.requesterId === request.recipientId) return { allowed: false, reason: "Self-delegation is not allowed." };
    if (!request.purpose.trim() || request.purpose.length > 1000) return { allowed: false, reason: "Purpose is missing or too long." };
    if (request.hop >= Math.min(this.policy.maxHops, this.scope.maxHops)) return { allowed: false, reason: "Delegation hop limit reached." };
    if (recipient.role === "orchestrator" || !this.policy.allowedRoles.has(recipient.role)) return { allowed: false, reason: "Recipient role is not eligible." };
    if (request.requestedTools.some(tool => this.policy.neverDelegateTools.has(tool))) return { allowed: false, reason: "Request includes a non-delegable privileged tool." };
    if (request.requestedTools.some(tool => !this.scope.allowedTools.includes(tool) || !requester.capabilities.includes(tool) || !recipient.capabilities.includes(tool))) {
      return { allowed: false, reason: "Requested tool is outside job scope or agent capabilities." };
    }
    const count = this.counts.get(request.requesterId) ?? 0;
    if (count >= this.policy.maxDelegationsPerAgent) return { allowed: false, reason: "Per-agent delegation budget exceeded." };
    this.counts.set(request.requesterId, count + 1);
    return { allowed: true, reason: "Delegation is within registered identity, scope, and budget." };
  }

  resetJobCounters(): void { this.counts.clear(); }
}
