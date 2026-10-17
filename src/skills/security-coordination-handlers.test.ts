import test from "node:test";
import assert from "node:assert/strict";
import {
  secretLeakDetector, commandRiskClassifier, approvalGateManager, securityRegressionTester,
  browserWorkflowPlanner, browserStateVerifier, gitWorkflowOperator, externalActionApproval,
  integrationTestDesigner, endToEndTestPlanner, flakyTestDetector, releaseReadinessAuditor,
  agentMessageValidator, sharedTaskBoard, agentResultReviewer, loopDeadlockDetector,
  humanGoalAlignmentMonitor, workflowTriggerEvaluator, longRunningJobMonitor, slaWatchdog,
  notificationPlanner, failureMemoryCurator, registerVerifiedSecurityCoordinationSkills,
} from "./security-coordination-handlers.js";
import { AdvancedSkillRegistry } from "./advanced-skill-runtime.js";

test("secret detector reports locations without returning secret values", () => {
  const result = secretLeakDetector({ content: "API_KEY=abcdefghijklmno\nnormal text" }) as any;
  assert.equal(result.count, 1);
  assert.equal(result.findings[0].line, 1);
  assert.equal(result.originalContentReturned, false);
});
test("command risk classifier flags destructive commands without executing", () => {
  const result = commandRiskClassifier({ command: "git reset --hard HEAD" }) as any;
  assert.equal(result.risk, "high");
  assert.equal(result.executed, false);
});
test("approval gates fail closed without trusted, action-bound approval", () => {
  assert.equal((approvalGateManager({ actionId: "a", risk: "privileged", approvalGranted: true, approvalVerifierTrusted: false, actionHashMatches: true }) as any).decision, "deny");
  assert.equal((externalActionApproval({ action: "publish", effect: "publish", verifierTrusted: true, approvalBoundToAction: true, approvalPresent: false }) as any).decision, "deny");
});
test("security regression requires evidence for each passing gate", () => {
  const result = securityRegressionTester({ checks: [{ id: "path", passed: true, evidenceId: "test-1" }, { id: "secret", passed: true }] }) as any;
  assert.equal(result.ready, false);
});
test("browser planner creates plans only and verifier compares supplied observations", () => {
  const plan = browserWorkflowPlanner({ goal: "review form", steps: [{ action: "inspect", target: "form" }, { action: "submit", target: "form" }] }) as any;
  assert.equal(plan.executionStarted, false);
  assert.equal(plan.steps[1].requiresApproval, true);
  assert.equal((browserStateVerifier({ expected: ["ready"], observed: ["loading"] }) as any).passed, false);
});
test("Git workflow proposal blocks destructive operations", () => {
  assert.equal((gitWorkflowOperator({ operation: "force-push", branch: "main", dirtyWorkingTree: true }) as any).allowed, false);
});
test("test designers use supplied evidence and do not execute tests", () => {
  const integration = integrationTestDesigner({ components: ["api", "db"], interactions: [{ id: "i1", from: "api", to: "db", expected: "persists" }] }) as any;
  assert.equal(integration.testsExecuted, false);
  assert.equal((endToEndTestPlanner({ criteria: [{ id: "login", given: "user", when: "signs in", then: "dashboard" }] }) as any).scenarioCount, 1);
  assert.equal((flakyTestDetector({ tests: [{ id: "t1", outcomes: ["pass", "fail", "pass"] }] }) as any).flakyCount, 1);
  assert.equal((releaseReadinessAuditor({ gates: [{ id: "build", passed: true, evidenceId: "ci" }] }) as any).ready, true);
});
test("agent validation and result review do not expand authority", () => {
  assert.equal((agentMessageValidator({ messageId: "m", senderId: "a", recipientId: "b", nonce: "n", timestamp: 10, signatureVerified: false, replayDetected: false }) as any).decision, "reject");
  assert.equal((agentResultReviewer({ resultId: "r", criteria: ["correct"], satisfiedCriteria: ["correct"], evidenceIds: ["run"] }) as any).approvalGranted, false);
  assert.equal((humanGoalAlignmentMonitor({ goals: ["fix bug"], proposedAction: "inspect", supportedGoalIds: ["fix bug"], matchesProhibitedAction: false }) as any).executionPerformed, false);
  assert.equal((humanGoalAlignmentMonitor({ goals: ["fix bug", "preserve API"], proposedAction: "rewrite", supportedGoalIds: ["fix bug"], matchesProhibitedAction: false }) as any).aligned, false);
});
test("task board, loop detector, and workflow monitors are read-only", () => {
  assert.equal((sharedTaskBoard({ tasks: [{ id: "a", status: "active" }] }) as any).persisted, false);
  assert.equal((loopDeadlockDetector({ states: ["plan", "run", "plan", "run", "plan"] }) as any).suspectedLoop, true);
  assert.equal((workflowTriggerEvaluator({ eventType: "push", expectedType: "push", requiredFlags: ["approved"], flags: { approved: false } }) as any).workflowStarted, false);
  assert.equal((longRunningJobMonitor({ jobId: "j", startedAt: 10, now: 100, timeoutMs: 50, status: "running" }) as any).timedOut, true);
  assert.equal((slaWatchdog({ taskId: "t", elapsedMs: 200, budgetMs: 100 }) as any).breached, true);
});
test("notifications and failure memories are drafted with redaction and no persistence", () => {
  const notice = notificationPlanner({ event: "failed", audience: ["owner"], channels: ["email"], message: "Token=abcdefghijklmno" }) as any;
  assert.equal(notice.sent, false);
  assert.equal(notice.approvalRequiredForExternalChannels, true);
  assert.equal((failureMemoryCurator({ incidents: [{ id: "i", category: "runtime", summary: "failed", resolution: "fixed", success: true }] }) as any).persisted, false);
});
test("new security and coordination handlers remain unavailable until verified", () => {
  assert.deepEqual(registerVerifiedSecurityCoordinationSkills(new AdvancedSkillRegistry()), []);
});
