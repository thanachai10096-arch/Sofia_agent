# Sofia Autonomy Model

## Purpose

Sofia can reason, plan, reflect, learn from authorized information, create candidate
skills and run bounded experiments without asking approval at every cognitive step.
Autonomy is not authority: thinking about an action does not grant permission to
execute it. This is an AGI-oriented engineering direction, not a claim that Sofia
is AGI.

## Default autonomy profile

| Capability | Default | Boundary |
| --- | --- | --- |
| Independent thinking and planning | Autonomous | No external side effect |
| Read memory and local research | Autonomous | Memory remains untrusted reference data |
| Write learning notes | Autonomous | Principal/tenant scoped and auditable |
| Create skill candidates | Autonomous | Quarantined; cannot grant capabilities |
| Network research | Off | Requires profile opt-in and execution-policy host allowlist |
| Experiments and code edits | Sandbox only | Isolated workspace and resource budgets |
| Skill promotion | Evidence-gated | Tests, adversarial tests, benchmark >= 0.90, zero safety incidents, version and rollback |
| Production deploy and external actions | Human approval | Never enabled by an autonomy profile |
| Secrets, policy and destructive production changes | Human approval | Never enabled by an autonomy profile |

## Independent research and improvement loop

1. Observe task outcomes and authorized telemetry.
2. Identify knowledge gaps and formulate research questions.
3. Research locally; use network only when both policy layers allow it.
4. Generate hypotheses and measurable success criteria.
5. Create an isolated experiment workspace.
6. Run tests and adversarial evaluations within resource budgets.
7. Record evidence, failures and provenance.
8. Keep candidate skills quarantined until the promotion gate passes.
9. Promote only through the controlled registry with a rollback path.
10. Compare before/after benchmarks and repeat within the cycle budget.

## Two independent permission planes

- Cognitive autonomy governs thinking, planning, memory and candidate generation.
- Execution policy governs tools, filesystem, shell, network, browser, secrets and
  destructive operations. The existing security policy remains authoritative.

A request must pass both planes. This controller does not change ExecutionPolicy
and must not bypass tool-level checks, approval gates, the security kill switch,
principal isolation or audit requirements.

## Runtime budgets

Initial defaults: 8 autonomy cycles, 40 steps, 8 tool calls per step, 300 seconds
per experiment and USD 1 estimated spend per run. Operators may lower these
values. Raising budgets does not grant new tool capabilities.

## Non-goals

- No self-editing of security policy, credentials, approval rules or this controller.
- No automatic production deployment.
- No generated skill code outside the sandbox.
- No cross-user memory or workspace access.
- No assumption that a sandbox exists: absent verified isolation means deny.

## Integration note

This is a policy decision module. Runtime entry points must call it before
autonomous loops or sandbox operations and must still enforce ExecutionPolicy
at every tool invocation. Promotion eligibility is not itself a registry mutation;
the registry integration must preserve versioning, audit records and rollback.
