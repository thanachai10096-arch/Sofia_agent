import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SofiaTool } from "../tools/types.js";
import type { SandboxAttestation, SandboxRunIdentity, SandboxSupervisor } from "./sandbox-supervisor.js";

const EXCLUDED = new Set([
  ".git", ".sofia", "node_modules", ".next", ".turbo", "dist", "build",
  "coverage", ".venv", "venv", ".ssh", ".aws", ".config", ".docker", ".kube",
  ".npmrc", ".pypirc", ".netrc", ".git-credentials", ".yarnrc.yml",
]);
const SECRET_FILE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|crt|p12|pfx|sqlite|db)|id_rsa|id_ed25519)$/i;
const MAX_FILES = 10_000;
const MAX_BYTES = 100 * 1024 * 1024;

async function stageSanitizedWorkspace(source: string, destination: string): Promise<Map<string, string>> {
  let count = 0;
  let bytes = 0;
  const baseline = new Map<string, string>();
  const root = path.resolve(source);
  async function visit(current: string, relative: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name) || SECRET_FILE.test(entry.name)) continue;
      const sourcePath = path.join(current, entry.name);
      const relativePath = relative ? path.join(relative, entry.name) : entry.name;
      const targetPath = path.resolve(destination, relativePath);
      const rel = path.relative(destination, targetPath);
      if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
        throw new Error("Sandbox staging path escaped its destination.");
      }
      const info = await lstat(sourcePath);
      // Symlinks and special files are never copied into an execution container.
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) continue;
      if (info.isDirectory()) {
        await mkdir(targetPath, { recursive: true, mode: 0o700 });
        await visit(sourcePath, relativePath);
        continue;
      }
      count += 1;
      bytes += info.size;
      if (count > MAX_FILES || bytes > MAX_BYTES) {
        throw new Error("Sandbox project snapshot exceeds the staging file or size limit.");
      }
      await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
      const sourceHandle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const openedInfo = await sourceHandle.stat();
        if (!openedInfo.isFile()) continue;
        if (openedInfo.size > MAX_BYTES - bytes) throw new Error("Sandbox project snapshot exceeds the staging size limit.");
        const data = await sourceHandle.readFile();
        if (data.length > MAX_BYTES - bytes) throw new Error("Sandbox project snapshot exceeds the staging size limit.");
        baseline.set(relativePath.split(path.sep).join("/"), createHash("sha256").update(data).digest("hex"));
        await writeFile(targetPath, data, { flag: "wx", mode: 0o600 });
      } finally {
        await sourceHandle.close();
      }
    }
  }
  await visit(root, "");
  return baseline;
}

async function collectSandboxChanges(workspace: string, baseline: Map<string, string>): Promise<Array<{ path: string; expectedHash: string; content: string }>> {
  const changes: Array<{ path: string; expectedHash: string; content: string }> = [];
  let totalBytes = 0;
  async function visit(current: string, relative: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name) || SECRET_FILE.test(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      const relativePath = relative ? path.join(relative, entry.name) : entry.name;
      const info = await lstat(fullPath);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) continue;
      if (info.isDirectory()) { await visit(fullPath, relativePath); continue; }
      const normalized = relativePath.split(path.sep).join("/");
      const expectedHash = baseline.get(normalized);
      if (!expectedHash) continue; // New files are not auto-promoted by this first patch workflow.
      const handle = await open(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const openedInfo = await handle.stat();
        if (!openedInfo.isFile()) continue;
        if (openedInfo.size > 10 * 1024 * 1024 - totalBytes) throw new Error("Sandbox change proposal exceeds its size limit.");
        const data = await handle.readFile();
        if (data.length > 10 * 1024 * 1024 - totalBytes) throw new Error("Sandbox change proposal exceeds its size limit.");
        totalBytes += data.length;
        if (totalBytes > 10 * 1024 * 1024 || changes.length >= 100) throw new Error("Sandbox change proposal exceeds its file or size limit.");
        const content = data.toString("utf8");
        if (createHash("sha256").update(data).digest("hex") !== expectedHash) {
          changes.push({ path: normalized, expectedHash, content });
        }
      } finally { await handle.close(); }
    }
  }
  await visit(workspace, "");
  return changes;
}

export interface SandboxToolOptions {
  supervisor: SandboxSupervisor;
  identity: SandboxRunIdentity;
  sourceWorkspace: string;
  networkAllowed: boolean;
  getAttestation(): Promise<SandboxAttestation>;
}

/** A sandbox-only command tool. It cannot execute against the host WorkspaceRuntime. */
export function createSandboxTools(options: SandboxToolOptions): SofiaTool[] {
  let baseline: Map<string, string> | undefined;
  let staging: Promise<void> | undefined;
  const ensureStaged = async () => {
    const attestation = await options.getAttestation();
    const workspace = options.supervisor.getWorkspacePath(options.identity, attestation);
    if (!baseline) {
      staging ??= stageSanitizedWorkspace(options.sourceWorkspace, workspace).then((result) => { baseline = result; });
      await staging;
    }
    return { attestation, workspace, baseline: baseline! };
  };
  const executeTool: SofiaTool = {
    name: "sandbox.exec",
    description: "Run a bounded command in an isolated, disposable copy of the project. Internet access is enabled only when the host sandbox policy allows it. Changes stay in the sandbox and are not applied to the host project.",
    effects: ["sandbox"],
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1 },
        args: { type: "array", items: { type: "string" }, maxItems: 128 },
        cwd: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 300000 },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const { attestation } = await ensureStaged();
      const command = input.command;
      if (typeof command !== "string" || !command.trim()) throw new Error("Sandbox command is required.");
      const args = Array.isArray(input.args) && input.args.every((value) => typeof value === "string")
        ? input.args as string[]
        : [];
      const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : 120000;
      const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
      return options.supervisor.run(
        options.identity,
        attestation,
        command,
        args,
        { timeoutMs, allowNetwork: options.networkAllowed, ...(cwd ? { cwd } : {}) },
        context.signal,
      );
    },
  };
  const proposeTool: SofiaTool = {
    name: "sandbox.propose_changes",
    description: "Compare the isolated project snapshot with its original files and return conflict-checked proposed edits. It never writes to the host workspace; apply proposals only through workspace.apply_patch, which requires the normal human approval flow.",
    effects: ["sandbox"],
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const { workspace, baseline } = await ensureStaged();
      return { operations: await collectSandboxChanges(workspace, baseline), approvalRequiredForApply: true };
    },
  };
  return [executeTool, proposeTool];
}
