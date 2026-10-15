<!-- Sofia Agent — README -->
<div align="center">

<img src="assets/sofia-mascots-animated.svg" alt="Sofia Agent mascots" width="280" />

<img src="assets/sofia-title.svg" alt="SOFIA AGENT — dimensional green binary title" width="100%" />

<p><code>&gt; Your AI Agent for Coding, Research, and More_</code></p>

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

Sofia creates separate store directories under that root and restricts local state files/directories on POSIX systems. Keep the directory on a persistent volume with appropriate OS permissions and backups. The file-backed runtime is still intended for a single active process; use a transactional shared store/queue before horizontally scaling workloads.
