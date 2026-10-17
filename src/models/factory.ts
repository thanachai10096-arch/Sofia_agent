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
import { DurableCheckpointManager } from "../brain/durable-checkpoint.js";
import { FileRunStore } from "../brain/run-store.js";
import { DurableJobRuntime } from "../brain/job-runtime.js";
import { buildRepositoryMap } from "../brain/repository-intelligence.js";
import { FileProjectMemoryStore, PersistentSkillLedger } from "../brain/project-memory.js";
import { VersionedSkillLifecycle } from "../brain/skill-lifecycle.js";
import { runSkillLifecycleWorkflow } from "../brain/skill-lifecycle-workflow.js";
import type { LearnedSkillCandidate } from "../brain/learning.js";
import { InMemorySkillsPlatform, type SkillPackage } from "../skills/platform.js";
import { actionHash } from "../security/guard.js";
import { randomUUID } from "node:crypto";
import { EvolutionEngine } from "../brain/evolution.js";
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

function createBrainFactory(config:ReturnType<typeof loadModelConfigFromEnv>,provider:SofiaModelGateway,workspace:string,evolution:EvolutionEngine,dependencies:{runtime:ReturnType<typeof createNodeWorkspaceRuntime>;tools:ReturnType<typeof createToolRegistry>;policy:ReturnType<typeof loadExecutionPolicyFromEnv>;approval?:AgentDependencies["approval"];onSkillCandidate?:(candidate:LearnedSkillCandidate)=>Promise<boolean>;lifecycle?:VersionedSkillLifecycle;security:SecurityController;audit:import("../security/audit.js").SecurityAuditSink}):NonNullable<AgentDependencies["brainFactory"]>{
  const routeAdapters=config.routes.map(route=>createInternalRoute({modelProvider:provider,route}));
  const checkpointManager=new DurableCheckpointManager(dependencies.runtime,workspace);
  const runStore=new FileRunStore(workspace);
  const projectMemory=new FileProjectMemoryStore(workspace);
  const skillLedger=new PersistentSkillLedger(projectMemory);
  for (const record of dependencies.lifecycle?.list().filter(item=>item.status==="active") ?? []) {
    const skill=record.package.skill;
    const category=skill.categories[0];
    const trigger=skill.triggers[0];
    if (category && trigger) skillLedger.record({name:skill.name,trigger,category,strategy:skill.strategy,procedure:[...skill.procedure],verification:[...skill.verification],evidenceIds:[...record.provenance.evidenceIds]});
  }
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
    return createSofiaBrain({dependencies:{reasoner,tools:toolGateway,subagents,skillLedger,onSkillCandidate:dependencies.onSkillCandidate,allowShell:dependencies.policy.allowShell,allowNetwork:dependencies.policy.allowNetwork,projectContextLoader:()=>discoverProjectContext(dependencies.runtime),repositoryMapLoader:task=>buildRepositoryMap(dependencies.runtime,task),runStore,projectMemory,evolution,onRunSnapshot},limits});
  };
}

export function createSofiaAgentDependencies(workspace=process.cwd(),approval?:AgentDependencies["approval"]):AgentDependencies{
  const config=loadModelConfigFromEnv(); const runtime=createNodeWorkspaceRuntime(workspace); const policy=loadExecutionPolicyFromEnv(); assertSecurityConfiguration(policy); const security=new SecurityController(); const memoryAudit=new MemorySecurityAudit(); const auditSecret=process.env.SOFIA_AUDIT_SECRET; const audit=auditSecret?new CompositeSecurityAudit([memoryAudit,new EncryptedFileAudit(path.join(workspace,".sofia","security-audit.log"),auditSecret)]):memoryAudit;
  const browserTools=policy.allowBrowser?createBrowserTools(new PlaywrightBrowserRuntime()):[];
  const tools=createToolRegistry([...createBuiltinTools(),...browserTools]);
  const provider=new SofiaModelGateway(config.providers);
  const evolution=new EvolutionEngine(path.join(workspace, ".sofia", "evolution.json"));
  const skillPlatform=new InMemorySkillsPlatform();
  const skillLifecycle=new VersionedSkillLifecycle(skillPlatform,async (pkg:SkillPackage)=>{
    const passed=Boolean(pkg.skill.name.trim()&&pkg.skill.description.trim()&&pkg.skill.triggers.length>0&&pkg.skill.procedure.length>=2&&pkg.skill.verification.length>0&&pkg.skill.categories.length>0);
    return {passed,checks:[{name:"skill-metadata-quality",passed}]};
  },{file:path.join(workspace,".sofia","skill-lifecycle.json"),minimumConfidence:0.7});
  const onSkillCandidate=async(candidate:LearnedSkillCandidate):Promise<boolean>=>{
    if(!approval||candidate.evidenceIds.length===0) return false;
    const skillId="learned:"+candidate.category;
    const skillPackage:SkillPackage={
      skill:{id:skillId,name:candidate.name,description:"Learned from a verified Sofia recovery; requires reviewed promotion.",triggers:[candidate.trigger],categories:[candidate.category],strategy:candidate.strategy,procedure:[...candidate.procedure],verification:["test"]},
      source:"learned",
      version:String(skillLifecycle.list(skillId).length+1)+".0.0",
    };
    const result=await runSkillLifecycleWorkflow(skillLifecycle,skillPackage,{source:"brain-recovery",evidenceIds:[...candidate.evidenceIds],confidence:0.85},{
      approvePromotion:async record=>{
        const input={candidateId:record.id,skillId:record.skillId,version:record.package.version,evidenceIds:record.provenance.evidenceIds};
        const runId=randomUUID();
        return approval({runId,toolName:"skill.promote",input,actionHash:actionHash(runId,"skill.promote",input),risk:"high"});
      },
    });
    return result.activated;
  };
  const brainFactory=createBrainFactory(config,provider,workspace,evolution,{runtime,tools,policy,approval,onSkillCandidate,lifecycle:skillLifecycle,security,audit});
  const jobRuntime=new DurableJobRuntime(brainFactory,new FileRunStore(workspace),workspace);
  return{router:new ModelRouter(config.routes),provider,reviewer:new Reviewer(),runtime,tools,policy,brainFactory,jobRuntime,securityController:security,securityAudit:memoryAudit,learningDiagnostics:()=>evolution.getDiagnostics()};
}
