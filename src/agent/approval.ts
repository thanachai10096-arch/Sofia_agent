import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RiskLevel } from "../security/guard.js";

export interface ApprovalRequest {
  runId:string;
  principalId?:string;
  toolName:string;
  input:Record<string,unknown>;
  actionHash:string;
  risk:RiskLevel;
}
export type ApprovalHandler=(request:ApprovalRequest)=>Promise<boolean>;

export interface PendingApproval {
  id:string;
  runId:string;
  principalId:string;
  toolName:string;
  input:Record<string,unknown>;
  actionHash:string;
  risk:RiskLevel;
  createdAt:number;
  expiresAt:number;
}

export type ApprovalAuditStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled" | "interrupted";
export interface ApprovalAuditRecord {
  id:string;
  runId:string;
  principalId:string;
  toolName:string;
  actionHash:string;
  risk:RiskLevel;
  status:ApprovalAuditStatus;
  createdAt:number;
  expiresAt:number;
  settledAt?:number;
}
export interface ApprovalJournal {
  load():ApprovalAuditRecord[];
  save(records:readonly ApprovalAuditRecord[]):void;
}

/**
 * Owner-only, atomic JSON journal. It intentionally stores action metadata but
 * never the proposed tool input or credentials. Single-process writer only.
 */
export class FileApprovalJournal implements ApprovalJournal {
  constructor(private readonly filePath:string) {}

  load():ApprovalAuditRecord[] {
    try {
      const parsed:unknown=JSON.parse(readFileSync(this.filePath,"utf8"));
      if(!Array.isArray(parsed)) throw new Error("Invalid approval journal.");
      return parsed as ApprovalAuditRecord[];
    } catch(error) {
      if((error as NodeJS.ErrnoException).code==="ENOENT") return [];
      throw error;
    }
  }

  save(records:readonly ApprovalAuditRecord[]):void {
    const directory=path.dirname(this.filePath);
    mkdirSync(directory,{recursive:true,mode:0o700});
    chmodSync(directory,0o700);
    const temporary=this.filePath+"."+randomUUID()+".tmp";
    try {
      writeFileSync(temporary,JSON.stringify(records),{encoding:"utf8",mode:0o600,flag:"wx"});
      renameSync(temporary,this.filePath);
      chmodSync(this.filePath,0o600);
    } finally {
      rmSync(temporary,{force:true});
    }
  }
}

export interface ApprovalDecision {
  approvalId:string;
  principalId:string;
  actionHash:string;
  approved:boolean;
}

/**
 * Single-use approval broker. With a journal, every state transition is durably
 * recorded before a decision can settle. On restart all formerly-pending items
 * become "interrupted" audit records and are never rehydrated as executable work.
 */
export class ApprovalBroker {
  private readonly pendingRequests = new Map<string, {
    request:PendingApproval;
    settle:(approved:boolean)=>void;
    timer:ReturnType<typeof setTimeout>;
  }>();
  private auditRecords:ApprovalAuditRecord[];

  constructor(private readonly ttlMs=120_000,private readonly journal?:ApprovalJournal) {
    if(!Number.isSafeInteger(ttlMs)||ttlMs<1_000||ttlMs>15*60_000) {
      throw new RangeError("Approval TTL must be between 1 second and 15 minutes.");
    }
    this.auditRecords=journal?.load() ?? [];
    const now=Date.now();
    let recovered=false;
    this.auditRecords=this.auditRecords.map(record=>{
      if(record.status!=="pending") return record;
      recovered=true;
      return {...record,status:"interrupted",settledAt:now};
    });
    if(recovered) journal?.save(this.auditRecords);
  }

  private persistTransition(record:ApprovalAuditRecord):boolean {
    const next=this.auditRecords.filter(item=>item.id!==record.id).concat(record).slice(-5000);
    try {
      this.journal?.save(next);
      this.auditRecords=next;
      return true;
    } catch {
      return false;
    }
  }

