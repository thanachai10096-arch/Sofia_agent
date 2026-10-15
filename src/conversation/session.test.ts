import test from "node:test";
import assert from "node:assert/strict";
import { ConversationService, InMemoryConversationStore } from "./session.js";

test("creates sessions and builds recent chronological context", () => {
  const service = new ConversationService();
  const session = service.create("user-1");
  service.append("user-1", session.id, { role: "user", content: "Please inspect this project" });
  service.append("user-1", session.id, { role: "assistant", content: "I will inspect it first." });
  const context = service.buildContext("user-1", session.id);
  assert.deepEqual(context.messages.map((message) => message.role), ["user", "assistant"]);
  assert.equal(service.get("user-1", session.id)?.title, "Please inspect this project");
});

test("does not reveal or permit access to another owner's session", () => {
  const service = new ConversationService();
  const session = service.create("alice");
  assert.equal(service.get("bob", session.id), undefined);
  assert.equal(service.delete("bob", session.id), false);
  assert.throws(() => service.append("bob", session.id, { role: "user", content: "steal context" }), /not found/i);
  assert.equal(service.get("alice", session.id)?.messages.length, 0);
});

test("trims old messages and bounds the model context", () => {
  const service = new ConversationService(new InMemoryConversationStore(), {
    maxMessagesPerSession: 3,
    maxMessageCharacters: 100,
    maxContextCharacters: 8,
  });
  const session = service.create("user-1");
  for (const content of ["old", "middle", "recent", "last"]) {
    service.append("user-1", session.id, { role: "user", content });
  }
  const stored = service.get("user-1", session.id);
  assert.deepEqual(stored?.messages.map((message) => message.content), ["middle", "recent", "last"]);
  const context = service.buildContext("user-1", session.id);
  assert.deepEqual(context.messages.map((message) => message.content), ["last"]);
  assert.equal(context.truncated, true);
});

test("clear removes messages and resets title; delete removes the session", () => {
  const service = new ConversationService();
  const session = service.create("user-1");
  service.append("user-1", session.id, { role: "user", content: "Remember this conversation" });
  const cleared = service.clear("user-1", session.id);
  assert.equal(cleared.messages.length, 0);
  assert.equal(cleared.title, "New conversation");
  assert.equal(service.delete("user-1", session.id), true);
  assert.equal(service.get("user-1", session.id), undefined);
});

test("rejects invalid owners, empty messages, and oversized messages", () => {
  const service = new ConversationService(new InMemoryConversationStore(), { maxMessageCharacters: 5 });
  assert.throws(() => service.create(" "), /ownerId/i);
  const session = service.create("user-1");
  assert.throws(() => service.append("user-1", session.id, { role: "user", content: " " }), /empty/i);
  assert.throws(() => service.append("user-1", session.id, { role: "user", content: "too long" }), /limit/i);
});
