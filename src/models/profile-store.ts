import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type UserModelProvider = "openai-compatible" | "gemini" | "openrouter";

export interface UserModelProfileInput {
  provider: UserModelProvider;
  model: string;
  apiKey: string;
  /** Required only for openai-compatible profiles and must use an operator-allowlisted HTTPS host. */
  baseUrl?: string;
}

export interface UserModelProfileMetadata {
  provider: UserModelProvider;
  model: string;
  baseUrl: string;
  updatedAt: string;
}

export interface DecryptedUserModelProfile extends UserModelProfileMetadata {
  apiKey: string;
}

export interface UserModelProfileStore {
  get(principalId: string): Promise<DecryptedUserModelProfile | undefined>;
  getMetadata(principalId: string): Promise<UserModelProfileMetadata | undefined>;
  set(principalId: string, input: UserModelProfileInput): Promise<UserModelProfileMetadata>;
  delete(principalId: string): Promise<boolean>;
}

interface StoredProfile extends UserModelProfileMetadata {
  encryptedKey: { iv: string; ciphertext: string; tag: string };
}
interface ProfileState { version: 1; profiles: Record<string, StoredProfile>; }

const BUILTIN_BASE_URLS: Record<"gemini" | "openrouter", string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/",
  openrouter: "https://openrouter.ai/api/v1/",
};
const DEFAULT_ALLOWED_HOSTS = [
  "api.openai.com",
  "api.groq.com",
  "api.deepseek.com",
  "api.together.xyz",
  "api.mistral.ai",
  "api.x.ai",
  "api.cerebras.ai",
  "api.fireworks.ai",
  "api.siliconflow.com",
  "api.perplexity.ai",
];

function principalKey(principalId: string): string {
  if (typeof principalId !== "string" || !principalId.trim() || principalId.length > 512) {
    throw new Error("A valid authenticated principal is required.");
  }
  return createHash("sha256").update(principalId).digest("hex");
}

function profileBaseUrl(input: UserModelProfileInput, allowedHosts: ReadonlySet<string>): string {
  if (input.provider === "gemini" || input.provider === "openrouter") {
    if (input.baseUrl !== undefined) throw new Error("Built-in providers do not accept a custom baseUrl.");
    return BUILTIN_BASE_URLS[input.provider];
  }
  if (input.provider !== "openai-compatible" || typeof input.baseUrl !== "string") {
    throw new Error("A supported provider and baseUrl are required.");
  }
  let parsed: URL;
  try { parsed = new URL(input.baseUrl); } catch { throw new Error("baseUrl must be a valid HTTPS URL."); }
  if (parsed.protocol !== "https:" || (parsed.port !== "" && parsed.port !== "443") || parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.hostname.toLowerCase() !== parsed.hostname || !allowedHosts.has(parsed.hostname) || input.baseUrl.length > 2_048) {
    throw new Error("baseUrl must use HTTPS and an operator-allowlisted hostname, without credentials, query, or fragment.");
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  return parsed.toString();
}

function metadata(profile: StoredProfile): UserModelProfileMetadata {
  return { provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl, updatedAt: profile.updatedAt };
}

export class EncryptedUserModelProfileStore implements UserModelProfileStore {
  private readonly encryptionKey: Buffer;
  private readonly allowedHosts: ReadonlySet<string>;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    encryptionKeyBase64: string,
    additionalAllowedHosts: readonly string[] = [],
  ) {
    const key = Buffer.from(encryptionKeyBase64.trim(), "base64");
    if (key.length !== 32) throw new Error("SOFIA_MODEL_PROFILE_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
    this.encryptionKey = key;
    this.allowedHosts = new Set([...DEFAULT_ALLOWED_HOSTS, "generativelanguage.googleapis.com", "openrouter.ai", ...additionalAllowedHosts]
      .map(host => host.trim().toLowerCase()).filter(Boolean));
  }

  async get(principalId: string): Promise<DecryptedUserModelProfile | undefined> {
    const profile = (await this.readState()).profiles[principalKey(principalId)];
    if (!profile) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(profile.encryptedKey.iv, "base64"));
      decipher.setAuthTag(Buffer.from(profile.encryptedKey.tag, "base64"));
      const apiKey = Buffer.concat([
        decipher.update(Buffer.from(profile.encryptedKey.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return { ...metadata(profile), apiKey };
    } catch {
      throw new Error("Stored model profile could not be decrypted; check the server encryption key.");
    }
  }

  async getMetadata(principalId: string): Promise<UserModelProfileMetadata | undefined> {
    const profile = (await this.readState()).profiles[principalKey(principalId)];
    return profile ? metadata(profile) : undefined;
  }

  async set(principalId: string, input: UserModelProfileInput): Promise<UserModelProfileMetadata> {
    const owner = principalKey(principalId);
    if (!input || !["openai-compatible", "gemini", "openrouter"].includes(input.provider)) {
      throw new Error("Unsupported model provider.");
    }
    if (typeof input.model !== "string" || !input.model.trim() || input.model.length > 200 || /[\x00-\x1f\x7f]/.test(input.model)) {
      throw new Error("model must be a non-empty string of at most 200 characters.");
    }
    if (typeof input.apiKey !== "string" || input.apiKey.trim().length < 8 || input.apiKey.length > 8_192 || /[\x00-\x1f\x7f]/.test(input.apiKey)) {
      throw new Error("apiKey must be a non-empty provider key without control characters.");
    }
    const baseUrl = profileBaseUrl(input, this.allowedHosts);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(input.apiKey.trim(), "utf8"), cipher.final()]);
    const profile: StoredProfile = {
      provider: input.provider,
      model: input.model.trim(),
      baseUrl,
      updatedAt: new Date().toISOString(),
      encryptedKey: { iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
    };
    return this.exclusive(async () => {
      const state = await this.readState();
      state.profiles[owner] = profile;
      await this.writeState(state);
      return metadata(profile);
    });
  }

  async delete(principalId: string): Promise<boolean> {
    const owner = principalKey(principalId);
    return this.exclusive(async () => {
      const state = await this.readState();
      if (!state.profiles[owner]) return false;
      delete state.profiles[owner];
      await this.writeState(state);
      return true;
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private async readState(): Promise<ProfileState> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<ProfileState>;
      if (parsed.version !== 1 || !parsed.profiles || typeof parsed.profiles !== "object" || Array.isArray(parsed.profiles)) {
        throw new Error("unsupported profile store format");
      }
      return parsed as ProfileState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, profiles: {} };
      throw new Error("Model profile store is unavailable or corrupt; refusing to overwrite it.");
    }
  }

  private async writeState(state: ProfileState): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = this.filePath + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await rename(temporary, this.filePath);
    } catch (error) {
      // Never delete the existing state to force a replacement.
      throw error;
    }
  }
}

export function defaultModelProfileAllowedHosts(): string[] {
  return [...DEFAULT_ALLOWED_HOSTS];
}
