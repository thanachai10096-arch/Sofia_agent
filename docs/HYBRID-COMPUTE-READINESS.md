# Hybrid Compute foundation and rollout gates

## Current implementation

- `src/platform/cloud-execution.ts` defines the backend contract and the existing `LocalJobBackend` adapter.
- `src/platform/compute-policy.ts` adds a pure, local-first routing decision function. It is a policy foundation only; it does not dispatch jobs and does not make a remote worker available.
- `tests/compute-policy.test.ts` covers default routing and fail-closed policy checks.

The local backend remains the production default. Do not advertise remote/cloud execution as available until a real remote backend is implemented and tested.

## Routing policy

- `local`: always select local compute.
- `auto`: prefer local compute when available. Select remote only if local compute is unavailable and remote readiness, authentication, isolation, task sensitivity, network policy, and configured memory checks pass.
- `remote`: require all remote gates. If a gate fails, return `unavailable`; do not silently execute locally when the user explicitly requested remote execution.
- Secret-bearing tasks and tasks requiring local-only resources are not eligible for remote execution under the default policy.
- Network access to a remote task must be explicitly allowed. Memory estimates are checked when both an estimate and a configured limit are supplied.

Callers must treat this module as a decision helper, not as an authorization boundary. The eventual dispatcher and remote worker must independently enforce identity, workspace scope, quotas, isolation, and secret minimization.

## Required before remote production rollout

1. Implement an authenticated remote worker transport and worker identity.
2. Use transactional shared job storage/queue for multi-host coordination, with atomic claims, leases, heartbeats, fencing, and durable cancellation.
3. Add idempotent submission and duplicate-execution prevention.
4. Enforce workspace/principal scoping, CPU/RAM/disk/time limits, network egress policy, and artifact/log retention.
5. Add provider-backed contract and failure-injection tests, including process/host loss, cancellation races, retries, and stale-worker writes.
6. Add cost ceilings, usage metering, observability, alerting, and documented incident procedures.
7. Keep local-only operation working when no remote provider is configured.

## Cost-first rollout

1. Local-only default and policy tests.
2. Optional single remote worker behind explicit configuration and strict limits.
3. Shared transactional queue only when multi-host scale is required.
4. Autoscaling and paid cloud capacity only after real workload metrics justify the cost.

No provider, credential, or cloud spend is configured by this foundation change.
