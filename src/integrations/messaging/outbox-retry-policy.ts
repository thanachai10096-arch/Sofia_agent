export interface MessagingRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export interface MessagingRetryDecision {
  attemptCount: number;
  nextAttemptAt: number;
  deadLetter: boolean;
}

export const DEFAULT_MESSAGING_RETRY_POLICY: Readonly<MessagingRetryPolicy> = Object.freeze({
  baseDelayMs: 30_000,
  maxDelayMs: 60 * 60_000,
  maxAttempts: 8,
});

/** Calculate bounded exponential backoff without persisting provider error details. */
export function calculateMessagingRetry(
  previousAttempts: number,
  now: number,
  policy: MessagingRetryPolicy = DEFAULT_MESSAGING_RETRY_POLICY,
): MessagingRetryDecision {
  if (!Number.isSafeInteger(previousAttempts) || previousAttempts < 0 ||
      !Number.isFinite(now) ||
      !Number.isSafeInteger(policy.baseDelayMs) || policy.baseDelayMs < 1_000 ||
      !Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs ||
      !Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error("Invalid messaging retry policy input.");
  }
  const attemptCount = previousAttempts + 1;
  const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** Math.min(attemptCount - 1, 30)));
  return {
    attemptCount,
    nextAttemptAt: now + delay,
    deadLetter: attemptCount >= policy.maxAttempts,
  };
}
