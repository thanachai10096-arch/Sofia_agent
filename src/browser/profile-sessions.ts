import { createHash } from "node:crypto";
import type { BrowserProfile, BrowserProfileStore } from "./profile-store.js";
import type { BrowserRuntime, BrowserSession } from "./runtime.js";

/**
 * Owns persistent local browser contexts across Brain runs. Run-scoped tools
 * receive only page handles; the host keeps the authenticated context alive
 * until the user revokes the profile or the process shuts down.
 */
export class BrowserProfileSessionManager {
  private readonly sessions = new Map<string, Promise<BrowserSession>>();

  constructor(
    private readonly store: BrowserProfileStore,
    private readonly createRuntime: () => BrowserRuntime,
  ) {}

  private key(ownerId: string, profileId: string): string {
    return createHash("sha256").update(ownerId).digest("hex") + ":" + profileId;
  }

  private async launch(profile: BrowserProfile): Promise<BrowserSession> {
    return this.createRuntime().launch({ profileDirectory: profile.directory, headless: false });
  }

  async create(ownerId: string): Promise<{ profile: BrowserProfile; session: BrowserSession }> {
    const profile = await this.store.create(ownerId);
    try {
      const session = await this.launch(profile);
      this.sessions.set(this.key(ownerId, profile.id), Promise.resolve(session));
      return { profile, session };
    } catch (error) {
      await this.store.revoke(ownerId, profile.id).catch(() => undefined);
      throw error;
    }
  }

  async acquire(ownerId: string, profileId: string): Promise<BrowserSession> {
    const profile = await this.store.get(ownerId, profileId);
    const key = this.key(ownerId, profileId);
    const current = this.sessions.get(key);
    if (current) return current;
    const pending = this.launch(profile);
    this.sessions.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.sessions.get(key) === pending) this.sessions.delete(key);
      throw error;
    }
  }

  async list(ownerId: string): Promise<BrowserProfile[]> {
    return this.store.list(ownerId);
  }

  async revoke(ownerId: string, profileId: string): Promise<void> {
    const key = this.key(ownerId, profileId);
    const current = this.sessions.get(key);
    this.sessions.delete(key);
    if (current) await (await current).close();
    await this.store.revoke(ownerId, profileId);
  }

  async closeAll(): Promise<void> {
    const current = [...this.sessions.values()];
    this.sessions.clear();
    const sessions = await Promise.allSettled(current);
    await Promise.allSettled(sessions.filter((result): result is PromiseFulfilledResult<BrowserSession> => result.status === "fulfilled").map((result) => result.value.close()));
  }
}
