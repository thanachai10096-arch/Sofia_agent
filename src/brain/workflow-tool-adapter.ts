import type { ToolGateway, ToolExecutionContext } from "./types.js";
import type { WorkflowOrchestratorDependencies } from "./workflow-orchestrator.js";

/**
 * Bridges persisted workflow actions to Sofia's existing ToolGateway.
 * The gateway remains the authorization boundary; this adapter adds a conservative
 * workflow-level gate for mutating tools and uses the gateway's real checkpoint API.
 */
export function createToolGatewayWorkflowAdapter(input: {
  gateway: ToolGateway;
  principalId?: string;
  requestApproval?: WorkflowOrchestratorDependencies["requestApproval"];
  onApprovalState?: (waiting: boolean, workflowId: string, stepId: string) => void;
  allowShell?: boolean;
  allowNetwork?: boolean;
}): Pick<WorkflowOrchestratorDependencies, "executeStep" | "createCheckpoint" | "requestApproval"> {
  return {
    createCheckpoint: async (plan, step) => {
      const controller = new AbortController();
      const checkpoint = await input.gateway.checkpoint(controller.signal);
      if (!checkpoint.id.trim() || !checkpoint.revision.trim()) {
        throw new Error("Tool gateway returned an unverifiable checkpoint");
      }
      return { id: checkpoint.id, verified: true };
    },
    requestApproval: input.requestApproval,
    executeStep: async (step, context) => {
      if (!step.action) throw new Error(`Workflow step "${step.id}" has no concrete tool action`);
      const descriptor = input.gateway.describe(step.action.tool);
      if (!descriptor) throw new Error(`Unknown or unavailable tool: ${step.action.tool}`);
      if (descriptor.effects.includes("shell") && input.allowShell === false) {
        throw new Error("Workflow tool blocked: shell execution is disabled");
      }
      if (descriptor.effects.includes("network") && input.allowNetwork === false) {
        throw new Error("Workflow tool blocked: network access is disabled");
      }
      const mutates = descriptor.effects.includes("write") || descriptor.effects.includes("destructive");
      if (mutates && !step.consequential) {
        throw new Error("Mutating tool actions must be marked consequential to require checkpoint and approval");
      }
      const controller = new AbortController();
      const signal = context.signal ?? controller.signal;
      const toolContext: ToolExecutionContext = {
        runId: context.workflowId,
        ...(input.principalId ? { principalId: input.principalId } : {}),
        signal,
        requireApproval: mutates || descriptor.effects.includes("destructive"),
        notifyApproval: (waiting) => input.onApprovalState?.(waiting, context.workflowId, step.id),
      };
      const result = await input.gateway.execute(
        { tool: step.action.tool, input: step.action.input },
        toolContext,
      );
      if (!result.ok) {
        throw new Error(result.error?.message ?? `Tool action failed: ${step.action.tool}`);
      }
      return { evidenceIds: [result.evidenceId] };
    },
  };
}
