import { createHash } from "node:crypto";
import { redactSecrets } from "../security/guard.js";
import { getAdvancedSkill } from "./advanced-skill-catalog.js";
import { AdvancedSkillRegistry, type AdvancedSkillHandler } from "./advanced-skill-runtime.js";

type Input = Record<string, unknown>;
function rec(value: unknown): Input {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Input must be an object.");
  return value as Input;
}
function str(value: unknown, key: string, max = 4_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(key + " must be non-empty text within the length limit.");
  return value.trim();
}
function arr(value: unknown, key: string, max = 200): Input[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new TypeError(key + " must be a bounded list of objects.");
  return value as Input[];
}
function texts(value: unknown, key: string, max = 100): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || !item.trim() || item.length > 1_000)) throw new TypeError(key + " must be a bounded list of non-empty strings.");
  return [...new Set(value.map(item => (item as string).trim()))];
}
function bool(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(key + " must be boolean.");
  return value;
}
function num(value: unknown, key: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new TypeError(key + " must be a finite number within range.");
  return value;
}

/** Finds common secret-like patterns and reports locations only, never secret values. */
export const secretLeakDetector = (input: unknown) => {
  const value = rec(input);
  const content = str(value.content, "content", 100_000);
  const patterns: Array<[string, RegExp]> = [
    ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
    ["github-token", /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g],
    ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/g],
    ["generic-assignment", /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s,;]{8,}/gi],
    ["bearer-token", /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/gi],
  ];
  const findings: Array<{ kind: string; line: number; column: number }> = [];
  for (const [kind, pattern] of patterns) {
    for (const match of content.matchAll(pattern)) {
      const offset = match.index ?? 0;
      const before = content.slice(0, offset);
      findings.push({ kind, line: before.split("\n").length, column: offset - before.lastIndexOf("\n") });
    }
  }
  return { findings: findings.sort((a, b) => a.line - b.line || a.column - b.column), count: findings.length, originalContentReturned: false, automaticDeletionPerformed: false };
};

/** Classifies command strings for review only; never executes shell commands. */
export const commandRiskClassifier = (input: unknown) => {
  const value = rec(input);
  const command = str(value.command, "command", 8_000);
  const lower = command.toLowerCase();
  const reasons: string[] = [];
  if (/(^|[;&|\s])rm\s+[^\n]*-[^\n]*r[^\n]*f|\bmkfs(?:\.|\s)|\bdd\s+if=|\bformat\s+[a-z]:/i.test(command)) reasons.push("destructive-filesystem");
  if (/\bgit\s+push\s+.*--force|\bgit\s+reset\s+--hard|\bgit\s+clean\s+-[a-z]*f/i.test(command)) reasons.push("destructive-git");
  if (/\bcurl\b.*\|\s*(?:sh|bash)|\bwget\b.*\|\s*(?:sh|bash)/i.test(command)) reasons.push("remote-code-pipe");
  if (/\bsudo\b|\bchmod\s+777\b|\bchown\s+-R\b/i.test(command)) reasons.push("privilege-or-permission-change");
  if (/\b(?:curl|wget|ssh|scp|nc|netcat)\b/i.test(command)) reasons.push("network-side-effect");
  if (reasons.length === 0 && /\b(?:npm test|npm run typecheck|git status|git diff|pwd|ls|cat)\b/i.test(lower)) reasons.push("common-inspection-or-test-command");
  const risk = reasons.some(r => r.startsWith("destructive") || r === "remote-code-pipe") ? "high" : reasons.some(r => r !== "common-inspection-or-test-command") ? "review" : "lower";
  return { risk, reasons, commandHash: createHash("sha256").update(command).digest("hex"), commandReturned: false, executed: false, requiresHumanReview: risk !== "lower" };
};

/** Plans a fail-closed approval decision from trusted upstream verification flags. */
export const approvalGateManager = (input: unknown) => {
  const value = rec(input);
  const actionId = str(value.actionId, "actionId", 200);
  const risk = value.risk;
  if (!["read-only", "may-write", "privileged", "destructive"].includes(String(risk))) throw new TypeError("risk is invalid.");
  const approvalGranted = bool(value.approvalGranted, "approvalGranted");
  const approvalVerifierTrusted = bool(value.approvalVerifierTrusted, "approvalVerifierTrusted");
  const actionHashMatches = bool(value.actionHashMatches, "actionHashMatches");
  const requiresApproval = risk !== "read-only";
  const allowedToProceed = !requiresApproval || (approvalGranted && approvalVerifierTrusted && actionHashMatches);
  return { actionId, decision: allowedToProceed ? "eligible-for-runtime-policy-check" : "deny", requiresApproval, allowedToProceed, bypassesRuntimePolicy: false };
};

