import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ToolEffect } from "./policy.js";
import type { RiskLevel } from "./guard.js";

export type Capability = {
  id:string; principalId:string; runId:string; tool:string; effects:readonly ToolEffect[];
  risk:RiskLevel; expiresAt:number; nonce:string; signature:string;
};

function payload(c:Omit<Capability,"signature">){return JSON.stringify({...c,effects:[...c.effects].sort()});}
function mac(value:string,secret:string){return createHmac("sha256",secret).update(value).digest("hex");}
function safeEqual(a:string,b:string){const aa=Buffer.from(a,"hex"),bb=Buffer.from(b,"hex");return aa.length===bb.length&&timingSafeEqual(aa,bb);}
export function issueCapability(input:{principalId:string;runId:string;tool:string;effects:readonly ToolEffect[];risk:RiskLevel;ttlMs?:number},secret:string):Capability{
  if(!secret)throw new Error("Capability secret is required.");
  const base={id:randomUUID(),principalId:input.principalId,runId:input.runId,tool:input.tool,effects:input.effects,risk:input.risk,expiresAt:Date.now()+(input.ttlMs??60_000),nonce:randomUUID()};
  return {...base,signature:mac(payload(base),secret)};
}
export function verifyCapability(cap:Capability,expected:{principalId:string;runId:string;tool:string},secret:string):boolean{
  if(!secret||cap.principalId!==expected.principalId||cap.runId!==expected.runId||cap.tool!==expected.tool||cap.expiresAt<Date.now())return false;
  const {signature:_signature,...unsigned}=cap;
  return safeEqual(mac(payload(unsigned),secret),cap.signature);
}
