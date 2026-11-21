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

export interface SubagentToolDescriptor {
  name: string;
  description: string;
  effects: readonly ("read" | "write" | "shell" | "network" | "browser" | "destructive")[];
}

export const SUBAGENT_TOOL_ALLOWLIST = [
  "workspace.read_file",
  "workspace.list_files",
  "workspace.search",
  "git.diff",
  "project.verify",
  "workspace.write_file",
  "workspace.apply_patch",
] as const;

export function subagentToolCatalog(tools: ToolGateway): SubagentToolDescriptor[] {
  // Fail closed: a subagent only sees tools enumerated by the live registry.
  // Do not synthesize catalog entries from a static list or a partial describe()
  // implementation; the advertised contract must come from the executor's
  // canonical registry snapshot.
  const registered = tools.listTools?.() ?? [];
  return registered.flatMap((tool) => {
    if (!SUBAGENT_TOOL_ALLOWLIST.includes(tool.name as (typeof SUBAGENT_TOOL_ALLOWLIST)[number])) {
      return [];
    }
    const descriptor = tools.describe(tool.name);
    if (!descriptor) return [];

    // Require the live policy descriptor to agree with the registry snapshot.
    // A mismatch is treated as unavailable rather than exposing stale metadata.
    const effects = [...tool.effects].sort();
    const liveEffects = [...descriptor.effects].sort();
    if (effects.length !== liveEffects.length ||
        effects.some((effect, index) => effect !== liveEffects[index])) {
      return [];
    }
    return [{
      name: tool.name,
      description: tool.description,
      effects: descriptor.effects,
    }];
  });
}

export function isSubagentToolAllowed(name: string, tools: ToolGateway): boolean {
  return subagentToolCatalog(tools).some((tool) => tool.name === name);
}

export interface SubagentRequest {
  role: SubagentRole;
  task: string;
  context?: Record<string, unknown>;
  availableTools?: SubagentToolDescriptor[];
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
  /** Set only by the parent after validating the child response. */
  childTaskId?: string;
}

export interface SubagentRuntime {
  run(request: SubagentRequest): Promise<SubagentResult>;
}

/**
 * Treat every runtime result as untrusted, including in-process/custom runtimes.
 * Reject role substitution and malformed/oversized action proposals before the
 * parent considers a proposal for execution.
 */
export function validateSubagentResult(
  value: unknown,
  expectedRole: SubagentRole,
): SubagentResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.role !== expectedRole) return undefined;
  if (typeof candidate.summary !== "string" || !candidate.summary.trim() ||
      candidate.summary.length > 6_000 || !("output" in candidate)) return undefined;

  let output: unknown;
  try {
    const serialized = JSON.stringify(candidate.output);
    if (serialized === undefined || serialized.length > 24_000) return undefined;
    output = JSON.parse(serialized) as unknown;
  } catch {
    return undefined;
  }

  let proposedAction: SubagentActionProposal | undefined;
  if (candidate.proposedAction !== undefined) {
    if (!candidate.proposedAction || typeof candidate.proposedAction !== "object" ||
        Array.isArray(candidate.proposedAction)) return undefined;
    const action = candidate.proposedAction as Record<string, unknown>;
    if (typeof action.tool !== "string" || !action.tool.trim() || action.tool.length > 128 ||
        !action.input || typeof action.input !== "object" || Array.isArray(action.input) ||
        typeof action.reason !== "string" || !action.reason.trim() || action.reason.length > 1_000) {
      return undefined;
    }
    try {
      const serializedInput = JSON.stringify(action.input);
      if (serializedInput === undefined || serializedInput.length > 16_000) return undefined;
      proposedAction = {
        tool: action.tool,
        input: JSON.parse(serializedInput) as Record<string, unknown>,
        reason: action.reason.trim(),
      };
    } catch {
      return undefined;
    }
  }

  return {
    role: expectedRole,
    summary: candidate.summary.trim(),
    output,
    ...(proposedAction ? { proposedAction } : {}),
  };
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

    const prompt = JSON.stringify({
      phase: "subagent",
      payload: {
        role: request.role,
        roleInstructions: instructions,
        actionContract: "If an action is needed, return {tool,input,reason}. Choose tool only from availableTools using the exact registered name. This is a proposal only; Brain must validate and execute it.",
        availableTools: request.availableTools ?? [],
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
    const proposedAction =
      value && typeof value === "object" &&
      typeof (value as Record<string, unknown>).tool === "string" &&
      !!(value as Record<string, unknown>).input &&
      typeof (value as Record<string, unknown>).input === "object"
        ? {
            tool: (value as Record<string, unknown>).tool as string,
            input: (value as Record<string, unknown>).input as Record<string, unknown>,
            reason: typeof (value as Record<string, unknown>).reason === "string"
              ? (value as Record<string, unknown>).reason as string
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
