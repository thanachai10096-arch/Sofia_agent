import type { ApprovalHandler, ApprovalRequest } from "../../agent/approval.js";
import { redactSecrets } from "../../security/guard.js";

export interface DiscordApprovalReply {
  channelId: string;
  authorId: string;
  content: string;
}

type Decision = "approved" | "denied";
type ReplyResult = Decision | "not_found" | "unauthorized" | "action_mismatch" | "invalid";

interface PendingApproval {
  request: ApprovalRequest;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(decision: boolean): void;
  settled: boolean;
  abort?: () => void;
}

export interface DiscordApprovalBroker {
  handle: ApprovalHandler;
  respond(reply: DiscordApprovalReply): ReplyResult | null;
  close(): void;
}

/**
 * One-process, single-use approval broker for authenticated Discord messages.
 * A decision must come from the same Discord user and channel that initiated
 * the job and must include the exact action hash displayed in the prompt.
 * Restart, timeout, cancellation, delivery failure, or mismatch all fail closed.
 */
export function createDiscordApprovalBroker(options: {
  sendMessage(channelId: string, text: string): Promise<unknown>;
  timeoutMs?: number;
  maxPending?: number;
}): DiscordApprovalBroker {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxPending = options.maxPending ?? 128;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 10 * 60_000) {
    throw new Error("Discord approval timeout must be between 5 seconds and 10 minutes.");
  }
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 1_000) {
    throw new Error("Discord approval capacity must be between 1 and 1000.");
  }
  const pending = new Map<string, PendingApproval>();

  const settle = (id: string, item: PendingApproval, decision: boolean): void => {
    if (item.settled) return;
    item.settled = true;
    clearTimeout(item.timer);
    if (item.abort) item.request.signal?.removeEventListener("abort", item.abort);
    pending.delete(id);
    item.resolve(decision);
  };

  const handle: ApprovalHandler = async (request) => {
    const channelId = request.notificationChannelId;
    const principalId = request.principalId;
    // Never infer a Discord identity from a caller-supplied channel alone.
    if (!channelId || !/^\d{1,24}$/.test(channelId) ||
        !principalId || !/^discord:\d{1,24}$/.test(principalId) ||
        !request.requestId || !/^[0-9a-f-]{36}$/i.test(request.requestId) ||
        !/^[0-9a-f]{64}$/i.test(request.actionHash) ||
        request.signal?.aborted || pending.size >= maxPending || pending.has(request.requestId)) {
      return false;
    }

    const safeInput = redactSecrets(request.input);
    const serializedInput = JSON.stringify(safeInput) ?? "[unavailable]";
    const prompt = [
      "Sofia is requesting approval for a privileged action.",
      "Tool: " + request.toolName,
      "Risk: " + request.risk,
      "Action: " + (serializedInput.length > 1_200 ? serializedInput.slice(0, 1_200) + "…" : serializedInput),
      "Request ID: " + request.requestId,
      "Action hash: " + request.actionHash,
      "Reply in this same channel as:",
      "/approve " + request.requestId + " " + request.actionHash,
      "or /deny " + request.requestId + " " + request.actionHash,
      "This request expires in " + Math.ceil(timeoutMs / 1000) + " seconds. A mismatch or timeout denies it.",
    ].join("\n");

    let resolveDecision!: (decision: boolean) => void;
    const decision = new Promise<boolean>((resolve) => { resolveDecision = resolve; });
    const item: PendingApproval = {
      request,
      expiresAt: Date.now() + timeoutMs,
      timer: setTimeout(() => settle(request.requestId, item, false), timeoutMs),
      resolve: resolveDecision,
      settled: false,
    };
    item.timer.unref?.();
    pending.set(request.requestId, item);
    item.abort = () => settle(request.requestId, item, false);
    request.signal?.addEventListener("abort", item.abort, { once: true });
    if (request.signal?.aborted) {
      item.abort();
      return false;
    }

    try {
      await options.sendMessage(channelId, prompt);
    } catch {
      settle(request.requestId, item, false);
      return false;
    }
    return decision;
  };

  return {
    handle,
    respond(reply) {
      const match = /^\/(approve|deny)\s+([0-9a-f-]{36})\s+([0-9a-f]{64})$/i.exec(reply.content.trim());
      if (!match) return null;
      const id = match[2];
      const actionHash = match[3].toLowerCase();
      const item = pending.get(id);
      if (!item) return "not_found";
      if (item.expiresAt <= Date.now()) {
        settle(id, item, false);
        return "not_found";
      }
      if (item.request.notificationChannelId !== reply.channelId ||
          item.request.principalId !== "discord:" + reply.authorId) return "unauthorized";
      if (item.request.actionHash.toLowerCase() !== actionHash) return "action_mismatch";
      const approved = match[1].toLowerCase() === "approve";
      settle(id, item, approved);
      return approved ? "approved" : "denied";
    },
    close() {
      for (const [id, item] of pending) settle(id, item, false);
    },
  };
}
