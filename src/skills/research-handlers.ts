import { validateToolInput } from "../tools/types.js";
import { getAdvancedSkill } from "./advanced-skill-catalog.js";
import { AdvancedSkillRegistry, type AdvancedSkillHandler } from "./advanced-skill-runtime.js";

type InputRecord = Record<string, unknown>;
function record(input: unknown): InputRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Skill input must be an object.");
  return input as InputRecord;
}
function requiredText(input: InputRecord, key: string, max = 8_000): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`Skill input ${key} must be a non-empty string.`);
  if (value.length > max) throw new RangeError(`Skill input ${key} exceeds ${max} characters.`);
  return value.trim();
}
function listOfText(value: unknown, key: string, max = 20): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new TypeError(`Skill input ${key} must be an array of at most ${max} non-empty strings.`);
  }
  return [...new Set(value.map(item => (item as string).trim()))];
}
function objectList(value: unknown, key: string, max = 100): InputRecord[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new TypeError(`Skill input ${key} must be an array of at most ${max} objects.`);
  }
  return value as InputRecord[];
}

/** Reuses Sofia's JSON-schema subset validator; this reports schema validity, not permission to execute a tool. */
export const toolArgumentValidator = (input: unknown) => {
  const value = record(input);
  if (!value.schema || typeof value.schema !== "object" || Array.isArray(value.schema)) {
    throw new TypeError("Skill input schema must be an object.");
  }
  if (!value.arguments || typeof value.arguments !== "object" || Array.isArray(value.arguments)) {
    throw new TypeError("Skill input arguments must be an object.");
  }
  try {
    validateToolInput(value.schema as Record<string, unknown>, value.arguments as Record<string, unknown>);
    return { valid: true, error: null };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message.slice(0, 300) : "Invalid tool arguments." };
  }
};

/** Produces a bounded research plan only; it does not fetch pages or claim results. */
export const webResearchPlanner = (input: unknown) => {
  const value = record(input);
  const question = requiredText(value, "question");
  const domains = listOfText(value.domains, "domains", 10).map(domain => domain.replace(/^https?:\/\//i, "").replace(/\/$/, ""));
  const sourceCount = value.sourceCount ?? 5;
  if (!Number.isSafeInteger(sourceCount) || (sourceCount as number) < 1 || (sourceCount as number) > 12) {
    throw new RangeError("sourceCount must be an integer from 1 to 12.");
  }
  const queries = [
    { purpose: "broad-overview", query: question },
    { purpose: "primary-evidence", query: question + " official documentation OR primary source" },
    { purpose: "independent-corroboration", query: question + " independent analysis" },
  ];
  for (const domain of domains.slice(0, 3)) queries.push({ purpose: "domain-specific", query: `site:${domain} ${question}` });
  return {
    question,
    sourceCount: sourceCount as number,
    domains,
    queries: queries.slice(0, 6),
    freshness: value.freshness === "recent" ? "recent" : "unspecified",
    executionRequired: true,
    fetchedSources: 0,
  };
};

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])
    .filter(word => !["the", "and", "for", "with", "that", "this", "from", "into", "are", "was"].includes(word)));
}

/** Heuristic overlap map between claims and provided source excerpts; it is not fact verification. */
export const claimEvidenceMapper = (input: unknown) => {
  const value = record(input);
  const claims = objectList(value.claims, "claims", 100).map((claim, index) => {
    if (typeof claim.id !== "string" || !claim.id.trim() || typeof claim.text !== "string" || !claim.text.trim()) {
      throw new TypeError(`claims[${index}] needs id and text.`);
    }
    return { id: claim.id.trim(), text: claim.text.trim(), terms: words(claim.text) };
  });
  const sources = objectList(value.sources, "sources", 100).map((source, index) => {
    if (typeof source.id !== "string" || !source.id.trim() || typeof source.title !== "string" || !source.title.trim() ||
        typeof source.excerpt !== "string" || !source.excerpt.trim()) {
      throw new TypeError(`sources[${index}] needs id, title, and excerpt.`);
    }
    return { id: source.id.trim(), title: source.title.trim(), excerpt: source.excerpt.trim(), terms: words(source.title + " " + source.excerpt) };
  });
  const mappings = claims.map(claim => {
    const matches = sources.map(source => {
      const overlap = [...claim.terms].filter(term => source.terms.has(term));
      const score = claim.terms.size ? overlap.length / claim.terms.size : 0;
      return { sourceId: source.id, title: source.title, score: Number(score.toFixed(3)), matchedTerms: overlap };
    }).filter(match => match.score > 0).sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId)).slice(0, 5);
    return { claimId: claim.id, matches, needsHumanReview: matches.length === 0 || matches[0]!.score < 0.5 };
  });
  return { mappings, claimCount: claims.length, sourceCount: sources.length, heuristicOnly: true };
};

