import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import { createChatCommandHandler, type VerifiedChatCommand } from "./chat-adapter.js";

const message = (overrides: Partial<VerifiedChatCommand> = {}): VerifiedChatCommand => ({
  platform: "telegram",
  messageId: "message-1",
  senderId: "user-1",
  conversationId: "chat-1",
  command: "run",
  task: "  inspect the repository  ",
  ...overrides,
});

function harness(options: { allowed?: boolean; failStart?: boolean; maxTaskCharacters?: number } = {}) {
  const claimed = new Set<string>();
  const started: Array<{ task: string; context?: string }> = [];
  let released = 0;
  const handler = createChatCommandHandler({
    client: {
      async start(input) {
        if (options.failStart) throw new Error("API unavailable");
        started.push(input);
        return { id: "run-123", status: "queued" };
      },
    },
    accessPolicy: { isAllowed: () => options.allowed ?? true },
    deduplicator: {
      claim(key) {
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
      release(key) {
        claimed.delete(key);
        released++;
      },
    },
    ...(options.maxTaskCharacters ? { maxTaskCharacters: options.maxTaskCharacters } : {}),
  });
  return { handler, started, get released() { return released; } };
}

test("dispatches a verified command through the shared Sofia client", async () => {
  const h = harness();
  assert.deepEqual(await h.handler(message()), {
    status: "accepted", runId: "run-123", runStatus: "queued",
  });
  assert.equal(h.started[0]?.task, "inspect the repository");
  assert.match(h.started[0]?.context ?? "", /telegram chat integration/);
});

test("rejects senders not allowed by the configured access policy", async () => {
  const h = harness({ allowed: false });
  assert.deepEqual(await h.handler(message()), { status: "forbidden" });
  assert.equal(h.started.length, 0);
});

test("deduplicates provider message IDs within a conversation", async () => {
  const h = harness();
  assert.equal((await h.handler(message())).status, "accepted");
  assert.deepEqual(await h.handler(message()), { status: "duplicate" });
  assert.equal(h.started.length, 1);
});

test("does not collide when message IDs match across conversations", async () => {
  const h = harness();
  assert.equal((await h.handler(message())).status, "accepted");
  assert.equal((await h.handler(message({ conversationId: "chat-2" }))).status, "accepted");
  assert.equal(h.started.length, 2);
});

test("rejects empty and oversized tasks before creating a run", async () => {
  const h = harness({ maxTaskCharacters: 8 });
  assert.deepEqual(await h.handler(message({ task: "  " })), { status: "rejected", reason: "empty_task" });
  assert.deepEqual(await h.handler(message({ task: "task that is too long" })), { status: "rejected", reason: "task_too_long" });
  assert.equal(h.started.length, 0);
});

test("releases the dedupe claim when the Sofia API call fails", async () => {
  const h = harness({ failStart: true });
  await assert.rejects(h.handler(message()), /API unavailable/);
  assert.equal(h.released, 1);
});

test("ignores commands not intended for Sofia", async () => {
  const h = harness();
  assert.deepEqual(await h.handler(message({ command: "help" })), { status: "ignored" });
  assert.equal(h.started.length, 0);
});

test("signs the verified chat origin and binds the signature to the task", async () => {
  const secret = "test-only-secret-value-with-at-least-32-characters";
  let captured: { messagingContext?: { platform: string; userId: string; conversationId: string; messageId: string; taskHash: string; signature: string } } | undefined;
  const handler = createChatCommandHandler({
    client: {
      async start(_input, _signal, options) {
        captured = options;
        return { id: "run-signed", status: "queued" };
      },
    },
    accessPolicy: { isAllowed: () => true },
    deduplicator: { claim: () => true, release: () => undefined },
    messagingContextSecret: secret,
  });
  const result = await handler(message({ task: "check project status" }));
  assert.deepEqual(result, { status: "accepted", runId: "run-signed", runStatus: "queued" });
  const context = captured?.messagingContext;
  assert.ok(context);
  const unsigned = {
    platform: "telegram",
    userId: "user-1",
    conversationId: "chat-1",
    messageId: "message-1",
    taskHash: createHash("sha256").update("check project status").digest("hex"),
  };
  assert.deepEqual(
    { platform: context.platform, userId: context.userId, conversationId: context.conversationId, messageId: context.messageId, taskHash: context.taskHash },
    unsigned,
  );
  assert.equal(context.signature, createHmac("sha256", secret).update(JSON.stringify(unsigned)).digest("hex"));
});

test("omits trusted messaging metadata when the bridge secret is not configured", async () => {
  let captured: { messagingContext?: unknown } | undefined;
  const handler = createChatCommandHandler({
    client: {
      async start(_input, _signal, options) {
        captured = options;
        return { id: "run-no-secret", status: "queued" };
      },
    },
    accessPolicy: { isAllowed: () => true },
    deduplicator: { claim: () => true, release: () => undefined },
  });
  await handler(message({ task: "check project status" }));
  assert.equal(captured?.messagingContext, undefined);
});
