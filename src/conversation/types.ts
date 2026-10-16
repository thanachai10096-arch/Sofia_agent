export type ConversationRole = "user" | "assistant" | "tool";

export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  content: string;
  createdAt: number;
  /** Optional tool name for tool-result messages; never treated as trusted instructions. */
  toolName?: string;
}

export interface ConversationSession {
  id: string;
  ownerId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ConversationMessage[];
}

export interface ConversationStore {
  get(id: string): ConversationSession | undefined;
  save(session: ConversationSession): void;
  delete(id: string): boolean;
  listByOwner(ownerId: string): ConversationSession[];
}

export interface ConversationLimits {
  /** Maximum persisted messages per session. Oldest messages are trimmed first. */
  maxMessagesPerSession?: number;
  /** Maximum characters in a single message. */
  maxMessageCharacters?: number;
  /** Maximum characters included in a model context. */
  maxContextCharacters?: number;
  /** Maximum sessions returned by list(). */
  maxListedSessions?: number;
}

export interface AppendMessageInput {
  role: ConversationRole;
  content: string;
  toolName?: string;
}

export interface ConversationContext {
  sessionId: string;
  ownerId: string;
  messages: Array<Pick<ConversationMessage, "role" | "content"> & { toolName?: string }>;
  truncated: boolean;
}
