import { createHash, randomUUID } from "node:crypto";
import type { ToolEffect } from "./policy.js";
import type { RiskLevel } from "./guard.js";

export type Capability = {
  id:string; principalId:string; runId:string; tool:string; effects:readonly ToolEffect[];
  risk:RiskLevel; expiresAt:number; nonce:string; signature:string;
};

function payload(c:Omit<Capability,"signature">){return JSON.stringify({...c,effects:[...c.effects].sort()});}
export function issueCapability(input:{principalId:string;runId:string;tool:string;effects:readonly ToolEffect[];risk:RiskLevel;ttlMs?:number},secret:string):Capability{
  const base={id:randomUUID(),principalId:input.principalId,runId:input.runId,tool:input.tool,effects:input.effects,risk:input.risk,expiresAt:Date.now()+(input.ttlMs??60_000),nonce:randomUUID()};
  const signature=createHash("sha256").update(secret+"\n"+payload(base)).digest("hex");
  return {...base,signature};
}
export function verifyCapability(cap:Capability, expected:{principalId:string;runId:string;tool:string},secret:string):boolean{
  if(cap.principalId!==expected.principalId||cap.runId!==expected.runId||cap.tool!==expected.tool||cap.expiresAt<Date.now())return false;
  const expectedSig=createHash("sha256").update(secret+"\n"+payload({...cap,signature:undefined} as Omit<Capability,"signature">)).digest("hex");
  return expectedSig===cap.signature;
}
