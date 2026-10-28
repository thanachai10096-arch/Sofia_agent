import assert from "node:assert/strict";
import test from "node:test";
import { createMatrixClientTransport } from "./matrix-client-transport.js";

const token = "matrix-test-access-token";
test("Matrix transport requires a public HTTPS homeserver and a bounded token", () => {
  assert.throws(() => createMatrixClientTransport({ homeserverUrl: "http://matrix.example.org", accessToken: token }), /HTTPS/);
  assert.throws(() => createMatrixClientTransport({ homeserverUrl: "https://localhost", accessToken: token }), /HTTPS/);
  assert.throws(() => createMatrixClientTransport({ homeserverUrl: "https://matrix.example.org", accessToken: "bad\nvalue" }), /token/);
});

test("Matrix transport establishes a sync cursor before dispatching new text events", async () => {
  const controller = new AbortController();
  const requests: Array<{ url: string; auth: string | null }> = [];
  let syncCalls = 0;
  const transport = createMatrixClientTransport({
    homeserverUrl: "https://matrix.example.org",
    accessToken: token,
    syncTimeoutMs: 1_000,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      if (String(url).includes("/account/whoami")) return new Response(JSON.stringify({ user_id: "@sofia:example.org" }));
      syncCalls++;
      if (syncCalls === 1) {
        return new Response(JSON.stringify({
          next_batch: "baseline",
          rooms: { join: { "!room:example.org": { timeline: { events: [
            { event_id: "$old", sender: "@alice:example.org", type: "m.room.message", content: { msgtype: "m.text", body: "old history must not run" } },
          ] } } } },
        }));
      }
      return new Response(JSON.stringify({
        next_batch: "s2",
        rooms: { join: { "!room:example.org": { timeline: { events: [
          { event_id: "$own", sender: "@sofia:example.org", type: "m.room.message", content: { msgtype: "m.text", body: "ignore own message" } },
          { event_id: "$human", sender: "@alice:example.org", type: "m.room.message", origin_server_ts: 123, content: { msgtype: "m.text", body: "hello" } },
          { event_id: "$image", sender: "@alice:example.org", type: "m.room.message", content: { msgtype: "m.image", body: "ignore image" } },
        ] } } } },
      }));
    },
  });
  const received: Array<{ senderId: string; roomId: string; text: string }> = [];
  await transport.start(controller.signal, async (message) => {
    received.push({ senderId: message.senderId, roomId: message.roomId, text: message.text });
    controller.abort();
  });
  for (let i = 0; i < 20 && received.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await transport.stop();
  assert.deepEqual(received, [{ senderId: "@alice:example.org", roomId: "!room:example.org", text: "hello" }]);
  assert.ok(syncCalls >= 2);
  assert.ok(requests.every(request => request.auth === "Bearer " + token));
});

test("Matrix transport sends a text event using the configured server-side token", async () => {
  let request: { url: string; method?: string; auth: string | null; body: string } | undefined;
  const controller = new AbortController();
  const transport = createMatrixClientTransport({
    homeserverUrl: "https://matrix.example.org",
    accessToken: token,
    fetchImpl: async (url, init) => {
      if (String(url).includes("/account/whoami")) return new Response(JSON.stringify({ user_id: "@sofia:example.org" }));
      if (String(url).includes("/sync")) {
        return await new Promise<Response>((resolve) => {
          init?.signal?.addEventListener("abort", () => {
            resolve(new Response(JSON.stringify({ next_batch: "s1" })));
          }, { once: true });
        });
      }
      request = { url: String(url), method: init?.method, auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") };
      return new Response(JSON.stringify({ event_id: "$sent" }));
    },
  });
  await transport.start(controller.signal, async () => {});
  assert.deepEqual(await transport.sendMessage("!room:example.org", "hello"), { messageId: "$sent" });
  assert.equal(request?.method, "PUT");
  assert.equal(request?.auth, "Bearer " + token);
  assert.match(request?.url ?? "", /rooms\/!room%3Aexample.org\/send/);
  assert.deepEqual(JSON.parse(request?.body ?? "{}"), { msgtype: "m.text", body: "hello" });
  await transport.stop();
});


test("Matrix transport reports a failed delivery exactly once with its HTTP status", async () => {
  const diagnostics: Array<{ event: string; status?: number }> = [];
  const transport = createMatrixClientTransport({
    homeserverUrl: "https://matrix.example.org",
    accessToken: token,
    onError: (event, status) => diagnostics.push({ event, ...(status === undefined ? {} : { status }) }),
    fetchImpl: async (url, init) => {
      if (String(url).includes("/account/whoami")) {
        return new Response(JSON.stringify({ user_id: "@sofia:example.org" }));
      }
      if (String(url).includes("/sync")) {
        return await new Promise<Response>((resolve) => {
          init?.signal?.addEventListener("abort", () => {
            resolve(new Response(JSON.stringify({ next_batch: "s1" })));
          }, { once: true });
        });
      }
      return new Response(JSON.stringify({ errcode: "M_UNKNOWN" }), { status: 503 });
    },
  });
  await transport.start(new AbortController().signal, async () => {});
  await assert.rejects(() => transport.sendMessage("!room:example.org", "hello"), /delivery failed/i);
  assert.deepEqual(diagnostics.filter((item) => item.event === "delivery_failed"), [
    { event: "delivery_failed", status: 503 },
  ]);
  await transport.stop();
});

test("Matrix transport rejects DNS answers that point to private or loopback networks", async () => {
  for (const address of ["127.0.0.1", "10.2.3.4", "192.168.1.9", "169.254.169.254", "172.20.1.2", "::1", "fd00::1"]) {
    let fetchCalls = 0;
    const transport = createMatrixClientTransport({
      homeserverUrl: "https://matrix.example.org",
      accessToken: token,
      resolveHostname: async () => [address],
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ user_id: "@sofia:example.org" }));
      },
    });
    await assert.rejects(
      () => transport.start(new AbortController().signal, async () => {}),
      /non-public address/i,
      `should reject DNS result ${address}`,
    );
    assert.equal(fetchCalls, 0, `must not send the access token to ${address}`);
  }
});

test("Matrix transport rejects mixed public/private DNS answers", async () => {
  let fetchCalls = 0;
  const transport = createMatrixClientTransport({
    homeserverUrl: "https://matrix.example.org",
    accessToken: token,
    resolveHostname: async () => ["93.184.216.34", "10.0.0.8"],
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ user_id: "@sofia:example.org" }));
    },
  });
  await assert.rejects(
    () => transport.start(new AbortController().signal, async () => {}),
    /non-public address/i,
  );
  assert.equal(fetchCalls, 0);
});
