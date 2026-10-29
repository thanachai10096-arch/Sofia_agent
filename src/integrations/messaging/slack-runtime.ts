import path from "node:path";
import { SofiaClient } from "../../sdk/client.js";
import { FileChatMessageDeduplicator } from "../file-chat-deduplicator.js";
import { createMessagingGateway, type MessagingGateway } from "./gateway.js";
import { createMessagingAccessCheck, createSofiaMessagingHandler } from "./sofia-handler.js";
import { createSlackAdapter } from "./slack.js";
import { createSlackEventsTransport, type SlackEventsTransport } from "./slack-events-transport.js";
import { redactSecrets } from "../../security/guard.js";
import type { OutboundMessage } from "./types.js";

export interface SlackMessagingRuntime {
  /** Supply this transport to createSofiaApi({ slackEventsRoute: { transport } }). */
  transport: SlackEventsTransport;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<boolean>;
}
export interface SlackMessagingEnvironment {
  SOFIA_MESSAGING_ENABLED?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_ALLOWED_USER_IDS?: string;
  SLACK_ALLOWED_CHANNEL_IDS?: string;
  SOFIA_MESSAGING_CONTEXT_SECRET?: string;
  SOFIA_API_KEY?: string;
  SOFIA_API_BASE_URL?: string;
}

/** Parse Slack immutable user IDs or channel IDs from a strict comma-separated allowlist. */
export function parseSlackAllowlist(value: string, name = "Slack allowlist"): ReadonlySet<string> {
  const entries = value.split(",").map((item) => item.trim());
  if (!entries.length || entries.some((item) => !/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(item))) {
    throw new Error(name + " must be a comma-separated list of valid Slack IDs.");
  }
  const ids = new Set(entries);
  if (ids.size !== entries.length) throw new Error(name + " must not contain duplicate IDs.");
  return ids;
}

/**
 * Optional Slack-to-Sofia runtime. The API route receives the same signed transport;
 * no second agent runtime is created. Plain text is task input only for explicitly
 * allowlisted Slack users/channels. Secrets remain server-side.
 */
export function createSlackMessagingRuntime(
  env: SlackMessagingEnvironment = process.env,
  workspace = process.cwd(),
  onWarning: (message: string) => void = (message) => console.error(message),
): SlackMessagingRuntime | undefined {
  if (env.SOFIA_MESSAGING_ENABLED !== "true") return undefined;
  const signingSecret = env.SLACK_SIGNING_SECRET?.trim();
  const botToken = env.SLACK_BOT_TOKEN?.trim();
  const rawUsers = env.SLACK_ALLOWED_USER_IDS?.trim();
  const rawChannels = env.SLACK_ALLOWED_CHANNEL_IDS?.trim();
  const apiKey = env.SOFIA_API_KEY?.trim();
  const baseUrl = env.SOFIA_API_BASE_URL?.trim();
  if (!signingSecret || !botToken || !rawUsers || !rawChannels || !apiKey || !baseUrl) {
    onWarning("Slack integration disabled: signing secret, bot token, API connection, and explicit user/channel allowlists are required.");
    return undefined;
  }
  try {
    const users = parseSlackAllowlist(rawUsers, "SLACK_ALLOWED_USER_IDS");
    const channels = parseSlackAllowlist(rawChannels, "SLACK_ALLOWED_CHANNEL_IDS");
    const client = new SofiaClient({ apiKey, baseUrl });
    const accessPolicy = {
      isAllowed(input: { platform: "telegram" | "discord" | "slack" | "line" | "whatsapp" | "matrix"; senderId: string; conversationId: string }) {
        return input.platform === "slack" && users.has(input.senderId) && channels.has(input.conversationId);
      },
    };
    const deduplicator = new FileChatMessageDeduplicator(path.join(workspace, ".sofia", "chat-dedupe"));
    const transport = createSlackEventsTransport({
      signingSecret,
      botToken,
      onError: (event, status) => onWarning("Slack transport " + event + (status ? " (HTTP " + status + ")" : "") + "."),
    });
    let gateway: MessagingGateway | undefined;
    const handler = createSofiaMessagingHandler({
      client, accessPolicy, deduplicator, messagingContextSecret: env.SOFIA_MESSAGING_CONTEXT_SECRET?.trim(), commandPrefix: "/run", allowPlainText: true,
      onAccepted: ({ runId, message }) => {
        void client.waitForRun(runId, { timeoutMs: 30 * 60 * 1_000, intervalMs: 1_000 }).then(async (run) => {
          const output = run.status === "completed" && typeof run.result?.output === "string"
            ? String(redactSecrets(run.result.output))
            : "Sofia task " + run.status + ". Check run history for details.";
          await gateway?.send("slack", { conversationId: message.identity.conversationId, text: output });
        }).catch(() => {
          onWarning("Slack completion status could not be retrieved.");
        });
      },
    });
    const adapter = createSlackAdapter(transport);
    gateway = createMessagingGateway({
      enabled: true,
      adapters: [adapter],
      allowUser: createMessagingAccessCheck(accessPolicy),
      onMessage: handler,
      logger: {
        info: (event, fields) => onWarning("Slack messaging event: " + event + (fields ? " " + JSON.stringify(fields) : "")),
        warn: (event) => onWarning("Slack messaging warning: " + event),
      },
    });
    return {
      transport,
      start: () => gateway!.start(),
      stop: () => gateway!.stop(),
      send: (message) => gateway!.send("slack", message),
    };
  } catch (error) {
    onWarning("Slack integration disabled: " + (error instanceof Error ? error.message : "invalid configuration") + ".");
    return undefined;
  }
}
