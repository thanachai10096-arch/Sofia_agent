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
import { FileSettlementJournal } from "../brain/settlement-journal.js";
import { DurableJobRuntime } from "../brain/job-runtime.js";
import { buildRepositoryMap } from "../brain/repository-intelligence.js";
import { FileProjectMemoryStore, PersistentSkillLedger } from "../brain/project-memory.js";
import { EvolutionEngine } from "../brain/evolution.js";
import { VersionedSkillLifecycle } from "../brain/skill-lifecycle.js";
import { InMemorySkillsPlatform } from "../skills/platform.js";
import { createManagedSkillLearningHandler } from "../brain/managed-skill-learning.js";
import path from "node:path";
import { createHash } from "node:crypto";
import { SecurityController } from "../security/controller.js";
import { MemorySecurityAudit } from "../security/audit.js";
import { EncryptedFileAudit } from "../security/persistent-audit.js";
import { CompositeSecurityAudit } from "../security/audit.js";
import { DesktopRuntime, createDesktopPrincipal } from "../desktop/runtime.js";
import { createDesktopTools } from "../desktop/tools.js";
import type { DesktopCapability } from "../desktop/types.js";

function ownerStorageNamespace(workspace: string, ownerKeyId?: string): string {
  // Preserve the pre-existing local/single-user namespace. Authenticated owners
  // receive an opaque, deterministic namespace derived only from server identity.
  if (ownerKeyId === undefined) return workspace;
  const ownerHash = createHash("sha256").update(ownerKeyId).digest("hex");
  return `${workspace}:owner:${ownerHash}`;
}

function intEnv(name:string,fallback:number,minimum=0){const value=Number(process.env[name]);return Number.isSafeInteger(value)&&value>=minimum?value:fallback;}
const NO_COST_CAP=9_000_000_000_000_000_000n;
function bigintEnv(name:string,fallback:bigint){const value=process.env[name];if(!value)return fallback;try{const parsed=BigInt(value);return parsed>=0n?parsed:fallback;}catch{return fallback;}}

