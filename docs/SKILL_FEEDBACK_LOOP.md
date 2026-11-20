# Skill Execution Feedback Loop

Execution feedback is an evidence stream for review, not a self-approval mechanism.

## Flow

1. A trusted runtime resolves an approved immutable Skill version.
2. The host records the result using `SkillFeedbackLedger.record()`. The actor, project scope, evidence references, and safety incident count must come from trusted host systems.
3. Feedback is idempotent per scope. Reusing an idempotency key with a different payload is rejected.
4. `summarize()` aggregates only one skill version:
   - fewer than five events: insufficient data
   - repeated failures / success rate below 70%: review
   - any trusted safety incident: disable-pending-review
   - otherwise: retain
5. For a review signal, `proposeSkillImprovement()` may ask a host reasoning adapter to draft a revised Candidate. The proposal must retain the prior feedback evidence references and change the candidate digest.
6. The revised Candidate goes through the ordinary Skill Evaluator and controlled promotion flow. The feedback loop never edits the active Registry pointer.

## Security and deployment

- Do not accept execution outcomes, evidence IDs, actor identity, scope, or safety counts from model output.
- A proposal is untrusted candidate data; it does not become active automatically.
- Any disable/rollback decision is an explicit controlled operation, not an automatic side effect of a model-generated recommendation.
- The in-memory feedback store is for tests and single-process development only. Production requires a durable transactional adapter and retention policy.
- The current implementation does not automatically instrument every ToolGateway execution. The host must explicitly record verified outcomes at the integration point.

## PostgreSQL adapter

`PostgresSkillFeedbackStore` implements the transactional store contract with a tenant-scoped JSONB row and `SELECT ... FOR UPDATE`. Run `ensureSchema()` from an explicit host migration/startup path before accepting feedback. The adapter is not wired into the production API or worker by this change. The reference in-memory store remains test/development-only.

## Brain integration hook

`SofiaBrainDependencies.onSkillExecutionResult` emits a minimal outcome event only when a learned skill informed the active plan and the ToolGateway returned an evidence ID. The event contains the run/step IDs, learned-skill ID, tool name, outcome, principal, and evidence reference; raw tool input/output is not forwarded.

Use `createBrainSkillFeedbackRecorder()` to bridge those events to the active Skill Registry version and `SkillFeedbackLedger`. The adapter resolves project scope from the authenticated principal and obtains safety-incident counts from a host safety monitor. Built-in or unregistered skills are ignored. Do not supply a model-generated scope, principal, evidence ID, or incident count.

The callback is optional and best-effort. The default model factory is not yet wired to a production PostgreSQL pool, so production feedback collection remains inactive until the host injects the adapter and provisions the durable store.

## Host factory injection

The standard factory now accepts an optional third argument, `SkillFeedbackHostConfig`. This is the explicit production integration seam; no process-global or in-memory production fallback is enabled:

```ts
const dependencies = createSofiaAgentDependencies(
  workspace,
  approval,
  {
    registry: durableSkillRegistryStore,
    ledger: new SkillFeedbackLedger(durableSkillFeedbackStore),
    resolveScope: (principalId) => tenantDirectory.projectScopeFor(principalId),
    resolveSafetyIncidentCount: (event) => safetyMonitor.incidentsForToolEvent(event),
  },
);
```

A convenience bootstrap is now exported as `createSofiaAgentDependenciesWithPostgresSkillFeedback()`. It accepts an already-created trusted PostgreSQL pool and host resolvers, initializes the two schema tables, then returns Agent dependencies with the Brain callback wired:

```ts
const dependencies = await createSofiaAgentDependenciesWithPostgresSkillFeedback({
  pool: postgresPool,
  resolveScope: (principalId) => tenantDirectory.projectScopeFor(principalId),
  resolveSafetyIncidentCount: (event) => safetyMonitor.incidentsForToolEvent(event),
}, workspace, approval);
```

Apply `migrations/20261120_skill_feedback.sql` with the migration role before starting the runtime with `initializeSchema: false`. The migration creates `sofia_skill_registry` and `sofia_skill_feedback` with JSON-object checks and tenant-scope length constraints; these names match the default PostgreSQL store table names. The migration is idempotent for fresh installs and does not alter existing tables. Set `initializeSchema: false` when an operator-managed migration has already created both tables. This allows the runtime role to operate without DDL privileges; the default remains `true` for explicit development/bootstrap workflows. Keep migration credentials separate from the normal Agent process.

The function deliberately accepts a pool rather than importing a database driver. The host owns driver selection, connection lifecycle, TLS, pool sizing, credential rotation, and shutdown. The database role used for schema initialization needs DDL privileges; runtime-only deployments should run migrations separately and use a least-privilege role. The helper does not create or connect a live database, and it does not wire the API entrypoint automatically.

The supplied stores must be backed by durable transactional storage and initialized by the host. The scope resolver must verify the principal's project membership; the safety monitor must query trusted host records. The regular API entrypoint intentionally does not construct these dependencies automatically, because this repository does not currently include a PostgreSQL client or a configured database pool. Therefore the feature is opt-in and remains inactive in the default production entrypoint until an operator supplies these trusted dependencies.
