# Batch evaluation and trajectory export

Sofia's existing AgentEvaluationRunner remains the evidence-based single-case evaluator. BatchEvaluationRunner wraps that interface, limits concurrency (default 1), preserves result order, rejects duplicate case IDs, and emits aggregate pass/fail metrics.

TrajectoryRecorder is an optional append-only JSONL recorder for explicitly configured offline evaluation. It redacts secret-shaped values, bounds nested payloads and strings, limits event size, and does not automatically capture raw task prompts.

## Safe defaults

- Keep concurrency at 1 when evaluations share a workspace or state directory. Use higher concurrency only with isolated disposable workspaces.
- Treat exported trajectories as sensitive artifacts even after redaction; do not upload them to training or third-party services without review and authorization.
- The recorder is intended for one process writing to one file. It is not a distributed event log.
- This pipeline exports evaluation evidence; it does not train a model or modify production skills automatically.
