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
