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

## Journal path integrity

Journal inspection and unresolved-state checks reject symbolic links and non-regular journal records. Reads use `O_NOFOLLOW` where supported and verify that the opened file descriptor still refers to the inode observed by `lstat`. Appends perform the same inode check when a record already exists. The namespace directory is opened with directory/no-follow flags and permissions are tightened through the verified descriptor rather than by following its path. A symlinked or replaced record is treated as corrupt/unresolved evidence; it is never interpreted as an empty, resolved journal. This is a local filesystem hardening measure, not a substitute for a transactional shared store on multi-host deployments.

## Read-only recovery decision classification

`decideSettlementRecovery(inspection)` is a pure helper that interprets the output of `inspectRun(runId)` without changing files or claims. It returns one of three conservative classifications:

- `hold_active_claim`: an active claim exists. Isolate workers and verify ownership; do not try to clear the claim automatically.
- `operator_reconciliation_required`: claim metadata is invalid, journal evidence is corrupt, or settlement evidence remains unresolved. Preserve the original evidence and reconcile against provider-side usage/billing records.
- `eligible_for_claim_recheck`: the snapshot shows no blocking evidence. This is **not** permission to replay. The caller must acquire the real per-run claim and inspect again while holding it before admitting provider work.

The decision is advisory because inspection is a snapshot and is not atomic with later execution. It never authorizes claim removal, journal mutation, checkpoint acknowledgement, or provider replay. PID, hostname, lock age, and a clean-looking journal are not substitutes for an operator's provider reconciliation.

Claim release also validates the lock path with `lstat`, opens with `O_NOFOLLOW` where available, checks the opened inode against the inspected inode, and re-checks the path identity before unlinking. If the claim path is replaced by a symlink, non-regular file, or different inode, release refuses to follow or remove it. The original claim may then require operator reconciliation; this is intentional fail-closed behavior.


The decision helper also validates its input summary defensively: counters must be non-negative safe integers, settled attempts cannot exceed started attempts, unknown-usage settlements cannot exceed settled attempts, and a missing journal must have zero event counts. Any inconsistent summary or reported unknown usage requires operator reconciliation even if a caller supplies an otherwise-clean status flag. This guards callers that construct or transform inspection objects; it does not replace validation of the on-disk journal.

A summary marked `resolved` must also have equal started and settled attempt counts. A caller-supplied `resolved` label with an unmatched attempt is treated as inconsistent and requires operator reconciliation.


## Directory-entry durability boundary

On POSIX platforms, creating a claim or a new journal record now follows this order: write the file, call `FileHandle.sync()` for file contents, close the file, then open the settlement namespace directory and call `sync()` to persist the directory entry before proceeding. Claim release and journal retention deletion also sync the directory after unlink. If a directory sync fails, the operation reports failure and does not claim durable success; a claim created before the failure is deliberately left fail-closed. A claim that reappears after a crash is an availability issue, not permission to replay a provider request.

Node.js does not provide a portable directory-fsync guarantee through this implementation on Windows. On Windows the directory sync step is skipped, so this implementation does **not** claim equivalent power-loss durability there. Filesystem, mount, controller-cache, and hardware behavior can further affect durability even on POSIX. Unit tests and successful `FileHandle.sync()` calls are not proof against every power-loss scenario; validate the actual deployment filesystem and retain provider-side reconciliation for ambiguous outcomes.

## Settlement event matching

`settle(runId, attempt, usage, claim)` now verifies the journal contains exactly one durable `started` event for the supplied attempt ID and no prior `settled` event before appending settlement evidence. Fabricated attempt IDs, duplicate settlement calls, and attempts against malformed journal records are rejected. The per-run claim serializes this validation with other cooperating journal writers. A rejected settlement does not append a second event or clear the existing unresolved evidence.

This is an integrity check on the local append-only journal; it does not independently prove that provider-reported usage is truthful. Preserve provider-side billing/request evidence for reconciliation.

## Checkpoint admission

Checkpoint acknowledgement is serialized by the per-run claim and now validates the journal before appending. It refuses to append a checkpoint if any provider attempt is still pending, any settlement has unknown or invalid usage, or the journal contains malformed/unmatched evidence. A checkpoint encountered in the event stream while an attempt is pending or after ambiguous evidence is itself invalid; later settlements or checkpoints cannot repair or clear that history. Recovery inspection, unresolved checks, settlement validation, and checkpoint admission all fail closed on this sequence. Only fully matched settlements with validated known usage are eligible. This prevents the journal from accumulating misleading checkpoint markers during an unresolved billing incident; a durable execution snapshot alone cannot establish provider usage.

## Attempt identifier uniqueness

An attempt ID is a one-time journal identity. The journal rejects a second `started` event reusing an ID already seen, including reuse after a prior settlement. Unresolved-state inspection treats reuse as ambiguous evidence, checkpoint admission rejects it, and settlement validation rejects it before appending. This protects the append-only event history from duplicate or replayed attempt identities.


## Historical usage validation before settlement

Before appending a new settlement, the journal validates every prior settled event. A `started` reservation and a record marked `usageKnown: true` must each contain non-negative safe-integer input and output token counts, and their combined total must also be a safe integer; a record marked `usageKnown: false` must not carry a usage payload. Malformed historical usage blocks further settlement appends and preserves the original evidence for operator reconciliation. This prevents a later valid attempt from extending an accounting log that already contains invalid billing evidence.

## Refusing appends after a damaged tail

Before appending to an existing JSONL record, the journal opens the record once with no-follow semantics, verifies the opened inode against the inspected path, and reads the existing bytes through that same descriptor. An empty record, a record without its final newline, or a line that is not valid JSON blocks the append. This applies to new `started` events as well as settlements and checkpoints. The original bytes are left unchanged so an interrupted write remains available for operator reconciliation; the journal does not truncate, repair, or silently continue after damaged evidence.

Recovery inspection applies the same aggregate token-count validation as settlement admission and checkpoint validation. Both reservation bounds and known usage must have safe-integer components whose sum is also a safe integer. If a Started reservation violates that rule, inspection classifies the journal as corrupt and does not count that event or any settlement that cannot validly match it.

Append admission also validates the combined input/output reservation bound as a safe integer, not merely each component independently. A JSON-valid historical `started` event whose aggregate bound overflows is rejected before a new `started` event is appended; the original journal bytes remain unchanged for operator reconciliation.
