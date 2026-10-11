<!-- Sofia Agents — README -->
<div align="center">

<h1 align="center"><img src="assets/sofia-title.svg" alt="Sofia Agents — large green code-style title" width="100%" /></h1>

**An agent runtime built to plan, act, verify, and recover.**

A model-agnostic execution layer for Zuse — with internal model routing, policy-controlled tools, durable jobs, browser automation, and a permission-gated local runtime.

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

Sofia is the internal agent runtime for **Zuse**. It turns a request into a managed execution lifecycle: understand the goal, plan the work, perform actions through approved capabilities, verify the outcome, and recover when something fails.

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
| **Security boundaries** | Centralized tool permissions and explicit policy/process sandbox abstractions. The process sandbox is **not** represented as a container. |
| **Platform services** | Agent profiles and templates, skills platform, cloud execution backend contract, and evaluation runner. |
| **SDK & API** | A stable, model-agnostic public surface for clients such as Zuse. |

## `> Quick start`

```bash
npm install
npm run typecheck
npm test
npm run build
```

Use the repository's package scripts as the source of truth if a command differs in your environment.

### Enable browser automation

Browser access is disabled by default. To opt in:

```bash
export SOFIA_ALLOW_BROWSER=true
npm install
npx playwright install chromium
```

Only enable browser capability in environments where its permissions and policy are configured appropriately.

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

## `> Browser & local runtime`

- Browser automation is opt-in and policy-controlled.
- The permission-gated desktop foundation supports scoped workspace discovery, listing, reading, writing, and opt-in allowlisted process execution.
- The local runtime does **not** claim unrestricted whole-disk indexing, browser-profile access, remote desktop control, or OS-level sandboxing.
- Install and start any local agent service explicitly on the user's machine, and grant only the capabilities needed for the task.

More details: [Desktop Runtime Foundation](docs/desktop-runtime.md).

## `> Validation`

Run the complete local validation suite:

```bash
npm install
npm run license:check
npm run typecheck
npm test
npm run build
```

GitHub Actions runs the same license, type, test, and build checks on pushes and pull requests. Use the workflow result as the source of truth; a commit alone does not mean the checks passed.

## `> License`

Sofia Agents is distributed under the **Apache License 2.0**. See [`LICENSE`](LICENSE) for the complete terms. The license permits use, modification, and redistribution subject to its conditions, including preserving required notices. Third-party dependencies remain subject to their own license terms.

SPDX identifier: `Apache-2.0`.

## `> Integration principle`

Zuse should use Sofia's stable API/SDK and let Sofia apply internal routing and execution policy. Keep model selection and privileged capabilities out of the end-user interface.

---

<div align="center">

**Sofia Agents** · Plan carefully. Act through policy. Verify the result.

<sub>Built for reliable, recoverable agent execution.</sub>

</div>