import assert from "node:assert/strict";
import test from "node:test";
import { CloudBrowserSessionManager } from "../browser/cloud-session-manager.js";
import type { BrowserRuntime } from "../browser/runtime.js";
import { createSofiaApi } from "./server.js";

const runtime: BrowserRuntime = {
  launch: async () => ({
    id: "cloud-session",
    newPage: async () => ({
      id: "cloud-page",
      url: async () => "https://example.com/",
      title: async () => "Example",
      content: async () => "<main>Example</main>",
      goto: async () => {},
      click: async () => {},
      type: async () => {},
      select: async () => {},
      scroll: async () => {},
      wait: async () => {},
      press: async () => {},
      back: async () => {},
      forward: async () => {},
      reload: async () => {},
      screenshot: async () => Buffer.from("png").toString("base64"),
      clickAt: async () => {},
      typeFocused: async () => {},
      viewportSize: async () => ({ width: 1280, height: 720 }),
      close: async () => {},
    }),
    close: async () => {},
  }),
};

test("mobile cloud browser API requires scope and isolates sessions by API-key owner", async () => {
  const manager = new CloudBrowserSessionManager(runtime);
  const server = createSofiaApi({
    provider: { generate: async () => ({ text: "unused" }) },
    router: { select: () => ({ id: "test", capabilities: ["fast"], costWeight: 1, latencyWeight: 1, qualityWeight: 1, healthy: true }), markUnhealthy: () => undefined },
    reviewer: { review: async () => ({ approved: true, reason: "unused" }) },
  }, {
    apiKeys: {
      "mobile-owner-key": ["browser:cloud"],
      "other-mobile-key": ["browser:cloud"],
      "missing-browser-scope": ["agent:read"],
    },
    cloudBrowserSessions: manager,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = "http://127.0.0.1:" + address.port;
  const request = (path: string, key: string, method = "GET", body?: unknown) => fetch(base + path, {
    method,
    headers: { authorization: "Bearer " + key, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await request("/v1/browser/cloud/sessions", "missing-browser-scope", "POST")).status, 403);
    const created = await request("/v1/browser/cloud/sessions", "mobile-owner-key", "POST");
    assert.equal(created.status, 201);
    const { session } = await created.json() as { session: { id: string } };
    assert.ok(session.id);

    assert.equal((await request("/v1/browser/cloud/sessions/" + session.id, "other-mobile-key")).status, 404);
    const status = await request("/v1/browser/cloud/sessions/" + session.id, "mobile-owner-key");
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { title: string }).title, "Example");

    const screenshot = await request("/v1/browser/cloud/sessions/" + session.id + "/screenshot", "mobile-owner-key");
    assert.equal(screenshot.status, 200);
    const screenshotBody = await screenshot.json() as { mimeType: string; width: number; height: number };\n    assert.equal(screenshotBody.mimeType, "image/png");\n    assert.equal(screenshotBody.width, 1280);\n    assert.equal(screenshotBody.height, 720);

    const action = await request("/v1/browser/cloud/sessions/" + session.id + "/action", "mobile-owner-key", "POST", { kind: "click", selector: "button" });
    assert.equal(action.status, 200);\n    const touch = await request("/v1/browser/cloud/sessions/" + session.id + "/action", "mobile-owner-key", "POST", { kind: "clickAt", x: 120, y: 80 });\n    assert.equal(touch.status, 200);
    assert.equal((await request("/v1/browser/cloud/sessions/" + session.id, "mobile-owner-key", "DELETE")).status, 200);
    assert.equal((await request("/v1/browser/cloud/sessions/" + session.id, "mobile-owner-key")).status, 404);
  } finally {
    await manager.closeAll();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
