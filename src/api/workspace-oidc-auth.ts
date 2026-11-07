import {
  createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature,
} from "node:crypto";
import { FileWorkspaceSessionStore } from "./workspace-session-store.js";

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
  sessionDirectory: string;
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
function tokenTooLong(value: string): boolean { return value.length > 4096; }
function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid OIDC configuration or response.");
  return value;
}
async function boundedJson(response: Response, maxBytes: number, label: string): Promise<JsonObject> {
  if (!response.ok) throw new Error(label + " unavailable.");
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(label + " response is too large.");
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) throw new Error(label + " response is too large.");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(label + " response is invalid.");
  return parsed as JsonObject;
}

/**
 * Minimal single-operator OIDC Authorization Code + PKCE integration.
 * It deliberately has no password database and admits only one configured subject.
 * Login transactions are process-local; persistent opaque sessions survive restarts.
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
  private readonly sessions: FileWorkspaceSessionStore;
  private readonly loginStarts: number[] = [];

  constructor(options: WorkspaceAuthOptions) {
    this.issuer = requiredString(options.issuer).replace(/\/$/, "");
    const issuerUrl = new URL(this.issuer);
    if (issuerUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(issuerUrl.hostname)) throw new Error("Workspace OIDC issuer must use HTTPS.");
    if (issuerUrl.username || issuerUrl.password || issuerUrl.hash || issuerUrl.search) throw new Error("Invalid workspace OIDC issuer.");
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
    if (redirect.username || redirect.password || redirect.hash) throw new Error("Invalid workspace OIDC redirect URI.");
    if (redirect.protocol !== "https:" && redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1") {
      throw new Error("Workspace OIDC redirect URI must use HTTPS.");
    }
    this.cookieName = options.cookieName ?? "__Host-sofia_workspace";
    if (!/^__Host-[A-Za-z0-9_-]+$/.test(this.cookieName)) throw new Error("Workspace session cookie must use the __Host- prefix.");
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.sessions = new FileWorkspaceSessionStore(options.sessionDirectory, this.now);
  }

  private async provider(): Promise<OidcDiscovery> {
    if (this.discovery) return this.discovery;
    const response = await this.fetcher(this.issuer + "/.well-known/openid-configuration", {
      headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    const data = await boundedJson(response, 64 * 1024, "OIDC discovery");
    const issuer = requiredString(data.issuer);
    const authorization_endpoint = requiredString(data.authorization_endpoint);
    const token_endpoint = requiredString(data.token_endpoint);
    const jwks_uri = requiredString(data.jwks_uri);
    if (!equalText(issuer.replace(/\/$/, ""), this.issuer)) throw new Error("OIDC issuer mismatch.");
    for (const endpoint of [authorization_endpoint, token_endpoint, jwks_uri]) {
      const url = new URL(endpoint);
      if ((url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") ||
          url.username || url.password || url.hash) {
        throw new Error("OIDC endpoints must use HTTPS and contain no credentials or fragments.");
      }
    }
    this.discovery = { issuer, authorization_endpoint, token_endpoint, jwks_uri };
    return this.discovery;
  }

  async beginLogin(): Promise<{ url: string; state: string }> {
    this.prune();
    const now = this.now();
    while (this.loginStarts.length && this.loginStarts[0]! <= now - 60_000) this.loginStarts.shift();
    if (this.loginStarts.length >= 20 || this.logins.size >= 100) throw new Error("Workspace login rate limit reached.");
    this.loginStarts.push(now);
    if (this.logins.size >= 100) throw new Error("Too many pending workspace login attempts.");
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
    if (!code || code.length > 4096 || tokenTooLong(code) || !/^[A-Za-z0-9_-]{32,}$/.test(state)) throw new Error("Invalid OIDC callback.");
    const pending = this.logins.get(state);
    this.logins.delete(state); // one-time state, including failed exchanges
    if (!pending || pending.expiresAt <= this.now() || !equalText(pending.state, state)) throw new Error("OIDC login expired or invalid.");
    const provider = await this.provider();
    const tokenResponse = await this.fetcher(provider.token_endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        grant_type: "authorization_code", code, redirect_uri: this.redirectUri,
        client_id: this.clientId, client_secret: this.clientSecret, code_verifier: pending.verifier,
      }),
    });
    if (!tokenResponse.ok) throw new Error("OIDC token exchange failed.");
    const tokenData = await boundedJson(tokenResponse, 64 * 1024, "OIDC token exchange");
    const idToken = requiredString(tokenData.id_token);
    const subject = await this.verifyIdToken(idToken, provider, pending.nonce);
    if (!equalText(subject, this.allowedSubject)) throw new Error("This identity is not allowed to access Sofia Workspace.");
    const created = this.sessions.create(subject, this.sessionTtlMs);
    return { subject, sessionId: created.sessionId, expiresAt: created.session.expiresAt };
  }

  private async verifyIdToken(token: string, provider: OidcDiscovery, nonce: string): Promise<string> {
    const parts = token.split(".");
    if (parts.length !== 3 || token.length > 16_384) throw new Error("Invalid OIDC ID token.");
    const header = decodeJson(parts[0]!);
    const claims = decodeJson(parts[1]!);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.crit !== undefined || header.b64 === false) {
      throw new Error("Unsupported OIDC ID token signature.");
    }
    const jwksResponse = await this.fetcher(provider.jwks_uri, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    const jwks = await boundedJson(jwksResponse, 256 * 1024, "OIDC signing keys");
    if (!Array.isArray(jwks.keys) || jwks.keys.length > 100) throw new Error("OIDC JWKS is invalid.");
    const jwk = (jwks.keys as Array<JsonObject>).find((key) => key.kid === header.kid && key.kty === "RSA" &&
      (key.use === undefined || key.use === "sig") && (key.alg === undefined || key.alg === "RS256") &&
      (key.key_ops === undefined || (Array.isArray(key.key_ops) && key.key_ops.includes("verify"))));
    if (!jwk || typeof jwk.n !== "string" || typeof jwk.e !== "string") throw new Error("OIDC signing key not found.");
    const publicKey = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
    if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("OIDC signing key is too weak.");
    const valid = verifySignature("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), publicKey, Buffer.from(parts[2]!, "base64url"));
    if (!valid) throw new Error("OIDC ID token signature invalid.");
    const issuer = requiredString(claims.iss).replace(/\/$/, "");
    const subject = requiredString(claims.sub);
    const audience = claims.aud;
    const audiences = Array.isArray(audience) ? audience : [audience];
    const nowSeconds = Math.floor(this.now() / 1000);
    const exp = claims.exp;
    const iat = claims.iat;
    const nbf = claims.nbf === undefined ? 0 : claims.nbf;
    const validAudiences = audiences.every((value) => typeof value === "string");
    if (!equalText(issuer, this.issuer) || !validAudiences || !audiences.includes(this.clientId) ||
        (audiences.length > 1 && claims.azp !== this.clientId) ||
        (claims.azp !== undefined && claims.azp !== this.clientId) ||
        typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= nowSeconds ||
        typeof iat !== "number" || !Number.isSafeInteger(iat) || iat > nowSeconds + 60 ||
        typeof nbf !== "number" || !Number.isSafeInteger(nbf) || nbf > nowSeconds ||
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
    if (!session) return null;
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
    this.sessions.prune();
  }
}
