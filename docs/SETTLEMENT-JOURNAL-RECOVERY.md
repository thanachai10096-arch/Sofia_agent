# Settlement Journal Claim Recovery

## Scope

`FileSettlementJournal` uses an exclusive-create lock file per run ID. It coordinates cooperating workers that share the same local filesystem. It is **not** a distributed lease and does not coordinate workers on different hosts or independent filesystems.

A claim is intentionally fail-closed. If a worker exits unexpectedly, the lock file remains. Sofia must not remove it automatically based only on age, PID absence, or timeout: the provider may have accepted and billed the request even if Sofia did not receive the response.

## Read-only recovery inspection

The journal exposes `inspectRun(runId)` for diagnostics before an operator takes action. It does not acquire or release a claim, append a checkpoint, delete evidence, or reveal the claim token.

The returned summary includes:
- `claim`: `absent`, `active`, or `invalid`. An active claim includes only PID, hostname, and creation time; this is diagnostic metadata, not proof that the owner is dead.
- `journal`: `missing`, `resolved`, `unresolved`, or `corrupt`.
- Counts of started attempts, settled attempts, unknown-usage settlements, and checkpoints.
- `unresolved`: the conservative replay-blocking result.

Example:

```ts
const inspection = await settlementJournal.inspectRun(runId);
if (inspection.claim !== "absent" || inspection.unresolved) {
  // Stop. Preserve evidence and follow the operator reconciliation procedure.
}
```

A missing claim does not make an unresolved journal safe to replay. A valid-looking PID/hostname/timestamp does not establish that a process is dead. An invalid claim or corrupt journal must be treated as an incident and escalated; inspection is intentionally read-only.

## Operator recovery procedure

1. Stop or isolate every Sofia worker that can access the affected settlement directory. Do not attempt recovery while another worker may still own or acquire the run.
2. Back up the complete settlement directory, including the affected `.jsonl` journal and corresponding `.lock` file. Preserve the original files unchanged for audit.
3. Inspect the lock owner record (version, token, PID, hostname, creation timestamp). Confirm the recorded process is no longer running on that host. PID absence alone is not sufficient if the host is unavailable or PID reuse is possible.
4. Inspect the journal from the backup. A malformed record or an unresolved `started` attempt is ambiguous and must remain blocked until reconciled.
5. Reconcile the attempt against authoritative provider-side usage/billing/request records where available. If the provider outcome cannot be established, treat the call as potentially billed and do not replay it automatically.
6. Only after all workers are stopped, the owner is confirmed dead, the journal has been backed up, and the provider outcome has been reconciled may an authorized operator quarantine the stale lock file. Prefer moving it to a restricted incident directory over deleting it. Record the operator, time, run identifier, evidence reviewed, and decision.
7. Restart one worker and verify it reads the preserved journal state before allowing the run to proceed. Do not acknowledge a checkpoint merely to clear a lock; checkpoint acknowledgement means the corresponding execution snapshot is durably persisted.

## Multi-host deployments

Do not mount this file journal as a shared multi-host coordination mechanism and assume it is safe. Multi-host execution requires a transactional shared store that can atomically claim a run, append/settle an attempt, and conditionally release/acknowledge using an ownership token or fencing version. Until that exists, use one writer per local settlement directory.

## Incident evidence

Never put prompts, user task text, credentials, provider replies, or API keys into lock files or journal events. Retain the original journal and provider billing evidence under the deployment's normal restricted-access and retention policy.
