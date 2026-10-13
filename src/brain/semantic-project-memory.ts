import type { ProjectMemoryEntry, ProjectMemoryStore } from "./project-memory.js";

interface EmbeddingResponse {
  model: string;
  dimensions: number;
  embeddings: number[][];
}
interface RerankResponse {
  model: string;
  results: Array<{ index: number; score: number }>;
}

export interface SemanticMemoryOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  maxCandidates?: number;
  fetchImpl?: typeof fetch;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return -1;
  return dot / Math.sqrt(normA * normB);
}

/**
 * Optional semantic layer over the existing project-memory store.
 * If the private Python service is unavailable, retrieval safely falls back
 * to the existing lexical search. Python returns ranking data only; it never
 * gets permission to read/write memory or execute agent tools.
 */
export class SemanticProjectMemorySearch {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxCandidates: number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly store: ProjectMemoryStore,
    options: SemanticMemoryOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? process.env.SOFIA_AI_SERVICE_URL ?? "").replace(/\/$/, "");
    this.token = options.token ?? process.env.SOFIA_AI_SERVICE_TOKEN ?? "";
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxCandidates = Math.min(12, Math.max(1, options.maxCandidates ?? 12));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private enabled(): boolean {
    if (!this.baseUrl || !this.token) return false;
    try {
      const url = new URL(this.baseUrl);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      return url.protocol === "https:" || (url.protocol === "http:" && local);
    } catch {
      return false;
    }
  }

  private async post<T>(route: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`AI service request failed (${response.status}).`);
    return await response.json() as T;
  }

  async find(query: string): Promise<ProjectMemoryEntry[]> {
    const normalized = query.trim();
    if (!normalized) return [];
    if (!this.enabled()) return this.store.find(normalized);

    try {
      const entries = await this.store.list();
      if (entries.length === 0) return [];
      const candidates = entries.slice(-Math.max(this.maxCandidates, 64));
      const embedded = await this.post<EmbeddingResponse>("/v1/embeddings", {
        texts: [normalized, ...candidates.map(entry => entry.content)],
        normalize: true,
      });
      if (
        embedded.embeddings.length !== candidates.length + 1 ||
        embedded.embeddings.some(vector =>
          vector.length !== embedded.dimensions || vector.some(value => !Number.isFinite(value)),
        )
      ) {
        throw new Error("AI service returned malformed embeddings.");
      }

      const queryVector = embedded.embeddings[0];
      if (!queryVector) throw new Error("AI service returned no query embedding.");
      const scored = candidates
        .map((entry, index) => ({
          entry,
          index,
          score: cosineSimilarity(queryVector, embedded.embeddings[index + 1] ?? []),
        }))
        .filter(item => item.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, this.maxCandidates);
      if (scored.length === 0) return this.store.find(normalized);

      try {
        const reranked = await this.post<RerankResponse>("/v1/rerank", {
          query: normalized,
          documents: scored.map(item => item.entry.content),
        });
        const valid = reranked.results.filter(item =>
          Number.isInteger(item.index) && item.index >= 0 && item.index < scored.length &&
          Number.isFinite(item.score),
        );
        if (valid.length > 0) {
          return valid
            .sort((a, b) => b.score - a.score)
            .map(item => scored[item.index]!.entry)
            .filter((entry, index, all) => all.findIndex(other => other.id === entry.id) === index)
            .slice(0, this.maxCandidates);
        }
      } catch {
        // Embeddings alone are useful; reranking is an optional quality improvement.
      }
      return scored.map(item => item.entry);
    } catch {
      // Semantic AI is optional: preserve availability using the established lexical path.
      return this.store.find(normalized);
    }
  }
}

export { cosineSimilarity };
