import path from "node:path";
import { SofiaClient } from "../../sdk/client.js";
import { FileChatMessageDeduplicator } from "../file-chat-deduplicator.js";
import { createMessagingGateway, type MessagingGateway } from "./gateway.js";
import { createMessagingAccessCheck, createSofiaMessagingHandler } from "./sofia-handler.js";
import { createWhatsAppAdapter } from "./whatsapp.js";
import { createWhatsAppHttpTransport } from "./whatsapp-http-transport.js";
import type { WhatsAppWebhookRouteTransport } from "./whatsapp-http-route.js";
import { redactSecrets } from "../../security/guard.js";
import type { ChatPlatform } from "../chat-adapter.js";

export interface WhatsAppMessagingRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  webhookTransport: WhatsAppWebhookRouteTransport;
}
export interface WhatsAppMessagingEnvironment {
  SOFIA_WHATSAPP_ENABLED?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_GRAPH_API_VERSION?: string;
  WHATSAPP_ALLOWED_USER_IDS?: string;
  WHATSAPP_ALLOWED_CONVERSATION_IDS?: string;
  SOFIA_API_KEY?: string;
  SOFIA_API_BASE_URL?: string;
  RAILWAY_PUBLIC_DOMAIN?: string;
}
function parseIds(value: string, name: string): ReadonlySet<string> {
  const entries = value.split(",").map((entry) => entry.trim());
  if (!entries.length || entries.some((entry) => !/^[0-9]{1,32}$/.test(entry))) {
    throw new Error(name + " must be a comma-separated list of numeric WhatsApp IDs.");
  }
  const ids = new Set(entries);
  if (ids.size !== entries.length) throw new Error(name + " must not contain duplicate IDs.");
  return ids;
}

/** Optional WhatsApp bridge that reuses Sofia's API client, gateway, policy, handler and deduplicator. */
export function createWhatsAppMessagingRuntime(
  env: WhatsAppMessagingEnvironment = process.env,
  workspace = process.cwd(),
  onWarning: (message: string) => void = (message) => console.error(message),
): WhatsAppMessagingRuntime | undefined {
  if (env.SOFIA_WHATSAPP_ENABLED !== "true") return undefined;
  const token = env.WHATSAPP_ACCESS_TOKEN?.trim();
  const appSecret = env.WHATSAPP_APP_SECRET?.trim();
  const verifyToken = env.WHATSAPP_VERIFY_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const graphApiVersion = env.WHATSAPP_GRAPH_API_VERSION?.trim();
  const rawUsers = env.WHATSAPP_ALLOWED_USER_IDS?.trim();
  const rawConversations = env.WHATSAPP_ALLOWED_CONVERSATION_IDS?.trim();
  const apiKey = env.SOFIA_API_KEY?.trim();
  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  const baseUrl = env.SOFIA_API_BASE_URL?.trim() ||
    (railwayDomain ? "https://" + railwayDomain.replace(/^https?:\/\//i, "").replace(/\/$/, "") : "");
  if (!token || !appSecret || !verifyToken || !phoneNumberId || !graphApiVersion ||
      !rawUsers || !rawConversations || !apiKey || !baseUrl) {
    onWarning("WhatsApp integration disabled: credentials, API connection, Graph API version, and explicit user/conversation allowlists are required.");
    return undefined;
  }
  try {
    const allowedUsers = parseIds(rawUsers, "WHATSAPP_ALLOWED_USER_IDS");
    const allowedConversations = parseIds(rawConversations, "WHATSAPP_ALLOWED_CONVERSATION_IDS");
    const client = new SofiaClient({ apiKey, baseUrl });
    const accessPolicy = {
      isAllowed(input: { platform: ChatPlatform; senderId: string; conversationId: string }) {
        return input.platform === "whatsapp" && allowedUsers.has(input.senderId) &&
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
            await gateway?.send("whatsapp", {
              conversationId: message.identity.conversationId,
              text: "Sofia could not retrieve the final result for run " + runId + ". Check the Sofia run status.",
            });
            return;
          }
          const output = typeof run.result?.output === "string"
            ? String(redactSecrets(run.result.output)).trim().slice(0, 3_800)
            : "";
          const status = ["completed", "failed", "cancelled", "queued", "running"].includes(run.status) ? run.status : "unknown";
          const safeError = typeof run.error === "string"
            ? String(redactSecrets(run.error)).replace(/[\r\n\t]+/g, " ").slice(0, 240).trim()
            : "";
          const text = status === "completed"
            ? "Sofia completed the task.\nRun ID: " + runId + (output ? "\n\n" + output : "\n\nThe run completed but returned no text output.")
            : "Sofia task " + status + ".\nRun ID: " + runId + (status === "failed" && safeError ? "\nReason: " + safeError : "");
          await gateway?.send("whatsapp", { conversationId: message.identity.conversationId, text });
        })().catch(() => onWarning("WhatsApp completion delivery failed."));
      },
    });
    const transport = createWhatsAppHttpTransport({
      accessToken: token,
      appSecret,
      verifyToken,
      phoneNumberId,
      graphApiVersion,
      onWarning: (event) => onWarning("WhatsApp transport warning: " + event + "."),
    });
    const adapter = createWhatsAppAdapter(transport);
    gateway = createMessagingGateway({
      enabled: true,
      adapters: [adapter],
      allowUser: createMessagingAccessCheck(accessPolicy),
      maxMessagesPerWindow: 5,
      rateWindowMs: 60_000,
      onMessage: (message) => handler(message),
      logger: {
        info: (event) => onWarning("WhatsApp messaging event: " + event + "."),
        warn: (event) => onWarning("WhatsApp messaging warning: " + event + "."),
      },
    });
    return { start: () => gateway!.start(), stop: () => gateway!.stop(), webhookTransport: transport };
  } catch (error) {
    const message = error instanceof Error && /WHATSAPP_ALLOWED_(USER|CONVERSATION)_IDS must (be a comma-separated list of valid IDs|not contain duplicate IDs)\./.test(error.message)
      ? error.message
      : "WhatsApp configuration validation failed; check required variables and API URL format.";
    onWarning("WhatsApp integration disabled: " + message);
    return undefined;
  }
}
