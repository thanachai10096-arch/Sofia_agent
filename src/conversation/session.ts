import { randomUUID } from "node:crypto";
import type {
  AppendMessageInput,
  ConversationContext,
  ConversationLimits,
  ConversationMessage,
  ConversationSession,
  ConversationStore,
} from "./types.js";

const DEFAULTS = {
  maxMessagesPerSession: 80,
  maxMessageCharacters: 20_000,
  maxContextCharacters: 24_000,
  maxListedSessions: 100,
} as const;

function resolveLimit(name: keyof typeof DEFAULTS, value: number | undefined): number {
  const resolved = value ?? DEFAULTS[name];
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 1_000_000) {
    throw new Error(`Invalid conversation limit: ${name}.`);
  }
  return resolved;
}

function cloneSession(session: ConversationSession): ConversationSession {
  return { ...session, messages: session.messages.map((message) => ({ ...message })) };
}

/** Volatile store for tests and single-process prototypes. Use a durable adapter for production. */
export class InMemoryConversationStore implements ConversationStore {
  private readonly sessions = new Map<string, ConversationSession>();

  get(id: string): ConversationSession | undefined {
    const session = this.sessions.get(id);
    return session ? cloneSession(session) : undefined;
  }

  save(session: ConversationSession): void {
    this.sessions.set(session.id, cloneSession(session));
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  listByOwner(ownerId: string): ConversationSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.ownerId === ownerId)
      .map(cloneSession)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

/**
 * Conversation foundation independent of the model provider and agent runtime.
 * Callers must pass a stable authenticated ownerId; never use a client-supplied
 * owner identifier without authenticating it first.
 */
export class ConversationService {
  private readonly maxMessages: number;
  private readonly maxMessageCharacters: number;
  private readonly maxContextCharacters: number;
  private readonly maxListedSessions: number;

  constructor(private readonly store: ConversationStore = new InMemoryConversationStore(), limits: ConversationLimits = {}) {
    this.maxMessages = resolveLimit("maxMessagesPerSession", limits.maxMessagesPerSession);
    this.maxMessageCharacters = resolveLimit("maxMessageCharacters", limits.maxMessageCharacters);
    this.maxContextCharacters = resolveLimit("maxContextCharacters", limits.maxContextCharacters);
    this.maxListedSessions = resolveLimit("maxListedSessions", limits.maxListedSessions);
  }

