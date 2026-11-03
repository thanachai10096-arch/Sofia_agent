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
  if (kinds.length === 0) {
    throw new Error("Verification requires at least one acceptance probe.");
  }
  const criteria = verificationCriteria(kinds);
  const results: VerificationResult[] = [];

  const snapshot = await gateway.snapshot(signal);
  if (!snapshot || typeof snapshot.id !== "string" || !snapshot.id.trim() || snapshot.id.length > 500 ||
      typeof snapshot.revision !== "string" || !snapshot.revision.trim() || snapshot.revision.length > 500 ||
      typeof snapshot.evidenceId !== "string" || !snapshot.evidenceId.trim() || snapshot.evidenceId.length > 500) {
    throw new Error("Verification snapshot returned incomplete workspace identity or evidence.");
  }

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

    // A successful-looking payload is not sufficient: every verification result
    // must carry a durable evidence reference before it can satisfy acceptance.
    if (!result || typeof result.evidenceId !== "string" || !result.evidenceId.trim() || result.evidenceId.length > 500) {
      results.push({
        criterionId: criterion.id,
        passed: false,
        detail: "Verification tool returned no evidence ID.",
        evidenceIds: [],
        workspaceRevision: snapshot.revision,
      });
      break;
    }

    // Bind the verification result to an unchanged workspace revision. A concurrent
    // writer must not make a passing probe certify a different workspace state.
    const afterProbe = await gateway.snapshot(signal);
    if (!afterProbe || typeof afterProbe.id !== "string" || !afterProbe.id.trim() || afterProbe.id.length > 500 ||
        typeof afterProbe.revision !== "string" || afterProbe.revision !== snapshot.revision ||
        typeof afterProbe.evidenceId !== "string" || !afterProbe.evidenceId.trim() || afterProbe.evidenceId.length > 500) {
      results.push({
        criterionId: criterion.id,
        passed: false,
        detail: "Workspace revision changed during verification.",
        evidenceIds: [result.evidenceId],
        workspaceRevision: snapshot.revision,
      });
      break;
    }

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
