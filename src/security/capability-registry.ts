import type { RiskLevel } from "./guard.js";

export type CapabilityEffect = "read" | "local_write" | "external_side_effect" | "financial";
export type CapabilityTransport = "api" | "browser" | "desktop";

export interface CapabilityDefinition {
  id: string;
  version: number;
  description: string;
  transport: CapabilityTransport;
  effect: CapabilityEffect;
  requiredScopes: readonly string[];
  risk: RiskLevel;
  inputSchema: Record<string, unknown>;
  supportsIdempotency: boolean;
  approvalRequired?: boolean;
}

export interface DelegatedAuthority {
  principalId: string;
  scopes: readonly string[];
  allowedCapabilityIds: readonly string[];
  expiresAt: number;
  /** Spending limits use integer minor units (e.g. satang, cents), never floating point. */
  currency?: string;
  maxPerTransactionMinor?: number;
  maxPerDayMinor?: number;
  allowedMerchants?: readonly string[];
}

export interface CapabilityInvocation {
  principalId: string;
  capabilityId: string;
  amountMinor?: number;
  currency?: string;
  merchantId?: string;
}

/** Trusted server-side ledger snapshot; never accept this value from model/user tool arguments. */
export interface SpendingSnapshot {
  currency: string;
  spentTodayMinor: number;
}

export type CapabilityDecision =
  | { allowed: true; requiresApproval: boolean; reason: string }
  | { allowed: false; requiresApproval: false; reason: string };

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SCOPE_PATTERN = /^[a-z][a-z0-9]*(?::[a-z0-9*.-]+)+$/;

function assertDefinition(definition: CapabilityDefinition): void {
  if (!ID_PATTERN.test(definition.id)) throw new Error("Invalid capability ID.");
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) throw new Error("Capability version must be a positive integer.");
  if (!definition.description.trim() || definition.description.length > 1000) throw new Error("Capability description is required and must be at most 1000 characters.");
  if (!Array.isArray(definition.requiredScopes) || definition.requiredScopes.length === 0 ||
      definition.requiredScopes.some(scope => !SCOPE_PATTERN.test(scope))) {
    throw new Error("Capabilities must declare valid required scopes.");
  }
  if (definition.effect === "financial" && definition.transport === "desktop") {
    throw new Error("Financial capabilities cannot use unrestricted desktop transport.");
  }
  if (definition.effect === "financial" && !definition.supportsIdempotency) {
    throw new Error("Financial capabilities must support idempotency or an equivalent provider reconciliation key.");
  }
  if (definition.inputSchema.type !== "object") throw new Error("Capability input schema must be an object schema.");
}

export class CapabilityRegistry {
  private readonly definitions = new Map<string, CapabilityDefinition>();

  constructor(definitions: readonly CapabilityDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: CapabilityDefinition): void {
    assertDefinition(definition);
    if (this.definitions.has(definition.id)) throw new Error("Capability is already registered: " + definition.id);
    this.definitions.set(definition.id, Object.freeze({
      ...definition,
      requiredScopes: Object.freeze([...definition.requiredScopes]),
      inputSchema: Object.freeze({ ...definition.inputSchema }),
    }));
  }

  get(id: string): CapabilityDefinition | undefined {
    return this.definitions.get(id);
  }

  list(): CapabilityDefinition[] {
    return [...this.definitions.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}

/**
 * Server-side default-deny authorization. The model cannot mint or widen this
 * authority: callers must load it from a trusted, principal-bound policy store.
 */
export function authorizeCapability(
  registry: CapabilityRegistry,
  authority: DelegatedAuthority | undefined,
  invocation: CapabilityInvocation,
  now = Date.now(),
  spending?: SpendingSnapshot,
): CapabilityDecision {
  const capability = registry.get(invocation.capabilityId);
  if (!capability) return { allowed: false, requiresApproval: false, reason: "Capability is not registered." };
  if (!authority) return { allowed: false, requiresApproval: false, reason: "No delegated authority is configured." };
  if (authority.principalId !== invocation.principalId) return { allowed: false, requiresApproval: false, reason: "Delegated authority belongs to a different principal." };
  if (!Number.isFinite(authority.expiresAt) || authority.expiresAt <= now) return { allowed: false, requiresApproval: false, reason: "Delegated authority has expired." };
  if (!authority.allowedCapabilityIds.includes(capability.id)) return { allowed: false, requiresApproval: false, reason: "Capability is outside the delegated allowlist." };
  if (!capability.requiredScopes.every(scope => authority.scopes.includes(scope))) return { allowed: false, requiresApproval: false, reason: "Required delegated scope is missing." };

  if (capability.effect === "financial") {
    if (!Number.isSafeInteger(invocation.amountMinor) || (invocation.amountMinor ?? 0) <= 0) {
      return { allowed: false, requiresApproval: false, reason: "Financial action requires a positive integer amount in minor currency units." };
    }
    if (!authority.currency || invocation.currency !== authority.currency) {
      return { allowed: false, requiresApproval: false, reason: "Transaction currency does not match the delegated currency." };
    }
    if (!Number.isSafeInteger(authority.maxPerTransactionMinor) || invocation.amountMinor! > authority.maxPerTransactionMinor!) {
      return { allowed: false, requiresApproval: false, reason: "Transaction exceeds the delegated per-transaction limit." };
    }
    if (!Number.isSafeInteger(authority.maxPerDayMinor) || authority.maxPerDayMinor! <= 0) {
      return { allowed: false, requiresApproval: false, reason: "A positive daily spending limit is required." };
    }
    if (!spending || spending.currency !== authority.currency ||
        !Number.isSafeInteger(spending.spentTodayMinor) || spending.spentTodayMinor < 0) {
      return { allowed: false, requiresApproval: false, reason: "A trusted same-currency daily spending snapshot is required." };
    }
    if (spending.spentTodayMinor + invocation.amountMinor! > authority.maxPerDayMinor!) {
      return { allowed: false, requiresApproval: false, reason: "Transaction exceeds the remaining delegated daily budget." };
    }
    if (!invocation.merchantId || !authority.allowedMerchants?.includes(invocation.merchantId)) {
      return { allowed: false, requiresApproval: false, reason: "Merchant is not on the delegated allowlist." };
    }
  }

  const requiresApproval = capability.approvalRequired === true ||
    capability.effect === "external_side_effect" ||
    capability.effect === "financial" ||
    capability.risk === "critical";
  return { allowed: true, requiresApproval, reason: requiresApproval
    ? "Within delegated scope; obtain the required human approval before execution."
    : "Within delegated scope and may execute autonomously." };
}
