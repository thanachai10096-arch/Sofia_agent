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

  const searchTool: SofiaTool = {
    name: "skills.search",
    description: "Search only the verified skill handlers registered in this runtime by goal, task, capability, or topic. Discovery only: invoke the returned skill.<id> tool separately to execute it. A skill result is not proof that the user's overall task is complete.",
    effects: ["read"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input) {
      const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
      if (query.length < 2 || query.length > 500) throw new TypeError("query must contain 2 to 500 characters.");
      const tokens = [...new Set(query.split(/[^\p{L}\p{N}._-]+/u).filter((token) => token.length >= 2))].slice(0, 40);
      const limit = typeof input.limit === "number" && Number.isInteger(input.limit)
        ? Math.max(1, Math.min(10, input.limit))
        : 5;
      const matches = registry.list().map((definition) => {
        const haystack = [definition.id, definition.name, definition.category, definition.description].join(" ").toLowerCase();
        const score = tokens.reduce((total, token) => total + (haystack.includes(token) ? (definition.name.toLowerCase().includes(token) ? 4 : 1) : 0), 0);
        return { definition, score };
      }).filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.definition.id.localeCompare(b.definition.id))
        .slice(0, limit)
        .map(({ definition, score }) => ({
          id: definition.id,
          toolName: `skill.${definition.id}`,
          name: definition.name,
          category: definition.category,
          risk: definition.risk,
          requiresApproval: definition.requiresApproval,
          score,
          description: definition.description,
        }));
      return {
        query,
        matches,
        matchCount: matches.length,
        registeredOnly: true,
        executionPerformed: false,
        overallTaskVerified: false,
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

  return [listTool, searchTool, ...skillTools];
}