/** Evaluates explicit security regression checks without mutating controls or claiming full penetration testing. */
export const securityRegressionTester = (input: unknown) => {
  const value = rec(input);
  const checks = arr(value.checks, "checks", 200).map((item, index) => ({ id: str(item.id, "checks[" + index + "].id", 200), passed: bool(item.passed, "checks[" + index + "].passed"), evidenceId: item.evidenceId === undefined ? "" : str(item.evidenceId, "evidenceId", 200) }));
  const failures = checks.filter(item => !item.passed || !item.evidenceId).map(item => item.id);
  return { checkCount: checks.length, passedCount: checks.filter(item => item.passed && item.evidenceId).length, failures, ready: checks.length > 0 && failures.length === 0, fullPenTestPerformed: false };
};

/** Converts browser steps into a reviewable plan; it never controls a browser. */
export const browserWorkflowPlanner = (input: unknown) => {
  const value = rec(input);
  const goal = str(value.goal, "goal", 2_000);
  const steps = arr(value.steps, "steps", 100).map((item, index) => {
    const action = str(item.action, "steps[" + index + "].action", 100);
    if (!["navigate", "inspect", "click", "type", "submit", "download", "upload"].includes(action)) throw new TypeError("Unsupported browser action.");
    const target = str(item.target, "steps[" + index + "].target", 2_000);
    return { order: index + 1, action, target, sideEffect: ["submit", "upload", "download", "click", "type"].includes(action), requiresApproval: ["submit", "upload"].includes(action) };
  });
  return { goal, steps, sideEffectsPossible: steps.some(s => s.sideEffect), executionStarted: false, approvalRequiredBeforeSubmitOrUpload: true };
};

/** Compares supplied browser observations against expectations; no browser is queried. */
export const browserStateVerifier = (input: unknown) => {
  const value = rec(input);
  const expected = texts(value.expected, "expected", 100);
  const observed = texts(value.observed, "observed", 100);
  const missing = expected.filter(item => !observed.includes(item));
  const unexpected = observed.filter(item => !expected.includes(item));
  return { passed: missing.length === 0, missing, unexpected, observationSource: "caller-supplied", browserAccessed: false };
};

/** Validates a proposed Git operation against a narrow allowlist; does not run Git. */
export const gitWorkflowOperator = (input: unknown) => {
  const value = rec(input);
  const operation = str(value.operation, "operation", 100);
  const branch = str(value.branch, "branch", 300);
  const dirtyWorkingTree = bool(value.dirtyWorkingTree, "dirtyWorkingTree");
  const allowed = ["status", "diff", "log", "show", "branch-list", "add-reviewed-files", "commit-reviewed-changes", "push-feature-branch"];
  const destructive = ["reset", "clean", "force-push", "checkout-overwrite", "rebase"];
  const known = allowed.includes(operation);
  const blocked = destructive.includes(operation) || !known;
  return { operation, branch, allowed: known && !blocked, blocked, requiresReview: dirtyWorkingTree || operation.includes("commit") || operation.includes("push"), executionPerformed: false, destructiveGitUsed: false };
};

/** Requests a verified approval for external side effects and otherwise fails closed. */
export const externalActionApproval = (input: unknown) => {
  const value = rec(input);
  const action = str(value.action, "action", 300);
  const effect = value.effect;
  if (!["read", "write", "network", "destructive", "financial", "publish"].includes(String(effect))) throw new TypeError("effect is invalid.");
  const verifierTrusted = bool(value.verifierTrusted, "verifierTrusted");
  const approvalBoundToAction = bool(value.approvalBoundToAction, "approvalBoundToAction");
  const approvalPresent = bool(value.approvalPresent, "approvalPresent");
  const sensitive = effect !== "read";
  const eligible = !sensitive || (verifierTrusted && approvalBoundToAction && approvalPresent);
  return { action, effect, decision: eligible ? "eligible-for-runtime-enforcement" : "deny", approvalRequired: sensitive, externalActionExecuted: false, bypassesSecurityController: false };
};

