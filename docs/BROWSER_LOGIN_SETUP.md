# Local Browser Login Setup

Sofia's browser login handoff is a local Desktop capability. It is intentionally unavailable on Railway and other headless cloud workers.

## Requirements

- Run Sofia Agent on the same computer where you want the browser window to appear.
- Install the project dependencies, including Playwright Chromium.
- Enable the existing browser policy and configure its allowed hosts.
- Use a dedicated local OS account and OS full-disk encryption.

## Environment

Set these variables only in the local Desktop process environment:

- `SOFIA_ALLOW_BROWSER=true`
- `SOFIA_BROWSER_LOGIN_ENABLED=true`
- `SOFIA_BROWSER_HEADLESS=false`
- `SOFIA_BROWSER_PROFILE_DIR=/absolute/private/path/sofia-browser-profiles`

A graphical session is required (Windows/macOS, or Linux with DISPLAY/WAYLAND_DISPLAY). A principal ID must be present so profile ownership can be enforced.

## How login works

1. Ask Sofia to sign in to the requested website.
2. Sofia opens a visible browser window with a new profile.
3. Complete the site's sign-in directly in that browser window. Enter passwords and OTPs only into the site's own page, never into ChatGPT/Sofia chat.
4. Leave the browser window open while you complete sign-in. Then tell Sofia that login is complete; the authenticated browser context remains managed by the local Desktop host and can be reused by later Brain runs. Profile IDs are owner-bound and may be listed or revoked through the browser profile tools.

The browser profile persists site session data locally (including cookies). Sofia does not return raw cookies, storage state, or the profile directory to the model. On Linux/macOS the profile directories use owner-only filesystem permissions; on Windows the configured root must remain under the current user's LocalAppData so Windows' inherited user-profile ACL remains in force. This implementation does not provide application-layer encryption; keep the profile directory private and rely on OS full-disk encryption.

The local host keeps the authenticated browser context open across Brain runs until the profile is revoked or Sofia shuts down. Sofia closes managed profile sessions during graceful process shutdown. MFA, CAPTCHA, device trust, and re-authentication prompts remain under the user's control. Sofia does not bypass them. Sensitive actions such as sending, purchasing, deleting, or changing account data remain subject to the existing policy and approval path.

## Cloud deployments

Do not set these login variables on Railway. A cloud browser cannot display the local sign-in window, and browser profile data must not be stored in a shared or cloud workspace. Use OAuth connectors for cloud-hosted app access when a provider integration is available.
