import type { SqliteApprovalQueue } from "../../agent/approval-queue.js";

/**
 * Discord approval commands are bound to the verified Discord principal.
 * The action hash is read from the owner-scoped durable record, never supplied
 * by the chat user, and the queue performs the atomic one-time decision.
 */
function safeApprovalInput(input: Record<string, unknown>): string {
  const sensitive = /secret|token|password|authorization|api[_-]?key|credential|cookie|private[_-]?key/i;
  const redact = (value: unknown, depth: number): unknown => {
    if (depth > 4) return "[truncated]";
    if (Array.isArray(value)) return value.slice(0, 8).map((item) => redact(item, depth + 1));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 20).map(([key, item]) =>
        [key, sensitive.test(key) ? "[redacted]" : redact(item, depth + 1)]));
    }
    if (typeof value === "string") return value.length > 180 ? value.slice(0, 177) + "..." : value;
    if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
    return String(value).slice(0, 80);
  };
  try {
    return JSON.stringify(redact(input, 0)).slice(0, 650);
  } catch {
    return "[input preview unavailable]";
  }
}

export function handleDiscordApprovalCommand(
  queue: Pick<SqliteApprovalQueue, "list" | "get" | "decide">,
  principalId: string,
  command: "/approvals" | "/approve" | "/reject",
  argument = "",
): string {
  if (!principalId.startsWith("discord:") || principalId.length > 256) {
    return "Approval commands require an authenticated Discord user.";
  }

  if (command === "/approvals") {
    const pending = queue.list(principalId, { limit: 10 });
    if (!pending.length) return "You have no pending approvals.";
    const lines = pending.map((item) =>
      "- " + item.toolName + " (" + item.risk + ")\n  ID: " + item.id +
      "\n  Expires: " + new Date(item.expiresAt).toISOString() +
      "\n  Decide: /approve job_id:" + item.id + " or /reject job_id:" + item.id
    );
    const remaining = queue.list(principalId, { limit: 11 }).length > 10;
    return ("Your pending approvals:\n" + lines.join("\n") +
      (remaining ? "\nMore approvals are pending; use the API inbox for pagination." : "")).slice(0, 1_850);
  }

  const approvalId = argument.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(approvalId)) {
    return "Provide a valid approval ID: /" + command.slice(1) + " job_id:<approval-id>.";
  }
  const pending = queue.get(approvalId, principalId);
  if (!pending) return "Approval not found or not accessible to this Discord user.";
  if (pending.status !== "pending") return "This approval is no longer pending (" + pending.status + ").";
  const decision = queue.decide({
    id: pending.id,
    ownerId: principalId,
    decidedBy: principalId,
    actionHash: pending.actionHash,
    approved: command === "/approve",
  });
  if (!decision) return "Approval expired or changed before the decision could be recorded. No action was approved.";
  return decision.status === "approved"
    ? "Approval recorded. Sofia may continue the exact approved action.\nApproval ID: " + decision.id
    : "Approval rejected. Sofia will not perform this action.\nApproval ID: " + decision.id;
}
