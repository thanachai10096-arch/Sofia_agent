import {
  createChatCommandHandler,
  type ChatAccessPolicy,
  type ChatMessageDeduplicator,
  type ChatRunStarter,
} from "../chat-adapter.js";
import type { InboundMessage } from "./types.js";
import type { ConversationMode, ConversationSessionStore } from "./conversation-session-store.js";

export interface SofiaMessagingHandlerOptions {
  client: ChatRunStarter;
  accessPolicy: ChatAccessPolicy;
  deduplicator: ChatMessageDeduplicator;
  commandPrefix?: string;
  acceptPlainTextTasks?: boolean;
  maxTaskCharacters?: number;
  maxConversationContextCharacters?: number;
  /** Optional durable local store; omit for in-memory-only sessions. */
  sessionStore?: ConversationSessionStore;
  onAccepted?: (input: { runId: string; runStatus: string; message: InboundMessage }) => void;
}

export interface SofiaMessagingHandler {
  (message: InboundMessage): Promise<string | void>;
  recordAssistantReply(conversationId: string, text: string): void;
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

export function createMessagingAccessCheck(policy: ChatAccessPolicy) {
  return async (input: { platform: "telegram" | "discord" | "slack"; userId: string; channelId: string }) =>
    policy.isAllowed({
      platform: input.platform,
      senderId: input.userId,
      conversationId: input.channelId,
    });
}

export function createSofiaMessagingHandler(options: SofiaMessagingHandlerOptions): SofiaMessagingHandler {
  const prefix = options.commandPrefix ?? "/run";
  if (!prefix.trim() || prefix.length > 128 || /[\r\n\0]/.test(prefix)) {
    throw new Error("commandPrefix must be a non-empty single-line command.");
  }
  const maxContext = Math.min(12_000, Math.max(500, options.maxConversationContextCharacters ?? 6_000));
  const sessions = new Map<string, string[]>();
  const modes = new Map<string, ConversationMode>();
  const loaded = new Set<string>();
  const loadQueues = new Map<string, Promise<void>>();
  const saveQueues = new Map<string, Promise<void>>();

  const persist = (conversationId: string) => {
    if (!options.sessionStore) return;
    const snapshot = {
      turns: [...(sessions.get(conversationId) ?? [])],
      mode: modes.get(conversationId) ?? "chat",
    };
    const previous = saveQueues.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => options.sessionStore!.save(conversationId, snapshot));
    saveQueues.set(conversationId, next);
    void next.catch(() => undefined);
  };

  const ensureLoaded = async (conversationId: string) => {
    if (loaded.has(conversationId)) return;
    const existing = loadQueues.get(conversationId);
    if (existing) return existing;
    const loading = (async () => {
      if (options.sessionStore) {
        try {
          const stored = await options.sessionStore.load(conversationId);
          if (stored) {
            sessions.set(conversationId, stored.turns.slice(-40));
            modes.set(conversationId, stored.mode);
          }
        } catch {
          // Persistence failure must not bypass access controls or stop chat service.
        }
      }
      if (!modes.has(conversationId)) modes.set(conversationId, "chat");
      loaded.add(conversationId);
      if (sessions.size > 500) {
        const oldest = sessions.keys().next().value;
        if (oldest !== undefined && oldest !== conversationId) {
          sessions.delete(oldest);
          modes.delete(oldest);
          loaded.delete(oldest);
          saveQueues.delete(oldest);
          loadQueues.delete(oldest);
        }
      }
    })();
    loadQueues.set(conversationId, loading);
    try {
      await loading;
    } finally {
      loadQueues.delete(conversationId);
    }
  };

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
    persist(conversationId);
    if (sessions.size > 500) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined && oldest !== conversationId) {
        sessions.delete(oldest);
        modes.delete(oldest);
        loaded.delete(oldest);
      }
    }
  };

  const handleCommand = createChatCommandHandler({
    client: options.client,
    accessPolicy: options.accessPolicy,
    deduplicator: options.deduplicator,
    maxTaskCharacters: options.maxTaskCharacters,
  });

  const onMessage = async (message: InboundMessage): Promise<string | void> => {
    const text = message.text.trim();
    if (!text) return;
    const conversationId = message.identity.conversationId;
    await ensureLoaded(conversationId);

    if (text === "/start" || text === "/help") {
      return [
        "Hi! I'm Sofia Agent 😊",
        "",
        "คุยกับฉันได้เหมือนคุยกับคน ไม่ต้องใส่ /run ทุกครั้ง",
        "• โหมด chat: พิมพ์คุยหรือถามต่อได้ตามธรรมชาติ",
        "• โหมด task: สั่งงานด้วย /run <task> หรือ /task <task>",
        "• เปลี่ยนโหมดด้วย /mode chat หรือ /mode task",
        "• /clear-context ล้างบริบทบทสนทนาที่เก็บไว้",
        "",
        "บริบทจะเก็บไว้ในเครื่องของบริการนี้เพื่อคุยต่อหลังรีสตาร์ตได้",
        "อย่าส่งรหัสผ่านหรือ API keys ในแชต",
      ].join("\n");
    }

    if (text === "/mode chat" || text === "/mode task") {
      const mode: ConversationMode = text.endsWith("task") ? "task" : "chat";
      modes.set(conversationId, mode);
      persist(conversationId);
      return mode === "chat"
        ? "เปลี่ยนเป็นโหมด chat แล้ว 😊 พิมพ์คุยหรือถามต่อได้ตามธรรมชาติ"
        : "เปลี่ยนเป็นโหมด task แล้ว งานใหม่ต้องขึ้นต้นด้วย /run หรือ /task เพื่อป้องกันการเริ่มงานโดยไม่ตั้งใจ";
    }

    if (text === "/clear-context") {
      sessions.delete(conversationId);
      persist(conversationId);
      return "ล้างบริบทบทสนทนาล่าสุดแล้ว การตั้งค่าโหมดยังคงเดิม";
    }

    const isConfiguredCommand = text === prefix || text.startsWith(prefix + " ") || text.startsWith(prefix + "\t");
    const isTaskAlias = text === "/task" || text.startsWith("/task ") || text.startsWith("/task\t");
    const hasPrefix = isConfiguredCommand || isTaskAlias;
    if (!hasPrefix) {
      const smallTalk = SMALL_TALK.find((entry) => entry.pattern.test(text));
      if (smallTalk) {
        appendTurn(conversationId, "User", text);
        appendTurn(conversationId, "Sofia", smallTalk.reply);
        return smallTalk.reply;
      }
    }
    if (!hasPrefix && (!options.acceptPlainTextTasks || modes.get(conversationId) === "task")) return;

    const task = isTaskAlias ? text.slice("/task".length).trim() : isConfiguredCommand ? text.slice(prefix.length).trim() : text;
    const transcript = (sessions.get(conversationId) ?? []).join("\n").slice(-maxContext);
    const mode = modes.get(conversationId) ?? "chat";
    const context = [
      `Messaging mode: ${mode}.`,
      mode === "chat"
        ? "Reply conversationally to the user's message. Ask a concise clarifying question when needed; do not assume the user requested file changes or other side effects unless clearly asked."
        : "The user explicitly selected task mode. Treat the message as a task request, follow the existing Sofia permission and approval policy, and verify work before claiming completion.",
      transcript,
    ].filter(Boolean).join("\n\n");

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
