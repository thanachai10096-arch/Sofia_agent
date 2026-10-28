import type { ChatPlatform } from "../chat-adapter.js";
import type { MessagingAdapter } from "./types.js";

/**
 * Registry of concrete messaging transports.
 *
 * Only adapters supplied by the application are registered. A platform name in
 * ChatPlatform is not evidence that a working transport exists for that platform.
 * Keep this registry transport-only: authorization, session routing, deduplication,
 * and execution remain in the existing gateway and Sofia runtime.
 */
export interface RegisteredMessagingAdapter {
  platform: ChatPlatform;
  status: "registered";
}

export interface MessagingAdapterRegistry {
  /** Returns a concrete adapter only when one was supplied during construction. */
  get(platform: ChatPlatform): MessagingAdapter | undefined;
  has(platform: ChatPlatform): boolean;
  /** Lists only concrete registered adapters, in registration order. */
  list(): readonly RegisteredMessagingAdapter[];
}

const PLATFORM_ID = /^[a-z][a-z0-9-]{0,63}$/;

export function createMessagingAdapterRegistry(
  adapters: readonly MessagingAdapter[],
): MessagingAdapterRegistry {
  const byPlatform = new Map<ChatPlatform, MessagingAdapter>();
  const registrations: RegisteredMessagingAdapter[] = [];

  for (const adapter of adapters) {
    const platform = adapter.platform;
    if (typeof platform !== "string" || !PLATFORM_ID.test(platform)) {
      throw new Error("Messaging adapter platform must be a lowercase kebab-case identifier.");
    }
    if (byPlatform.has(platform)) {
      throw new Error(`Duplicate messaging adapter platform: ${platform}`);
    }
    byPlatform.set(platform, adapter);
    registrations.push({ platform, status: "registered" });
  }

  const snapshot = Object.freeze(registrations.map((item) => Object.freeze({ ...item })));
  return Object.freeze({
    get(platform: ChatPlatform) {
      return byPlatform.get(platform);
    },
    has(platform: ChatPlatform) {
      return byPlatform.has(platform);
    },
    list() {
      return snapshot;
    },
  });
}
