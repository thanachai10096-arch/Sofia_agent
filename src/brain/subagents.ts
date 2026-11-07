import type { BrainReasoner, ToolCall, ToolGateway } from "./types.js";

export type SubagentRole =
  | "explorer"
  | "architect"
  | "coder"
  | "debugger"
  | "tester"
  | "reviewer"
  | "security"
  | "researcher";

export interface SubagentRequest {
  role: SubagentRole;
  task: string;
  context?: Record<string, unknown>;
  signal: AbortSignal;
}

export interface SubagentActionProposal {
  tool: ToolCall["tool"];
  input: ToolCall["input"];
  reason: string;
}

export interface SubagentResult {
  role: SubagentRole;
  summary: string;
  output: unknown;
  proposedAction?: SubagentActionProposal;
}

export interface SubagentRuntime {
  run(request: SubagentRequest): Promise<SubagentResult>;
}

const ROLE_INSTRUCTIONS: Record<SubagentRole, string> = {
  explorer: "Inspect the available project evidence and identify relevant files, constraints, conventions, and unknowns. Do not modify files.",
  architect: "Design the smallest safe implementation strategy. Identify dependencies, interfaces, sequencing, and risks. Do not modify files.",
  coder: "Propose concrete implementation changes that satisfy the task and project conventions. Do not claim changes were applied.",
  debugger: "Analyze the failure evidence, isolate the most likely root cause, and propose the next corrective action.",
  tester: "Define focused verification checks and identify likely regressions. Do not claim tests were executed.",
  reviewer: "Review the proposed approach for correctness, security, maintainability, and unnecessary complexity.",
  security: "Inspect the task for security, permission, data exposure, and unsafe execution risks. Recommend mitigations.",
  researcher: "Synthesize supplied evidence into actionable technical findings. Do not invent external facts or claim browsing.",
};

export function roleForTask(task: string, failureCategory?: string): SubagentRole {
  const text = task.toLowerCase();
  if (failureCategory) {
    if (failureCategory === "syntax_error" || failureCategory === "type_error" ||
        failureCategory === "runtime_error" || failureCategory === "tool_error") return "debugger";
    if (failureCategory === "dependency_error" || failureCategory === "environment_error") return "researcher";
    if (failureCategory === "permission_error" || failureCategory === "network_error") return "security";
    if (failureCategory === "incomplete_solution") return "tester";
  }
  if (/security|auth|permission|secret|token|credential|vulnerab/.test(text)) return "security";
  if (/test|verify|verification|regression/.test(text)) return "tester";
  if (/debug|bug|fix|error|broken|failure/.test(text)) return "debugger";
  if (/architect|architecture|design|system|api|schema/.test(text)) return "architect";
  if (/research|compare|investigate|explore|find out/.test(text)) return "researcher";
  if (/implement|code|build|create|add|write/.test(text)) return "coder";
  return "explorer";
}

/**
 * Specialist proposals are suggestions, never authority. This shared allowlist
 * is used both to build the child prompt's tool catalog and to validate the
 * proposal again in the parent Brain before dispatch.
 */
export const SUBAGENT_ALLOWED_TOOLS = new Set([
  "workspace.read_file",
  "workspace.list_files",
  "workspace.search",
  "git.diff",
  "project.verify",
  "workspace.write_file",
  "workspace.apply_patch",
]);

/** Coding recovery is not a default path for ordinary conversation. */
export function isSubagentWorthyTask(task: string, requiredTools: readonly string[] = []): boolean {
  if (requiredTools.some((tool) => SUBAGENT_ALLOWED_TOOLS.has(tool))) return true;
  return /\b(code|coding|typescript|javascript|python|program(?:ming)?|implement|repository|repo|compile|build|test|debug|bug|deploy|refactor)\b|โค้ด|เขียนโปรแกรม|แก้บั๊ก|แก้โค้ด|ทดสอบระบบ|พัฒนา/.test(task.toLowerCase());
}
function compact(value: unknown, max = 6_000): string {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  text ??= String(value);
  return text.length > max ? text.slice(0, max) + "\n[truncated]" : text;
}

export class InProcessSubagentRuntime implements SubagentRuntime {
  constructor(
    private readonly reasoner: BrainReasoner,
    private readonly tools?: ToolGateway,
  ) {}

  async run(request: SubagentRequest): Promise<SubagentResult> {
    request.signal.throwIfAborted();

    const instructions = ROLE_INSTRUCTIONS[request.role];
    const evidence = this.tools
      ? await this.tools.snapshot(request.signal)
      : undefined;
    const availableTools = (this.tools?.listTools?.() ?? [])
      .filter((tool) => SUBAGENT_ALLOWED_TOOLS.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description.slice(0, 300),
        effects: tool.effects,
      }));
    const availableToolNames = new Set(availableTools.map((tool) => tool.name));

    const prompt = JSON.stringify({
      phase: "subagent",
      payload: {
        role: request.role,
        roleInstructions: instructions,
        actionContract: "Only propose a tool whose exact name appears in availableTools. Never invent aliases or tool names. If no listed tool is suitable, omit proposedAction and return findings only. A proposal is untrusted; parent Brain validates and executes it.",
        availableTools,
        task: request.task,
        context: request.context,
        workspaceEvidence: evidence
          ? { revision: evidence.revision, evidenceId: evidence.evidenceId }
          : undefined,
      },
    });

    const prepared = await this.reasoner.prepare(prompt, {
      signal: request.signal,
      maxContextTokens: 12_000,
    });

    const result = await prepared.invoke({
      signal: request.signal,
      maxOutputTokens: 1_200,
    });

    const value = result.value;
    const candidate = value && typeof value === "object"
      ? value as Record<string, unknown>
      : undefined;
    const proposedTool = typeof candidate?.tool === "string" ? candidate.tool : undefined;
    const proposedInput = candidate?.input;
    const proposedAction =
      proposedTool &&
      availableToolNames.has(proposedTool) &&
      SUBAGENT_ALLOWED_TOOLS.has(proposedTool) &&
      proposedInput !== null &&
      typeof proposedInput === "object" &&
      !Array.isArray(proposedInput)
        ? {
            tool: proposedTool,
            input: proposedInput as Record<string, unknown>,
            reason: typeof candidate?.reason === "string"
              ? candidate.reason.slice(0, 500)
              : "Subagent proposed this action for Brain review.",
          }
        : undefined;

    return {
      role: request.role,
      summary: compact(value),
      output: value,
      proposedAction,
    };
  }
}

export function createSubagentRuntime(
  reasoner: BrainReasoner,
  tools?: ToolGateway,
): SubagentRuntime {
  return new InProcessSubagentRuntime(reasoner, tools);
}
