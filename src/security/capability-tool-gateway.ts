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
    private readonly capabilityIdForTool: (toolName: string) => string = toolName => toolName,
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

    const capability = this.registry.get(capabilityId);
    if (capability?.effect === "financial") {
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
    });
  }

  snapshot(signal: AbortSignal) { return this.inner.snapshot(signal); }
  changedFiles(baselineSnapshotId: string, signal: AbortSignal) { return this.inner.changedFiles(baselineSnapshotId, signal); }
  checkpoint(signal: AbortSignal) { return this.inner.checkpoint(signal); }
  rollback(checkpointId: string, signal: AbortSignal) { return this.inner.rollback(checkpointId, signal); }
}
