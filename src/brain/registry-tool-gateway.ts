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
  listTools(){return this.dependencies.tools.list().map((tool)=>({name:tool.name,description:tool.description,effects:effectiveToolEffects(tool.name,tool.effects)}));}
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
      const detail=error instanceof Error?error.message:"Invalid tool input";
      return{ok:false,data:null,evidenceId,error:{category:"tool_error",message:`Invalid input for ${call.tool}: ${detail}`}};
    }
    if(!this.policy.allowTools)return{ok:false,data:null,evidenceId,error:{category:"permission_error",message:"Tool execution is disabled by policy."}};
    const permission=toolPermission(this.policy,call.tool,descriptor.effects);
    if(permission.allow===false)return{ok:false,data:null,evidenceId,error:{category:"permission_error",message:`Tool execution is disabled by policy: ${call.tool}`}};
    const assessment=assessAction({runId:context.runId,principalId:context.principalId,toolName:call.tool,input:redactSecrets(input),effects:descriptor.effects},this.policy.blockedPaths,this.policy.allowedHosts);
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
      await this.audit?.record({id:randomUUID(),at:new Date().toISOString(),runId:context.runId,principalId:context.principalId,toolName:call.tool,actionHash:assessment.actionHash,risk:assessment.risk,decision:"completed",input:redactSecrets(input),result:redactSecrets(data)});
      return{ok:true,data:redactSecrets(data),evidenceId};
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
