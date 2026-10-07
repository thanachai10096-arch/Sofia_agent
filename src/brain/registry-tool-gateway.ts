import { createHash, randomUUID } from "node:crypto";

import type { ExecutionPolicy } from "../security/policy.js";
import type { AgentDependencies } from "../agent/types.js";
import type { ApprovalHandler } from "../agent/approval.js";
import type { ToolGateway, ToolExecutionContext, ToolResult, WorkspaceSnapshot, ToolCall } from "./types.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function classifyEffects(name: string) {
  if (name === "workspace.read_file" || name === "workspace.list_files" || name === "workspace.search" || name === "git.diff") {
    return ["read"] as const;
  }
  if (name === "workspace.write_file") {
    return ["write"] as const;
  }
  if (name === "project.verify" || name === "git.diff") {
    return ["read"] as const;
  }
  if (name === "terminal.run") {
    return ["shell"] as const;
  }
  if (name === "git.run") {
    return ["read", "write"] as const;
  }
  return ["read"] as const;
}

interface SnapshotRecord {
  id: string;
  revision: string;
  files: string[];
  fingerprints: Record<string, string>;
}

export class RegistryToolGateway implements ToolGateway {
  private readonly snapshots = new Map<string, SnapshotRecord>();

  constructor(
    private readonly dependencies: Pick<AgentDependencies, "runtime" | "tools">,
    private readonly policy: ExecutionPolicy,
    private readonly approval?: ApprovalHandler,
  ) {}

  describe(name: string) {
    const tool = this.dependencies.tools.get(name);
    if (!tool) return undefined;

    const effects = classifyEffects(name);
    return { effects };
  }

  async execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    context.signal.throwIfAborted();

    const descriptor = this.describe(call.tool);
    if (!descriptor) {
      return {
        ok: false,
        data: null,
        evidenceId: randomUUID(),
        error: { category: "tool_error", message: `Unknown tool: ${call.tool}` },
      };
    }

    if (!this.policy.allowTools) {
      return {
        ok: false,
        data: null,
        evidenceId: randomUUID(),
        error: { category: "permission_error", message: "Tool execution is disabled by policy." },
      };
    }

    if (descriptor.effects.includes("shell") && !this.policy.allowShell) {
      return {
        ok: false,
        data: null,
        evidenceId: randomUUID(),
        error: { category: "permission_error", message: "Shell execution is disabled by policy." },
      };
    }

    if (descriptor.effects.includes("write") && !this.policy.allowFileWrite) {
      return {
        ok: false,
        data: null,
        evidenceId: randomUUID(),
        error: { category: "permission_error", message: "File writes are disabled by policy." },
      };
    }

    if (descriptor.effects.includes("network") && !this.policy.allowNetwork) {
      return {
        ok: false,
        data: null,
        evidenceId: randomUUID(),
        error: { category: "network_error", message: "Network access is disabled by policy." },
      };
    }

    const tool = this.dependencies.tools.get(call.tool);
    if (!tool) {
      return {
        ok: false,
        data: null,
        evidenceId: randomUUID(),
        error: { category: "tool_error", message: "Tool disappeared during execution." },
      };
    }

    const requiresApproval =
      descriptor.effects.includes("write") ||
      descriptor.effects.includes("shell") ||
      descriptor.effects.includes("destructive");

    if (requiresApproval && context.requireApproval) {
      if (!this.approval) {
        return {
          ok: false,
          data: null,
          evidenceId: randomUUID(),
          error: {
            category: "permission_error",
            message: "Approval is required for this tool.",
          },
        };
      }

      context.notifyApproval(true);
      try {
        const approved = await this.approval({
          runId: context.runId,
          toolName: call.tool,
          input: call.input,
        });

        if (!approved) {
          return {
            ok: false,
            data: null,
            evidenceId: randomUUID(),
            error: {
              category: "permission_error",
              message: "Tool execution was not approved.",
            },
          };
        }
      } finally {
        context.notifyApproval(false);
      }
    }

    try {
      const data = await tool.execute(call.input, {
        runtime: this.dependencies.runtime,
        signal: context.signal,
      });

      return {
        ok: true,
        data,
        evidenceId: randomUUID(),
      };
    } catch (error) {
      return {
        ok: false,
        data: null,
        evidenceId: randomUUID(),
        error: {
          category: "tool_error",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async snapshot(signal: AbortSignal): Promise<WorkspaceSnapshot> {
    signal.throwIfAborted();

    const result = await this.dependencies.runtime.git(
      ["status", "--porcelain", "--untracked-files=all"],
    );

    const files = result.code === 0
      ? result.stdout
          .split(/\r?\n/)
          .map((line) => line.slice(3).trim())
          .filter(Boolean)
          .sort()
      : [];

    const revisionSource =
      result.code === 0
        ? result.stdout
        : `non-git:${await this.dependencies.runtime.cwd()}`;

    const revision = digest(revisionSource);
    const id = randomUUID();

    const fingerprints: Record<string, string> = {};
    for (const file of files) {
      try {
        fingerprints[file] = digest(await this.dependencies.runtime.readFile(file));
      } catch {
        fingerprints[file] = "<missing>";
      }
    }

    this.snapshots.set(id, { id, revision, files, fingerprints });

    return {
      id,
      revision,
      evidenceId: randomUUID(),
    };
  }

  async changedFiles(
    baselineSnapshotId: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    signal.throwIfAborted();

    const baseline = this.snapshots.get(baselineSnapshotId);
    if (!baseline) throw new Error("Unknown baseline snapshot");

    const current = await this.snapshot(signal);
    const currentRecord = this.snapshots.get(current.id);
    if (!currentRecord) throw new Error("Current snapshot was not retained");

    const names = [...new Set([...baseline.files, ...currentRecord.files])].sort();
    return names.filter((file) =>
      baseline.fingerprints[file] !== currentRecord.fingerprints[file],
    );
  }}
