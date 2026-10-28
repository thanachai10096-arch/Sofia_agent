import path from "node:path";
import { SofiaClient } from "../../sdk/client.js";
import { FileChatMessageDeduplicator } from "../file-chat-deduplicator.js";
import { redactSecrets } from "../../security/guard.js";
import type { OutboundMessage } from "./types.js";
import { createMessagingGateway, type MessagingGateway } from "./gateway.js";
import { createMessagingAccessCheck, createSofiaMessagingHandler } from "./sofia-handler.js";
import { createMatrixAdapter, type MatrixTransport } from "./matrix.js";
import { createMatrixClientTransport } from "./matrix-client-transport.js";

export interface MatrixMessagingRuntime {
  transport: MatrixTransport;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<boolean>;
}
export interface MatrixMessagingEnvironment {
  SOFIA_MESSAGING_ENABLED?: string;
  MATRIX_HOMESERVER_URL?: string;
  MATRIX_ACCESS_TOKEN?: string;
  MATRIX_ALLOWED_USER_IDS?: string;
  MATRIX_ALLOWED_ROOM_IDS?: string;
  SOFIA_MESSAGING_CONTEXT_SECRET?: string;
  SOFIA_API_KEY?: string;
  SOFIA_API_BASE_URL?: string;
}
export function parseMatrixAllowlist(value: string, name = "Matrix allowlist"): ReadonlySet<string> {
  const entries = value.split(",").map((item) => item.trim());
  if (!entries.length || entries.some((item) =>
    item.length > 255 || !/^[!@][A-Za-z0-9._=:/-]{1,253}$/.test(item))) {
    throw new Error(name + " must be a comma-separated list of Matrix user or room IDs.");
  }
  const ids = new Set(entries);
  if (ids.size !== entries.length) throw new Error(name + " must not contain duplicate IDs.");
  return ids;
}

/** Optional Matrix bridge using the existing Sofia SDK and shared gateway. */
export function createMatrixMessagingRuntime(
  env: MatrixMessagingEnvironment = process.env,
  workspace = process.cwd(),
  onWarning: (message: string) => void = (message) => console.error(message),
): MatrixMessagingRuntime | undefined {
  if (env.SOFIA_MESSAGING_ENABLED !== "true") return undefined;
  const homeserverUrl = env.MATRIX_HOMESERVER_URL?.trim();
  const accessToken = env.MATRIX_ACCESS_TOKEN?.trim();
  const rawUsers = env.MATRIX_ALLOWED_USER_IDS?.trim();
  const rawRooms = env.MATRIX_ALLOWED_ROOM_IDS?.trim();
  const apiKey = env.SOFIA_API_KEY?.trim();
  const baseUrl = env.SOFIA_API_BASE_URL?.trim();
  if (!homeserverUrl || !accessToken || !rawUsers || !rawRooms || !apiKey || !baseUrl) {
    onWarning("Matrix integration disabled: homeserver, access token, Sofia API connection, and explicit user/room allowlists are required.");
    return undefined;
  }
  try {
    const users = parseMatrixAllowlist(rawUsers, "MATRIX_ALLOWED_USER_IDS");
    const rooms = parseMatrixAllowlist(rawRooms, "MATRIX_ALLOWED_ROOM_IDS");
    if ([...users].some((id) => !id.startsWith("@")) || [...rooms].some((id) => !id.startsWith("!"))) {
      throw new Error("Matrix user allowlist must contain @user IDs and room allowlist must contain !room IDs.");
    }
    const client = new SofiaClient({ apiKey, baseUrl });
    const accessPolicy = {
      isAllowed(input: { platform: "telegram" | "discord" | "slack" | "line" | "whatsapp" | "matrix"; senderId: string; conversationId: string }) {
        return input.platform === "matrix" && users.has(input.senderId) && rooms.has(input.conversationId);
      },
    };
    const deduplicator = new FileChatMessageDeduplicator(path.join(workspace, ".sofia", "chat-dedupe"));
    const transport = createMatrixClientTransport({
      homeserverUrl,
      accessToken,
      onError: (event, status) => onWarning("Matrix transport " + event + (status ? " (HTTP " + status + ")" : "") + "."),
    });
    let gateway: MessagingGateway | undefined;
    const handler = createSofiaMessagingHandler({
      client, accessPolicy, deduplicator, messagingContextSecret: env.SOFIA_MESSAGING_CONTEXT_SECRET?.trim(), commandPrefix: "!run", allowPlainText: true,
      onAccepted: ({ runId, message }) => {
        void client.waitForRun(runId, { timeoutMs: 30 * 60 * 1_000, intervalMs: 1_000 }).then(async (run) => {
          const output = run.status === "completed" && typeof run.result?.output === "string"
            ? String(redactSecrets(run.result.output))
            : "Sofia task " + run.status + ". Check run history for details.";
          await gateway?.send("matrix", { conversationId: message.identity.conversationId, text: output });
        }).catch(() => onWarning("Matrix completion status could not be retrieved."));
      },
    });
    const adapter = createMatrixAdapter(transport);
    gateway = createMessagingGateway({
      enabled: true,
      adapters: [adapter],
      allowUser: createMessagingAccessCheck(accessPolicy),
      onMessage: handler,
      logger: {
        info: (event) => onWarning("Matrix messaging event: " + event),
        warn: (event) => onWarning("Matrix messaging warning: " + event),
      },
    });
    return { transport, start: () => gateway!.start(), stop: () => gateway!.stop(), send: (message) => gateway!.send("matrix", message) };
  } catch (error) {
    onWarning("Matrix integration disabled: " + (error instanceof Error ? error.message : "invalid configuration") + ".");
    return undefined;
  }
}
