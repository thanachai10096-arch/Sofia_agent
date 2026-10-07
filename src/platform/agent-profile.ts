export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  systemInstructions?: string;
  allowedTools: string[];
  defaultSkillIds: string[];
  policyOverrides?: Record<string, boolean>;
}

export interface AgentTemplate {
  id: string;
  profileId: string;
  name: string;
  description: string;
  taskHints: string[];
  skillIds: string[];
}
