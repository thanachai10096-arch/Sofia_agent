/**
 * Sofia Agent advanced skill catalog.
 *
 * IMPORTANT: this is a design-time catalog, not 100 implemented skill handlers.
 * Keep status="planned" until a handler is registered and its acceptance tests pass.
 * Never use catalog metadata as an authorization decision; enforce policy at runtime.
 */
export type SkillRisk = "read-only" | "may-write" | "privileged";
export type SkillStatus = "planned" | "implemented" | "verified" | "quarantined";

export interface AdvancedSkillDefinition {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly risk: SkillRisk;
  readonly status: SkillStatus;
  readonly requiresApproval: boolean;
  readonly description: string;
}

export const ADVANCED_SKILLS: readonly AdvancedSkillDefinition[] = [
  {
    "id": "runtime.01",
    "name": "Intent Clarifier",
    "category": "Runtime & Recovery",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Intent Clarifier: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "runtime.02",
    "name": "Goal Decomposer",
    "category": "Runtime & Recovery",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Goal Decomposer: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "runtime.03",
    "name": "Plan Builder",
    "category": "Runtime & Recovery",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Plan Builder: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "runtime.04",
    "name": "Dependency Scheduler",
    "category": "Runtime & Recovery",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Dependency Scheduler: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "runtime.05",
    "name": "Execution Trace Analyzer",
    "category": "Runtime & Recovery",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "Execution Trace Analyzer: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "runtime.06",
    "name": "Checkpoint Manager",
    "category": "Runtime & Recovery",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Checkpoint Manager: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "runtime.07",
    "name": "Crash Recovery",
    "category": "Runtime & Recovery",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "Crash Recovery: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "runtime.08",
    "name": "Retry Strategist",
    "category": "Runtime & Recovery",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Retry Strategist: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "runtime.09",
    "name": "Failure Classifier",
    "category": "Runtime & Recovery",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Failure Classifier: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "runtime.10",
    "name": "Completion Verifier",
    "category": "Runtime & Recovery",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Completion Verifier: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "conversation.01",
    "name": "Natural Conversation",
    "category": "Conversation & Memory",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "Natural Conversation: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "conversation.02",
    "name": "Context Summarizer",
    "category": "Conversation & Memory",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Context Summarizer: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "conversation.03",
    "name": "User Preference Memory",
    "category": "Conversation & Memory",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "User Preference Memory: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "conversation.04",
    "name": "Project Memory Retrieval",
    "category": "Conversation & Memory",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Project Memory Retrieval: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "conversation.05",
    "name": "Memory Conflict Resolver",
    "category": "Conversation & Memory",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Memory Conflict Resolver: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "conversation.06",
    "name": "Conversation-to-Task Parser",
    "category": "Conversation & Memory",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Conversation-to-Task Parser: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "conversation.07",
    "name": "Clarifying Question Planner",
    "category": "Conversation & Memory",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "Clarifying Question Planner: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "conversation.08",
    "name": "Session Handoff",
    "category": "Conversation & Memory",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "Session Handoff: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "conversation.09",
    "name": "Long-Context Compressor",
    "category": "Conversation & Memory",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Long-Context Compressor: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "conversation.10",
    "name": "Memory Retention Policy",
    "category": "Conversation & Memory",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Memory Retention Policy: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "coding.01",
    "name": "Repository Mapper",
    "category": "Software Engineering",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Repository Mapper: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "coding.02",
    "name": "Codebase Semantic Search",
    "category": "Software Engineering",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Codebase Semantic Search: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "coding.03",
    "name": "Change Impact Analyzer",
    "category": "Software Engineering",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Change Impact Analyzer: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "coding.04",
    "name": "Implementation Planner",
    "category": "Software Engineering",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "Implementation Planner: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "coding.05",
    "name": "Patch Generator",
    "category": "Software Engineering",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": true,
    "description": "Patch Generator: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "coding.06",
    "name": "TypeScript Specialist",
    "category": "Software Engineering",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "TypeScript Specialist: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "coding.07",
    "name": "Python Specialist",
    "category": "Software Engineering",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Python Specialist: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "coding.08",
    "name": "API Contract Designer",
    "category": "Software Engineering",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "API Contract Designer: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "coding.09",
    "name": "Refactoring Planner",
    "category": "Software Engineering",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "Refactoring Planner: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "coding.10",
    "name": "Code Review Auditor",
    "category": "Software Engineering",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Code Review Auditor: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "testing.01",
    "name": "Test Strategy Builder",
    "category": "Testing & Quality",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Test Strategy Builder: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "testing.02",
    "name": "Unit Test Generator",
    "category": "Testing & Quality",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Unit Test Generator: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "testing.03",
    "name": "Integration Test Designer",
    "category": "Testing & Quality",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "Integration Test Designer: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "testing.04",
    "name": "End-to-End Test Planner",
    "category": "Testing & Quality",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "End-to-End Test Planner: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "testing.05",
    "name": "Regression Test Selector",
    "category": "Testing & Quality",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Regression Test Selector: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "testing.06",
    "name": "Flaky Test Detector",
    "category": "Testing & Quality",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Flaky Test Detector: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "testing.07",
    "name": "Coverage Gap Analyzer",
    "category": "Testing & Quality",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "Coverage Gap Analyzer: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "testing.08",
    "name": "Acceptance Criteria Verifier",
    "category": "Testing & Quality",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Acceptance Criteria Verifier: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "testing.09",
    "name": "Static Analysis Coordinator",
    "category": "Testing & Quality",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Static Analysis Coordinator: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "testing.10",
    "name": "Release Readiness Auditor",
    "category": "Testing & Quality",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Release Readiness Auditor: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "security.01",
    "name": "Permission Policy Evaluator",
    "category": "Security & Permissions",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Permission Policy Evaluator: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "security.02",
    "name": "Least-Privilege Planner",
    "category": "Security & Permissions",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Least-Privilege Planner: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "security.03",
    "name": "Secret Leak Detector",
    "category": "Security & Permissions",
    "risk": "privileged",
    "status": "planned",
    "requiresApproval": true,
    "description": "Secret Leak Detector: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "security.04",
    "name": "Prompt Injection Detector",
    "category": "Security & Permissions",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Prompt Injection Detector: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "security.05",
    "name": "Untrusted Output Fencer",
    "category": "Security & Permissions",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Untrusted Output Fencer: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "security.06",
    "name": "Path Traversal Guard",
    "category": "Security & Permissions",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Path Traversal Guard: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "security.07",
    "name": "Command Risk Classifier",
    "category": "Security & Permissions",
    "risk": "privileged",
    "status": "planned",
    "requiresApproval": true,
    "description": "Command Risk Classifier: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "security.08",
    "name": "Approval Gate Manager",
    "category": "Security & Permissions",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "Approval Gate Manager: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "security.09",
    "name": "Audit Trail Writer",
    "category": "Security & Permissions",
    "risk": "privileged",
    "status": "planned",
    "requiresApproval": true,
    "description": "Audit Trail Writer: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "security.10",
    "name": "Security Regression Tester",
    "category": "Security & Permissions",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "Security Regression Tester: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "tools.01",
    "name": "Tool Discovery Router",
    "category": "Tools & Automation",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Tool Discovery Router: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "tools.02",
    "name": "Tool Argument Validator",
    "category": "Tools & Automation",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Tool Argument Validator: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "tools.03",
    "name": "Tool Result Normalizer",
    "category": "Tools & Automation",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Tool Result Normalizer: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "tools.04",
    "name": "Browser Workflow Planner",
    "category": "Tools & Automation",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "Browser Workflow Planner: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "tools.05",
    "name": "Browser State Verifier",
    "category": "Tools & Automation",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Browser State Verifier: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "tools.06",
    "name": "Terminal Task Runner",
    "category": "Tools & Automation",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": true,
    "description": "Terminal Task Runner: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "tools.07",
    "name": "File Workspace Operator",
    "category": "Tools & Automation",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": true,
    "description": "File Workspace Operator: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "tools.08",
    "name": "Git Workflow Operator",
    "category": "Tools & Automation",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": true,
    "description": "Git Workflow Operator: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "tools.09",
    "name": "API Connector Orchestrator",
    "category": "Tools & Automation",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "API Connector Orchestrator: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "tools.10",
    "name": "External Action Approval",
    "category": "Tools & Automation",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": true,
    "description": "External Action Approval: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "research.01",
    "name": "Web Research Planner",
    "category": "Research & Knowledge",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Web Research Planner: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "research.02",
    "name": "Source Credibility Ranker",
    "category": "Research & Knowledge",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Source Credibility Ranker: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "research.03",
    "name": "Claim Evidence Mapper",
    "category": "Research & Knowledge",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Claim Evidence Mapper: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "research.04",
    "name": "Cross-Source Synthesizer",
    "category": "Research & Knowledge",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Cross-Source Synthesizer: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "research.05",
    "name": "Freshness Checker",
    "category": "Research & Knowledge",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Freshness Checker: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "research.06",
    "name": "Fact Conflict Detector",
    "category": "Research & Knowledge",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Fact Conflict Detector: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "research.07",
    "name": "Technical Documentation Reader",
    "category": "Research & Knowledge",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "Technical Documentation Reader: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "research.08",
    "name": "Citation Builder",
    "category": "Research & Knowledge",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Citation Builder: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "research.09",
    "name": "Market Gap Analyst",
    "category": "Research & Knowledge",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "Market Gap Analyst: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "research.10",
    "name": "Research Brief Writer",
    "category": "Research & Knowledge",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Research Brief Writer: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "agents.01",
    "name": "Agent Task Delegator",
    "category": "Multi-Agent Coordination",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Agent Task Delegator: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "agents.02",
    "name": "Specialist Router",
    "category": "Multi-Agent Coordination",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Specialist Router: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "agents.03",
    "name": "Agent Message Validator",
    "category": "Multi-Agent Coordination",
    "risk": "privileged",
    "status": "planned",
    "requiresApproval": true,
    "description": "Agent Message Validator: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "agents.04",
    "name": "Shared Task Board",
    "category": "Multi-Agent Coordination",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "Shared Task Board: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "agents.05",
    "name": "Handoff Contract Manager",
    "category": "Multi-Agent Coordination",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Handoff Contract Manager: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "agents.06",
    "name": "Parallel Work Coordinator",
    "category": "Multi-Agent Coordination",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Parallel Work Coordinator: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "agents.07",
    "name": "Agent Result Reviewer",
    "category": "Multi-Agent Coordination",
    "risk": "privileged",
    "status": "planned",
    "requiresApproval": true,
    "description": "Agent Result Reviewer: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "agents.08",
    "name": "Disagreement Resolver",
    "category": "Multi-Agent Coordination",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Disagreement Resolver: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "agents.09",
    "name": "Loop and Deadlock Detector",
    "category": "Multi-Agent Coordination",
    "risk": "privileged",
    "status": "planned",
    "requiresApproval": true,
    "description": "Loop and Deadlock Detector: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "agents.10",
    "name": "Human-Goal Alignment Monitor",
    "category": "Multi-Agent Coordination",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": false,
    "description": "Human-Goal Alignment Monitor: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "workflow.01",
    "name": "Workflow Builder",
    "category": "Workflow & Productivity",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Workflow Builder: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "workflow.02",
    "name": "Workflow Trigger Evaluator",
    "category": "Workflow & Productivity",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Workflow Trigger Evaluator: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "workflow.03",
    "name": "Scheduled Job Planner",
    "category": "Workflow & Productivity",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": true,
    "description": "Scheduled Job Planner: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "workflow.04",
    "name": "Long-Running Job Monitor",
    "category": "Workflow & Productivity",
    "risk": "read-only",
    "status": "planned",
    "requiresApproval": true,
    "description": "Long-Running Job Monitor: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "workflow.05",
    "name": "Idempotency Guard",
    "category": "Workflow & Productivity",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Idempotency Guard: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "workflow.06",
    "name": "Rate Limit Manager",
    "category": "Workflow & Productivity",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Rate Limit Manager: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "workflow.07",
    "name": "SLA Watchdog",
    "category": "Workflow & Productivity",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "SLA Watchdog: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "workflow.08",
    "name": "Notification Planner",
    "category": "Workflow & Productivity",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Notification Planner: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "workflow.09",
    "name": "Business Process Mapper",
    "category": "Workflow & Productivity",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Business Process Mapper: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "workflow.10",
    "name": "Workflow Replay Tester",
    "category": "Workflow & Productivity",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Workflow Replay Tester: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "evolution.01",
    "name": "Skill Success Scorer",
    "category": "Learning & Optimization",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Skill Success Scorer: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "evolution.02",
    "name": "Failure Memory Curator",
    "category": "Learning & Optimization",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Failure Memory Curator: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "evolution.03",
    "name": "Skill Ranking Engine",
    "category": "Learning & Optimization",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Skill Ranking Engine: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "evolution.04",
    "name": "Prompt Variant Evaluator",
    "category": "Learning & Optimization",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Prompt Variant Evaluator: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "evolution.05",
    "name": "Model Router Optimizer",
    "category": "Learning & Optimization",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Model Router Optimizer: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "evolution.06",
    "name": "Token Budget Planner",
    "category": "Learning & Optimization",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": false,
    "description": "Token Budget Planner: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "evolution.07",
    "name": "Cost and Latency Analyzer",
    "category": "Learning & Optimization",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Cost and Latency Analyzer: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "evolution.08",
    "name": "Offline Evaluation Runner",
    "category": "Learning & Optimization",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": false,
    "description": "Offline Evaluation Runner: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "evolution.09",
    "name": "Skill Promotion Gate",
    "category": "Learning & Optimization",
    "risk": "read-only",
    "status": "verified",
    "requiresApproval": true,
    "description": "Skill Promotion Gate: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  },
  {
    "id": "evolution.10",
    "name": "Skill Rollback Manager",
    "category": "Learning & Optimization",
    "risk": "may-write",
    "status": "planned",
    "requiresApproval": true,
    "description": "Skill Rollback Manager: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs."
  }
] as const;

export const ADVANCED_SKILL_COUNT = ADVANCED_SKILLS.length;

export function getAdvancedSkill(id: string): AdvancedSkillDefinition | undefined {
  return ADVANCED_SKILLS.find((skill) => skill.id === id);
}

export function listAdvancedSkillsByCategory(category: string): AdvancedSkillDefinition[] {
  const normalized = category.trim().toLowerCase();
  return ADVANCED_SKILLS.filter((skill) => skill.category.toLowerCase() === normalized);
}

export function validateAdvancedSkillCatalog(): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const skill of ADVANCED_SKILLS) {
    if (ids.has(skill.id)) errors.push(`Duplicate skill id: ${skill.id}`);
    ids.add(skill.id);
    if (!skill.id || !skill.name.trim() || !skill.category.trim()) errors.push(`Invalid required metadata: ${skill.id || "(empty id)"}`);
    if (skill.risk === "privileged" && !skill.requiresApproval) errors.push(`Privileged skill must require approval: ${skill.id}`);
    if (skill.status === "planned" && skill.description.length === 0) errors.push(`Planned skill requires a description: ${skill.id}`);
  }
  if (ADVANCED_SKILLS.length !== 100) errors.push(`Expected 100 skills, found ${ADVANCED_SKILLS.length}`);
  return errors;
}