function createBrainFactory(config:ReturnType<typeof loadModelConfigFromEnv>,provider:SofiaModelGateway,workspace:string,evolution:EvolutionEngine,dependencies:{runtime:ReturnType<typeof createNodeWorkspaceRuntime>;tools:ReturnType<typeof createToolRegistry>;policy:ReturnType<typeof loadExecutionPolicyFromEnv>;approval?:AgentDependencies["approval"];security:SecurityController;audit:import("../security/audit.js").SecurityAuditSink}):NonNullable<AgentDependencies["brainFactory"]>{
  const routeAdapters=new Map(config.routes.map(route=>[route.id,createInternalRoute({modelProvider:provider,route})]));
  const ownerEvolutionEngines = new Map<string, EvolutionEngine>();
  const ownerLearningStores = new Map<string, {
    projectMemory: FileProjectMemoryStore;
    skillLedger: PersistentSkillLedger;
    onSkillCandidate: ReturnType<typeof createManagedSkillLearningHandler>;
  }>();
  const checkpointManager=new DurableCheckpointManager(dependencies.runtime,workspace);
  return ({signal,maxSteps,principalId,modelRouteId,desktopCapabilities,onRunSnapshot,onEvent,budgetSnapshot})=>{
    // Resolve all learning state only after the authenticated principal is known.
    // This prevents a shared workspace from becoming a cross-user memory boundary.
    const ownerNamespace = principalId === undefined ? "local" : createHash("sha256").update(principalId).digest("hex");
    let runEvolution = evolution;
    if (principalId !== undefined) {
      let scopedEvolution = ownerEvolutionEngines.get(ownerNamespace);
      if (!scopedEvolution) {
        scopedEvolution = new EvolutionEngine(path.join(workspace, ".sofia", "evolution", ownerNamespace + ".json"));
        ownerEvolutionEngines.set(ownerNamespace, scopedEvolution);
      }
      runEvolution = scopedEvolution;
    }
    let learningStores = ownerLearningStores.get(ownerNamespace);
    if (!learningStores) {
      const projectMemory = new FileProjectMemoryStore(workspace, undefined, principalId);
      const skillLedger = new PersistentSkillLedger(projectMemory);
      const lifecycleFile = principalId === undefined
        ? path.join(workspace, ".sofia", "skill-lifecycle.json")
        : path.join(workspace, ".sofia", "skill-lifecycle", ownerNamespace + ".json");
      const skillLifecycle = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), async (candidate) => {
        const checks = [
          { name: "skill-metadata", passed: Boolean(candidate.skill.id && candidate.skill.name.trim() && candidate.skill.description.trim()) },
          { name: "procedure", passed: candidate.skill.procedure.length > 0 && candidate.skill.procedure.every((step) => step.trim().length > 0) },
          { name: "verification", passed: candidate.skill.verification.length > 0 && candidate.skill.verification.every((item) => ["typecheck", "test", "build"].includes(item)) },
        ];
        return { passed: checks.every((check) => check.passed), checks };
      }, { file: lifecycleFile });
      learningStores = {
        projectMemory,
        skillLedger,
        onSkillCandidate: createManagedSkillLearningHandler(skillLifecycle, dependencies.approval),
      };
      ownerLearningStores.set(ownerNamespace, learningStores);
    }
    const { projectMemory, skillLedger, onSkillCandidate } = learningStores;
    const scopedStorageNamespace = ownerStorageNamespace(workspace, principalId);
    const runStore = new FileRunStore(scopedStorageNamespace);
    // Keep the accounting journal in its legacy namespace for now: old unresolved
    // provider attempts have no owner metadata, so moving it per-owner could hide
    // ambiguous billing evidence and permit an unsafe duplicate inference.
    const settlementJournal = new FileSettlementJournal(workspace);
    const requestedRouteId = modelRouteId && modelRouteId !== "auto" ? modelRouteId : undefined;
    const requestedRoute = requestedRouteId ? config.routes.find((route) => route.id === requestedRouteId) : undefined;
    if (requestedRouteId && !requestedRoute) throw new Error("Unknown model route: " + requestedRouteId);
    if (requestedRoute && !requestedRoute.healthy) throw new Error("Requested model route is unhealthy: " + requestedRouteId);
    const selectedRouteAdapters = requestedRouteId
      ? [routeAdapters.get(requestedRouteId)!]
      : [...routeAdapters.values()];
    const runLimit:BudgetLimit={maxTokens:intEnv("SOFIA_BRAIN_MAX_TOKENS",60000,1),maxCostNanoUsd:bigintEnv("SOFIA_BRAIN_MAX_COST_NANO_USD",NO_COST_CAP),maxCalls:intEnv("SOFIA_BRAIN_MAX_MODEL_CALLS",12,1),maxInFlight:intEnv("SOFIA_BRAIN_MAX_IN_FLIGHT",1,1)};
    const models=config.routes.map(route=>({key:route.id,limit:{maxTokens:intEnv("SOFIA_BRAIN_MODEL_MAX_TOKENS",runLimit.maxTokens,1),maxCostNanoUsd:runLimit.maxCostNanoUsd,maxCalls:runLimit.maxCalls,maxInFlight:runLimit.maxInFlight},price:{inputNanoUsdPerToken:bigintEnv("SOFIA_"+route.id.toUpperCase()+"_INPUT_NANO_USD",0n),outputNanoUsdPerToken:bigintEnv("SOFIA_"+route.id.toUpperCase()+"_OUTPUT_NANO_USD",0n)}})).filter((m,i,a)=>a.findIndex(x=>x.key===m.key)===i);
    const budget=new TokenBudget(runLimit,models,budgetSnapshot);
    const gateway=new TokenAwareGateway(budget,selectedRouteAdapters,intEnv("SOFIA_BRAIN_MODEL_TIMEOUT_MS",45000,1),settlementJournal);
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
    const persistRunSnapshot = async (snapshot: import("../brain/run-state.js").BrainRunSnapshot) => {
      if (onRunSnapshot) {
        // DurableJobRuntime persists the redacted snapshot in its job record before
        // returning. That embedded copy is the fallback if FileRunStore is unavailable.
        await onRunSnapshot(snapshot);
      } else {
        // Direct brainFactory callers have no job-record fallback. Reconfirm the
        // dedicated snapshot write here because SofiaBrain intentionally treats its
        // best-effort RunStore write as non-fatal for ordinary execution.
        await runStore.save(snapshot);
      }
      // Acknowledgement is written only after one durable snapshot path succeeds.
      // If persistence fails, leave the settlement unresolved to block unsafe resume.
      await settlementJournal.acknowledgeCheckpoint(snapshot.runId);
    };
    const rawSubagents=createSubagentRuntime(reasoner,toolGateway);
    const subagents=new CoordinatedSubagentRuntime(rawSubagents,{
      maxConcurrency:intEnv("SOFIA_SUBAGENT_MAX_CONCURRENCY",3,1),
      maxTasks:intEnv("SOFIA_SUBAGENT_MAX_TASKS",12,1),
      timeoutMs:intEnv("SOFIA_SUBAGENT_TIMEOUT_MS",60000,100),
      maxContextBytes:intEnv("SOFIA_SUBAGENT_MAX_CONTEXT_BYTES",32768,256),
    });
    const limits:Partial<BrainLimits>={maxSteps:maxSteps??dependencies.policy.maxSteps,maxToolCalls:intEnv("SOFIA_BRAIN_MAX_TOOL_CALLS",100,1),maxReplans:intEnv("SOFIA_BRAIN_MAX_REPLANS",4,0),maxModelCalls:runLimit.maxCalls,maxTokens:runLimit.maxTokens,maxContextTokens:intEnv("SOFIA_BRAIN_MAX_CONTEXT_TOKENS",16000,1),maxOutputTokens:intEnv("SOFIA_BRAIN_MAX_OUTPUT_TOKENS",2048,1),timeoutMs:intEnv("SOFIA_BRAIN_TIMEOUT_MS",120000,1)};
    return createSofiaBrain({dependencies:{reasoner,tools:toolGateway,subagents,skillLedger,onSkillCandidate,allowShell:dependencies.policy.allowShell,allowNetwork:dependencies.policy.allowNetwork,projectContextLoader:()=>discoverProjectContext(dependencies.runtime),repositoryMapLoader:task=>buildRepositoryMap(dependencies.runtime,task),runStore,projectMemory,evolution:runEvolution,onRunSnapshot:persistRunSnapshot,onEvent},limits});
  };
}

