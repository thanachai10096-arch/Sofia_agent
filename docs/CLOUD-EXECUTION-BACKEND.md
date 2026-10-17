# Cloud execution backend status

Sofia currently exposes the CloudExecutionBackend interface and LocalJobBackend adapter. The latter delegates to the existing JobRuntime; it is not a remote/cloud execution service.

The contract tests in this change verify the local adapter's submit/get/cancel semantics without inventing a cloud provider. A real remote backend should not be added until a provider, authentication model, workload isolation boundary, quotas, cancellation semantics, artifact handling, and operational monitoring are selected and tested.

## Required gates before a remote backend is production-ready

- Authenticated and integrity-protected requests.
- Explicit workspace and principal scoping.
- Idempotent submission and duplicate-execution prevention.
- Workload isolation, resource limits, network egress controls, and secret minimization.
- Durable status, cancellation, logs, and artifact semantics.
- Contract and failure-injection tests against the real provider.
- Documented cost controls, observability, and incident handling.

Keep LocalJobBackend as the default. Do not describe the interface alone as cloud execution support.
