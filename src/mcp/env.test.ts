import assert from "node:assert/strict";
import test from "node:test";
import { connectMcpFromEnv } from "./env.js";
import { defaultPolicy } from "../security/policy.js";

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test("MCP bootstrap stays disabled when no server config is supplied", async () => {
  await withEnv({ SOFIA_MCP_SERVERS: undefined }, async () => {
    assert.equal(await connectMcpFromEnv(defaultPolicy), undefined);
  });
});

test("MCP bootstrap rejects malformed JSON and untrusted server definitions", async () => {
  await withEnv({ SOFIA_MCP_SERVERS: "{" }, async () => {
    await assert.rejects(connectMcpFromEnv(defaultPolicy), /valid JSON/);
  });
  await withEnv({ SOFIA_MCP_SERVERS: JSON.stringify([{ id: "docs", transport: "http", endpoint: "http://127.0.0.1/mcp", allowedTools: ["search"] }]) }, async () => {
    await assert.rejects(connectMcpFromEnv({ ...defaultPolicy, allowNetwork: true, allowedHosts: ["127.0.0.1"] }), /must use HTTPS/);
  });
});

test("MCP HTTP servers require explicit network permission and exact host allowlisting", async () => {
  const config = JSON.stringify([{ id: "docs", transport: "http", endpoint: "https://mcp.example.com/mcp", allowedTools: ["search"] }]);
  await withEnv({ SOFIA_MCP_SERVERS: config }, async () => {
    await assert.rejects(connectMcpFromEnv(defaultPolicy), /blocked/);
    await assert.rejects(connectMcpFromEnv({ ...defaultPolicy, allowNetwork: true, allowedHosts: ["other.example.com"] }), /blocked/);
  });
});

test("MCP stdio commands require an operator allowlist", async () => {
  const config = JSON.stringify([{ id: "local", transport: "stdio", command: "node", args: ["server.js"], allowedTools: ["lookup"] }]);
  await withEnv({ SOFIA_MCP_SERVERS: config, SOFIA_MCP_STDIO_ALLOWED_COMMANDS: "" }, async () => {
    await assert.rejects(connectMcpFromEnv(defaultPolicy), /not in SOFIA_MCP_STDIO_ALLOWED_COMMANDS/);
  });
});

test("MCP bootstrap rejects readOnlyTools outside the explicit allowedTools list", async () => {
  const config = JSON.stringify([{
    id: "docs", transport: "http", endpoint: "https://mcp.example.com/mcp",
    allowedTools: ["search"], readOnlyTools: ["delete"],
  }]);
  await withEnv({ SOFIA_MCP_SERVERS: config }, async () => {
    await assert.rejects(connectMcpFromEnv(defaultPolicy), /readOnlyTools must be a subset/);
  });
});
