import { createHash } from "node:crypto";
import { redactSecrets } from "../security/guard.js";
import { getAdvancedSkill } from "./advanced-skill-catalog.js";
import { AdvancedSkillRegistry, type AdvancedSkillHandler } from "./advanced-skill-runtime.js";

type Input = Record<string, unknown>;
function obj(value: unknown): Input {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Input must be an object.");
  return value as Input;
}
function text(value: unknown, key: string, max = 5_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(key + " must be non-empty text within the length limit.");
  return value.trim();
}
function list(value: unknown, key: string, max = 200): Input[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) throw new TypeError(key + " must be a bounded list of objects.");
  return value as Input[];
}
function texts(value: unknown, key: string, max = 200): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== "string" || !item.trim() || item.length > 2_000)) throw new TypeError(key + " must be a bounded list of non-empty strings.");
  return [...new Set(value.map(item => (item as string).trim()))];
}
function bool(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(key + " must be boolean.");
  return value;
}

/** Produces a reviewable patch proposal from caller-supplied patch text; never applies changes. */
export const patchGenerator = (input: unknown) => {
  const value = obj(input);
  const objective = text(value.objective, "objective", 2_000);
  const patch = text(value.patch, "patch", 100_000);
  const touchedPaths = texts(value.touchedPaths, "touchedPaths", 200);
  const blockedPaths = touchedPaths.filter(path => path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).some(part => part === ".." || [".git", "node_modules", ".env", "secrets"].includes(part.toLowerCase())));
  return { objective, patchPreview: redactSecrets(patch).slice(0, 20_000), patchHash: createHash("sha256").update(patch).digest("hex"), touchedPaths, blockedPaths, eligibleForReview: blockedPaths.length === 0, applied: false };
};

/** Plans Python-focused review from supplied metadata; does not run Python or install packages. */
export const pythonSpecialist = (input: unknown) => {
  const value = obj(input);
  const goal = text(value.goal, "goal", 2_000);
  const files = texts(value.files, "files", 200);
  const constraints = texts(value.constraints, "constraints", 100);
  const checks = ["syntax-and-imports", "type-and-interface-contracts", "dependency-and-environment", "error-handling", "tests-and-reproducibility"];
  return { goal, pythonFiles: files.filter(path => path.toLowerCase().endsWith(".py")), constraints, reviewChecklist: checks, executionPerformed: false, dependencyInstallationPerformed: false };
};

/** Drafts an API contract from supplied endpoints without creating routes or changing a server. */
export const apiContractDesigner = (input: unknown) => {
  const value = obj(input);
  const service = text(value.service, "service", 200);
  const endpoints = list(value.endpoints, "endpoints", 100).map((item, index) => {
    const method = text(item.method, "method", 12).toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new TypeError("Unsupported HTTP method.");
    const path = text(item.path, "path", 500);
    if (!path.startsWith("/") || path.includes("..")) throw new TypeError("Endpoint path must be absolute and traversal-free.");
    return { id: text(item.id, "endpoints[" + index + "].id", 200), method, path, requestSchema: item.requestSchema ?? null, responseSchema: item.responseSchema ?? null, authRequired: item.authRequired === undefined ? true : bool(item.authRequired, "authRequired") };
  });
  return { service, endpoints, contractVersion: "draft-v1", routeCreated: false, serverModified: false };
};

/** Reviews caller-supplied change findings against scope and evidence; does not inspect a repository. */
export const codeReviewAuditor = (input: unknown) => {
  const value = obj(input);
  const findings = list(value.findings, "findings", 500).map((item, index) => {
    const id = text(item.id, "findings[" + index + "].id", 200);
    const severity = text(item.severity, "severity", 30);
    if (!["critical", "high", "medium", "low", "info"].includes(severity)) throw new TypeError("Finding severity is invalid.");
    return { id, severity, description: redactSecrets(text(item.description, "description", 2_000)), evidenceId: item.evidenceId === undefined ? "" : text(item.evidenceId, "evidenceId", 200), inScope: bool(item.inScope, "inScope") };
  });
  const blockers = findings.filter(item => (item.severity === "critical" || item.severity === "high") && item.inScope && !item.evidenceId).map(item => item.id);
  return { findings, blockerIds: blockers, recommendation: blockers.length ? "request-evidence-or-fix" : "human-review-required", repositoryInspected: false, approvalGranted: false };
};

