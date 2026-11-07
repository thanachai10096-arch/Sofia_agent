# MCP integration

Sofia exposes an opt-in MCP client that adapts remote MCP tools into Sofia's existing tool format. The hosted API bootstraps operator-configured servers from `SOFIA_MCP_SERVERS` and injects only explicitly allowlisted tools into the same Brain Tool Registry. Every call passes through the existing Tool Gateway, policy, approval, and audit path.

## Transports

- stdio launches an explicitly configured command. Only a small environment-variable allowlist is inherited by default; pass additional variables explicitly. Only connect to MCP servers whose commands and packages you trust.
- HTTP uses an explicitly configured HTTP(S) endpoint and optional headers. Do not embed credentials in endpoint URLs. Configure host allowlists and network egress restrictions at the deployment boundary; the transport is not an SSRF defense.

## Hosted API configuration

Set `SOFIA_MCP_SERVERS` to a JSON array. Example for an HTTPS MCP server:

    [{"id":"docs","transport":"http","endpoint":"https://mcp.example.com/mcp","allowedTools":["search","fetch"],"headersEnv":{"authorization":"DOCS_MCP_TOKEN"}}]

Add the exact hostname `mcp.example.com` to `SOFIA_ALLOWED_HOSTS` and set `SOFIA_ALLOW_NETWORK=true`. The value in `headersEnv` is an environment-variable name, not a secret. For stdio, set `transport` to `stdio`, configure `command`/`args`, and add the exact command string to `SOFIA_MCP_STDIO_ALLOWED_COMMANDS`. Only operator-controlled environment configuration can start servers; chat input cannot. Leave `SOFIA_MCP_SERVERS` blank to disable MCP.

Tools not marked read-only by the MCP server are treated as destructive and remain denied unless Sofia policy explicitly permits them. All MCP tools are network-capable and require network permission.

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
- Startup fails closed for invalid configuration, unallowlisted HTTP hosts, missing credential variables, or unapproved stdio commands.
- The hosted API closes managed MCP sessions during shutdown.
- This does not implement an MCP server endpoint, marketplace, or automatic installation of servers.
