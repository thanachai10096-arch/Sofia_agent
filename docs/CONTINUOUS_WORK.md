# Continuous Work Supervisor

Sofia's continuous-work supervisor runs a large objective as small, verifiable work slices on top of the existing `JobRuntime`. It persists the objective, owner, iteration count, latest summary, and current child-job ID so a caller can resume after an activation ends.

## Behavior

- A task is created paused and can be resumed, paused, or stopped by its authenticated owner.
- Each activation is bounded (default: 10 slices or 15 minutes; maximum activation duration: 1 hour). Reaching the slice/time cap pauses the objective rather than spinning forever in one process.
- Progress is persisted after each completed child job. Resume starts from the saved summary and asks Sofia to continue without repeating verified completed work.
- Work can continue across activations without a lifetime iteration cap by default. Set `maxLifetimeIterations` for a hard lifetime limit.
- A trusted `isComplete` callback decides when the actual objective is complete. Do not infer completion solely from a model saying it is done; the callback should inspect task-specific acceptance criteria or verified evidence.
- All records are owner-scoped. Child jobs are submitted with the same owner ID, and reads/stops for another owner are denied.
- `FileContinuousWorkStore` is for a single host with persistent storage. It uses private directory/file permissions and atomic replacement. It is not a distributed lock or multi-host database; use a transactional shared `ContinuousWorkStore` implementation before running multiple replicas.
- The supervisor is exported as a library component. It is not yet exposed as a public HTTP/chat command; callers must explicitly construct it with the existing `JobRuntime`, persistent store, and a trusted completion evaluator.

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

The example's `existingJobRuntime` and `verifyObjectiveAcceptance` are host-provided dependencies, not globals exported by the package.

## Operational guardrails

Long-running does not mean unlimited parallelism or unlimited spending. Keep provider token/cost budgets enabled, use the existing tool approval/policy gateway, make writes idempotent where possible, and provide a visible pause/stop path. A crash can happen after an external side effect but before a checkpoint is saved; workflows that send messages, charge money, or mutate external systems must use idempotency keys or their own reconciliation before automatic retry.
