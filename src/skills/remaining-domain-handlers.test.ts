import test from "node:test";
import assert from "node:assert/strict";
import {
  patchGenerator, pythonSpecialist, apiContractDesigner, codeReviewAuditor, unitTestGenerator,
  auditTrailWriter, toolDiscoveryRouter, terminalTaskRunner, fileWorkspaceOperator,
  apiConnectorOrchestrator, technicalDocumentationReader, marketGapAnalyst, modelRouterOptimizer,
  registerVerifiedRemainingDomainSkills,
} from "./remaining-domain-handlers.js";
import { AdvancedSkillRegistry } from "./advanced-skill-runtime.js";

test("patch proposal is redacted and never applied", () => {
  const result = patchGenerator({ objective: "fix bug", patch: "diff --git a/a b/a", touchedPaths: ["src/a.ts"] }) as any;
  assert.equal(result.applied, false);
  assert.equal(result.eligibleForReview, true);
  const traversal = patchGenerator({ objective: "bad path", patch: "diff", touchedPaths: ["../outside.ts"] }) as any;
  assert.equal(traversal.eligibleForReview, false);
});
test("Python review and API contracts are planning-only", () => {
  assert.equal((pythonSpecialist({ goal: "review", files: ["app.py", "index.ts"], constraints: [] }) as any).pythonFiles.length, 1);
  assert.equal((apiContractDesigner({ service: "api", endpoints: [{ id: "health", method: "GET", path: "/health" }] }) as any).routeCreated, false);
});
test("code review and unit test planning require evidence and do not execute", () => {
  assert.equal((codeReviewAuditor({ findings: [{ id: "f1", severity: "high", description: "issue", inScope: true }] }) as any).blockerIds.length, 1);
  assert.equal((unitTestGenerator({ target: "sum", behaviors: ["adds two values"], edgeCases: ["empty input"] }) as any).testsExecuted, false);
});
test("audit event candidate is redacted and not persisted", () => {
  const result = auditTrailWriter({ eventType: "tool.finished", actorId: "u1", actionId: "a1", outcome: "denied", reason: "policy" }) as any;
  assert.equal(result.persisted, false);
  assert.equal(result.eventHash.length, 64);
});
test("tool routing and terminal requests remain inside runtime enforcement", () => {
  assert.equal((toolDiscoveryRouter({ goal: "read", requiredCapabilities: ["read"], registeredTools: [{ id: "fs", capabilities: ["read"], available: true }] }) as any).rankedTools[0].id, "fs");
  const terminal = terminalTaskRunner({ command: "npm test", cwd: ".", rationale: "verify", timeoutMs: 1000 }) as any;
  assert.equal(terminal.executionPerformed, false);
  assert.equal(terminal.runtimeMustRevalidatePermissions, true);
});
test("workspace operator rejects traversal and connector orchestrator rejects unknown connector", () => {
  assert.equal((fileWorkspaceOperator({ operation: "write", relativePath: "../secret" }) as any).pathRejected, true);
  assert.equal((apiConnectorOrchestrator({ purpose: "read", connectorId: "mail", registeredConnectorIds: [], operation: "list", approvalRequired: true }) as any).decision, "deny-unregistered-connector");
});
test("documentation and market analysis do not claim external verification", () => {
  assert.equal((technicalDocumentationReader({ documentId: "d1", content: "# Intro\nText. More." }) as any).sourceFetched, false);
  assert.equal((marketGapAnalyst({ competitors: [{ id: "c1", features: ["chat"], evidenceIds: [] }], desiredFeatures: ["chat", "agents"] }) as any).marketResearchPerformed, false);
});
test("model route suggestion never changes production routing", () => {
  const result = modelRouterOptimizer({ taskType: "code", candidates: [{ id: "cheap", capabilities: ["code"], cost: 1, latencyMs: 50, available: true }, { id: "wrong", capabilities: ["chat"], cost: 0, latencyMs: 10, available: true }] }) as any;
  assert.equal(result.recommendation, "cheap");
  assert.equal(result.routingChanged, false);
});
test("new remaining-domain handlers remain unavailable until verified", () => {
  assert.deepEqual(registerVerifiedRemainingDomainSkills(new AdvancedSkillRegistry()), []);
});
