/**
 * Conservative, side-effect-free resource admission checks for compute dispatch.
 *
 * This is a policy helper, not an OS-level CPU/RAM sandbox. A worker must still
 * enforce hard limits at the process/container boundary.
 */
export interface ComputeCapacityLimits {
  maxConcurrentJobs: number;
  maxQueuedJobs: number;
  maxTaskRuntimeMs: number;
  maxMemoryMb: number;
  maxDiskMb?: number;
}

export interface ComputeCapacityRequest {
  activeJobs: number;
  queuedJobs: number;
  estimatedRuntimeMs?: number;
  estimatedMemoryMb?: number;
  estimatedDiskMb?: number;
}

export interface ComputeCapacityDecision {
  admitted: boolean;
  reason: string;
}

export function validateComputeCapacityLimits(limits: ComputeCapacityLimits): void {
  const positiveIntegers: Array<[string, number]> = [
    ["maxConcurrentJobs", limits.maxConcurrentJobs],
    ["maxQueuedJobs", limits.maxQueuedJobs],
    ["maxTaskRuntimeMs", limits.maxTaskRuntimeMs],
    ["maxMemoryMb", limits.maxMemoryMb],
  ];
  for (const [name, value] of positiveIntegers) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(name + " must be a positive safe integer");
    }
  }
  if (limits.maxDiskMb !== undefined && (!Number.isSafeInteger(limits.maxDiskMb) || limits.maxDiskMb <= 0)) {
    throw new Error("maxDiskMb must be a positive safe integer when provided");
  }
}

export function checkComputeCapacity(
  limits: ComputeCapacityLimits,
  request: ComputeCapacityRequest,
): ComputeCapacityDecision {
  validateComputeCapacityLimits(limits);
  for (const [name, value] of [["activeJobs", request.activeJobs], ["queuedJobs", request.queuedJobs]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return { admitted: false, reason: name + " must be a non-negative safe integer" };
    }
  }
  if (request.activeJobs >= limits.maxConcurrentJobs) {
    return { admitted: false, reason: "concurrent job limit reached" };
  }
  if (request.queuedJobs >= limits.maxQueuedJobs) {
    return { admitted: false, reason: "queue capacity reached" };
  }
  if (request.estimatedRuntimeMs !== undefined) {
    if (!Number.isFinite(request.estimatedRuntimeMs) || request.estimatedRuntimeMs < 0) {
      return { admitted: false, reason: "estimated runtime must be a non-negative finite number" };
    }
    if (request.estimatedRuntimeMs > limits.maxTaskRuntimeMs) {
      return { admitted: false, reason: "estimated runtime exceeds the configured limit" };
    }
  }
  if (request.estimatedMemoryMb !== undefined) {
    if (!Number.isFinite(request.estimatedMemoryMb) || request.estimatedMemoryMb < 0) {
      return { admitted: false, reason: "estimated memory must be a non-negative finite number" };
    }
    if (request.estimatedMemoryMb > limits.maxMemoryMb) {
      return { admitted: false, reason: "estimated memory exceeds the configured limit" };
    }
  }
  if (request.estimatedDiskMb !== undefined) {
    if (!Number.isFinite(request.estimatedDiskMb) || request.estimatedDiskMb < 0) {
      return { admitted: false, reason: "estimated disk must be a non-negative finite number" };
    }
    if (limits.maxDiskMb === undefined) {
      return { admitted: false, reason: "disk estimates supplied but no disk limit is configured" };
    }
    if (request.estimatedDiskMb > limits.maxDiskMb) {
      return { admitted: false, reason: "estimated disk exceeds the configured limit" };
    }
  }
  return { admitted: true, reason: "request is within configured admission limits" };
}
