import type { RiskLevel } from "../security/guard.js";
export interface ApprovalRequest {
  runId:string;
  toolName:string;
  input:Record<string,unknown>;
  actionHash:string;
  risk:RiskLevel;
}
export type ApprovalHandler=(request:ApprovalRequest)=>Promise<boolean>;
export const approveAll:ApprovalHandler=async()=>true;
