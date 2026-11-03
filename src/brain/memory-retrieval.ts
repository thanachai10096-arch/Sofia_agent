export interface MemorySearchDocument {
  id: string;
  kind: string;
  content: string;
  updatedAt?: string;
}

export interface RankedMemory<T extends MemorySearchDocument> {
  entry: T;
  score: number;
  matchedTerms: number;
  matchedNgrams: number;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, " ").trim();
}

function wordTerms(value: string): Set<string> {
  return new Set((normalize(value).match(/[\p{L}\p{N}_-]+/gu) ?? []).filter((term) => Array.from(term).length > 1));
}

/** Bounded character n-grams improve retrieval for Thai/CJK text without a tokenizer dependency. */
function characterNgrams(value: string, max = 96): Set<string> {
  const compact = normalize(value).replace(/\s+/gu, "");
  const chars = Array.from(compact);
  const grams = new Set<string>();
  if (chars.length < 2) return grams;
  const size = chars.length < 4 ? 2 : 3;
  for (let i = 0; i <= chars.length - size && grams.size < max; i += 1) {
    grams.add(chars.slice(i, i + size).join(""));
  }
  return grams;
}

/**
 * Deterministic hybrid lexical retrieval: exact phrase + word terms + character
 * n-grams. Recency is only a tie-breaker; it cannot make an irrelevant item match.
 */
export function rankMemoryDocuments<T extends MemorySearchDocument>(
  documents: readonly T[],
  query: string,
  options: { limit?: number; maxDocuments?: number; minScore?: number } = {},
): RankedMemory<T>[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];
  const maxDocuments = Math.max(1, Math.min(2_000, Math.floor(options.maxDocuments ?? 500)));
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 12)));
  const minScore = Math.max(0, Math.min(1, options.minScore ?? 0.12));
  const queryTerms = wordTerms(normalizedQuery);
  const queryGrams = characterNgrams(normalizedQuery);
  const results: RankedMemory<T>[] = [];

  for (const entry of documents.slice(0, maxDocuments)) {
    if (!entry || typeof entry.content !== "string" || typeof entry.kind !== "string") continue;
    const searchable = normalize(entry.kind + " " + entry.content);
    const candidateTerms = wordTerms(searchable);
    const candidateGrams = characterNgrams(searchable, 512);
    const matchedTerms = [...queryTerms].filter((term) => candidateTerms.has(term)).length;
    const matchedNgrams = [...queryGrams].filter((gram) => candidateGrams.has(gram)).length;
    const termCoverage = queryTerms.size ? matchedTerms / queryTerms.size : 0;
    const ngramCoverage = queryGrams.size ? matchedNgrams / queryGrams.size : 0;
    const phrase = normalizedQuery.length >= 4 && searchable.includes(normalizedQuery);
    const score = Math.min(1, termCoverage * 0.55 + ngramCoverage * 0.35 + (phrase ? 0.1 : 0));
    if (score < minScore) continue;
    results.push({ entry, score: Number(score.toFixed(4)), matchedTerms, matchedNgrams });
  }

  return results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aTime = Date.parse(a.entry.updatedAt ?? "") || 0;
    const bTime = Date.parse(b.entry.updatedAt ?? "") || 0;
    return bTime - aTime;
  }).slice(0, limit);
}
