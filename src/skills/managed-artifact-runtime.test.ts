import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Sandbox } from "../sandbox.js";
import { AdvancedSkillRegistry } from "./advanced-skill-runtime.js";
import { registerActiveSkillArtifacts } from "./managed-artifact-runtime.js";
import type { SkillPackage } from "./platform.js";

const packageFixture: SkillPackage = {
  source: "learned",
  version: "1.0.0",
  skill: {
    id: "learned:sample:runtime_error",
    name: "Sample learned skill",
    description: "A verified sample",
    triggers: ["sample"],
    categories: ["runtime_error"],
    strategy: "fix-implementation",
    procedure: ["Inspect input", "Return a result"],
    verification: ["test"],
  },
  artifact: {
    format: "sofia-node-skill-v1",
    runtime: "node",
    entrypoint: "index.mjs",
    files: { "index.mjs": "export async function run(input, context) { return { input, runId: context.runId }; }" },
  },
};

async function withWorkspace(run: (workspace: string) => Promise<void>) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "sofia-managed-skill-test-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("only promoted learned artifacts are registered as approval-gated container skills", async () => {
  await withWorkspace(async (workspace) => {
    const calls: Array<{ command: string; args: string[]; limits: { allowNetwork: boolean; readOnlyWorkspace?: boolean } }> = [];
    const sandbox: Sandbox = {
      isolation: "container",
      async run(command, args, limits) {
        calls.push({ command, args, limits });
        return { stdout: '{"result":{"ok":true}}\n', stderr: "", code: 0 };
      },
    };
    const registry = new AdvancedSkillRegistry((request) =>
      request.skillId === packageFixture.skill.id &&
      request.principalId === "owner" &&
      request.runId === "run-1" &&
      request.actionHash === "bound-action",
    );

    const mounted = registerActiveSkillArtifacts(registry, [packageFixture], sandbox, workspace);

    assert.deepEqual(mounted, [packageFixture.skill.id]);
    assert.equal(registry.list()[0]?.risk, "privileged");
    assert.equal(registry.list()[0]?.requiresApproval, true);
    const output = await registry.execute(packageFixture.skill.id, { task: "inspect" }, {
      principalId: "owner",
      signal: new AbortController().signal,
      approval: {
        requestId: "approval-1",
        runId: "run-1",
        principalId: "owner",
        toolName: `skill.${packageFixture.skill.id}`,
        actionHash: "bound-action",
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, "node");
    assert.equal(calls[0]?.limits.allowNetwork, false);
    assert.equal(calls[0]?.limits.readOnlyWorkspace, true);
    assert.ok(calls[0]?.args.includes("--eval"));
    assert.deepEqual(output, {
      stdout: '{"result":{"ok":true}}\n',
      stderr: "",
      exitCode: 0,
      outputIsUntrusted: true,
    });
  });
});

test("learned artifact mounting rejects non-container sandboxes", () => {
  const sandbox: Sandbox = {
    isolation: "process",
    async run() { return { stdout: "", stderr: "", code: 0 }; },
  };
  const registry = new AdvancedSkillRegistry();
  assert.throws(
    () => registerActiveSkillArtifacts(registry, [packageFixture], sandbox),
    /container-enforcing sandbox/,
  );
  assert.equal(registry.list().length, 0);
});

test("learned artifact execution fails closed without action-bound approval", async () => {
  await withWorkspace(async (workspace) => {
    let invoked = false;
    const sandbox: Sandbox = {
      isolation: "container",
      async run() {
        invoked = true;
        return { stdout: "", stderr: "", code: 0 };
      },
    };
    const registry = new AdvancedSkillRegistry(() => false);
    registerActiveSkillArtifacts(registry, [packageFixture], sandbox, workspace);

    await assert.rejects(
      registry.execute(packageFixture.skill.id, {}, {
        principalId: "owner",
        signal: new AbortController().signal,
      }),
      { code: "APPROVAL_REQUIRED" },
    );
    assert.equal(invoked, false);
  });
});
