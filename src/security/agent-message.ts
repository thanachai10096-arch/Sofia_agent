import { createHash } from "node:crypto";
export type SignedAgentMessage<T=unknown>={messageId:string;sender:string;recipient:string;issuedAt:number;nonce:string;body:T;signature:string};
function canonical(m:Omit<SignedAgentMessage,"signature">){return JSON.stringify({...m,body:m.body});}
export function signAgentMessage<T>(m:Omit<SignedAgentMessage<T>,"signature">,secret:string):SignedAgentMessage<T>{
 return {...m,signature:createHash("sha256").update(secret+"\n"+canonical(m)).digest("hex")};
}
export function verifyAgentMessage<T>(m:SignedAgentMessage<T>,secret:string,maxAgeMs=120_000):boolean{
 if(Math.abs(Date.now()-m.issuedAt)>maxAgeMs)return false;
 const {signature,...unsigned}=m;
 return signAgentMessage(unsigned,secret).signature===signature;
}
