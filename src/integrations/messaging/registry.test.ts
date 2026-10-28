import assert from "node:assert/strict";
import test from "node:test";
import { createMessagingAdapterRegistry } from "./registry.js";
import type { MessagingAdapter } from "./types.js";

function adapter(platform: string): MessagingAdapter {
  return {
    platform,
    async start() {},
    async send() { return { state: "sent" }; },
    async stop() {},
  };
}

test("registry exposes only concrete adapters passed to it", () => {
  const telegram = adapter("telegram");
  const discord = adapter("discord");
  const registry = createMessagingAdapterRegistry([telegram, discord]);

  assert.equal(registry.get("telegram"), telegram);
  assert.equal(registry.get("discord"), discord);
  assert.equal(registry.get("whatsapp"), undefined);
  assert.equal(registry.has("whatsapp"), false);
  assert.deepEqual(registry.list(), [
    { platform: "telegram", status: "registered" },
    { platform: "discord", status: "registered" },
  ]);
});

test("registry rejects duplicate platform adapters", () => {
  assert.throws(
    () => createMessagingAdapterRegistry([adapter("telegram"), adapter("telegram")]),
    /Duplicate messaging adapter platform: telegram/,
  );
});

test("registry rejects malformed platform identifiers", () => {
  for (const platform of ["", "Telegram", "line messaging", "../slack", "slack/evil"]) {
    assert.throws(
      () => createMessagingAdapterRegistry([adapter(platform)]),
      /lowercase kebab-case identifier/,
    );
  }
});

test("registry returns an immutable registration snapshot", () => {
  const registry = createMessagingAdapterRegistry([adapter("line")]);
  const listed = registry.list();

  assert.throws(() => (listed as unknown as Array<unknown>).push({ platform: "fake", status: "registered" }));
  assert.deepEqual(registry.list(), [{ platform: "line", status: "registered" }]);
});
