/**
 * Non-destructive memory maintenance helpers.
 *
 * These helpers only produce review candidates. They never rewrite, merge,
 * archive, or delete memory records; callers must preserve scope and obtain
 * an explicit decision before applying any change.
 */

export interface MemoryMaintenanceRecord {
  id: string;
  kind: string;
  content: string;
  updatedAt?: string;
}

export interface DuplicateMemoryGroup {
  /** IDs with equivalent normalized content and the same memory kind. */
  ids: string[];
  kind: string;
}

export interface MemoryReviewPair {
  firstId: string;
  secondId: string;
  kind: string;
  /** Shared-token ratio, bounded to [0, 1]. This is a review signal, not a truth score. */
  similarity: number;
  reason: "similar-content";
}

export interface MemoryMaintenanceReport {
  /** Number of valid records included in the bounded scan. */
  scanned: number;
  /** Exact duplicate groups, scoped to the same memory kind. */
  duplicates: DuplicateMemoryGroup[];
  /** Near-duplicate pairs that require human review. */
  reviewPairs: MemoryReviewPair[];
}

export interface MemoryConflictReviewPair {
  firstId: string;
  secondId: string;
  kind: string;
  /** Shared content-term coverage after removing recognized negation markers. */
  similarity: number;
  reason: "opposite-negation";
  /** Human-readable signal only; it is not a semantic contradiction verdict. */
  polarity: "affirmed-vs-negated";
}

/** Normalize only for comparison; stored memory text is never modified. */
export function normalizeMemoryForComparison(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(
    (value.match(/[\p{L}\p{N}_-]+/gu) ?? [])
      .filter((token) => Array.from(token).length > 1),
  );
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / Math.min(left.size, right.size);
}

const ENGLISH_NEGATION = /\b(?:not|no|never|cannot|can't|cant|don't|dont|doesn't|doesnt|didn't|didnt|isn't|isnt|aren't|arent|wasn't|wasnt|won't|wont|without)\b/iu;
const THAI_NEGATION = /(?:ไม่ใช่|ไม่ได้|ไม่มี|ไม่|มิได้|ห้าม)/u;

function hasNegation(value: string): boolean {
  return ENGLISH_NEGATION.test(value) || THAI_NEGATION.test(value);
}

