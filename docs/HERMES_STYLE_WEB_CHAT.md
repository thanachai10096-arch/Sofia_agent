# Sofia Web Chat and Hermes-style behavior

## Local Web Chat

The repository includes a lightweight chat UI under `web/` and a loopback-only backend bridge in `scripts/web-chat-server.mjs`.

Start the Sofia API in one terminal, then run:

```sh
SOFIA_API_URL=http://127.0.0.1:3000 SOFIA_API_KEY='<your Sofia API key>' npm run web:chat
```

Open `http://127.0.0.1:4173`. On Windows PowerShell, set the environment variables with `$env:SOFIA_API_URL=...` and `$env:SOFIA_API_KEY=...` before running the command.

The bridge binds only to loopback, keeps the Sofia API key in the Node server process, exposes only fixed endpoints, rejects cross-origin browser requests, limits request bodies, and does not provide an arbitrary URL proxy. Do not change it to bind to a public interface. For a hosted multi-user web app, use a separately authenticated BFF with user sessions, CSRF protection, per-user API-key mapping, rate limits, and server-side secret storage; this local bridge is not a multi-tenant hosting solution.

The UI supports natural chat, async run polling/reconnect by run ID, saved default model profile selection, explicit “remember …” requests, and a memory panel to add/search/delete saved memories. Browser chat history is kept in the current browser's local storage; it is not a replacement for server-side transcript retention. The API key is not stored in browser storage.

For memory management, configure the trusted server key with `agent:run,agent:read,memory:read,memory:write` scopes. Do not grant broader scopes than needed. Model preferences only need the existing `agent:run` and `agent:read` scopes.

## Hermes-style behavior: implemented foundations

Sofia should use one shared Core, not a second planner inside the web or chat client.

- **Closed-loop task execution:** Sofia Brain already plans, executes tools, verifies outcomes, diagnoses failures, and repairs/retries.
- **Persistent learning signals:** `EvolutionEngine` records success/failure history and ranks strategies using observed performance.
- **Versioned learned skills:** `VersionedSkillLifecycle` keeps candidate/verified/active/rejected versions and only promotes candidates after evaluation and the configured approval path.
- **User memory:** explicit user memories are scoped by API-key identity, secret-redacted, bounded, searchable, and now retrieved as limited reference context for runs. Memory is never treated as system-level instructions, and storage failures do not block execution.
- **Natural chat:** the Web Chat submits plain language without requiring a slash command, while preserving Sofia's tool policy and approval controls.
- **Model choice:** automatic routing remains the default; optional model profiles are configurable per run and as a saved API-key preference.

## Remaining parity work

This is a compatibility roadmap, not a claim that Sofia already equals Hermes in every area.

1. Add an account/session identity layer for hosted multi-user use; API-key identity is not a full account model.
2. Build a production BFF with login/session expiry, CSRF protections, per-user quotas, revocation, and encrypted server-side secrets before exposing Web Chat publicly.
3. Add better session transcript retrieval/summarization and user-controlled retention/export/delete. Current browser history is local, and relevant saved memory is a separate explicit store.
4. Expand learning evaluation beyond metadata/procedure checks: run isolated skill fixtures, compare before/after outcomes, track regression rate, and support rollback. Never auto-activate an unverified skill.
5. Finish durable cross-channel delivery and replay protection for Telegram/Discord/Slack; verify each provider independently and do not claim a channel works without a live smoke test.
6. Add job recovery and notification delivery evidence across restart/network-loss scenarios, then add benchmark fixtures comparing repeated-task quality, latency, and token use.
7. Add multi-user integration tests for memory isolation, settings isolation, run ownership, cancellation, and tool approvals.

## Validation boundary

A green CI run verifies the checks actually executed by GitHub. It does not prove that a real model provider, a hosted login flow, or a live chat platform is configured. Those require separate integration/smoke-test evidence.

### Learning-loop safety status

The production learned-skill evaluator currently performs metadata/procedure-shape checks only; it does not execute a candidate against isolated task fixtures. These checks are not proof of task improvement. The runtime now fails closed at this boundary: a candidate stays inactive until a real isolated fixture evaluator reports passing outcome evidence, and the existing explicit approval step is still required afterward. This deliberately prioritizes truthful verification over auto-activating an untested skill. The missing fixture runner remains an implementation gap, not a completed Hermes parity feature.
