# MCP integration

Sofia exposes an opt-in MCP client that adapts remote MCP tools into Sofia's existing tool format. The hosted API bootstraps operator-configured servers from `SOFIA_MCP_SERVERS` and injects only explicitly allowlisted tools into the same Brain Tool Registry. Every call passes through the existing Tool Gateway, policy, approval, and audit path.

## Transports

- stdio launches an explicitly configured command. Only a small environment-variable allowlist is inherited by default; pass additional variables explicitly. Only connect to MCP servers whose commands and packages you trust.
- HTTP uses an explicitly configured HTTPS endpoint and optional headers. Do not embed credentials in endpoint URLs. The hosted bootstrap requires an exact hostname allowlist and rejects redirects.

## Hosted API configuration

Set `SOFIA_MCP_SERVERS` to a JSON array. Example for an HTTPS MCP server:

    [{"id":"docs","transport":"http","endpoint":"https://mcp.example.com/mcp","allowedTools":["search","fetch"],"readOnlyTools":["search"],"headersEnv":{"authorization":"DOCS_MCP_TOKEN"}}]

Add the exact hostname `mcp.example.com` to `SOFIA_ALLOWED_HOSTS` and set `SOFIA_ALLOW_NETWORK=true`. The value in `headersEnv` is an environment-variable name, not a secret. For stdio, set `transport` to `stdio`, configure `command`/`args`, and add the exact command string to `SOFIA_MCP_STDIO_ALLOWED_COMMANDS`. Only operator-controlled environment configuration can start servers; chat input cannot. Leave `SOFIA_MCP_SERVERS` blank to disable MCP.

Only tools explicitly listed in the operator-controlled `readOnlyTools` subset are treated as read-only; remote MCP annotations are not trusted for permissions. All HTTP MCP tools require network permission and exact hostname allowlisting. stdio MCP tools do not require network permission; they require an exact command allowlist, and tools not in `readOnlyTools` remain destructive until explicitly permitted by Sofia policy.

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
- HTTP MCP tools are marked network-capable. stdio tools are governed by the command allowlist instead. Non-read-only tools are additionally marked destructive, so default policy may deny them until an operator configures appropriate permissions.
- MCP `readOnlyHint` annotations are advisory only; the operator must explicitly list safe tools in `readOnlyTools`.
- Keep credentials out of source control and logs. Do not pass the master Sofia API key to an MCP server.
- The HTTP transport handles request/response JSON and SSE responses, not long-lived server-initiated notifications or subscription streaming.
- Startup fails closed for invalid configuration, unallowlisted HTTP hosts, missing credential variables, or unapproved stdio commands.
- The hosted API closes managed MCP sessions during shutdown.
- This does not implement an MCP server endpoint, marketplace, or automatic installation of servers.
