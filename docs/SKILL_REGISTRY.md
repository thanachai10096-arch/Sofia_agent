# Sofia Skill Registry

The skill registry separates candidate learning from trusted runtime use.

## Lifecycle

1. Brain may create a plain-data `LearnedSkillCandidate`.
2. The evaluation pipeline produces evidence bound to the exact candidate SHA-256 digest.
3. `ControlledSkillRegistry.promote()` checks the candidate digest, tests, adversarial tests, benchmark threshold (0.90), zero safety incidents, immutable artifact version and rollback availability.
4. Promotion uses an expected-active-version guard. A stale writer or duplicate artifact version is rejected.
5. `SkillRuntime.resolve()` returns only the active version after re-validating the evidence and candidate digest.
6. Rollback changes the active version pointer and appends an audit event. Prior version artifacts remain immutable.

## PostgreSQL host setup

Use a trusted server-side PostgreSQL pool. Resolve `identity.scope` from authenticated host context (for example, a project/tenant mapping); never accept it from candidate content or model output.

```ts
const store = new PostgresSkillRegistryStore(trustedPool);
await store.ensureSchema(); // controlled migration/startup only

const registry = new ControlledSkillRegistry(store);
const runtime = new SkillRuntime(store);
```

The adapter serializes state changes with a row-level `SELECT ... FOR UPDATE` lock per scope and commits the new JSONB state in one transaction. It is not a client-side store. Grant the application DB role only the required access to `sofia_skill_registry`; do not expose the pool or registry mutation methods to untrusted model tools.

## Security boundary

A resolved skill is a set of instruction strings, not executable code. Runtime resolution does not invoke tools, grant capabilities, alter ExecutionPolicy, read secrets, or authorize production deployment. Every proposed action must still pass the existing Brain authorization and ToolGateway ExecutionPolicy checks.

The in-memory store is for tests and single-process development only. PostgreSQL schema setup is not automatically wired into the production API or Railway worker. No production database has been provisioned or connected by this change.
