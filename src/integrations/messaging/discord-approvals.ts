import type { SqliteApprovalQueue } from "../../agent/approval-queue.js";

/**
 * Discord approval commands are bound to the verified Discord principal.
 * The action hash is read from the owner-scoped durable record, never supplied
 * by the chat user, and the queue performs the atomic one-time decision.
 *
 * Approval previews deliberately expose only a tiny, low-risk summary. Tool
 * arguments are untrusted and may contain credentials under arbitrary keys;
 * key-name redaction alone cannot safely classify every possible secret.
 */
function safeApprovalInput(input: Record<string, unknown>): string {
  const preview: Record<string, string> = {};
  const path = input.path;
  if (typeof path === "string" && path.length <= 160 &&
      /^[A-Za-z0-9_./ -]+$/.test(path) &&
      !/(^|[/.])(?:\.env(?:\.|$)|credentials?|secrets?|id_rsa|id_ed25519)(?:$|[/.])/i.test(path)) {
    preview.path = path;
  }
  const operation = input.operation;
  if (typeof operation === "string" &&
      /^(?:read|write|create|update|delete|move|copy|list|search|fetch|download|upload)$/i.test(operation)) {
    preview.operation = operation;
  }
  return Object.keys(preview).length
    ? JSON.stringify(preview)
    : "[details hidden; review the secure approval inbox]";
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
      "\n  Action summary: " + safeApprovalInput(item.input) +
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
