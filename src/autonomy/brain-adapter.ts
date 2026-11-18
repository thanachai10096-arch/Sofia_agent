import {
  defaultAutonomyProfile,
  evaluateAutonomyRequest,
  type AutonomyAction,
  type AutonomyContext,
  type AutonomyProfile,
} from "./controller.js";
import type {
  AutonomyToolAuthorizationDecision,
  AutonomyToolAuthorizationRequest,
} from "../brain/executor.js";

/**
 * Host-owned bridge between Brain's pre-tool gate and the autonomy policy.
 *
 * Classification and context are deliberately injected by the trusted host:
 * tool effect labels alone cannot prove sandbox isolation or identify the
 * actual scope of a side effect. Unknown tools fail closed.
 */
export interface BrainAutonomyAdapterOptions {
  profile?: AutonomyProfile;
  classifyTool: (request: AutonomyToolAuthorizationRequest) => AutonomyAction | undefined;
  getTrustedContext: (
    request: AutonomyToolAuthorizationRequest,
    action: AutonomyAction,
  ) => Promise<AutonomyContext>;
}

export function createBrainAutonomyAuthorizer(
  options: BrainAutonomyAdapterOptions,
): (
  request: AutonomyToolAuthorizationRequest,
) => Promise<AutonomyToolAuthorizationDecision> {
  const profile = options.profile ?? defaultAutonomyProfile;

  return async (request) => {
    if (!request || typeof request.runId !== "string" || !request.runId.trim() ||
        typeof request.toolCall?.tool !== "string" || !request.toolCall.tool.trim() ||
        !request.toolCall.input || typeof request.toolCall.input !== "object" ||
        Array.isArray(request.toolCall.input) || !Array.isArray(request.effects) ||
        request.effects.some((effect) => typeof effect !== "string")) {
      return { allowed: false, reason: "Malformed Brain authorization request; default deny." };
    }

    let action: AutonomyAction | undefined;
    try {
      action = options.classifyTool(request);
    } catch {
      return { allowed: false, reason: "Host tool classification failed; default deny." };
    }
    if (!action) {
      return { allowed: false, reason: "Tool has no explicit host-owned autonomy classification; default deny." };
    }

    let context: AutonomyContext;
    try {
      context = await options.getTrustedContext(request, action);
    } catch {
      return { allowed: false, reason: "Trusted runtime context is unavailable; default deny." };
    }
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      return { allowed: false, reason: "Trusted runtime context is malformed; default deny." };
    }

    const decision = evaluateAutonomyRequest(action, profile, context);
    return { allowed: decision.allowed, reason: decision.reason };
  };
}
