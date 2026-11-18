import { createHash } from "node:crypto";
import path from "node:path";
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

  const issued = new WeakSet<object>();
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
      issued.add(context);
      return context;
    },

    assertContext(context: TenantResourceContext): void {
      if (!context || typeof context !== "object" || !issued.has(context)) {
        throw new Error("Untrusted or foreign tenant context.");
      }
      if (
        typeof context.tenantId !== "string" ||
        typeof context.principalId !== "string" ||
        typeof context.workspaceRoot !== "string" ||
        !path.isAbsolute(context.workspaceRoot) ||
        !context.workspaceRoot.startsWith(path.join(root, "tenants") + path.sep)
      ) {
        throw new Error("Invalid tenant resource context.");
      }
    },
  });
}
