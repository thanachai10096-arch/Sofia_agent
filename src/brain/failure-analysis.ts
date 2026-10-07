import { createHash } from "node:crypto";

import type { Diagnosis, FailureCategory, Strategy, VerificationResult } from "./types.js";

export interface FailureEvidence {
  category: FailureCategory;
  message: string;
  source: "tool" | "verification" | "model";
  criterionId?: string;
  stdout?: string;
  stderr?: string;
  code?: number;
  files?: string[];
}

const PATTERNS: readonly [FailureCategory, RegExp][] = [
  ["dependency_error", /cannot find module|module not found|err_module_not_found|npm (?:err! )?code e(?:notarget|resolve)|peer dep/i],
  ["type_error", /ts\d{4}|typescript|type error|type '.*' is not assignable|property '.*' does not exist/i],
  ["syntax_error", /syntaxerror|unexpected token|parsing error|parse error/i],
  ["permission_error", /eacces|eperm|permission denied|access is denied/i],
  ["network_error", /enotfound|econnrefused|etimedout|network|fetch failed|socket hang up/i],
  ["environment_error", /command not found|is not recognized as an internal|no such file or directory|runtime .* not found/i],
  ["runtime_error", /runtimeerror|uncaught exception|unhandled (?:promise )?rejection|assertionerror/i],
  ["incomplete_solution", /test failed|tests? failed|failed to pass|acceptance criteria/i],
];

export function classifyFailure(message: string, fallback: FailureCategory = "unknown"): FailureCategory {
  for (const [category, pattern] of PATTERNS) {
    if (pattern.test(message)) return category;
  }
  return fallback;
}

export function normalizeFailureMessage(message: string): string {
  return message
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\b(?:[A-Za-z]:)?[\\/][^\s:]+[\\/][^\s:]+/g, "<path>")
    .replace(/\b0x[a-f0-9]+\b/gi, "0x?")
    .replace(/\b\d+\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000)
    .toLowerCase();
}

export function failureFingerprint(evidence: FailureEvidence): string {
  const normalized = normalizeFailureMessage(
    [evidence.message, evidence.stderr, evidence.stdout].filter(Boolean).join("\n"),
  );
  return createHash("sha256")
    .update(JSON.stringify({
      category: evidence.category,
      criterionId: evidence.criterionId ?? "",
      message: normalized,
      files: [...(evidence.files ?? [])].sort(),
    }))
    .digest("hex");
}

export function diagnosisFromFailure(
  evidence: FailureEvidence,
  previous: readonly Diagnosis[] = [],
): Diagnosis {
  const fingerprint = failureFingerprint(evidence);
  const repeated = previous.filter((item) => item.fingerprint === fingerprint).length + 1;
  const attemptedStrategies = [...new Set(previous.map((item) => item.fingerprint === fingerprint ? item.attemptedStrategies : []).flat())];

  return {
    category: evidence.category,
    fingerprint,
    repeated,
    message: evidence.message.slice(0, 4000),
    attemptedStrategies,
  };
}

export function failureEvidenceFromVerification(
  results: readonly VerificationResult[],
): FailureEvidence | undefined {
  const failed = results.find((result) => !result.passed);
  if (!failed) return undefined;
  return {
    category: classifyFailure(failed.detail, "incomplete_solution"),
    message: failed.detail,
    source: "verification",
    criterionId: failed.criterionId,
  };
}

export function preferredStrategy(
  category: FailureCategory,
  attempted: readonly Strategy[],
): Strategy {
  if (category === "dependency_error" || category === "environment_error") {
    return attempted.includes("fix-environment") ? "alternative-tool" : "fix-environment";
  }
  if (category === "permission_error" || category === "network_error") {
    return attempted.includes("alternative-tool") ? "inspect-evidence" : "alternative-tool";
  }
  if (category === "tool_error") return "alternative-tool";
  if (category === "wrong_assumption") return "inspect-evidence";
  return attempted.includes("fix-implementation") ? "inspect-evidence" : "fix-implementation";
}
