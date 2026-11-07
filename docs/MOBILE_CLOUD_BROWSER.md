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

- click: selector button[type=submit]
- type: selector input[name=email], text user@example.com
- press: selector input[name=email], key Enter
- scroll: x 0, y 600

## Opt-in configuration

Set SOFIA_CLOUD_BROWSER_ENABLED=true and add browser:cloud only to API keys that should be able to create cloud browsers. Optional limits:

- SOFIA_CLOUD_BROWSER_MAX_SESSIONS_PER_OWNER (default 2)
- SOFIA_CLOUD_BROWSER_IDLE_TIMEOUT_MS (default 900000, minimum 60000)

The feature is disabled unless explicitly enabled and the key has the scope. This PR does not change Railway settings or deploy anything.

## Mobile UX still required

These endpoints are the backend foundation, not a finished mobile user interface. The next slice should add a responsive Sofia Web/Mobile Browser panel with screenshot refresh, touch-to-click mapping, address bar, keyboard/input controls, session close, and an explicit sign-in handoff. The client must keep the API key in the platform secure store and must never put it in browser localStorage or URLs.

For account sign-in, the user enters passwords and MFA codes directly into the visible remote browser surface. Sofia must not request credentials in chat, read or store password fields, or bypass MFA/CAPTCHA. High-impact actions such as purchases, payments, account deletion, and publishing should require a separate confirmation in the mobile UI.

## Important limitations

This first backend slice is process-local and ephemeral: no durable session recovery, multi-replica routing, persistent cloud profiles, video streaming, or mobile UI is included yet. It is not production-ready until the mobile UI, deployment affinity/durable routing strategy, and end-to-end security tests are complete.