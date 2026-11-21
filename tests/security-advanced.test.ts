
import {approveAll} from "../src/agent/approval.js";
import {describe,it} from "node:test";
import assert from "node:assert/strict";
import {issueCapability,verifyCapability} from "../src/security/capability.js";
import {ReplayProtector,signAgentMessage,verifyAgentMessage} from "../src/security/agent-message.js";
import {assertSecurityConfiguration,loadExecutionPolicyFromEnv} from "../src/security/policy.js";
import {SecurityController} from "../src/security/controller.js";

describe("advanced security",()=>{
 it("aborts active operations when the kill switch activates",()=>{
  const security=new SecurityController();
  const parent=new AbortController();
  const bound=security.bindSignal(parent.signal);
  assert.equal(bound.signal.aborted,false);
  security.kill("test incident");
  assert.equal(bound.signal.aborted,true);
  assert.throws(()=>security.assertRunning(),/kill switch is active/);
  bound.dispose();
  security.revive();
  assert.equal(security.isKilled(),false);
 });
 it("binds capabilities and rejects tampering",()=>{
  const c=issueCapability({principalId:"p",runId:"r",tool:"workspace.write_file",effects:["write"],risk:"medium",actionHash:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",ttlMs:1000},"secret");
  assert.equal(verifyCapability(c,{principalId:"p",runId:"r",tool:"workspace.write_file",actionHash:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"secret"),true);
  assert.equal(verifyCapability(c,{principalId:"p",runId:"r",tool:"workspace.write_file",effects:["write"],risk:"medium",actionHash:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"secret"),true);
  assert.equal(verifyCapability(c,{principalId:"p",runId:"r",tool:"workspace.write_file",effects:["read"],risk:"medium"},"secret"),false);
  assert.equal(verifyCapability(c,{principalId:"p",runId:"r",tool:"workspace.write_file",effects:["write"],risk:"high",actionHash:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"secret"),false);
  assert.equal(verifyCapability(c,{principalId:"attacker",runId:"r",tool:"workspace.write_file",actionHash:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"secret"),false);
  assert.equal(verifyCapability({...c,signature:"00".repeat(32)},{principalId:"p",runId:"r",tool:"workspace.write_file"},"secret"),false);
  assert.equal(verifyCapability(c,{principalId:"p",runId:"r",tool:"workspace.write_file",actionHash:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"secret"),false);
  assert.equal(verifyCapability({...c,expiresAt:Number.NaN},{principalId:"p",runId:"r",tool:"workspace.write_file"},"secret"),false);
  assert.equal(verifyCapability({...c,signature:"not-a-hex-signature"},{principalId:"p",runId:"r",tool:"workspace.write_file"},"secret"),false);
  assert.throws(()=>issueCapability({principalId:"p",runId:"r",tool:"workspace.write_file",effects:["write"],risk:"medium",actionHash:"a".repeat(64),ttlMs:300_001},"secret"),/TTL/);
 });
 it("rejects tampered signed agent messages and replays",()=>{
  const replay=new ReplayProtector();
  const m=signAgentMessage({messageId:"1",sender:"a",recipient:"b",issuedAt:Date.now(),nonce:"n",body:{task:"x"}},"secret");
  assert.equal(verifyAgentMessage(m,"secret",120_000,"b",replay),true);
  assert.equal(verifyAgentMessage(m,"secret",120_000,"b",replay),false);
  assert.equal(verifyAgentMessage({...m,body:{task:"evil"}},"secret"),false);
 });
 it("rejects malformed agent identity, timestamps, and signatures",()=>{
  const base=signAgentMessage({messageId:"msg-1",sender:"agent-a",recipient:"agent-b",issuedAt:Date.now(),nonce:"nonce-1",body:{task:"x"}},"secret");
  assert.equal(verifyAgentMessage({...base,signature:"zz".repeat(32)},"secret"),false);
  assert.equal(verifyAgentMessage({...base,issuedAt:Number.NaN},"secret"),false);
  assert.equal(verifyAgentMessage({...base,sender:""},"secret"),false);
  assert.equal(verifyAgentMessage({...base,nonce:""},"secret"),false);
  assert.equal(verifyAgentMessage(base,"secret",Number.POSITIVE_INFINITY),false);
  assert.throws(()=>signAgentMessage({...base,messageId:""},"secret"),/identity/);
 });
 it("scopes replay protection by sender and recipient and bounds its cache",()=>{
  const replay=new ReplayProtector(60_000,2);
  const now=Date.now();
  const a=signAgentMessage({messageId:"1",sender:"agent-a",recipient:"agent-b",issuedAt:now,nonce:"shared",body:{}}, "secret");
  const b=signAgentMessage({messageId:"2",sender:"agent-c",recipient:"agent-b",issuedAt:now,nonce:"shared",body:{}}, "secret");
  assert.equal(verifyAgentMessage(a,"secret",120_000,"agent-b",replay),true);
  assert.equal(verifyAgentMessage(a,"secret",120_000,"agent-b",replay),false);
  assert.equal(verifyAgentMessage(b,"secret",120_000,"agent-b",replay),true);
  const c=signAgentMessage({messageId:"3",sender:"agent-a",recipient:"agent-b",issuedAt:now,nonce:"third",body:{}}, "secret");
  assert.equal(verifyAgentMessage(c,"secret",120_000,"agent-b",replay),false);
  assert.equal(replay.size(),2);
  assert.throws(()=>new ReplayProtector(0),/TTL/);
  assert.throws(()=>new ReplayProtector(120_000,0),/capacity/);
 });
 it("never blanket-approves actions in production",async()=>{
  const oldNode=process.env.NODE_ENV; const oldSofia=process.env.SOFIA_ENV;
  process.env.SOFIA_ENV="production";
  assert.equal(await approveAll({runId:"r",principalId:"p",toolName:"terminal.run",input:{command:"x"},actionHash:"hash",risk:"high"}),false);
  if(oldNode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldNode;
  if(oldSofia===undefined)delete process.env.SOFIA_ENV;else process.env.SOFIA_ENV=oldSofia;
 });
 it("fails closed for production security configuration",()=>{
  const old={...process.env};
  process.env.SOFIA_ENV="production"; delete process.env.SOFIA_CAPABILITY_SECRET;
  assert.throws(()=>assertSecurityConfiguration(loadExecutionPolicyFromEnv()),/SOFIA_CAPABILITY_SECRET/);
  process.env.SOFIA_CAPABILITY_SECRET="test"; delete process.env.SOFIA_AUDIT_SECRET;
  assert.throws(()=>assertSecurityConfiguration(loadExecutionPolicyFromEnv()),/SOFIA_AUDIT_SECRET/);
  process.env.SOFIA_AUDIT_SECRET="test-audit"; process.env.SOFIA_ALLOW_NETWORK="true"; delete process.env.SOFIA_ALLOWED_HOSTS;
  assert.throws(()=>assertSecurityConfiguration(loadExecutionPolicyFromEnv()),/SOFIA_ALLOWED_HOSTS/);
  process.env=old;
 });
});