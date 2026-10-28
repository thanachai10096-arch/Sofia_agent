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
import { EncryptedUserModelProfileStore } from "./profile-store.js";
import { loadModelConfigFromEnv } from "./config.js";
import type { AgentDependencies } from "../agent/types.js";
import { Reviewer } from "../review/reviewer.js";
import { createNodeWorkspaceRuntime } from "../platform/local-runtime.js";
import { createToolRegistry } from "../tools/registry.js";
import { McpHttpTransport } from "../mcp/transports.js";
import { connectManagedMcpRegistry, type ManagedMcpServerConfig } from "../mcp/registry.js";
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

function intEnv(name:string,fallback:number,minimum=0){const value=Number(process.env[name]);return Number.isSafeInteger(value)&&value>=minimum?value:fallback;}
const NO_COST_CAP=9_000_000_000_000_000_000n;
function bigintEnv(name:string,fallback:bigint){const value=process.env[name];if(!value)return fallback;try{const parsed=BigInt(value);return parsed>=0n?parsed:fallback;}catch{return fallback;}}

function createBrainFactory(config:ReturnType<typeof loadModelConfigFromEnv>,provider:SofiaModelGateway,workspace:string,evolution:EvolutionEngine,dependencies:{runtime:ReturnType<typeof createNodeWorkspaceRuntime>;tools:ReturnType<typeof createToolRegistry>;policy:ReturnType<typeof loadExecutionPolicyFromEnv>;approval?:AgentDependencies["approval"];security:SecurityController;audit:import("../security/audit.js").SecurityAuditSink}):NonNullable<AgentDependencies["brainFactory"]>{
  const checkpointManager=new DurableCheckpointManager(dependencies.runtime,workspace);
  const runStore=new FileRunStore(workspace);
  const projectMemory=new FileProjectMemoryStore(workspace);
  const evolutionsByPrincipal = new Map<string, EvolutionEngine>();
  const learningByPrincipal = new Map<string, { skillLedger: PersistentSkillLedger; onSkillCandidate: ReturnType<typeof createManagedSkillLearningHandler> }>();
  const principalKey = (principalId?: string) => principalId?.trim() || "local";
  const principalHash = (principalId?: string) => createHash("sha256").update(principalKey(principalId)).digest("hex");
  const evolutionForPrincipal = (principalId?: string) => {
    const key = principalKey(principalId);
    if (key === "local") return evolution;
    const hash = principalHash(principalId);
    let instance = evolutionsByPrincipal.get(hash);
    if (!instance) {
      instance = new EvolutionEngine(path.join(workspace, ".sofia", "users", hash, "evolution.json"));
      evolutionsByPrincipal.set(hash, instance);
    }
    return instance;
  };
  const learningForPrincipal = (principalId?: string) => {
    const hash = principalHash(principalId);
    let learning = learningByPrincipal.get(hash);
    if (learning) return learning;
    // Keep learned skills and lifecycle versions isolated by authenticated principal.
    // The principal itself is never used as a filesystem path or stored in clear text.
    const skillMemory = new FileProjectMemoryStore("skill:" + workspace + ":" + principalKey(principalId));
    const skillLedger = new PersistentSkillLedger(skillMemory);
    const skillLifecycle = new VersionedSkillLifecycle(new InMemorySkillsPlatform(), async (candidate) => {
      const checks = [
        { name: "skill-metadata", passed: Boolean(candidate.skill.id && candidate.skill.name.trim() && candidate.skill.description.trim()) },
        { name: "procedure", passed: candidate.skill.procedure.length > 0 && candidate.skill.procedure.every((step) => step.trim().length > 0) },
        { name: "verification", passed: candidate.skill.verification.length > 0 && candidate.skill.verification.every((item) => ["typecheck", "test", "build"].includes(item) || (item.startsWith("acceptance:") && /^[A-Za-z0-9._:-]{1,160}$/.test(item.slice("acceptance:".length)))) },
      ];
      return { passed: checks.every((check) => check.passed), checks };
    }, { file: path.join(workspace, ".sofia", "users", hash, "skill-lifecycle.json") });
    learning = { skillLedger, onSkillCandidate: createManagedSkillLearningHandler(skillLifecycle, dependencies.approval) };
    learningByPrincipal.set(hash, learning);
    return learning;
  };
  return ({signal,maxSteps,principalId,desktopCapabilities,onRunSnapshot,onEvent})=>{
    const learning = learningForPrincipal(principalId);
    const runEvolution = evolutionForPrincipal(principalId);
    const routeAdapters=config.routes.map(route=>createInternalRoute({modelProvider:provider.forPrincipal(principalId),route}));
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
    return createSofiaBrain({dependencies:{reasoner,tools:toolGateway,subagents,skillLedger:learning.skillLedger,onSkillCandidate:learning.onSkillCandidate,allowShell:dependencies.policy.allowShell,allowNetwork:dependencies.policy.allowNetwork,projectContextLoader:()=>discoverProjectContext(dependencies.runtime),repositoryMapLoader:task=>buildRepositoryMap(dependencies.runtime,task),runStore,projectMemory,evolution:runEvolution,onRunSnapshot,onEvent},limits});
  };
}

