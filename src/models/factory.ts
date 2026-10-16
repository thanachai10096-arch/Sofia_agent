import { TokenBudget, type BudgetLimit } from "../brain/token-budget.js";
import { TokenAwareGateway } from "../brain/token-aware-gateway.js";
import { TokenAwareBrainReasoner } from "../brain/token-aware-reasoner.js";
import { createInternalRoute } from "../brain/model-route-adapter.js";
import { RegistryToolGateway } from "../brain/registry-tool-gateway.js";
import { createSofiaBrain } from "../brain/executor.js";
import type { BrainLimits } from "../brain/types.js";
import { ModelRouter } from "./router.js";
import { SofiaModelGateway } from "./gateway.js";
import { loadModelConfigFromEnv } from "./config.js";
import type { AgentDependencies } from "../agent/types.js";
import { Reviewer } from "../review/reviewer.js";
import { createNodeWorkspaceRuntime } from "../platform/local-runtime.js";
import { createToolRegistry } from "../tools/registry.js";
import { assertSecurityConfiguration, loadExecutionPolicyFromEnv, toolPermission } from "../security/policy.js";
import { createBuiltinTools } from "../tools/builtin.js";
import { createBrowserTools } from "../browser/tools.js";
import { PlaywrightBrowserRuntime } from "../browser/runtime.js";
import { discoverProjectContext } from "../brain/project-context.js";
import { createSubagentRuntime } from "../brain/subagents.js";
import { DurableCheckpointManager } from "../brain/durable-checkpoint.js";
import { FileRunStore } from "../brain/run-store.js";
import { DurableJobRuntime } from "../brain/job-runtime.js";
import { buildRepositoryMap } from "../brain/repository-intelligence.js";
import { FileProjectMemoryStore, PersistentSkillLedger } from "../brain/project-memory.js";
import { FileUserMemoryStore } from "../brain/user-memory.js";
import { EvolutionEngine } from "../brain/evolution.js";
import path from "node:path";
import { SecurityController } from "../security/controller.js";
import { MemorySecurityAudit } from "../security/audit.js";
import { EncryptedFileAudit } from "../security/persistent-audit.js";
import { CompositeSecurityAudit } from "../security/audit.js";
import { createToolGatewayWorkflowAdapter } from "../brain/workflow-tool-adapter.js";
import { FileWorkflowExecutionJournal } from "../brain/workflow-execution-journal.js";
import { actionHash, riskFor } from "../security/guard.js";
import { DesktopRuntime, createDesktopPrincipal } from "../desktop/runtime.js";
import { createDesktopTools } from "../desktop/tools.js";
import type { DesktopCapability } from "../desktop/types.js";
import type { WorkflowOrchestratorDependencies } from "../brain/workflow-orchestrator.js";

function intEnv(name:string,fallback:number,minimum=0){const value=Number(process.env[name]);return Number.isSafeInteger(value)&&value>=minimum?value:fallback;}
const NO_COST_CAP=9_000_000_000_000_000_000n;
function bigintEnv(name:string,fallback:bigint){const value=process.env[name];if(!value)return fallback;try{const parsed=BigInt(value);return parsed>=0n?parsed:fallback;}catch{return fallback;}}

