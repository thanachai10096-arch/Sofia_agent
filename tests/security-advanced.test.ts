import {describe,it} from "node:test";
import assert from "node:assert/strict";
import {issueCapability,verifyCapability} from "../src/security/capability.js";
import {signAgentMessage,verifyAgentMessage} from "../src/security/agent-message.js";
describe("advanced security",()=>{
 it("binds capabilities to principal/run/tool and expiry",()=>{
  const c=issueCapability({principalId:"p",runId:"r",tool:"workspace.write_file",effects:["write"],risk:"medium",ttlMs:1000},"secret");
  assert.equal(verifyCapability(c,{principalId:"p",runId:"r",tool:"workspace.write_file"},"secret"),true);
  assert.equal(verifyCapability(c,{principalId:"attacker",runId:"r",tool:"workspace.write_file"},"secret"),false);
 });
 it("rejects tampered signed agent messages",()=>{
  const m=signAgentMessage({messageId:"1",sender:"a",recipient:"b",issuedAt:Date.now(),nonce:"n",body:{task:"x"}},"secret");
  assert.equal(verifyAgentMessage(m,"secret"),true);
  assert.equal(verifyAgentMessage({...m,body:{task:"evil"}},"secret"),false);
 });
});
