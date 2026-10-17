# Versioned skill lifecycle

VersionedSkillLifecycle is an opt-in gate layered beside Sofia's existing skill ledger and platform. It records candidate provenance and confidence, requires an injected evaluator to return explicit passing checks, and only then permits promotion into a configured SkillsPlatform. Previous active versions remain in history and can be restored with rollback.

## Safety model

- New skills are candidates by default and are never registered as active automatically.
- Promotion requires a successful evaluation with at least one passing check and a configurable confidence threshold.
- The evaluator is supplied by the host and should run repeatable tests, regression checks, and policy validation in an isolated workspace.
- Promotion changes only the supplied SkillsPlatform. The lifecycle manager does not execute skill procedures.
- A local JSON store is single-process only. Use an appropriately transactional shared store for multi-process deployments.
- If persistence fails during promotion/rollback, the manager attempts to restore the previous platform package and reports the original failure; inspect consistency before continuing.
