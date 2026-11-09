import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Sandbox } from "../sandbox.js";
import { createIsolatedSkillVerifier } from "./isolated-verifier.js";
import type { SkillPackage } from "./platform.js";

const candidate: SkillPackage = {
  skill: {
    id: "learned:example:workflow",
    name: "Example workflow",
    description: "A test skill",
    triggers: ["run example"],
    categories: ["workflow"],
    strategy: "Run the example safely",
    procedure: ["Execute the example"],
    verification: ["test"],
  },
  source: "learned",
  version: "1.0.0",
  artifact: {
    format: "sofia-node-skill-v1",
    runtime: "node",
    entrypoint: "index.mjs",
    files: { "index.mjs": "export async function run(input, context) { return input; }" },
  },
};

function trustedSuite() {
  return {
    id: "example-suite",
    version: "1",
    files: { "test/example.test.mjs": 'import test from "node:test"; test("trusted fixture", () => {});' },
    tests: ["test/example.test.mjs"],
  };
}

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "sofia-skill-verifier-test-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("isolated verifier checks the exported runtime contract before trusted tests", async () => {
  await withWorkspace(async (workspace) => {
    const calls: Array<{ command: string; args: string[]; limits: unknown }> = [];
    const sandbox: Sandbox = {
      isolation: "container",
      async run(command, args, limits) {
        calls.push({ command, args, limits });
        return { stdout: "", stderr: "", code: 0 };
      },
    };
    const verify = createIsolatedSkillVerifier({
      sandbox,
      workspaceParent: workspace,
      getTrustedTestSuite: () => trustedSuite(),
    });

    const result = await verify(candidate);

    assert.equal(result.passed, true);
    assert.deepEqual(result.executedChecks.map((check) => check.name), [
      "syntax",
      "runtime-contract",
      "test",
    ]);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1].args.slice(0, 3), ["--input-type=module", "--eval", calls[1].args[2]]);
    assert.match(calls[1].args[2], /typeof entry\.run !== "function"/);
    assert.equal(calls[1].args[3], "index.mjs");
    assert.equal((calls[0].limits as { allowNetwork: boolean }).allowNetwork, false);
    assert.equal((calls[0].limits as { readOnlyWorkspace: boolean }).readOnlyWorkspace, true);
  });
});

test("isolated verifier fails closed and skips tests when the runtime contract fails", async () => {
  await withWorkspace(async (workspace) => {
    const calls: string[] = [];
    const sandbox: Sandbox = {
      isolation: "container",
      async run(command, args) {
        calls.push(args.includes("--eval") ? "runtime-contract" : args.includes("--check") ? "syntax" : "test");
        return { stdout: "", stderr: "missing run export", code: args.includes("--eval") ? 1 : 0 };
      },
    };
    const verify = createIsolatedSkillVerifier({
      sandbox,
      workspaceParent: workspace,
      getTrustedTestSuite: () => trustedSuite(),
    });

    const result = await verify(candidate);

    assert.equal(result.passed, false);
    assert.deepEqual(calls, ["syntax", "runtime-contract"]);
    assert.deepEqual(result.executedChecks.map((check) => check.name), ["syntax", "runtime-contract"]);
  });
});
