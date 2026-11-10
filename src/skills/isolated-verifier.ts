import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Sandbox } from "../sandbox.js";
import type { SkillExecutableArtifact, SkillPackage } from "./platform.js";

export interface IsolatedSkillVerificationOptions {
  sandbox: Sandbox;
  workspaceParent?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Trusted tests are supplied by Sofia policy, never by the candidate artifact. */
  getTrustedTestSuite: (candidate: SkillPackage) => TrustedSkillTestSuite | undefined;
}

export interface TrustedSkillTestSuite {
  id: string;
  version: string;
  files: Record<string, string>;
  tests: string[];
}

export interface IsolatedSkillVerificationResult {
  passed: boolean;
  candidateDigest: string;
  runnerId: string;
  isolatedWorkspaceId: string;
  isolated: true;
  executedChecks: Array<{ name: string; passed: boolean; exitCode: number }>;
  completedAt: string;
  testSuiteId: string;
  testSuiteVersion: string;
  testSuiteDigest: string;
  output: Array<{ check: string; stdout: string; stderr: string }>;
}

const MAX_FILES = 128;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function safeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) return false;
  const segments = value.split("/");
  return !path.posix.isAbsolute(value) &&
    segments.every((part) => part !== "." && part !== ".." && SAFE_SEGMENT.test(part)) &&
    !segments.some((part) => ["node_modules", ".git", "__sofia_trusted_tests__"].includes(part.toLowerCase()));
}

function validateArtifact(value: unknown): asserts value is SkillExecutableArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Executable skill artifact is required.");
  const artifact = value as Record<string, unknown>;
  if (artifact.format !== "sofia-node-skill-v1" || artifact.runtime !== "node" ||
      !safeRelativePath(artifact.entrypoint) || !artifact.entrypoint.endsWith(".mjs") || !artifact.files || typeof artifact.files !== "object" ||
      Array.isArray(artifact.files)) {
    throw new Error("Invalid executable skill artifact manifest.");
  }
  const files = artifact.files as Record<string, unknown>;
  const entries = Object.entries(files);
  if (entries.length === 0 || entries.length > MAX_FILES || !Object.hasOwn(files, artifact.entrypoint)) {
    throw new Error("Artifact files must include the entrypoint and stay within file-count limits.");
  }
  let total = 0;
  for (const [name, contents] of entries) {
    if (!safeRelativePath(name) || typeof contents !== "string") throw new Error("Artifact contains an invalid file path or content.");
    const bytes = Buffer.byteLength(contents, "utf8");
    if (bytes > MAX_FILE_BYTES) throw new Error("Artifact file exceeds the per-file size limit.");
    total += bytes;
  }
  if (total > MAX_TOTAL_BYTES) throw new Error("Artifact exceeds the total size limit.");
}

export function getExecutableArtifactDigest(artifact: SkillExecutableArtifact): string {
  validateArtifact(artifact);
  const files = Object.fromEntries(Object.entries(artifact.files).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify({
    format: artifact.format,
    runtime: artifact.runtime,
    entrypoint: artifact.entrypoint,
    files,
  })).digest("hex");
}

/**
 * Executes a declared JavaScript skill artifact only in a real container sandbox.
 * The artifact is copied to a fresh temporary workspace, with no dependency
 * installation, no inherited project files, and network disabled.
 */
