import {
  createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature,
} from "node:crypto";

type JsonObject = Record<string, unknown>;
interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}
interface PendingLogin {
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
}
export interface WorkspaceIdentity {
  subject: string;
  sessionId: string;
  expiresAt: number;
}
export interface WorkspaceAuthOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedSubject: string;
  sessionTtlMs?: number;
  loginTtlMs?: number;
  cookieName?: string;
  fetcher?: typeof fetch;
  now?: () => number;
}
function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}
function decodeJson(value: string): JsonObject {
  const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid OIDC response.");
  return parsed as JsonObject;
}
function equalText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid OIDC configuration or response.");
  return value;
}

/**
 * Minimal single-operator OIDC Authorization Code + PKCE integration.
 * It deliberately has no password database and admits only one configured subject.
 * Sessions and login transactions are process-local; a restart invalidates them.
 */
export class WorkspaceOidcAuth {
  readonly cookieName: string;
  private readonly issuer: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly allowedSubject: string;
  private readonly sessionTtlMs: number;
  private readonly loginTtlMs: number;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private discovery?: OidcDiscovery;
  private readonly logins = new Map<string, PendingLogin>();
  private readonly sessions = new Map<string, { subject: string; expiresAt: number }>();

  constructor(options: WorkspaceAuthOptions) {
    this.issuer = requiredString(options.issuer).replace(/\/$/, "");
    this.clientId = requiredString(options.clientId);
    this.clientSecret = requiredString(options.clientSecret);
    this.redirectUri = requiredString(options.redirectUri);
    this.allowedSubject = requiredString(options.allowedSubject);
    this.sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60_000;
    this.loginTtlMs = options.loginTtlMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs < 60_000 || this.sessionTtlMs > 7 * 24 * 60 * 60_000 ||
        !Number.isSafeInteger(this.loginTtlMs) || this.loginTtlMs < 30_000 || this.loginTtlMs > 10 * 60_000) {
      throw new Error("Invalid workspace OIDC timeout configuration.");
    }
    const redirect = new URL(this.redirectUri);
    if (redirect.protocol !== "https:" && redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1") {
      throw new Error("Workspace OIDC redirect URI must use HTTPS.");
    }
    this.cookieName = options.cookieName ?? "__Host-sofia_workspace";
    if (!/^__Host-[A-Za-z0-9_-]+$/.test(this.cookieName)) throw new Error("Workspace session cookie must use the __Host- prefix.");
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async provider(): Promise<OidcDiscovery> {
    if (this.discovery) return this.discovery;
    const response = await this.fetcher(this.issuer + "/.well-known/openid-configuration", {
      headers: { accept: "application/json" }, redirect: "error",
    });
    if (!response.ok) throw new Error("OIDC discovery failed.");
    const data = await response.json() as JsonObject;
    const issuer = requiredString(data.issuer);
    const authorization_endpoint = requiredString(data.authorization_endpoint);
    const token_endpoint = requiredString(data.token_endpoint);
    const jwks_uri = requiredString(data.jwks_uri);
    if (!equalText(issuer.replace(/\/$/, ""), this.issuer)) throw new Error("OIDC issuer mismatch.");
    for (const endpoint of [authorization_endpoint, token_endpoint, jwks_uri]) {
      const url = new URL(endpoint);
      if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        throw new Error("OIDC endpoints must use HTTPS.");
      }
    }
    this.discovery = { issuer, authorization_endpoint, token_endpoint, jwks_uri };
    return this.discovery;
  }

  async beginLogin(): Promise<{ url: string; state: string }> {
    this.prune();
    const provider = await this.provider();
    const state = b64url(randomBytes(32));
    const nonce = b64url(randomBytes(32));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    this.logins.set(state, { state, nonce, verifier, expiresAt: this.now() + this.loginTtlMs });
    const url = new URL(provider.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", "openid");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.toString(), state };
  }

  async completeLogin(code: string, state: string): Promise<WorkspaceIdentity> {
    this.prune();
    if (!code || code.length > 4096 || !/^[A-Za-z0-9_-]{32,}$/.test(state)) throw new Error("Invalid OIDC callback.");
    const pending = this.logins.get(state);
    this.logins.delete(state); // one-time state, including failed exchanges
    if (!pending || pending.expiresAt <= this.now() || !equalText(pending.state, state)) throw new Error("OIDC login expired or invalid.");
    const provider = await this.provider();
    const tokenResponse = await this.fetcher(provider.token_endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: this.redirectUri,
        client_id: this.clientId, client_secret: this.clientSecret, code_verifier: pending.verifier,
      }),
    });
    if (!tokenResponse.ok) throw new Error("OIDC token exchange failed.");
    const tokenData = await tokenResponse.json() as JsonObject;
    const idToken = requiredString(tokenData.id_token);
    const subject = await this.verifyIdToken(idToken, provider, pending.nonce);
    if (!equalText(subject, this.allowedSubject)) throw new Error("This identity is not allowed to access Sofia Workspace.");
    const sessionId = b64url(randomBytes(32));
    const expiresAt = this.now() + this.sessionTtlMs;
    this.sessions.set(sessionId, { subject, expiresAt });
    return { subject, sessionId, expiresAt };
  }

  private async verifyIdToken(token: string, provider: OidcDiscovery, nonce: string): Promise<string> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid OIDC ID token.");
    const header = decodeJson(parts[0]!);
    const claims = decodeJson(parts[1]!);
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unsupported OIDC ID token signature.");
    const jwksResponse = await this.fetcher(provider.jwks_uri, { headers: { accept: "application/json" }, redirect: "error" });
    if (!jwksResponse.ok) throw new Error("OIDC signing keys unavailable.");
    const jwks = await jwksResponse.json() as { keys?: Array<JsonObject> };
    const jwk = jwks.keys?.find((key) => key.kid === header.kid && key.kty === "RSA" && key.use !== "enc" && (!key.alg || key.alg === "RS256"));
    if (!jwk || typeof jwk.n !== "string" || typeof jwk.e !== "string") throw new Error("OIDC signing key not found.");
    const publicKey = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
    const valid = verifySignature("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), publicKey, Buffer.from(parts[2]!, "base64url"));
    if (!valid) throw new Error("OIDC ID token signature invalid.");
    const issuer = requiredString(claims.iss).replace(/\/$/, "");
    const subject = requiredString(claims.sub);
    const audience = claims.aud;
    const audiences = Array.isArray(audience) ? audience : [audience];
    const exp = Number(claims.exp);
    const nbf = claims.nbf === undefined ? 0 : Number(claims.nbf);
    if (!equalText(issuer, this.issuer) || !audiences.includes(this.clientId) ||
        (audiences.length > 1 && claims.azp !== this.clientId) ||
        !Number.isFinite(exp) || exp <= Math.floor(this.now() / 1000) ||
        !Number.isFinite(nbf) || nbf > Math.floor(this.now() / 1000) ||
        typeof claims.nonce !== "string" || !equalText(claims.nonce, nonce)) {
      throw new Error("OIDC ID token claims invalid.");
    }
    return subject;
  }

  authenticate(cookieHeader: string | undefined): WorkspaceIdentity | null {
    this.prune();
    const cookie = (cookieHeader ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(this.cookieName + "="));
    if (!cookie) return null;
    const sessionId = cookie.slice(this.cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{40,}$/.test(sessionId)) return null;
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= this.now()) return null;
    return { subject: session.subject, sessionId, expiresAt: session.expiresAt };
  }

  revoke(sessionId: string): void { this.sessions.delete(sessionId); }

  sessionCookie(sessionId: string, maxAgeSeconds: number): string {
    return this.cookieName + "=" + sessionId + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + Math.max(0, Math.floor(maxAgeSeconds));
  }

  clearCookie(): string {
    return this.cookieName + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
  }

  private prune(): void {
    const now = this.now();
    for (const [state, login] of this.logins) if (login.expiresAt <= now) this.logins.delete(state);
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id);
  }
}