/** Generates unit-test case outlines from supplied behavior contracts, not executable test code. */
export const unitTestGenerator = (input: unknown) => {
  const value = obj(input);
  const target = text(value.target, "target", 500);
  const behaviors = texts(value.behaviors, "behaviors", 100);
  const edgeCases = texts(value.edgeCases ?? [], "edgeCases", 100);
  const cases = [...behaviors.map((behavior, index) => ({ id: "behavior-" + (index + 1), behavior, type: "expected" })), ...edgeCases.map((behavior, index) => ({ id: "edge-" + (index + 1), behavior, type: "edge" }))];
  return { target, cases, generatedCode: false, testsExecuted: false, missingBehaviorCount: behaviors.length === 0 ? 1 : 0 };
};

/** Creates a redacted audit-event candidate; persistence must use Sofia's configured audit sink. */
export const auditTrailWriter = (input: unknown) => {
  const value = obj(input);
  const eventType = text(value.eventType, "eventType", 200);
  const actorId = text(value.actorId, "actorId", 200);
  const actionId = text(value.actionId, "actionId", 200);
  const outcome = text(value.outcome, "outcome", 100);
  const reason = value.reason === undefined ? "" : redactSecrets(text(value.reason, "reason", 2_000));
  const at = value.at === undefined ? null : text(value.at, "at", 100);
  const event = { eventType, actorId, actionId, outcome, reason, at };
  return { event, eventHash: createHash("sha256").update(JSON.stringify(event)).digest("hex"), persisted: false, secretsIncludedByThisHandler: false };
};

/** Ranks registered tool metadata against requested capabilities; does not invoke tools or invent registry entries. */
export const toolDiscoveryRouter = (input: unknown) => {
  const value = obj(input);
  const goal = text(value.goal, "goal", 2_000);
  const requiredCapabilities = texts(value.requiredCapabilities, "requiredCapabilities", 50);
  const tools = list(value.registeredTools, "registeredTools", 500).map((item, index) => {
    const id = text(item.id, "registeredTools[" + index + "].id", 200);
    const capabilities = texts(item.capabilities, "capabilities", 100);
    const available = bool(item.available, "available");
    const matched = requiredCapabilities.filter(capability => capabilities.includes(capability));
    return { id, available, matchedCapabilities: matched, missingCapabilities: requiredCapabilities.filter(capability => !matched.includes(capability)), score: requiredCapabilities.length ? matched.length / requiredCapabilities.length : 0 };
  }).filter(item => item.available).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { goal, rankedTools: tools, noSuitableTool: tools.length === 0 || (tools[0]?.score ?? 0) < 1, invokedTool: false };
};

/** Creates a bounded terminal execution request for Sofia's existing permission-enforcing runtime. */
export const terminalTaskRunner = (input: unknown) => {
  const value = obj(input);
  const command = text(value.command, "command", 8_000);
  const cwd = text(value.cwd, "cwd", 2_000);
  const timeoutMs = value.timeoutMs === undefined ? 30_000 : value.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new RangeError("timeoutMs must be an integer from 100 to 120000.");
  const rationale = text(value.rationale, "rationale", 2_000);
  return { request: { command, cwd, timeoutMs, rationale }, runtimeMustRevalidatePermissions: true, executionPerformed: false, shellPolicyBypassed: false };
};

/** Validates a proposed workspace operation; file access remains with WorkspaceRuntime. */
export const fileWorkspaceOperator = (input: unknown) => {
  const value = obj(input);
  const operation = text(value.operation, "operation", 50);
  if (!["read", "list", "search", "write", "patch", "delete"].includes(operation)) throw new TypeError("Unsupported workspace operation.");
  const relativePath = text(value.relativePath, "relativePath", 2_000);
  const parts = relativePath.replace(/\\/g, "/").split("/");
  const traversal = relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath) || parts.some(part => part === ".." || [".git", "node_modules", ".env"].includes(part.toLowerCase()));
  const writeLike = ["write", "patch", "delete"].includes(operation);
  return { operation, relativePath, pathRejected: traversal, requiresApproval: writeLike, delegatedToWorkspaceRuntime: !traversal, filesystemAccessPerformed: false };
};

