import { createHash } from "node:crypto";
import { redactSecrets } from "../security/guard.js";
import { getAdvancedSkill } from "./advanced-skill-catalog.js";
import { AdvancedSkillRegistry, type AdvancedSkillHandler } from "./advanced-skill-runtime.js";

type Input = Record<string, unknown>;
function record(input: unknown): Input {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Input must be an object.");
  return input as Input;
}
function text(value: unknown, key: string, max = 8_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(key + " must be non-empty text within the length limit.");
  return value.trim();
}
function list(value: unknown, key: string, max = 100): Input[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new TypeError(key + " must be a bounded list of objects.");
  return value as Input[];
}
function strings(value: unknown, key: string, max = 100): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || !item.trim() || item.length > 2_000)) throw new TypeError(key + " must be a bounded list of non-empty strings.");
  return [...new Set(value.map(item => (item as string).trim()))];
}
function finite(value: unknown, key: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new TypeError(key + " must be a finite number within range.");
  return value;
}

/** Evaluates caller-supplied checkpoint metadata; does not write, restore, or roll back checkpoint data. */
export const checkpointManager = (input: unknown) => {
  const value = record(input);
  const checkpointId = text(value.checkpointId, "checkpointId", 200);
  const createdAt = finite(value.createdAt, "createdAt");
  const currentVersion = text(value.currentVersion, "currentVersion", 200);
  const checkpointVersion = text(value.checkpointVersion, "checkpointVersion", 200);
  const compatible = currentVersion === checkpointVersion;
  const containsSecrets = value.containsSecrets;
  const integrityVerified = value.integrityVerified;
  if (typeof containsSecrets !== "boolean" || typeof integrityVerified !== "boolean") throw new TypeError("containsSecrets and integrityVerified must be booleans.");
  const recommendation = !integrityVerified ? "reject-integrity-unverified" : containsSecrets ? "quarantine-secret-bearing-checkpoint" : !compatible ? "manual-compatibility-review" : "eligible-for-authorized-review";
  return { checkpointId, createdAt, compatible, integrityVerified, containsSecrets, recommendation, restorePerformed: false, requiresApproval: true };
};

/** Structures the user's supplied message without generating missing requirements. */
export const naturalConversation = (input: unknown) => {
  const value = record(input);
  const message = text(value.message, "message", 20_000);
  const normalized = message.replace(/\s+/g, " ").trim();
  const explicitConstraints = strings(value.constraints, "constraints", 50);
  const asksQuestion = /\?\s*$/.test(normalized);
  const imperative = /^(please\s+)?(add|create|build|fix|update|remove|review|explain|find|compare|write|test|run|deploy)\b/i.test(normalized);
  return { normalizedMessage: normalized, explicitConstraints, likelyQuestion: asksQuestion, likelyActionRequest: imperative, confidence: asksQuestion && imperative ? "mixed" : asksQuestion || imperative ? "moderate" : "uncertain", inferredFacts: [] as string[] };
};

