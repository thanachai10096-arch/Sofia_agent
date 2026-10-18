import type { ProjectMemoryStore } from "../brain/project-memory.js";
import type { SecurityController } from "../security/controller.js";
import { ADVANCED_SKILLS } from "./advanced-skill-catalog.js";
import {
  AdvancedSkillRegistry,
  type AdvancedSkillApprovalVerifier,
} from "./advanced-skill-runtime.js";
import { registerVerifiedCoreSkills } from "./core-handlers.js";
import { registerVerifiedRuntimeRecoverySkills } from "./runtime-recovery-handlers.js";
import { registerVerifiedSecuritySkills } from "./security-handlers.js";
import { registerVerifiedMemorySkills } from "./memory-handlers.js";
import { registerVerifiedQualitySkills } from "./quality-handlers.js";
import { registerVerifiedResearchSkills } from "./research-handlers.js";
import { registerVerifiedWorkflowSkills } from "./workflow-handlers.js";
import { registerVerifiedEvolutionSkills } from "./evolution-handlers.js";
import { registerVerifiedAgentCoordinationSkills } from "./agent-coordination-handlers.js";
import { registerVerifiedCodingPlanningSkills } from "./coding-planning-handlers.js";
import { registerVerifiedPlanningAnalysisSkills } from "./planning-analysis-handlers.js";
import { registerVerifiedSecurityCoordinationSkills } from "./security-coordination-handlers.js";
import { registerVerifiedRemainingDomainSkills } from "./remaining-domain-handlers.js";

export interface AdvancedSkillRegistryOptions {
  /** Enables the verified project-memory retrieval skill when supplied. */
  readonly projectMemoryStore?: ProjectMemoryStore;
  /** Must consult a trusted, action-bound Sofia approval source. Defaults to deny. */
  readonly verifyApproval?: AdvancedSkillApprovalVerifier;
  /** Optional global kill switch and abort binding shared with Sofia security. */
  readonly securityController?: SecurityController;
}

/**
 * Assemble all existing verified skill handlers into one guarded registry.
 * This does not promote catalog entries or grant tools additional permissions.
 * Approval-required skills remain denied unless a trusted verifier is supplied.
 */
export function createAdvancedSkillRegistry(
  options: AdvancedSkillRegistryOptions = {},
): AdvancedSkillRegistry {
  const registry = new AdvancedSkillRegistry(
    options.verifyApproval,
    options.securityController,
  );

  registerVerifiedCoreSkills(registry);
  registerVerifiedRuntimeRecoverySkills(registry);
  registerVerifiedSecuritySkills(registry);
  registerVerifiedMemorySkills(registry, options.projectMemoryStore);
  registerVerifiedQualitySkills(registry);
  registerVerifiedResearchSkills(registry);
  registerVerifiedWorkflowSkills(registry);
  registerVerifiedEvolutionSkills(registry);
  registerVerifiedAgentCoordinationSkills(registry);
  registerVerifiedCodingPlanningSkills(registry);
  registerVerifiedPlanningAnalysisSkills(registry);
  registerVerifiedSecurityCoordinationSkills(registry);
  registerVerifiedRemainingDomainSkills(registry);

  return registry;
}

/** Report verified catalog entries that are not available in this configured registry. */
export function listUnregisteredVerifiedSkills(
  registry: AdvancedSkillRegistry,
): string[] {
  return ADVANCED_SKILLS
    .filter((definition) => definition.status === "verified" && !registry.has(definition.id))
    .map((definition) => definition.id)
    .sort();
}
