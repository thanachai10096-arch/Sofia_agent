import type { AdvancedSkillDefinition } from "./advanced-skill-catalog.js";

export interface AdvancedSkillExecutionContext {
  readonly principalId: string;
  readonly signal: AbortSignal;
  readonly approval?: { readonly requestId: string };
  readonly emitTrace?: (event: AdvancedSkillTraceEvent) => void;
}

export interface AdvancedSkillTraceEvent {
  readonly type: "skill.started" | "skill.completed" | "skill.failed" | "skill.denied";
  readonly skillId: string;
  readonly at: string;
  readonly detail?: string;
}

export type AdvancedSkillHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  context: AdvancedSkillExecutionContext,
) => Promise<TOutput> | TOutput;

export interface AdvancedSkillExecutionOptions {
  readonly timeoutMs?: number;
}

export class AdvancedSkillPolicyError extends Error {
  constructor(
    message: string,
    readonly code: "SKILL_NOT_FOUND" | "SKILL_NOT_VERIFIED" | "APPROVAL_REQUIRED" | "ABORTED" | "TIMEOUT",
  ) {
    super(message);
    this.name = "AdvancedSkillPolicyError";
  }
}

export interface AdvancedSkillApprovalRequest {
  readonly skillId: string;
  readonly principalId: string;
  readonly requestId: string;
}

export type AdvancedSkillApprovalVerifier = (request: AdvancedSkillApprovalRequest) => boolean | Promise<boolean>;

interface RegisteredSkill {
  definition: AdvancedSkillDefinition;
  handler: AdvancedSkillHandler;
}

/**
 * A guarded dispatcher for verified skill handlers. This is intentionally not
 * an authorization system for tools: handlers must still use Sofia's Tool
 * Registry, security controller, and workspace policy for every side effect.
 */
export class AdvancedSkillRegistry {
  private readonly skills = new Map<string, RegisteredSkill>();

  /**
   * The verifier must consult a trusted Sofia approval store/controller.
   * With no verifier, approval-required skills fail closed.
   */
  constructor(private readonly verifyApproval: AdvancedSkillApprovalVerifier = () => false) {}

  register(definition: AdvancedSkillDefinition, handler: AdvancedSkillHandler): void {
    if (definition.status !== "verified") {
      throw new AdvancedSkillPolicyError(
        `Skill ${definition.id} must be verified before registration`,
        "SKILL_NOT_VERIFIED",
      );
    }
    if (!definition.id.trim() || typeof handler !== "function") {
      throw new TypeError("A non-empty skill ID and handler are required");
    }
    if (
      typeof definition.name !== "string" || !definition.name.trim() ||
      typeof definition.category !== "string" || !definition.category.trim() ||
      typeof definition.description !== "string" ||
      !["read-only", "may-write", "privileged"].includes(definition.risk) ||
      typeof definition.requiresApproval !== "boolean"
    ) {
      throw new TypeError("Skill policy metadata is invalid");
    }
    if (this.skills.has(definition.id)) {
      throw new Error(`Skill handler already registered: ${definition.id}`);
    }
    // Snapshot and freeze policy metadata so callers cannot weaken a registered
    // skill by mutating the original object after registration.
    const snapshot = Object.freeze({ ...definition });
    this.skills.set(snapshot.id, { definition: snapshot, handler });
  }

  has(id: string): boolean {
    return this.skills.has(id);
  }

  list(): AdvancedSkillDefinition[] {
    return [...this.skills.values()].map(({ definition }) => ({ ...definition }));
  }

  async execute<TInput = unknown, TOutput = unknown>(
    id: string,
    input: TInput,
    context: AdvancedSkillExecutionContext,
    options: AdvancedSkillExecutionOptions = {},
  ): Promise<TOutput> {
    const registered = this.skills.get(id);
    if (!registered) throw new AdvancedSkillPolicyError(`No verified handler for ${id}`, "SKILL_NOT_FOUND");
    const { definition, handler } = registered;
    if (definition.status !== "verified") {
      throw new AdvancedSkillPolicyError(`Skill ${id} is not verified`, "SKILL_NOT_VERIFIED");
    }
    if (definition.requiresApproval || definition.risk === "privileged") {
      const approval = context.approval;
      let approved = false;
      if (approval && context.principalId.trim()) {
        try {
          approved = await this.verifyApproval({
            skillId: id,
            principalId: context.principalId,
            requestId: approval.requestId,
          });
        } catch {
          // Approval infrastructure errors must fail closed.
          approved = false;
        }
      }
      if (!approved) {
        context.emitTrace?.({ type: "skill.denied", skillId: id, at: new Date().toISOString(), detail: "approval required" });
        throw new AdvancedSkillPolicyError(`Approval required for skill ${id}`, "APPROVAL_REQUIRED");
      }
    }
    if (context.signal.aborted) {
      throw new AdvancedSkillPolicyError(`Skill ${id} was aborted before execution`, "ABORTED");
    }

    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) {
      throw new RangeError("timeoutMs must be an integer between 1 and 600000");
    }
    const startedAt = new Date().toISOString();
    context.emitTrace?.({ type: "skill.started", skillId: id, at: startedAt });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const executionController = new AbortController();
    const stop = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        executionController.abort();
        reject(new AdvancedSkillPolicyError(
          `Skill ${id} exceeded timeout of ${timeoutMs}ms`, "TIMEOUT",
        ));
      }, timeoutMs);
      abortListener = () => {
        executionController.abort();
        reject(new AdvancedSkillPolicyError(
          `Skill ${id} was aborted during execution`, "ABORTED",
        ));
      };
      context.signal.addEventListener("abort", abortListener, { once: true });
    });

    const executionContext: AdvancedSkillExecutionContext = {
      ...context,
      signal: executionController.signal,
    };
    try {
      const output = await Promise.race([Promise.resolve().then(() => handler(input, executionContext)), stop]);
      context.emitTrace?.({ type: "skill.completed", skillId: id, at: new Date().toISOString() });
      return output as TOutput;
    } catch (error) {
      context.emitTrace?.({
        type: "skill.failed",
        skillId: id,
        at: new Date().toISOString(),
        detail: error instanceof Error ? error.message.slice(0, 240) : "unknown error",
      });
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener) context.signal.removeEventListener("abort", abortListener);
    }
  }
}
