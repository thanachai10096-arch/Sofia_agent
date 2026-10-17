import type { ProjectMemoryEntry, ProjectMemoryStore } from "../brain/project-memory.js";
import { AdvancedSkillRegistry, type AdvancedSkillHandler } from "./advanced-skill-runtime.js";
import { getAdvancedSkill } from "./advanced-skill-catalog.js";
import { containsPromptInjection, redactSecrets } from "../security/guard.js";

type InputRecord = Record<string, unknown>;
function record(input: unknown): InputRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Skill input must be an object.");
  return input as InputRecord;
}
function text(input: InputRecord, key: string, max = 20_000): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`Skill input ${key} must be a non-empty string.`);
  if (value.length > max) throw new RangeError(`Skill input ${key} exceeds ${max} characters.`);
  return value.trim();
}
function stringList(value: unknown, key: string, maxItems = 200): string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new TypeError(`Skill input ${key} must be an array of at most ${maxItems} non-empty strings.`);
  }
  return value.map(item => (item as string).trim());
}

/** Extractive summary only: it selects original sentences and does not invent facts. */
export const contextSummarizer = (input: unknown) => {
  const value = record(input);
  const source = text(value, "text", 100_000);
  const maxSentences = value.maxSentences ?? 5;
  if (!Number.isSafeInteger(maxSentences) || (maxSentences as number) < 1 || (maxSentences as number) > 20) {
    throw new RangeError("maxSentences must be an integer from 1 to 20.");
  }
  const sentences = source.split(/(?<=[.!?。！？])\s+|\n+/).map(item => item.trim()).filter(Boolean);
  const selected = sentences.length <= (maxSentences as number)
    ? sentences
    : [...sentences.slice(0, 1), ...sentences.slice(-(maxSentences as number) + 1)];
  return {
    summary: selected.join(" "),
    sourceSentenceCount: sentences.length,
    selectedSentenceCount: selected.length,
    omittedSentenceCount: Math.max(0, sentences.length - selected.length),
    method: "extractive-boundary-selection",
  };
};

/** Conflict resolution preserves competing values and flags ambiguity for a human. */
export const memoryConflictResolver = (input: unknown) => {
  const value = record(input);
  if (!Array.isArray(value.candidates) || value.candidates.length === 0 || value.candidates.length > 200) {
    throw new TypeError("Skill input candidates must be a non-empty array of at most 200 memory candidates.");
  }
  const candidates = value.candidates.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError(`candidates[${index}] must be an object.`);
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.key !== "string" || !candidate.key.trim() ||
        typeof candidate.value !== "string" || !candidate.value.trim() ||
        typeof candidate.updatedAt !== "string" || !Number.isFinite(Date.parse(candidate.updatedAt))) {
      throw new TypeError(`candidates[${index}] needs key, value, and a valid updatedAt timestamp.`);
    }
    return {
      key: candidate.key.trim(),
      value: candidate.value.trim(),
      updatedAt: candidate.updatedAt,
      ...(typeof candidate.source === "string" ? { source: candidate.source.slice(0, 200) } : {}),
    };
  });
  const groups = new Map<string, typeof candidates>();
  for (const candidate of candidates) groups.set(candidate.key, [...(groups.get(candidate.key) ?? []), candidate]);
  const decisions = [...groups.entries()].map(([key, group]) => {
    const values = [...new Set(group.map(candidate => candidate.value))];
    const ordered = [...group].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return {
      key,
      candidates: ordered,
      conflicting: values.length > 1,
      suggestedLatest: ordered[0],
      requiresHumanReview: values.length > 1,
    };
  });
  return {
    decisions,
    conflictCount: decisions.filter(item => item.conflicting).length,
    requiresHumanReview: decisions.some(item => item.requiresHumanReview),
  };
};

/** Bounded context compaction keeps the first and newest messages and reports what was omitted. */
export const longContextCompressor = (input: unknown) => {
  const value = record(input);
  const messages = stringList(value.messages, "messages");
  const maxChars = value.maxChars ?? 8_000;
  if (!Number.isSafeInteger(maxChars) || (maxChars as number) < 100 || (maxChars as number) > 50_000) {
    throw new RangeError("maxChars must be an integer from 100 to 50000.");
  }
  if (messages.length === 0) throw new TypeError("Skill input messages must contain at least one message.");
  const budget = maxChars as number;
  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  if (messages.join("\n").length <= budget) {
    return { context: messages.join("\n"), originalMessageCount: messages.length, retainedMessageCount: messages.length, omittedMessageCount: 0, truncated: false };
  }
  if (first.length + last.length + 32 > budget) {
    const tail = last.slice(-Math.max(1, budget - 64));
    return { context: "[Earlier context omitted]\n" + tail, originalMessageCount: messages.length, retainedMessageCount: 1, omittedMessageCount: Math.max(0, messages.length - 1), truncated: true };
  }
  const context = [first, `[Omitted ${Math.max(0, messages.length - 2)} middle messages]`, last].join("\n");
  return { context: context.length <= budget ? context : context.slice(0, budget), originalMessageCount: messages.length, retainedMessageCount: Math.min(2, messages.length), omittedMessageCount: Math.max(0, messages.length - 2), truncated: true };
};

export function createProjectMemoryRetrievalHandler(store: ProjectMemoryStore): (input: unknown) => Promise<unknown> {
  return async (input) => {
    const value = record(input);
    const query = text(value, "query", 2_000);
    const entries: ProjectMemoryEntry[] = await store.find(query);
    const safeEntries = entries.filter(entry => !containsPromptInjection(entry.content)).slice(0, 12);
    return {
      query,
      entries: safeEntries.map(entry => ({
        id: entry.id,
        project: entry.project,
        kind: entry.kind,
        content: String(redactSecrets(entry.content)).slice(0, 4_000),
        confidence: entry.confidence,
        updatedAt: entry.updatedAt,
        uses: entry.uses,
      })),
      count: safeEntries.length,
    };
  };
}

export function registerVerifiedMemorySkills(
  registry: AdvancedSkillRegistry,
  store?: ProjectMemoryStore,
): string[] {
  const registered: string[] = [];
  const handlers: Array<{ id: string; handler: AdvancedSkillHandler }> = [
    { id: "conversation.02", handler: contextSummarizer },
    { id: "conversation.05", handler: memoryConflictResolver },
    { id: "conversation.09", handler: longContextCompressor },
    ...(store ? [{ id: "conversation.04", handler: createProjectMemoryRetrievalHandler(store) }] : []),
  ];
  for (const item of handlers) {
    const definition = getAdvancedSkill(item.id);
    if (!definition || definition.status !== "verified") continue;
    registry.register(definition, item.handler);
    registered.push(item.id);
  }
  return registered;
}
