import path from "node:path";
import { SofiaClient } from "../../sdk/client.js";
import { FileChatMessageDeduplicator } from "../file-chat-deduplicator.js";
import { createMessagingGateway, type MessagingGateway } from "./gateway.js";
import { createMessagingAccessCheck, createSofiaMessagingHandler } from "./sofia-handler.js";
import { createLineAdapter } from "./line.js";
import { createLineWebhookTransport, type LineWebhookTransport } from "./line-webhook-transport.js";
import { redactSecrets } from "../../security/guard.js";
import type { OutboundMessage } from "./types.js";

export interface LineMessagingRuntime {
  /** Pass this transport to createSofiaApi({ lineWebhookRoute: { transport } }). */
  transport: LineWebhookTransport;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<boolean>;
}
export interface LineMessagingEnvironment {
  SOFIA_MESSAGING_ENABLED?: string;
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  LINE_ALLOWED_USER_IDS?: string;
  LINE_ALLOWED_CONVERSATION_IDS?: string;
  SOFIA_MESSAGING_CONTEXT_SECRET?: string;
  SOFIA_API_KEY?: string;
  SOFIA_API_BASE_URL?: string;
}
export function parseLineAllowlist(value: string, name = "LINE allowlist"): ReadonlySet<string> {
  const entries = value.split(",").map((item) => item.trim());
  if (!entries.length || entries.some((item) => !/^[A-Za-z0-9_-]{1,128}$/.test(item))) {
    throw new Error(name + " must be a comma-separated list of valid LINE IDs.");
  }
  const ids = new Set(entries);
  if (ids.size !== entries.length) throw new Error(name + " must not contain duplicate IDs.");
  return ids;
}

/** Optional LINE Messaging API runtime with mandatory sender/conversation allowlists. */
export function createLineMessagingRuntime(
  env: LineMessagingEnvironment = process.env,
  workspace = process.cwd(),
  onWarning: (message: string) => void = (message) => console.error(message),
): LineMessagingRuntime | undefined {
  if (env.SOFIA_MESSAGING_ENABLED !== "true") return undefined;
  const channelSecret = env.LINE_CHANNEL_SECRET?.trim();
  const channelAccessToken = env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  const rawUsers = env.LINE_ALLOWED_USER_IDS?.trim();
  const rawConversations = env.LINE_ALLOWED_CONVERSATION_IDS?.trim();
  const apiKey = env.SOFIA_API_KEY?.trim();
  const baseUrl = env.SOFIA_API_BASE_URL?.trim();
  if (!channelSecret || !channelAccessToken || !rawUsers || !rawConversations || !apiKey || !baseUrl) {
    onWarning("LINE integration disabled: channel credentials, Sofia API connection, and explicit user/conversation allowlists are required.");
    return undefined;
  }
  try {
    const users = parseLineAllowlist(rawUsers, "LINE_ALLOWED_USER_IDS");
    const conversations = parseLineAllowlist(rawConversations, "LINE_ALLOWED_CONVERSATION_IDS");
    const client = new SofiaClient({ apiKey, baseUrl });
    const accessPolicy = {
      isAllowed(input: { platform: "telegram" | "discord" | "slack" | "line" | "whatsapp" | "matrix"; senderId: string; conversationId: string }) {
        return input.platform === "line" && users.has(input.senderId) && conversations.has(input.conversationId);
      },
    };
    const deduplicator = new FileChatMessageDeduplicator(path.join(workspace, ".sofia", "chat-dedupe"));
    const transport = createLineWebhookTransport({
      channelSecret, channelAccessToken,
      onError: (event, status) => onWarning("LINE transport " + event + (status ? " (HTTP " + status + ")" : "") + "."),
    });
    let gateway: MessagingGateway | undefined;
    const handler = createSofiaMessagingHandler({
      client, accessPolicy, deduplicator, messagingContextSecret: env.SOFIA_MESSAGING_CONTEXT_SECRET?.trim(), commandPrefix: "/run", allowPlainText: true,
      onAccepted: ({ runId, message }) => {
        void client.waitForRun(runId, { timeoutMs: 30 * 60 * 1_000, intervalMs: 1_000 }).then(async (run) => {
          const output = run.status === "completed" && typeof run.result?.output === "string"
            ? String(redactSecrets(run.result.output))
            : "Sofia task " + run.status + ". Check run history for details.";
          await gateway?.send("line", { conversationId: message.identity.conversationId, text: output });
        }).catch(() => onWarning("LINE completion status could not be retrieved."));
      },
    });
    const adapter = createLineAdapter(transport);
    gateway = createMessagingGateway({
      enabled: true, adapters: [adapter],
      allowUser: createMessagingAccessCheck(accessPolicy),
      onMessage: handler,
      logger: {
        info: (event) => onWarning("LINE messaging event: " + event),
        warn: (event) => onWarning("LINE messaging warning: " + event),
      },
    });
    return { transport, start: () => gateway!.start(), stop: () => gateway!.stop(), send: (message) => gateway!.send("line", message) };
  } catch (error) {
    onWarning("LINE integration disabled: " + (error instanceof Error ? error.message : "invalid configuration") + ".");
    return undefined;
  }
}
