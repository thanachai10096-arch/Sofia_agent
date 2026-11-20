import assert from "node:assert/strict";
import test from "node:test";
import { createAgentReachTools } from "./agent-reach.js";
import type { WorkspaceRuntime } from "../platform/runtime.js";

function harness(result: unknown = { code: 0, stdout: "ok" }) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runtime = {
    run: async (command: string, args: string[]) => {
      calls.push({ command, args });
      return result;
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

test("Agent-Reach adapter exposes only read-only network tools", () => {
  const { get } = harness();
  assert.deepEqual(get("internet.agent_reach.channels").effects, ["read", "network"]);
  assert.deepEqual(get("internet.agent_reach.read").effects, ["read", "network"]);
  assert.equal(get("internet.agent_reach.channels").inputSchema.additionalProperties, false);
});

test("channels invokes the CLI with a fixed argument array", async () => {
  const { calls, runtime, get } = harness();
  const result = await get("internet.agent_reach.channels").execute({}, { runtime });
  assert.deepEqual(calls, [{ command: "agent-reach", args: ["channels"] }]);
  assert.equal((result as { untrustedOutput: boolean }).untrustedOutput, true);
});

test("read invokes Agent-Reach with a validated public URL and marks output untrusted", async () => {
  const { calls, runtime, get } = harness();
  const result = await get("internet.agent_reach.read").execute(
    { url: "https://example.com/research?q=sofia" },
    { runtime },
  ) as { url: string; untrustedOutput: boolean; instruction: string };
  assert.deepEqual(calls, [{ command: "agent-reach", args: ["read", "https://example.com/research?q=sofia"] }]);
  assert.equal(result.untrustedOutput, true);
  assert.match(result.instruction, /untrusted reference material/);
});

test("read rejects non-HTTP schemes, credentials, localhost and private IPs before execution", async () => {
  const { calls, runtime, get } = harness();
  const tool = get("internet.agent_reach.read");
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@example.com/",
    "http://localhost/admin",
    "http://127.0.0.1/",
    "http://10.0.0.8/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://172.20.0.1/",
    "http://224.0.0.1/",
  ]) {
    await assert.rejects(tool.execute({ url }, { runtime }), undefined, url);
  }
  assert.equal(calls.length, 0);
});

test("read rejects IP literal destinations and malformed or oversized input", async () => {
  const { calls, runtime, get } = harness();
  const tool = get("internet.agent_reach.read");
  await assert.rejects(tool.execute({ url: "https://8.8.8.8/" }, { runtime }), /hostname/);
  await assert.rejects(tool.execute({ url: "not-a-url" }, { runtime }), /absolute public HTTP/);
  await assert.rejects(tool.execute({ url: "https://" + "a".repeat(2050) }, { runtime }), /2048/);
  assert.equal(calls.length, 0);
});