/** Computes source age from supplied dates and leaves unknown dates explicitly unknown. */
export const freshnessChecker = (input: unknown) => {
  const value = record(input);
  const asOfRaw = value.asOf ?? new Date().toISOString();
  if (typeof asOfRaw !== "string" || !Number.isFinite(Date.parse(asOfRaw))) throw new TypeError("asOf must be a valid date string.");
  const maxAgeDays = value.maxAgeDays ?? 365;
  if (!Number.isSafeInteger(maxAgeDays) || (maxAgeDays as number) < 1 || (maxAgeDays as number) > 3_650) {
    throw new RangeError("maxAgeDays must be an integer from 1 to 3650.");
  }
  const sources = objectList(value.sources, "sources", 200).map((source, index) => {
    if (typeof source.id !== "string" || !source.id.trim()) throw new TypeError(`sources[${index}] needs an id.`);
    if (source.publishedAt === undefined || source.publishedAt === null || source.publishedAt === "") {
      return { id: source.id, freshness: "unknown" as const, ageDays: null, stale: null };
    }
    if (typeof source.publishedAt !== "string" || !Number.isFinite(Date.parse(source.publishedAt))) {
      throw new TypeError(`sources[${index}].publishedAt must be a valid date string.`);
    }
    const ageDays = Math.floor((Date.parse(asOfRaw) - Date.parse(source.publishedAt)) / 86_400_000);
    const stale = ageDays > (maxAgeDays as number);
    return { id: source.id, freshness: stale ? "stale" as const : "fresh" as const, ageDays, stale };
  });
  return { asOf: asOfRaw, maxAgeDays: maxAgeDays as number, sources, staleCount: sources.filter(source => source.stale === true).length, unknownDateCount: sources.filter(source => source.freshness === "unknown").length };
};

/** Builds citations from supplied source metadata and validates URL schemes; it never invents sources. */
export const citationBuilder = (input: unknown) => {
  const value = record(input);
  const sources = objectList(value.sources, "sources", 100).map((source, index) => {
    const title = requiredText(source, "title", 1_000);
    const url = requiredText(source, "url", 4_000);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new TypeError(`sources[${index}].url must be an absolute URL.`); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new TypeError(`sources[${index}].url must use HTTP or HTTPS.`);
    const date = typeof source.publishedAt === "string" && Number.isFinite(Date.parse(source.publishedAt))
      ? new Date(source.publishedAt).toISOString().slice(0, 10)
      : undefined;
    const escapedTitle = title.replace(/[\[\]]/g, "\\$&");
    return {
      title,
      url: parsed.toString(),
      citation: `[${escapedTitle}](${parsed.toString()})${date ? ` (published ${date})` : ""}`,
      ...(date ? { publishedDate: date } : {}),
    };
  });
  return { citations: sources.map(source => source.citation), count: sources.length, sourcesProvided: true };
};

export function registerVerifiedResearchSkills(registry: AdvancedSkillRegistry): string[] {
  const handlers: Array<{ id: string; handler: AdvancedSkillHandler }> = [
    { id: "tools.02", handler: toolArgumentValidator },
    { id: "research.01", handler: webResearchPlanner },
    { id: "research.03", handler: claimEvidenceMapper },
    { id: "research.05", handler: freshnessChecker },
    { id: "research.08", handler: citationBuilder },
  ];
  const registered: string[] = [];
  for (const item of handlers) {
    const definition = getAdvancedSkill(item.id);
    if (!definition || definition.status !== "verified") continue;
    registry.register(definition, item.handler);
    registered.push(item.id);
  }
  return registered;
}
