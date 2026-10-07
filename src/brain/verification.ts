import type { AcceptanceCriterion, ToolGateway, VerificationResult } from "./types.js";

export type VerificationKind = "typecheck" | "test" | "build";

const ORDER: readonly VerificationKind[] = ["typecheck", "test", "build"];

export function verificationCriteria(
  kinds: readonly VerificationKind[] = ORDER,
): AcceptanceCriterion[] {
  return kinds.map((kind) => ({
    id: "project-" + kind,
    description: "Project " + kind + " must pass.",
    probe: { tool: "project.verify", input: { kind } },
    evaluate(data: unknown) {
      const value = data as { passed?: unknown; code?: unknown; stderr?: unknown; stdout?: unknown };
      const passed = value?.passed === true && value?.code === 0;
      const detail = passed
        ? kind + " passed."
        : kind + " failed: " + String(value?.stderr || value?.stdout || "unknown verification failure");
      return { passed, detail };
    },
  }));
}

export async function runVerification(
  gateway: ToolGateway,
  kinds: readonly VerificationKind[],
  signal: AbortSignal,
  runId = "verification",
): Promise<VerificationResult[]> {
  const criteria = verificationCriteria(kinds);
  const results: VerificationResult[] = [];

  const snapshot = await gateway.snapshot(signal);

  for (const criterion of criteria) {
    signal.throwIfAborted();
    const result = await gateway.execute(criterion.probe, {
      runId,
      signal,
      requireApproval: false,
      notifyApproval(waiting) {
        if (waiting) throw new Error("Verification cannot request approval.");
      },
    });

    const evaluated = criterion.evaluate(result.data);
    results.push({
      criterionId: criterion.id,
      passed: result.ok && evaluated.passed,
      detail: result.ok ? evaluated.detail : result.error?.message ?? "Verification tool failed",
      evidenceIds: [result.evidenceId],
      workspaceRevision: snapshot.revision,
    });

    if (!result.ok || !evaluated.passed) break;
  }

  return results;
}
