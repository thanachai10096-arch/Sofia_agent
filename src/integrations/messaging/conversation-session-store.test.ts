import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileConversationSessionStore } from "./conversation-session-store.js";

test("file session store persists bounded turns and mode across instances", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sofia-session-test-"));
  try {
    const first = new FileConversationSessionStore(directory);
    await first.save("private-chat-id", {
      turns: ["User: hello", "Sofia: hi"],
      mode: "task",
    });
    const second = new FileConversationSessionStore(directory);
    assert.deepEqual(await second.load("private-chat-id"), {
      turns: ["User: hello", "Sofia: hi"],
      mode: "task",
    });
    assert.equal(await second.load("unknown-chat"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file session store caps transcript length and rejects invalid session modes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sofia-session-test-"));
  try {
    const store = new FileConversationSessionStore(directory);
    await store.save("chat", {
      turns: Array.from({ length: 80 }, (_, index) => `User: turn-${index} ${"x".repeat(1500)}`),
      mode: "chat",
    });
    const restored = await store.load("chat");
    assert.ok(restored);
    assert.ok(restored.turns.length <= 40);
    assert.ok(restored.turns.join("\n").length <= 6_000);
    await assert.rejects(
      () => store.save("chat", { turns: [], mode: "invalid" as "chat" }),
      /Invalid conversation mode/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
