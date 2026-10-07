import type { FailureCategory, VerificationResult } from "../brain/types.js";

export interface ReviewFinding {
  category: "correctness" | "regression" | "security" | "scope" | "coverage";
  severity: "error" | "warning" | "info";
  message: string;
  evidence?: string;
}

export interface CodeReviewInput {
  task: string;
  changedFiles: string[];
  verification: VerificationResult[];
  diff?: string;
  acceptanceCriteria?: string[];
}

export interface CodeReviewResult {
  approved: boolean;
  findings: ReviewFinding[];
  reason: string;
  repairCategory?: FailureCategory;
}

const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']+["']/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
];

export function reviewCodeChange(input: CodeReviewInput): CodeReviewResult {
  const findings: ReviewFinding[] = [];

  for (const item of input.verification) {
    if (!item.passed) {
      findings.push({
        category: "correctness",
        severity: "error",
        message: item.detail,
        evidence: item.criterionId,
      });
    }
  }

  if (input.diff) {
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(input.diff)) {
        findings.push({
          category: "security",
          severity: "error",
          message: "The diff appears to contain a hard-coded secret or private key.",
        });
      }
    }

    if (input.diff.includes("TODO") && /implement|add|fix|build/i.test(input.task)) {
      findings.push({
        category: "coverage",
        severity: "warning",
        message: "The change still contains TODO markers; verify the requested implementation is complete.",
      });
    }
  }

  if (input.changedFiles.length === 0) {
    findings.push({
      category: "scope",
      severity: "error",
      message: "No changed files were observed for a coding task.",
    });
  }

  const approved = !findings.some((finding) => finding.severity === "error");
  return {
    approved,
    findings,
    reason: approved
      ? "Code review passed: verification is green and no blocking review finding was detected."
      : "Code review rejected the change because one or more blocking findings were detected.",
    ...(approved ? {} : { repairCategory: "incomplete_solution" }),
  };
}
