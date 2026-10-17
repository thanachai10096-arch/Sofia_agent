# Sofia Agent — Advanced Skill Catalog (100)

**Status: partial implementation.** The catalog contains 100 capabilities. Forty-eight runtime/security/memory/quality/research/workflow/evolution/multi-agent/coding-planning skills are marked `verified`, including three runtime recovery handlers; the remaining 52 entries are `planned`. A skill becomes `implemented` only after a handler exists and `verified` only after its acceptance criteria pass. Catalog metadata must never grant permissions by itself.

## Shared implementation contract

Every runnable skill must: (1) declare a versioned input/output schema; (2) use the Tool Registry rather than bypassing the runtime; (3) enforce workspace, user, tenant, and capability scopes; (4) treat model output, web pages, files, and tool output as untrusted; (5) support cancellation, timeout, and bounded retries; (6) emit trace/audit events without secrets; (7) define success and failure criteria; (8) have unit and integration tests; and (9) request human approval before privileged or irreversible actions.

## Catalog

### Runtime & Recovery

- **runtime.01 — Intent Clarifier** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Intent Clarifier: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **runtime.02 — Goal Decomposer** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Goal Decomposer: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **runtime.03 — Plan Builder** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Plan Builder: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **runtime.04 — Dependency Scheduler** — Risk: `may-write`; status: `verified`; approval: **policy-dependent**. Dependency Scheduler: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **runtime.05 — Execution Trace Analyzer** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Execution Trace Analyzer: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **runtime.06 — Checkpoint Manager** — Risk: `may-write`; approval: **policy-dependent**. Checkpoint Manager: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **runtime.07 — Crash Recovery** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Crash Recovery: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **runtime.08 — Retry Strategist** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Retry Strategist: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **runtime.09 — Failure Classifier** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Failure Classifier: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **runtime.10 — Completion Verifier** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Completion Verifier: runtime & recovery capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.

### Conversation & Memory

- **conversation.01 — Natural Conversation** — Risk: `read-only`; approval: **policy-dependent**. Natural Conversation: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **conversation.02 — Context Summarizer** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Context Summarizer: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **conversation.03 — User Preference Memory** — Risk: `read-only`; approval: **policy-dependent**. User Preference Memory: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **conversation.04 — Project Memory Retrieval** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Project Memory Retrieval: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **conversation.05 — Memory Conflict Resolver** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Memory Conflict Resolver: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **conversation.06 — Conversation-to-Task Parser** — Risk: `may-write`; approval: **policy-dependent**. Conversation-to-Task Parser: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **conversation.07 — Clarifying Question Planner** — Risk: `read-only`; approval: **policy-dependent**. Clarifying Question Planner: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **conversation.08 — Session Handoff** — Risk: `read-only`; approval: **policy-dependent**. Session Handoff: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **conversation.09 — Long-Context Compressor** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Long-Context Compressor: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **conversation.10 — Memory Retention Policy** — Risk: `may-write`; approval: **policy-dependent**. Memory Retention Policy: conversation & memory capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.

### Software Engineering

- **coding.01 — Repository Mapper** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Repository Mapper: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **coding.02 — Codebase Semantic Search** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Codebase Semantic Search: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **coding.03 — Change Impact Analyzer** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Change Impact Analyzer: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **coding.04 — Implementation Planner** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Implementation Planner: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **coding.05 — Patch Generator** — Risk: `may-write`; approval: **required for sensitive actions**. Patch Generator: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **coding.06 — TypeScript Specialist** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. TypeScript Specialist: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **coding.07 — Python Specialist** — Risk: `may-write`; approval: **policy-dependent**. Python Specialist: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **coding.08 — API Contract Designer** — Risk: `may-write`; approval: **policy-dependent**. API Contract Designer: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **coding.09 — Refactoring Planner** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Refactoring Planner: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **coding.10 — Code Review Auditor** — Risk: `may-write`; approval: **policy-dependent**. Code Review Auditor: software engineering capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.

### Testing & Quality

