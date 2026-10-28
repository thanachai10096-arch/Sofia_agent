import { FileUserMemoryStore } from "../brain/user-memory.js";
import { SqliteSessionStore } from "../session/sqlite-store.js";
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
import { assertSecurityConfiguration, loadExecutionPolicyFromEnv } from "../security/policy.js";
import { createBuiltinTools } from "../tools/builtin.js";
import { createBrowserTools } from "../browser/tools.js";
import { PlaywrightBrowserRuntime } from "../browser/runtime.js";
import { discoverProjectContext } from "../brain/project-context.js";
import { createSubagentRuntime } from "../brain/subagents.js";
import { CoordinatedSubagentRuntime } from "../brain/coordinated-subagent-runtime.js";
import { DurableCheckpointManager } from "../brain/durable-checkpoint.js";
import { FileRunStore } from "../brain/run-store.js";
import { DurableJobRuntime } from "../brain/job-runtime.js";
import { buildRepositoryMap } from "../brain/repository-intelligence.js";
import { FileProjectMemoryStore, PersistentSkillLedger } from "../brain/project-memory.js";
import { EvolutionEngine } from "../brain/evolution.js";
import { VersionedSkillLifecycle } from "../brain/skill-lifecycle.js";
import { evaluateLearnedSkillCandidate } from "../brain/skill-evaluation.js";
import { InMemorySkillsPlatform } from "../skills/platform.js";
import { createManagedSkillLearningHandler } from "../brain/managed-skill-learning.js";
import path from "node:path";
import { SecurityController } from "../security/controller.js";
import { MemorySecurityAudit } from "../security/audit.js";
import { EncryptedFileAudit } from "../security/persistent-audit.js";
import { CompositeSecurityAudit } from "../security/audit.js";
import { DesktopRuntime, createDesktopPrincipal } from "../desktop/runtime.js";
import { createDesktopTools } from "../desktop/tools.js";
import type { DesktopCapability } from "../desktop/types.js";

function intEnv(name:string,fallback:number,minimum=0){const value=Number(process.env[name]);return Number.isSafeInteger(value)&&value>=minimum?value:fallback;}
const NO_COST_CAP=9_000_000_000_000_000_000n;
function bigintEnv(name:string,fallback:bigint){const value=process.env[name];if(!value)return fallback;try{const parsed=BigInt(value);return parsed>=0n?parsed:fallback;}catch{return fallback;}}

