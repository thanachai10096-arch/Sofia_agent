# Sofia Agent Language Boundaries: TypeScript + Python

Status: Proposed architecture decision  
Date: 2026-10-13  
Scope: Sofia Agent runtime and the future Sofia web/cloud platform

## Decision

Keep TypeScript as the primary implementation language for Sofia Agent. Add Python only for an isolated capability when a concrete requirement benefits materially from Python's AI/ML, data, or model-serving ecosystem. Do not rewrite the existing runtime in Python and do not create a Python service just to use a second language.

The current repository is a Node.js/TypeScript project: `package.json` defines TypeScript build/typecheck/test scripts and Node.js >=20; the runtime, planner/executor, model gateway, API, durable jobs, security policies, and desktop runtime are implemented in TypeScript. The current CI workflow validates the Node.js project. No Python service or Python dependency manifest is currently part of the repository.

## Ownership by language

### TypeScript owns the product control plane

- Agent runtime and orchestration: understand, plan, route, execute, verify, recover.
- Tool registry, tool contracts, permission checks, approvals, execution policy, and audit/event trace.
- Model-provider routing, token/cost budgets, retries, concurrency, circuit breakers, and request cancellation.
- Public API, API/SDK contracts, authentication/authorization, usage metering, quotas, billing integration, and tenant boundaries.
- Durable jobs, run/session state, checkpoint coordination, and cross-channel Gateway.
- Web UI and dashboards when the web application is added; TypeScript/React is the default frontend stack.
- Desktop integration and shared client contracts.

Security-sensitive authorization remains enforced in the TypeScript control plane. A Python service must not bypass or independently redefine these rules.

### Python may own specialist data/AI services

Introduce Python only when one of these needs is confirmed and a TypeScript implementation would be materially weaker or more costly:

1. A production feature depends on a Python-first AI/ML library or model runtime that cannot be integrated cleanly through a provider API.
2. A specialized embedding, reranking, evaluation, data-processing, speech, or multimodal pipeline needs Python-specific dependencies.
3. A reproducible offline evaluation/experiment pipeline benefits from Python's scientific/data tooling and is not already adequately covered by the existing TypeScript benchmark tooling.

Possible future examples include a dedicated evaluation worker, a model-serving adapter, or a document-processing pipeline. These are candidates, not claims that such services exist today.

### Do not move these to Python by default

- The planner/executor loop, main agent runtime, API authentication, tool permissions, action approval, job ownership, billing/quotas, or Gateway.
- Existing TypeScript functionality solely to imitate another project.
- A second implementation of memory, model routing, or agent state unless a measured requirement justifies it.

## Service boundary if Python is introduced

- Run it as a separate process/service; do not embed a Python interpreter in the Node.js runtime.
- Communicate through versioned HTTP/JSON contracts (or a separately reviewed RPC contract), not shared mutable state.
- Validate all request and response payloads on both sides. Include schema/version, request ID, tenant/principal context where appropriate, deadline, and structured error codes.
- Keep provider secrets in the service's secret manager/environment; never log secrets or raw sensitive prompts by default.
- Apply authentication between services, least privilege, network restrictions, timeouts, bounded concurrency, cancellation/deadlines, and payload-size limits.
- Treat Python output as untrusted data. The TypeScript control plane still validates results and independently authorizes any tool/action.
- Make retries explicit and idempotent. Do not retry non-idempotent work automatically without an idempotency key.
- Track latency, failures, resource use, model/token cost where applicable, and correlation IDs across the boundary.

## Required quality gates for any Python service

Before production use, add:

- A dedicated `pyproject.toml` with pinned/locked dependencies and supported Python version.
- Unit tests and contract tests for valid, invalid, oversized, unauthorized, timed-out, and cancelled requests.
- Static checks and formatting (for example, Ruff and a type checker appropriate to the service).
- CI that installs the locked Python dependencies and runs lint/type/test checks independently of Node.js CI.
- A container/runtime policy, health/readiness endpoints, resource limits, vulnerability/dependency scanning, and a documented deployment path.
- An explicit cost/latency benchmark demonstrating why the Python service is needed.

## Implementation sequence

1. Preserve the existing TypeScript runtime and keep current tests/CI green.
2. Build the shared Gateway/API, durable jobs, permission enforcement, and the Sofia web platform in TypeScript.
3. Choose the first Python-backed capability from a measured product need, not in advance.
4. Add the smallest isolated Python service with a versioned contract, tests, security controls, and CI.
5. Compare operational cost, reliability, and latency before expanding Python's responsibility.

## Acceptance criteria

- TypeScript remains the authoritative control plane for identity, authorization, execution policy, jobs, and billing.
- Python is only introduced for a documented capability with a concrete dependency or measurable advantage.
- No secret, permission, tenant-isolation, or tool-execution rule is weakened by the language boundary.
- Node.js and Python services can be tested, deployed, observed, and rolled back independently.
