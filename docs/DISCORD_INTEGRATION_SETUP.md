# Discord integration: deployment and smoke test

This guide covers the opt-in Discord slash-command integration wired by `src/api/entrypoint.ts`.
It does not claim that a live Discord app or production server has already been tested.

## Commands

Register these commands for one test guild:

- `/run task:<description>` — submit a task and receive a durable job ID immediately.
- `/status job_id:<id>` — view the status of a job owned by the invoking Discord user.
- `/cancel job_id:<id>` — request cancellation of an owned job.
- `/resume job_id:<id>` — resume an owned job when a checkpoint exists and the job is eligible for resume.

Completed jobs can contribute a short, redacted session context to later `/run` tasks from the same Discord user in the same channel. Historical context is treated as untrusted data, not instructions. Jobs are owner-scoped; user and channel allowlists are mandatory.

## 1. Create and configure the Discord application

1. In the Discord Developer Portal, create an application and add a bot.
2. Copy the **Application ID**, **Public Key**, and **Bot Token** into your deployment's secret/environment configuration. Never commit real values.
3. Invite the bot to a private test server with permission to view and send messages in the intended test channel. Slash-command registration is performed by the script below.
4. Set a public HTTPS endpoint for Interactions Endpoint URL to:
   `https://YOUR_PUBLIC_HOST/v1/integrations/discord/interactions`
   Replace the host with your real TLS-enabled API hostname. Do not use an untrusted HTTP endpoint.
5. Keep the application ID, public key, and bot token separate: the endpoint URL uses the public host, `DISCORD_PUBLIC_KEY` verifies request signatures, and `DISCORD_BOT_TOKEN` is used for bot-authenticated outbound messages.

## 2. Configure the server

Required for the API entrypoint:

- `SOFIA_API_KEY`: a strong server-side API key.
- `DISCORD_PUBLIC_KEY`: the Discord application's 32-byte public key as 64 hexadecimal characters.
- `DISCORD_BOT_TOKEN`: bot token.
- `DISCORD_ALLOWED_USER_IDS`: comma-separated Discord user IDs allowed to invoke Sofia.
- `DISCORD_ALLOWED_CHANNEL_IDS`: comma-separated channel IDs allowed to invoke Sofia.

Example using placeholders only:

```dotenv
SOFIA_API_KEY=replace-with-a-long-random-secret
DISCORD_PUBLIC_KEY=replace-with-64-hex-characters
DISCORD_BOT_TOKEN=replace-with-the-real-bot-token
DISCORD_ALLOWED_USER_IDS=111111111111111111
DISCORD_ALLOWED_CHANNEL_IDS=222222222222222222
SOFIA_WORKSPACE=/absolute/path/to/your/workspace
SOFIA_STATE_DIR=/absolute/path/on/a/persistent/volume
PORT=3000
```

Use real numeric Discord IDs for the allowlists. Both lists are required and fail closed when missing, empty, malformed, or duplicated. Do not use usernames as IDs.

**Persistence:** set `SOFIA_STATE_DIR` to an absolute path on durable storage and verify the existing job runtime is configured to use it in your deployment. A temporary directory may lose job records on restart. Back up durable state according to your operational policy.

**Execution policy:** configure Sofia's tool, network, shell, workspace, and sandbox settings deliberately for the tasks you intend to permit. Do not enable shell/network/destructive capabilities merely to make Discord work. Start with a private test channel and the least privilege needed.

## 3. Build, start, and register commands

Use Node.js 20 or newer. From a clean checkout of the feature branch (or after the PR stack is merged into your deployment branch):

```sh
npm ci
npm run typecheck
npm test
npm run build
npm start
```

In a separate terminal with the same Discord application ID and bot token configured:

```sh
DISCORD_APPLICATION_ID=your_application_id \
DISCORD_GUILD_ID=your_test_guild_id \
DISCORD_BOT_TOKEN=your_bot_token \
npm run discord:register-command
```

The registration script registers commands individually for the specified guild rather than bulk-overwriting that guild's command list. Keep the bot token in a secret manager or local environment; do not paste it into chat, issues, or logs.

The server exposes the interaction handler at `/v1/integrations/discord/interactions` when Discord is configured. Configure the Discord Developer Portal endpoint to the exact public HTTPS URL and ensure the reverse proxy preserves the request body bytes for signature verification.

## 4. Verify in a private test channel

1. Confirm an allowed user can run `/run task:Reply with exactly SOFIA_DISCORD_SMOKE_OK`.
2. Confirm the bot acknowledges the request and returns a job ID before the task finishes.
3. Use `/status job_id:<returned-id>` and confirm the status is visible to the same user.
4. Confirm a different, non-allowlisted user cannot submit or inspect a job.
5. Confirm an unapproved channel is denied.
6. Run a second task in the same user/channel and verify only useful, completed session history is available; do not use secrets as test data.
7. If testing `/cancel` or `/resume`, use a disposable task with a known safe checkpoint and verify its final state.
8. Restart the server in a controlled test and verify interrupted jobs are reported and that `/resume` works only when a valid checkpoint exists.
9. Inspect redacted logs and confirm no bot token, API key, or private prompt content is leaked.

## Current limitations / production gate

- CI passing is not a substitute for a live Discord end-to-end test with a real application, endpoint, and persistent storage.
- Notification recovery runs at server startup; a delivery failure is retried on a later restart while the delivery marker remains unset.
- Session context is limited to recent completed jobs and is not a general-purpose transcript or guaranteed full conversation memory.
- Do not enable production traffic until the allowlist, signature validation, ownership checks, cancellation/resume, restart recovery, and secret-handling checks above pass in your environment.
- The stacked pull requests must be reviewed and merged in dependency order before their changes are present on the deployment branch. This guide itself does not merge or deploy them.
