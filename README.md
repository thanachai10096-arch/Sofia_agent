# Sofia Agents\n\nSofia is the internal Agent runtime for Zuse. Users never select models: model routing is an internal policy.\n\n## Architecture\n\nZuse / SDK -> Sofia API -> Agent -> Brain -> Tool Gateway -> central Policy -> capabilities\n\nBrain lifecycle: understand -> plan -> execute -> observe -> verify -> diagnose -> repair.\n\n### Implemented platform layers\n- Core: Brain state machine, planner/executor, verification/repair, trace, token budget, repository intelligence, edit engine.\n- Tools: one registry and one policy gateway; terminal/Git/files/verification are capabilities rather than separate execution systems.\n- Skills: builtin + persisted learned skills through the same matching path.\n- Browser: Playwright-backed BrowserRuntime with navigation, click, type, select, scroll, wait, press, history, reload, observe, screenshot and close. Browser actions are policy-controlled.\n- Jobs: background and long-running work are one DurableJobRuntime; the old run manager is only a compatibility facade.\n- Recovery: checkpoints and run snapshots are durable on the local machine and resume is guarded against duplicate concurrent resumes.\n- Security: centralized tool permission policy plus explicit policy/process sandbox abstractions. Process sandbox is not claimed to be a container.\n- Platform: Agent Profiles/Templates, Skills Platform, CloudExecutionBackend contract, and Evaluation runner.\n- Public surface: stable SDK/API remains model-agnostic.\n\n## Browser setup\nBrowser capability is disabled by default. Enable it with:\n\nSOFIA_ALLOW_BROWSER=true\nnpm install\nnpx playwright install chromium\n\nDo not expose browser or model selection to end users. Zuse should call Sofia's stable API/SDK and let Sofia decide the internal route.\n\n## Validation\nThe repository includes GitHub Actions validation for npm install, typecheck, test, and build.\n\nA green local result or CI run must be treated as the source of truth; this README does not claim CI success by itself.
## Mobile / browser clients

Sofia is designed so a phone browser can use the same Agent runtime as desktop. The API supports:

- POST /v1/agent/runs for normal requests.
- POST /v1/agent/runs with { "async": true } for mobile-safe background execution. The request returns 202 immediately with a run id.
- GET /v1/agent/runs/:id to reconnect and poll a run after the phone sleeps, changes network, or the browser is backgrounded.
- DELETE /v1/agent/runs/:id to cancel a queued/running task.
- POST /v1/agent/runs/stream for live SSE events when the connection is available.
- CORS OPTIONS handling for browser clients.

For a web app, keep the Sofia master API key on the server. The browser should call your authenticated application backend, which then calls Sofia; do not embed a privileged Sofia API key in shipped frontend JavaScript.

The SDK exposes start(), getRun(), cancel(), and waitForRun() for this reconnectable flow.


## Local desktop runtime foundation

The permission-gated local runtime foundation is documented in [docs/desktop-runtime.md](docs/desktop-runtime.md). It provides scoped workspace discovery/list/read/write and opt-in allowlisted process execution. It does not yet provide remote desktop control, unrestricted whole-disk indexing, browser-profile access, or OS-level sandboxing. Install and run any local agent service explicitly on the user's machine and grant only the capabilities required for the task.
