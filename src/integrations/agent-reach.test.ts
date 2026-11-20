import assert from "node:assert/strict";
import test from "node:test";
import { createAgentReachTools } from "./agent-reach.js";
import type { WorkspaceRuntime } from "../platform/runtime.js";

function harness(payload: unknown = { ok: true, items: [] }, code = 0) {
  const calls: Array<{ command: string; args: string[]; options?: { timeoutMs?: number; allowNetwork?: boolean } }> = [];
  const runtime = {
    platform: "linux",
    run: async (command: string, args: string[], options?: { timeoutMs?: number }) => {
      calls.push({ command, args, options });
      return { code, stdout: JSON.stringify(payload), stderr: "" };
    },
  } as unknown as WorkspaceRuntime;
  const tools = createAgentReachTools();
  const get = (name: string) => {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, "missing tool " + name);
    return tool;
  };
  return { calls, runtime, get };
}

test("channel discovery is local while web reads and platform actions require network permission", () => {
  const { get } = harness();
  assert.deepEqual(get("internet.reach.channels").effects, ["read"]);
  assert.deepEqual(get("internet.reach.read").effects, ["read", "network"]);
  assert.deepEqual(get("internet.reach.action").effects, ["read", "network"]);
});

test("channel discovery runs the vendored Python bridge, not an external CLI", async () => {
  const { calls, runtime, get } = harness({ ok: true, channels: [] });
  const result = await get("internet.reach.channels").execute({}, { runtime }) as { untrustedOutput: boolean };
  assert.equal(calls[0]?.command, "python3");
  assert.equal(calls[0]?.args[0], "vendor/agent-reach/sofia_bridge.py");
  assert.equal(calls[0]?.args[1], "--request-json");
  assert.equal(calls[0]?.options?.allowNetwork, true);
  assert.deepEqual(JSON.parse(calls[0]!.args[2]!), { operation: "channels" });
  assert.equal(result.untrustedOutput, true);
});

test("read passes a validated URL to the embedded bridge and marks output untrusted", async () => {
  const { calls, runtime, get } = harness({ ok: true, items: [{ title: "Example" }] });
  const result = await get("internet.reach.read").execute(
    { url: "https://example.com/research?q=sofia" }, { runtime },
  ) as { url: string; untrustedOutput: boolean; instruction: string };
  assert.deepEqual(JSON.parse(calls[0]!.args[2]!), {
    operation: "read", url: "https://example.com/research?q=sofia", timeout: 30,
  });
  assert.equal(result.untrustedOutput, true);
  assert.match(result.instruction, /untrusted reference data/);
});

test("generic channel action is routed through the vendored package", async () => {
  const { calls, runtime, get } = harness({ ok: true, items: [] });
  await get("internet.reach.action").execute({
    channel: "github", url: "https://github.com/", action: "search", params: { query: "sofia agent" },
  }, { runtime });
  assert.deepEqual(JSON.parse(calls[0]!.args[2]!), {
    channel: "github", url: "https://github.com/", action: "search", params: { query: "sofia agent" }, timeout: 30,
  });
});

test("mutating actions are blocked before invoking the embedded package", async () => {
  const { calls, runtime, get } = harness();
  await assert.rejects(get("internet.reach.action").execute({
    channel: "twitter", url: "https://x.com/", action: "post", params: { text: "hello" },
  }, { runtime }), /not enabled/);
  assert.equal(calls.length, 0);
});

test("read rejects non-HTTP schemes, credentials, local and IP-literal destinations", async () => {
  const { calls, runtime, get } = harness();
  const tool = get("internet.reach.read");
  for (const url of [
    "file:///etc/passwd", "javascript:alert(1)", "https://user:pass@example.com/",
    "http://localhost/admin", "http://127.0.0.1/", "http://10.0.0.8/",
    "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/",
    "http://172.20.0.1/", "http://224.0.0.1/", "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
  ]) await assert.rejects(tool.execute({ url }, { runtime }), undefined, url);
  await assert.rejects(tool.execute({ url: "https://8.8.8.8/" }, { runtime }), /IP-literal/);
  await assert.rejects(tool.execute({ url: "not-a-url" }, { runtime }), /absolute public HTTP/);
  await assert.rejects(tool.execute({ url: "https://" + "a".repeat(2050) }, { runtime }), /2048/);
  assert.equal(calls.length, 0);
});

test("non-zero bridge exits become tool errors", async () => {
  const { runtime, get } = harness({ ok: false, error: { message: "bridge unavailable" } }, 1);
  await assert.rejects(get("internet.reach.channels").execute({}, { runtime }), /bridge unavailable/);
});
