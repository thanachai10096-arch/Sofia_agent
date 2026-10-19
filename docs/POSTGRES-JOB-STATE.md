# PostgreSQL job-state storage (opt-in)

Sofia's default `DurableJobRuntime` continues to use the existing file-backed state store. Hosts can inject `PostgresJobStateStore` to coordinate lease and state mutations through PostgreSQL transactions without adding a PostgreSQL driver dependency to Sofia.

## Configure

Use a trusted host application that already configures a `node-postgres`-compatible pool. Provision PostgreSQL with private credentials and network access, then run schema setup during controlled startup/migration:

```ts
import { Pool } from "pg";
import { PostgresJobStateStore, createSofiaAgentDependencies } from "sofia-agent";

const pool = new Pool({ connectionString: process.env.SOFIA_JOB_DATABASE_URL });
const jobStateStore = new PostgresJobStateStore(pool);
await jobStateStore.ensureSchema();

const dependencies = createSofiaAgentDependencies(process.cwd(), undefined, jobStateStore);
// Pass dependencies to the existing Sofia API/runtime host.
// On graceful shutdown, stop accepting work, stop the runtime, then await pool.end().
```

Do not expose schema setup through an unauthenticated API route. Keep the database connection string in the host's secret manager and restrict database permissions.

## Guarantees and limitations

- Claims and state mutations use row-level transactions and `FOR UPDATE` locks. Concurrent workers cannot both claim the same live lease.
- Every claim gets a new opaque fencing token. Heartbeats and writes from an older worker are rejected after another worker takes over.
- Cancellation is persisted transactionally and terminal cancellation cannot be overwritten by a late worker result.
- Persisted task text, snapshots, results and errors pass through Sofia's secret redaction before storage and on read.
- This is a shared **job-state store**, not a complete distributed queue service. Sofia does not yet run a background dispatcher that continuously polls and claims unstarted jobs from PostgreSQL. A queued job submitted by a host that crashes before local execution starts still needs explicit recovery/resume orchestration.
- Checkpoints use the existing `RunStore`. The job record embeds its latest snapshot as a fallback, but multi-host deployments should configure a shared durable checkpoint store before relying on resume from another host.
- PostgreSQL availability, backups, TLS, migrations, connection pool sizing, worker orchestration, idempotent external side effects, and live deployment behavior remain operator responsibilities.
- Keep the existing file-backed default unless the host has explicitly provisioned and tested PostgreSQL. This adapter alone does not certify Sofia as production-ready for horizontal scaling.