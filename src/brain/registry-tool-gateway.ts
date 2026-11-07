import { createHash, randomUUID } from "node:crypto";
import type { ExecutionPolicy } from "../security/policy.js";
import type { WorkspaceRuntime } from "../platform/runtime.js";
import { validateToolInput, type ToolRegistry } from "../tools/types.js";
import { effectiveToolEffects, toolPermission, riskRank } from "../security/policy.js";
import { assessAction, redactSecrets, type RiskLevel } from "../security/guard.js";
import { issueCapability, verifyCapability } from "../security/capability.js";
import type { AgentDependencies } from "../agent/types.js";
import type { ApprovalHandler } from "../agent/approval.js";
import type { SecurityAuditSink } from "../security/audit.js";
import { SecurityController } from "../security/controller.js";
import type { ToolGateway, ToolExecutionContext, ToolResult, WorkspaceSnapshot, WorkspaceCheckpoint, ToolCall } from "./types.js";
import { RuntimeCheckpointManager, type CheckpointManager } from "./checkpoint.js";

function digest(value:string){return createHash("sha256").update(value).digest("hex");}
function deepFreeze<T>(value:T):T {
  if(value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for(const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
interface SnapshotRecord{id:string;revision:string;files:string[];fingerprints:Record<string,string>}

export class RegistryToolGateway implements ToolGateway {
  private readonly snapshots=new Map<string,SnapshotRecord>();
  private readonly checkpoints:CheckpointManager;
  constructor(
    private readonly dependencies:{runtime:WorkspaceRuntime;tools:ToolRegistry},
    private readonly policy:ExecutionPolicy,
    private readonly approval?:ApprovalHandler,
    checkpoints?:CheckpointManager,
    private readonly security:SecurityController=new SecurityController(),
    private readonly audit?:SecurityAuditSink,
  ){this.checkpoints=checkpoints??new RuntimeCheckpointManager(dependencies.runtime);}
  listTools(){return this.dependencies.tools.list().map((tool)=>{
    const effects=effectiveToolEffects(tool.name,tool.effects);
    const permission=toolPermission(this.policy,tool.name,effects);
    let status:"allowed"|"approval_required"|"blocked"="allowed";
    let reason:string|undefined;
    if(this.security.isKilled()){status="blocked";reason="Sofia security kill switch is active.";}
    else if(!this.policy.allowTools){status="blocked";reason="Tool execution is disabled by policy."; }
    else if(effects.includes("network")&&!this.policy.allowNetwork){status="blocked";reason="Network access is disabled by execution policy.";}
    else if(permission.allow===false){status="blocked";reason="Disabled by execution policy: "+tool.name;}
    else if(effects.includes("network")&&this.policy.allowedHosts.length===0){status="blocked";reason="Network tool has no configured allowed-host list.";}
    else if(permission.requireApproval===true||effects.some(effect=>effect==="write"||effect==="shell"||effect==="destructive"||effect==="browser")){
      status="approval_required";
      reason=this.approval?"Approval is required before execution.":"Approval is required but no approval handler is configured.";
      if(!this.approval)status="blocked";
    }
    return{name:tool.name,description:tool.description,effects,registered:true,policy:{status,reason},runtimeReadiness:"not_probed" as "ready"|"not_probed"|"unavailable",runtimeReason:undefined as string|undefined};
  });}
  /**
   * Probe runtime readiness without executing user tools or making network requests.
   * Workspace checks are read-only. Shell and browser remain not_probed because a
   * real probe would execute code or create a browser session outside this gateway.
   */
  async probeReadiness(){
    const catalog=this.listTools();
    let workspaceReady:{ok:boolean;reason:string}|undefined;
    const browserProbeResults=new Map<() => Promise<{ok:boolean;reason:string}>,Promise<{ok:boolean;reason:string}>>();
    for(const item of catalog){
      if(item.name.startsWith("workspace.")||item.name==="project.verify"){
        // Discovery must not touch workspace state when policy has already
        // blocked the capability (including the global tools kill switch).
        if(item.policy?.status==="blocked"){
          item.runtimeReadiness="not_probed";
          item.runtimeReason="Workspace probe skipped because execution policy blocks this tool.";
          continue;
        }
        if(!workspaceReady){
          try{
            const root=await this.dependencies.runtime.cwd();
            if(typeof root!=="string"||!root.trim())throw new Error("Workspace runtime returned an empty working directory.");
            await this.dependencies.runtime.listFiles(".");
            workspaceReady={ok:true,reason:"Read-only workspace root and directory listing checks passed."};
          }catch(error){
            workspaceReady={ok:false,reason:error instanceof Error?error.message:"Workspace runtime probe failed."};
          }
        }
        item.runtimeReadiness=workspaceReady.ok?"ready":"unavailable";
        item.runtimeReason=workspaceReady.reason;
      }else if(item.effects.includes("browser")||item.name.startsWith("browser.")){
        if(item.policy?.status==="blocked"){
          item.runtimeReadiness="not_probed";
          item.runtimeReason="Browser runtime probe skipped because execution policy blocks this tool.";
        }else{
          const registered=this.dependencies.tools.get(item.name);
          const probe=registered?.probeReadiness;
          if(!probe){
            item.runtimeReadiness="not_probed";
            item.runtimeReason="No safe browser-session probe is registered for this tool.";
          }else{
            let pending=browserProbeResults.get(probe);
            if(!pending){
              pending=probe().catch(error=>({ok:false,reason:error instanceof Error?error.message:"Browser runtime probe failed."}));
              browserProbeResults.set(probe,pending);
            }
            const result=await pending;
            item.runtimeReadiness=result.ok?"ready":"unavailable";
            item.runtimeReason=result.reason;
          }
        }
      }else if(item.effects.includes("shell")){
        item.runtimeReadiness="not_probed";
        item.runtimeReason="Terminal execution was not invoked during discovery to avoid running a command outside an approved task.";
      }else if(item.effects.includes("network")){
        if(!this.policy.allowNetwork||this.policy.allowedHosts.length===0){
          item.runtimeReadiness="unavailable";
          item.runtimeReason="Network access is disabled or no host allowlist is configured.";
        }else if((item.name==="web.search"||item.name==="web.search_news")&&!process.env.BRAVE_SEARCH_API_KEY?.trim()){
          item.runtimeReadiness="unavailable";
          item.runtimeReason="BRAVE_SEARCH_API_KEY is not configured.";
        }else{
          item.runtimeReadiness="not_probed";
          item.runtimeReason="Network credentials and policy are configured, but no external request was sent during discovery.";
        }
      }else{
        item.runtimeReadiness="not_probed";
        item.runtimeReason="No safe runtime-specific probe is registered for this tool.";
      }
    }
    return catalog;
  }
  describe(name:string){const tool=this.dependencies.tools.get(name);if(!tool)return undefined;return{effects:effectiveToolEffects(name,tool.effects)};}

  async execute(call:ToolCall,context:ToolExecutionContext):Promise<ToolResult>{
    // Bind the approval hash and actual execution to one immutable input snapshot.
    // The caller and approval UI must not be able to swap the action while approval is pending.
    const input = deepFreeze(structuredClone(call.input));
    context.signal.throwIfAborted();
    this.security.assertRunning();
    const descriptor=this.describe(call.tool);
    const evidenceId=randomUUID();
    if(!descriptor)return{ok:false,data:null,evidenceId,error:{category:"tool_error",message:`Unknown tool: ${call.tool}`}};
    const registeredTool=this.dependencies.tools.get(call.tool);
    if(!registeredTool)return{ok:false,data:null,evidenceId,error:{category:"tool_error",message:"Tool disappeared during execution."}};
    try {
      validateToolInput(registeredTool.inputSchema, input);
    } catch (error) {
      const detail=String(redactSecrets(error instanceof Error?error.message:"Invalid tool input"));
      return{ok:false,data:null,evidenceId,error:{category:"tool_error",message:`Invalid input for ${call.tool}: ${detail}`}};
    }
    if(!this.policy.allowTools)return{ok:false,data:null,evidenceId,error:{category:"permission_error",message:"Tool execution is disabled by policy."}};
    const permission=toolPermission(this.policy,call.tool,descriptor.effects);
    if(permission.allow===false)return{ok:false,data:null,evidenceId,error:{category:"permission_error",message:`Tool execution is disabled by policy: ${call.tool}`}};
    const securityInput = registeredTool.networkUrl
      ? { ...input, ...(Object.prototype.hasOwnProperty.call(input, "url") ? { requestedUrl: input.url } : {}), url: registeredTool.networkUrl }
      : input;
    const assessment=assessAction({runId:context.runId,principalId:context.principalId,toolName:call.tool,input:securityInput,effects:descriptor.effects},this.policy.blockedPaths,this.policy.allowedHosts);
    if(!assessment.allowed){
      await this.audit?.record({id:randomUUID(),at:new Date().toISOString(),runId:context.runId,principalId:context.principalId,toolName:call.tool,actionHash:assessment.actionHash,risk:assessment.risk,decision:"deny",reason:assessment.reason,input:redactSecrets(input)});
      return{ok:false,data:null,evidenceId,error:{category:"permission_error",message:assessment.reason??"Security policy denied the action."}};
    }
    if(riskRank[assessment.risk]>riskRank[this.policy.maxRisk]){
      await this.audit?.record({id:randomUUID(),at:new Date().toISOString(),runId:context.runId,principalId:context.principalId,toolName:call.tool,actionHash:assessment.actionHash,risk:assessment.risk,decision:"deny",reason:"Risk exceeds policy maximum.",input:redactSecrets(input)});
      return{ok:false,data:null,evidenceId,error:{category:"permission_error",message:"Action risk exceeds Sofia security policy."}};
    }
    const requiresApproval=permission.requireApproval===true||assessment.requireApproval||descriptor.effects.some(x=>x==="write"||x==="shell"||x==="destructive"||x==="browser");
    const capabilitySecret=this.policy.capabilitySecret;
    const capability=capabilitySecret?issueCapability({principalId:context.principalId??"anonymous",runId:context.runId,tool:call.tool,effects:descriptor.effects,risk:assessment.risk},capabilitySecret):undefined;
    if(capabilitySecret && capability && !verifyCapability(capability,{principalId:context.principalId??"anonymous",runId:context.runId,tool:call.tool,effects:descriptor.effects,risk:assessment.risk},capabilitySecret)) return{ok:false,data:null,evidenceId,error:{category:"permission_error",message:"Capability verification failed."}};
    await this.audit?.record({id:randomUUID(),at:new Date().toISOString(),runId:context.runId,principalId:context.principalId,toolName:call.tool,actionHash:assessment.actionHash,risk:assessment.risk,decision:requiresApproval?"approval_required":"allow",input:redactSecrets(input)});
    if(requiresApproval){
      if(!this.approval)return{ok:false,data:null,evidenceId,error:{category:"permission_error",message:"Approval is required for this tool."}};
      context.notifyApproval(true);
      try{
        const approved=await this.approval({runId:context.runId,principalId:context.principalId,toolName:call.tool,input:structuredClone(input),actionHash:assessment.actionHash,risk:assessment.risk});
        if(!approved){
          await this.audit?.record({id:randomUUID(),at:new Date().toISOString(),runId:context.runId,principalId:context.principalId,toolName:call.tool,actionHash:assessment.actionHash,risk:assessment.risk,decision:"approval_denied",reason:"Approval handler denied the exact action.",input:redactSecrets(input)});
          return{ok:false,data:null,evidenceId,error:{category:"permission_error",message:"Tool execution was not approved."}};
        }
      }finally{context.notifyApproval(false);}
    }
    try{
      this.security.assertRunning();
      context.signal.throwIfAborted();
      if(capabilitySecret && (!capability || !verifyCapability(capability,{principalId:context.principalId??"anonymous",runId:context.runId,tool:call.tool,effects:descriptor.effects,risk:assessment.risk},capabilitySecret))) {
        return {ok:false,data:null,evidenceId,error:{category:"permission_error",message:"Capability validation failed immediately before execution."}};
      }
      if(!capabilitySecret && (process.env.NODE_ENV==="production"||process.env.SOFIA_ENV==="production")) {
        return {ok:false,data:null,evidenceId,error:{category:"permission_error",message:"Production tool execution requires a capability secret."}};
      }
      const boundSignal=this.security.bindSignal(context.signal);
      let data:unknown;
      try {
        data=await registeredTool.execute(input,{runtime:this.dependencies.runtime,signal:boundSignal.signal});
      } finally {
        boundSignal.dispose();
      }
      const safeData = redactSecrets(data);
      await this.audit?.record({id:randomUUID(),at:new Date().toISOString(),runId:context.runId,principalId:context.principalId,toolName:call.tool,actionHash:assessment.actionHash,risk:assessment.risk,decision:"completed",input:redactSecrets(input),result:safeData});
      return{ok:true,data:safeData,evidenceId};
    }catch(error){
      const message=String(redactSecrets(error instanceof Error?error.message:String(error)));
      await this.audit?.record({id:randomUUID(),at:new Date().toISOString(),runId:context.runId,principalId:context.principalId,toolName:call.tool,actionHash:assessment.actionHash,risk:assessment.risk,decision:"failed",reason:message,input:redactSecrets(input)});
      return{ok:false,data:null,evidenceId,error:{category:descriptor.effects.includes("network")?"network_error":"tool_error",message}};
    }
  }

  async snapshot(signal:AbortSignal):Promise<WorkspaceSnapshot>{
    signal.throwIfAborted();this.security.assertRunning();
    const result=await this.dependencies.runtime.git(["status","--porcelain","--untracked-files=all"]);
    const files=result.code===0?result.stdout.split(/\r?\n/).map(x=>x.slice(3).trim()).filter(Boolean).sort():[];
    const revision=digest(result.code===0?result.stdout:`non-git:${await this.dependencies.runtime.cwd()}`);
    const id=randomUUID();const fingerprints:Record<string,string>={};
    for(const file of files){try{fingerprints[file]=digest(await this.dependencies.runtime.readFile(file));}catch{fingerprints[file]="<missing>";}}
    this.snapshots.set(id,{id,revision,files,fingerprints});return{id,revision,evidenceId:randomUUID()};
  }
  async changedFiles(baselineSnapshotId:string,signal:AbortSignal):Promise<string[]>{
    signal.throwIfAborted();const baseline=this.snapshots.get(baselineSnapshotId);if(!baseline)throw new Error("Unknown baseline snapshot");
    const current=await this.snapshot(signal);const record=this.snapshots.get(current.id)!;
    return[...new Set([...baseline.files,...record.files])].sort().filter(file=>baseline.fingerprints[file]!==record.fingerprints[file]);
  }
  async checkpoint(signal:AbortSignal):Promise<WorkspaceCheckpoint>{this.security.assertRunning();const c=await this.checkpoints.create(signal);return{id:c.id,revision:c.revision};}
  async rollback(id:string,signal:AbortSignal):Promise<string[]>{this.security.assertRunning();return(await this.checkpoints.rollback(id,signal)).restoredFiles;}
}
