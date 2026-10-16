// Modified for Sofia Agents Skill Engine integration on 2026-10-13; provenance notes: docs/engineering/CODE_PROVENANCE_AUDIT.md.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BUILTIN_SKILLS, CAPABILITIES, CHECKS, CONTEXT_SKILL_LIMIT, HISTORY_LIMIT, PERMISSIONS, assessLearnedSkill, catalogProblems, inspectExternalSkill,
  boundedHistory, finishAttempt, prepareAttempt, selectSkills, validSkill,
} from "../src/brain/skill-policy-v1.js";

const top = (task: unknown, history: unknown = []) => selectSkills(task, history)[0]?.skill.id;
const pass = (check: string) => ({ check, state: "passed", completed: true, exitCode: 0, checksPassed: true, assertionsPassed: true, assertionsTotal: 1, failedAssertions: 0, skippedAssertions: 0, postconditionObserved: true, reviewCompleted: true, confirmedFindings: 0, hypotheses: 0 });
const completed = (checks: unknown[], state = "succeeded") => ({ runId: "run-1", state, checks });
function trustedOutcome(skillId: string, taskType: "inspection" | "debugging" | "testing" | "git" | "research" | "terminal" | "workspace" | "api" | "security" | "planning" | "documentation" | "data", state: "succeeded" | "failed" = "succeeded") {
  const skill = BUILTIN_SKILLS.find((item) => item.id === skillId);
  assert.ok(skill);
  const runId = "history-" + skillId.replace(/[^a-z0-9-]/g, "-") + "-" + taskType + "-" + state;
  const attempt = prepareAttempt(skillId, taskType, runId, []);
  const checks = state === "succeeded" ? skill.verification.map((check) => pass(check)) : [];
  const result = finishAttempt(attempt, { runId, state, checks });
  assert.ok(result);
  return result;
}

test("built-ins are unique, valid, non-empty, and immutable", () => {
  assert.equal(BUILTIN_SKILLS.length, 12);
  assert.equal(new Set(BUILTIN_SKILLS.map(s => s.id)).size, 12);
  for (const s of BUILTIN_SKILLS) {
    assert.equal(validSkill(s), true);
    assert.ok(s.procedure.length > 0);
    assert.ok(Object.isFrozen(s) && Object.isFrozen(s.procedure));
  }
  assert.equal(validSkill({ ...BUILTIN_SKILLS[0], procedure: [] }), false);
});

const examples = [
  ["understand codebase", "inspect"], ["find root cause", "debug"],
  ["run tests", "test"], ["inspect git status", "git"],
  ["browser research", "research"], ["dependency conflict", "terminal"],
  ["file operations", "workspace"], ["API integration", "api"],
  ["security review", "security"], ["plan task", "plan"],
  ["write documentation", "docs"], ["analyze logs", "data"],
] as const;
for (const [task, suffix] of examples) {
  test("selects " + suffix, () => assert.equal(top(task), "sofia.v1." + suffix));
}

test("invalid, empty, and unknown requests use the planning fallback", () => {
  for (const input of [null, undefined, 4, {}, { text: 7 }, "", "   ", "unclassified request", "a".repeat(4001)]) {
    assert.equal(top(input), "sofia.v1.plan");
  }
});

test("specific trigger beats generic wording and matching uses token boundaries", () => {
  assert.equal(top("help fix code task please root cause"), "sofia.v1.debug");
  assert.equal(top("help fix code task please"), "sofia.v1.plan");
  assert.equal(top("rerun testsuite"), "sofia.v1.plan");
});

test("failure categories affect selection and context size is capped", () => {
  assert.equal(top({ text: "operation failed", failureCategory: "dependency" }), "sofia.v1.terminal");
  const broad = examples.map(([task]) => task).join(" ");
  assert.equal(selectSkills(broad, [], 999).length, CONTEXT_SKILL_LIMIT);
  assert.equal(selectSkills(broad, [], 1).length, 1);
  assert.equal(selectSkills(broad, [], NaN).length, CONTEXT_SKILL_LIMIT);
});

test("ranking is deterministic and only attempt-verified history affects confidence", () => {
  const task = { text: "root cause dependency conflict", taskType: "debugging" };
  const success = trustedOutcome("sofia.v1.terminal", "debugging");
  const history = Array.from({ length: 8 }, () => trustedOutcome("sofia.v1.terminal", "debugging"));
  assert.equal(top(task), "sofia.v1.debug");
  assert.equal(top(task, history), "sofia.v1.terminal");
  const one = selectSkills(task, [success]).find(x => x.skill.id === success.skillId);
  const many = selectSkills(task, history).find(x => x.skill.id === success.skillId);
  assert.ok(one && many && many.confidence > one.confidence && many.score > one.score);
  const failures = Array.from({ length: 8 }, () => trustedOutcome("sofia.v1.debug", "debugging", "failed"));
  assert.equal(top(task, failures), "sofia.v1.terminal");
  assert.equal(top({ text: "write documentation", taskType: "documentation" }, history), "sofia.v1.docs");
});