/** Extracts only explicitly stated preferences from supplied statements; never persists them. */
export const userPreferenceMemory = (input: unknown) => {
  const value = record(input);
  const statements = strings(value.statements, "statements", 200);
  const candidates = statements.filter(s => /\b(I prefer|I like|I dislike|I don't like|please always|please never|I want|I need)\b/i.test(s));
  return { candidates: candidates.map(statement => ({ statement: redactSecrets(statement), source: "user-supplied", requiresConfirmation: true })), stored: false, sensitiveInferencePerformed: false };
};

/** Parses explicit numbered/bulleted lines into proposed tasks only. */
export const conversationToTaskParser = (input: unknown) => {
  const value = record(input);
  const message = text(value.message, "message", 30_000);
  const tasks = message.split(/\r?\n/).map(line => line.trim()).filter(line => /^(?:[-*•]|\d+[.)])\s+/.test(line)).map((line, index) => ({ id: "task-" + (index + 1), description: line.replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim() })).filter(task => task.description.length > 0);
  return { tasks, count: tasks.length, sourceLinesOnly: true, executed: false, needsHumanReview: tasks.length === 0 };
};

/** Selects missing details from explicit goal/known-field metadata; it does not ask the user itself. */
export const clarifyingQuestionPlanner = (input: unknown) => {
  const value = record(input);
  const goal = text(value.goal, "goal", 8_000);
  const knownFields = strings(value.knownFields, "knownFields", 100).map(x => x.toLowerCase());
  const requiredFields = strings(value.requiredFields, "requiredFields", 100);
  const missing = requiredFields.filter(field => !knownFields.includes(field.toLowerCase()));
  return { goal, missingFields: missing, questions: missing.map(field => ({ field, question: "What should Sofia use for " + field + "?", required: true })), readyToProceed: missing.length === 0, assumptionsAdded: false };
};

/** Creates a bounded handoff package from caller-provided state; no session state is changed. */
export const sessionHandoff = (input: unknown) => {
  const value = record(input);
  const summary = text(value.summary, "summary", 12_000);
  const completed = strings(value.completed, "completed", 100);
  const pending = strings(value.pending, "pending", 100);
  const constraints = strings(value.constraints, "constraints", 100);
  const evidenceIds = strings(value.evidenceIds, "evidenceIds", 200);
  return { summary: redactSecrets(summary), completed: completed.map(item => redactSecrets(item)), pending: pending.map(item => redactSecrets(item)), constraints: constraints.map(item => redactSecrets(item)), evidenceIds, handoffCreated: true, sessionMutated: false };
};

/** Applies a transparent retention recommendation to supplied metadata only. */
export const memoryRetentionPolicy = (input: unknown) => {
  const value = record(input);
  const sensitivity = value.sensitivity;
  const userApproved = value.userApproved;
  const hasExpiry = value.hasExpiry;
  const containsCredential = value.containsCredential;
  if (!["ordinary", "personal", "sensitive", "secret"].includes(String(sensitivity))) throw new TypeError("sensitivity is invalid.");
  if (typeof userApproved !== "boolean" || typeof hasExpiry !== "boolean" || typeof containsCredential !== "boolean") throw new TypeError("approval and retention flags must be booleans.");
  let decision = "retain-with-expiry";
  if (containsCredential || sensitivity === "secret") decision = "do-not-store";
  else if (sensitivity === "sensitive" && !userApproved) decision = "discard-unapproved-sensitive-data";
  else if (sensitivity === "personal" && !userApproved) decision = "request-explicit-consent";
  else if (!hasExpiry) decision = "require-expiry-policy";
  return { decision, userApproved, hasExpiry, storagePerformed: false, automaticDeletionPerformed: false };
};

/** Finds coverage gaps from supplied coverage counters; does not inspect source files or run tests. */
export const coverageGapAnalyzer = (input: unknown) => {
  const value = record(input);
  const files = list(value.files, "files", 500).map((file, index) => {
    const path = text(file.path, "files[" + index + "].path", 1_000);
    const statements = finite(file.statements, "statements", 0, 1_000_000);
    const covered = finite(file.coveredStatements, "coveredStatements", 0, statements);
    const tests = finite(file.testCount, "testCount", 0, 100_000);
    return { path, statements, coveredStatements: covered, testCount: tests, uncoveredStatements: statements - covered, coverageRatio: statements === 0 ? 1 : covered / statements, gap: statements > covered || tests === 0 };
  });
  return { files, gapCount: files.filter(file => file.gap).length, dataSource: "caller-supplied-coverage-metadata", filesystemInspected: false };
};

/** Ranks caller-provided source metadata using explicit dimensions; does not verify sources online. */
export const sourceCredibilityRanker = (input: unknown) => {
  const value = record(input);
  const sources = list(value.sources, "sources", 200).map((source, index) => {
    const id = text(source.id, "sources[" + index + "].id", 200);
    const authority = finite(source.authority, "authority", 0, 1);
    const primary = source.primarySource;
    const recent = source.recent;
    const transparent = source.transparent;
    if (typeof primary !== "boolean" || typeof recent !== "boolean" || typeof transparent !== "boolean") throw new TypeError("source quality flags must be booleans.");
    const score = Math.round((authority * 0.5 + (primary ? 0.2 : 0) + (recent ? 0.15 : 0) + (transparent ? 0.15 : 0)) * 1000) / 1000;
    return { id, score, factors: { authority, primary, recent, transparent }, verifiedExternally: false };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { sources, scoringModel: "authority-50-primary-20-recency-15-transparency-15", factualVerificationPerformed: false };
};

/** Groups evidence-backed claims by topic and reports conflicts without choosing a winner. */
export const crossSourceSynthesizer = (input: unknown) => {
  const value = record(input);
  const claims = list(value.claims, "claims", 500).map((claim, index) => ({
    topic: text(claim.topic, "claims[" + index + "].topic", 300),
    sourceId: text(claim.sourceId, "claims[" + index + "].sourceId", 200),
    claim: text(claim.claim, "claims[" + index + "].claim", 4_000),
    evidenceId: claim.evidenceId === undefined ? "" : text(claim.evidenceId, "evidenceId", 300),
  }));
  const topics = new Map<string, typeof claims>();
  for (const claim of claims) topics.set(claim.topic, [...(topics.get(claim.topic) ?? []), claim]);
  const synthesis = [...topics.entries()].map(([topic, items]) => ({ topic, claims: items, sourceCount: new Set(items.map(item => item.sourceId)).size, conflict: new Set(items.map(item => item.claim)).size > 1, missingEvidence: items.filter(item => !item.evidenceId).map(item => item.sourceId) }));
  return { synthesis, unresolvedConflicts: synthesis.filter(item => item.conflict).length, autoResolved: false };
};

/** Detects exact-topic claim disagreements from supplied records; does not adjudicate truth. */
export const factConflictDetector = (input: unknown) => {
  const value = record(input);
  const claims = list(value.claims, "claims", 500).map((claim, index) => ({ topic: text(claim.topic, "claims[" + index + "].topic", 300).toLowerCase(), sourceId: text(claim.sourceId, "sourceId", 200), value: text(claim.value, "value", 4_000) }));
  const groups = new Map<string, typeof claims>();
  for (const claim of claims) groups.set(claim.topic, [...(groups.get(claim.topic) ?? []), claim]);
  const conflicts = [...groups.entries()].filter(([, items]) => new Set(items.map(item => item.value)).size > 1).map(([topic, items]) => ({ topic, claims: items, requiresReview: true }));
  return { conflicts, conflictCount: conflicts.length, truthDetermined: false };
};

/** Formats a research brief solely from supplied sources and explicit questions. */
export const researchBriefWriter = (input: unknown) => {
  const value = record(input);
  const question = text(value.question, "question", 4_000);
  const sources = list(value.sources, "sources", 100).map((source, index) => ({ id: text(source.id, "sources[" + index + "].id", 200), summary: text(source.summary, "sources[" + index + "].summary", 4_000), limitations: strings(source.limitations ?? [], "limitations", 30) }));
  return { question, evidence: sources, sourceCount: sources.length, openQuestions: strings(value.openQuestions ?? [], "openQuestions", 100), unsupportedConclusionsAdded: false, readyForHumanReview: true };
};

/** Computes a deterministic idempotency key; this does not execute or deduplicate an external action. */
export const idempotencyGuard = (input: unknown) => {
  const value = record(input);
  const action = text(value.action, "action", 2_000);
  const scope = text(value.scope, "scope", 500);
  const payload = value.payload ?? null;
  const serialized = JSON.stringify(payload);
  if (serialized === undefined || serialized.length > 50_000) throw new RangeError("payload must be JSON-serializable and at most 50000 characters.");
  const key = createHash("sha256").update(scope + "\0" + action + "\0" + serialized).digest("hex");
  return { key, scope, action, deduplicationPerformed: false, callerMustEnforceUniqueness: true };
};

/** Validates a scheduled-job proposal without creating a timer or cron job. */
export const scheduledJobPlanner = (input: unknown) => {
  const value = record(input);
  const jobId = text(value.jobId, "jobId", 200);
  const schedule = text(value.schedule, "schedule", 200);
  const timezone = text(value.timezone, "timezone", 100);
  const timezoneValid = (() => { try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0); return true; } catch { return false; } })();
  const recurrence = value.recurrence;
  if (!["once", "hourly", "daily", "weekly", "monthly", "cron"].includes(String(recurrence))) throw new TypeError("recurrence is invalid.");
  const requiresApproval = value.requiresApproval;
  if (typeof requiresApproval !== "boolean") throw new TypeError("requiresApproval must be boolean.");
  return { jobId, schedule, timezone, timezoneValid, recurrence, scheduleSyntaxValidated: false, approvalRequired: requiresApproval, jobCreated: false };
};

/** Calculates budget and latency summaries from supplied observations only. */
export const costLatencyAnalyzer = (input: unknown) => {
  const value = record(input);
  const samples = list(value.samples, "samples", 10_000).map((sample, index) => ({ cost: finite(sample.cost, "samples[" + index + "].cost"), latencyMs: finite(sample.latencyMs, "samples[" + index + "].latencyMs", 0, 86_400_000), route: text(sample.route, "samples[" + index + "].route", 200) }));
  const totalCost = samples.reduce((sum, sample) => sum + sample.cost, 0);
  const latencies = samples.map(sample => sample.latencyMs).sort((a, b) => a - b);
  const percentile = (p: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(p * latencies.length) - 1)] : null;
  const routes = new Map<string, { count: number; cost: number; latencyTotal: number }>();
  for (const sample of samples) { const prev = routes.get(sample.route) ?? { count: 0, cost: 0, latencyTotal: 0 }; routes.set(sample.route, { count: prev.count + 1, cost: prev.cost + sample.cost, latencyTotal: prev.latencyTotal + sample.latencyMs }); }
  return { sampleCount: samples.length, totalCost, averageCost: samples.length ? totalCost / samples.length : 0, p50LatencyMs: percentile(0.5), p95LatencyMs: percentile(0.95), routes: [...routes.entries()].map(([route, stats]) => ({ route, count: stats.count, totalCost: stats.cost, averageLatencyMs: stats.latencyTotal / stats.count })), optimizationPerformed: false };
};