function createBrainFactory(config:ReturnType<typeof loadModelConfigFromEnv>,provider:SofiaModelGateway,workspace:string,evolution:EvolutionEngine,dependencies:{runtime:ReturnType<typeof createNodeWorkspaceRuntime>;tools:ReturnType<typeof createToolRegistry>;policy:ReturnType<typeof loadExecutionPolicyFromEnv>;approval?:AgentDependencies["approval"];security:SecurityController;audit:import("../security/audit.js").SecurityAuditSink}):NonNullable<AgentDependencies["brainFactory"]>{
  const selectedProviderCache = new Map<string, SofiaModelGateway>();
  const checkpointManager=new DurableCheckpointManager(dependencies.runtime,workspace);
  const runStore=new FileRunStore(workspace);
  const projectMemory=new FileProjectMemoryStore(workspace);
  const skillLedger=new PersistentSkillLedger(projectMemory);
  const skillLifecycle=new VersionedSkillLifecycle(new InMemorySkillsPlatform(), evaluateLearnedSkillCandidate, { file: path.join(workspace, ".sofia", "skill-lifecycle.json") });
  const onSkillCandidate = createManagedSkillLearningHandler(skillLifecycle, dependencies.approval);
  return ({signal,maxSteps,principalId,desktopCapabilities,modelSelection,onRunSnapshot,onEvent})=>{
    // Explicit selection pins the chosen configured model ID across the run while retaining
    // the normal phase/capability routes. Auto mode keeps Sofia's existing route selection.
    const selectedModel = modelSelection && modelSelection !== "auto" ? config.providers[modelSelection]?.model : undefined;
    if (modelSelection && modelSelection !== "auto" && !selectedModel) {
      throw new Error("Selected model profile is not configured: " + modelSelection);
    }
    let selectedProvider = provider;
    if (selectedModel && modelSelection && modelSelection !== "auto") {
      selectedProvider = selectedProviderCache.get(modelSelection) ?? new SofiaModelGateway(
        Object.fromEntries(Object.entries(config.providers).map(([id, value]) => [id, { ...value, model: selectedModel }])),
      );
      selectedProviderCache.set(modelSelection, selectedProvider);
    }
    const routeAdapters=config.routes.map(route=>createInternalRoute({modelProvider:selectedProvider,route}));
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
    const rawSubagents=createSubagentRuntime(reasoner,toolGateway);
    const subagents=new CoordinatedSubagentRuntime(rawSubagents,{
      maxConcurrency:intEnv("SOFIA_SUBAGENT_MAX_CONCURRENCY",3,1),
      maxTasks:intEnv("SOFIA_SUBAGENT_MAX_TASKS",12,1),
      timeoutMs:intEnv("SOFIA_SUBAGENT_TIMEOUT_MS",60000,100),
      maxContextBytes:intEnv("SOFIA_SUBAGENT_MAX_CONTEXT_BYTES",32768,256),
    });
    const limits:Partial<BrainLimits>={maxSteps:maxSteps??dependencies.policy.maxSteps,maxToolCalls:intEnv("SOFIA_BRAIN_MAX_TOOL_CALLS",100,1),maxReplans:intEnv("SOFIA_BRAIN_MAX_REPLANS",4,0),maxModelCalls:runLimit.maxCalls,maxTokens:runLimit.maxTokens,maxContextTokens:intEnv("SOFIA_BRAIN_MAX_CONTEXT_TOKENS",16000,1),maxOutputTokens:intEnv("SOFIA_BRAIN_MAX_OUTPUT_TOKENS",2048,1),timeoutMs:intEnv("SOFIA_BRAIN_TIMEOUT_MS",120000,1)};
    return createSofiaBrain({dependencies:{reasoner,tools:toolGateway,subagents,skillLedger,onSkillCandidate,allowShell:dependencies.policy.allowShell,allowNetwork:dependencies.policy.allowNetwork,projectContextLoader:()=>discoverProjectContext(dependencies.runtime),repositoryMapLoader:task=>buildRepositoryMap(dependencies.runtime,task),runStore,projectMemory,evolution,onRunSnapshot,onEvent},limits});
  };
}

export function createSofiaAgentDependencies(workspace=process.cwd(),approval?:AgentDependencies["approval"]):AgentDependencies{
  const config=loadModelConfigFromEnv(); const runtime=createNodeWorkspaceRuntime(workspace); const policy=loadExecutionPolicyFromEnv(); assertSecurityConfiguration(policy); const security=new SecurityController(); const memoryAudit=new MemorySecurityAudit(); const auditSecret=process.env.SOFIA_AUDIT_SECRET; const audit=auditSecret?new CompositeSecurityAudit([memoryAudit,new EncryptedFileAudit(path.join(workspace,".sofia","security-audit.log"),auditSecret)]):memoryAudit;
  const browserTools=policy.allowBrowser?createBrowserTools(new PlaywrightBrowserRuntime()):[];
  const tools=createToolRegistry([...createBuiltinTools(),...browserTools]);
  const provider=new SofiaModelGateway(config.providers);
  const evolution=new EvolutionEngine(path.join(workspace, ".sofia", "evolution.json"));
  const brainFactory=createBrainFactory(config,provider,workspace,evolution,{runtime,tools,policy,approval,security,audit});
  const jobRuntime=new DurableJobRuntime(brainFactory,new FileRunStore(workspace),workspace);
  const userMemoryStore = new FileUserMemoryStore();
  return{router:new ModelRouter(config.routes),provider,reviewer:new Reviewer(),runtime,tools,policy,brainFactory,jobRuntime,securityController:security,securityAudit:memoryAudit,userMemoryStore,learningDiagnostics:()=>evolution.getDiagnostics()};
}

/** Create dependencies with opt-in durable SQLite transcripts; close the store on shutdown. */
export async function createSofiaAgentDependenciesWithSessions(
  workspace = process.cwd(),
  approval?: AgentDependencies["approval"],
  databasePath?: string,
): Promise<AgentDependencies & { closeSessionStore: () => void }> {
  const dependencies = createSofiaAgentDependencies(workspace, approval);
  const sessionStore = await SqliteSessionStore.open(databasePath);
  return { ...dependencies, sessionStore, closeSessionStore: () => sessionStore.close() };
}
