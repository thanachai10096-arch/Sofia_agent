import {
  createChatCommandHandler,
  type ChatAccessPolicy,
  type ChatMessageDeduplicator,
  type ChatRunStarter,
} from "../chat-adapter.js";
import type { InboundMessage } from "./types.js";

export interface SofiaMessagingHandlerOptions {
  /** Existing Sofia SDK/API client; credentials remain server-side. */
  client: ChatRunStarter;
  /** Existing access policy and atomic deduplicator from chat-adapter.ts. */
  accessPolicy: ChatAccessPolicy;
  deduplicator: ChatMessageDeduplicator;
  /** Exact command prefix, e.g. /run or /run@SofiaBot. Defaults to /run. */
  commandPrefix?: string;
  /**
   * Route ordinary text messages to Sofia as natural-language tasks.
   * Defaults to true so users can chat without typing /run. Set false to
   * preserve command-only behavior for deployments that require it.
   */
  naturalLanguageEnabled?: boolean;
  maxTaskCharacters?: number;
  /** Called after the API accepts a run; implementations should schedule completion reporting without blocking polling. */
  onAccepted?: (input: { runId: string; runStatus: string; message: InboundMessage }) => void;
}

/** Maps the gateway identity to Sofia's existing chat authorization contract. */
/**
 * Short conversational nudges must not create expensive Brain runs.
 * These are deliberately narrow phrase matches; substantive questions and
 * requests continue through the normal Brain dispatcher.
 */
function quickConversationReply(text: string): string | undefined {
  const normalized = text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\u200b]+/g, "")
    .replace(/[!?！？。，,、.]+/g, "");

  if (/^(ผมมีคำถาม|ฉันมีคำถาม|มีคำถาม|ขอถามหน่อย|ถามหน่อย|ขอถาม|ถามได้ไหม|ขอถามได้ไหม)$/.test(normalized)) {
    return "ได้เลยครับ 😊 ถามมาได้เลย ผมจะช่วยตอบให้ตรงประเด็นครับ";
  }
  if (/^(ตอบสิ|ตอบหน่อย|ช่วยตอบหน่อย|ตอบด้วย|ตอบลิ|ตอบดิ|ว่าไง|อยู่ไหม|ยังอยู่ไหม)$/.test(normalized)) {
    return "ขอโทษครับ 😊 ผมอยู่ตรงนี้แล้ว ส่งคำถามหรือบอกได้เลยว่าต้องการให้ผมตอบเรื่องไหน";
  }
  if (/^(สวัสดี|หวัดดี|hello|hi|hey)$/.test(normalized)) {
    return "สวัสดีครับ 😊 มีอะไรให้ผมช่วย บอกได้เลยครับ";
  }
  if (/^(ขอบคุณ|ขอบใจ|thanks|thankyou|โอเค|ok)$/.test(normalized)) {
    return "ยินดีครับ 😊";
  }
  if (/(เข้าแอพ|เข้าแอป|เปิดแอพ|เปิดแอป|ควบคุมแอพ|ควบคุมแอป|กดในแอพ|กดในแอป)/.test(normalized)) {
    return "ผมช่วยวางแผนและสั่งงานผ่านเครื่องมือที่ Sofia เชื่อมต่อได้ครับ แต่ตอนนี้ยังไม่มีสิทธิ์ควบคุมแอปอื่นบนมือถือโดยตรง คุณหมายถึงแอปไหน และต้องการให้ทำอะไรในแอปนั้นครับ?";
  }
  return undefined;
}

export function createMessagingAccessCheck(policy: ChatAccessPolicy) {
  return async (input: { platform: "telegram" | "discord" | "slack"; userId: string; channelId: string }) =>
    policy.isAllowed({
      platform: input.platform,
      senderId: input.userId,
      conversationId: input.channelId,
    });
}

/**
 * Bridges normalized inbound messages to Sofia's existing command dispatcher.
 * By default ordinary text is treated as a natural-language task, while slash
 * commands other than the configured run command are ignored. Authorization,
 * deduplication, and task-length validation remain in the existing dispatcher.
 * Attachments alone never trigger execution.
 *
 * Do not also pass this same deduplicator to createMessagingGateway, because the
 * existing command handler claims the provider/channel/message key itself.
 */
export function createSofiaMessagingHandler(options: SofiaMessagingHandlerOptions) {
  const prefix = options.commandPrefix ?? "/run";
  if (!prefix.trim() || prefix.length > 128 || /[\r\n\0]/.test(prefix)) {
    throw new Error("commandPrefix must be a non-empty single-line command.");
  }
  const naturalLanguageEnabled = options.naturalLanguageEnabled ?? true;
  const handleCommand = createChatCommandHandler({
    client: options.client,
    accessPolicy: options.accessPolicy,
    deduplicator: options.deduplicator,
    maxTaskCharacters: options.maxTaskCharacters,
  });

  return async function onMessage(message: InboundMessage): Promise<string | void> {
    const text = message.text.trim();
    const isRunCommand = text === prefix || text.startsWith(prefix + " ") || text.startsWith(prefix + "\t");

    // Answer obvious conversational nudges locally. They are not agent tasks
    // and must never spawn a new run or consume model/tool budget.
    if (naturalLanguageEnabled && !isRunCommand && text && !text.startsWith("/")) {
      const quickReply = quickConversationReply(text);
      if (quickReply) return quickReply;
    }

    // Preserve provider commands such as /start, /help, and /status for the
    // adapter/platform instead of accidentally treating them as agent tasks.
    if (!isRunCommand && text.startsWith("/")) return;
    if (!isRunCommand && !naturalLanguageEnabled) return;
    // Do not trigger an empty run for attachment-only messages.
    if (!text) return;

    const task = isRunCommand ? text.slice(prefix.length).trim() : text;
    const result = await handleCommand({
      platform: message.platform,
      messageId: message.messageId,
      senderId: message.identity.userId,
      conversationId: message.identity.conversationId,
      command: "run",
      task,
    });
    switch (result.status) {
      case "accepted":
        try {
          options.onAccepted?.({ runId: result.runId, runStatus: result.runStatus, message });
        } catch {
          // Completion notifications must never prevent the normal acceptance acknowledgement.
        }
        return `รับคำขอแล้วครับ กำลังเริ่มทำงาน (รหัสงาน: ${result.runId.slice(0, 8)})`;
      case "forbidden":
        return "Access denied.";
      case "rejected":
        return result.reason === "empty_task"
          ? `Usage: ${prefix} <task>`
          : "Task is too long. Please shorten it.";
      case "duplicate":
      case "ignored":
        return;
    }
  };
}
