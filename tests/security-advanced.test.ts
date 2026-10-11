import {describe,it} from "node:test";
import assert from "node:assert/strict";
import {issueCapability,verifyCapability} from "../src/security/capability.js";
import {ReplayProtector,signAgentMessage,verifyAgentMessage} from "../src/security/agent-message.js";
import {assertSecurityConfiguration,loadExecutionPolicyFromEnv} from "../src/security/policy.js";

describe("advanced security",()=>{
 it("binds capabilities and rejects tampering",()=>{
  const c=issueCapability({principalId:"p",runId:"r",tool:"workspace.write_file",effects:["write"],risk:"medium",ttlMs:1000},"secret");
  assert.equal(verifyCapability(c,{principalId:"p",runId:"r",tool:"workspace.write_file"},"secret"),true);
  assert.equal(verifyCapability(c,{principalId:"attacker",runId:"r",tool:"workspace.write_file"},"secret"),false);
  assert.equal(verifyCapability({...c,signature:"00".repeat(32)},{principalId:"p",runId:"r",tool:"workspace.write_file"},"secret"),false);
 });
 it("rejects tampered signed agent messages and replays",()=>{
  const replay=new ReplayProtector();
  const m=signAgentMessage({messageId:"1",sender:"a",recipient:"b",issuedAt:Date.now(),nonce:"n",body:{task:"x"}},"secret");
  assert.equal(verifyAgentMessage(m,"secret",120_000,"b",replay),true);
  assert.equal(verifyAgentMessage(m,"secret",120_000,"b",replay),false);
  assert.equal(verifyAgentMessage({...m,body:{task:"evil"}},"secret"),false);
 });
 it("fails closed for production security configuration",()=>{
  const old={...process.env};
  process.env.SOFIA_ENV="production"; delete process.env.SOFIA_CAPABILITY_SECRET;
  assert.throws(()=>assertSecurityConfiguration(loadExecutionPolicyFromEnv()),/SOFIA_CAPABILITY_SECRET/);
  process.env.SOFIA_CAPABILITY_SECRET="test"; process.env.SOFIA_AUDIT_SECRET="test-audit"; process.env.SOFIA_ALLOW_NETWORK="true"; delete process.env.SOFIA_ALLOWED_HOSTS;
  assert.throws(()=>assertSecurityConfiguration(loadExecutionPolicyFromEnv()),/SOFIA_ALLOWED_HOSTS/);
  process.env=old;
 });
});