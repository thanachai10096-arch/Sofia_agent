import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { redactSecrets } from "./guard.js";
import type { SecurityAuditEvent, SecurityAuditSink, SecurityEvidenceReader } from "./audit.js";

// All instances in this process that target the same resolved file share one
// queue for both appends and reads.
const writeChains = new Map<string, Promise<void>>();

function enqueue<T>(file: string, operation: () => Promise<T>): Promise<T> {
 const queueKey=path.resolve(file);
 const previous=writeChains.get(queueKey) ?? Promise.resolve();
 const pending=previous.then(operation);
 const settled=pending.then(()=>undefined,()=>undefined);
 writeChains.set(queueKey,settled);
 void settled.then(()=>{
  if(writeChains.get(queueKey)===settled) writeChains.delete(queueKey);
 });
 return pending;
}

export type IncompleteAuditExecution = {
 operationId: string;
 started: SecurityAuditEvent;
 /** Latest event, when a tool reported failure after it began. Partial side effects remain possible. */
 latest?: SecurityAuditEvent;
};

export class EncryptedFileAudit implements SecurityAuditSink, SecurityEvidenceReader {
 constructor(private readonly file:string,private readonly secret:string){}
 private key():Buffer {
  if (!this.secret) throw new Error("Audit encryption secret is required");
  return createHash("sha256").update(this.secret).digest();
 }
 record(event:SecurityAuditEvent):Promise<void>{
  return enqueue(this.file,async()=>{
   const key=this.key();
   await mkdir(path.dirname(this.file),{recursive:true});
   const iv=randomBytes(12); const cipher=createCipheriv("aes-256-gcm",key,iv);
   const plaintext=Buffer.from(JSON.stringify(event));
   const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
   const tag=cipher.getAuthTag();
   const handle=await open(this.file,"a",0o600);
   try {
    await handle.writeFile(Buffer.concat([iv,tag,ciphertext]).toString("base64")+"\n","utf8");
    // Flush the journal record before allowing the caller to continue to a tool side effect.
    await handle.sync();
   } finally {
    await handle.close();
   }
  });
 }
 async getEvidence(evidenceId: string): Promise<SecurityAuditEvent | undefined> {
  if (typeof evidenceId !== "string" || !evidenceId.trim()) return undefined;
  const events = await this.list();
  return events.find(event => event.decision === "completed" && event.evidenceId === evidenceId);
 }
 async listIncompleteExecutions():Promise<IncompleteAuditExecution[]>{
  const events=await this.list();
  const completed=new Set(events
   .filter(event=>(event.decision==="completed"||event.decision==="reconciled")&&event.operationId)
   .map(event=>event.operationId!));
  return events
   .filter(event=>event.decision==="execution_started"&&event.operationId&&!completed.has(event.operationId))
   .map(started=>({
    operationId:started.operationId!,
    started,
    latest:events.filter(event=>event.operationId===started.operationId).at(-1),
   }));
 }
 list():Promise<SecurityAuditEvent[]>{
  return enqueue(this.file,async()=>{
   const key=this.key();
   let contents:string;
   try { contents=await readFile(this.file,"utf8"); }
   catch(error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
   }
   const events:SecurityAuditEvent[]=[];
   for (const [index,line] of contents.split("\n").entries()) {
    if (!line) continue;
    const payload=Buffer.from(line,"base64");
    if (payload.length < 29) throw new Error(`Invalid encrypted audit record at line ${index+1}`);
    const decipher=createDecipheriv("aes-256-gcm",key,payload.subarray(0,12));
    decipher.setAuthTag(payload.subarray(12,28));
    const plaintext=Buffer.concat([decipher.update(payload.subarray(28)),decipher.final()]);
    const event=JSON.parse(plaintext.toString("utf8")) as SecurityAuditEvent;
    if (!event || typeof event.id !== "string" || typeof event.runId !== "string" || typeof event.toolName !== "string") {
     throw new Error(`Invalid audit event at line ${index+1}`);
    }
    events.push(event);
   }
   return events;
  });
 }
}