  create(ownerId: string, title = "New conversation"): ConversationSession {
    this.assertOwner(ownerId);
    const now = Date.now();
    const session: ConversationSession = {
      id: randomUUID(),
      ownerId,
      title: this.cleanText(title, 160, "title"),
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.store.save(session);
    return cloneSession(session);
  }

  get(ownerId: string, sessionId: string): ConversationSession | undefined {
    this.assertOwner(ownerId);
    const session = this.store.get(sessionId);
    return session?.ownerId === ownerId ? cloneSession(session) : undefined;
  }

  list(ownerId: string): ConversationSession[] {
    this.assertOwner(ownerId);
    return this.store.listByOwner(ownerId).slice(0, this.maxListedSessions).map(cloneSession);
  }

  validateAppend(ownerId: string, sessionId: string, input: AppendMessageInput): string {
    this.assertOwner(ownerId);
    if (!input || !["user", "assistant", "tool"].includes(input.role)) {
      throw new Error("Unsupported conversation message role.");
    }
    this.requireOwned(ownerId, sessionId);
    return this.cleanText(input.content, this.maxMessageCharacters, "message");
  }

  append(ownerId: string, sessionId: string, input: AppendMessageInput): ConversationMessage {
    const content = this.validateAppend(ownerId, sessionId, input);
    const session = this.requireOwned(ownerId, sessionId);
    const toolName = input.role === "tool" ? this.cleanText(input.toolName ?? "", 120, "tool name") : undefined;
    const message: ConversationMessage = {
      id: randomUUID(),
      role: input.role,
      content,
      createdAt: Date.now(),
      ...(toolName ? { toolName } : {}),
    };
    session.messages.push(message);
    if (session.messages.length > this.maxMessages) {
      session.messages.splice(0, session.messages.length - this.maxMessages);
    }
    if (session.messages.length === 1 && input.role === "user") {
      session.title = this.titleFrom(content);
    }
    session.updatedAt = message.createdAt;
    this.store.save(session);
    return { ...message };
  }

  /**
   * Bound assistant output for history persistence and suppress stale completions
   * if the originating user message was cleared while the model was running.
   */
  /** Remove one exact message when async admission fails before execution starts. */
  removeMessage(ownerId: string, sessionId: string, messageId: string): boolean {
    this.assertOwner(ownerId);
    const session = this.store.get(sessionId);
    if (!session || session.ownerId !== ownerId) return false;
    const index = session.messages.findIndex((message) => message.id === messageId);
    if (index < 0) return false;
    session.messages.splice(index, 1);
    const firstUserMessage = session.messages.find((message) => message.role === "user");
    session.title = firstUserMessage ? this.titleFrom(firstUserMessage.content) : "New conversation";
    session.updatedAt = Date.now();
    this.store.save(session);
    return true;
  }

  appendAssistantResponse(
    ownerId: string,
    sessionId: string,
    content: string,
    expectedUserMessageId?: string,
  ): ConversationMessage | undefined {
    const session = this.requireOwned(ownerId, sessionId);
    if (expectedUserMessageId && !session.messages.some((message) => message.id === expectedUserMessageId)) {
      return undefined;
    }
    const marker = "\n\n[Response truncated in conversation history.]";
    const suffix = this.maxMessageCharacters >= marker.length
      ? marker
      : this.maxMessageCharacters >= "[truncated]".length
        ? "[truncated]"
        : "…".repeat(this.maxMessageCharacters);
    const bounded = content.length <= this.maxMessageCharacters
      ? content
      : content.slice(0, Math.max(0, this.maxMessageCharacters - suffix.length)) + suffix;
    return this.append(ownerId, sessionId, { role: "assistant", content: bounded });
  }

  buildContext(ownerId: string, sessionId: string): ConversationContext {
    const session = this.requireOwned(ownerId, sessionId);
    const selected: ConversationMessage[] = [];
    let characters = 0;
    let truncated = false;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const message = session.messages[i];
      if (!message) continue;
      const cost = message.content.length + (message.toolName?.length ?? 0);
      if (characters + cost > this.maxContextCharacters) {
        truncated = true;
        // Keep recent context contiguous instead of selecting older fragments.
        break;
      }
      selected.push(message);
      characters += cost;
    }
    selected.reverse();
    if (selected.length < session.messages.length) truncated = true;
    return {
      sessionId: session.id,
      ownerId: session.ownerId,
      messages: selected.map(({ role, content, toolName }) => ({
        role, content, ...(toolName ? { toolName } : {}),
      })),
      truncated,
    };
  }

  delete(ownerId: string, sessionId: string): boolean {
    this.assertOwner(ownerId);
    const session = this.store.get(sessionId);
    if (!session || session.ownerId !== ownerId) return false;
    return this.store.delete(sessionId);
  }

  clear(ownerId: string, sessionId: string): ConversationSession {
    this.assertOwner(ownerId);
    const session = this.requireOwned(ownerId, sessionId);
    session.messages = [];
    session.title = "New conversation";
    session.updatedAt = Date.now();
    this.store.save(session);
    return cloneSession(session);
  }

  private requireOwned(ownerId: string, sessionId: string): ConversationSession {
    const session = this.store.get(sessionId);
    if (!session || session.ownerId !== ownerId) {
      // Do not disclose whether another user's session exists.
      throw new Error("Conversation not found.");
    }
    return session;
  }

  private assertOwner(ownerId: string): void {
    if (typeof ownerId !== "string" || ownerId.trim().length === 0 || ownerId.length > 256) {
      throw new Error("A valid authenticated ownerId is required.");
    }
  }

  private cleanText(value: string, max: number, label: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Conversation ${label} must not be empty.`);
    }
    if (value.length > max) throw new Error(`Conversation ${label} exceeds the configured limit.`);
    return value.trim();
  }

  private titleFrom(content: string): string {
    const normalized = content.replace(/\s+/g, " ").trim();
    return normalized.length > 64 ? normalized.slice(0, 61) + "..." : normalized;
  }
}
