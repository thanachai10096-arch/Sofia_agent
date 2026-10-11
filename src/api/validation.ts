import type { AgentRunInput } from "./types.js";

export function validateAgentRunInput(value: unknown): { valid: true; input: AgentRunInput } | { valid: false; error: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, error: "invalid_request_body" };
  }
  const input = value as Record<string, unknown>;
  if (typeof input.task !== "string" || !input.task.trim()) return { valid: false, error: "task_required" };
  if (input.task.length > 100_000) return { valid: false, error: "task_too_long" };
  if (input.context !== undefined && typeof input.context !== "string" && (input.context === null || typeof input.context !== "object" || Array.isArray(input.context))) {
    return { valid: false, error: "invalid_context" };
  }
  if (input.maxSteps !== undefined && (!Number.isInteger(input.maxSteps) || (input.maxSteps as number) < 1 || (input.maxSteps as number) > 200)) {
    return { valid: false, error: "invalid_max_steps" };
  }
  if (input.async !== undefined && typeof input.async !== "boolean") return { valid: false, error: "invalid_async" };
  if (input.stream !== undefined && typeof input.stream !== "boolean") return { valid: false, error: "invalid_stream" };
  if (input.priority !== undefined && input.priority !== "normal" && input.priority !== "high") return { valid: false, error: "invalid_priority" };
  if (input.sessionId !== undefined && (typeof input.sessionId !== "string" || input.sessionId.length > 256)) return { valid: false, error: "invalid_session_id" };
  if (input.acceptanceCriteria !== undefined) {
    if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.length > 50) return { valid: false, error: "invalid_acceptance_criteria" };
    for (const item of input.acceptanceCriteria) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return { valid: false, error: "invalid_acceptance_criteria" };
      const criterion = item as Record<string, unknown>;
      if (typeof criterion.id !== "string" || !criterion.id.trim() || criterion.id.length > 128 ||
          typeof criterion.description !== "string" || !criterion.description.trim() || criterion.description.length > 2_000 ||
          criterion.probe === null || typeof criterion.probe !== "object" || Array.isArray(criterion.probe)) {
        return { valid: false, error: "invalid_acceptance_criteria" };
      }
      const probe = criterion.probe as Record<string, unknown>;
      if (typeof probe.tool !== "string" || !probe.tool.trim() || probe.tool.length > 128 ||
          probe.input === null || typeof probe.input !== "object" || Array.isArray(probe.input)) {
        return { valid: false, error: "invalid_acceptance_criteria" };
      }
    }
  }
  return { valid: true, input: value as AgentRunInput };
}
