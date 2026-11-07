# Sofia Mobile Workspace UI

A responsive, installable PWA workspace for people who use Sofia from a phone and do not own a computer. Add it to the iPhone/Android home screen from the browser's Share/Install menu after it is hosted over HTTPS.

## UI included

- Responsive dark workspace layout for desktop, tablet, iPhone and Android.
- Private cloud browser start/close, address navigation, back/forward/reload.
- Screenshot refresh with tap-to-click coordinate mapping and touch-drag scrolling.
- Remote keyboard panel that types into the currently focused remote browser element.
- Sofia task composer using the async Agent Runs API and reconnectable status polling.
- PWA manifest, custom app icon, and offline caching for the static app shell (API responses are never cached).
- Session countdown, connection states, error feedback, privacy/sign-in guidance and responsive mobile navigation.

## Run as static assets

Serve this directory from a static host or place it behind the existing Sofia web application's authenticated route. It is plain HTML/CSS/JavaScript and has no frontend package dependency.

The UI expects the same-origin path prefix `/api/sofia` by default. To change it, set `window.SOFIA_WORKSPACE_API_ROOT` before `workspace.js` loads.

## Required authenticated BFF contract

The browser UI intentionally does not accept, store, or embed a Sofia master API key. It expects a same-origin Backend-for-Frontend (BFF) that:

1. Authenticates the user with the product's existing login/session cookie (HttpOnly, Secure, SameSite) and sets a separate `sofia_csrf` double-submit cookie (Secure, SameSite, readable by this same-origin UI).
2. Authorizes the signed-in user for browser and agent-run scopes.
3. Proxies only the allowed `/v1/browser/cloud/*`, `/v1/agent/runs*`, and `/v1/approvals*` requests to Sofia, injecting the API key server-side and preserving the approval scopes.
4. Validates the `x-csrf-token` request header against the `sofia_csrf` cookie on mutating requests, validates Origin/Host, applies per-user rate limits, and never logs credentials or request bodies containing user data.
5. Does not expose a generic URL-forwarding proxy or allow the client to choose API keys, provider URLs, or arbitrary headers.

The BFF is a required integration; do not expose the privileged Sofia API directly to an untrusted browser or place a master key in JavaScript/localStorage/sessionStorage. The existing API currently authenticates using Bearer API keys, so a cookie-authenticated BFF is needed before this UI can be used as a signed-in production web surface.

## API routes used

- `POST /v1/browser/cloud/sessions`
- `GET /v1/browser/cloud/sessions/:id/screenshot`
- `GET /v1/browser/cloud/sessions/:id`
- `POST /v1/browser/cloud/sessions/:id/navigate`
- `POST /v1/browser/cloud/sessions/:id/action`
- `DELETE /v1/browser/cloud/sessions/:id`
- `POST /v1/agent/runs` with `{ "task": "...", "async": true }`
- `GET /v1/agent/runs/:id`
- `GET /v1/approvals` (requires `approval:read` or `approval:decide`)
- `GET /v1/approvals/audit?limit=50` (requires `approval:read` or `approval:decide`; returns the owner audit history)
- `POST /v1/approvals/:id/decision` with `{ "decision": "approve" | "deny", "actionHash": "<displayed-action-hash>" }` (requires `approval:decide`)


## Built-in single-operator OIDC login and BFF

The API can serve the PWA and provide a same-origin cookie-authenticated BFF when all of these server-side environment variables are configured:

- `SOFIA_WORKSPACE_OIDC_ISSUER` — HTTPS OIDC issuer URL (discovery is read from `/.well-known/openid-configuration`).
- `SOFIA_WORKSPACE_OIDC_CLIENT_ID` — OIDC client ID.
- `SOFIA_WORKSPACE_OIDC_CLIENT_SECRET` — confidential client secret; server-side only.
- `SOFIA_WORKSPACE_OIDC_REDIRECT_URI` — exact HTTPS callback URI, `https://YOUR_HOST/workspace/auth/callback`.
- `SOFIA_WORKSPACE_OIDC_ALLOWED_SUBJECT` — exact OIDC `sub` claim permitted to use this workspace.

This first integration is intentionally **single-operator**: only the configured subject is admitted and the BFF injects the existing server API key. It is not multi-user account provisioning. Configure the existing `SOFIA_API_SCOPES` to include only the required scopes for this operator, including `agent:run`, `browser:cloud`, `approval:read`, and `approval:decide` when those features are needed. Cloud browser must also be enabled using `SOFIA_CLOUD_BROWSER_ENABLED=true`.

The flow uses OIDC discovery, Authorization Code + PKCE (S256), one-time state, nonce, RS256 ID-token signature verification against JWKS, issuer/audience/expiry checks, and an exact subject allowlist. The session cookie is HttpOnly, Secure, SameSite=Lax and host-only; a separate Secure, SameSite=Strict CSRF cookie is checked against the request header. The BFF accepts only same-origin requests and proxies a fixed allowlist of browser, agent-run, and approval endpoints. The master API key is never returned to the browser.

Visit `/workspace/` after configuration; unauthenticated visitors are redirected to the OIDC provider. The API serves the static PWA files from `web/mobile-workspace/`.

**Limitations:** login transactions and sessions are process-local and are invalidated by a restart. This first release supports one explicitly allowlisted identity, one server API key and one Railway replica; it does not yet provide user registration, multi-user role management, durable sessions, per-user API keys, or a recovery/session-management UI. Register the exact callback URL with the OIDC provider. Do not enable this for public sign-up or expose the privileged API directly.

## Known UI/backend gaps

- The built-in OIDC/BFF is single-operator only and requires explicit provider environment configuration; it is not a public multi-user identity system.
- The Approval Inbox is connected to the Brain approval callback and exposes owner-scoped, one-time decisions. The UI displays the redacted action input and risk before approval. Pending decisions remain process-local and fail closed on restart; a durable, secret-free append-only audit trail is written to `.sofia/approval-audit.jsonl`. Orphaned requests are marked `interrupted` on startup and are never replayed as actionable. Audit export/retention controls remain future work.
- Grant `approval:read` and `approval:decide` only to API keys that should review/approve actions. The BFF must preserve these scope checks and validate its CSRF token on decision requests.
- Browser streaming currently refreshes PNG screenshots on a short polling interval; it is not WebRTC/video streaming.
- Session cookies are ephemeral and lost on server restart; multi-replica affinity/durable session routing remains future work.
- Native browser coordinate actions are only available when the runtime exposes the optional `clickAt` driver; keyboard text requires `typeFocused`.