/** Evaluates supplied test cases without executing model calls or modifying production routing. */
export const offlineEvaluationRunner = (input: unknown) => {
  const value = record(input);
  const cases = list(value.cases, "cases", 1_000).map((item, index) => {
    const id = text(item.id, "cases[" + index + "].id", 200);
    const expected = text(item.expected, "expected", 4_000);
    const actual = text(item.actual, "actual", 4_000);
    const exact = item.exactMatch ?? true;
    if (typeof exact !== "boolean") throw new TypeError("exactMatch must be boolean.");
    return { id, passed: exact ? expected === actual : actual.toLowerCase().includes(expected.toLowerCase()), comparison: exact ? "exact" : "contains" };
  });
  return { cases, passed: cases.filter(item => item.passed).length, failed: cases.filter(item => !item.passed).length, executedCases: false, promotionAllowed: false };
};

/** Recommends rollback review from explicit regression evidence; never changes skill status or deployment. */
export const skillRollbackManager = (input: unknown) => {
  const value = record(input);
  const skillId = text(value.skillId, "skillId", 200);
  const regressionDetected = value.regressionDetected;
  const rollbackAvailable = value.rollbackAvailable;
  const securityIncident = value.securityIncident;
  if (typeof regressionDetected !== "boolean" || typeof rollbackAvailable !== "boolean" || typeof securityIncident !== "boolean") throw new TypeError("rollback evidence flags must be boolean.");
  const recommendation = securityIncident ? "halt-and-escalate" : regressionDetected && rollbackAvailable ? "request-human-approved-rollback" : regressionDetected ? "manual-investigation" : "no-rollback-indicated";
  return { skillId, recommendation, automaticRollback: false, statusChanged: false, requiresHumanReview: recommendation !== "no-rollback-indicated" };
};

