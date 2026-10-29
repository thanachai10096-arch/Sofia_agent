# Sofia Agent learning loop

Sofia learns reusable workflow skills from successful work by default. This is the intended Hermes-style behavior: users should not need to approve every ordinary skill write.

## Lifecycle

1. The Brain completes a task and requires trusted verification evidence before proposing a candidate.
2. A candidate captures a bounded task trigger, the verified plan's procedure, strategy, verification evidence IDs, and task category.
3. The managed lifecycle validates the skill metadata and persists a versioned candidate.
4. Promotion happens automatically when the lifecycle evaluator and confidence gate pass. Set `SOFIA_SKILL_WRITE_APPROVAL=true` to require the configured host approval handler.
5. The learned skill is persisted and matched during both initial planning and failure recovery/replanning. Verification metadata preserves the actual successful acceptance-check IDs; Sofia does not relabel every acceptance check as a typecheck, test, or build. Trigger variants and evidence accumulate across repeat successes; the latest verified procedure replaces stale steps so old instructions do not linger.
6. The Evolution Engine records success/failure history and ranks skills from observed outcomes. Failed use is penalized; a later verified success can improve the ranking again.
7. Lifecycle versions support rollback to the previous managed version.

## Isolation and safety

- Authenticated principals get separate skill ledgers, lifecycle history, and Evolution Engine state. The principal identifier is hashed before it is used in filesystem paths.
- Local/self-hosted runs retain the existing local Evolution Engine location.
- Skills are stored as validated metadata and procedure guidance; they are not arbitrary executable code. Each proposed action still goes through the existing Brain, Tool Gateway, policy, and approval controls.
- Learning only starts from successful completion with non-empty trusted verification evidence. Sofia flushes the learned-skill ledger before emitting the learning-recorded event, and reports no learning event if persistence fails. Secret-shaped content is redacted by the existing guard, and persistence rejects prompt-injection-shaped memory content.
- An absent or anonymous principal cannot promote a learned skill.
- `SOFIA_SKILL_WRITE_APPROVAL=true` is an optional extra gate for operators who want manual approval of promotion.

## Configuration

```dotenv
# Default: automatically promote verified skill metadata.
SOFIA_SKILL_WRITE_APPROVAL=false

# Optional: require the configured host approval handler for promotion.
# SOFIA_SKILL_WRITE_APPROVAL=true
```

## Scope and validation

This loop creates and improves reusable skill metadata, reuses it in planning, and tracks performance. It does not claim that Sofia rewrites its own runtime source code or that a skill has been proven useful beyond the recorded verification and subsequent measured outcomes. CI and live provider tests must pass for the exact branch head before release.
