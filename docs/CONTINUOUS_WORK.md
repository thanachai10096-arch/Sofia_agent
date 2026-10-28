# Continuous Work Supervisor

Sofia's continuous-work supervisor runs a large objective as small, verifiable work slices on top of the existing `JobRuntime`. It persists the objective, owner, iteration count, latest summary, and current child-job ID so a caller can resume after an activation ends.

## Behavior

- A task is created paused and can be resumed, paused, or stopped by its authenticated owner.
- Each activation is bounded (default: 10 slices or 15 minutes; maximum activation duration: 1 hour). Reaching the slice/time cap pauses the objective rather than spinning forever in one process.
- Progress is persisted after each completed child job. Resume starts from the saved summary and asks Sofia to continue without repeating verified completed work.
- Work can continue across activations without a lifetime iteration cap by default. Set `maxLifetimeIterations` for a hard lifetime limit.
- A trusted `isComplete` callback decides when the actual objective is complete. Do not infer completion solely from a model saying it is done; the callback should inspect task-specific acceptance criteria or verified evidence.
- All records are owner-scoped. Child jobs are submitted with the same owner ID, and reads/stops for another owner are denied.
- `FileContinuousWorkStore` is for a single API process with persistent storage. It uses private directory/file permissions, credential-shaped secret redaction, and atomic replacement. It does not coordinate concurrent writers across processes; use a transactional shared `ContinuousWorkStore` implementation before running multiple workers or replicas.
- The API entrypoint wires this into the existing `JobRuntime` and exposes authenticated owner-scoped HTTP controls:
  - `POST /v1/continuous-work` with `{"task":"..."}` creates a paused objective (requires `agent:run`).
  - `GET /v1/continuous-work` and `GET /v1/continuous-work/:id` list/read only the authenticated owner's records (requires `agent:read` or `agent:run`).
  - `POST /v1/continuous-work/:id/resume` runs one bounded activation; `/continue` chains bounded activations in the background until the owner pauses/stops the objective or a trusted completion check succeeds; `/pause` and `/stop` halt it (all require `agent:run`).
  - Resume returns `202`; poll the GET endpoint for progress. Each activation is bounded; `/resume` returns to paused state at its cap, while `/continue` waits briefly and starts another bounded activation.
- The default API host deliberately uses a completion evaluator that never auto-declares success. This avoids treating a model's claim as verified completion; objectives must be stopped by the owner unless the host is changed to provide task-specific evidence checks. Optionally set `SOFIA_CONTINUOUS_WORK_MAX_LIFETIME_ITERATIONS` to a positive integer to impose a hard lifetime cap.
- Startup recovery automatically schedules objectives persisted in `active` state. It reconciles the recorded child job before creating another slice, reuses a completed child checkpoint, and pauses safely if the child is missing or ended unsuccessfully. Recovery is best-effort on a single process; multi-replica transactional coordination is not implemented.

## Example

```ts
import {
  ContinuousWorkSupervisor,
  FileContinuousWorkStore,
  DurableJobRuntime,
} from "sofia-agent";

const continuous = new ContinuousWorkSupervisor(
  existingJobRuntime, // existing DurableJobRuntime instance; do not create a second runtime
  new FileContinuousWorkStore("sofia-api"),
  {
    maxIterationsPerActivation: 10,
    maxActivationMs: 15 * 60 * 1000,
    // Supply task-specific verification, not a model-only guess.
    isComplete: async (work, childJob) => {
      return childJob.result?.completed === true &&
        await verifyObjectiveAcceptance(work.task, childJob.result.summary);
    },
  },
);

const work = await continuous.create(authenticatedPrincipalId, "Continue improving the project until acceptance criteria pass");
await continuous.resume(work.id, authenticatedPrincipalId);
// Later, including after a process restart, call resume again with the same store.
```

The example's `existingJobRuntime` and `verifyObjectiveAcceptance` are host-provided dependencies, not globals exported by the package. The API entrypoint automatically invokes `resumeInterrupted()` at startup; objectives persisted as active resume in continuous mode and reconcile their existing child job first. The HTTP API currently uses a conservative never-complete evaluator until a host-specific verifier is configured.

## Operational guardrails

Long-running does not mean unlimited parallelism or unlimited spending. Keep provider token/cost budgets enabled, use the existing tool approval/policy gateway, make writes idempotent where possible, and provide a visible pause/stop path. A crash can happen after an external side effect but before a checkpoint is saved; workflows that send messages, charge money, or mutate external systems must use idempotency keys or their own reconciliation before automatic retry.
