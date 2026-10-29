import type { DiscordTransport } from "./discord.js";
import { splitMessage } from "./format.js";

/**
 * Deliver complete Discord text while respecting message limits.
 * Only the first chunk uses the interaction token; follow-up chunks use the bot API.
 */
export async function sendDiscordText(
  transport: Pick<DiscordTransport, "sendMessage">,
  channelId: string,
  text: string,
  interactionId?: string,
): Promise<void> {
  const chunks = splitMessage(text, 1_700);
  for (let index = 0; index < chunks.length; index += 1) {
    await transport.sendMessage(channelId, chunks[index]!, undefined, index === 0 ? interactionId : undefined);
  }
}
