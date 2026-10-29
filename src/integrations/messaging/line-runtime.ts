import path from "node:path";
import { SofiaClient } from "../../sdk/client.js";
import { FileChatMessageDeduplicator } from "../file-chat-deduplicator.js";
import { createMessagingGateway, type MessagingGateway } from "./gateway.js";
import { createMessagingAccessCheck, createSofiaMessagingHandler } from "./sofia-handler.js";
import { createLineAdapter } from "./line.js";
import { createLineHttpTransport } from "./line-http-transport.js";
import type { LineWebhookTransport } from "./line-http-route.js";
import type { OutboundMessage } from "./types.js";
import { redactSecrets } from "../../security/guard.js";

export interface LineMessagingRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  webhookTransport: LineWebhookTransport;
}

export interface LineMessagingEnvironment {
  SOFIA_LINE_ENABLED?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  LINE_CHANNEL_SECRET?: string;
  LINE_ALLOWED_USER_IDS?: string;
  LINE_ALLOWED_CONVERSATION_IDS?: string;
  SOFIA_API_KEY?: string;
  SOFIA_API_BASE_URL?: string;
  RAILWAY_PUBLIC_DOMAIN?: string;
}

function parseLineIds(value: string, name: string): ReadonlySet<string> {
  const entries = value.split(",").map((entry) => entry.trim());
  if (!entries.length || entries.some((entry) => !entry || entry.length > 256 || /[\r\n\0]/.test(entry))) {
    throw new Error(name + " must be a comma-separated list of valid LINE IDs.");
  }
  const ids = new Set(entries);
  if (ids.size !== entries.length) throw new Error(name + " must not contain duplicate IDs.");
  return ids;
}

/** Optional LINE bridge using the existing Sofia API, shared handler, gateway and access policy. */
export function createLineMessagingRuntime(
  env: LineMessagingEnvironment = process.env,
  workspace = process.cwd(),
  onWarning: (message: string) => void = (message) => console.error(message),
): LineMessagingRuntime | undefined {
  if (env.SOFIA_LINE_ENABLED !== "true") return undefined;
  const token = env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  const secret = env.LINE_CHANNEL_SECRET?.trim();
  const rawUsers = env.LINE_ALLOWED_USER_IDS?.trim();
  const rawConversations = env.LINE_ALLOWED_CONVERSATION_IDS?.trim();
  const apiKey = env.SOFIA_API_KEY?.trim();
  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  const baseUrl = env.SOFIA_API_BASE_URL?.trim() ||
    (railwayDomain ? "https://" + railwayDomain.replace(/^https?:\/\//i, "").replace(/\/$/, "") : "");
  if (!token || !secret || !rawUsers || !rawConversations || !apiKey || !baseUrl) {
    onWarning("LINE integration disabled: credentials, API connection, and explicit user/conversation allowlists are required.");
    return undefined;
  }

  try {
    const allowedUsers = parseLineIds(rawUsers, "LINE_ALLOWED_USER_IDS");
    const allowedConversations = parseLineIds(rawConversations, "LINE_ALLOWED_CONVERSATION_IDS");
    const client = new SofiaClient({ apiKey, baseUrl });
    const accessPolicy = {
      isAllowed(input: { platform: "telegram" | "discord" | "slack"; senderId: string; conversationId: string }) {
        return input.platform === "line" && allowedUsers.has(input.senderId) &&
          allowedConversations.has(input.conversationId);
      },
    };
    const deduplicator = new FileChatMessageDeduplicator(path.join(workspace, ".sofia", "chat-dedupe"));
    let gateway: MessagingGateway | undefined;
    const handler = createSofiaMessagingHandler({
      client,
      accessPolicy,
      deduplicator,
      commandPrefix: "/run",
      onAccepted: ({ runId, message }) => {
        void (async () => {
          let run: { id: string; status: string; result?: { output?: string }; error?: string };
          try {
            run = await client.waitForRun(runId, { timeoutMs: 30 * 60_000, intervalMs: 1_000 });
          } catch {
            await gateway?.send("line", {
              conversationId: message.identity.conversationId,
              text: "Sofia could not retrieve the final result for run " + runId + ". Check the Sofia run status.",
            });
            return;
          }
          const output = typeof run.result?.output === "string"
            ? String(redactSecrets(run.result.output)).trim().slice(0, 4_500)
            : "";
          const status = ["completed", "failed", "cancelled", "queued", "running"].includes(run.status) ? run.status : "unknown";
          const safeError = typeof run.error === "string"
            ? String(redactSecrets(run.error)).replace(/[\r\n\t]+/g, " ").slice(0, 240).trim()
            : "";
          const text = status === "completed"
            ? "Sofia completed the task.\nRun ID: " + runId + (output ? "\n\n" + output : "\n\nThe run completed but returned no text output.")
            : "Sofia task " + status + ".\nRun ID: " + runId + (status === "failed" && safeError ? "\nReason: " + safeError : "");
          await gateway?.send("line", { conversationId: message.identity.conversationId, text });
        })().catch(() => onWarning("LINE completion delivery failed."));
      },
    });
    const transport = createLineHttpTransport({
      channelAccessToken: token,
      channelSecret: secret,
      onWarning: (event) => onWarning("LINE transport warning: " + event + "."),
    });
    const adapter = createLineAdapter(transport);
    gateway = createMessagingGateway({
      enabled: true,
      adapters: [adapter],
      allowUser: createMessagingAccessCheck(accessPolicy),
      maxMessagesPerWindow: 5,
      rateWindowMs: 60_000,
      onMessage: (message) => handler(message),
      logger: {
        info: (event) => onWarning("LINE messaging event: " + event + "."),
        warn: (event) => onWarning("LINE messaging warning: " + event + "."),
      },
    });
    return { start: () => gateway!.start(), stop: () => gateway!.stop(), webhookTransport: transport };
  } catch (error) {
    const message = error instanceof Error && /LINE_ALLOWED_(USER|CONVERSATION)_IDS must (be a comma-separated list of valid LINE IDs|not contain duplicate IDs)\./.test(error.message)
      ? error.message
      : "LINE configuration validation failed; check required variables and API URL format.";
    onWarning("LINE integration disabled: " + message);
    return undefined;
  }
}
