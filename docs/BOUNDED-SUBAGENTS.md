# Bounded subagent coordinator

BoundedSubagentCoordinator is an additive orchestration primitive for running independent specialist tasks with bounded concurrency, isolated JSON-cloned context, per-task timeout, parent cancellation propagation, and ordered results.

The runtime factory is called once per child task. The host must use it to create a fresh runtime and enforce a least-privilege tool allowlist for that child. The coordinator does not grant or expand permissions.

This primitive is not automatically wired into SofiaBrain's existing single-subagent repair flow. Integrating it into planning requires a separate change to task decomposition, budgets, and parent verification. Do not treat a batch of child outputs as trusted; validate them through Brain and the existing Tool Gateway before applying side effects.

Defaults: at most 3 concurrent children, 12 tasks per batch, 60-second per-task timeout, and 32 KiB of JSON context per child.
