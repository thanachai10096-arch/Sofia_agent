# Sofia Mobile Cloud Browser

The Mobile Cloud Browser is the no-computer path for users who want Sofia to work in a browser from a phone. Sofia runs an isolated headless Chromium session on the server; a mobile client displays screenshots and sends user-authorized navigation and input actions. It does not require a Windows/macOS/Linux Desktop Companion.

## Current implementation

- One ephemeral browser session per session ID, bound to the authenticated Sofia API key owner.
- Headless Playwright browser, using the existing URL validation and DNS-pinned browser egress proxy.
- Mobile clients can create/inspect/close sessions, navigate, request screenshots, and send click/type/press/scroll/back/forward/reload actions.
- Session limits are enforced per owner; sessions expire after inactivity and are closed on API shutdown.
- Screenshot responses are bounded and marked no-store.
- Sessions and cookies are in memory only. A process restart closes the browser and requires the user to sign in again.
- No cross-owner session lookup, no persistent cloud cookies, and no password/OTP collection in Sofia chat.

## API

All routes require Authorization: Bearer <SOFIA_API_KEY> and the explicit browser:cloud scope.

- POST /v1/browser/cloud/sessions — create a new cloud browser; returns session.id.
- GET /v1/browser/cloud/sessions/:id — current URL/title and remaining idle lifetime.
- POST /v1/browser/cloud/sessions/:id/navigate — JSON { url: https://example.com }.
- GET /v1/browser/cloud/sessions/:id/screenshot — JSON containing mimeType and base64 PNG.
- POST /v1/browser/cloud/sessions/:id/action — click/type/press/scroll/back/forward/reload.
- DELETE /v1/browser/cloud/sessions/:id — close the session.

Example action payloads:

- {"kind":"click","selector":"button[type=submit]"}
- {"kind":"type","selector":"input[name=email]","text":"user@example.com"}
- {"kind":"press","selector":"input[name=email]","key":"Enter"}
- {"kind":"scroll","x":0,"y":600}

## Opt-in configuration

Set SOFIA_CLOUD_BROWSER_ENABLED=true and add browser:cloud only to API keys that should be able to create cloud browsers. Optional limits:

- SOFIA_CLOUD_BROWSER_MAX_SESSIONS_PER_OWNER (default 2)
- SOFIA_CLOUD_BROWSER_IDLE_TIMEOUT_MS (default 900000, minimum 60000)

The feature is disabled unless explicitly enabled and the key has the scope. This PR does not change Railway settings or deploy anything.

## Mobile UX included

A responsive PWA is included in `web/mobile-workspace/` with screenshot refresh, touch-to-click mapping, address navigation, keyboard/input controls, session close, Sofia task composer, and a sign-in handoff. It uses a same-origin cookie-authenticated BFF; the browser never receives or stores the Sofia API key.

For website account sign-in, the user enters passwords and MFA codes directly into the visible remote browser surface. Sofia must not request credentials in chat, read or store password fields, or bypass MFA/CAPTCHA. High-impact actions such as purchases, payments, account deletion, and publishing must follow the Brain-connected approval workflow.


## Mobile Workspace UI

A polished responsive UI is now included at `web/mobile-workspace/` (HTML/CSS/JS): mobile-first browser surface, URL navigation, back/forward/reload, touch-to-click, touch scrolling, remote keyboard, session status and Sofia task composer.

See [web/mobile-workspace/README.md](../web/mobile-workspace/README.md) for the sign-in configuration and BFF contract. The UI does not accept or store a Sofia master API key. The API still uses Bearer keys internally; the BFF authenticates the allowlisted OIDC subject and injects the key server-side. The Brain-connected Approval Inbox is wired to the existing approval callback.

## Important limitations

The cloud browser and actionable pending approvals remain process-local and are discarded on restart. OIDC login sessions are persisted separately under `.sofia/workspace-sessions/`; this does not make browser cookies or browser sessions persistent. Multi-replica routing, persistent cloud profiles, video streaming, and production end-to-end validation remain future work. The PWA and single-operator BFF are implemented, but do not enable them until the OIDC environment variables, API scopes, persistent volume, and callback URL are configured and tested.
## Brain-connected Approval Inbox

The same API runtime now wires an owner-bound `ApprovalInbox` into the existing Brain approval callback. The inbox is not a second execution path: the Brain's existing `RegistryToolGateway` still validates policy, risk, immutable action input, and the approval hash immediately before executing the tool.

- `GET /v1/approvals` — lists only pending approvals for the authenticated API-key owner. Requires `approval:read` or `approval:decide`.
- `POST /v1/approvals/:id/decision` — body `{"decision":"approve"|"deny","actionHash":"<sha256>" }`; requires `approval:decide`.
- Decisions are one-time, owner-bound, expire after two minutes, and must match the exact SHA-256 action hash.
- Displayed inputs are secret-redacted. Approval requests without an authenticated principal fail closed.
- The mobile workspace polls the inbox and renders action details with explicit Approve/Deny controls.

This first implementation is process-local. Pending requests are denied on process shutdown/restart and are not recovered from disk. It is a safe first integration, not yet a durable multi-replica approval service. Grant `approval:read` and `approval:decide` only to trusted owner keys. The cookie-authenticated BFF must enforce its CSRF/Origin checks before proxying decision requests.


## Mobile Workspace sign-in and BFF

The API now optionally serves the PWA at `/workspace/` and provides a same-origin BFF at `/api/sofia/*`. Enable it only after configuring a confidential OIDC client and a single explicitly permitted identity:

- `SOFIA_WORKSPACE_OIDC_ISSUER`
- `SOFIA_WORKSPACE_OIDC_CLIENT_ID`
- `SOFIA_WORKSPACE_OIDC_CLIENT_SECRET`
- `SOFIA_WORKSPACE_OIDC_REDIRECT_URI` (exact callback: `https://YOUR_HOST/workspace/auth/callback`)
- `SOFIA_WORKSPACE_OIDC_ALLOWED_SUBJECT` (exact OIDC `sub` value)

The login uses Authorization Code + PKCE S256, one-time state and nonce, RS256/JWKS signature validation, issuer/audience/expiry/issued-at checks, and an exact subject allowlist. The browser receives only an HttpOnly Secure SameSite session cookie and a separate CSRF cookie; the BFF injects the configured server-side Sofia API key and permits only the browser, agent-run and approval routes needed by this UI.

This is a single-operator bridge for the current one-key API runtime, not multi-user account provisioning. Pending OIDC login transactions are process-local and expire after five minutes. Authenticated sessions are stored as opaque-token digests under `.sofia/workspace-sessions/` with restrictive file permissions, survive a process restart on the persistent Railway volume, and expire after eight hours by default. Logout revokes the stored session. Configure `SOFIA_API_SCOPES` to include `agent:run`, `agent:read`, `browser:cloud`, `approval:read`, and `approval:decide` as required by the enabled UI features, and enable `SOFIA_CLOUD_BROWSER_ENABLED=true` for cloud browsing. Do not enable public registration or share the OIDC client secret/API key with the browser.
