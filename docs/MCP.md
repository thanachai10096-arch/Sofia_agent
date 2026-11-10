# MCP integration

Sofia exposes an opt-in MCP client that adapts remote MCP tools into Sofia's existing tool format. The adapter does not execute tools directly: register the returned SofiaTool array with the existing Tool Registry so the normal Tool Gateway, policy, approval, and audit path remains authoritative.

## Transports

- stdio launches an explicitly configured command. Only a small environment-variable allowlist is inherited by default; pass additional variables explicitly. Only connect to MCP servers whose commands and packages you trust.
- HTTP uses an explicitly configured HTTP(S) endpoint and optional headers. Do not embed credentials in endpoint URLs. Configure host allowlists and network egress restrictions at the deployment boundary; the transport is not an SSRF defense.

## Example

    import { McpClient } from "sofia-agent";
    import { McpStdioTransport } from "sofia-agent";

    const transport = new McpStdioTransport({
      command: "node",
      args: ["./trusted-mcp-server.js"],
      env: { MCP_MODE: "read-only" },
    });
    const client = new McpClient(transport);
    await client.initialize();
    const tools = await client.createSofiaTools();
    // Register tools with Sofia's existing registry; do not call them outside ToolGateway.

## Security and limitations

- Server-provided names, descriptions, schemas, annotations, tool results, and resource contents are untrusted.
- Remote MCP tools are marked network-capable. Non-read-only tools are additionally marked destructive, so default policy may deny them until an operator configures appropriate permissions.
- Keep credentials out of source control and logs. Do not pass the master Sofia API key to an MCP server.
- The HTTP transport handles request/response JSON and SSE responses, not long-lived server-initiated notifications or subscription streaming.
- This is a client foundation; it does not implement an MCP server endpoint, marketplace, or automatic installation of servers.


## Environment bootstrap

The API composition root supports opt-in startup configuration through
`SOFIA_MCP_SERVERS`, a JSON array of server definitions. Set
`SOFIA_ALLOW_TOOLS=true` and `SOFIA_ALLOW_NETWORK=true` before enabling
MCP. HTTP endpoints must be HTTPS and their hostname must be present in
`SOFIA_ALLOWED_HOSTS` (exact host or explicit `*.example.com` wildcard).

HTTP example:

```json
[
  {
    "id": "docs",
    "transport": "http",
    "endpoint": "https://mcp.example.com/mcp",
    "headers": { "Authorization": "Bearer <secret>" },
    "allowedTools": ["search", "fetch"]
  }
]
```

Stdio example:

```json
[
  {
    "id": "local-docs",
    "transport": "stdio",
    "command": "node",
    "args": ["./mcp-server.js"],
    "cwd": "/opt/sofia/mcp-docs",
    "allowedTools": ["search"]
  }
]
```

The environment bootstrap rejects configurations over 32 KiB, more than 12
servers, duplicate IDs/tool names, empty allowlists, unknown fields, invalid
environment entries, unsafe headers, and HTTP URLs containing credentials,
query strings, or fragments. Stdio commands are launched directly without a
shell and inherit only a small environment allowlist plus explicitly supplied
per-server variables. Treat all server definitions, commands, credentials,
headers, and allowlisted tool names as trusted operator configuration; never
derive them from chat input or model output.

Every configured server exposes only its explicitly allowlisted tools. MCP
metadata and results remain untrusted, and every tool still passes through
Sofia's existing ToolGateway policy and approval controls.
