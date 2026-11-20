import type { RiskLevel } from "../security/guard.js";
export interface ApprovalRequest {
  runId:string;
  principalId?:string;
  /** Trusted reply destination, carried from the authenticated messaging job. */
  notificationChannelId?:string;
  toolName:string;
  input:Record<string,unknown>;
  actionHash:string;
  risk:RiskLevel;
  /** Caller cancellation signal; never persisted with the approval record. */
  signal?:AbortSignal;
}
export type ApprovalHandler=(request:ApprovalRequest)=>Promise<boolean>;
/**
 * Explicit development-only helper. Production must use a real approval
 * mechanism bound to the displayed action hash; this helper fails closed.
 */
export const approveAll:ApprovalHandler=async()=>{
  if(process.env.NODE_ENV==="production"||process.env.SOFIA_ENV==="production")return false;
  return true;
};