export function createSofiaAgentDependencies(workspace=process.cwd(),approval?:AgentDependencies["approval"]):AgentDependencies{
  const config=loadModelConfigFromEnv(); const runtime=createNodeWorkspaceRuntime(workspace); const policy=loadExecutionPolicyFromEnv(); assertSecurityConfiguration(policy); const security=new SecurityController(); const memoryAudit=new MemorySecurityAudit(); const auditSecret=process.env.SOFIA_AUDIT_SECRET; const audit=auditSecret?new CompositeSecurityAudit([memoryAudit,new EncryptedFileAudit(path.join(workspace,".sofia","security-audit.log"),auditSecret)]):memoryAudit;
  const browserTools=policy.allowBrowser?createBrowserTools(new PlaywrightBrowserRuntime()):[];
  const tools=createToolRegistry([...createBuiltinTools(),...browserTools]);
  const provider=new SofiaModelGateway(config.providers);
  const evolution=new EvolutionEngine(path.join(workspace, ".sofia", "evolution.json"));
  const brainFactory=createBrainFactory(config,provider,workspace,evolution,{runtime,tools,policy,approval,security,audit});
  const jobRuntime=new DurableJobRuntime(
    brainFactory,
    (ownerKeyId) => new FileRunStore(ownerStorageNamespace(workspace, ownerKeyId)),
    workspace,
    (runId) => new FileSettlementJournal(workspace).deleteRun(runId),
  );
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
