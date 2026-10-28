import path from "node:path";
import { SofiaClient } from "../../sdk/client.js";
import { FileChatMessageDeduplicator } from "../file-chat-deduplicator.js";
import { createMessagingGateway, type MessagingGateway } from "./gateway.js";
import { createMessagingAccessCheck, createSofiaMessagingHandler } from "./sofia-handler.js";
import { createWhatsAppAdapter } from "./whatsapp.js";
import { createWhatsAppWebhookTransport, type WhatsAppWebhookTransport } from "./whatsapp-webhook-transport.js";
import { redactSecrets } from "../../security/guard.js";

export interface WhatsAppMessagingRuntime {
  /** Pass this transport to createSofiaApi({ whatsAppWebhookRoute: { transport } }). */
  transport: WhatsAppWebhookTransport;
  start(): Promise<void>;
  stop(): Promise<void>;
}
export interface WhatsAppMessagingEnvironment {
  SOFIA_MESSAGING_ENABLED?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_GRAPH_API_VERSION?: string;
  WHATSAPP_ALLOWED_PHONE_IDS?: string;
  SOFIA_API_KEY?: string;
  SOFIA_API_BASE_URL?: string;
}
export function parseWhatsAppAllowlist(value: string): ReadonlySet<string> {
  const entries = value.split(",").map((item) => item.trim());
  if (!entries.length || entries.some((item) => !/^\d{5,20}$/.test(item))) {
    throw new Error("WHATSAPP_ALLOWED_PHONE_IDS must be a comma-separated list of phone IDs in international numeric form.");
  }
  const ids = new Set(entries);
  if (ids.size !== entries.length) throw new Error("WHATSAPP_ALLOWED_PHONE_IDS must not contain duplicate IDs.");
  return ids;
}

/** Optional Meta WhatsApp Cloud API runtime; only explicitly allowlisted sender numbers can invoke Sofia. */
export function createWhatsAppMessagingRuntime(
  env: WhatsAppMessagingEnvironment = process.env,
  workspace = process.cwd(),
  onWarning: (message: string) => void = (message) => console.error(message),
): WhatsAppMessagingRuntime | undefined {
  if (env.SOFIA_MESSAGING_ENABLED !== "true") return undefined;
  const appSecret = env.WHATSAPP_APP_SECRET?.trim();
  const verifyToken = env.WHATSAPP_VERIFY_TOKEN?.trim();
  const accessToken = env.WHATSAPP_ACCESS_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const graphApiVersion = env.WHATSAPP_GRAPH_API_VERSION?.trim();
  const rawAllowed = env.WHATSAPP_ALLOWED_PHONE_IDS?.trim();
  const apiKey = env.SOFIA_API_KEY?.trim();
  const baseUrl = env.SOFIA_API_BASE_URL?.trim();
  if (!appSecret || !verifyToken || !accessToken || !phoneNumberId || !graphApiVersion ||
      !rawAllowed || !apiKey || !baseUrl) {
    onWarning("WhatsApp integration disabled: Meta credentials, explicit API version, allowlist, and Sofia API connection are required.");
    return undefined;
  }
  try {
    const allowed = parseWhatsAppAllowlist(rawAllowed);
    const client = new SofiaClient({ apiKey, baseUrl });
    const accessPolicy = {
      isAllowed(input: { platform: "telegram" | "discord" | "slack" | "line" | "whatsapp"; senderId: string; conversationId: string }) {
        return input.platform === "whatsapp" && allowed.has(input.senderId) && allowed.has(input.conversationId);
      },
    };
    const deduplicator = new FileChatMessageDeduplicator(path.join(workspace, ".sofia", "chat-dedupe"));
    const transport = createWhatsAppWebhookTransport({
      appSecret, verifyToken, accessToken, phoneNumberId, graphApiVersion,
      onError: (event, status) => onWarning("WhatsApp transport " + event + (status ? " (HTTP " + status + ")" : "") + "."),
    });
    let gateway: MessagingGateway | undefined;
    const handler = createSofiaMessagingHandler({
      client, accessPolicy, deduplicator, commandPrefix: "/run", allowPlainText: true,
      onAccepted: ({ runId, message }) => {
        void client.waitForRun(runId, { timeoutMs: 30 * 60 * 1_000, intervalMs: 1_000 }).then(async (run) => {
          const output = run.status === "completed" && typeof run.result?.output === "string"
            ? String(redactSecrets(run.result.output))
            : "Sofia task " + run.status + ". Check run history for details.";
          await gateway?.send("whatsapp", { conversationId: message.identity.conversationId, text: output });
        }).catch(() => onWarning("WhatsApp completion status could not be retrieved."));
      },
    });
    const adapter = createWhatsAppAdapter(transport);
    gateway = createMessagingGateway({
      enabled: true, adapters: [adapter],
      allowUser: createMessagingAccessCheck(accessPolicy),
      onMessage: handler,
      logger: {
        info: (event) => onWarning("WhatsApp messaging event: " + event),
        warn: (event) => onWarning("WhatsApp messaging warning: " + event),
      },
    });
    return { transport, start: () => gateway!.start(), stop: () => gateway!.stop() };
  } catch (error) {
    onWarning("WhatsApp integration disabled: " + (error instanceof Error ? error.message : "invalid configuration") + ".");
    return undefined;
  }
}
