import { createHash, randomUUID } from "node:crypto";
import type { SecurityAuditSink } from "../security/audit.js";
import type { ProjectMemoryEntry, ProjectMemoryStore } from "./project-memory.js";
import { rankMemoryDocuments } from "./memory-retrieval.js";

/**
 * A caller-authenticated capability for a fixed set of project memory scopes.
 * The caller must derive principalId/projects from trusted authorization state,
 * never directly from an untrusted request body.
 */
export interface ProjectMemoryAccessScope {
  principalId: string;
  projects: readonly string[];
  canRead?: boolean;
  canWrite?: boolean;
}

export interface ScopedProjectMemoryStoreOptions {
  audit?: SecurityAuditSink;
}

/**
 * Enforces a fixed principal/project capability around the existing memory
 * store. It does not create ownership claims or replace the application's
 * authentication/authorization system.
 */
export class ScopedProjectMemoryStore implements ProjectMemoryStore {
  private readonly principalId: string;
  private readonly projects: ReadonlySet<string>;
  private readonly canRead: boolean;
  private readonly canWrite: boolean;

  constructor(
    private readonly store: ProjectMemoryStore,
    scope: ProjectMemoryAccessScope,
    private readonly options: ScopedProjectMemoryStoreOptions = {},
  ) {
    if (!scope || typeof scope.principalId !== "string" || !scope.principalId.trim() || scope.principalId.length > 512) {
      throw new Error("A trusted principal identity is required for scoped project memory.");
    }
    if (!Array.isArray(scope.projects) || scope.projects.length === 0 ||
        scope.projects.some((project) => typeof project !== "string" || !project.trim() || project.length > 512)) {
      throw new Error("At least one valid authorized project is required for scoped project memory.");
    }
    this.principalId = scope.principalId.trim();
    this.projects = new Set(scope.projects.map((project) => project.trim()));
    this.canRead = scope.canRead !== false;
    this.canWrite = scope.canWrite !== false;
  }

  private permitted(project: string): boolean {
    return this.projects.has(project);
  }

  private async audit(action: "list" | "find" | "save", decision: "allow" | "deny", project?: string): Promise<void> {
    if (!this.options.audit) return;
    const scopeHash = createHash("sha256")
      .update(this.principalId + "\u0000" + (project ?? [...this.projects].sort().join("\u0000")))
      .digest("hex");
    await this.options.audit.record({
      id: randomUUID(),
      at: new Date().toISOString(),
      runId: "memory-scope",
      principalId: this.principalId,
      toolName: "memory.project.scope",
      actionHash: scopeHash,
      risk: "low",
      decision,
      reason: decision === "deny" ? "Project memory scope denied the requested operation." : undefined,
      input: { action, projectHash: project ? createHash("sha256").update(project).digest("hex") : undefined },
    });
  }

  async save(entry: ProjectMemoryEntry): Promise<void> {
    if (!this.canWrite || !entry || !this.permitted(entry.project)) {
      await this.audit("save", "deny", entry?.project);
      throw new Error("Project memory write is outside the authorized scope.");
    }
    await this.store.save(entry);
    await this.audit("save", "allow", entry.project);
  }

  async list(): Promise<ProjectMemoryEntry[]> {
    if (!this.canRead) {
      await this.audit("list", "deny");
      throw new Error("Project memory read is not authorized.");
    }
    const entries = (await this.store.list()).filter((entry) => this.permitted(entry.project));
    await this.audit("list", "allow");
    return entries;
  }

  async find(query: string): Promise<ProjectMemoryEntry[]> {
    if (!this.canRead) {
      await this.audit("find", "deny");
      throw new Error("Project memory read is not authorized.");
    }
    const entries = (await this.store.list()).filter((entry) => this.permitted(entry.project) && entry.kind !== "version");
    const matches = rankMemoryDocuments(entries, query, { limit: 12, maxDocuments: 2_000, minScore: 0.12 })
      .map((result) => result.entry);
    await this.audit("find", "allow");
    return matches;
  }
}
