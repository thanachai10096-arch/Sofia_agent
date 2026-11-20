import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { acceptWebhookEvent, MemoryWebhookReplayStore, verifyHmacWebhookSignature } from "./webhooks.js";
const secret = "test-secret", body = '{"id":"evt_123","type":"payment.succeeded"}', now = 1_800_000_000_000;
function header(timestamp: number, rawBody = body): string { const signature = createHmac("sha256", secret).update(String(timestamp) + ".").update(rawBody).digest("hex"); return "t=" + timestamp + ",v1=" + signature; }
test("verifies valid signature over exact raw body", () => { assert.deepEqual(verifyHmacWebhookSignature({ rawBody: body, signatureHeader: header(now / 1000), secret, now }), { valid: true, timestamp: now / 1000 }); });
test("rejects modified body and malformed header", () => { assert.equal(verifyHmacWebhookSignature({ rawBody: body + " ", signatureHeader: header(now / 1000), secret, now }).valid, false); assert.deepEqual(verifyHmacWebhookSignature({ rawBody: body, signatureHeader: "bad", secret, now }), { valid: false, reason: "malformed-header" }); });
test("rejects stale signatures and missing secrets", () => { assert.deepEqual(verifyHmacWebhookSignature({ rawBody: body, signatureHeader: header(1), secret, now }), { valid: false, reason: "stale-timestamp" }); assert.deepEqual(verifyHmacWebhookSignature({ rawBody: body, signatureHeader: header(now / 1000), secret: "", now }), { valid: false, reason: "missing-secret" }); });
test("reserves event IDs once and rejects replay", async () => { const store = new MemoryWebhookReplayStore(100, () => now); assert.equal(await acceptWebhookEvent(store, "evt_123", now / 1000, 300, now), true); assert.equal(await acceptWebhookEvent(store, "evt_123", now / 1000, 300, now), false); });
test("rejects expired event timestamps and empty IDs", async () => { const store = new MemoryWebhookReplayStore(100, () => now); assert.equal(await acceptWebhookEvent(store, "evt_old", 1, 300, now), false); assert.equal(await acceptWebhookEvent(store, " ", now / 1000, 300, now), false); });