function contentTerms(value: string): Set<string> {
  const withoutNegation = value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(ENGLISH_NEGATION, " ")
    .replace(/(?:ไม่ใช่|ไม่ได้|ไม่มี|ไม่|มิได้|ห้าม)/gu, " ");
  const result = tokens(withoutNegation);

  // Thai/CJK text often has no whitespace-delimited words. Add character
  // bigrams from those script runs so overlap remains useful without a tokenizer.
  for (const run of withoutNegation.match(/[\p{Script=Thai}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? []) {
    const chars = Array.from(run);
    for (let index = 0; index < chars.length - 1; index += 1) {
      result.add(chars[index]! + chars[index + 1]!);
    }
  }
  return result;
}

/**
 * Find exact duplicates and conservative near-duplicate review candidates.
 * Similarity uses shared-token coverage rather than embeddings, so it is
 * deterministic, offline, and intentionally limited to candidate generation.
 */
export function analyzeMemoryEntries(
  records: readonly MemoryMaintenanceRecord[],
  options: { maxRecords?: number; reviewThreshold?: number; maxReviewPairs?: number } = {},
): MemoryMaintenanceReport {
  const maxRecords = Math.max(1, Math.min(2_000, Math.floor(options.maxRecords ?? 500)));
  const threshold = Math.max(0.5, Math.min(1, options.reviewThreshold ?? 0.8));
  const maxReviewPairs = Math.max(0, Math.min(5_000, Math.floor(options.maxReviewPairs ?? 200)));
  const bounded = records.slice(0, maxRecords).filter((record) =>
    Boolean(record && typeof record.id === "string" && record.id.length > 0 &&
      typeof record.kind === "string" && typeof record.content === "string" &&
      record.content.trim().length > 0),
  );

  const exact = new Map<string, { kind: string; ids: string[] }>();
  const prepared = bounded.map((record) => {
    const normalized = normalizeMemoryForComparison(record.content);
    const key = record.kind + "\u0000" + normalized;
    const group = exact.get(key) ?? { kind: record.kind, ids: [] };
    group.ids.push(record.id);
    exact.set(key, group);
    return { record, normalized, terms: tokens(normalized) };
  });

  const duplicates = [...exact.values()]
    .filter((group) => group.ids.length > 1)
    .map((group) => ({ kind: group.kind, ids: [...new Set(group.ids)].sort() }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.ids[0]!.localeCompare(b.ids[0]!));

  const reviewPairs: MemoryReviewPair[] = [];
  for (let i = 0; i < prepared.length && reviewPairs.length < maxReviewPairs; i += 1) {
    const left = prepared[i]!;
    if (left.terms.size < 3) continue;
    for (let j = i + 1; j < prepared.length && reviewPairs.length < maxReviewPairs; j += 1) {
      const right = prepared[j]!;
      if (left.record.kind !== right.record.kind || left.normalized === right.normalized || right.terms.size < 3) continue;
      const score = similarity(left.terms, right.terms);
      if (score >= threshold) {
        reviewPairs.push({
          firstId: left.record.id,
          secondId: right.record.id,
          kind: left.record.kind,
          similarity: Number(score.toFixed(3)),
          reason: "similar-content",
        });
      }
    }
  }

  return { scanned: bounded.length, duplicates, reviewPairs };
}

/**
 * Surface only high-overlap same-kind entries whose text differs by an
 * explicit recognized negation marker. This deliberately does not attempt
 * general natural-language contradiction detection. Results are suggestions
 * for review, never instructions to overwrite or delete either memory.
 */
export function detectMemoryConflicts(
  records: readonly MemoryMaintenanceRecord[],
  options: { maxRecords?: number; reviewThreshold?: number; maxPairs?: number } = {},
): MemoryConflictReviewPair[] {
  const maxRecords = Math.max(1, Math.min(2_000, Math.floor(options.maxRecords ?? 500)));
  const threshold = Math.max(0.5, Math.min(1, options.reviewThreshold ?? 0.8));
  const maxPairs = Math.max(0, Math.min(5_000, Math.floor(options.maxPairs ?? 100)));
  if (maxPairs === 0) return [];

  const bounded = records.slice(0, maxRecords).filter((record) =>
    Boolean(record && typeof record.id === "string" && record.id.length > 0 &&
      typeof record.kind === "string" && typeof record.content === "string" &&
      record.content.trim().length > 0),
  );
  const prepared = bounded.map((record) => ({
    record,
    normalized: normalizeMemoryForComparison(record.content),
    terms: contentTerms(record.content),
    negated: hasNegation(record.content),
  }));

  const conflicts: MemoryConflictReviewPair[] = [];
  for (let i = 0; i < prepared.length && conflicts.length < maxPairs; i += 1) {
    const left = prepared[i]!;
    if (left.terms.size < 3) continue;
    for (let j = i + 1; j < prepared.length && conflicts.length < maxPairs; j += 1) {
      const right = prepared[j]!;
      if (
        left.record.kind !== right.record.kind ||
        left.normalized === right.normalized ||
        left.negated === right.negated ||
        right.terms.size < 3
      ) continue;

      const score = similarity(left.terms, right.terms);
      if (score < threshold) continue;
      conflicts.push({
        firstId: left.record.id,
        secondId: right.record.id,
        kind: left.record.kind,
        similarity: Number(score.toFixed(3)),
        reason: "opposite-negation",
        polarity: "affirmed-vs-negated",
      });
    }
  }

  return conflicts;
}

export interface StaleMemoryCandidate {
  id: string;
  kind: string;
  updatedAt: string;
  ageDays: number;
  reason: "older-than-retention-window";
}

export interface MemoryConsolidationReport {
  /** Existing duplicate and near-duplicate analysis; no records are modified. */
  maintenance: MemoryMaintenanceReport;
  /** Explicit-negation candidates for human review. */
  conflicts: MemoryConflictReviewPair[];
  /** Old records to revalidate; age alone never authorizes deletion or demotion. */
  staleCandidates: StaleMemoryCandidate[];
}

/**
 * Produce one bounded, read-only maintenance report for a memory review screen.
 * Staleness is a prompt to revalidate, not a claim that a memory is false.
 */
export function analyzeMemoryConsolidation(
  records: readonly MemoryMaintenanceRecord[],
  options: {
    maxRecords?: number;
    reviewThreshold?: number;
    maxReviewPairs?: number;
    maxConflictPairs?: number;
    staleAfterDays?: number;
    now?: string;
  } = {},
): MemoryConsolidationReport {
  const maxRecords = Math.max(1, Math.min(2_000, Math.floor(options.maxRecords ?? 500)));
  const bounded = records.slice(0, maxRecords).filter((record) =>
    Boolean(record && typeof record.id === "string" && record.id.length > 0 &&
      typeof record.kind === "string" && typeof record.content === "string" &&
      record.content.trim().length > 0),
  );
  const staleAfterDays = Math.max(1, Math.min(36_500, Math.floor(options.staleAfterDays ?? 180)));
  const nowMs = Date.parse(options.now ?? new Date().toISOString());
  if (!Number.isFinite(nowMs)) throw new Error("Invalid consolidation analysis time.");
  const staleCandidates = bounded.flatMap((record) => {
    if (typeof record.updatedAt !== "string") return [];
    const updatedMs = Date.parse(record.updatedAt);
    if (!Number.isFinite(updatedMs) || updatedMs > nowMs) return [];
    const ageDays = Math.floor((nowMs - updatedMs) / 86_400_000);
    return ageDays >= staleAfterDays
      ? [{ id: record.id, kind: record.kind, updatedAt: record.updatedAt, ageDays, reason: "older-than-retention-window" as const }]
      : [];
  }).sort((a, b) => b.ageDays - a.ageDays || a.id.localeCompare(b.id));

  return {
    maintenance: analyzeMemoryEntries(bounded, {
      maxRecords,
      reviewThreshold: options.reviewThreshold,
      maxReviewPairs: options.maxReviewPairs,
    }),
    conflicts: detectMemoryConflicts(bounded, {
      maxRecords,
      reviewThreshold: options.reviewThreshold,
      maxPairs: options.maxConflictPairs,
    }),
    staleCandidates,
  };
}


export interface VerifiedMemoryRevalidationRecord {
  id: string;
  kind: string;
  updatedAt?: string;
  verification?: {
    candidateId?: string;
    runId?: string;
    verifiedAt?: string;
    evidenceIds?: string[];
    checks?: Array<{ name?: string; passed?: boolean }>;
  };
}

export interface VerifiedMemoryRevalidationCandidate {
  id: string;
  kind: string;
  reason: "missing-provenance" | "incomplete-provenance" | "invalid-verification-time" | "verification-expired";
  verifiedAt?: string;
  ageDays?: number;
}

export interface VerifiedMemoryRevalidationReport {
  scanned: number;
  /** Durable knowledge records with complete verification provenance. */
  verified: number;
  /** Durable knowledge records that have not passed the promotion gate. */
  unverified: number;
  /** Verified records whose provenance or age requires human review. */
  revalidationCandidates: VerifiedMemoryRevalidationCandidate[];
}

/**
 * Read-only audit of durable project knowledge. Episodes and feedback are
 * intentionally excluded: they are records of activity/signals, not promoted
 * knowledge. Missing or expired verification never triggers an automatic
 * demotion, deletion, rewrite, or confidence change.
 */
export function analyzeVerifiedMemoryRevalidation(
  records: readonly VerifiedMemoryRevalidationRecord[],
  options: { maxRecords?: number; revalidateAfterDays?: number; now?: string } = {},
): VerifiedMemoryRevalidationReport {
  const maxRecords = Math.max(1, Math.min(2_000, Math.floor(options.maxRecords ?? 500)));
  const revalidateAfterDays = Math.max(1, Math.min(36_500, Math.floor(options.revalidateAfterDays ?? 180)));
  const nowMs = Date.parse(options.now ?? new Date().toISOString());
  if (!Number.isFinite(nowMs)) throw new Error("Invalid verified-memory analysis time.");

  const bounded = records.slice(0, maxRecords).filter((record) =>
    Boolean(record && typeof record.id === "string" && record.id.trim().length > 0 &&
      ["convention", "repair", "decision"].includes(record.kind)),
  );
  let verified = 0;
  let unverified = 0;
  const revalidationCandidates: VerifiedMemoryRevalidationCandidate[] = [];

  for (const record of bounded) {
    const provenance = record.verification;
    if (!provenance) {
      unverified += 1;
      revalidationCandidates.push({ id: record.id, kind: record.kind, reason: "missing-provenance" });
      continue;
    }

    const complete = typeof provenance.candidateId === "string" && provenance.candidateId.trim().length > 0 &&
      typeof provenance.runId === "string" && provenance.runId.trim().length > 0 &&
      typeof provenance.verifiedAt === "string" && Array.isArray(provenance.evidenceIds) &&
      provenance.evidenceIds.length > 0 && provenance.evidenceIds.every((id) => typeof id === "string" && id.trim().length > 0) &&
      Array.isArray(provenance.checks) && ["evidence", "regression", "policy"].every((required) =>
        provenance.checks!.some((check) => check?.name === required && check.passed === true),
      ) && provenance.checks.every((check) => check && check.passed === true);

    if (!complete) {
      unverified += 1;
      revalidationCandidates.push({ id: record.id, kind: record.kind, reason: "incomplete-provenance" });
      continue;
    }

    const verifiedAtMs = Date.parse(provenance.verifiedAt!);
    if (!Number.isFinite(verifiedAtMs) || verifiedAtMs > nowMs) {
      verified += 1;
      revalidationCandidates.push({
        id: record.id,
        kind: record.kind,
        reason: "invalid-verification-time",
        verifiedAt: provenance.verifiedAt,
      });
      continue;
    }

    verified += 1;
    const ageDays = Math.floor((nowMs - verifiedAtMs) / 86_400_000);
    if (ageDays >= revalidateAfterDays) {
      revalidationCandidates.push({
        id: record.id,
        kind: record.kind,
        reason: "verification-expired",
        verifiedAt: provenance.verifiedAt,
        ageDays,
      });
    }
  }

  return { scanned: bounded.length, verified, unverified, revalidationCandidates };
}
