import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import path from "node:path";

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Unexpected test server address"));
      resolve(address.port);
    });
  });
}
function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function waitForChat(url: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) throw new Error("Web Chat bridge exited before becoming ready.");
    try { const response = await fetch(url); if (response.ok) return; } catch { /* wait for bind */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Web Chat bridge did not become ready.");
}

test("Web Chat bridge keeps the API key server-side and rejects cross-origin requests", async () => {
  let receivedAuthorization = "";
  const upstream = createServer((req, res) => {
    receivedAuthorization = req.headers.authorization ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/health") res.end(JSON.stringify({ ok: true }));
    else if (req.url === "/v1/settings/model") res.end(JSON.stringify({ modelSelection: "auto", source: "default" }));
    else res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  const secret = "test-only-sofia-api-key-must-not-reach-browser";
  const child = spawn(process.execPath, [path.resolve("scripts/web-chat-server.mjs")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SOFIA_API_URL: "http://127.0.0.1:" + upstreamPort,
      SOFIA_API_KEY: secret,
      SOFIA_WEB_CHAT_HOST: "127.0.0.1",
      SOFIA_WEB_CHAT_PORT: String(port),
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const base = "http://127.0.0.1:" + port;
  try {
    await waitForChat(base + "/", child);
    const html = await (await fetch(base + "/")).text();
    const script = await (await fetch(base + "/chat.js")).text();
    assert.match(html, /Sofia Agent/);
    assert.doesNotMatch(html, new RegExp(secret));
    assert.doesNotMatch(script, new RegExp(secret));

    const preference = await fetch(base + "/bridge/model");
    assert.equal(preference.status, 200);
    assert.deepEqual(await preference.json(), { modelSelection: "auto", source: "default" });
    assert.equal(receivedAuthorization, "Bearer " + secret);

    const crossOrigin = await fetch(base + "/bridge/model", { headers: { origin: "https://attacker.example" } });
    assert.equal(crossOrigin.status, 403);
  } finally {
    child.kill("SIGTERM");
    await close(upstream);
  }
});