/** Proposes integration tests from supplied components and interactions. */
export const integrationTestDesigner = (input: unknown) => {
  const value = rec(input);
  const components = texts(value.components, "components", 100);
  const interactions = arr(value.interactions, "interactions", 200).map((item, index) => ({ id: str(item.id, "interactions[" + index + "].id", 200), from: str(item.from, "from", 200), to: str(item.to, "to", 200), expected: str(item.expected, "expected", 2_000) }));
  const unknownEndpoints = interactions.filter(item => !components.includes(item.from) || !components.includes(item.to)).map(item => item.id);
  return { components, proposedTests: interactions.map(item => ({ id: "integration-" + item.id, setup: [item.from, item.to], assertion: item.expected })), unknownEndpoints, requiresReview: unknownEndpoints.length > 0, testsExecuted: false };
};

/** Maps acceptance criteria into an end-to-end test outline; it does not drive a browser or agent. */
export const endToEndTestPlanner = (input: unknown) => {
  const value = rec(input);
  const criteria = arr(value.criteria, "criteria", 100).map((item, index) => ({ id: str(item.id, "criteria[" + index + "].id", 200), given: str(item.given, "given", 1_000), when: str(item.when, "when", 1_000), then: str(item.then, "then", 1_000) }));
  return { scenarios: criteria.map(item => ({ id: "e2e-" + item.id, given: item.given, when: item.when, then: item.then, cleanupRequired: true })), scenarioCount: criteria.length, testsExecuted: false };
};

/** Detects flakiness from caller-supplied repeated outcomes. */
export const flakyTestDetector = (input: unknown) => {
  const value = rec(input);
  const tests = arr(value.tests, "tests", 500).map((item, index) => {
    const id = str(item.id, "tests[" + index + "].id", 200);
    const outcomes = texts(item.outcomes, "outcomes", 100).map(x => x.toLowerCase());
    if (outcomes.some(x => x !== "pass" && x !== "fail" && x !== "skip")) throw new TypeError("outcomes must be pass, fail, or skip.");
    const distinct = new Set(outcomes);
    return { id, attempts: outcomes.length, outcomes, flaky: distinct.has("pass") && distinct.has("fail"), failureRate: outcomes.length ? outcomes.filter(x => x === "fail").length / outcomes.length : 0 };
  });
  return { tests, flakyCount: tests.filter(item => item.flaky).length, dataSource: "caller-supplied-run-history" };
};

/** Computes release readiness from explicit gates and evidence references. */
export const releaseReadinessAuditor = (input: unknown) => {
  const value = rec(input);
  const gates = arr(value.gates, "gates", 100).map((item, index) => ({ id: str(item.id, "gates[" + index + "].id", 200), passed: bool(item.passed, "passed"), evidenceId: item.evidenceId === undefined ? "" : str(item.evidenceId, "evidenceId", 200), blocking: item.blocking === undefined ? true : bool(item.blocking, "blocking") }));
  const blockers = gates.filter(g => g.blocking && (!g.passed || !g.evidenceId)).map(g => g.id);
  return { ready: gates.length > 0 && blockers.length === 0, blockers, gateCount: gates.length, evidenceBackedCount: gates.filter(g => g.passed && g.evidenceId).length, releasePerformed: false };
};

/** Validates a message envelope using a trusted verifier's result; does not implement cryptography itself. */
export const agentMessageValidator = (input: unknown) => {
  const value = rec(input);
  const messageId = str(value.messageId, "messageId", 200);
  const senderId = str(value.senderId, "senderId", 200);
  const recipientId = str(value.recipientId, "recipientId", 200);
  const nonce = str(value.nonce, "nonce", 500);
  const timestamp = num(value.timestamp, "timestamp");
  const signatureVerified = bool(value.signatureVerified, "signatureVerified");
  const replayDetected = bool(value.replayDetected, "replayDetected");
  const valid = signatureVerified && !replayDetected && senderId !== recipientId;
  return { messageId, senderId, recipientId, nonce, timestamp, valid, decision: valid ? "eligible-for-scope-policy-check" : "reject", cryptographyPerformedHere: false };
};

