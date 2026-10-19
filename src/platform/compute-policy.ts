/**
 * Pure routing policy for the future Hybrid Compute dispatcher.
 *
 * This module deliberately does not execute jobs or claim that remote compute
 * exists. Keep LocalJobBackend as the runtime default until a real remote worker
 * satisfies the authentication, isolation, and durable-job contract.
 */
export type ComputePreference = "auto" | "local" | "remote";
export type ComputeBackendKind = "local" | "remote" | "unavailable";

export interface ComputeTaskRequirements {
  /** Tasks containing credentials or secret material must stay local by default. */
  containsSecrets?: boolean;
  /** Requires access to the caller's local workspace or local-only resources. */
  requiresLocalResources?: boolean;
  /** Task needs network access; remote network policy must explicitly allow it. */
  requiresNetwork?: boolean;
  /** Optional conservative memory estimate for remote admission. */
  estimatedMemoryMb?: number;
}

export interface ComputeRoutingInput {
  preference?: ComputePreference;
  localAvailable: boolean;
  remoteConfigured: boolean;
  remoteHealthy: boolean;
  remoteAuthenticated: boolean;
  remoteIsolated: boolean;
  remoteNetworkAllowed?: boolean;
  maxRemoteMemoryMb?: number;
  task?: ComputeTaskRequirements;
}

export interface ComputeRoutingDecision {
  backend: ComputeBackendKind;
  reason: string;
  /** True only when policy permits a local alternative before remote-only work begins. */
  localFallbackAllowed: boolean;
}

function remoteReadinessFailure(input: ComputeRoutingInput): string | undefined {
  if (!input.remoteConfigured) return "remote backend is not configured";
  if (!input.remoteHealthy) return "remote backend is not healthy";
  if (!input.remoteAuthenticated) return "remote backend authentication is not verified";
  if (!input.remoteIsolated) return "remote workload isolation is not verified";
  const task = input.task ?? {};
  if (task.containsSecrets) return "task contains secrets and remote secret handling is not approved";
  if (task.requiresLocalResources) return "task requires local-only resources";
  if (task.requiresNetwork && !input.remoteNetworkAllowed) {
    return "remote network access is not explicitly allowed";
  }
  if (
    task.estimatedMemoryMb !== undefined &&
    input.maxRemoteMemoryMb !== undefined &&
    task.estimatedMemoryMb > input.maxRemoteMemoryMb
  ) {
    return "estimated task memory exceeds the remote admission limit";
  }
  return undefined;
}

/**
 * Local-first decision function. Automatic routing never selects remote compute
 * while local execution is available; callers may opt in to remote explicitly.
 */
export function decideComputeBackend(input: ComputeRoutingInput): ComputeRoutingDecision {
  const preference = input.preference ?? "auto";
  if (preference === "local") {
    return { backend: "local", reason: "local backend explicitly requested", localFallbackAllowed: true };
  }

  const remoteFailure = remoteReadinessFailure(input);
  if (preference === "remote") {
    if (remoteFailure) {
      // Fail closed: never silently move an explicitly remote request to local.
      return { backend: "unavailable", reason: "remote request rejected: " + remoteFailure, localFallbackAllowed: false };
    }
    return { backend: "remote", reason: "remote backend passed readiness and task-policy checks", localFallbackAllowed: false };
  }

  if (input.localAvailable) {
    return { backend: "local", reason: "local-first policy prefers available local compute", localFallbackAllowed: true };
  }
  if (remoteFailure) {
    return { backend: "unavailable", reason: "no eligible compute backend (" + remoteFailure + ")", localFallbackAllowed: false };
  }
  return { backend: "remote", reason: "local compute unavailable; eligible remote backend selected", localFallbackAllowed: false };
}
