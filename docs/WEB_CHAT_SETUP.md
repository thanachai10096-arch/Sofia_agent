# Sofia Web Chat setup

The API serves a small responsive chat interface at `/web-chat`. It uses the existing Sofia API and Core, supports natural-language task submission, async run polling, and saved model profiles.

## Run locally

1. Configure the same server-side API key required by Sofia API:
   ```bash
   export SOFIA_API_KEY='your-sofia-api-key'
   export SOFIA_API_SCOPES='agent:run,agent:read'
   export SOFIA_STATE_DIR="$HOME/.local/share/sofia"
   ```
2. Start the API using the repository's normal startup command.
3. Open `http://localhost:3000/web-chat` (use the actual host/port configured for the API).
4. For local HTTP development only, set `SOFIA_WEB_CHAT_COOKIE_SECURE=false` before starting the server. Never disable Secure cookies on a public or production deployment.

## Authentication and security

- The page is served by the same API origin. It does not bundle a master key in JavaScript or save the submitted key in localStorage/sessionStorage.
- The user enters an API key already configured in the server's `apiKeys` map. The key is validated server-side and held only in server memory for the session.
- The browser receives a random `HttpOnly; SameSite=Strict; Secure` session cookie by default. Sessions expire after eight hours and are in-memory only; restarting the server logs browser sessions out.
- Login is rate-limited per remote IP (eight attempts per minute). Expired sessions and attempt counters are pruned; the process caps live sessions at 10,000.
- Cookie-authenticated API calls are checked against the request origin and then go through the same existing API key scopes, quotas, run ownership, and tool policy as normal API calls.
- Only profiles configured on the server can be selected. Provider credentials are not entered into or stored by the Web Chat.
- Use HTTPS, keep the service behind an appropriate access boundary, and restrict server API scopes. If running behind a reverse proxy, configure HTTPS and host/origin forwarding carefully; the gateway compares the browser Origin host to the request Host.
- This initial version is single-process: browser sessions do not survive restarts or work across multiple API replicas. It does not provide a separate account directory, SSO, or per-person provider credentials.

## Model choices

The model menu offers `auto`, `fast`, `coding`, `reasoning`, and `vision`. Saving a default calls `PUT /v1/settings/model`; a per-message profile overrides the saved preference. `auto` delegates to Sofia's configured routing. The selected profile is not a guarantee that every provider supports every capability.

## Validation boundaries

CI tests cover session login/logout, cookie flags, same-origin enforcement, and preference endpoint access. A live provider smoke test, external reverse-proxy deployment test, and multi-replica session-store test must be run separately before production use.
