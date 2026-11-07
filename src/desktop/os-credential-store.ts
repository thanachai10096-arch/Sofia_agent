import { Entry } from "@napi-rs/keyring";
import type { DesktopCompanionCredentialStore } from "./companion-client.js";

const SERVICE = "sofia-agent-desktop-companion";
const ACCOUNT = "paired-companion-token";

/**
 * Stores only the restricted companion bearer token in the OS credential vault.
 * Linux is pinned to Secret Service so we never silently fall back to a
 * non-persistent kernel keyring. No plaintext-file fallback is provided.
 */
export class OsDesktopCredentialStore implements DesktopCompanionCredentialStore {
  private readonly entry: Entry;

  constructor() {
    this.entry = process.platform === "linux"
      ? new Entry(SERVICE, ACCOUNT, { linux: { store: "secret-service" } })
      : new Entry(SERVICE, ACCOUNT);
  }

  async get(): Promise<string | null> {
    try {
      const value = this.entry.getPassword();
      return typeof value === "string" && value.length > 0 ? value : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/no.?entry|not found|does not exist/i.test(message)) return null;
      throw new Error("Could not read the Sofia Companion token from the OS credential store.");
    }
  }

  async set(token: string): Promise<void> {
    if (typeof token !== "string" || token.length < 40 || token.length > 256) {
      throw new Error("Invalid Sofia Companion token.");
    }
    try {
      this.entry.setPassword(token);
    } catch {
      throw new Error("Could not save the Sofia Companion token to the OS credential store. Check that the system keychain is unlocked and available.");
    }
  }

  async delete(): Promise<void> {
    try {
      this.entry.deletePassword();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/no.?entry|not found|does not exist/i.test(message)) {
        throw new Error("Could not remove the Sofia Companion token from the OS credential store.");
      }
    }
  }
}
