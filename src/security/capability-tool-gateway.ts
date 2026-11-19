import type {
  ToolCall,
  ToolExecutionContext,
  ToolGateway,
  ToolResult,
} from "../brain/types.js";
import {
  authorizeCapability,
  CapabilityRegistry,
  type DelegatedAuthority,
} from "./capability-registry.js";
import { riskFor, type RiskLevel } from "./guard.js";

/**
 * Adds principal-bound capability authorization in front of the existing Brain
 * ToolGateway. Financial tools deliberately fail closed here until a transaction
 * executor can atomically reserve spend and reconcile provider outcomes.
 */
export class CapabilityGuardToolGateway implements ToolGateway {
  constructor(
    private readonly inner: ToolGateway,
    private readonly registry: CapabilityRegistry,
    private readonly resolveAuthority: (principalId: string) => Promise<DelegatedAuthority | undefined>,
    private readonly capabilityIdForTool: (toolName: string) => string | undefined = toolName => toolName,
  ) {}

  listTools(): Array<{ name: string; description: string; effects: readonly ("read" | "write" | "shell" | "network" | "browser" | "destructive")[] }> {
    return this.inner.listTools?.() ?? [];
  }

  describe(name: string) {
    return this.inner.describe(name);
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const descriptor = this.inner.describe(call.tool);
    if (!descriptor) {
      return { ok: false, data: null, evidenceId: "", error: { category: "permission_error", message: "Tool is not registered." } };
    }
    if (!context.principalId) {
      return { ok: false, data: null, evidenceId: "", error: { category: "permission_error", message: "Authenticated principal is required for capability execution." } };
    }

    const capabilityId = this.capabilityIdForTool(call.tool);
    if (!capabilityId) {
      return { ok: false, data: null, evidenceId: "", error: { category: "permission_error", message: "No explicit capability mapping exists for this tool." } };
    }
    const capability = this.registry.get(capabilityId);
    if (!capability) {
      return { ok: false, data: null, evidenceId: "", error: { category: "permission_error", message: "Mapped capability is not registered." } };
    }
    const actualRisk = riskFor(descriptor.effects, call.input);
    const riskOrder: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
    if (riskOrder[capability.risk] < riskOrder[actualRisk]) {
      return { ok: false, data: null, evidenceId: "", error: { category: "permission_error", message: "Capability risk is lower than the registered tool action risk." } };
    }
    const has = (effect: string) => descriptor.effects.includes(effect as typeof descriptor.effects[number]);
    const compatible =
      (capability.effect === "read" && !has("write") && !has("shell") && !has("destructive")) ||
      (capability.effect === "local_write" && has("write") && !has("network") && !has("browser") && !has("shell") && !has("destructive")) ||
      (capability.effect === "external_side_effect" && (has("network") || has("browser")) && !has("shell") && !has("destructive")) ||
      capability.effect === "financial";
    if (!compatible) {
      return { ok: false, data: null, evidenceId: "", error: { category: "permission_error", message: "Capability effect does not match the registered tool effects." } };
    }
    if (capability.transport === "browser" && !has("browser")) {
      return { ok: false, data: null, evidenceId: "", error: { category: "permission_error", message: "Browser capability is mapped to a non-browser tool." } };
    }
    if (capability.transport === "desktop" && !call.tool.startsWith("desktop.")) {
      return { ok: false, data: null, evidenceId: "", error: { category: "permission_error", message: "Desktop capability is mapped to a non-desktop tool." } };
    }
    const authority = await this.resolveAuthority(context.principalId);
    const input = call.input as Record<string, unknown>;
    const decision = authorizeCapability(
      this.registry,
      authority,
      {
        principalId: context.principalId,
        capabilityId,
        ...(typeof input.amountMinor === "number" ? { amountMinor: input.amountMinor } : {}),
        ...(typeof input.currency === "string" ? { currency: input.currency } : {}),
        ...(typeof input.merchantId === "string" ? { merchantId: input.merchantId } : {}),
      },
    );

    if (!decision.allowed) {
      return { ok: false, data: null, evidenceId: "", error: { category: "permission_error", message: decision.reason } };
    }

    if (capability.effect === "financial") {
      return {
        ok: false,
        data: null,
        evidenceId: "",
        error: {
          category: "permission_error",
          message: "Financial execution is disabled until an atomic transaction executor and provider reconciliation adapter are configured.",
        },
      };
    }

    if (decision.requiresApproval && !context.requireApproval) {
      return {
        ok: false,
        data: null,
        evidenceId: "",
        error: { category: "permission_error", message: "This capability requires human approval; the caller did not provide an approval gate." },
      };
    }

    return this.inner.execute(call, {
      ...context,
      requireApproval: context.requireApproval || decision.requiresApproval,
      // The downstream gateway may skip its generic approval prompt only for
      // this server-verified, non-critical delegated capability. Its other
      // policy, path, host, and risk checks remain in force.
      ...(!decision.requiresApproval && capability?.risk !== "critical"
        ? { delegatedCapabilityId: capabilityId }
        : {}),
    });
  }

  snapshot(signal: AbortSignal) { return this.inner.snapshot(signal); }
  changedFiles(baselineSnapshotId: string, signal: AbortSignal) { return this.inner.changedFiles(baselineSnapshotId, signal); }
  checkpoint(signal: AbortSignal) { return this.inner.checkpoint(signal); }
  rollback(checkpointId: string, signal: AbortSignal) { return this.inner.rollback(checkpointId, signal); }
}
