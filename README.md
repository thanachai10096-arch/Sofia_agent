<!-- Sofia Agent — README hero: keep every image in its own paragraph to prevent side-by-side layout on mobile -->
<div align="center">

<p align="center">
  <img src="assets/sofia-agent-hero.svg" alt="Sofia Agent — green terminal-style agent platform identity" width="100%" />
</p>

**An agent runtime designed to plan, act, check results, and recover.**

A model-agnostic AI agent runtime with internal model routing, policy-controlled tools, durable jobs, browser automation, and a permission-gated local runtime. Capabilities depend on the configured providers, permissions, and runtime mode; the descriptions below are not a guarantee that every task will succeed.

![Runtime](https://img.shields.io/badge/runtime-agent--first-16a34a?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-typed-15803d?style=for-the-badge&logo=typescript&logoColor=white)
![Policy](https://img.shields.io/badge/tools-policy--controlled-22c55e?style=for-the-badge)
![Models](https://img.shields.io/badge/model-routing-internal-166534?style=for-the-badge)

</div>

---


## `> Overview`

Sofia Agent is a standalone agent runtime and platform. It turns a request into a managed execution lifecycle: understand the goal, plan the work, perform actions through approved capabilities, verify the outcome, and recover when something fails.

> **Model routing is automatic by default.** Authenticated users may select one of the server-configured routes via `GET /v1/models` and `modelRouteId`. Clients cannot submit provider URLs or API keys, and an explicit route is not silently replaced.


## Open source and contribution

Sofia Agent is distributed under the [MIT License](LICENSE). Review third-party dependency and artwork licenses before redistribution.

- **Contribute:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **Report security issues:** [SECURITY.md](SECURITY.md)
- **Model providers and user route selection:** [docs/MODEL_SELECTION.md](docs/MODEL_SELECTION.md)
- **Open-source and commercial roadmap boundaries:** [docs/OPEN_SOURCE_AND_COMMERCIAL_MODEL.md](docs/OPEN_SOURCE_AND_COMMERCIAL_MODEL.md)
- **Shared access architecture:** [docs/UNIFIED_ACCESS_ARCHITECTURE.md](docs/UNIFIED_ACCESS_ARCHITECTURE.md)

Hosted and enterprise services described in the roadmap are potential offerings, not a claim that they are currently available.



## Project creator

Sofia Agent was created and is developed by **Thanachai Khongseechay**.

- **Developer:** Thanachai Khongseechay
- **Country:** Thailand
- **Age:** 18

## `> Execution lifecycle`

```text
REQUEST
   │
   ▼
UNDERSTAND ──► PLAN ──► EXECUTE
                         │
                         ▼
                  OBSERVE RESULTS
                         │
                         ▼
                      VERIFY
                         │
                  ┌──────┴──────┐
                  │             │
                PASS          FAIL
                  │             │
                  ▼             ▼
                DONE        DIAGNOSE
                                │
                                ▼
                              REPAIR
                                │
                                └──────► VERIFY AGAIN
```

## `> Platform capabilities`

| Layer | What it provides |
| --- | --- |
| **Brain & planning** | State-machine execution, planning, verification, repair, traces, token budgets, repository intelligence, and edit workflows. |
| **Tool Gateway** | A shared registry and centralized policy gate for terminal, Git, file, and verification capabilities. |
| **Skills & learning** | Built-in skills, learned-skill candidates, and persisted workflow patterns recorded only after successful completion with verification evidence. These are reusable workflow records, not model-weight training. |
| **Browser runtime** | Playwright-backed navigation, click, type, select, scroll, wait, keypress, history, reload, observation, screenshots, and close actions. |
| **Durable jobs** | Background and long-running execution through one durable job runtime, with a compatibility facade for older callers. |
| **Recovery & project memory** | Durable local checkpoints and run snapshots; guarded resume; searchable project conventions and repair/workflow patterns persisted locally. |
| **Security boundaries** | Centralized tool permissions plus policy/process runners and an opt-in Docker-backed container sandbox. Process mode is **not** represented as a container. |
| **Platform services** | Agent profiles and templates, skills platform, cloud execution backend contract, and evaluation runner. |
| **Messaging gateway** | Opt-in Telegram Bot API and Discord interaction adapters share the existing Sofia command/API path, access policy, rate limits, and deduplication controls. Ordinary text can be dispatched as a task without `/run`; provider slash commands are not treated as tasks. |
| **SDK & API** | A stable, model-agnostic public surface for desktop, mobile, web, and third-party clients. |

## `> Quick start`

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Use the repository's package scripts as the source of truth if a command differs in your environment.

### Persistent local state

By default, local job records, Brain run snapshots, and project memory are stored under the operating system's temporary directory. Temporary storage may be cleared by reboots, cleanup jobs, or container replacement, so it is not sufficient for production recovery. Configure an absolute, persistent directory before starting Sofia:

```bash
export SOFIA_STATE_DIR=/var/lib/sofia
```

Sofia creates separate store directories under that root and restricts local state files/directories on POSIX systems. Keep the directory on a persistent volume with appropriate OS permissions and backups. The file-backed runtime is still intended for a single active process; use a transactional shared store/queue before horizontally scaling workers.

### Enable browser automation

Browser access is disabled by default. To opt in:

```bash
export SOFIA_ALLOW_BROWSER=true
npx playwright install chromium
```

Only enable browser capability in environments where its permissions and policy are configured appropriately. Playwright traffic is routed through a local egress proxy that validates DNS answers and connects to the selected numeric IP, blocks private/internal destinations, and limits web traffic to HTTP port 80 and HTTPS port 443. Chromium QUIC and non-proxied WebRTC UDP are disabled to reduce direct-network bypasses. Sites that require non-standard ports may not work. Keep host/container egress controls enabled for defense in depth.

## `> API — reconnectable runs`

Sofia supports long-running work for desktop and mobile browser clients:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/v1/agent/runs` | Start a normal run. |
| `POST` | `/v1/agent/runs` with `{ "async": true }` | Start background execution; returns `202` and a run ID. |
| `GET` | `/v1/agent/runs/:id` | Inspect or reconnect to a run. |
| `DELETE` | `/v1/agent/runs/:id` | Cancel a queued or running task. |
| `POST` | `/v1/agent/runs/stream` | Receive live Server-Sent Events (SSE). |
| `OPTIONS` | API routes | Handle browser CORS preflight requests. |

The SDK exposes `start()`, `getRun()`, `cancel()`, and `waitForRun()` for reconnectable execution.

### Secure client integration

**Keep the Sofia master API key on the server.** A browser should call your authenticated application backend, which then calls Sofia. Never ship a privileged Sofia API key in frontend JavaScript.

## `> Messaging integrations (opt-in)`

Sofia has a shared messaging gateway with Telegram and Discord adapters. These adapters connect to the existing Sofia API/SDK and command dispatcher; they do not create a second agent runtime or bypass the normal authorization and tool-policy checks.

- **Telegram:** Bot API long polling, allowlisted user/chat IDs, bounded message delivery, run-completion reporting, and deduplication.
- **Discord:** Signed interaction verification, deferred interaction responses, allowlisted users/channels, and durable job commands.
- **Natural-language chat:** Ordinary text messages are treated as tasks by the shared Sofia messaging handler by default, so users do not need to prefix every request with `/run`. The explicit `/run <task>` command remains supported. Other slash commands are ignored by the task dispatcher, and attachment-only messages do not start runs.
- **Safety:** Integrations are opt-in. Configure explicit user and conversation allowlists, keep tokens/API keys server-side, expose Discord interactions over HTTPS, and use shared Redis-backed rate limiting/deduplication before multi-replica operation.

The adapter and transport foundations are implemented, but this does not mean a bot is already configured or live in a server. A real provider-side smoke test is still required for each deployment. Start with a test environment and follow [Messaging Gateway configuration and acceptance checks](docs/MESSAGING_GATEWAY.md).

## `> Discord integration (opt-in)`

The Discord interaction adapter supports allowlisted slash commands for durable background work:

- `/run` submits a task and returns a job ID.
- `/status` and `/cancel` are restricted to jobs owned by the invoking Discord user.
- `/resume` can continue an eligible job from a saved checkpoint.
- Recent completed work can provide bounded, session-scoped context for the same user and channel; historical content is treated as untrusted input.
- Restart recovery can notify the configured channel about interrupted jobs and whether a checkpoint is available.

Discord is disabled unless its server-side configuration is supplied. Configure explicit user and channel ID allowlists, use HTTPS, keep the bot token/API key in a secret store, and use persistent storage for restart recovery. **CI does not replace a live Discord test.**

See [Discord integration setup and smoke-test guide](docs/DISCORD_INTEGRATION_SETUP.md) for required environment variables, command registration, and a private-server acceptance checklist.

## `> Browser & local runtime`

- Browser automation is opt-in and policy-controlled.
- The permission-gated desktop foundation supports scoped workspace discovery, listing, reading, writing, and opt-in allowlisted process execution.
- The local runtime does **not** claim unrestricted whole-disk indexing, browser-profile access, remote desktop control, or OS-level sandboxing.
- Install and start any local agent service explicitly on the user's machine, and grant only the capabilities needed for the task.

### Opt-in Docker container execution

The SDK exports `ContainerSandbox` for tasks that require an actual container boundary. It requires a trusted image pinned by SHA-256 digest and already present locally; it will not pull images implicitly. The container uses a read-only root filesystem, drops Linux capabilities, enables `no-new-privileges`, caps PIDs/memory/CPU, and mounts only the configured workspace at `/workspace`. Set `allowNetwork: false` to use Docker's `none` network.

This is stronger isolation than `ProcessSandbox`, but it is not a substitute for a patched container runtime, host-level egress controls, or a dedicated disposable worker for hostile workloads. The workspace mount remains writable by design so coding tasks can edit project files. Docker must be installed, running, and available to the Sofia process. Set the image explicitly to an immutable digest; do not use a mutable tag as the configured value:

```bash
docker pull node:22-alpine
docker image inspect node:22-alpine --format '{{index .RepoDigests 0}}'
# Copy the exact repository@sha256:... value printed above:
export SOFIA_SANDBOX_IMAGE='docker.io/library/node@sha256:REPLACE_WITH_THE_REAL_DIGEST'
export SOFIA_SANDBOX_MODE=docker
```

Replace the example placeholder with the actual digest printed by your local Docker engine. The placeholder is not a usable image reference. Preload the exact digest before running Sofia; the sandbox uses `--pull=never` and fails closed if that image is absent.

More details: [Desktop Runtime Foundation](docs/desktop-runtime.md).

## `> Current implementation notes`

The repository is actively evolving. Recent merged work includes natural-language messaging dispatch (chat without requiring `/run`), persistence of verified workflow patterns as project memory, and a Windows job-lock release race fix. See the commit history and linked implementation guides for the exact scope of each change.

## `> Evidence & limitations`

- Verification results describe the checks actually executed; they are not a guarantee of correctness unless the checks independently establish the requested outcome.
- Evolution confidence and success/failure history are heuristic tracking signals, not evidence of model training or calibrated learning.
- Automated review findings are rule-based signals and can produce false positives or miss defects; use human review for security-sensitive changes.
- CI status is the source of truth for build/test compatibility. Features without an end-to-end benchmark should be treated as implemented but not yet benchmark-validated.
- In process mode, tool policy and approval checks are not equivalent to OS-level network or filesystem isolation. Use a properly configured container/runtime boundary for stronger isolation.

## `> Validation`

Run the complete local validation suite:

```bash
npm ci
npm run license:check
npm run typecheck
npm test
npm run build
```

GitHub Actions runs the same license, type, test, and build checks on pushes and pull requests. Use the workflow result as the source of truth; a commit alone does not mean the checks passed.

## `> License`

Sofia Agent is distributed under the **MIT License**. See [`LICENSE`](LICENSE) for the complete terms. The license permits use, modification, distribution, sublicensing, and sale, provided the copyright and permission notice are included with copies or substantial portions. The software is provided without warranty; third-party dependencies remain subject to their own license terms.

SPDX identifier: `MIT`.

## `> API security`

Before exposing Sofia to external clients, follow the [API Security and Deployment Guide](docs/API_SECURITY.md) and verify the current security issue checklist.

## `> Integration principle`

Clients should use Sofia Agent's stable API/SDK and let Sofia enforce execution policy. They may choose only from the configured model routes returned by `GET /v1/models`, or omit `modelRouteId` to let Sofia route automatically. Never accept provider URLs, API keys, or privileged capabilities from an untrusted client.

---

<div align="center">

**Sofia Agent** · Plan carefully. Act through policy. Verify the result.

<sub>Built for reliable, recoverable agent execution.</sub>

</div>

## Benchmark harness

The dependency-free benchmark runner covers ten observable coding tasks. Run the harness self-test before interpreting any agent score:

```bash
node bench/run.mjs --selftest
node bench/run.mjs --agent noop
node bench/run.mjs --agent reference
```

The no-op and reference modes validate the benchmark harness; they are not Sofia capability scores. A real Sofia evaluation requires a configured disposable workspace and API credentials. See [the benchmark guide](bench/README.md) for adapter setup and limitations.

### Persistent conversation transcripts (opt-in)

The existing synchronous `createSofiaAgentDependencies()` factory remains unchanged. On Node 22.5 or newer, opt in to SQLite-backed transcript storage with the additive async factory:

```ts
import { createSofiaAgentDependenciesWithSessions } from "sofia-agent";

const dependencies = await createSofiaAgentDependenciesWithSessions(process.cwd());
try {
  // Pass dependencies to your agent/API host.
} finally {
  dependencies.closeSessionStore();
}
```

Pass a `sessionId` to `SofiaAgent.run()` or the SDK/API run methods to record turns. API session identifiers are namespaced by authenticated API key. SQLite files are stored under the Sofia state directory by default; use a persistent, access-controlled volume. Session transcript persistence does not automatically replay history into model context or add transcript retrieval endpoints. Opening the SQLite store requires a Node release that provides `node:sqlite` (Node 22.5+).

## Project memory and learning

Sofia keeps project-level workflow memory separate from user-scoped memory and conversation transcripts.

- Project memory can persist conventions and repair/workflow patterns for a project.
- Workflow learning is evidence-gated: a candidate is recorded only when the task completed, verification passed, and evidence IDs are present.
- Persisted workflow patterns are searchable and can inform later work; they are not proof that the underlying model has been trained or that every future task will succeed.
- Memory content is treated as untrusted reference data, checked for prompt-injection-like content, and redacted for common secrets before persistence.
- The local file-backed stores are intended for a single active process. Multi-host deployments need a shared transactional storage design before relying on concurrent writes.

## User memory

See [User Memory](docs/USER_MEMORY.md) for explicit, authenticated-user-scoped memory API routes, retrieval behavior, scopes, retention limits, and privacy boundaries. User memory is distinct from project memory and persisted conversation transcripts.
