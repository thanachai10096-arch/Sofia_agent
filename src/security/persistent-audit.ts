import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SecurityAuditEvent, SecurityAuditSink } from "./audit.js";
import { redactSecrets } from "./guard.js";

export class EncryptedFileAudit implements SecurityAuditSink {
 constructor(private readonly file:string,private readonly secret:string){}
 async record(event:SecurityAuditEvent):Promise<void>{
  if (!this.secret) throw new Error("Audit encryption secret is required");
  await mkdir(path.dirname(this.file),{recursive:true});
  const key=createHash("sha256").update(this.secret).digest();
  const iv=randomBytes(12); const cipher=createCipheriv("aes-256-gcm",key,iv);
  // Persist only a redacted copy: encryption protects storage, but authorized readers must not receive raw credentials.\n  const safeEvent=redactSecrets(event) as SecurityAuditEvent;\n  const plaintext=Buffer.from(JSON.stringify(safeEvent));
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  const tag=cipher.getAuthTag();
  await appendFile(this.file,Buffer.concat([iv,tag,ciphertext]).toString("base64")+"\n","utf8");
 }

 /** Read and authenticate persisted audit records, including records from previous process instances. */
 async list():Promise<SecurityAuditEvent[]>{
  if (!this.secret) throw new Error("Audit encryption secret is required");
  let contents:string;
  try { contents=await readFile(this.file,"utf8"); }
  catch(error) {
   if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
   throw error;
  }
  const key=createHash("sha256").update(this.secret).digest();
  const events:SecurityAuditEvent[]=[];
  for (const [index,line] of contents.split("\n").entries()) {
   if (!line) continue;
   const payload=Buffer.from(line,"base64");
   if (payload.length < 29) throw new Error(`Invalid encrypted audit record at line ${index+1}`);
   const iv=payload.subarray(0,12);
   const tag=payload.subarray(12,28);
   const ciphertext=payload.subarray(28);
   const decipher=createDecipheriv("aes-256-gcm",key,iv);
   decipher.setAuthTag(tag);
   const plaintext=Buffer.concat([decipher.update(ciphertext),decipher.final()]);
   const event=JSON.parse(plaintext.toString("utf8")) as SecurityAuditEvent;
   if (!event || typeof event.id !== "string" || typeof event.at !== "string" || typeof event.runId !== "string" || typeof event.toolName !== "string" || typeof event.actionHash !== "string" || !["low","medium","high","critical"].includes(event.risk) || !["allow","deny","approval_required","approval_denied","completed","failed"].includes(event.decision)) {
    throw new Error(`Invalid audit event at line ${index+1}`);
   }
   events.push(event);
  }
  return events;
 }
}
