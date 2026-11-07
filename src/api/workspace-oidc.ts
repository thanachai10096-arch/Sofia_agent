import {
  createHash, createPublicKey, randomBytes, timingSafeEqual, verify,
} from "node:crypto";
import {
  chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  response_types_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
}
interface PendingLogin { nonce: string; verifier: string; expiresAt: number; }
interface SessionRecord { subject: string; createdAt: number; expiresAt: number; }
export interface WorkspaceSession { subject: string; createdAt: number; expiresAt: number; }
export interface WorkspaceOidcOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Until per-user Sofia API-key mapping exists, exactly one subject is permitted. */
  allowedSubject: string;
  sessionDirectory: string;
  sessionTtlMs?: number;
  cookieName?: string;
  fetcher?: typeof fetch;
  now?: () => number;
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}
function parseJwtPart(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid OIDC token.");
  return parsed as Record<string, unknown>;
}
function secureEndpoint(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
    throw new Error("OIDC " + label + " must use HTTPS.");
  }
  if (url.username || url.password || url.hash) throw new Error("Invalid OIDC " + label + ".");
  return url;
}

export class FileWorkspaceSessionStore {
  private readonly directory: string;
  constructor(directory: string, private readonly now: () => number = Date.now) {
    this.directory = path.resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try { chmodSync(this.directory, 0o700); } catch { /* best effort on platforms without POSIX modes */ }
  }
  private filename(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid workspace session identifier.");
    return path.join(this.directory, digest + ".json");
  }
  create(subject: string, ttlMs: number): { token: string; session: WorkspaceSession } {
    const token = randomBytes(32).toString("base64url");
    const now = this.now();
    const session: WorkspaceSession = { subject, createdAt: now, expiresAt: now + ttlMs };
    const digest = createHash("sha256").update(token).digest("hex");
    const target = this.filename(digest);
    const temporary = target + "." + randomBytes(8).toString("hex") + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify(session), { encoding: "utf8", mode: 0o600, flag: "wx" });
      try { chmodSync(temporary, 0o600); } catch { /* best effort */ }
      renameSync(temporary, target);
    } catch {
      try { unlinkSync(temporary); } catch { /* absent */ }
      throw new Error("Workspace session persistence failed.");
    }
    return { token, session };
  }
  get(token: string): WorkspaceSession | null {
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
    const digest = createHash("sha256").update(token).digest("hex");
    try {
      const raw: unknown = JSON.parse(readFileSync(this.filename(digest), "utf8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const value = raw as Partial<SessionRecord>;
      if (typeof value.subject !== "string" || !value.subject ||
          !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) ||
          (value.expiresAt as number) <= this.now() || (value.expiresAt as number) <= (value.createdAt as number)) {
        this.removeDigest(digest);
        return null;
      }
      return { subject: value.subject, createdAt: value.createdAt!, expiresAt: value.expiresAt! };
    } catch { return null; }
  }
  delete(token: string): void {
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return;
    this.removeDigest(createHash("sha256").update(token).digest("hex"));
  }
  private removeDigest(digest: string): void {
    try { unlinkSync(this.filename(digest)); } catch { /* already absent */ }
  }
  prune(): number {
    let removed = 0;
    let names: string[];
    try { names = (awaitlessReadDir(this.directory)); } catch { return 0; }
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = path.join(this.directory, name);
      try {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<SessionRecord>;
        if (!Number.isSafeInteger(raw.expiresAt) || (raw.expiresAt as number) <= this.now()) {
          unlinkSync(file); removed++;
        }
      } catch { try { unlinkSync(file); removed++; } catch { /* absent */ } }
    }
    return removed;
  }
}
function awaitlessReadDir(directory: string): string[] {
  // Synchronous store by design: session validation must not depend on an unawaited cleanup.
  return requireDirEntries(directory);
}
function requireDirEntries(directory: string): string[] {
  // Imported lazily through a static module binding below.
  return readdirSync(directory);
}
import { readdirSync } from "node:fs";

