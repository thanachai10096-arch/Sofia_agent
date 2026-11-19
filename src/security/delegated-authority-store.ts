import fs from "node:fs";
import path from "node:path";
import type { DelegatedAuthority } from "./capability-registry.js";
import type { TenantResourceContext, TenantResourceResolver } from "../platform/tenant-resolver.js";

type SqliteDatabase = import("node:sqlite").DatabaseSync;

/**
 * Durable authority storage. Every read/write is scoped by both tenant and
 * authenticated principal. Callers must derive these IDs from trusted auth
 * context; never accept either from model-generated tool arguments.
 */
export class SqliteDelegatedAuthorityStore {
  private constructor(private readonly db: SqliteDatabase) {}

  static async open(filePath: string): Promise<SqliteDelegatedAuthorityStore> {
    if (!path.isAbsolute(filePath)) throw new Error("Delegated authority database path must be absolute.");
    const absolute = path.resolve(filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    try {
      const fd = fs.openSync(absolute, "wx", 0o600);
      fs.closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (process.platform !== "win32") {
      const stat = fs.lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Authority database must be a regular file.");
      fs.chmodSync(absolute, stat.mode & 0o600);
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(absolute);
    try {
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      if (version > 1) throw new Error("Delegated authority schema is newer than this Sofia Agent supports.");
      if (version === 0) {
        db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE delegated_authorities (
            tenant_id TEXT NOT NULL,
            principal_id TEXT NOT NULL,
            authority_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            revoked_at INTEGER,
            PRIMARY KEY (tenant_id, principal_id)
          );
          PRAGMA user_version = 1;
          COMMIT;
        `);
      }
      return new SqliteDelegatedAuthorityStore(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** Trusted control-plane operation; never expose directly as an agent tool. */
  grant(tenantId: string, principalId: string, authority: DelegatedAuthority): void {
    this.assertIdentity(tenantId, principalId);
    if (authority.principalId !== principalId) throw new Error("Authority principal does not match the authenticated principal.");
    this.validateAuthority(authority);
    this.db.prepare(`
      INSERT INTO delegated_authorities(tenant_id, principal_id, authority_json, updated_at, revoked_at)
      VALUES (?, ?, ?, ?, NULL)
      ON CONFLICT(tenant_id, principal_id) DO UPDATE SET
        authority_json = excluded.authority_json,
        updated_at = excluded.updated_at,
        revoked_at = NULL
    `).run(tenantId, principalId, JSON.stringify(authority), Date.now());
  }

  get(tenantId: string, principalId: string, now = Date.now()): DelegatedAuthority | undefined {
    this.assertIdentity(tenantId, principalId);
    const row = this.db.prepare(`
      SELECT authority_json FROM delegated_authorities
      WHERE tenant_id = ? AND principal_id = ? AND revoked_at IS NULL
    `).get(tenantId, principalId) as { authority_json: string } | undefined;
    if (!row) return undefined;
    let authority: DelegatedAuthority;
    try { authority = JSON.parse(row.authority_json) as DelegatedAuthority; }
    catch { return undefined; }
    if (authority.principalId !== principalId || !Number.isFinite(authority.expiresAt) || authority.expiresAt <= now) return undefined;
    try { this.validateAuthority(authority); } catch { return undefined; }
    return authority;
  }

  revoke(tenantId: string, principalId: string): boolean {
    this.assertIdentity(tenantId, principalId);
    const result = this.db.prepare(`
      UPDATE delegated_authorities SET revoked_at = ?, updated_at = ?
      WHERE tenant_id = ? AND principal_id = ? AND revoked_at IS NULL
    `).run(Date.now(), Date.now(), tenantId, principalId);
    return Number(result.changes) > 0;
  }

  close(): void { this.db.close(); }

  private assertIdentity(tenantId: string, principalId: string): void {
    if (!tenantId || tenantId.length > 256 || !principalId || principalId.length > 256) {
      throw new Error("Trusted tenant and principal identifiers are required.");
    }
  }

  private validateAuthority(authority: DelegatedAuthority): void {
    if (!Array.isArray(authority.scopes) || !Array.isArray(authority.allowedCapabilityIds) ||
        !Number.isSafeInteger(authority.expiresAt) || authority.expiresAt <= 0 ||
        authority.scopes.some((scope) => typeof scope !== "string" || !scope) ||
        authority.allowedCapabilityIds.some((id) => typeof id !== "string" || !id)) {
      throw new Error("Delegated authority is malformed.");
    }
    if (authority.currency !== undefined && !/^[A-Z]{3}$/.test(authority.currency)) {
      throw new Error("Delegated authority currency must be an ISO-style three-letter code.");
    }
    for (const amount of [authority.maxPerTransactionMinor, authority.maxPerDayMinor]) {
      if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) {
        throw new Error("Delegated spending limits must be non-negative safe integers.");
      }
    }
    if (authority.allowedMerchants !== undefined &&
        (!Array.isArray(authority.allowedMerchants) || authority.allowedMerchants.some((merchant) => typeof merchant !== "string" || !merchant))) {
      throw new Error("Delegated merchant allowlist is malformed.");
    }
  }
}

/** Open a private per-tenant database using only a resolver-issued context. */
export async function openTenantDelegatedAuthorityStore(
  resolver: TenantResourceResolver,
  context: TenantResourceContext,
): Promise<SqliteDelegatedAuthorityStore> {
  resolver.assertContext(context);
  return SqliteDelegatedAuthorityStore.open(
    path.join(context.workspaceRoot, ".sofia", "delegated-authority.sqlite"),
  );
}
