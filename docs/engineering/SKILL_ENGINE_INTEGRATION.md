# Skill Engine Integration Contract

## Runtime flow

1. `SofiaBrain` diagnoses a failure and calls `matchSkills` in `src/brain/skills.ts`.
2. The adapter combines the existing legacy repair catalog with matching built-in policies from `src/brain/skill-policy-v1.ts`; it bounds input length and candidate count and keeps legacy IDs working.
3. `compactSkillContext` sends procedures, preconditions, verification obligations, recovery guidance, risk labels, capability/permission names, and compatibility metadata to the planner as untrusted guidance.
4. The planner's proposed tool calls still pass through the existing `ToolGateway` and its registered tool policies, workspace/sandbox checks, approval requirements, and Brain-wide execution/token/deadline budgets. Skill metadata does not authorize actions.
5. `runVerification` carries structured project-check results, assertion metrics, and test-runner counts into the Brain. The repository test runner emits Node TAP summaries; `project.verify` parses only complete, consistent summaries, and `finishAttempt` accepts them only when there are passed tests and no failures, skips, cancellations, or TODO tests. Missing metrics remain unverified.
6. `EvolutionEngine` receives success credit only for verified policy skills; failure handling remains scoped to the skill that informed the failed repair. Evolution persistence is bounded and sanitized before it affects ranking.

## Components incorporated

| Draft component | Sofia implementation | Status |
| --- | --- | --- |
| Skill types and contracts | `src/brain/skill-policy-v1.ts` type definitions and `validSkill` | Integrated as one versioned module |
| Built-in catalog | `BUILTIN_SKILLS` in `src/brain/skill-policy-v1.ts` | Integrated; 12 built-in policies |
| Matching | `selectSkills` plus compatibility adapter `matchSkills` | Integrated; old skills remain available |
| Action policy / execution boundary | Existing `SofiaBrain`, `ToolGateway`, registered tool policies and approval checks | Reuses existing runtime boundary; no second parallel dispatcher is introduced |
| Outcome history | `finishAttempt`, `boundedHistory`, `EvolutionEngine` | In-memory Skill Policy outcomes require private object identity; durable ranking uses EvolutionEngine |
| Verification | `src/brain/verification.ts`, `src/brain/test-summary.ts`, and `finishAttempt` | Structured project-check evidence and TAP counts are propagated; incomplete/malformed summaries remain unverified |
| External/learned skills | `inspectExternalSkill`, `assessLearnedSkill`, safe legacy-ledger validation | Quarantined or rejected; never promoted to built-in trust by self-asserted metadata |

## Security invariants

- A skill's `requiredCapabilities`, `requiredPermissions`, `risk`, and `resourceLimits` fields are not authorization tokens.
- ToolGateway remains the source of truth for action registration, actual capabilities, permissions, approval, and dispatch.
- The catalog's per-skill `resourceLimits` are currently planner contracts, not an independently enforced per-skill runtime account. The Brain-wide and gateway budgets are the enforced limits. Do not advertise per-skill limits as a hard boundary until separately implemented and tested.
- Skill Policy history ranking rejects caller-constructed or deserialized outcome objects. This prevents a plain JSON success claim from boosting in-memory Skill Policy ranking. Durable learning is handled by the separately bounded EvolutionEngine.
- `verified-success` means the required evidence contract passed; a security review with findings is not a security-clear verdict.
- No external skill, model output, browser content, or learned procedure may grant permissions or bypass approval.

## Release gate

- Keep PR #94 in draft until the complete source provenance review is finished.
- Run typecheck, the full test suite, build, license check, Windows/macOS/Linux CI, sandbox integration, and browser egress integration on the exact final commit.
- Record unresolved findings and do not describe catalog risk labels or per-skill limits as runtime enforcement.
- A successful CI run establishes build/test status only; it does not establish copyright provenance or prove every possible runtime scenario.