function createBrainFactory(config:ReturnType<typeof loadModelConfigFromEnv>,provider:SofiaModelGateway,workspace:string,evolution:EvolutionEngine,dependencies:{runtime:ReturnType<typeof createNodeWorkspaceRuntime>;tools:ReturnType<typeof createToolRegistry>;policy:ReturnType<typeof loadExecutionPolicyFromEnv>;approval?:AgentDependencies["approval"];security:SecurityController;audit:import("../security/audit.js").SecurityAuditSink;userMemory:FileUserMemoryStore}):NonNullable<AgentDependencies["brainFactory"]>{
  const routeAdapters=config.routes.map(route=>createInternalRoute({modelProvider:provider,route}));
  const checkpointManager=new DurableCheckpointManager(dependencies.runtime,workspace,path.join(workspace,".sofia","checkpoints"));
  const runStore=new FileRunStore(workspace);
  const projectMemory=new FileProjectMemoryStore(workspace);
  const userMemory=dependencies.userMemory;
  const skillLedger=new PersistentSkillLedger(projectMemory);
  return ({signal,maxSteps,principalId,desktopCapabilities,onRunSnapshot})=>{
    const runLimit:BudgetLimit={maxTokens:intEnv("SOFIA_BRAIN_MAX_TOKENS",60000,1),maxCostNanoUsd:bigintEnv("SOFIA_BRAIN_MAX_COST_NANO_USD",NO_COST_CAP),maxCalls:intEnv("SOFIA_BRAIN_MAX_MODEL_CALLS",12,1),maxInFlight:intEnv("SOFIA_BRAIN_MAX_IN_FLIGHT",1,1)};
    const models=config.routes.map(route=>({key:route.providerId??route.id,limit:{maxTokens:intEnv("SOFIA_BRAIN_MODEL_MAX_TOKENS",runLimit.maxTokens,1),maxCostNanoUsd:runLimit.maxCostNanoUsd,maxCalls:runLimit.maxCalls,maxInFlight:runLimit.maxInFlight},price:{inputNanoUsdPerToken:bigintEnv("SOFIA_"+route.id.toUpperCase()+"_INPUT_NANO_USD",0n),outputNanoUsdPerToken:bigintEnv("SOFIA_"+route.id.toUpperCase()+"_OUTPUT_NANO_USD",0n)}})).filter((m,i,a)=>a.findIndex(x=>x.key===m.key)===i);
    const budget=new TokenBudget(runLimit,models);
    const gateway=new TokenAwareGateway(budget,routeAdapters,intEnv("SOFIA_BRAIN_MODEL_TIMEOUT_MS",45000,1));
    const reasoner=new TokenAwareBrainReasoner(gateway);
    const grantedDesktopCapabilities = desktopCapabilities ?? [];
    const runTools = grantedDesktopCapabilities.length
      ? createToolRegistry([
          ...dependencies.tools.list(),
          ...createDesktopTools({
            runtime: new DesktopRuntime({
              workspaceRoot: workspace,
              allowedExecutables: (process.env.SOFIA_DESKTOP_ALLOWED_EXECUTABLES ?? "").split(",").map((value) => value.trim()).filter(Boolean),
            }),
            principal: createDesktopPrincipal(principalId ?? "local-agent", grantedDesktopCapabilities),
          }),
        ])
      : dependencies.tools;
    const toolGateway=new RegistryToolGateway({runtime:dependencies.runtime,tools:runTools},dependencies.policy,dependencies.approval,checkpointManager,dependencies.security,dependencies.audit);
    const subagents=createSubagentRuntime(reasoner,toolGateway);
    const limits:Partial<BrainLimits>={maxSteps:maxSteps??dependencies.policy.maxSteps,maxToolCalls:intEnv("SOFIA_BRAIN_MAX_TOOL_CALLS",100,1),maxReplans:intEnv("SOFIA_BRAIN_MAX_REPLANS",4,0),maxModelCalls:runLimit.maxCalls,maxTokens:runLimit.maxTokens,maxContextTokens:intEnv("SOFIA_BRAIN_MAX_CONTEXT_TOKENS",16000,1),maxOutputTokens:intEnv("SOFIA_BRAIN_MAX_OUTPUT_TOKENS",2048,1),timeoutMs:intEnv("SOFIA_BRAIN_TIMEOUT_MS",120000,1)};
    return createSofiaBrain({dependencies:{reasoner,tools:toolGateway,subagents,skillLedger,allowShell:dependencies.policy.allowShell,allowNetwork:dependencies.policy.allowNetwork,projectContextLoader:()=>discoverProjectContext(dependencies.runtime),repositoryMapLoader:task=>buildRepositoryMap(dependencies.runtime,task),runStore,projectMemory,userMemory,evolution,onRunSnapshot},limits});
  };
}

