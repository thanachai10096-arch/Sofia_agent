import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AdvancedSkillDefinition } from "./advanced-skill-catalog.js";
import type { AdvancedSkillExecutionContext, AdvancedSkillRegistry } from "./advanced-skill-runtime.js";
import { getExecutableArtifactDigest } from "./isolated-verifier.js";
import type { SkillPackage } from "./platform.js";
import type { Sandbox } from "../sandbox.js";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;

/**
 * Mount only lifecycle-active, package-bound verified artifacts into the
 * run-scoped advanced registry. Learned code is always treated as privileged
 * and requires a fresh action-bound approval on every invocation.
 */
export function registerActiveSkillArtifacts(
  registry: AdvancedSkillRegistry,
  packages: readonly SkillPackage[],
  sandbox: Sandbox,
  workspaceParent = os.tmpdir(),
): string[] {
  if (sandbox.isolation !== "container") {
    throw new Error("Learned skill execution requires a container-enforcing sandbox.");
  }
  const registered: string[] = [];
  for (const skillPackage of packages) {
    if (skillPackage.source !== "learned" || !skillPackage.artifact) continue;
    // Revalidate persisted artifacts before any filesystem operation.
    getExecutableArtifactDigest(skillPackage.artifact);
    const skillId = skillPackage.skill.id;
    const definition: AdvancedSkillDefinition = {
      id: skillId,
      name: skillPackage.skill.name,
      category: skillPackage.skill.categories[0] ?? "Learned",
      risk: "privileged",
      status: "verified",
      requiresApproval: true,
      description: skillPackage.skill.description,
    };
    registry.register(definition, async (input, context: AdvancedSkillExecutionContext) => {
      const serializedInput = JSON.stringify(input);
      if (typeof serializedInput !== "string" || Buffer.byteLength(serializedInput, "utf8") > MAX_INPUT_BYTES) {
        throw new Error("Learned skill input must be JSON serializable and stay within 64 KiB.");
      }
      const workspace = await mkdtemp(path.join(workspaceParent, "sofia-skill-run-"));
      try {
        for (const [relative, contents] of Object.entries(skillPackage.artifact!.files)) {
          const destination = path.join(workspace, ...relative.split("/"));
          const relativeToRoot = path.relative(workspace, destination);
          if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
            throw new Error("Learned skill artifact path escaped its isolated workspace.");
          }
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, contents, { encoding: "utf8", flag: "wx", mode: 0o400 });
        }
        const inputFile = `__sofia_runtime_input_${cryptoRandomId()}.json`;
        await writeFile(path.join(workspace, inputFile), serializedInput, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o400,
        });
        const script = [
          'import fs from "node:fs/promises";',
          'import path from "node:path";',
          'import { pathToFileURL } from "node:url";',
          'const entry = await import(pathToFileURL(path.resolve(process.argv[1])).href);',
          'if (typeof entry.run !== "function") throw new Error("Skill entrypoint must export run(input, context)");',
          'const input = JSON.parse(await fs.readFile(process.argv[2], "utf8"));',
          'const result = await entry.run(input, { runId: process.argv[3], principalId: process.argv[4] });',
          'process.stdout.write(JSON.stringify({ result }) + "\\n");',
        ].join("\n");
        const result = await sandbox.run("node", [
          "--input-type=module",
          "--eval",
          script,
          skillPackage.artifact!.entrypoint,
          inputFile,
          context.approval?.runId ?? "unknown",
          context.principalId,
        ], {
          workspaceRoot: workspace,
          timeoutMs: 30_000,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          allowNetwork: false,
          readOnlyWorkspace: true,
        }, context.signal);
        if (result.code !== 0) {
          throw new Error(`Learned skill execution failed (exit ${result.code}): ${result.stderr.slice(0, 2_000)}`);
        }
        // Output remains untrusted tool data; it is never promoted to instructions.
        return {
          stdout: result.stdout.slice(0, MAX_OUTPUT_BYTES),
          stderr: result.stderr.slice(0, MAX_OUTPUT_BYTES),
          exitCode: result.code,
          outputIsUntrusted: true,
        };
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    });
    registered.push(skillId);
  }
  return registered;
}

function cryptoRandomId(): string {
  return randomUUID();
}
