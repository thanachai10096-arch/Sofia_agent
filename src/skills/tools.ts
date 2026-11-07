import type { SofiaTool } from "../tools/types.js";
import type { AdvancedSkillRegistry } from "./advanced-skill-runtime.js";
import { listUnregisteredVerifiedSkills } from "./advanced-skill-registry.js";

/**
 * Adapts verified skills into the same tool surface consumed by Brain's
 * RegistryToolGateway. Risk metadata is mapped to gateway effects so existing
 * policy, approval, capability, audit, and kill-switch controls still apply.
 */
export function createAdvancedSkillTools(
  registry: AdvancedSkillRegistry,
  principalId: string,
): SofiaTool[] {
  const listTool: SofiaTool = {
    name: "skills.list",
    description: "List the verified skills actually registered in this Agent runtime, including their risk and approval requirements.",
    effects: ["read"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      return {
        registered: registry.list(),
        unregisteredVerified: listUnregisteredVerifiedSkills(registry),
      };
    },
  };

  const skillTools: SofiaTool[] = registry.list().map((definition) => ({
    name: `skill.${definition.id}`,
    description: `${definition.name}: ${definition.description} Risk: ${definition.risk}. Approval required: ${definition.requiresApproval}.`,
    effects: definition.risk === "privileged"
      ? ["destructive"]
      : definition.risk === "may-write"
        ? ["write"]
        : ["read"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    async execute(input, context) {
      const signal = context.signal ?? new AbortController().signal;
      return registry.execute(
        definition.id,
        input,
        {
          principalId,
          signal,
          approval: context.approval,
          emitTrace: () => {
            // Skill traces are intentionally kept internal to the tool result
            // until Brain has a first-class skill-event channel.
          },
        },
      );
    },
  }));

  return [listTool, ...skillTools];
}
