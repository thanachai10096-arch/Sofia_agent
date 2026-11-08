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
    input: { path: "notes.txt", apiKey: "do-not-display-this", operation: "write" },
    actionHash: "d".repeat(64),
    risk: "high",
  });
  try {
    const inbox = handleDiscordApprovalCommand(queue, owner, "/approvals");
    assert.match(inbox, new RegExp(pending.id));
    assert.match(inbox, /workspace\.write/);
    assert.match(inbox, /"path":"notes.txt"/);
    assert.match(inbox, /"apiKey":"\[redacted\]"/);
    assert.doesNotMatch(inbox, /do-not-display-this/);
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
