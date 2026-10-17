import type { MessagingIdentity } from "./types.js";

/** Length-prefixed key prevents separator collisions and enforces platform/user/channel isolation. */
export function messagingSessionKey(identity: MessagingIdentity, mode: "user-channel" | "user-conversation" = "user-conversation"): string {
  const conversation = mode === "user-channel" ? identity.channelId : identity.conversationId;
  const parts = [identity.platform, identity.userId, conversation];
  if (parts.some((part) => !part || part.length > 512)) throw new Error("Invalid messaging identity.");
  return parts.map((part) => `${part.length}:${part}`).join("|");
}
