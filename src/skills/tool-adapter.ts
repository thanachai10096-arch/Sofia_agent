import type { SofiaTool } from "../tools/types.js";
import type { AdvancedSkillExecutionContext } from "./advanced-skill-runtime.js";
import { createAdvancedSkillRegistry } from "./advanced-skill-registry.js";
import type { ProjectMemoryStore } from "../brain/project-memory.js";
import type { SecurityController } from "../security/controller.js";

/**
 * Expose only verified handlers as ordinary Sofia tools. Every invocation is
 * still executed by RegistryToolGateway, so tool policy, approval, audit and
 * kill-switch checks remain the outer authorization boundary.
 */
export function createAdvancedSkillTools(options: {
  projectMemoryStore?: ProjectMemoryStore;
  securityController: SecurityController;
}): SofiaTool[] {
  // The registry's approval verifier is intentionally satisfied only here:
  // this registry is private to the Brain run and its tools are reachable only
  // through RegistryToolGateway, which requires approval for write/destructive
  // effects before calling execute().
  const registry = createAdvancedSkillRegistry({
    projectMemoryStore: options.projectMemoryStore,
    securityController: options.securityController,
    verifyApproval: () => true,
  });

  const tools: SofiaTool[] = registry.list().map((definition) => {
    const effects = definition.risk === "privileged"
      ? ["destructive" as const]
      : definition.risk === "may-write" || definition.requiresApproval
        ? ["write" as const]
        : ["read" as const];
    return {
      name: "skill." + definition.id,
      description: "[" + definition.category + "] " + definition.name + ": " + definition.description,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      effects,
      async execute(input, context) {
        const executionContext: AdvancedSkillExecutionContext = {
          principalId: options.securityController.isRunning() ? "sofia-runtime" : "sofia-stopped",
          signal: context.signal ?? new AbortController().signal,
        };
        return registry.execute(definition.id, input, executionContext);
      },
    };
  });

  tools.push({
    name: "skill.list",
    description: "List verified skill handlers available in this Sofia runtime.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effects: ["read"],
    async execute() {
      return registry.list().map(({ id, name, category, risk, requiresApproval }) => ({
        id, name, category, risk, requiresApproval,
      }));
    },
  });
  return tools;
}