/** Produces a read-only shared-task-board snapshot from supplied task records. */
export const sharedTaskBoard = (input: unknown) => {
  const value = rec(input);
  const tasks = arr(value.tasks, "tasks", 500).map((item, index) => {
    const id = str(item.id, "tasks[" + index + "].id", 200);
    const status = str(item.status, "status", 50);
    if (!["queued", "active", "blocked", "done", "failed", "cancelled"].includes(status)) throw new TypeError("task status is invalid.");
    return { id, owner: item.owner === undefined ? "unassigned" : str(item.owner, "owner", 200), status, dependencyIds: texts(item.dependencyIds, "dependencyIds", 100) };
  });
  return { tasks, counts: Object.fromEntries(["queued", "active", "blocked", "done", "failed", "cancelled"].map(status => [status, tasks.filter(task => task.status === status).length])), persisted: false };
};

/** Reviews an agent result against supplied criteria and evidence without granting authority. */
export const agentResultReviewer = (input: unknown) => {
  const value = rec(input);
  const resultId = str(value.resultId, "resultId", 200);
  const criteria = texts(value.criteria, "criteria", 100);
  const satisfied = texts(value.satisfiedCriteria, "satisfiedCriteria", 100);
  const evidenceIds = texts(value.evidenceIds, "evidenceIds", 200);
  const missingCriteria = criteria.filter(item => !satisfied.includes(item));
  return { resultId, passed: missingCriteria.length === 0 && evidenceIds.length > 0, missingCriteria, evidenceCount: evidenceIds.length, approvalGranted: false, scopeExpanded: false };
};

/** Finds cycles and repeated states in supplied agent traces; does not cancel agents. */
export const loopDeadlockDetector = (input: unknown) => {
  const value = rec(input);
  const states = texts(value.states, "states", 2_000);
  const stateCounts = new Map<string, number>();
  for (const state of states) stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
  const repeatedStates = [...stateCounts.entries()].filter(([, count]) => count > 2).map(([state, count]) => ({ state, count }));
  const edges = arr(value.dependencies ?? [], "dependencies", 2_000).map((item, index) => ({ from: str(item.from, "dependencies[" + index + "].from", 200), to: str(item.to, "dependencies[" + index + "].to", 200) }));
  const graph = new Map<string, string[]>();
  for (const edge of edges) graph.set(edge.from, [...(graph.get(edge.from) ?? []), edge.to]);
  const visiting = new Set<string>(), visited = new Set<string>();
  let cycleDetected = false;
  const visit = (node: string): void => { if (visiting.has(node)) { cycleDetected = true; return; } if (visited.has(node)) return; visiting.add(node); for (const next of graph.get(node) ?? []) visit(next); visiting.delete(node); visited.add(node); };
  for (const node of graph.keys()) visit(node);
  return { repeatedStates, cycleDetected, suspectedLoop: repeatedStates.length > 0 || cycleDetected, agentCancelled: false };
};

/** Scores alignment against explicit human goals and prohibited actions; it does not infer hidden intent. */
export const humanGoalAlignmentMonitor = (input: unknown) => {
  const value = rec(input);
  const goals = texts(value.goals, "goals", 100);
  const action = str(value.proposedAction, "proposedAction", 2_000);
  const supportedGoalIds = texts(value.supportedGoalIds, "supportedGoalIds", 100);
  const prohibited = bool(value.matchesProhibitedAction, "matchesProhibitedAction");
  const unexplained = goals.filter(goal => !supportedGoalIds.includes(goal));
  const aligned = goals.length > 0 && supportedGoalIds.length > 0 && !prohibited;
  return { aligned, decision: prohibited ? "deny-and-review" : aligned ? "eligible-for-scope-check" : "needs-human-clarification", proposedActionHash: createHash("sha256").update(action).digest("hex"), unsupportedGoals: unexplained, executionPerformed: false };
};

/** Evaluates a supplied event against explicit trigger conditions; no workflow is started. */
export const workflowTriggerEvaluator = (input: unknown) => {
  const value = rec(input);
  const eventType = str(value.eventType, "eventType", 200);
  const expectedType = str(value.expectedType, "expectedType", 200);
  const requiredFlags = texts(value.requiredFlags, "requiredFlags", 100);
  const flags = rec(value.flags ?? {});
  const missingFlags = requiredFlags.filter(flag => flags[flag] !== true);
  const matches = eventType === expectedType && missingFlags.length === 0;
  return { matches, missingFlags, triggerFired: false, workflowStarted: false };
};

