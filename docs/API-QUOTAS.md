# API Usage Quotas

Sofia's current `UsageLimiter` enforces per-key run and tool-call limits inside one API server process.

## Current behavior

- Run and tool-call counters are held in process memory.
- Tool-call usage is recorded on the `tool.started` event. If the limit is reached, the run is aborted; the agent core must honor that abort before invoking the tool's `execute()` method.
- The counter window resets after 24 hours from the first counter update for that key.
- Restarting the API process resets the counters.
- Multiple API replicas do **not** share a single quota. Each replica can independently allow up to its configured limit.

## Deployment boundary

Treat these limits as a per-process safety guard, not as a durable billing ledger or a distributed abuse-prevention boundary. Do not rely on them to enforce account-wide budgets across restarts or horizontally scaled replicas.

Before deploying multiple API replicas or using these counters for billing, replace the in-memory limiter with an atomic shared implementation (for example, a transactional database update or a shared store with atomic increment and expiry). The shared operation must reserve quota before a tool side effect begins, and it must handle simultaneous requests without allowing the total to exceed the configured cap.

## Required verification before release

- A request that exceeds the tool-call cap must not call the over-limit tool's `execute()` method.
- Verify this for async runs, streaming/SSE runs, and synchronous requests.
- Verify concurrent requests for one key cannot exceed the cap within the same process.
- Explicitly test and document restart and multi-replica behavior until a shared limiter is implemented.
- Re-run the full supported CI matrix against the final integrated commit.

Passing unit tests for the in-memory counter alone does not establish distributed quota enforcement or production billing correctness.
