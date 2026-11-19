import { randomUUID } from "node:crypto";
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
export interface ApprovalDecision {
  approvalId:string;
  principalId:string;
  actionHash:string;
  approved:boolean;
}

/**
 * In-memory, single-use approval broker. Decisions are bound to the requesting
 * principal and immutable action hash. Hosts should expose pending() and
 * decide() only through authenticated, owner-scoped approval endpoints.
 * Pending approvals intentionally do not survive process restarts.
 */
export class ApprovalBroker {
  private readonly pendingRequests = new Map<string, {
    request:PendingApproval;
    settle:(approved:boolean)=>void;
    timer:ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly ttlMs=120_000) {
    if(!Number.isSafeInteger(ttlMs)||ttlMs<1_000||ttlMs>15*60_000) {
      throw new RangeError("Approval TTL must be between 1 second and 15 minutes.");
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
    return new Promise<boolean>((resolve)=>{
      const timer=setTimeout(()=>{
        const current=this.pendingRequests.get(id);
        if(!current)return;
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
        clearTimeout(item.timer);
        this.pendingRequests.delete(id);
        item.settle(false);
      } else if(item.request.principalId===owner) {
        result.push({...item.request,input:structuredClone(item.request.input)});
      }
    }
    return result;
  }

  decide(decision:ApprovalDecision):boolean {
    const item=this.pendingRequests.get(decision.approvalId);
    if(!item)return false;
    if(item.request.expiresAt<=Date.now()) {
      clearTimeout(item.timer);
      this.pendingRequests.delete(decision.approvalId);
      item.settle(false);
      return false;
    }
    if(!decision.principalId?.trim()
      ||decision.principalId.trim()!==item.request.principalId
      ||decision.actionHash!==item.request.actionHash) return false;
    this.pendingRequests.delete(decision.approvalId);
    clearTimeout(item.timer);
    item.settle(decision.approved===true);
    return true;
  }

  cancelRun(runId:string,principalId:string):number {
    let cancelled=0;
    for(const [id,item] of this.pendingRequests) {
      if(item.request.runId===runId&&item.request.principalId===principalId) {
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
