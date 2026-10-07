export interface ApprovalRequest { runId:string; toolName:string; input:Record<string,unknown>; }
export type ApprovalHandler = (request:ApprovalRequest)=>Promise<boolean>;
export const approveAll:ApprovalHandler=async()=>true;