  readonly handle:ApprovalHandler = (request) => {
    const principalId=request.principalId?.trim();
    if(!principalId||!request.runId||!request.actionHash) return Promise.resolve(false);
    const id=randomUUID();
    const createdAt=Date.now();
    const pending:PendingApproval={
      id,runId:request.runId,principalId,toolName:request.toolName,
      input:structuredClone(request.input),actionHash:request.actionHash,
      risk:request.risk,createdAt,expiresAt:createdAt+this.ttlMs,
    };
    const audit:ApprovalAuditRecord={
      id,runId:request.runId,principalId,toolName:request.toolName,
      actionHash:request.actionHash,risk:request.risk,status:"pending",
      createdAt,expiresAt:pending.expiresAt,
    };
    if(!this.persistTransition(audit)) return Promise.resolve(false);
    return new Promise<boolean>((resolve)=>{
      const timer=setTimeout(()=>{
        const current=this.pendingRequests.get(id);
        if(!current)return;
        const expired={...audit,status:"expired" as const,settledAt:Date.now()};
        if(!this.persistTransition(expired)) {
          // Storage failure must never approve the action.
          this.pendingRequests.delete(id);
          current.settle(false);
          return;
        }
        this.pendingRequests.delete(id);
        current.settle(false);
      },this.ttlMs);
      this.pendingRequests.set(id,{request:pending,settle:resolve,timer});
    });
  };

  pending(principalId:string):PendingApproval[] {
    const owner=principalId.trim();
    if(!owner)return [];
    const now=Date.now();
    const result:PendingApproval[]=[];
    for(const [id,item] of this.pendingRequests) {
      if(item.request.expiresAt<=now) {
        const expired:ApprovalAuditRecord={
          id,runId:item.request.runId,principalId:item.request.principalId,
          toolName:item.request.toolName,actionHash:item.request.actionHash,
          risk:item.request.risk,status:"expired",createdAt:item.request.createdAt,
          expiresAt:item.request.expiresAt,settledAt:now,
        };
        clearTimeout(item.timer);
        this.pendingRequests.delete(id);
        this.persistTransition(expired);
        item.settle(false);
      } else if(item.request.principalId===owner) {
        result.push({...item.request,input:structuredClone(item.request.input)});
      }
    }
    return result;
  }

  history(principalId:string):ApprovalAuditRecord[] {
    const owner=principalId.trim();
    if(!owner)return [];
    return this.auditRecords.filter(record=>record.principalId===owner).map(record=>({...record}));
  }

  decide(decision:ApprovalDecision):boolean {
    const item=this.pendingRequests.get(decision.approvalId);
    if(!item)return false;
    if(item.request.expiresAt<=Date.now()) {
      const expired:ApprovalAuditRecord={
        id:decision.approvalId,runId:item.request.runId,principalId:item.request.principalId,
        toolName:item.request.toolName,actionHash:item.request.actionHash,risk:item.request.risk,
        status:"expired",createdAt:item.request.createdAt,expiresAt:item.request.expiresAt,settledAt:Date.now(),
      };
      if(!this.persistTransition(expired)) return false;
      clearTimeout(item.timer);
      this.pendingRequests.delete(decision.approvalId);
      item.settle(false);
      return false;
    }
    if(!decision.principalId?.trim()
      ||decision.principalId.trim()!==item.request.principalId
      ||decision.actionHash!==item.request.actionHash) return false;
    const approved=decision.approved===true;
    const settled:ApprovalAuditRecord={
      id:decision.approvalId,runId:item.request.runId,principalId:item.request.principalId,
      toolName:item.request.toolName,actionHash:item.request.actionHash,risk:item.request.risk,
      status:approved?"approved":"rejected",createdAt:item.request.createdAt,
      expiresAt:item.request.expiresAt,settledAt:Date.now(),
    };
    if(!this.persistTransition(settled)) return false;
    this.pendingRequests.delete(decision.approvalId);
    clearTimeout(item.timer);
    item.settle(approved);
    return true;
  }

  cancelRun(runId:string,principalId:string):number {
    let cancelled=0;
    for(const [id,item] of this.pendingRequests) {
      if(item.request.runId===runId&&item.request.principalId===principalId) {
        const record:ApprovalAuditRecord={
          id,runId,principalId,toolName:item.request.toolName,actionHash:item.request.actionHash,
          risk:item.request.risk,status:"cancelled",createdAt:item.request.createdAt,
          expiresAt:item.request.expiresAt,settledAt:Date.now(),
        };
        if(!this.persistTransition(record)) continue;
        this.pendingRequests.delete(id);
        clearTimeout(item.timer);
        item.settle(false);
        cancelled++;
      }
    }
    return cancelled;
  }
}

/**
 * Explicit development-only helper. Production must use a real approval
 * mechanism bound to the displayed action hash; this helper fails closed.
 */
export const approveAll:ApprovalHandler=async()=>{
  if(process.env.NODE_ENV==="production"||process.env.SOFIA_ENV==="production")return false;
  return true;
};
