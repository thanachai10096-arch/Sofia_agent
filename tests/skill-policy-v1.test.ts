import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BUILTIN_SKILLS, CONTEXT_SKILL_LIMIT, HISTORY_LIMIT, assessLearnedSkill,
  boundedHistory, finishAttempt, prepareAttempt, selectSkills, validSkill,
} from "../src/brain/skill-policy-v1.js";

const top = (task: unknown, history: unknown = []) => selectSkills(task, history)[0]?.skill.id;
const pass = (check: string) => ({ check, state: "passed", completed: true, exitCode: 0, checksPassed: true, assertionsPassed: true, assertionsTotal: 1, failedAssertions: 0, skippedAssertions: 0, postconditionObserved: true, reviewCompleted: true, confirmedFindings: 0, hypotheses: 0 });
const completed = (checks: unknown[], state = "succeeded") => ({ runId: "run-1", state, checks });

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

test("ranking is deterministic and task-specific history affects confidence", () => {
  const task = { text: "root cause dependency conflict", taskType: "debugging" };
  const success = { skillId: "sofia.v1.terminal", taskType: "debugging", result: "verified-success" };
  const history = Array.from({ length: 8 }, () => success);
  assert.equal(top(task), "sofia.v1.debug");
  assert.equal(top(task, history), "sofia.v1.terminal");
  const one = selectSkills(task, [success]).find(x => x.skill.id === success.skillId);
  const many = selectSkills(task, history).find(x => x.skill.id === success.skillId);
  assert.ok(one && many && many.confidence > one.confidence && many.score > one.score);
  const failures = history.map(x => ({ ...x, skillId: "sofia.v1.debug", result: "failure" }));
  assert.equal(top(task, failures), "sofia.v1.terminal");
  assert.equal(top({ text: "write documentation", taskType: "documentation" }, history), "sofia.v1.docs");
});

test("history is bounded, metadata-only, and legacy success is not verified success", () => {
  const row = { skillId: "sofia.v1.test", taskType: "testing", result: "verified-success", rawOutput: "PRIVATE", token: "SECRET" };
  const history = boundedHistory(Array.from({ length: HISTORY_LIMIT + 20 }, () => row));
  assert.equal(history.length, HISTORY_LIMIT);
  assert.deepEqual(Object.keys(history[0] ?? {}).sort(), ["result", "skillId", "taskType"]);
  assert.equal(JSON.stringify(history).includes("SECRET"), false);
  assert.deepEqual(boundedHistory([{ ...row, result: "success" }, { ...row, skillId: "external.skill" }]), []);
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
      assert.equal(finishAttempt(a, completed(evidence ? [pass("tests"), evidence] : [pass("tests")]))?.result, evidence && Number((evidence as { exitCode?: number }).exitCode) === 2 ? "failure" : "unverified");
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
});


test("security review completion is not a claim that no vulnerabilities exist", () => {
  const a = prepareAttempt("sofia.v1.security", "security", "run-1", ["security-review"]);
  const evidence = { ...pass("security-review"), confirmedFindings: 2, hypotheses: 4 };
  assert.equal(finishAttempt(a, completed([evidence]))?.result, "verified-success");
});