- **testing.01 — Test Strategy Builder** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Test Strategy Builder: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **testing.02 — Unit Test Generator** — Risk: `may-write`; approval: **policy-dependent**. Unit Test Generator: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **testing.03 — Integration Test Designer** — Risk: `read-only`; approval: **policy-dependent**. Integration Test Designer: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **testing.04 — End-to-End Test Planner** — Risk: `may-write`; approval: **policy-dependent**. End-to-End Test Planner: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **testing.05 — Regression Test Selector** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Regression Test Selector: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **testing.06 — Flaky Test Detector** — Risk: `may-write`; approval: **policy-dependent**. Flaky Test Detector: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **testing.07 — Coverage Gap Analyzer** — Risk: `read-only`; approval: **policy-dependent**. Coverage Gap Analyzer: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **testing.08 — Acceptance Criteria Verifier** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Acceptance Criteria Verifier: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **testing.09 — Static Analysis Coordinator** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Static Analysis Coordinator: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **testing.10 — Release Readiness Auditor** — Risk: `may-write`; approval: **policy-dependent**. Release Readiness Auditor: testing & quality capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.

### Security & Permissions

- **security.01 — Permission Policy Evaluator** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Permission Policy Evaluator: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **security.02 — Least-Privilege Planner** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Least-Privilege Planner: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **security.03 — Secret Leak Detector** — Risk: `privileged`; approval: **required for sensitive actions**. Secret Leak Detector: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **security.04 — Prompt Injection Detector** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Prompt Injection Detector: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **security.05 — Untrusted Output Fencer** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Untrusted Output Fencer: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **security.06 — Path Traversal Guard** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Path Traversal Guard: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **security.07 — Command Risk Classifier** — Risk: `privileged`; approval: **required for sensitive actions**. Command Risk Classifier: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **security.08 — Approval Gate Manager** — Risk: `read-only`; approval: **policy-dependent**. Approval Gate Manager: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **security.09 — Audit Trail Writer** — Risk: `privileged`; approval: **required for sensitive actions**. Audit Trail Writer: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **security.10 — Security Regression Tester** — Risk: `read-only`; approval: **policy-dependent**. Security Regression Tester: security & permissions capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.

### Tools & Automation

- **tools.01 — Tool Discovery Router** — Risk: `may-write`; approval: **policy-dependent**. Tool Discovery Router: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **tools.02 — Tool Argument Validator** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Tool Argument Validator: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **tools.03 — Tool Result Normalizer** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Tool Result Normalizer: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **tools.04 — Browser Workflow Planner** — Risk: `read-only`; approval: **policy-dependent**. Browser Workflow Planner: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **tools.05 — Browser State Verifier** — Risk: `may-write`; approval: **policy-dependent**. Browser State Verifier: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **tools.06 — Terminal Task Runner** — Risk: `read-only`; approval: **required for sensitive actions**. Terminal Task Runner: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **tools.07 — File Workspace Operator** — Risk: `may-write`; approval: **required for sensitive actions**. File Workspace Operator: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **tools.08 — Git Workflow Operator** — Risk: `may-write`; approval: **required for sensitive actions**. Git Workflow Operator: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **tools.09 — API Connector Orchestrator** — Risk: `read-only`; approval: **policy-dependent**. API Connector Orchestrator: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **tools.10 — External Action Approval** — Risk: `may-write`; approval: **required for sensitive actions**. External Action Approval: tools & automation capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.

### Research & Knowledge

- **research.01 — Web Research Planner** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Web Research Planner: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **research.02 — Source Credibility Ranker** — Risk: `may-write`; approval: **policy-dependent**. Source Credibility Ranker: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **research.03 — Claim Evidence Mapper** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Claim Evidence Mapper: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **research.04 — Cross-Source Synthesizer** — Risk: `may-write`; approval: **policy-dependent**. Cross-Source Synthesizer: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **research.05 — Freshness Checker** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Freshness Checker: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **research.06 — Fact Conflict Detector** — Risk: `may-write`; approval: **policy-dependent**. Fact Conflict Detector: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **research.07 — Technical Documentation Reader** — Risk: `read-only`; approval: **policy-dependent**. Technical Documentation Reader: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **research.08 — Citation Builder** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Citation Builder: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **research.09 — Market Gap Analyst** — Risk: `read-only`; approval: **policy-dependent**. Market Gap Analyst: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **research.10 — Research Brief Writer** — Risk: `may-write`; approval: **policy-dependent**. Research Brief Writer: research & knowledge capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.

### Multi-Agent Coordination

