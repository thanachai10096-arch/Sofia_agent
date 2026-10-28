# Chat-first messaging

Sofia's messaging bridge can accept ordinary text without requiring `/run`. This behavior is configured per integration and is available in the current `feat/sofia-unified-agent-capabilities` draft branch; it is not yet present on `main` and has not been verified against live provider accounts.

## What users type

In a configured Telegram chat, send a normal message such as:

- `Hi Sofia`
- `Can you check my project status?`
- `Please remind me tomorrow to review the build`

The bridge submits the message to the existing Sofia API/Core. It acknowledges the accepted run, then sends the final result back to the originating conversation. No second agent runtime is created. The explicit `/run <task>` form remains supported, and unsupported slash commands such as `/status` are ignored by the task dispatcher rather than submitted as tasks.

The Telegram, Slack, LINE, WhatsApp Cloud API, and Matrix runtime constructors in this branch opt into `allowPlainText: true`. Each integration still requires its own server-side credentials and explicit immutable user/conversation allowlists. Messaging is disabled unless `SOFIA_MESSAGING_ENABLED=true`.

## Telegram configuration

Set these as server-side secrets/environment variables on the **Test** service first:

- `SOFIA_MESSAGING_ENABLED=true`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_IDS` — explicit comma-separated Telegram user IDs
- `TELEGRAM_ALLOWED_CHAT_IDS` — explicit comma-separated chat IDs
- `SOFIA_API_KEY` — server-side key with `agent:run` access
- `SOFIA_API_BASE_URL` — HTTPS URL for the existing Sofia API (or the supported Railway domain fallback)

The user and chat allowlists are both required. A missing or invalid setting disables Telegram rather than opening access. Do not put bot/API tokens in source control or chat messages.

## Important platform distinction

The current Discord integration is an **HTTP Interactions / slash-command transport**. It accepts registered Discord application commands such as `/run`; it does not receive arbitrary channel messages. Plain-text Discord chat requires a separate Discord Gateway/message-event transport and the appropriate Discord Message Content intent, plus explicit allowlists and tests. Do not describe Discord as chat-first until that transport exists and is validated.

## Safety and acceptance checks

- Authorization is checked against the provider's verified user and conversation IDs before a run is created.
- Message IDs are deduplicated and runs use idempotency keys.
- Session IDs include platform, user, and conversation identity; previous-turn context must remain scoped to that session and be treated as untrusted data.
- Completion reporting is asynchronous so a long-running task does not block incoming messages; provider errors are redacted before they are sent to chat.
- A normal text message starts an agent run and can consume model tokens/cost. Keep rate limits, task-size limits, provider budgets, approval policies, and a visible cancel/stop path in place.

Before enabling this on a live bot, run typecheck, the relevant unit tests, build, and a real **Test**-service smoke test covering an allowed user, denied user, plain-text message, follow-up turn, completion reply, duplicate event, restart/session recovery, and cross-user isolation. Do not deploy to Production based on unit tests alone.
