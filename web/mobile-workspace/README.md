# Sofia Mobile Workspace UI

A responsive, installable PWA workspace for people who use Sofia from a phone and do not own a computer. Add it to the iPhone/Android home screen from the browser's Share/Install menu after it is hosted over HTTPS.

## UI included

- Responsive dark workspace layout for desktop, tablet, iPhone and Android.
- Private cloud browser start/close, address navigation, back/forward/reload.
- Screenshot refresh with tap-to-click coordinate mapping and touch-drag scrolling.
- Remote keyboard panel that types into the currently focused remote browser element.
- Sofia task composer using the async Agent Runs API and reconnectable status polling.\n- PWA manifest, custom app icon, and offline caching for the static app shell (API responses are never cached).
- Session countdown, connection states, error feedback, privacy/sign-in guidance and responsive mobile navigation.

## Run as static assets

Serve this directory from a static host or place it behind the existing Sofia web application's authenticated route. It is plain HTML/CSS/JavaScript and has no frontend package dependency.

The UI expects the same-origin path prefix `/api/sofia` by default. To change it, set `window.SOFIA_WORKSPACE_API_ROOT` before `workspace.js` loads.

## Required authenticated BFF contract

The browser UI intentionally does not accept, store, or embed a Sofia master API key. It expects a same-origin Backend-for-Frontend (BFF) that:

1. Authenticates the user with the product's existing login/session cookie (HttpOnly, Secure, SameSite).
2. Authorizes the signed-in user for browser and agent-run scopes.
3. Proxies only the allowed `/v1/browser/cloud/*` and `/v1/agent/runs*` requests to Sofia, injecting the API key server-side.
4. Enforces CSRF protection on mutating requests, validates Origin/Host, applies per-user rate limits, and never logs credentials or request bodies containing user data.
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

## Known UI/backend gaps

- No authentication/login product or BFF implementation is included in this repository slice.
- Approval banner is a placeholder; no approval inbox endpoint/UI is connected yet. High-impact actions must remain blocked pending a real approval workflow.
- Browser streaming currently refreshes PNG screenshots on a short polling interval; it is not WebRTC/video streaming.
- Session cookies are ephemeral and lost on server restart; multi-replica affinity/durable session routing remains future work.
- Native browser coordinate actions are only available when the runtime exposes the optional `clickAt` driver; keyboard text requires `typeFocused`.
