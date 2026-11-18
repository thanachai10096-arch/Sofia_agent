import { createHash } from "node:crypto";
import type { ProjectMemoryEntry, ProjectMemoryStore } from "../brain/project-memory.js";
import type { ResearchLoopAdapters } from "./research-loop.js";

type LearningInput = Parameters<ResearchLoopAdapters["recordLearning"]>[0];

/**
 * Bridges completed research into the existing project-memory store.
 * The deterministic entry ID makes retries of the same job/cycle an upsert.
 */
export function createProjectMemoryLearningRecorder(
  store: ProjectMemoryStore,
  resolveProject: (principalId: string) => string,
): ResearchLoopAdapters["recordLearning"] {
  return async (input: LearningInput, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    const principalId = typeof input.principalId === "string" ? input.principalId.trim() : "";
    const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
    if (!principalId || principalId.length > 256) throw new Error("A valid authenticated principal is required for research memory.");
    if (!idempotencyKey || idempotencyKey.length > 256) throw new Error("A valid research idempotency key is required.");
    if (!input.finding || typeof input.finding.summary !== "string" ||
        !Array.isArray(input.finding.sourceIds) || !input.hypothesis ||
        typeof input.hypothesis.statement !== "string" || typeof input.hypothesis.successMetric !== "string" ||
        !Number.isFinite(input.finding.confidence)) {
      throw new Error("Research memory input is malformed.");
    }
    const project = resolveProject(principalId).trim();
    if (!project || project.length > 200) throw new Error("A valid project scope is required for research memory.");
    const id = createHash("sha256").update(principalId).update("\\0").update(project).update("\\0").update(idempotencyKey).digest("hex");
    const evidence = input.evidence
      ? `Experiment: ${input.evidence.summary.slice(0, 1200)}\nPassed: ${input.evidence.passed}\nBenchmark: ${input.evidence.benchmarkBefore} -> ${input.evidence.benchmarkAfter}\nSafety incidents: ${input.evidence.safetyIncidents}\nArtifact: ${input.evidence.artifactVersion ?? "not provided"}`
      : `Experiment skipped: ${(input.experimentSkippedReason ?? "not run").slice(0, 500)}`;
    const content = [
      `Research question: ${input.question.slice(0, 1000)}`,
      `Finding: ${input.finding.summary.slice(0, 1600)}`,
      `Hypothesis: ${input.hypothesis.statement.slice(0, 1000)}`,
      `Success metric: ${input.hypothesis.successMetric.slice(0, 500)}`,
      evidence,
      `Sources: ${input.finding.sourceIds.slice(0, 20).join(", ")}`,
    ].join("\n");
    const now = new Date().toISOString();
    const entry: ProjectMemoryEntry = {
      id,
      project,
      kind: "decision",
      content: content.slice(0, 4000),
      source: `sofia-autonomy:${idempotencyKey.slice(0, 160)}`,
      confidence: Math.max(0, Math.min(1, input.finding.confidence)),
      createdAt: now,
      updatedAt: now,
      uses: 0,
    };
    signal.throwIfAborted();
    await store.save(entry);
  };
}
