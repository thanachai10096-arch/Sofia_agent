import type { WorkflowPlan } from "./workflow-plan-store.js";

export function createWorkflowPlan(
  title: string,
  definitions: Array<{ id: string; title: string; description: string; idempotent: boolean; dependsOn?: string[] }>,
  options: { id?: string; now?: string } = {},
): WorkflowPlan {
  const now = options.now ?? new Date().toISOString();
  return {
    id: options.id ?? "plan-" + now.replace(/[^0-9]/g, ""),
    title,
    createdAt: now,
    updatedAt: now,
    status: "draft",
    steps: definitions.map(step => ({
      id: step.id,
      title: step.title,
      description: step.description,
      idempotent: step.idempotent,
      dependsOn: [...(step.dependsOn ?? [])],
      status: (step.dependsOn?.length ?? 0) === 0 ? "ready" : "pending",
      attempts: 0,
      evidenceIds: [],
      updatedAt: now,
    })),
  };
}