/** Summarizes job progress and timeout status from explicit timestamps; never retries or cancels a job. */
export const longRunningJobMonitor = (input: unknown) => {
  const value = rec(input);
  const jobId = str(value.jobId, "jobId", 200);
  const startedAt = num(value.startedAt, "startedAt");
  const now = num(value.now, "now");
  const timeoutMs = num(value.timeoutMs, "timeoutMs", 1, 86_400_000);
  if (now < startedAt) throw new RangeError("now must not precede startedAt.");
  const elapsedMs = now - startedAt;
  const status = str(value.status, "status", 50);
  const terminal = ["completed", "failed", "cancelled"].includes(status);
  return { jobId, elapsedMs, timeoutMs, timedOut: !terminal && elapsedMs > timeoutMs, terminal, cancellationPerformed: false, retryPerformed: false };
};

/** Checks SLA budgets from supplied timing data and reports a breach without taking action. */
export const slaWatchdog = (input: unknown) => {
  const value = rec(input);
  const taskId = str(value.taskId, "taskId", 200);
  const elapsedMs = num(value.elapsedMs, "elapsedMs");
  const budgetMs = num(value.budgetMs, "budgetMs");
  const breached = elapsedMs > budgetMs;
  return { taskId, elapsedMs, budgetMs, breached, overrunMs: Math.max(0, elapsedMs - budgetMs), alertSent: false };
};

/** Drafts notifications from explicit events; never sends messages. */
export const notificationPlanner = (input: unknown) => {
  const value = rec(input);
  const event = str(value.event, "event", 2_000);
  const audience = texts(value.audience, "audience", 100);
  const channels = texts(value.channels, "channels", 20);
  if (channels.some(channel => !["in-app", "email", "slack", "telegram", "webhook"].includes(channel))) throw new TypeError("Unsupported notification channel.");
  const message = redactSecrets(str(value.message, "message", 4_000));
  return { event, audience, channels, message, draftCreated: true, sent: false, approvalRequiredForExternalChannels: channels.some(channel => channel !== "in-app") };
};

/** Curates a bounded, redacted incident summary from supplied failure records; never persists memory. */
export const failureMemoryCurator = (input: unknown) => {
  const value = rec(input);
  const incidents = arr(value.incidents, "incidents", 500).map((item, index) => ({
    id: str(item.id, "incidents[" + index + "].id", 200),
    category: str(item.category, "category", 100),
    summary: redactSecrets(str(item.summary, "summary", 2_000)),
    resolution: item.resolution === undefined ? "" : redactSecrets(str(item.resolution, "resolution", 2_000)),
    success: item.success === undefined ? false : bool(item.success, "success"),
  }));
  const byCategory = new Map<string, number>();
  for (const item of incidents) byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + 1);
  return { incidents, categoryCounts: Object.fromEntries(byCategory), curated: true, persisted: false, autoLearningApplied: false };
};

const HANDLERS: ReadonlyArray<{ id: string; handler: AdvancedSkillHandler }> = [
  { id: "security.03", handler: secretLeakDetector },
  { id: "security.07", handler: commandRiskClassifier },
  { id: "security.08", handler: approvalGateManager },
  { id: "security.10", handler: securityRegressionTester },
  { id: "tools.04", handler: browserWorkflowPlanner },
  { id: "tools.05", handler: browserStateVerifier },
  { id: "tools.08", handler: gitWorkflowOperator },
  { id: "tools.10", handler: externalActionApproval },
  { id: "testing.03", handler: integrationTestDesigner },
  { id: "testing.04", handler: endToEndTestPlanner },
  { id: "testing.06", handler: flakyTestDetector },
  { id: "testing.10", handler: releaseReadinessAuditor },
  { id: "agents.03", handler: agentMessageValidator },
  { id: "agents.04", handler: sharedTaskBoard },
  { id: "agents.07", handler: agentResultReviewer },
  { id: "agents.09", handler: loopDeadlockDetector },
  { id: "agents.10", handler: humanGoalAlignmentMonitor },
  { id: "workflow.02", handler: workflowTriggerEvaluator },
  { id: "workflow.04", handler: longRunningJobMonitor },
  { id: "workflow.07", handler: slaWatchdog },
  { id: "workflow.08", handler: notificationPlanner },
  { id: "evolution.02", handler: failureMemoryCurator },
];
export function registerVerifiedSecurityCoordinationSkills(registry: AdvancedSkillRegistry): string[] {
  const registered: string[] = [];
  for (const item of HANDLERS) {
    const definition = getAdvancedSkill(item.id);
    if (!definition || definition.status !== "verified") continue;
    registry.register(definition, item.handler);
    registered.push(item.id);
  }
  return registered;
}
