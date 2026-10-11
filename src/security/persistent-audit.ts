import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SecurityAuditEvent, SecurityAuditSink } from "./audit.js";

export class EncryptedFileAudit implements SecurityAuditSink {
 constructor(private readonly file:string,private readonly secret:string){}
 private key():Buffer {
  if (!this.secret) throw new Error("Audit encryption secret is required");
  return createHash("sha256").update(this.secret).digest();
 }
 async record(event:SecurityAuditEvent):Promise<void>{
  const key=this.key();
  await mkdir(path.dirname(this.file),{recursive:true});
  const iv=randomBytes(12); const cipher=createCipheriv("aes-256-gcm",key,iv);
  const plaintext=Buffer.from(JSON.stringify(event));
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  const tag=cipher.getAuthTag();
  await appendFile(this.file,Buffer.concat([iv,tag,ciphertext]).toString("base64")+"\n","utf8");
 }
 async list():Promise<SecurityAuditEvent[]>{
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
 }
}
