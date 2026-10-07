import type { SofiaTool } from "../tools/types.js";
export interface ApprovalRequest { runId:string; tool:SofiaTool; input:Record<string,unknown>; }
export type ApprovalHandler = (request:ApprovalRequest)=>Promise<boolean>;
export const approveAll:ApprovalHandler=async()=>true;