export function createIsolatedSkillVerifier(options: IsolatedSkillVerificationOptions) {
  if (options.sandbox.isolation !== "container") {
    throw new Error("Skill verification requires a container-enforcing sandbox.");
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 1024 * 1024) {
    throw new Error("Skill verification resource limits are invalid.");
  }

  return async (candidate: SkillPackage, signal?: AbortSignal): Promise<IsolatedSkillVerificationResult> => {
    const artifact: unknown = candidate.artifact;
    validateArtifact(artifact);
    const suite = options.getTrustedTestSuite(candidate);
    if (!suite || typeof suite.id !== "string" || !/^[A-Za-z0-9._:-]{1,120}$/.test(suite.id) ||
        typeof suite.version !== "string" || !suite.version.trim() || suite.version.length > 100 ||
        !suite.files || typeof suite.files !== "object" || Array.isArray(suite.files) ||
        !Array.isArray(suite.tests) || suite.tests.length === 0 || suite.tests.length > 32 ||
        !suite.tests.every((name) => safeRelativePath(name) && Object.hasOwn(suite.files, name)) ||
        new Set(suite.tests).size !== suite.tests.length) {
      throw new Error("No valid trusted verification suite is configured for this skill candidate.");
    }
    const suiteEntries = Object.entries(suite.files);
    if (suiteEntries.length === 0 || suiteEntries.length > 64 ||
        suiteEntries.some(([name, contents]) => !safeRelativePath(name) || typeof contents !== "string" ||
          Buffer.byteLength(contents, "utf8") > MAX_FILE_BYTES) ||
        suiteEntries.reduce((sum, [, contents]) => sum + Buffer.byteLength(contents, "utf8"), 0) > MAX_TOTAL_BYTES) {
      throw new Error("Trusted verification suite is invalid or exceeds resource limits.");
    }
    if (suite.tests.some((name) => !/(?:^|\/)test[^/]*\.(?:js|mjs|cjs)$|\.test\.(?:js|mjs|cjs)$/.test(name))) {
      throw new Error("Trusted test paths must be explicit JavaScript test files.");
    }
    const candidateDigest = createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
    const trustedSuiteDigest = createHash("sha256").update(JSON.stringify({
      id: suite.id,
      version: suite.version,
      files: Object.fromEntries(suiteEntries.sort(([a], [b]) => a.localeCompare(b))),
      tests: [...suite.tests].sort(),
    })).digest("hex");
    const workspace = await mkdtemp(path.join(options.workspaceParent ?? os.tmpdir(), "sofia-skill-verify-"));
    const workspaceId = randomUUID();
    const executedChecks: IsolatedSkillVerificationResult["executedChecks"] = [];
    const output: IsolatedSkillVerificationResult["output"] = [];
    try {
      for (const [relative, contents] of Object.entries(artifact.files)) {
        const destination = path.join(workspace, ...relative.split("/"));
        const rel = path.relative(workspace, destination);
        if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Artifact path escaped isolated workspace.");
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, contents, { encoding: "utf8", flag: "wx", mode: 0o400 });
      }
      for (const [relative, contents] of suiteEntries) {
        const destination = path.join(workspace, "__sofia_trusted_tests__", ...relative.split("/"));
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, contents, { encoding: "utf8", flag: "wx", mode: 0o400 });
      }
      const limits = {
        workspaceRoot: workspace,
        timeoutMs,
        maxOutputBytes,
        allowNetwork: false,
        readOnlyWorkspace: true,
      };
      const checks = [
        { name: "syntax", command: "node", args: ["--check", artifact.entrypoint] },
        { name: "test", command: "node", args: ["--test", ...suite.tests.map((name) => path.posix.join("__sofia_trusted_tests__", name))] },
      ];
      for (const check of checks) {
        const result = await options.sandbox.run(check.command, check.args, limits, signal);
        const passed = result.code === 0;
        executedChecks.push({ name: check.name, passed, exitCode: result.code });
        output.push({
          check: check.name,
          stdout: result.stdout.slice(0, 32_000),
          stderr: result.stderr.slice(0, 32_000),
        });
        if (!passed) break;
      }
      return {
        passed: executedChecks.length === checks.length && executedChecks.every((check) => check.passed),
        candidateDigest,
        runnerId: "sofia-isolated-node-skill-v1",
        isolatedWorkspaceId: workspaceId,
        isolated: true,
        executedChecks,
        completedAt: new Date().toISOString(),
        testSuiteId: suite.id,
        testSuiteVersion: suite.version,
        testSuiteDigest: trustedSuiteDigest,
        output,
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  };
}
