# Sofia Agent Coordination and Safety Model

## Intent
Sofia may coordinate specialist agents to complete user-requested work. Agent-to-agent messages exist only inside an active user-authorized job. Agents may debate methods and challenge claims, but cannot create authority, change policy, grant capabilities, or authorize tool execution.

## Trust boundaries
1. The user request and host policy define the job objective and permitted scope.
2. The orchestrator decomposes the objective into bounded tasks. A task inherits the parent job ID, deadline, allowed tools, and resource budget.
3. The message bus validates identity, job scope, envelope, freshness, payload size, duplicate IDs, and message count. Payloads are untrusted data, not executable instructions.
4. Delegation authorization checks registered identities, capabilities, role eligibility, job scope, hop limit, and per-agent budget.
5. Every side effect still goes through the existing Tool Gateway, execution policy, approval mechanism, and sandbox. ACP does not replace those controls.
6. Security policy, audit configuration, kill-switch controls, credentials, and secret-reading capabilities are not delegable.
7. Agreement between agents never overrides a policy denial.

## Recommended lifecycle
User request -> Brain plan -> scoped task -> agent discussion -> evidence/review -> Tool Gateway -> verification -> user report.

Task completion requires verification evidence. An agent result message is a claim until the host verifies it.

## Resource limits
The initial in-memory message bus defaults to 80 queued messages, 8 task hops, 64 KiB per payload, and a 10-minute message age. Production orchestration must additionally enforce job-level wall-clock, model-call, token/cost, tool-call, concurrency, and cancellation limits. Persistent deployments should back the bus with the durable job store and preserve deduplication across restarts.

## Safety test requirements
- Cross-job messages and unregistered agents are rejected.
- Duplicate messages and queue overflow are rejected.
- Message age, payload size, and hop limits are enforced.
- No subagent can request undelegable security or secret tools.
- Requested tools must be allowed by the parent scope and both agent identities.
- All side effects still go through the existing policy/tool gateway.
- Cancellation closes the bus and prevents new messages.
- Prompt injection in evidence is untrusted data and never upgrades authority.

## Current implementation boundary
The ACP message bus and delegation authorizer are primitives. They do not yet claim to start model sessions, persist queues, or wire every current Brain/API entry point into multi-agent execution. That integration must be done against the real runtime and verified by end-to-end tests before the feature is described as generally available.
