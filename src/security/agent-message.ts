import { createHmac, timingSafeEqual } from "node:crypto";
export type SignedAgentMessage<T=unknown>={messageId:string;sender:string;recipient:string;issuedAt:number;nonce:string;body:T;signature:string};
function canonical(m:Omit<SignedAgentMessage,"signature">){return JSON.stringify(m);}
function mac(value:string,secret:string){return createHmac("sha256",secret).update(value).digest("hex");}
function safeEqual(a:string,b:string){const aa=Buffer.from(a,"hex"),bb=Buffer.from(b,"hex");return aa.length===bb.length&&timingSafeEqual(aa,bb);}
export function signAgentMessage<T>(m:Omit<SignedAgentMessage<T>,"signature">,secret:string):SignedAgentMessage<T>{
 if(!secret)throw new Error("Agent message secret is required.");
 return {...m,signature:mac(canonical(m),secret)};
}
export class ReplayProtector {
 private readonly seen=new Map<string,number>();
 constructor(private readonly ttlMs=120_000){}
 accept(nonce:string,now=Date.now()):boolean{
   for(const [key,expires] of this.seen)if(expires<=now)this.seen.delete(key);
   if(!nonce||this.seen.has(nonce))return false;
   this.seen.set(nonce,now+this.ttlMs); return true;
 }
 size(){return this.seen.size;}
}
export function verifyAgentMessage<T>(m:SignedAgentMessage<T>,secret:string,maxAgeMs=120_000,expectedRecipient?:string,replay?:ReplayProtector):boolean{
 if(!secret||Math.abs(Date.now()-m.issuedAt)>maxAgeMs)return false;
 if(expectedRecipient&&m.recipient!==expectedRecipient)return false;
 const {signature,...unsigned}=m;
 if(!safeEqual(mac(canonical(unsigned),secret),m.signature))return false;
 return replay?replay.accept(m.nonce):true;
}
