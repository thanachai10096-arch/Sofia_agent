import { createHash } from "node:crypto";
import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { createTenantWorkspace } from "./tenant-workspace.js";

/**
 * Server-created identity and filesystem boundary for one authenticated principal.
 * Instances are issued by a resolver and validated by object identity; callers must
 * never deserialize or construct this context from request data.
 */
export interface TenantResourceContext {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workspaceRoot: string;
}

export interface TenantResourceResolver {
  resolve(principalId: string): Promise<TenantResourceContext>;
  assertContext(context: TenantResourceContext): void;
}

export function createTenantResourceResolver(tenantsRoot: string): TenantResourceResolver {
  if (!path.isAbsolute(tenantsRoot)) {
    throw new Error("Tenant resources root must be an absolute path.");
  }

  const issued = new WeakMap<object, TenantResourceContext>();
  const root = path.resolve(tenantsRoot);

  return Object.freeze({
    async resolve(principalId: string): Promise<TenantResourceContext> {
      const workspaceRoot = await createTenantWorkspace(root, principalId);
      const tenantId = createHash("sha256").update("sofia-tenant:v1:").update(principalId).digest("hex");
      const context = Object.freeze({
        tenantId,
        principalId,
        workspaceRoot,
      });
      issued.set(context, context);
      return context;
    },

    assertContext(context: TenantResourceContext): void {
      if (!context || typeof context !== "object" || issued.get(context) !== context) {
        throw new Error("Untrusted or foreign tenant context.");
      }
      const expectedTenantId = createHash("sha256")
        .update("sofia-tenant:v1:")
        .update(context.principalId)
        .digest("hex");
      if (
        typeof context.principalId !== "string" ||
        typeof context.workspaceRoot !== "string" ||
        !path.isAbsolute(context.workspaceRoot) ||
        context.tenantId !== expectedTenantId
      ) {
        throw new Error("Invalid tenant resource context.");
      }

      // Revalidate the filesystem boundary every time an issued context is used.
      // A previously valid workspace may have been replaced or redirected later.
      try {
        const workspaceStat = lstatSync(context.workspaceRoot);
        if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink() ||
            realpathSync(context.workspaceRoot) !== context.workspaceRoot) {
          throw new Error("Tenant workspace boundary changed.");
        }
      } catch {
        throw new Error("Tenant workspace is missing or no longer a real directory.");
      }
    },
  });
}