const HANDLERS: ReadonlyArray<{ id: string; handler: AdvancedSkillHandler }> = [
  { id: "runtime.06", handler: checkpointManager },
  { id: "conversation.01", handler: naturalConversation },
  { id: "conversation.03", handler: userPreferenceMemory },
  { id: "conversation.06", handler: conversationToTaskParser },
  { id: "conversation.07", handler: clarifyingQuestionPlanner },
  { id: "conversation.08", handler: sessionHandoff },
  { id: "conversation.10", handler: memoryRetentionPolicy },
  { id: "testing.07", handler: coverageGapAnalyzer },
  { id: "research.02", handler: sourceCredibilityRanker },
  { id: "research.04", handler: crossSourceSynthesizer },
  { id: "research.06", handler: factConflictDetector },
  { id: "research.10", handler: researchBriefWriter },
  { id: "workflow.03", handler: scheduledJobPlanner },
  { id: "workflow.05", handler: idempotencyGuard },
  { id: "evolution.07", handler: costLatencyAnalyzer },
  { id: "evolution.08", handler: offlineEvaluationRunner },
  { id: "evolution.10", handler: skillRollbackManager },
];
export function registerVerifiedPlanningAnalysisSkills(registry: AdvancedSkillRegistry): string[] {
  const registered: string[] = [];
  for (const item of HANDLERS) {
    const definition = getAdvancedSkill(item.id);
    if (!definition || definition.status !== "verified") continue;
    registry.register(definition, item.handler);
    registered.push(item.id);
  }
  return registered;
}