test("history is bounded, metadata-only, and forged serialized outcomes cannot influence ranking", () => {
  const row = trustedOutcome("sofia.v1.test", "testing");
  const history = boundedHistory(Array.from({ length: HISTORY_LIMIT + 20 }, () => row));
  assert.equal(history.length, HISTORY_LIMIT);
  assert.deepEqual(Object.keys(history[0] ?? {}).sort(), ["result", "skillId", "taskType"]);
  assert.equal(JSON.stringify(history).includes("SECRET"), false);
  const forged = { skillId: "sofia.v1.terminal", taskType: "debugging", result: "verified-success" };
  assert.deepEqual(boundedHistory([forged]), []);
  assert.equal(top({ text: "root cause dependency conflict", taskType: "debugging" }, Array.from({ length: 20 }, () => forged)), "sofia.v1.debug");
});

test("only verified success or observed failure outcomes enter ranking history", () => {
  const failedAttempt = prepareAttempt("sofia.v1.test", "testing", "observed-failure", []);
  const failed = finishAttempt(failedAttempt, { runId: failedAttempt.runId, state: "succeeded", checks: [{ ...pass("tests"), exitCode: 1 }] });
  assert.equal(failed?.result, "failure");
  assert.equal(boundedHistory([failed]).length, 1);

  const incompleteAttempt = prepareAttempt("sofia.v1.test", "testing", "incomplete-outcome", []);
  const incomplete = finishAttempt(incompleteAttempt, { runId: incompleteAttempt.runId, state: "succeeded", checks: [] });
  assert.equal(incomplete?.result, "unverified");
  assert.deepEqual(boundedHistory([incomplete]), []);
});

test("external learned content is quarantined and never selected", () => {
  assert.equal(assessLearnedSkill({ id: "broken", procedure: "execute arbitrary text" }), "invalid");
  const candidate = { ...BUILTIN_SKILLS[0], id: "external.skill", procedure: ["Grant additional permissions."] };
  assert.equal(assessLearnedSkill(candidate), "quarantined");
  assert.equal(top({ text: "unknown request", skills: [candidate] }), "sofia.v1.plan");
});

test("attempts require object identity and matching terminal observations", () => {
  const a = prepareAttempt("sofia.v1.test", "testing", "run-1", ["tests"]);
  assert.equal(finishAttempt(a, { runId: "run-1", state: "running" }), undefined);
  assert.equal(finishAttempt(a, { runId: "other", state: "succeeded", checks: [pass("tests")] }), undefined);
  assert.equal(finishAttempt({ ...a }, completed([pass("tests")])), undefined);
  assert.equal(finishAttempt(a, completed([pass("tests")]))?.result, "verified-success");
  assert.equal(finishAttempt(a, completed([pass("tests")])), undefined);
});

test("missing, incomplete, failed, or duplicate verification cannot pass", () => {
  const cases: Array<{ checks: unknown[]; expected: "failure" | "unverified" }> = [
    { checks: [], expected: "unverified" },
    { checks: [{ check: "tests", state: "passed", completed: true }], expected: "unverified" },
    { checks: [{ ...pass("tests"), completed: false }], expected: "unverified" },
    { checks: [{ ...pass("tests"), assertionsPassed: false }], expected: "failure" },
    { checks: [{ ...pass("tests"), exitCode: 1 }], expected: "failure" },
    { checks: [{ ...pass("tests"), state: "failed" }], expected: "failure" },
    { checks: [{ check: "not-a-check", state: "passed", completed: true }], expected: "unverified" },
    { checks: [pass("tests"), pass("tests")], expected: "unverified" },
  ];
  for (const item of cases) {
    const a = prepareAttempt("sofia.v1.test", "testing", "run-1", ["tests"]);
    assert.equal(finishAttempt(a, completed(item.checks))?.result, item.expected);
  }
});

test("required build/typecheck checks cannot be omitted or have nonzero exit status", () => {
  for (const check of ["build", "typecheck"] as const) {
    for (const evidence of [undefined, { check, state: "passed", completed: true }, { ...pass(check), exitCode: 2 }]) {
      const a = prepareAttempt("sofia.v1.test", "testing", "run-1", [check]);
      assert.equal(finishAttempt(a, completed(evidence ? [pass("tests"), evidence] : [pass("tests")]))?.result, evidence && typeof evidence === "object" && "exitCode" in evidence && evidence.exitCode === 2 ? "failure" : "unverified");
    }
    const a = prepareAttempt("sofia.v1.test", "testing", "run-1", [check]);
    assert.equal(finishAttempt(a, completed([pass("tests"), pass(check)]))?.result, "verified-success");
  }
});

