import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { SecurityAuditEvent, SecurityAuditSink } from "./audit.js";

export class EncryptedFileAudit implements SecurityAuditSink {
 constructor(private readonly file:string,private readonly secret:string){}
 async record(event:SecurityAuditEvent):Promise<void>{
  await mkdir(path.dirname(this.file),{recursive:true});
  const key=createHash("sha256").update(this.secret).digest();
  const iv=randomBytes(12); const cipher=createCipheriv("aes-256-gcm",key,iv);
  const plaintext=Buffer.from(JSON.stringify(event));
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  const tag=cipher.getAuthTag();
  await appendFile(this.file,Buffer.concat([iv,tag,ciphertext]).toString("base64")+"\n","utf8");
 }
}