/** Plans an API connector call using only an explicit registered-connector list. */
export const apiConnectorOrchestrator = (input: unknown) => {
  const value = obj(input);
  const purpose = text(value.purpose, "purpose", 2_000);
  const connectorId = text(value.connectorId, "connectorId", 200);
  const registeredIds = texts(value.registeredConnectorIds, "registeredConnectorIds", 200);
  const operation = text(value.operation, "operation", 200);
  const isRegistered = registeredIds.includes(connectorId);
  const approvalRequired = bool(value.approvalRequired, "approvalRequired");
  return { purpose, connectorId, operation, isRegistered, decision: isRegistered ? "eligible-for-connector-policy-check" : "deny-unregistered-connector", approvalRequired, networkRequestSent: false };
};

/** Summarizes supplied documentation text and extracts headings; does not fetch URLs. */
export const technicalDocumentationReader = (input: unknown) => {
  const value = obj(input);
  const documentId = text(value.documentId, "documentId", 300);
  const content = text(value.content, "content", 100_000);
  const headings = content.split(/\r?\n/).filter(line => /^#{1,6}\s+/.test(line)).map(line => line.replace(/^#{1,6}\s+/, "").trim()).slice(0, 200);
  const sentences = content.split(/(?<=[.!?])\s+/).map(line => line.trim()).filter(Boolean);
  const summary = sentences.slice(0, 8).join(" ").slice(0, 4_000);
  return { documentId, headings, summary: redactSecrets(summary), sourceFetched: false, claimsVerified: false };
};

/** Compares only supplied competitor/feature observations and labels missing evidence. */
export const marketGapAnalyst = (input: unknown) => {
  const value = obj(input);
  const competitors = list(value.competitors, "competitors", 100).map((item, index) => ({ id: text(item.id, "competitors[" + index + "].id", 200), features: texts(item.features, "features", 200), evidenceIds: texts(item.evidenceIds ?? [], "evidenceIds", 100) }));
  const desiredFeatures = texts(value.desiredFeatures, "desiredFeatures", 200);
  const gaps = desiredFeatures.map(feature => ({ feature, observedCompetitors: competitors.filter(c => c.features.includes(feature)).map(c => c.id), evidenceMissingFor: competitors.filter(c => c.features.includes(feature) && c.evidenceIds.length === 0).map(c => c.id) }));
  return { gaps, sourceCount: competitors.length, marketResearchPerformed: false, claimsExternallyVerified: false };
};

/** Selects a suggested route from supplied cost/latency/capability data; does not change model routing. */
export const modelRouterOptimizer = (input: unknown) => {
  const value = obj(input);
  const taskType = text(value.taskType, "taskType", 200);
  const candidates = list(value.candidates, "candidates", 100).map((item, index) => {
    const id = text(item.id, "candidates[" + index + "].id", 200);
    const capabilities = texts(item.capabilities, "capabilities", 100);
    const cost = item.cost;
    const latencyMs = item.latencyMs;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs < 0) throw new TypeError("candidate cost and latency must be non-negative numbers.");
    const available = bool(item.available, "available");
    return { id, capabilities, cost, latencyMs, available, eligible: available && capabilities.includes(taskType) };
  }).filter(item => item.eligible).sort((a, b) => a.cost - b.cost || a.latencyMs - b.latencyMs || a.id.localeCompare(b.id));
  return { taskType, recommendation: candidates[0]?.id ?? null, rankedCandidates: candidates, routingChanged: false, costUnits: "caller-defined" };
};

const HANDLERS: ReadonlyArray<{ id: string; handler: AdvancedSkillHandler }> = [
  { id: "coding.05", handler: patchGenerator },
  { id: "coding.07", handler: pythonSpecialist },
  { id: "coding.08", handler: apiContractDesigner },
  { id: "coding.10", handler: codeReviewAuditor },
  { id: "testing.02", handler: unitTestGenerator },
  { id: "security.09", handler: auditTrailWriter },
  { id: "tools.01", handler: toolDiscoveryRouter },
  { id: "tools.06", handler: terminalTaskRunner },
  { id: "tools.07", handler: fileWorkspaceOperator },
  { id: "tools.09", handler: apiConnectorOrchestrator },
  { id: "research.07", handler: technicalDocumentationReader },
  { id: "research.09", handler: marketGapAnalyst },
  { id: "evolution.05", handler: modelRouterOptimizer },
];
export function registerVerifiedRemainingDomainSkills(registry: AdvancedSkillRegistry): string[] {
  const registered: string[] = [];
  for (const item of HANDLERS) {
    const definition = getAdvancedSkill(item.id);
    if (!definition || definition.status !== "verified") continue;
    registry.register(definition, item.handler);
    registered.push(item.id);
  }
  return registered;
}
