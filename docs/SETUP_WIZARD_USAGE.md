# CLI Setup Wizard

The first CLI wizard configures a **connection to an existing Sofia API**. It is an initial hosted-connection setup step, not a local model-provider installer and not a live connectivity test.

## Use it

```bash
sofia setup
```

Enter the Sofia API base URL when prompted. The wizard stores only non-secret connection metadata in `~/.sofia/setup.json`. On POSIX systems it requests owner-only permissions for the state directory (`0700`) and config file (`0600`).

Set the API key separately in your shell or secret manager:

```bash
export SOFIA_API_KEY="your-user-scoped-sofia-api-key"
```

Then run:

```bash
sofia status
sofia run "your task"
```

`SOFIA_API_URL`, when set, overrides the saved URL. Do not put API keys in URLs, command-line arguments, repository files, or shared chat messages.

## What this first slice does not do

- It does not save or prompt for API keys.
- It does not make an authenticated or billable model/provider request automatically.
- It does not prove that the API is reachable or that the key is authorized.
- It does not configure a local model provider, desktop/web UI, or messaging integrations.
- It does not grant tools or change Sofia's policy/approval settings.

The next implementation slice should add an explicit, user-triggered API health/authentication check using an existing supported endpoint, then connect the same setup coordinator to other frontends. Only show “connected” after a real check succeeds.
