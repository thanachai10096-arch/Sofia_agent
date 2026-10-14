<!-- Sofia Agent — README -->
<div align="center">

<h1 align="center"><img src="assets/sofia-title.svg" alt="Sofia Agent — large green code-style title" width="100%" /></h1>

**An agent runtime designed to plan, act, check results, and recover.**

A model-agnostic AI agent runtime with internal model routing, policy-controlled tools, durable jobs, browser automation, and a permission-gated local runtime. Capabilities depend on the configured providers, permissions, and runtime mode; the descriptions below are not a guarantee that every task will succeed.

![Runtime](https://img.shields.io/badge/runtime-agent--first-16a34a?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-typed-15803d?style=for-the-badge&logo=typescript&logoColor=white)
![Policy](https://img.shields.io/badge/tools-policy--controlled-22c55e?style=for-the-badge)
![Models](https://img.shields.io/badge/model-routing-internal-166534?style=for-the-badge)

</div>

---


## Meet the 14 Sofia characters

<div align="center">

**One Sofia ecosystem. Fourteen distinct character identities.**

The original Agent Workspace character artwork now lives in this repository as transparent PNG assets, ready for light or dark UI surfaces.

</div>

<table>
  <tr>
<td align="center" width="14.28%">
  <img src="assets/characters/a01-beanie-white.png" alt="Sofia — Orchestrator" width="76" /><br/>
  <strong>Sofia</strong><br/>
  <sub>Orchestrator</sub>
</td>
<td align="center" width="14.28%">
  <img src="assets/characters/a02-glasses-blue.png" alt="Nova — Planning" width="76" /><br/>
  <strong>Nova</strong><br/>
  <sub>Planning</sub>
</td>
<td align="center" width="14.28%">
  <img src="assets/characters/a03-cap-shadow.png" alt="Pixel — Coding" width="76" /><br/>
  <strong>Pixel</strong><br/>
  <sub>Coding</sub>
</td>
<td align="center" width="14.28%">
  <img src="assets/characters/a04-cap-back-pink.png" alt="Lumi — Design" width="76" /><br/>
  <strong>Lumi</strong><br/>
  <sub>Design</sub>
</td>
<td align="center" width="14.28%">
  <img src="assets/characters/a05-curly-pink.png" alt="Mira — Research" width="76" /><br/>
  <strong>Mira</strong><br/>
  <sub>Research</sub>
</td>
<td align="center" width="14.28%">
  <img src="assets/characters/a06-bob-pink.png" alt="Echo — Browser" width="76" /><br/>
  <strong>Echo</strong><br/>
  <sub>Browser</sub>
</td>
<td align="center" width="14.28%">
  <img src="assets/characters/a07-cap-pink.png" alt="Data — Data" width="76" /><br/>
  <strong>Data</strong><br/>
  <sub>Data</sub>
</td>
  </tr>
  <tr>
<td align="center" width="14.28%">
  <img src="assets/characters/a08-curly-mint.png" alt="Mint — Testing" width="76" /><br/>
  <strong>Mint</strong><br/>
  <sub>Testing</sub>
</td>
<td align="center" width="14.28%">
  <img src="assets/characters/a09-spiky-pink.png" alt="Bloom — Writing" width="76" /><br/>
  <strong>Bloom</strong><br/>
  <sub>Writing</sub>
</td>
<td align="center" width="14.28%">
  <img src="assets/characters/a10-spiky-violet.png" alt="Iris — Analysis" width="76" /><br/>
  <strong>Iris</strong><br/>
  <sub>Analysis</sub>
</td>
<td align="center" width="14.28%">
  <img src="assets/characters/a11-curly-lilac.png" alt="Orbit — Memory" width="76" /><br/>
  <strong>Orbit</strong><br/>
  <sub>Memory</sub>
</td>
<td align="center" width="14.28%">
  <img src="assets/characters/a12-beanie-violet.png" alt="Velvet — Security" width="76" /><br/>
  <strong>Velvet</strong><br/>
  <sub>Security</sub>
</td>
<td align="center" width="14.28%">
  <img src="assets/characters/a13-bob-violet.png" alt="Spark — Tooling" width="76" /><br/>
  <strong>Spark</strong><br/>
  <sub>Tooling</sub>
</td>
<td align="center" width="14.28%">
  <img src="assets/characters/a14-tuft-lilac.png" alt="Pulse — Operations" width="76" /><br/>
  <strong>Pulse</strong><br/>
  <sub>Operations</sub>
</td>
  </tr>
</table>

<details>
<summary><strong>Character roles and developer usage</strong></summary>

| Character | Focus | Asset |
|---|---|---|
| Sofia | Orchestrator | [a01-beanie-white.png](assets/characters/a01-beanie-white.png) |
| Nova | Planning | [a02-glasses-blue.png](assets/characters/a02-glasses-blue.png) |
| Pixel | Coding | [a03-cap-shadow.png](assets/characters/a03-cap-shadow.png) |
| Lumi | Design | [a04-cap-back-pink.png](assets/characters/a04-cap-back-pink.png) |
| Mira | Research | [a05-curly-pink.png](assets/characters/a05-curly-pink.png) |
| Echo | Browser | [a06-bob-pink.png](assets/characters/a06-bob-pink.png) |
| Data | Data | [a07-cap-pink.png](assets/characters/a07-cap-pink.png) |
| Mint | Testing | [a08-curly-mint.png](assets/characters/a08-curly-mint.png) |
| Bloom | Writing | [a09-spiky-pink.png](assets/characters/a09-spiky-pink.png) |
| Iris | Analysis | [a10-spiky-violet.png](assets/characters/a10-spiky-violet.png) |
| Orbit | Memory | [a11-curly-lilac.png](assets/characters/a11-curly-lilac.png) |
| Velvet | Security | [a12-beanie-violet.png](assets/characters/a12-beanie-violet.png) |
| Spark | Tooling | [a13-bob-violet.png](assets/characters/a13-bob-violet.png) |
| Pulse | Operations | [a14-tuft-lilac.png](assets/characters/a14-tuft-lilac.png) |

- **Artwork directory:** `assets/characters/`
- **Typed registry:** [`src/characters/registry.ts`](src/characters/registry.ts)
- **Important:** these are character identities for the product UI. They do not imply that 14 separate runtime agents are currently running.

```ts
import { SOFIA_CHARACTERS, getSofiaCharacter } from "./characters/registry.js";

console.log(SOFIA_CHARACTERS.length); // 14
const codingMascot = getSofiaCharacter("pixel");
```

</details>

## `> Overview`

Sofia Agent is a standalone agent runtime and platform. It turns a request into a managed execution lifecycle: understand the goal, plan the work, perform actions through approved capabilities, verify the outcome, and recover when something fails.

> **Model routing is an internal policy.** End users do not choose models; Sofia decides how requests are handled.

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
| **Skills** | Built-in skills and persisted learned skills using a shared matching path. |
| **Browser runtime** | Playwright-backed navigation, click, type, select, scroll, wait, keypress, history, reload, observation, screenshots, and close actions. |
| **Durable jobs** | Background and long-running execution through one durable job runtime, with a compatibility facade for older callers. |
| **Recovery** | Durable local checkpoints and run snapshots; resume is guarded against duplicate concurrent resumes. |
| **Security boundaries** | Centralized tool permissions plus policy/process runners and an opt-in Docker-backed container sandbox. Process mode is **not** represented as a container. |
| **Platform services** | Agent profiles and templates, skills platform, cloud execution backend contract, and evaluation runner. |
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
npm install
npm ci\nnpx playwright install chromium
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
| `GET` | `/v1/memory` or `/v1/memory?q=...` | List or search memories for the authenticated principal (`agent:read` or `agent:run`). |
| `DELETE` | `/v1/memory/:id` | Delete one saved memory (`agent:run`). |
| `DELETE` | `/v1/memory` | Clear the authenticated principal’s saved memories (`agent:run`). |
| `OPTIONS` | API routes | Handle browser CORS preflight requests. |

The SDK exposes `start()`, `getRun()`, `cancel()`, and `waitForRun()` for reconnectable execution.

### Secure client integration

**Keep the Sofia master API key on the server.** A browser should call your authenticated application backend, which then calls Sofia. Never ship a privileged Sofia API key in frontend JavaScript.

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

## `> Personal memory & recall`

Sofia supports persistent, user-scoped memory in addition to project memory and learned repair history.

- Explicitly ask Sofia to remember a preference or fact, for example: `Remember that I prefer concise Thai responses` or `จำไว้ว่า ฉันชอบคำตอบภาษาไทย`.
- Later requests can use those saved details as context. Sofia loads a small, bounded set of recent memories rather than the entire memory file.
- Ask Sofia to forget saved details with `Forget all memories about me` or `ลืมทุกอย่างเกี่ยวกับฉัน`.
- Memory is local-first, scoped to the principal identity, and stored separately from project memory. Local runs use `SOFIA_USER_ID` when set or a stable local default; API runs use the authenticated API-key identity unless a trusted server config maps separate channel keys to the same verified end-user principal. It uses the OS user-data directory by default; set an absolute `SOFIA_STATE_DIR` to choose a persistent application data root. In multi-user deployments, issue separate API keys per client and configure `principalIdsByApiKey` only from verified server-side login identity when the same person should share memory across channels. Never trust a user ID supplied by the client.
- Sofia saves only clearly phrased, explicit remember requests; it does not automatically turn every conversation into long-term memory. Secret-like values are redacted, prompt-injection-like content is rejected, entries are bounded, and local files use restrictive permissions.
- User memory is optional context, not an instruction or permission grant. ToolGateway and security policy remain authoritative. Do not store credentials, recovery codes, or other secrets.

Programmatic integrations can use `FileUserMemoryStore`, `UserMemoryStore`, and `UserMemoryEntry` exported by the package to list, search, delete, or clear memories for a trusted principal.

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

## `> Integration principle`

Clients should use Sofia Agent's stable API/SDK and let Sofia apply internal model routing and execution policy. Keep model selection and privileged capabilities out of the end-user interface.

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
