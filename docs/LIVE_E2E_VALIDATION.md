# Live E2E validation runbook

This runbook separates automated CI evidence from tests that need real credentials or an interactive desktop session. A green CI run does **not** imply either live test has passed.

## 1. Real model provider smoke test

### Configure GitHub Actions

In the repository settings, add:

- **Actions secret** `AI_GATEWAY_API_KEY`: the API key for the configured OpenAI-compatible AI Gateway.
- **Actions variable** `SOFIA_FAST_MODEL`: the exact model identifier supported by that gateway.
- **Optional Actions variable** `SOFIA_AI_GATEWAY_URL`: the gateway's OpenAI-compatible base URL. If omitted, the workflow uses `https://ai-gateway.vercel.sh/v1`.

Never put credentials in repository variables, source files, issue comments, or workflow logs. Do not use a production key with broader privileges than this smoke test needs.

### Run it

1. Open **Actions → Sofia Live Provider Smoke Test**.
2. Select **Run workflow** on the default branch.
3. Open the resulting run and confirm the **Real provider connectivity** job succeeds.
4. Record the run URL, model identifier, and date in the release checklist; never record the API key.

The check calls the configured provider through `SofiaModelGateway`, enforces a 60-second outer timeout, and requires the exact response token `SOFIA_LIVE_PROVIDER_OK`. It validates connectivity and response parsing only; it does not prove tool execution, task quality, budget enforcement, or full agent completion. If no Actions secret/variable is configured, the workflow should fail early with a configuration message.

## 2. Interactive desktop host verification

Run only on a disposable test machine or a dedicated test account. Keep the host bound to loopback; do not expose the pairing host to a LAN or the public internet. Do not use personal documents or real accounts for the first test.

### Pairing and authorization

- [ ] Pairing endpoint binds to loopback only.
- [ ] A valid one-time pairing code succeeds once and cannot be replayed.
- [ ] An expired code and an incorrect code are rejected; repeated attempts are bounded.
- [ ] Session credentials are not logged or printed.
- [ ] A session is rejected after expiry or revocation.
- [ ] A session cannot call a capability outside its granted scope.
- [ ] Missing, malformed, or invalid authorization fails closed.

### Screen and input driver

- [ ] Screenshot/capture returns a valid image and correct dimensions.
- [ ] A harmless pointer move on a blank test desktop reaches the expected coordinates.
- [ ] A harmless keypress in a dedicated text field enters only the expected test string.
- [ ] Out-of-range coordinates, unsupported keys, and malformed action payloads are rejected.
- [ ] Cancel an in-progress action and confirm no subsequent action is executed.
- [ ] Stop the host and confirm the session and endpoints are no longer usable.

### Approval and audit

- [ ] A read-only observation can run under its explicitly granted capability.
- [ ] A write/destructive action pauses for approval when policy requires it.
- [ ] Denying approval prevents the action from executing.
- [ ] Changing approval-request data cannot change the immutable action snapshot.
- [ ] Audit events describe action, result, and principal without including secrets or sensitive screen contents.

### Evidence and release gate

Attach the OS/version, host build/commit, test outcome, and sanitized logs to the release record. Do not attach screenshots of private data or bearer tokens. Mark each test **PASS**, **FAIL**, or **NOT RUN**; never convert an untested item into a pass based only on unit tests.

Release should remain blocked if pairing/authentication, capability scope, cancellation, or approval-denial checks fail.
