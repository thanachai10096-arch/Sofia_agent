import type { AgentDependencies } from "../agent/types.js";
import type { TenantResourceContext, TenantResourceResolver } from "./tenant-resolver.js";

export type TenantDependenciesFactory = (
  context: TenantResourceContext,
) => AgentDependencies | Promise<AgentDependencies>;

/**
 * Caches one dependency bundle per resolver-issued tenant context.
 *
 * This is a lifecycle primitive for a tenant-aware host, not an API router:
 * callers must still resolve the authenticated principal on every request and
 * route every stateful operation (including jobs and recovery) through the
 * returned bundle. Never pass client-created contexts to this registry.
 */
export class TenantDependencyRegistry {
  private readonly entries = new Map<string, {
    context: TenantResourceContext;
    dependencies: Promise<AgentDependencies>;
  }>();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly resolver: TenantResourceResolver,
    private readonly factory: TenantDependenciesFactory,
  ) {}

  async getForPrincipal(principalId: string): Promise<AgentDependencies> {
    if (this.closed) throw new Error("Tenant dependency registry is closed.");
    const context = await this.resolver.resolve(principalId);
    return this.get(context);
  }

  get(context: TenantResourceContext): Promise<AgentDependencies> {
    if (this.closed) throw new Error("Tenant dependency registry is closed.");
    this.resolver.assertContext(context);

    const existing = this.entries.get(context.tenantId);
    if (existing) {
      if (existing.context.principalId !== context.principalId ||
          existing.context.workspaceRoot !== context.workspaceRoot) {
        throw new Error("Tenant identity collision in dependency registry.");
      }
      return existing.dependencies;
    }

    const dependencies = Promise.resolve().then(() => {
      this.resolver.assertContext(context);
      return this.factory(context);
    }).catch((error: unknown) => {
      this.entries.delete(context.tenantId);
      throw error;
    });

    this.entries.set(context.tenantId, { context, dependencies });
    return dependencies;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      const pending = [...this.entries.values()].map((entry) => entry.dependencies);
      const settled = await Promise.allSettled(pending);
      const failures: unknown[] = [];
      for (const result of settled) {
        if (result.status === "rejected") {
          failures.push(result.reason);
          continue;
        }
        try {
          if (result.value.close) await result.value.close();
          else await result.value.closeBrowserProfiles?.();
        } catch (error) {
          failures.push(error);
        }
      }
      this.entries.clear();
      if (failures.length) {
        throw new AggregateError(failures, "One or more tenant dependency bundles failed to close.");
      }
    })();
    return this.closePromise;
  }
}