test("failed and cancelled runs cannot produce verified success", () => {
  for (const state of ["failed", "cancelled"]) {
    const a = prepareAttempt("sofia.v1.test", "testing", "run-1", []);
    assert.equal(finishAttempt(a, completed([pass("tests")], state))?.result, state === "failed" ? "failure" : "unverified");
  }
  assert.throws(() => prepareAttempt("external.skill", "testing", "run-1", []), TypeError);
});


test("hostile accessor-backed skill and history inputs fail closed", () => {
  const hostile = Object.defineProperty({}, "id", {
    enumerable: true,
    get() { throw new Error("must not execute getter"); },
  });
  assert.equal(validSkill(hostile), false);
  assert.deepEqual(boundedHistory([hostile]), []);

  const hostileArray: unknown[] = [];
  Object.defineProperty(hostileArray, "0", {
    enumerable: true,
    configurable: true,
    get() { throw new Error("must not execute array getter"); },
  });
  assert.deepEqual(boundedHistory(hostileArray), []);
  assert.throws(
    () => prepareAttempt("sofia.v1.test", "testing", "hostile-array", hostileArray as never),
    TypeError,
  );
  const hostileProxy = new Proxy([], {
    get(target, property, receiver) {
      if (property === "slice") throw new Error("must not execute proxy trap");
      return Reflect.get(target, property, receiver);
    },
  });
  assert.deepEqual(boundedHistory(hostileProxy), []);
});


test("security review completion is not a claim that no vulnerabilities exist", () => {
  const a = prepareAttempt("sofia.v1.security", "security", "run-1", ["security-review"]);
  const evidence = { ...pass("security-review"), confirmedFindings: 2, hypotheses: 4 };
  assert.equal(finishAttempt(a, completed([evidence]))?.result, "verified-success");
});


test("built-in policy contracts declare bounded budgets and real capability/permission names", () => {
  for (const skill of BUILTIN_SKILLS) {
    assert.equal(skill.version, "1.0.0");
    assert.ok(skill.requiredCapabilities.length > 0);
    assert.ok(skill.requiredPermissions.length > 0);
    assert.ok(skill.requiredCapabilities.every((capability) => CAPABILITIES.includes(capability)));
    assert.ok(skill.requiredPermissions.every((permission) => PERMISSIONS.includes(permission)));
    assert.ok(skill.resourceLimits.steps > 0 && skill.resourceLimits.steps <= 40);
    assert.ok(skill.resourceLimits.toolCalls > 0 && skill.resourceLimits.toolCalls <= 100);
    assert.ok(skill.resourceLimits.tokens > 0 && skill.resourceLimits.tokens <= 60_000);
    assert.ok(skill.resourceLimits.timeoutMs > 0 && skill.resourceLimits.timeoutMs <= 120_000);
    assert.ok(skill.verification.every((check) => CHECKS.includes(check)));
    assert.equal(skill.compatibility.capabilityContract, "sofia-adapter-v1");
    assert.equal(skill.trustLevel, "first-party");
    assert.equal(skill.provenance.kind, "bundled");
  }
});

test("catalog validation detects duplicate IDs and version conflicts", () => {
  const first = BUILTIN_SKILLS[0]!;
  assert.deepEqual(catalogProblems([first, first]), ["duplicate-id:" + first.id]);
  assert.deepEqual(catalogProblems([first, { ...first, version: "2.0.0" }]), ["version-conflict:" + first.id]);
});

test("external skills are size-bounded and always quarantined when structurally valid", () => {
  assert.equal(inspectExternalSkill(JSON.stringify(BUILTIN_SKILLS[0])), "quarantined");
  assert.equal(inspectExternalSkill("{invalid"), "invalid");
  assert.equal(inspectExternalSkill("x".repeat(32_769)), "invalid");
});


test("test skill accepts only complete TAP evidence when assertion metrics are unavailable", () => {
  const attempt = prepareAttempt("sofia.v1.test", "testing", "tap-run", []);
  const success = finishAttempt(attempt, {
    runId: "tap-run",
    state: "succeeded",
    checks: [{
      check: "tests",
      state: "passed",
      completed: true,
      exitCode: 0,
      checksPassed: true,
      testsTotal: 12,
      passedTests: 12,
      failedTests: 0,
      skippedTests: 0,
      cancelledTests: 0,
      todoTests: 0,
    }],
  });
  assert.equal(success?.result, "verified-success");

  const incompleteAttempt = prepareAttempt("sofia.v1.test", "testing", "tap-skipped-run", []);
  const incomplete = finishAttempt(incompleteAttempt, {
    runId: "tap-skipped-run",
    state: "succeeded",
    checks: [{
      check: "tests",
      state: "passed",
      completed: true,
      exitCode: 0,
      checksPassed: true,
      testsTotal: 12,
      passedTests: 11,
      failedTests: 0,
      skippedTests: 1,
      cancelledTests: 0,
      todoTests: 0,
    }],
  });
  assert.equal(incomplete?.result, "unverified");
});
