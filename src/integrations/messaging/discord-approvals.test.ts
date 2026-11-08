import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteApprovalQueue } from "../../agent/approval-queue.js";
import { handleDiscordApprovalCommand } from "./discord-approvals.js";

test("Discord approval inbox and decisions are scoped to the verified Discord principal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sofia-discord-approvals-"));
  const queue = await SqliteApprovalQueue.open(path.join(directory, "approvals.sqlite"));
  const owner = "discord:123456789";
  const other = "discord:987654321";
  const pending = queue.create({
    runId: "run-discord-approval",
    principalId: owner,
    toolName: "workspace.write",
    input: {
      path: "notes.txt",
      operation: "write",
      apiKey: "do-not-display-this",
      payload: "Bearer hidden-token-value",
      note: "private customer information",
    },
    actionHash: "d".repeat(64),
    risk: "high",
  });
  try {
    const inbox = handleDiscordApprovalCommand(queue, owner, "/approvals");
    assert.match(inbox, new RegExp(pending.id));
    assert.match(inbox, /workspace\.write/);
    assert.match(inbox, /"path":"notes\.txt"/);
    assert.match(inbox, /"operation":"write"/);
    assert.doesNotMatch(inbox, /apiKey|payload|note|do-not-display-this|hidden-token-value|private customer information/);
    assert.equal(handleDiscordApprovalCommand(queue, other, "/approvals"), "You have no pending approvals.");
    assert.equal(handleDiscordApprovalCommand(queue, other, "/approve", pending.id),
      "Approval not found or not accessible to this Discord user.");
    assert.equal(queue.get(pending.id, owner)?.status, "pending");

    const approved = handleDiscordApprovalCommand(queue, owner, "/approve", pending.id);
    assert.match(approved, /Approval recorded/);
    assert.equal(queue.get(pending.id, owner)?.status, "approved");
    assert.match(handleDiscordApprovalCommand(queue, owner, "/approve", pending.id), /no longer pending/);
  } finally {
    queue.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Discord approval preview hides sensitive-looking paths and unsupported action fields", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sofia-discord-approvals-"));
  const queue = await SqliteApprovalQueue.open(path.join(directory, "approvals.sqlite"));
  const owner = "discord:123456789";
  queue.create({
    runId: "run-discord-preview-redaction",
    principalId: owner,
    toolName: "workspace.read",
    input: { path: ".env.production", command: "cat .env.production", url: "https://example.test/?token=secret" },
    actionHash: "f".repeat(64),
    risk: "medium",
  });
  try {
    const inbox = handleDiscordApprovalCommand(queue, owner, "/approvals");
    assert.match(inbox, /details hidden/);
    assert.doesNotMatch(inbox, /\.env\.production|cat \.env|token=secret/);
  } finally {
    queue.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Discord approval rejection and malformed IDs fail closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sofia-discord-approvals-"));
  const queue = await SqliteApprovalQueue.open(path.join(directory, "approvals.sqlite"));
  const owner = "discord:123456789";
  const pending = queue.create({
    runId: "run-discord-reject",
    principalId: owner,
    toolName: "workspace.delete",
    input: { path: "old.txt" },
    actionHash: "e".repeat(64),
    risk: "critical",
  });
  try {
    assert.match(handleDiscordApprovalCommand(queue, owner, "/reject", "not-an-id"), /valid approval ID/);
    assert.match(handleDiscordApprovalCommand(queue, owner, "/reject", pending.id), /rejected/);
    assert.equal(queue.get(pending.id, owner)?.status, "rejected");
    assert.match(handleDiscordApprovalCommand(queue, "api-key-owner", "/approvals"), /authenticated Discord user/);
  } finally {
    queue.close();
    await rm(directory, { recursive: true, force: true });
  }
});
