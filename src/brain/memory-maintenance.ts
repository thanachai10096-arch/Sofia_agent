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
    .replace(/[\\p{P}\\p{S}\\s]+/gu, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(
    (value.match(/[\\p{L}\\p{N}_-]+/gu) ?? [])
      .filter((token) => Array.from(token).length > 1),
  );
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / Math.min(left.size, right.size);
}

const ENGLISH_NEGATION = /\\b(?:not|no|never|cannot|can't|cant|don't|dont|doesn't|doesnt|didn't|didnt|isn't|isnt|aren't|arent|wasn't|wasnt|won't|wont|without)\\b/iu;
const THAI_NEGATION = /(?:ไม่ใช่|ไม่ได้|ไม่มี|ไม่|มิได้|ห้าม)/u;

function hasNegation(value: string): boolean {
  return ENGLISH_NEGATION.test(value) || THAI_NEGATION.test(value);
}

function contentTerms(value: string): Set<string> {
  return tokens(
    value
      .replace(ENGLISH_NEGATION, " ")
      .replace(/(?:ไม่ใช่|ไม่ได้|ไม่มี|ไม่|มิได้|ห้าม)/gu, " "),
  );
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
    const key = record.kind + "\\u0000" + normalized;
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
