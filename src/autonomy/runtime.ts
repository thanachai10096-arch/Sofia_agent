import {
  defaultAutonomyProfile,
  evaluateAutonomyRequest,
  type AutonomyContext,
  type AutonomyProfile,
} from "./controller.js";
import {
  runIndependentResearchLoop,
  type ResearchLoopAdapters,
  type ResearchLoopReport,
} from "./research-loop.js";

export interface AutonomyAuditEvent {
  type: "autonomy.research.started" | "autonomy.research.completed" | "autonomy.research.failed";
  principalId: string;
  at: string;
  cycleCount?: number;
  stoppedBy?: ResearchLoopReport["stoppedBy"];
  error?: string;
}

export interface AutonomyResearchRequest {
  /** Must come from the authenticated host, never from model-generated input. */
  principalId: string;
  /** Explicit caller cancellation / host kill-switch signal. */
  signal: AbortSignal;
  adapters: ResearchLoopAdapters;
  /** Trusted host attestation; never derive this from an agent/model response. */
  sandboxAvailable: boolean;
  /** Live counters supplied by the trusted supervisor. */
  budgetContext: () => AutonomyContext;
  maxCycles?: number;
  idempotencyPrefix?: string;
  startCycle?: number;
  previousCycles?: ResearchLoopReport["cycles"];
  onCycle?: (cycle: ResearchLoopReport["cycles"][number], nextCycle: number) => Promise<void> | void;
}

export interface SofiaAutonomyRuntimeOptions {
  profile?: AutonomyProfile;
  audit?: (event: AutonomyAuditEvent) => void | Promise<void>;
}

/**
 * Explicit runtime entry point for autonomous research. It is deliberately not
 * called from SofiaAgent.run(): hosts must opt in by invoking runResearch().
 * This wrapper grants no tools and delegates all execution to trusted adapters.
 */
export class SofiaAutonomyRuntime {
  private readonly profile: AutonomyProfile;

  constructor(private readonly options: SofiaAutonomyRuntimeOptions = {}) {
    this.profile = options.profile ?? defaultAutonomyProfile;
  }

  async runResearch(request: AutonomyResearchRequest): Promise<ResearchLoopReport> {
    const principalId = request.principalId.trim();
    if (!principalId) throw new Error("Authenticated principal identity is required.");
    if (request.signal.aborted) {
      return { completed: false, stoppedBy: "aborted", cycles: [] };
    }
    const decision = evaluateAutonomyRequest("research_local", this.profile);
    if (!decision.allowed) throw new Error(decision.reason);
    if (request.maxCycles !== undefined &&
        (!Number.isSafeInteger(request.maxCycles) ||
         request.maxCycles < 1 ||
         request.maxCycles > this.profile.budget.maxCycles)) {
      throw new Error("Research cycle limit is invalid or exceeds the autonomy profile.");
    }

    await this.options.audit?.({
      type: "autonomy.research.started",
      principalId,
      at: new Date().toISOString(),
    });
    try {
      const report = await runIndependentResearchLoop({
        profile: this.profile,
        adapters: request.adapters,
        signal: request.signal,
        principalId,
        sandboxAvailable: request.sandboxAvailable,
        budgetContext: request.budgetContext,
        ...(request.maxCycles !== undefined ? { maxCycles: request.maxCycles } : {}),
        ...(request.idempotencyPrefix ? { idempotencyPrefix: request.idempotencyPrefix } : {}),
        ...(request.startCycle !== undefined ? { startCycle: request.startCycle } : {}),
        ...(request.previousCycles !== undefined ? { previousCycles: request.previousCycles } : {}),
        ...(request.onCycle ? { onCycle: request.onCycle } : {}),
      });
      await this.options.audit?.({
        type: "autonomy.research.completed",
        principalId,
        at: new Date().toISOString(),
        cycleCount: report.cycles.length,
        stoppedBy: report.stoppedBy,
      });
      return report;
    } catch (error) {
      await this.options.audit?.({
        type: "autonomy.research.failed",
        principalId,
        at: new Date().toISOString(),
        error: error instanceof Error ? error.message.slice(0, 500) : "Unknown autonomy research failure",
      });
      throw error;
    }
  }
}