- **agents.01 — Agent Task Delegator** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Agent Task Delegator: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **agents.02 — Specialist Router** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Specialist Router: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **agents.03 — Agent Message Validator** — Risk: `privileged`; approval: **required for sensitive actions**. Agent Message Validator: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **agents.04 — Shared Task Board** — Risk: `read-only`; approval: **policy-dependent**. Shared Task Board: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **agents.05 — Handoff Contract Manager** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Handoff Contract Manager: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **agents.06 — Parallel Work Coordinator** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Parallel Work Coordinator: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **agents.07 — Agent Result Reviewer** — Risk: `privileged`; approval: **required for sensitive actions**. Agent Result Reviewer: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **agents.08 — Disagreement Resolver** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Disagreement Resolver: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **agents.09 — Loop and Deadlock Detector** — Risk: `privileged`; approval: **required for sensitive actions**. Loop and Deadlock Detector: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **agents.10 — Human-Goal Alignment Monitor** — Risk: `read-only`; approval: **policy-dependent**. Human-Goal Alignment Monitor: multi-agent coordination capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.

### Workflow & Productivity

- **workflow.01 — Workflow Builder** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Workflow Builder: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **workflow.02 — Workflow Trigger Evaluator** — Risk: `may-write`; approval: **policy-dependent**. Workflow Trigger Evaluator: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **workflow.03 — Scheduled Job Planner** — Risk: `read-only`; approval: **required for sensitive actions**. Scheduled Job Planner: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **workflow.04 — Long-Running Job Monitor** — Risk: `read-only`; approval: **required for sensitive actions**. Long-Running Job Monitor: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **workflow.05 — Idempotency Guard** — Risk: `may-write`; approval: **policy-dependent**. Idempotency Guard: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **workflow.06 — Rate Limit Manager** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Rate Limit Manager: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **workflow.07 — SLA Watchdog** — Risk: `may-write`; approval: **policy-dependent**. SLA Watchdog: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **workflow.08 — Notification Planner** — Risk: `may-write`; approval: **policy-dependent**. Notification Planner: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **workflow.09 — Business Process Mapper** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Business Process Mapper: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **workflow.10 — Workflow Replay Tester** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Workflow Replay Tester: workflow & productivity capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.

### Learning & Optimization

- **evolution.01 — Skill Success Scorer** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Skill Success Scorer: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **evolution.02 — Failure Memory Curator** — Risk: `may-write`; approval: **policy-dependent**. Failure Memory Curator: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **evolution.03 — Skill Ranking Engine** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Skill Ranking Engine: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **evolution.04 — Prompt Variant Evaluator** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Prompt Variant Evaluator: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **evolution.05 — Model Router Optimizer** — Risk: `may-write`; approval: **policy-dependent**. Model Router Optimizer: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **evolution.06 — Token Budget Planner** — Risk: `read-only`; status: `verified`; approval: **policy-dependent**. Token Budget Planner: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **evolution.07 — Cost and Latency Analyzer** — Risk: `may-write`; approval: **policy-dependent**. Cost and Latency Analyzer: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **evolution.08 — Offline Evaluation Runner** — Risk: `may-write`; approval: **policy-dependent**. Offline Evaluation Runner: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **evolution.09 — Skill Promotion Gate** — Risk: `read-only`; status: `verified`; approval: **required for sensitive actions**. Skill Promotion Gate: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.
- **evolution.10 — Skill Rollback Manager** — Risk: `may-write`; approval: **required for sensitive actions**. Skill Rollback Manager: learning & optimization capability. Must use registered tools, scoped permissions, structured inputs, bounded execution, trace events, and verifiable outputs.

## Required rollout order

1. Runtime contracts, trace events, cancellation, and recovery.
2. Permission enforcement and approval gates before write-capable skills.
3. Memory, research, coding, and verification skills with acceptance tests.
4. Workflow and multi-agent coordination under human-goal and scope constraints.
5. Evolution/optimization skills only after evaluation data exists; learned skills remain quarantined until reviewed.

## Definition of done for each skill

- Typed schema and registered handler exist.
- Positive, negative, permission-denied, timeout, cancellation, and malformed-input tests pass as applicable.
- Output is independently verified where possible.
- No secret leakage and no workspace-boundary escape in tests.
- Trace explains actions and evidence without exposing credentials.
- Status is promoted from `planned` to `implemented` and then `verified` only with evidence.
