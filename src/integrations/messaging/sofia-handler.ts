import {
  createChatCommandHandler,
  type ChatAccessPolicy,
  type ChatMessageDeduplicator,
  type ChatRunStarter,
} from "../chat-adapter.js";
import type { InboundMessage } from "./types.js";

export interface SofiaMessagingHandlerOptions {
  client: ChatRunStarter;
  accessPolicy: ChatAccessPolicy;
  deduplicator: ChatMessageDeduplicator;
  commandPrefix?: string;
  /** Treat ordinary messages as tasks; disabled by default for backwards compatibility. */
  acceptPlainTextTasks?: boolean;
  maxTaskCharacters?: number;
  /** Maximum recent transcript characters kept per conversation in memory. */
  maxConversationContextCharacters?: number;
  onAccepted?: (input: { runId: string; runStatus: string; message: InboundMessage }) => void;
}

export interface SofiaMessagingHandler {
  (message: InboundMessage): Promise<string | void>;
  /** Adds the delivered assistant response to bounded, in-memory conversation context. */
  recordAssistantReply(conversationId: string, text: string): void;
}

export function createMessagingAccessCheck(policy: ChatAccessPolicy) {
  return async (input: { platform: "telegram" | "discord" | "slack"; userId: string; channelId: string }) =>
    policy.isAllowed({
      platform: input.platform,
      senderId: input.userId,
      conversationId: input.channelId,
    });
}

const SMALL_TALK: ReadonlyArray<{ pattern: RegExp; reply: string }> = [
  { pattern: /^(hi|hello|hey|สวัสดี|หวัดดี)(\s+sofia)?[!.?\s]*$/i, reply: "สวัสดี 😊 วันนี้อยากคุยหรือให้ Sofia ช่วยเรื่องอะไรดี?" },
  { pattern: /^(thanks|thank you|ขอบคุณ|ขอบใจ)(\s+(sofia|มาก))?[!.\s]*$/i, reply: "ยินดีเลย 😊 มีอะไรให้ช่วยต่อก็บอกได้เสมอ" },
  { pattern: /^(how are you|how are you doing|เป็นไงบ้าง|สบายดีไหม)[?!.\s]*$/i, reply: "สบายดี พร้อมช่วยอยู่ 😊 แล้วคุณล่ะ วันนี้เป็นยังไงบ้าง?" },
  { pattern: /^(who are you|what are you|คุณคือใคร|เธอคือใคร)[?!.\s]*$/i, reply: "ฉันคือ Sofia Agent 😊 คุยกับฉันได้ตามธรรมชาติเลย หรือจะให้ช่วยวางแผน ค้นคว้า เขียนโค้ด และทำงานในขอบเขตสิทธิ์ที่อนุญาตก็ได้" },
];

function isSensitiveLooking(text: string): boolean {
  return /(?:\bsk-[A-Za-z0-9_-]{12,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:password|api[_ -]?key|access[_ -]?token)\s*[:=])/i.test(text);
}

export function createSofiaMessagingHandler(options: SofiaMessagingHandlerOptions): SofiaMessagingHandler {
  const prefix = options.commandPrefix ?? "/run";
  if (!prefix.trim() || prefix.length > 128 || /[\r\n\0]/.test(prefix)) {
    throw new Error("commandPrefix must be a non-empty single-line command.");
  }
  const maxContext = Math.min(12_000, Math.max(500, options.maxConversationContextCharacters ?? 6_000));
  const sessions = new Map<string, string[]>();
  const handleCommand = createChatCommandHandler({
    client: options.client,
    accessPolicy: options.accessPolicy,
    deduplicator: options.deduplicator,
    maxTaskCharacters: options.maxTaskCharacters,
  });

  const appendTurn = (conversationId: string, speaker: "User" | "Sofia", text: string) => {
    if (isSensitiveLooking(text)) return;
    const turns = sessions.get(conversationId) ?? [];
    turns.push(`${speaker}: ${text.trim().slice(0, 2_000)}`);
    let combined = turns.join("\n");
    while (turns.length > 1 && combined.length > maxContext) {
      turns.shift();
      combined = turns.join("\n");
    }
    sessions.set(conversationId, turns);
    // Bound number of active conversations to avoid unbounded memory growth.
    if (sessions.size > 500) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined && oldest !== conversationId) sessions.delete(oldest);
    }
  };

  const onMessage = async (message: InboundMessage): Promise<string | void> => {
    const text = message.text.trim();
    if (!text) return;
    if (text === "/start" || text === "/help") {
      return [
        "Hi! I'm Sofia Agent 😊",
        "",
        "คุยกับฉันได้เหมือนคุยกับคน ไม่ต้องใส่ /run ทุกครั้ง",
        "• ถามคำถามหรือบอกสิ่งที่อยากให้ช่วยได้เลย",
        "• พิมพ์ต่อเพื่ออธิบาย เพิ่มข้อมูล หรือถามต่อจากเรื่องเดิมได้",
        "• /run <task> ใช้สั่งงานโดยตรงได้เหมือนเดิม",
        "",
        "ฉันจะเก็บบริบทการคุยล่าสุดไว้ชั่วคราวระหว่างที่บอตทำงานอยู่",
        "อย่าส่งรหัสผ่านหรือ API keys ในแชต",
      ].join("\n");
    }

    const hasPrefix = text === prefix || text.startsWith(prefix + " ") || text.startsWith(prefix + "\t");
    if (!hasPrefix) {
      const smallTalk = SMALL_TALK.find((entry) => entry.pattern.test(text));
      if (smallTalk) {
        appendTurn(message.identity.conversationId, "User", text);
        appendTurn(message.identity.conversationId, "Sofia", smallTalk.reply);
        return smallTalk.reply;
      }
    }
    if (!hasPrefix && !options.acceptPlainTextTasks) return;

    const task = hasPrefix ? text.slice(prefix.length).trim() : text;
    const conversationId = message.identity.conversationId;
    const context = (sessions.get(conversationId) ?? []).join("\n").slice(-maxContext);
    const result = await handleCommand({
      platform: message.platform,
      messageId: message.messageId,
      senderId: message.identity.userId,
      conversationId,
      command: "run",
      task,
      context,
    });
    switch (result.status) {
      case "accepted":
        appendTurn(conversationId, "User", task);
        try {
          options.onAccepted?.({ runId: result.runId, runStatus: result.runStatus, message });
        } catch {
          // Notification scheduling must not block the acknowledgement.
        }
        return `😊 ได้เลย ฉันรับเรื่องแล้ว กำลังทำให้อยู่นะ\nสถานะ: ${result.runStatus} · Run: ${result.runId}\nเสร็จแล้วจะส่งคำตอบกลับมาในแชตนี้`;
      case "forbidden":
        return "ขอโทษนะ บัญชีหรือห้องแชตนี้ยังไม่ได้รับอนุญาตให้สั่งงาน Sofia";
      case "rejected":
        return result.reason === "empty_task"
          ? `พิมพ์สิ่งที่อยากให้ช่วยได้เลย หรือใช้ ${prefix} <task>`
          : "ข้อความยาวเกินไป ลองแบ่งส่งเป็นข้อความสั้นลงนะ";
      case "duplicate":
      case "ignored":
        return;
    }
  };

  onMessage.recordAssistantReply = (conversationId: string, text: string) => appendTurn(conversationId, "Sofia", text);
  return onMessage;
}
