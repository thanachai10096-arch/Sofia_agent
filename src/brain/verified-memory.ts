import { createHash } from "node:crypto";
import type { ProjectMemoryEntry, ProjectMemoryStore } from "./project-memory.js";
import { containsPromptInjection, redactSecrets } from "../security/guard.js";

export type VerifiedMemoryKind = "convention" | "repair" | "decision";

export interface MemoryPromotionCandidate {
  id: string;
  project: string;
  kind: VerifiedMemoryKind;
  content: string;
  source: string;
  confidence: number;
  evidenceIds: string[];
}

export interface MemoryVerificationCheck {
  name: "evidence" | "regression" | "policy" | string;
  passed: boolean;
  evidenceIds?: string[];
  detail?: string;
}

export interface MemoryVerificationReceipt {
  runId: string;
  verifiedAt: string;
  checks: MemoryVerificationCheck[];
  evidenceIds: string[];
}

export interface VerifiedMemoryPromotionOptions {
  minimumConfidence?: number;
  /** Allows deterministic callers/tests to control the record timestamp. */
  now?: string;
}

export interface VerifiedMemoryPromotionResult {
  promoted: boolean;
  reason: "promoted" | "invalid_candidate" | "invalid_receipt" | "checks_failed" | "evidence_mismatch" | "insufficient_confidence" | "unsafe_content";
  entry?: ProjectMemoryEntry;
}

/**
 * Persist a durable project-memory record only after a caller supplies a
 * complete verification receipt. Feedback signals alone are deliberately
 * not accepted as verification evidence. This function does not execute
 * candidate content and does not activate skills or change policy.
 */
export async function promoteVerifiedProjectMemory(
  store: ProjectMemoryStore,
  candidate: MemoryPromotionCandidate,
  receipt: MemoryVerificationReceipt,
  options: VerifiedMemoryPromotionOptions = {},
): Promise<VerifiedMemoryPromotionResult> {
  const minimumConfidence = options.minimumConfidence ?? 0.8;
  if (!Number.isFinite(minimumConfidence) || minimumConfidence < 0 || minimumConfidence > 1) {
    throw new Error("minimumConfidence must be between 0 and 1");
  }
  if (!candidate || typeof candidate.id !== "string" || !candidate.id.trim() || candidate.id.length > 200 ||
      typeof candidate.project !== "string" || !candidate.project.trim() || candidate.project.length > 300 ||
      !["convention", "repair", "decision"].includes(candidate.kind) ||
      typeof candidate.content !== "string" || !candidate.content.trim() ||
      typeof candidate.source !== "string" || !candidate.source.trim() ||
      !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1 ||
      !Array.isArray(candidate.evidenceIds) || candidate.evidenceIds.length === 0 ||
      !candidate.evidenceIds.every((id) => typeof id === "string" && id.trim().length > 0 && id.length <= 200)) {
    return { promoted: false, reason: "invalid_candidate" };
  }
  if (!receipt || typeof receipt.runId !== "string" || !receipt.runId.trim() || receipt.runId.length > 200 ||
      typeof receipt.verifiedAt !== "string" || !Number.isFinite(Date.parse(receipt.verifiedAt)) ||
      !Array.isArray(receipt.checks) || !Array.isArray(receipt.evidenceIds) ||
      !receipt.evidenceIds.every((id) => typeof id === "string" && id.trim().length > 0 && id.length <= 200) ||
      receipt.evidenceIds.length === 0 ||
      !receipt.checks.every((check) => check && typeof check.name === "string" && typeof check.passed === "boolean")) {
    return { promoted: false, reason: "invalid_receipt" };
  }
  const required = ["evidence", "regression", "policy"];
  const checksPassed = required.every((name) =>
    receipt.checks.some((check) => check.name === name && check.passed === true),
  ) && receipt.checks.every((check) => check.passed === true);
  if (!checksPassed) return { promoted: false, reason: "checks_failed" };
  const candidateEvidence = new Set(candidate.evidenceIds);
  const evidenceCheck = receipt.checks.find((check) => check.name === "evidence" && check.passed);
  const verifiedEvidence = new Set(receipt.evidenceIds);
  for (const evidenceId of evidenceCheck?.evidenceIds ?? []) verifiedEvidence.add(evidenceId);
  if (!candidate.evidenceIds.some((id) => verifiedEvidence.has(id)) ||
      (evidenceCheck?.evidenceIds && !evidenceCheck.evidenceIds.every((id) => typeof id === "string" && id.length <= 200))) {
    return { promoted: false, reason: "evidence_mismatch" };
  }
  if (candidate.confidence < minimumConfidence) {
    return { promoted: false, reason: "insufficient_confidence" };
  }
  if (containsPromptInjection(candidate.content)) {
    return { promoted: false, reason: "unsafe_content" };
  }

  const now = options.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) throw new Error("Invalid memory promotion timestamp");
  const safeContent = String(redactSecrets(candidate.content)).trim().slice(0, 4_000);
  if (!safeContent || containsPromptInjection(safeContent)) return { promoted: false, reason: "unsafe_content" };
  const evidenceIds = [...new Set([...candidate.evidenceIds, ...receipt.evidenceIds])].slice(0, 40);
  const id = createHash("sha256")
    .update(candidate.project + "\u0000verified-memory\u0000" + candidate.id + "\u0000" + receipt.runId)
    .digest("hex");
  const entry: ProjectMemoryEntry = {
    id,
    project: candidate.project,
    kind: candidate.kind,
    content: safeContent,
    source: String(redactSecrets(candidate.source)).slice(0, 200),
    confidence: candidate.confidence,
    createdAt: new Date(receipt.verifiedAt).toISOString(),
    updatedAt: now,
    uses: 0,
    verification: {
      candidateId: candidate.id,
      runId: receipt.runId,
      verifiedAt: new Date(receipt.verifiedAt).toISOString(),
      evidenceIds,
      checks: receipt.checks.map((check) => ({ name: check.name.slice(0, 100), passed: true as const })),
    },
  };
  await store.save(entry);
  return { promoted: true, reason: "promoted", entry };
}