function createWorkflowRuntimeFactory(
  workspace: string,
  runtime: ReturnType<typeof createNodeWorkspaceRuntime>,
  tools: ReturnType<typeof createToolRegistry>,
  policy: ReturnType<typeof loadExecutionPolicyFromEnv>,
  approval: AgentDependencies["approval"],
  security: SecurityController,
  audit: import("../security/audit.js").SecurityAuditSink,
): NonNullable<AgentDependencies["workflowRuntime"]> {
  return (principalId: string): Omit<WorkflowOrchestratorDependencies, "store"> => {
    const checkpointManager = new DurableCheckpointManager(runtime, workspace, path.join(workspace, ".sofia", "checkpoints"));
    const approvedActions = new Set<string>();
    const executionJournal = new FileWorkflowExecutionJournal(principalId, path.join(workspace, ".sofia", "workflow-journal"));
    const rollbackGuards = new Map<string, { snapshotId: string; allowedPaths: Set<string> }>();
    const normalizeWorkspacePath = (value: string) => path.normalize(value).replace(/\\/g, "/").replace(/^\.\//, "");
    const gateway = new RegistryToolGateway(
      { runtime, tools },
      policy,
      async (request) => {
        // Consume only a ticket for the exact immutable action approved for this principal/step.
        if (approvedActions.delete(request.actionHash)) return true;
        return approval ? approval(request) : false;
      },
      checkpointManager,
      security,
      audit,
    );
    const adapter = createToolGatewayWorkflowAdapter({
      gateway,
      principalId,
      allowShell: policy.allowShell,
      allowNetwork: policy.allowNetwork,
    });
    const requestApproval = approval
      ? async (plan: import("../brain/workflow-plan.js").WorkflowPlan, step: import("../brain/workflow-plan.js").WorkflowStepRecord, checkpointId: string): Promise<boolean> => {
          if (!step.action) return false;
          const descriptor = gateway.describe(step.action.tool);
          if (!descriptor) return false;
          const runId = `${plan.id}:${step.id}`;
          const input = structuredClone(step.action.input);
          const hash = actionHash(runId, step.action.tool, input, principalId);
          const approved = await approval({
            runId,
            principalId,
            toolName: step.action.tool,
            input,
            actionHash: hash,
            risk: riskFor(descriptor.effects, input),
            checkpointId,
          });
          const gatewayWillAsk = descriptor.effects.some((effect) =>
            effect === "write" || effect === "shell" || effect === "network" ||
            effect === "browser" || effect === "destructive",
          ) || toolPermission(policy, step.action.tool, descriptor.effects).requireApproval === true;
          if (approved && gatewayWillAsk) approvedActions.add(hash);
          return approved;
        }
      : undefined;
    return {
      ...adapter,
      executeStep: async (step, context) => {
        const runId = `${context.workflowId}:${step.id}`;
        const hash = step.action ? actionHash(runId, step.action.tool, step.action.input, principalId) : undefined;
        try {
          if (step.consequential && step.checkpointId) {
            const signal = context.signal ?? new AbortController().signal;
            const baseline = await gateway.snapshot(signal);
            const allowedPaths = new Set<string>();
            if (typeof step.action?.input.path === "string") {
              allowedPaths.add(normalizeWorkspacePath(step.action.input.path));
            }
            if (Array.isArray(step.action?.input.operations)) {
              for (const operation of step.action.input.operations) {
                if (operation && typeof operation === "object" && typeof (operation as { path?: unknown }).path === "string") {
                  allowedPaths.add(normalizeWorkspacePath((operation as { path: string }).path));
                }
              }
            }
            rollbackGuards.set(step.checkpointId, { snapshotId: baseline.id, allowedPaths });
          }
          if (step.action && hash) {
            await executionJournal.recordStarted({ workflowId: context.workflowId, stepId: step.id, actionHash: hash });
          }
          const result = await adapter.executeStep(step, context);
          if (step.action && hash) {
            await executionJournal.recordCompleted({ workflowId: context.workflowId, stepId: step.id, actionHash: hash, evidenceIds: result.evidenceIds });
          }
          return result;
        } catch (error) {
          if (step.action && hash) {
            try {
              await executionJournal.recordFailed({
                workflowId: context.workflowId,
                stepId: step.id,
                actionHash: hash,
                error: error instanceof Error ? error.message : "Workflow tool action failed",
              });
            } catch {
              // Preserve the original execution error; absent/invalid journal entries remain fail-closed.
            }
          }
          throw error;
        } finally {
          if (step.action && hash) approvedActions.delete(hash);
        }
      },
      ...(requestApproval ? { requestApproval } : {}),
      rollbackCheckpoint: async (checkpointId: string, step: import("../brain/workflow-plan.js").WorkflowStepRecord, signal?: AbortSignal) => {
        const guard = rollbackGuards.get(checkpointId);
        if (!guard) throw new Error("Rollback blocked because no pre-action workspace baseline is available.");
        try {
          const changed = await gateway.changedFiles(guard.snapshotId, signal ?? new AbortController().signal);
          const unexpected = changed.map(normalizeWorkspacePath).filter((file) => !guard.allowedPaths.has(file));
          if (unexpected.length) {
            throw new Error(`Rollback blocked because workspace changes outside the failed action were detected: ${unexpected.slice(0, 10).join(", ")}`);
          }
          return { restoredFiles: await gateway.rollback(checkpointId, signal ?? new AbortController().signal) };
        } finally {
          rollbackGuards.delete(checkpointId);
        }
      },
      // No durable tool-result journal exists yet. A crash during a tool call is ambiguous,
      // so never infer success or automatically replay it.
      reconcileInterruptedStep: async (plan, step) => {
        if (!step.action) return "unknown" as const;
        const expectedHash = actionHash(`${plan.id}:${step.id}`, step.action.tool, step.action.input, principalId);
        const entry = await executionJournal.get(plan.id, step.id);
        if (!entry || entry.actionHash !== expectedHash || entry.status !== "completed") return "unknown" as const;
        return { state: "completed" as const, evidenceIds: entry.evidenceIds };
      },
    };
  };
}

export function createSofiaAgentDependencies(workspace=process.cwd(),approval?:AgentDependencies["approval"]):AgentDependencies{
  const config=loadModelConfigFromEnv(); const runtime=createNodeWorkspaceRuntime(workspace); const policy=loadExecutionPolicyFromEnv(); assertSecurityConfiguration(policy); const security=new SecurityController(); const memoryAudit=new MemorySecurityAudit(); const auditSecret=process.env.SOFIA_AUDIT_SECRET; const audit=auditSecret?new CompositeSecurityAudit([memoryAudit,new EncryptedFileAudit(path.join(workspace,".sofia","security-audit.log"),auditSecret)]):memoryAudit;
  const browserTools=policy.allowBrowser?createBrowserTools(new PlaywrightBrowserRuntime()):[];
  const tools=createToolRegistry([...createBuiltinTools(),...browserTools]);
  const provider=new SofiaModelGateway(config.providers);
  const evolution=new EvolutionEngine(path.join(workspace, ".sofia", "evolution.json"));
  const userMemory=new FileUserMemoryStore();
  const brainFactory=createBrainFactory(config,provider,workspace,evolution,{runtime,tools,policy,approval,security,audit,userMemory});
  const jobRuntime=new DurableJobRuntime(brainFactory,new FileRunStore(workspace),workspace);
  const workflowRuntime=createWorkflowRuntimeFactory(workspace,runtime,tools,policy,approval,security,audit);
  return{workflowRuntime,workflowStateRoot:path.join(workspace,".sofia","workflows"),router:new ModelRouter(config.routes),provider,reviewer:new Reviewer(),runtime,tools,policy,brainFactory,jobRuntime,securityController:security,securityAudit:memoryAudit,learningDiagnostics:()=>evolution.getDiagnostics(),userMemory};
}
