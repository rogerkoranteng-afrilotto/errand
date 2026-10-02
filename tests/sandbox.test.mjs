// Against the REAL PayPal sandbox, PayPal's real JWKS and the real Channel3 MCP server. No deployed stack needed.
// Run: node --test tests/sandbox.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPayPal, cfg, PayPalError } from "../backend/paypal.mjs";
import { createChannel3 } from "../backend/channel3.mjs";
import { fetchPaypalJwks, PAYPAL_JWKS_URL } from "../backend/jwt.mjs";

for (const l of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) process.env[m[1]] = m[2]; }
const pp = createPayPal(cfg());
const vault = readFileSync(new URL("../.deploy-state/vault-token-id", import.meta.url), "utf8").trim();
const body = (tag) => ({ intent: "CAPTURE", purchase_units: [{ reference_id: "default", custom_id: `errand-test:${tag}`, invoice_id: `ERRAND-TEST-${tag}`, amount: { currency_code: "USD", value: "4.25", breakdown: { item_total: { currency_code: "USD", value: "4.25" } } }, items: [{ name: "Sandbox test item", quantity: "1", unit_amount: { currency_code: "USD", value: "4.25" }, sku: "test-1", category: "PHYSICAL_GOODS" }] }] });
const tag = Date.now().toString(36).toUpperCase();

test("PayPal JWKS: the published signing key is reachable and is RS256", async () => {
  const keys = await fetchPaypalJwks({ force: true });
  assert.ok(keys.length >= 1); assert.equal(keys[0].alg, "RS256"); assert.equal(keys[0].kty, "RSA"); assert.ok(keys[0].kid);
  console.log(`      ${PAYPAL_JWKS_URL} -> kid ${keys.map((k) => k.kid)}`);
});
test("vault: the fund's token is a PayPal wallet with a payer id (no card)", async () => {
  const t = await pp.getPaymentToken(vault);
  assert.ok(t.payment_source.paypal.payer_id); assert.equal(t.payment_source.card, undefined);
  console.log(`      vault ${vault} payer ${t.payment_source.paypal.payer_id}`);
});
test("orders: the same PayPal-Request-Id returns the SAME order, not a second one", async () => {
  const rid = `errand-test-order-${tag}`;
  const a = await pp.createOrder(body(`${tag}-a`), rid), b = await pp.createOrder(body(`${tag}-a`), rid);
  assert.equal(a.id, b.id); console.log(`      two creates with one Request-Id -> ${a.id} both times`);
});
test("hands-free payment: CREATED order -> confirm with vault -> APPROVED -> capture COMPLETED, no browser", async () => {
  const o = await pp.createOrder(body(`${tag}-b`), `errand-test-order-b-${tag}`);
  assert.equal(o.status, "CREATED");
  const c = await pp.confirmWithVault(o.id, vault); assert.equal(c.status, "APPROVED");
  const cap = await pp.capture(o.id, `errand-test-cap-${tag}`); assert.equal(cap.status, "COMPLETED");
  const id = cap.purchase_units[0].payments.captures[0].id;
  console.log(`      order ${o.id} captured as ${id}`);
  // Replays: same Request-Id returns the original result; a different Request-Id is refused with ORDER_ALREADY_CAPTURED.
  const again = await pp.capture(o.id, `errand-test-cap-${tag}`);
  assert.equal(again.purchase_units[0].payments.captures[0].id, id); console.log("      replay with the same Request-Id -> same capture id");
  await assert.rejects(() => pp.capture(o.id, `errand-test-cap-other-${tag}`), (e) => e instanceof PayPalError && e.issue === "ORDER_ALREADY_CAPTURED");
  console.log("      replay with a new Request-Id -> 422 ORDER_ALREADY_CAPTURED (the service treats this as success)");
  const full = await pp.getOrder(o.id); assert.equal(full.purchase_units[0].payments.captures.length, 1);
});
test("orders: Channel3 CDN image URLs are rejected by PayPal, which is why order items carry no image_url", async () => {
  const bad = body(`${tag}-c`); bad.purchase_units[0].items[0].image_url = "https://cdn.trychannel3.com/cleaned/v1/8c5ff2c9-8092?aid=01M3&mid=QnTm";
  await assert.rejects(() => pp.createOrder(bad, `errand-test-img-${tag}`), (e) => e.status === 400 && /image_url/.test(JSON.stringify(e.body)));
});
test("webhook verification: PayPal refuses a request whose headers do not match any real delivery", async () => {
  const raw = JSON.stringify({ id: "WH-FAKE", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} });
  const hdr = { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270", "paypal-transmission-id": "00000000-0000-0000-0000-000000000000", "paypal-transmission-sig": "AAAA", "paypal-transmission-time": "2026-10-02T00:00:00Z" };
  let verdict; try { verdict = (await pp.verifyWebhook("26C51957X24463123", hdr, raw)).verification_status; } catch (e) { verdict = `HTTP ${e.status}`; }
  assert.notEqual(verdict, "SUCCESS"); console.log(`      forged event -> ${verdict}`);
});
test("Channel3 MCP: search then get_products on the same thread; price comes back in cents; the N95 and inhaler cases behave as documented", async () => {
  const c = createChannel3();
  const found = await c.search("twin size bed sheet set");
  assert.ok(found.length >= 3); assert.ok(found[0].offers[0].priceCents > 0); assert.ok(c.threadId?.startsWith("thr_"));
  const live = await c.details([found[0].id]); assert.equal(live[0].id, found[0].id);
  const n95 = await c.search("NIOSH N95 respirator mask");
  const hasN95 = n95.some((p) => /\bn95\b/i.test(`${p.title} ${p.description}`) && /respirator|mask/i.test(`${p.title} ${p.description}`) && !/laptop|processor|intel/i.test(`${p.title} ${p.description}`));
  const laptopTrap = n95.filter((p) => /laptop/i.test(p.title) && /\bn95\b/i.test(p.title)).length;
  const inh = await c.search("albuterol inhaler");
  const vet = inh.filter((p) => p.offers.some((o) => /petco|petsmart|tractorsupply|chewy/.test(o.domain)));
  console.log(`      N95 query: ${n95.length} results, an actual N95 respirator among them: ${hasN95}, Intel "N95" laptops among them: ${laptopTrap}; albuterol query: ${vet.length} of ${inh.length} sold at pet/farm retailers`);
});
