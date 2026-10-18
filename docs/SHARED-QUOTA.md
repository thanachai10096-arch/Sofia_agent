# Shared API usage quotas

Sofia API's default `UsageLimiter` is process-local and intended for a single API process. It must not be described as enforcing a global quota across replicas.

## PostgreSQL-backed store

`src/api/usage-store.ts` provides `PostgresUsageStore`, a structural adapter for a node-postgres-compatible pool. It atomically serializes quota checks by locking one row per hashed API-key identity in a transaction. It does not add a database driver dependency.

1. Provision a PostgreSQL database with restricted credentials and TLS appropriate to the deployment.
2. Create the `sofia_api_usage` table during a controlled migration/startup using `await store.ensureSchema()`; do not run schema changes as an unauthenticated HTTP action.
3. Construct the store using the same limits configured for the API, then pass it as `SofiaApiConfig.usageStore`.
4. Use the API's existing hashed `auth.keyId` as the key. Never use or persist the raw API token.
5. Monitor database errors and quota rejections separately. If shared accounting fails, the API rejects new work with `503 usage_store_unavailable`; it does not fall back to process-local counters.

Example (using an already-configured node-postgres pool):

```ts
import { Pool } from "pg";
import { PostgresUsageStore } from "./api/usage-store.js";

const pool = new Pool({ connectionString: process.env.SOFIA_USAGE_DATABASE_URL });
const usageStore = new PostgresUsageStore(pool, 100, 1000);
await usageStore.ensureSchema();

// Supply usageStore in SofiaApiConfig when creating the API.
// Keep maxRunsPerKeyPerDay / maxToolCallsPerKeyPerDay aligned with the
// store's limits. Keep the connection string in the deployment secret store.
```

Install/configure the PostgreSQL driver in the host application if using this adapter; Sofia does not install `pg` implicitly.

## Current contract and limitations

- Each accepted API run increments the run counter atomically. Tool-call usage is supported by the store interface, but current API paths do not yet report actual tool-call totals to it.
- The quota uses a per-key rolling-from-first-use fixed window (24 hours by default), matching the existing local limiter's reset model; it is not a calendar-day billing ledger.
- This is atomic quota counting, **not yet a reserve/commit/release billing ledger**. It does not refund run quota for cancelled/failed work or guarantee exactly-once monetary billing.
- The implementation includes unit tests for transaction ordering, quota rejection, malformed records, and storage failure. These mocks do not prove real multi-connection PostgreSQL contention behavior. Before production, add a PostgreSQL integration test that runs concurrent clients/processes against a disposable database and proves the hard limit cannot be exceeded.
- Shared quotas do not provide multi-host durable job coordination. Configure the separate transactional shared job queue/store before running multiple hosts.
- The in-memory `UsageLimiter` remains the backward-compatible default. Deployments requiring globally enforced quotas must explicitly configure `usageStore`; do not enable horizontal replicas while relying on the default.