export function createSofiaAgentDependencies(workspace=process.cwd(),approval?:AgentDependencies["approval"]):AgentDependencies{
  const config=loadModelConfigFromEnv(); const runtime=createNodeWorkspaceRuntime(workspace); const policy=loadExecutionPolicyFromEnv(); assertSecurityConfiguration(policy); const security=new SecurityController(); const memoryAudit=new MemorySecurityAudit(); const auditSecret=process.env.SOFIA_AUDIT_SECRET; const audit=auditSecret?new CompositeSecurityAudit([memoryAudit,new EncryptedFileAudit(path.join(workspace,".sofia","security-audit.log"),auditSecret)]):memoryAudit;
  const userMemoryStore = new FileUserMemoryStore();
  const browserTools=policy.allowBrowser?createBrowserTools(new PlaywrightBrowserRuntime()):[];
  const tools=createToolRegistry([...createBuiltinTools(userMemoryStore),...browserTools]);
  const profileEncryptionKey = process.env.SOFIA_MODEL_PROFILE_ENCRYPTION_KEY?.trim();
  const configuredStateDir = process.env.SOFIA_STATE_DIR?.trim();
  if (configuredStateDir && !path.isAbsolute(configuredStateDir)) throw new Error("SOFIA_STATE_DIR must be an absolute path.");
  const profileStorePath = configuredStateDir
    ? path.join(configuredStateDir, "sofia-agents", "model-profiles.json")
    : path.join(workspace, ".sofia", "model-profiles.json");
  const extraProfileHosts = (process.env.SOFIA_MODEL_PROFILE_ALLOWED_HOSTS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  const modelProfileStore = profileEncryptionKey
    ? new EncryptedUserModelProfileStore(profileStorePath, profileEncryptionKey, extraProfileHosts)
    : undefined;
  const provider=new SofiaModelGateway(config.providers, modelProfileStore);
  const evolution=new EvolutionEngine(path.join(workspace, ".sofia", "evolution.json"));
  const brainFactory=createBrainFactory(config,provider,workspace,evolution,{runtime,tools,policy,approval,security,audit});
  const jobRuntime=new DurableJobRuntime(brainFactory,new FileRunStore(workspace),workspace);
  return{router:new ModelRouter(config.routes),provider,...(modelProfileStore ? { modelProfileStore } : {}),reviewer:new Reviewer(),runtime,tools,policy,brainFactory,jobRuntime,securityController:security,securityAudit:memoryAudit,userMemoryStore,learningDiagnostics:()=>evolution.getDiagnostics()};
}

/** Create dependencies with opt-in durable SQLite transcripts; close the store on shutdown. */
function loadManagedMcpServerConfigs(): ManagedMcpServerConfig[] {
  const raw = process.env.SOFIA_MCP_SERVERS_JSON?.trim();
  if (!raw) return [];
  if (process.env.SOFIA_ALLOW_NETWORK !== "true") {
    throw new Error("SOFIA_ALLOW_NETWORK=true is required to connect configured MCP servers.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("SOFIA_MCP_SERVERS_JSON must be valid JSON."); }
  if (!Array.isArray(parsed) || parsed.length > 10) {
    throw new Error("SOFIA_MCP_SERVERS_JSON must be an array of at most 10 server definitions.");
  }
  const allowedHosts = (process.env.SOFIA_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  return parsed.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP server config at index " + index);
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.endpoint !== "string" ||
        !Array.isArray(item.allowedTools) || item.allowedTools.some((name) => typeof name !== "string")) {
      throw new Error("MCP server config requires id, HTTPS endpoint, and explicit allowedTools.");
    }
    let endpoint: URL;
    try { endpoint = new URL(item.endpoint); } catch { throw new Error("MCP endpoint must be an absolute HTTPS URL."); }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
      throw new Error("MCP endpoint must use HTTPS and cannot embed credentials.");
    }
    if (!allowedHosts.includes(endpoint.hostname.toLowerCase())) {
      throw new Error("MCP endpoint host must be listed in SOFIA_ALLOWED_HOSTS: " + endpoint.hostname);
    }
    const headers: Record<string, string> = {};
    if (item.headers !== undefined) {
      if (!item.headers || typeof item.headers !== "object" || Array.isArray(item.headers)) throw new Error("MCP headers must be an object.");
      for (const [key, headerValue] of Object.entries(item.headers as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9-]{1,80}$/.test(key) || typeof headerValue !== "string" || headerValue.length > 4000 || /[\\r\\n]/.test(headerValue)) {
          throw new Error("Invalid MCP header entry.");
        }
        headers[key] = headerValue;
      }
    }
    return {
      transport: new McpHttpTransport({ endpoint: endpoint.toString(), headers }),
      options: {
        id: item.id,
        allowedTools: item.allowedTools as string[],
      },
    };
  });
}

/** Create dependencies with opt-in durable SQLite transcripts and operator-allowlisted MCP servers. */
export async function createSofiaAgentDependenciesWithSessions(
  workspace = process.cwd(),
  approval?: AgentDependencies["approval"],
  databasePath?: string,
): Promise<AgentDependencies & { closeSessionStore: () => Promise<void> }> {
  const dependencies = createSofiaAgentDependencies(workspace, approval);
  const sessionStore = await SqliteSessionStore.open(databasePath);
  let mcpRegistry: Awaited<ReturnType<typeof connectManagedMcpRegistry>> | undefined;
  try {
    const mcpConfigs = loadManagedMcpServerConfigs();
    if (mcpConfigs.length) {
      mcpRegistry = await connectManagedMcpRegistry(dependencies.tools!.list(), mcpConfigs);
      const mcpTools = mcpRegistry.tools.list().filter((tool) => tool.name.startsWith("mcp."));
      const dynamicRegistry = dependencies.tools as ReturnType<typeof createToolRegistry>;
      dynamicRegistry.addTools(mcpTools);
    }
  } catch (error) {
    await mcpRegistry?.close().catch(() => undefined);
    sessionStore.close();
    throw error;
  }
  return {
    ...dependencies,
    sessionStore,
    closeSessionStore: async () => {
      try { await mcpRegistry?.close(); } finally { sessionStore.close(); }
    },
  };
}
