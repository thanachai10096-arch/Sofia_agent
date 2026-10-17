import { getAdvancedSkill } from "./advanced-skill-catalog.js";
import { AdvancedSkillRegistry, type AdvancedSkillHandler } from "./advanced-skill-runtime.js";

type InputRecord = Record<string, unknown>;
function record(input: unknown): InputRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Input must be an object.");
  return input as InputRecord;
}
function text(value: unknown, key: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(key + " must be non-empty text within the length limit.");
  return value.trim();
}
function stringList(value: unknown, key: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || !item.trim() || item.length > 500)) throw new TypeError(key + " must be a bounded list of non-empty strings.");
  return [...new Set(value.map(item => (item as string).trim()))];
}
function objectList(value: unknown, key: string, max = 100): InputRecord[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new TypeError(key + " must be a bounded list of objects.");
  return value as InputRecord[];
}

/** Creates a proposed delegation plan only; this handler never starts another agent. */
export const agentTaskDelegator = (input: unknown) => {
  const value = record(input);
  const goal = text(value.goal, "goal");
  const tasks = objectList(value.tasks, "tasks", 50).map((task, index) => {
    const id = text(task.id, "tasks[" + index + "].id", 120);
    const description = text(task.description, "tasks[" + index + "].description");
    const acceptanceCriteria = stringList(task.acceptanceCriteria, "acceptanceCriteria", 20);
    const allowedCapabilities = stringList(task.allowedCapabilities ?? [], "allowedCapabilities", 30);
    const dependencies = stringList(task.dependsOn ?? [], "dependsOn", 50);
    if (acceptanceCriteria.length === 0) throw new TypeError("Each delegated task needs acceptance criteria.");
    return { id, description, acceptanceCriteria, allowedCapabilities, dependsOn: dependencies };
  });
  if (tasks.length === 0 || new Set(tasks.map(task => task.id)).size !== tasks.length) throw new TypeError("Tasks must be non-empty and have unique IDs.");
  const known = new Set(tasks.map(task => task.id));
  for (const task of tasks) if (task.dependsOn.some(id => !known.has(id) || id === task.id)) throw new TypeError("Task dependencies must reference another known task.");
  return { goal, tasks, executionStarted: false, humanGoalRequired: true };
};

/** Recommends a specialist from declared tags; does not launch agents or grant capabilities. */
export const specialistRouter = (input: unknown) => {
  const value = record(input);
  const requiredTags = stringList(value.requiredTags, "requiredTags", 30);
  const specialists = objectList(value.specialists, "specialists", 50).map((item, index) => ({
    id: text(item.id, "specialists[" + index + "].id", 120),
    tags: stringList(item.tags, "specialist tags", 30),
    available: item.available === undefined ? true : item.available === true,
    declaredCapabilities: stringList(item.declaredCapabilities ?? [], "declaredCapabilities", 50),
  }));
  const ranked = specialists.filter(item => item.available).map(item => ({
    ...item,
    matchedTags: requiredTags.filter(tag => item.tags.includes(tag)),
    score: requiredTags.length === 0 ? 0 : requiredTags.filter(tag => item.tags.includes(tag)).length / requiredTags.length,
  })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { requiredTags, candidates: ranked, recommendation: ranked[0]?.score > 0 ? ranked[0].id : null, launchesAgent: false, grantsCapabilities: false };
};

/** Validates a handoff contract and exposes missing fields instead of guessing them. */
export const handoffContractManager = (input: unknown) => {
  const value = record(input);
  const required = ["taskId", "goal", "deliverable", "acceptanceCriteria", "allowedCapabilities"] as const;
  const missing: string[] = [];
  const normalized: Record<string, unknown> = {};
  for (const key of required) {
    if (key === "acceptanceCriteria" || key === "allowedCapabilities") {
      try {
        const items = stringList(value[key], key, 50);
        if (items.length === 0) missing.push(key);
        else normalized[key] = items;
      } catch {
        missing.push(key);
      }
    } else {
      if (typeof value[key] !== "string" || !(value[key] as string).trim()) missing.push(key);
      else normalized[key] = (value[key] as string).trim().slice(0, 2_000);
    }
  }
  return { valid: missing.length === 0, missingFields: missing, contract: missing.length === 0 ? normalized : null, executionStarted: false };
};

/** Checks dependency references and provides a stable ready-set for parallel scheduling. */
export const parallelWorkCoordinator = (input: unknown) => {
  const value = record(input);
  const tasks = objectList(value.tasks, "tasks", 100).map((task, index) => ({
    id: text(task.id, "tasks[" + index + "].id", 120),
    dependsOn: stringList(task.dependsOn ?? [], "dependsOn", 100),
  }));
  const ids = new Set(tasks.map(task => task.id));
  if (ids.size !== tasks.length) throw new TypeError("Task IDs must be unique.");
  for (const task of tasks) if (task.dependsOn.some(dep => !ids.has(dep) || dep === task.id)) throw new TypeError("Dependencies must reference other known tasks.");
  const remaining = new Map(tasks.map(task => [task.id, new Set(task.dependsOn)]));
  const batches: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id).sort();
    if (ready.length === 0) return { valid: false, batches, cycleDetected: true, unscheduled: [...remaining.keys()].sort(), executionStarted: false };
    batches.push(ready);
    for (const id of ready) remaining.delete(id);
    for (const deps of remaining.values()) for (const id of ready) deps.delete(id);
  }
  return { valid: true, batches, cycleDetected: false, unscheduled: [], executionStarted: false };
};

/** Reports conflicting agent claims and keeps them unresolved for review; no autonomous winner is selected. */
export const disagreementResolver = (input: unknown) => {
  const value = record(input);
  const claims = objectList(value.claims, "claims", 200).map((claim, index) => ({
    topic: text(claim.topic, "claims[" + index + "].topic", 300),
    agentId: text(claim.agentId, "agentId", 120),
    claim: text(claim.claim, "claim"),
    evidenceIds: stringList(claim.evidenceIds ?? [], "evidenceIds", 50),
  }));
  const topics = new Map<string, typeof claims>();
  for (const claim of claims) topics.set(claim.topic, [...(topics.get(claim.topic) ?? []), claim]);
  const disagreements = [...topics.entries()].map(([topic, items]) => ({
    topic,
    claims: items,
    disagreement: new Set(items.map(item => item.claim)).size > 1,
    missingEvidenceAgentIds: items.filter(item => item.evidenceIds.length === 0).map(item => item.agentId),
    requiresHumanReview: new Set(items.map(item => item.claim)).size > 1 || items.some(item => item.evidenceIds.length === 0),
  }));
  return { disagreements, unresolvedCount: disagreements.filter(item => item.disagreement).length, requiresHumanReview: disagreements.some(item => item.requiresHumanReview), autoResolved: false };
};

export function registerVerifiedAgentCoordinationSkills(registry: AdvancedSkillRegistry): string[] {
  const entries: Array<{ id: string; handler: AdvancedSkillHandler }> = [
    { id: "agents.01", handler: agentTaskDelegator },
    { id: "agents.02", handler: specialistRouter },
    { id: "agents.05", handler: handoffContractManager },
    { id: "agents.06", handler: parallelWorkCoordinator },
    { id: "agents.08", handler: disagreementResolver },
  ];
  const registered: string[] = [];
  for (const entry of entries) {
    const definition = getAdvancedSkill(entry.id);
    if (definition?.status === "verified") {
      registry.register(definition, entry.handler);
      registered.push(entry.id);
    }
  }
  return registered;
}
