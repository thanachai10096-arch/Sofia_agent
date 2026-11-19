import assert from "node:assert/strict";
import test from "node:test";
import { verifyTransactionEvidence, visiblePageText } from "./transaction.js";
test("matches every explicitly supplied transaction value", () => {
 const html="<main><p>Acme Store</p><p>USD $42.50</p><p>Canvas backpack x 1</p><p>12 Main Street, Bangkok</p></main>";
 const result=verifyTransactionEvidence(html,{recipient:"Acme Store",amount:"$42.50",currency:"USD",items:["Canvas backpack x 1"],shippingAddress:"12 Main Street, Bangkok"});
 assert.equal(result.verified,true); assert.deepEqual(result.missing,[]);
});
test("fails closed when any expected value is absent", () => {
 const result=verifyTransactionEvidence("<p>Acme Store</p><p>$42.50 USD</p>",{recipient:"Acme Store",amount:"$42.50",currency:"USD",shippingAddress:"99 Other Road"});
 assert.equal(result.verified,false); assert.deepEqual(result.missing,["shippingAddress"]);
});
test("ignores script and style content", () => {
 const html="<script>secret merchant</script><style>.price{display:none}</style><p>Visible shop</p>";
 assert.equal(visiblePageText(html).includes("secret merchant"),false);
 assert.equal(verifyTransactionEvidence(html,{recipient:"secret merchant"}).verified,false);
});
test("never verifies without expected fields", () => {
 const result=verifyTransactionEvidence("<p>Any page</p>",{});
 assert.equal(result.verified,false); assert.deepEqual(result.checks,{});
});
