import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Sandbox, SandboxLimits } from "../src/sandbox.js";
import { createIsolatedSkillVerifier, getExecutableArtifactDigest } from "../src/skills/isolated-verifier.js";
import { getSkillCandidateDigest } from "../src/brain/skill-lifecycle.js";
import type { SkillPackage } from "../src/skills/platform.js";

function candidate(): SkillPackage {
  return {
    source: "learned",
    version: "1.0.0",
    skill: {
      id: "test-skill", name: "Test skill", description: "Executable fixture",
      triggers: ["test"], categories: ["runtime_error"], strategy: "inspect-evidence",
      procedure: ["inspect", "verify"], verification: ["test"],
    },
    artifact: {
      format: "sofia-node-skill-v1",
      runtime: "node",
      entrypoint: "index.js",
      files: {
        "index.js": "export function run() { return 42; }",
        "index.test.js": 'import test from "node:test"; import assert from "node:assert/strict"; import { run } from "./index.js"; test("run returns 42", () => assert.equal(run(), 42));',
      },
      tests: ["index.test.js"],
    },
  };
}

function fakeSandbox(run: Sandbox["run"], isolation: Sandbox["isolation"] = "container"): Sandbox {
  return { isolation, run };
}

test("isolated skill verifier executes syntax and tests with networking disabled", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sofia-verifier-test-"));
  const calls: Array<{ command: string; args: string[]; limits: SandboxLimits }> = [];
  try {
    const sandbox = fakeSandbox(async (command, args, limits) => {
      calls.push({ command, args, limits });
      return { stdout: "ok", stderr: "", code: 0 };
    });
    const verifier = createIsolatedSkillVerifier({ sandbox, workspaceParent: parent });
    const pkg = candidate();
    const result = await verifier(pkg);
    assert.equal(result.passed, true);
    assert.equal(result.isolated, true);
    assert.equal(result.candidateDigest, getSkillCandidateDigest(pkg));
    assert.equal(getExecutableArtifactDigest(pkg.artifact!), getExecutableArtifactDigest(pkg.artifact!));
    assert.deepEqual(calls.map((call) => [call.command, ...call.args]), [
      ["node", "--check", "index.js"],
      ["node", "--test", "index.test.js"],
    ]);
    assert.ok(calls.every((call) => call.limits.allowNetwork === false));
    assert.ok(calls.every((call) => call.limits.workspaceRoot.startsWith(parent)));
    assert.equal((await readdir(parent)).length, 0, "temporary workspace is removed after verification");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("isolated skill verifier stops after a failed check", async () => {
  let calls = 0;
  const verifier = createIsolatedSkillVerifier({
    sandbox: fakeSandbox(async () => {
      calls += 1;
      return { stdout: "", stderr: "syntax error", code: 1 };
    }),
  });
  const result = await verifier(candidate());
  assert.equal(result.passed, false);
  assert.equal(calls, 1);
  assert.deepEqual(result.executedChecks.map((check) => check.name), ["syntax"]);
});

test("isolated skill verifier rejects path traversal before executing", async () => {
  let calls = 0;
  const verifier = createIsolatedSkillVerifier({
    sandbox: fakeSandbox(async () => {
      calls += 1;
      return { stdout: "", stderr: "", code: 0 };
    }),
  });
  const pkg = candidate();
  pkg.artifact!.files["../escape.js"] = "export {};";
  await assert.rejects(() => verifier(pkg), /Invalid|invalid|path/i);
  assert.equal(calls, 0);
});

test("isolated skill verifier refuses non-container sandbox implementations", () => {
  assert.throws(
    () => createIsolatedSkillVerifier({
      sandbox: fakeSandbox(async () => ({ stdout: "", stderr: "", code: 0 }), "process"),
    }),
    /container-enforcing sandbox/,
  );
});
