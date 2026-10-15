# Sofia Interactive Conversation CLI

The `sofia chat` command is a terminal interface to the same authenticated conversation API used by SDK clients. It reuses the existing Sofia Agent execution runtime; it does not introduce a separate planner.

## Start a chat

Start the API with `createSofiaLocalApi` and configure an API key with `agent:run` and `agent:read` scopes. Then set the client environment:

```sh
export SOFIA_API_URL=http://localhost:3000
export SOFIA_API_KEY=your-local-api-key
sofia chat "Project planning"
```

The conversation is stored by the configured conversation store. The CLI prints the conversation ID so the same session can be resumed later:

```sh
sofia chat --resume <conversation-id>
```

Available in-chat commands:

- `/exit` or `/quit` — leave without deleting history.
- `/clear` — clear the current conversation's message history.
- `/help` — show available commands.

The CLI sends turns asynchronously and polls for the result, allowing the server-side run to continue if the client disconnects. A failed or interrupted run is reported; the CLI does not claim that a server-restarted run will automatically resume.

## Security and deployment notes

- Keep the API key in a trusted terminal environment; do not put a master API key in browser/mobile bundles.
- The default API URL is loopback-only development HTTP. Remote API endpoints must use HTTPS.
- File-backed stores are intended for one local process. Use a transactional shared store and durable queue for multi-instance/cloud deployments.
- Conversation history may contain sensitive user data; apply appropriate filesystem permissions, retention, and deletion policies.
