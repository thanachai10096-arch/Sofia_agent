import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

function isWithin(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(base + path.sep);
}

/**
 * Allocate a private workspace for an authenticated principal.
 *
 * The principal ID must be derived by the trusted API authentication layer.
 * Never pass a client-supplied workspace path or raw bearer token here.
 */
export async function createTenantWorkspace(
  root: string,
  principalId: string,
): Promise<string> {
  if (!path.isAbsolute(root)) {
    throw new Error("Tenant workspace root must be an absolute path.");
  }
  if (typeof principalId !== "string" || !principalId.trim() || principalId.length > 256) {
    throw new Error("A valid authenticated principal ID is required.");
  }

  const configuredRoot = path.resolve(root);
  await fs.mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const realRoot = await fs.realpath(configuredRoot);
  await fs.chmod(realRoot, 0o700);

  const tenantsDirectory = path.join(realRoot, "tenants");
  await fs.mkdir(tenantsDirectory, { recursive: true, mode: 0o700 });
  const realTenantsDirectory = await fs.realpath(tenantsDirectory);
  // Do not follow a pre-existing tenants symlink outside the configured root.
  if (realTenantsDirectory !== tenantsDirectory || !isWithin(realRoot, realTenantsDirectory)) {
    throw new Error("Tenant directory must be a real directory inside the configured root.");
  }
  await fs.chmod(realTenantsDirectory, 0o700);

  // Hash the opaque principal so IDs, emails, and tokens never appear in paths.
  const tenantKey = createHash("sha256").update(principalId).digest("hex");
  const tenantDirectory = path.join(realTenantsDirectory, tenantKey);
  await fs.mkdir(tenantDirectory, { recursive: true, mode: 0o700 });
  const realTenantDirectory = await fs.realpath(tenantDirectory);
  if (realTenantDirectory !== tenantDirectory || !isWithin(realTenantsDirectory, realTenantDirectory)) {
    throw new Error("Tenant workspace directory must not resolve through a symlink.");
  }
  await fs.chmod(realTenantDirectory, 0o700);

  const workspace = path.join(realTenantDirectory, "workspace");
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  const realWorkspace = await fs.realpath(workspace);
  if (realWorkspace !== workspace || !isWithin(realTenantDirectory, realWorkspace)) {
    throw new Error("Tenant workspace must not resolve through a symlink.");
  }
  await fs.chmod(realWorkspace, 0o700);
  return realWorkspace;
}
