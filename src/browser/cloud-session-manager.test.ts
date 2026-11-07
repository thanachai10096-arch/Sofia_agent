import assert from "node:assert/strict";
import test from "node:test";
import { CloudBrowserSessionManager } from "./cloud-session-manager.js";
import type { BrowserPage, BrowserRuntime, BrowserSession } from "./runtime.js";

function harness() {
  let now = 1_000_000;
  let closes = 0;
  let pageCounter = 0;
  const runtime: BrowserRuntime = {
    launch: async (options) => {
      assert.equal(options?.headless, true);
      const page: BrowserPage = {
        id: "page-" + (++pageCounter),
        url: async () => "https://example.com/",
        title: async () => "Example",
        content: async () => "<main>Example</main>",
        goto: async (url) => { assert.equal(url, "https://example.org/"); },
        click: async () => {},
        type: async () => {},
        select: async () => {},
        scroll: async () => {},
        wait: async () => {},
        press: async () => {},
        back: async () => {},
        forward: async () => {},
        reload: async () => {},
        screenshot: async () => Buffer.from("image").toString("base64"),
        close: async () => {},
      };
      return {
        id: "session-" + pageCounter,
        newPage: async () => page,
        close: async () => { closes++; },
      } satisfies BrowserSession;
    },
  };
  const manager = new CloudBrowserSessionManager(runtime, {
    now: () => now,
    idleTimeoutMs: 60_000,
    maxSessionsPerOwner: 1,
  });
  return { manager, advance: (ms: number) => { now += ms; }, closes: () => closes };
}

test("cloud browser sessions are private to their owner and expose screenshot/action primitives", async () => {
  const h = harness();
  const created = await h.manager.create("owner-a");
  assert.equal(created.url, "https://example.com/");
  await assert.rejects(h.manager.status("owner-b", created.id), /not found/);
  assert.deepEqual(await h.manager.observe("owner-a", created.id), {
    url: "https://example.com/", title: "Example", content: "<main>Example</main>",
  });
  assert.deepEqual(await h.manager.screenshot("owner-a", created.id), {
    imageBase64: Buffer.from("image").toString("base64"), mimeType: "image/png",
  });
  assert.deepEqual(await h.manager.navigate("owner-a", created.id, "https://example.org/"), {
    url: "https://example.com/", title: "Example",
  });
  assert.deepEqual(await h.manager.act("owner-a", created.id, { kind: "click", selector: "button" }), {
    ok: true, url: "https://example.com/",
  });
  await assert.rejects(h.manager.act("owner-a", created.id, { kind: "type", selector: "input", text: "x".repeat(5000) }), /Unsupported/);
  await h.manager.close("owner-a", created.id);
  assert.equal(h.closes(), 1);
  await assert.rejects(h.manager.status("owner-a", created.id), /not found/);
});

test("cloud browser enforces per-owner session limits and expires idle sessions", async () => {
  const h = harness();
  const first = await h.manager.create("owner-a");
  await assert.rejects(h.manager.create("owner-a"), /limit reached/);
  const secondOwner = await h.manager.create("owner-b");
  assert.ok(secondOwner.id);
  h.advance(60_001);
  const replacement = await h.manager.create("owner-a");
  assert.notEqual(replacement.id, first.id);
  assert.equal(h.closes(), 2);
  await h.manager.closeAll();
  assert.equal(h.closes(), 3);
});

test("cloud browser rejects malformed identifiers and oversized screenshots", async () => {
  const runtime: BrowserRuntime = {
    launch: async () => ({
      id: "large",
      newPage: async () => ({
        id: "large-page", url: async () => "https://example.com/", title: async () => "Example",
        content: async () => "", goto: async () => {}, click: async () => {}, type: async () => {},
        select: async () => {}, scroll: async () => {}, wait: async () => {}, press: async () => {},
        back: async () => {}, forward: async () => {}, reload: async () => {},
        screenshot: async () => Buffer.alloc(70_000).toString("base64"), close: async () => {},
      }),
      close: async () => {},
    }),
  };
  const manager = new CloudBrowserSessionManager(runtime, { maxScreenshotBytes: 64 * 1024 });
  await assert.rejects(manager.status("owner", "bad-id"), /not found/);
  const session = await manager.create("owner");
  await assert.rejects(manager.screenshot("owner", session.id), /too large/);
  await manager.closeAll();
});
