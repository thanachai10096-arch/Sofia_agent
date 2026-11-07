import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = readFileSync(new URL("../../web/mobile-workspace/service-worker.js", import.meta.url), "utf8");

function harness(fetcher: typeof fetch = fetch) {
  const handlers = new Map<string, (event: any) => void>();
  const cachedAssets: string[][] = [];
  const cache = { addAll: async (assets: string[]) => { cachedAssets.push(assets); }, put: async () => undefined };
  const cacheApi = {
    open: async () => cache,
    keys: async () => ["sofia-mobile-workspace-v1", "sofia-mobile-workspace-v2"],
    delete: async () => true,
    match: async () => undefined,
  };
  const scope = {
    location: { origin: "https://sofia.example.test" },
    clients: { claim: async () => undefined },
    skipWaiting: async () => undefined,
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
  };
  runInNewContext(source, { self: scope, caches: cacheApi, fetch: fetcher, URL, Response, Promise });
  return { handlers, cachedAssets };
}

test("workspace service worker caches only public static assets, never HTML", async () => {
  const { handlers, cachedAssets } = harness();
  let installPromise: Promise<unknown> | undefined;
  handlers.get("install")!({ waitUntil: (promise: Promise<unknown>) => { installPromise = promise; } });
  await installPromise;
  assert.equal(cachedAssets.length, 1);
  assert.ok(cachedAssets[0]!.includes("./workspace.css"));
  assert.ok(cachedAssets[0]!.includes("./login.js"));
  assert.ok(!cachedAssets[0]!.some(asset => asset.endsWith(".html") || asset === "./"));
});

test("workspace navigation never falls back to a cached authenticated page", async () => {
  const { handlers } = harness(async () => { throw new Error("offline"); });
  let responsePromise: Promise<Response> | undefined;
  handlers.get("fetch")!({
    request: new Request("https://sofia.example.test/workspace/index.html", { mode: "navigate" }),
    respondWith: (promise: Promise<Response>) => { responsePromise = promise; },
  });
  const response = await responsePromise!;
  assert.equal(response.status, 503);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.match(await response.text(), /Reconnect to sign in/);
});
