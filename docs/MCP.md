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


## Runtime bootstrap

The API host can connect operator-configured stdio servers during its async startup. Set
`SOFIA_MCP_SERVERS_JSON` to a JSON array; leave it unset to keep MCP disabled.

```json
[
  {
    "id": "filesystem",
    "transport": "stdio",
    "command": "node",
    "args": ["./trusted-mcp-server.js"],
    "allowedTools": ["list_files", "read_file"]
  }
]
```

Each server needs a unique lowercase ID and a non-empty explicit `allowedTools` list.
Optional fields are `cwd`, `args`, `inheritEnv`, and `env`. The process is started
lazily during MCP initialization, receives only the configured environment allowlist,
and is closed when the API host shuts down. Startup fails if an explicitly configured
server cannot initialize or an allowlisted tool is missing; Sofia does not silently
pretend that integration is available.

The first integrated bootstrap supports stdio only. HTTP MCP remains available through
the lower-level transport API, but is not enabled by environment bootstrap until
deployment-level SSRF and egress enforcement is provided.

## Verified skill tools

The Brain runtime now registers verified advanced-skill handlers as `skill.<id>`
tools and exposes `skill.list`. Planned and merely implemented catalog entries are
not exposed. Every skill call still passes through Sofia's normal Tool Gateway:
read-only handlers are read-scoped, may-write handlers require write approval, and
privileged handlers require destructive approval. A skill handler does not grant
additional workspace or network permissions; side effects must still use the normal
Sofia tool boundary.