export class WorkspaceOidc {
  readonly cookieName: string;
  readonly sessions: FileWorkspaceSessionStore;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingLogin>();
  private discovery?: OidcDiscovery;
  private jwksCache?: { expiresAt: number; keys: Array<Record<string, unknown>> };

  constructor(private readonly options: WorkspaceOidcOptions) {
    const issuer = secureEndpoint(options.issuer, "issuer").toString().replace(/\/$/, "");
    if (issuer !== options.issuer.replace(/\/$/, "") ||
        !options.clientId || !options.clientSecret || !options.allowedSubject ||
        !options.redirectUri || !Number.isSafeInteger(options.sessionTtlMs ?? 8 * 60 * 60_000)) {
      throw new Error("Invalid workspace OIDC configuration.");
    }
    secureEndpoint(options.redirectUri, "redirect URI");
    this.cookieName = options.cookieName ?? "sofia_workspace_session";
    if (!/^[A-Za-z0-9_]{1,48}$/.test(this.cookieName)) throw new Error("Invalid workspace cookie name.");
    this.sessions = new FileWorkspaceSessionStore(options.sessionDirectory, options.now ?? Date.now);
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async metadata(): Promise<OidcDiscovery> {
    if (this.discovery) return this.discovery;
    const url = new URL(".well-known/openid-configuration", this.options.issuer.replace(/\/$/, "") + "/");
    const response = await this.fetcher(url, { redirect: "error", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("OIDC discovery failed.");
    const value = await response.json() as Partial<OidcDiscovery>;
    if (value.issuer !== this.options.issuer.replace(/\/$/, "") ||
        typeof value.authorization_endpoint !== "string" ||
        typeof value.token_endpoint !== "string" || typeof value.jwks_uri !== "string") {
      throw new Error("OIDC discovery metadata is invalid.");
    }
    secureEndpoint(value.authorization_endpoint, "authorization endpoint");
    secureEndpoint(value.token_endpoint, "token endpoint");
    secureEndpoint(value.jwks_uri, "JWKS endpoint");
    if (value.response_types_supported && !value.response_types_supported.includes("code")) {
      throw new Error("OIDC provider does not support authorization code flow.");
    }
    if (value.id_token_signing_alg_values_supported && !value.id_token_signing_alg_values_supported.includes("RS256")) {
      throw new Error("OIDC provider does not support RS256 ID tokens.");
    }
    this.discovery = value as OidcDiscovery;
    return this.discovery;
  }

  async begin(): Promise<string> {
    const metadata = await this.metadata();
    const now = this.now();
    for (const [key, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(key);
    if (this.pending.size >= 100) throw new Error("Too many pending workspace logins.");
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    this.pending.set(state, { nonce, verifier, expiresAt: now + 5 * 60_000 });
    const url = new URL(metadata.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", this.options.redirectUri);
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async complete(callbackUrl: string): Promise<{ token: string; session: WorkspaceSession }> {
    const url = new URL(callbackUrl);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt <= this.now() || !code || url.searchParams.has("error")) {
      throw new Error("Workspace login was denied, expired, or invalid.");
    }
    const metadata = await this.metadata();
    const response = await this.fetcher(metadata.token_endpoint, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: this.options.redirectUri,
        client_id: this.options.clientId, client_secret: this.options.clientSecret,
        code_verifier: pending.verifier,
      }),
    });
    if (!response.ok) throw new Error("OIDC token exchange failed.");
    const tokens = await response.json() as { id_token?: unknown };
    if (typeof tokens.id_token !== "string") throw new Error("OIDC response did not contain an ID token.");
    const claims = await this.verifyIdToken(tokens.id_token, pending.nonce);
    if (claims.sub !== this.options.allowedSubject) throw new Error("This identity is not allowed to access the Sofia workspace.");
    return this.sessions.create(claims.sub, this.options.sessionTtlMs ?? 8 * 60 * 60_000);
  }

  private async keys(): Promise<Array<Record<string, unknown>>> {
    if (this.jwksCache && this.jwksCache.expiresAt > this.now()) return this.jwksCache.keys;
    const metadata = await this.metadata();
    const response = await this.fetcher(metadata.jwks_uri, { redirect: "error", headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("OIDC JWKS request failed.");
    const value = await response.json() as { keys?: unknown };
    if (!Array.isArray(value.keys) || value.keys.length > 100) throw new Error("OIDC JWKS is invalid.");
    const keys = value.keys.filter((key): key is Record<string, unknown> =>
      !!key && typeof key === "object" && !Array.isArray(key) && key.kty === "RSA" &&
      (key.use === undefined || key.use === "sig") && (key.alg === undefined || key.alg === "RS256"));
    this.jwksCache = { keys, expiresAt: this.now() + 5 * 60_000 };
    return keys;
  }

  private async verifyIdToken(token: string, expectedNonce: string): Promise<{ sub: string }> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid OIDC ID token.");
    const header = parseJwtPart(parts[0]!);
    const claims = parseJwtPart(parts[1]!);
    if (header.alg !== "RS256" || typeof header.kid !== "string" ||
        typeof claims.sub !== "string" || !claims.sub || claims.iss !== this.options.issuer.replace(/\/$/, "") ||
        claims.nonce !== expectedNonce) throw new Error("OIDC ID token claims are invalid.");
    const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    if (!audiences.includes(this.options.clientId) ||
        (audiences.length > 1 && claims.azp !== this.options.clientId)) throw new Error("OIDC ID token audience is invalid.");
    const nowSeconds = Math.floor(this.now() / 1000);
    if (typeof claims.exp !== "number" || claims.exp <= nowSeconds - 60 ||
        typeof claims.iat !== "number" || claims.iat > nowSeconds + 60 ||
        (typeof claims.nbf === "number" && claims.nbf > nowSeconds + 60)) {
      throw new Error("OIDC ID token is expired or not yet valid.");
    }
    const key = (await this.keys()).find((candidate) => candidate.kid === header.kid);
    if (!key) {
      this.jwksCache = undefined;
      const refreshed = (await this.keys()).find((candidate) => candidate.kid === header.kid);
      if (!refreshed) throw new Error("OIDC signing key was not found.");
      return this.verifySignatureAndReturn(parts, refreshed, claims);
    }
    return this.verifySignatureAndReturn(parts, key, claims);
  }

  private verifySignatureAndReturn(parts: string[], jwk: Record<string, unknown>, claims: Record<string, unknown>): { sub: string } {
    try {
      const publicKey = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
      const valid = verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), publicKey, Buffer.from(parts[2]!, "base64url"));
      if (!valid) throw new Error("invalid signature");
    } catch {
      throw new Error("OIDC ID token signature is invalid.");
    }
    return { sub: claims.sub as string };
  }

  getSession(cookieHeader: string | undefined): WorkspaceSession | null {
    const token = this.readCookie(cookieHeader);
    return token ? this.sessions.get(token) : null;
  }
  logout(cookieHeader: string | undefined): void {
    const token = this.readCookie(cookieHeader);
    if (token) this.sessions.delete(token);
  }
  private readCookie(header: string | undefined): string | null {
    if (!header) return null;
    for (const part of header.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name !== this.cookieName) continue;
      const value = rest.join("=");
      return /^[A-Za-z0-9_-]{40,60}$/.test(value) ? value : null;
    }
    return null;
  }
  sessionCookie(token: string, maxAgeSeconds: number): string {
    return this.cookieName + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + Math.max(0, Math.floor(maxAgeSeconds));
  }
  clearSessionCookie(): string {
    return this.cookieName + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
  }
}

export function validateWorkspaceCsrf(cookieValue: string | undefined, headerValue: string | undefined): boolean {
  if (!cookieValue || !headerValue || !/^[A-Za-z0-9_-]{32,80}$/.test(cookieValue) ||
      !/^[A-Za-z0-9_-]{32,80}$/.test(headerValue)) return false;
  const left = Buffer.from(cookieValue);
  const right = Buffer.from(headerValue);
  return left.length === right.length && timingSafeEqual(left, right);
}
