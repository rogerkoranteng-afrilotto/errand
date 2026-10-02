// Offline tests: no network. Run with `node --test tests/unit.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign, createHash } from "node:crypto";
import { agentKey, signAgentToken, verifyBearer } from "../backend/jwt.mjs";
import { blockReasons, missingRequirements, budgetOf, packCount, bestOffer, RESERVE_PCT } from "../backend/policy.mjs";
import { handleCartApi } from "../backend/cartapi.mjs";
import { newRun, execTool } from "../backend/tools.mjs";
import { runAgent, rulesFill } from "../backend/agent.mjs";
import { buy } from "../backend/purchase.mjs";
import { handle, runJob } from "../backend/index.mjs";
import { parseRpcBody, normalizeProduct } from "../backend/channel3.mjs";
import { testCtx, product, offer, keyB64 } from "./helpers.mjs";

const b64u = (x) => Buffer.from(x).toString("base64url");
const delivery = { line1: "1 Example Way", city: "Pasadena", state: "CA", postal: "91101" };
const catalogue = () => [
  product("SHEET1", "Twin Sheet Set 3 Piece", [offer("kohls.com", 24.5)], { description: "Soft microfibre twin sheet set." }),
  product("SHEET2", "Queen Sheet Set", [offer("kohls.com", 20)], { description: "Queen size." }),
  product("CHG1", "USB-C Wall Charger with Cable", [offer("target.com", 15)], { description: "20W USB-C charger and cable." }),
  product("FORM1", "Infant Formula Powder", [offer("walgreens.com", 23.99), offer("cvs.com", 25.29)], { category: "Food > Baby Formula", description: "Infant formula powder with iron." }),
  product("INH1", "Albuterol Sulfate HFA Inhalation Aerosol", [offer("tractorsupply.com", 35.99)], { description: "Veterinary use. Inhalation aerosol." }),
  product("DOG1", "Dog Bed Twin Sheet Set", [offer("petco.com", 9)], { description: "twin sheet for dogs", category: "Animals & Pet Supplies" }),
  product("OOS1", "Out Of Stock Charger USB-C", [offer("target.com", 12, { availability: "OutOfStock" }), offer("bestbuy.com", 14)], { description: "USB-C charger" }),
  product("PRICEY", "Twin Sheet Set Deluxe", [offer("qvc.com", 900)], { description: "twin sheet set luxury" }),
];
const mkRun = (over = {}) => newRun({ id: "rtest1", reference: "T-1", request: "twin sheets and a charger", capCents: 10000, budget: budgetOf(over.capCents ?? 10000), mode: "buy", delivery, instructions: "", allergies: over.allergies ?? "None known", now: new Date().toISOString(), ...over });
const toolRun = async (ctx, products) => { const run = mkRun(); for (const p of products || catalogue()) run.seen[p.id] = p; await execTool(ctx, run, "record_needs", { needs: [{ id: "sheets", label: "Twin sheet set", quantity: 1 }, { id: "charger", label: "Charger", quantity: 1 }] }); return run; };

// ---------------------------------------------------------------- JWT
test("jwt: an agent-signed token verifies; payload, signature, alg and expiry attacks are rejected", async () => {
  const key = agentKey(keyB64());
  const tok = signAgentToken(key, { run: "r1", limit_cents: 5000 });
  const ok = await verifyBearer(`Bearer ${tok}`, { agent: key, paypalJwks: async () => [] });
  assert.equal(ok.ok, true); assert.equal(ok.issuer, "agent"); assert.equal(ok.claims.limit_cents, 5000);

  const [h, p, s] = tok.split(".");
  const forged = { ...JSON.parse(Buffer.from(p, "base64url")), limit_cents: 9_999_999 };
  assert.equal((await verifyBearer(`Bearer ${h}.${b64u(JSON.stringify(forged))}.${s}`, { agent: key, paypalJwks: async () => [] })).reason, "bad_signature");

  const none = `${b64u(JSON.stringify({ alg: "none", typ: "JWT", kid: key.kid }))}.${p}.`;
  assert.equal((await verifyBearer(`Bearer ${none}`, { agent: key, paypalJwks: async () => [] })).ok, false);
  const hs = `${b64u(JSON.stringify({ alg: "HS256", typ: "JWT", kid: key.kid }))}.${p}.${b64u("x")}`;
  assert.equal((await verifyBearer(`Bearer ${hs}`, { agent: key, paypalJwks: async () => [] })).reason, "alg_not_allowed");

  const old = signAgentToken(key, {}, { now: Date.now() - 3600_000, ttlSec: 60 });
  assert.equal((await verifyBearer(`Bearer ${old}`, { agent: key, paypalJwks: async () => [] })).reason, "expired");
  assert.equal((await verifyBearer("", { agent: key })).reason, "missing_bearer");
  assert.equal((await verifyBearer("Bearer a.b", { agent: key })).reason, "malformed");
});

test("jwt: a token signed by PayPal's key (injected JWKS) verifies; the same kid signed by another key does not", async () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "pp-kid-1", use: "sig", alg: "RS256" };
  const sign = (priv, claims) => { const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "pp-kid-1" })), body = b64u(JSON.stringify(claims)); const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(priv); return `${head}.${body}.${b64u(sig)}`; };
  const exp = Math.floor(Date.now() / 1000) + 600;
  const good = sign(pair.privateKey, { merchant_id: "MERCHANT-123", scope: ["cart"], iat: exp - 600, exp });
  const r = await verifyBearer(`Bearer ${good}`, { agent: null, paypalJwks: async () => [jwk] });
  assert.equal(r.ok, true); assert.equal(r.issuer, "paypal");
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const impostor = sign(other.privateKey, { merchant_id: "MERCHANT-123", exp });
  assert.equal((await verifyBearer(`Bearer ${impostor}`, { agent: null, paypalJwks: async () => [jwk] })).reason, "bad_signature");
  assert.equal((await verifyBearer(`Bearer ${good}`, { agent: null, paypalJwks: async () => [] })).reason, "unknown_kid");
  assert.equal((await verifyBearer(`Bearer ${good}`, { agent: null, paypalJwks: async () => { throw new Error("down"); } })).reason, "jwks_unreachable");
});

// ---------------------------------------------------------------- policy
test("policy: the reserve is 10% of the cap and the ceiling holds", () => {
  assert.equal(RESERVE_PCT, 10);
  assert.deepEqual(budgetOf(77000), { capCents: 77000, reserveCents: 7700, spendableCents: 69300 });
  assert.equal(budgetOf(99_999_999).capCents, 100_000);
});
test("policy: animals, prescription text, stock and condition block an offer", () => {
  const c = catalogue(), by = Object.fromEntries(c.map((p) => [p.id, p]));
  assert.ok(blockReasons(by.INH1, by.INH1.offers[0]).some((r) => r.includes("animals")));
  assert.ok(blockReasons(by.INH1, by.INH1.offers[0]).some((r) => r.includes("prescription")));
  assert.ok(blockReasons(by.DOG1, by.DOG1.offers[0]).some((r) => r.includes("animals")));
  assert.ok(blockReasons(by.OOS1, by.OOS1.offers[0]).some((r) => r.includes("not in stock")));
  assert.deepEqual(blockReasons(by.SHEET1, by.SHEET1.offers[0]), []);
  assert.ok(blockReasons(by.SHEET1, { ...by.SHEET1.offers[0], condition: "used" }).some((r) => r.includes("not new")));
  assert.equal(bestOffer(by.OOS1).domain, "bestbuy.com");
});
test("policy: requirement words must appear in the product text; a|b means either", () => {
  const p = catalogue()[0];
  assert.deepEqual(missingRequirements(p, ["twin", "sheet"]), []);
  assert.deepEqual(missingRequirements(p, ["queen"]), ["queen"]);
  assert.deepEqual(missingRequirements(p, ["queen|twin"]), []);
  assert.equal(packCount({ title: "Diapers 120 Count", description: "" }), 120);
  assert.equal(packCount({ title: "Charger", description: "" }), null);
});
test("channel3: SSE and JSON bodies parse; products normalise to integer cents with real alt text", () => {
  assert.equal(parseRpcBody('event: message\ndata: {"result":{"x":1},"id":2}\n\n').result.x, 1);
  assert.equal(parseRpcBody('{"result":{"y":2}}').result.y, 2);
  const n = normalizeProduct({ id: "A", title: "T", brands: [{ name: "B" }], images: [{ url: "u", cleaned_url: "c", alt_text: "A real description", is_main_image: true }], offers: [{ url: "o", domain: "d.com", price: { price: 12.99, currency: "USD" }, availability: "InStock", condition: "new" }], structured_attributes: { size: ["Twin"] } });
  assert.equal(n.offers[0].priceCents, 1299); assert.equal(n.images[0].alt, "A real description"); assert.equal(n.images[0].url, "c"); assert.deepEqual(n.attributes, ["size: Twin"]);
});

// ---------------------------------------------------------------- tools: the budget and the refusals live in code
test("tools: a line over the remaining budget is refused by the server, not by the model", async () => {
  const ctx = await testCtx({ products: catalogue() }); const run = await toolRun(ctx);
  const r = await execTool(ctx, run, "add_to_cart", { need_id: "sheets", product_id: "PRICEY", quantity: 1, must_have: ["twin"], why: "A twin sheet set for the child." });
  assert.equal(r.ok, false); assert.match(r.error, /Over budget/); assert.equal(run.lines.length, 0);
});
test("tools: a product that does not mention the required word is refused", async () => {
  const ctx = await testCtx({ products: catalogue() }); const run = await toolRun(ctx);
  const r = await execTool(ctx, run, "add_to_cart", { need_id: "sheets", product_id: "SHEET2", quantity: 1, must_have: ["twin"], why: "Cheapest sheet set found." });
  assert.equal(r.ok, false); assert.match(r.error, /does not mention: twin/);
});
test("tools: the word N95 alone would match a laptop; the product noun in must_have stops it", async () => {
  const laptop = product("LAP1", "N95 Laptop", [offer("macys.com", 349)], { description: "15.6 inch laptop with Intel Alder Lake N95 processor.", category: "Electronics > Computers" });
  const ctx = await testCtx({ products: [laptop, ...catalogue()] }); const run = mkRun({ capCents: 90000 }); run.seen.LAP1 = laptop;
  await execTool(ctx, run, "record_needs", { needs: [{ id: "n95", label: "N95 masks", quantity: 1 }] });
  const naive = await execTool(ctx, run, "add_to_cart", { need_id: "n95", product_id: "LAP1", quantity: 1, must_have: ["n95"], why: "Title says N95, so it matches." });
  assert.equal(naive.ok, true, "this is the weakness the noun rule exists for: a lone constraint word passes");
  run.lines = []; run.needs[0].status = "open";
  const guarded = await execTool(ctx, run, "add_to_cart", { need_id: "n95", product_id: "LAP1", quantity: 1, must_have: ["mask|respirator", "n95"], why: "Title says N95, so it matches." });
  assert.equal(guarded.ok, false); assert.match(guarded.error, /mask\|respirator/);
});
test("tools: veterinary and prescription items cannot be added even if the model insists", async () => {
  const ctx = await testCtx({ products: catalogue() }); const run = await toolRun(ctx);
  const r = await execTool(ctx, run, "add_to_cart", { need_id: "sheets", product_id: "INH1", quantity: 1, must_have: ["albuterol"], why: "It is the inhaler that was asked for." });
  assert.equal(r.ok, false); assert.match(r.error, /animals|prescription/);
  const d = await execTool(ctx, run, "add_to_cart", { need_id: "sheets", product_id: "DOG1", quantity: 1, must_have: ["twin"], why: "A twin sheet set for the child." });
  assert.equal(d.ok, false);
});
test("tools: a product never seen in a search cannot be bought; quantity and why are validated", async () => {
  const ctx = await testCtx({ products: catalogue() }); const run = await toolRun(ctx, []);
  assert.match((await execTool(ctx, run, "add_to_cart", { need_id: "sheets", product_id: "SHEET1", quantity: 1, must_have: ["twin"], why: "Because it fits the need." })).error, /has not appeared in a search/);
  run.seen.SHEET1 = catalogue()[0];
  assert.match((await execTool(ctx, run, "add_to_cart", { need_id: "sheets", product_id: "SHEET1", quantity: 99, must_have: ["twin"], why: "Because it fits the need." })).error, /quantity/);
  assert.match((await execTool(ctx, run, "add_to_cart", { need_id: "sheets", product_id: "SHEET1", quantity: 1, must_have: ["twin"], why: "x" })).error, /why is required/);
});
test("tools: a substitution is recorded, the need turns 'substituted', and the live price is re-read", async () => {
  const ctx = await testCtx({ products: catalogue() }); const run = await toolRun(ctx);
  run.seen.SHEET1 = { ...catalogue()[0], offers: [offer("kohls.com", 10)] };            // stale search-time price
  const r = await execTool(ctx, run, "add_to_cart", { need_id: "sheets", product_id: "SHEET1", quantity: 2, must_have: ["twin", "sheet"], why: "Cheapest twin set that mentions twin.", substitution_note: "Asked for one set per child; buying two of the same set." });
  assert.equal(r.ok, true); assert.equal(r.live_unit_price, "24.50"); assert.equal(run.lines[0].unitCents, 2450); assert.equal(run.lines[0].lineCents, 4900);
  assert.equal(run.needs[0].status, "substituted"); assert.match(run.lines[0].substitution, /Asked for one set/);
});
test("tools: a need cannot be declined while it has a line; complete_checkout lists open needs", async () => {
  const ctx = await testCtx({ products: catalogue() }); const run = await toolRun(ctx);
  await execTool(ctx, run, "add_to_cart", { need_id: "sheets", product_id: "SHEET1", quantity: 1, must_have: ["twin"], why: "Cheapest twin set found." });
  assert.match((await execTool(ctx, run, "decline_need", { need_id: "sheets", reason: "Changed my mind about it." })).error, /already has a cart line/);
  const c = await execTool(ctx, run, "complete_checkout", { summary: "x" });
  assert.equal(c.ok, false); assert.match(c.error, /charger/);
  await execTool(ctx, run, "decline_need", { need_id: "charger", reason: "Nothing under budget mentions USB-C.", next_step: "Buy locally." });
  assert.equal((await execTool(ctx, run, "complete_checkout", { summary: "One line, one declined." })).ok, true);
});

// ---------------------------------------------------------------- Cart API (merchant side)
const call = async (ctx, method, path, body, token) => handleCartApi(ctx, { method, path, headers: token === null ? {} : { authorization: `Bearer ${token ?? signAgentToken(ctx.agentKey, { run: "rtest1", limit_cents: 10000 })}` }, rawBody: body ? JSON.stringify(body) : "" });
const goodBody = (over = {}) => ({
  items: [{ variant_id: "SHEET1@kohls.com", quantity: 1, price: { currency_code: "USD", value: "24.50" } }], customer: { name: { given_name: "H", surname: "T-1" } },
  shipping_address: { address_line_1: "1 Example Way", admin_area_2: "Pasadena", admin_area_1: "CA", postal_code: "91101", country_code: "US" }, payment_method: { type: "paypal" },
  checkout_fields: [{ type: "TERMS_ACCEPTANCE", status: "COMPLETED", value: { type: "TERMS_ACCEPTANCE", accepted: true } }], ...over,
});

test("cart api: no token, a bad token and a wrong route are refused before any work", async () => {
  const ctx = await testCtx({ products: catalogue() });
  assert.equal((await call(ctx, "POST", "/merchant-cart", goodBody(), null)).status, 401);
  assert.equal((await call(ctx, "POST", "/merchant-cart", goodBody(), "a.b.c")).status, 401);
  assert.equal((await call(ctx, "DELETE", "/merchant-cart/X")).status, 404);
  assert.equal(ctx.fake.paypal.calls.length, 0);
});
test("cart api createCart: a valid cart returns 201, PayPal's order id as the token, and totals from live Channel3 prices", async () => {
  const ctx = await testCtx({ products: catalogue() });
  const r = await call(ctx, "POST", "/merchant-cart", goodBody());
  assert.equal(r.status, 201); assert.equal(r.body.validation_status, "VALID"); assert.equal(r.body.status, "CREATED");
  assert.equal(r.body.payment_method.token, "ORDER1"); assert.equal(r.body.totals.total.value, "24.50");
  assert.equal(r.body._x, undefined, "internals must not leak");
  const o = ctx.fake.paypal.orders.get("ORDER1").body.purchase_units[0];
  assert.equal(o.amount.value, "24.50"); assert.equal(o.items[0].unit_amount.value, "24.50"); assert.match(o.custom_id, /^errand:CART-/);
});
test("cart api: a price that moved is PRICING_ERROR/PRICE_MISMATCH with ACCEPT_NEW_PRICE and no order is made", async () => {
  const ctx = await testCtx({ products: catalogue() });
  const r = await call(ctx, "POST", "/merchant-cart", goodBody({ items: [{ variant_id: "SHEET1@kohls.com", quantity: 1, price: { currency_code: "USD", value: "19.99" } }] }));
  assert.equal(r.status, 200); assert.equal(r.body.validation_status, "INVALID");
  const i = r.body.validation_issues[0];
  assert.equal(i.code, "PRICING_ERROR"); assert.equal(i.context.specific_issue, "PRICE_MISMATCH"); assert.equal(i.context.original_price, "19.99"); assert.equal(i.context.current_price, "24.50"); assert.equal(i.resolution_options[0].action, "ACCEPT_NEW_PRICE");
  assert.equal(ctx.fake.paypal.orders.size, 0);
});
test("cart api: out of stock returns INVENTORY_ISSUE/ITEM_OUT_OF_STOCK with another retailer suggested", async () => {
  const ctx = await testCtx({ products: catalogue() });
  const r = await call(ctx, "POST", "/merchant-cart", goodBody({ items: [{ variant_id: "OOS1@target.com", quantity: 1 }] }));
  const i = r.body.validation_issues[0];
  assert.equal(i.code, "INVENTORY_ISSUE"); assert.equal(i.context.specific_issue, "ITEM_OUT_OF_STOCK"); assert.deepEqual(i.context.suggested_alternatives, ["OOS1@bestbuy.com"]);
});
test("cart api: unknown, veterinary and over-quantity items each get their own typed issue", async () => {
  const ctx = await testCtx({ products: catalogue() });
  const r = await call(ctx, "POST", "/merchant-cart", goodBody({ items: [{ variant_id: "NOPE@x.com", quantity: 1 }, { variant_id: "INH1@tractorsupply.com", quantity: 1 }, { variant_id: "SHEET1@kohls.com", quantity: 50 }] }));
  const specific = r.body.validation_issues.map((i) => i.context.specific_issue);
  assert.deepEqual(specific.sort(), ["INVALID_ITEM_DATA", "ITEM_NOT_FOUND", "MAXIMUM_QUANTITY_EXCEEDED"]);
});
test("cart api: a cart over the token's limit is refused with 422 PURCHASE_LIMIT_EXCEEDED and creates no PayPal order", async () => {
  const ctx = await testCtx({ products: catalogue() });
  const r = await call(ctx, "POST", "/merchant-cart", goodBody({ items: [{ variant_id: "PRICEY@qvc.com", quantity: 1 }] }));
  assert.equal(r.status, 422); assert.equal(r.body.name, "PURCHASE_LIMIT_EXCEEDED");
  assert.equal(r.body.business_context.context.specific_issue, "PURCHASE_LIMIT_EXCEEDED"); assert.equal(r.body.business_context.context.exceeds_by, "800.00");
  assert.equal(ctx.fake.paypal.orders.size, 0);
});
test("cart api: the fund ceiling binds even a token that claims a higher limit", async () => {
  const ctx = await testCtx({ products: [product("BIG", "Twin Sheet Set Gold", [offer("x.com", 1500)], { description: "twin sheet" })] });
  const tok = signAgentToken(ctx.agentKey, { run: "r", limit_cents: 99_999_999 });
  assert.equal((await call(ctx, "POST", "/merchant-cart", goodBody({ items: [{ variant_id: "BIG@x.com", quantity: 1 }] }), tok)).status, 422);
});
test("cart api: food with no allergy information is REQUIRES_ADDITIONAL_INFORMATION; adding it makes the cart valid", async () => {
  const ctx = await testCtx({ products: catalogue() });
  const items = [{ variant_id: "FORM1@walgreens.com", quantity: 2 }];
  const r = await call(ctx, "POST", "/merchant-cart", goodBody({ items }));
  assert.equal(r.body.validation_status, "REQUIRES_ADDITIONAL_INFORMATION"); assert.equal(r.body.status, "INCOMPLETE");
  assert.deepEqual(r.body.validation_issues[0].context.required_fields, ["ALLERGY_INFORMATION"]);
  assert.equal(ctx.fake.paypal.orders.size, 0);
  const fields = [...goodBody().checkout_fields, { type: "ALLERGY_INFORMATION", status: "COMPLETED", value: { type: "ALLERGY_INFORMATION", allergies: ["cow's milk protein"] } }, { type: "DELIVERY_INSTRUCTIONS", status: "COMPLETED", value: { type: "DELIVERY_INSTRUCTIONS", instructions: "Call on arrival" } }];
  const u = await call(ctx, "PUT", `/merchant-cart/${r.body.id}`, goodBody({ items, checkout_fields: fields }));
  assert.equal(u.status, 200); assert.equal(u.body.validation_status, "VALID"); assert.equal(u.body.status, "READY");
  assert.deepEqual(u.body.checkout_fields.map((f) => f.type).sort(), ["ALLERGY_INFORMATION", "DELIVERY_INSTRUCTIONS", "TERMS_ACCEPTANCE"]);
});
test("cart api: PUT replaces the whole cart (omitted fields are dropped) and cannot raise the original limit", async () => {
  const ctx = await testCtx({ products: catalogue() });
  const c = await call(ctx, "POST", "/merchant-cart", goodBody());
  const u = await call(ctx, "PUT", `/merchant-cart/${c.body.id}`, { items: [{ variant_id: "CHG1@target.com", quantity: 1 }] });
  assert.equal(u.body.shipping_address, undefined, "omitted shipping_address is dropped, not merged");
  assert.equal(u.body.validation_status, "REQUIRES_ADDITIONAL_INFORMATION".length ? u.body.validation_status : "");
  assert.ok(u.body.validation_issues.some((i) => i.code === "SHIPPING_ERROR"));
  const high = signAgentToken(ctx.agentKey, { run: "r", limit_cents: 900_000 });
  const raise = await call(ctx, "PUT", `/merchant-cart/${c.body.id}`, goodBody({ items: [{ variant_id: "PRICEY@qvc.com", quantity: 1 }] }), high);
  assert.equal(raise.status, 422, "the original 10,000-cent limit still applies");
});
test("cart api checkout: the vaulted fund account pays; a different payer_id on an unapproved order is refused", async () => {
  const ctx = await testCtx({ products: catalogue() });
  const c = await call(ctx, "POST", "/merchant-cart", goodBody());
  const tok = c.body.payment_method.token;
  const bad = await call(ctx, "POST", `/merchant-cart/${c.body.id}/checkout`, { payment_method: { type: "paypal", token: tok, payer_id: "SOMEONE-ELSE" } });
  assert.equal(bad.status, 422); assert.equal(bad.body.name, "PAYMENT_METHOD_NOT_ACCEPTED"); assert.equal(ctx.fake.paypal.completedCaptures(), 0);
  const wrongTok = await call(ctx, "POST", `/merchant-cart/${c.body.id}/checkout`, { payment_method: { type: "paypal", token: "ORDER99", payer_id: "PAYER-FUND" } });
  assert.equal(wrongTok.status, 422); assert.equal(wrongTok.body.name, "PAYMENT_TOKEN_MISMATCH");
  const ok = await call(ctx, "POST", `/merchant-cart/${c.body.id}/checkout`, { payment_method: { type: "paypal", token: tok, payer_id: "PAYER-FUND" } });
  assert.equal(ok.status, 200); assert.equal(ok.body.status, "COMPLETED"); assert.match(ok.body.payment_confirmation.merchant_order_number, /^ERR-/);
  assert.equal(ok.body.payment_confirmation.paypal_capture_id, "CAPORDER1"); assert.equal(ctx.fake.paypal.completedCaptures(), 1);
});
test("cart api checkout: a REPLAYED checkout purchases once and returns the same confirmation", async () => {
  const ctx = await testCtx({ products: catalogue() });
  const c = await call(ctx, "POST", "/merchant-cart", goodBody());
  const body = { payment_method: { type: "paypal", token: c.body.payment_method.token, payer_id: "PAYER-FUND" } };
  const first = await call(ctx, "POST", `/merchant-cart/${c.body.id}/checkout`, body);
  const second = await call(ctx, "POST", `/merchant-cart/${c.body.id}/checkout`, body);
  const third = await call(ctx, "POST", `/merchant-cart/${c.body.id}/checkout`, body);
  assert.equal(first.status, 200); assert.equal(second.status, 200); assert.equal(third.status, 200);
  assert.deepEqual(second.body.payment_confirmation, first.body.payment_confirmation);
  assert.equal(ctx.fake.paypal.completedCaptures(), 1, "exactly one capture exists at PayPal");
  assert.equal(ctx.fake.paypal.calls.filter((x) => x[0] === "capture").length, 1, "the replays never reached PayPal's capture endpoint");
});
test("cart api checkout: eight CONCURRENT checkouts capture once", async () => {
  const ctx = await testCtx({ products: catalogue() });
  const c = await call(ctx, "POST", "/merchant-cart", goodBody());
  const body = { payment_method: { type: "paypal", token: c.body.payment_method.token, payer_id: "PAYER-FUND" } };
  const rs = await Promise.all(Array.from({ length: 8 }, () => call(ctx, "POST", `/merchant-cart/${c.body.id}/checkout`, body)));
  assert.ok(rs.every((r) => r.status === 200 || r.status === 409), `statuses: ${rs.map((r) => r.status)}`);
  assert.ok(rs.some((r) => r.status === 200));
  assert.equal(ctx.fake.paypal.completedCaptures(), 1);
});
test("cart api checkout: if PayPal already captured (duplicate refusal), that is treated as success", async () => {
  const ctx = await testCtx({ products: catalogue() });
  const c = await call(ctx, "POST", "/merchant-cart", goodBody());
  const o = ctx.fake.paypal.orders.get(c.body.payment_method.token);
  await ctx.fake.paypal.confirmWithVault(o.id, "VAULT1"); await ctx.fake.paypal.capture(o.id, "someone-else");   // captured out of band
  const r = await call(ctx, "POST", `/merchant-cart/${c.body.id}/checkout`, { payment_method: { type: "paypal", token: o.id, payer_id: "PAYER-FUND" } });
  assert.equal(r.status, 200); assert.equal(r.body.status, "COMPLETED"); assert.equal(ctx.fake.paypal.completedCaptures(), 1);
});
test("cart api checkout: a declined payment returns 422 PAYMENT_DECLINED and the cart can be retried", async () => {
  const ctx = await testCtx({ products: catalogue(), failCapture: true });
  const c = await call(ctx, "POST", "/merchant-cart", goodBody());
  const r = await call(ctx, "POST", `/merchant-cart/${c.body.id}/checkout`, { payment_method: { type: "paypal", token: c.body.payment_method.token, payer_id: "PAYER-FUND" } });
  assert.equal(r.status, 422); assert.equal(r.body.name, "PAYMENT_DECLINED");
  assert.equal((await call(ctx, "GET", `/merchant-cart/${c.body.id}`)).body.status, "READY", "unlocked, not stuck in COMPLETING");
});
test("cart api: checkout on an invalid cart is refused and getCart reports completion", async () => {
  const ctx = await testCtx({ products: catalogue() });
  const c = await call(ctx, "POST", "/merchant-cart", goodBody({ items: [{ variant_id: "OOS1@target.com", quantity: 1 }] }));
  const r = await call(ctx, "POST", `/merchant-cart/${c.body.id}/checkout`, { payment_method: { type: "paypal", token: "X", payer_id: "PAYER-FUND" } });
  assert.equal(r.status, 422); assert.equal(r.body.name, "CART_NOT_READY");
  assert.equal((await call(ctx, "GET", "/merchant-cart/NOPE")).status, 404);
});

// ---------------------------------------------------------------- the buying side, end to end with doubles
test("purchase: a held run creates the cart and order but charges nothing; approving it buys once, and approving again buys nothing more", async () => {
  const ctx = await testCtx({ products: catalogue() });
  const run = await toolRun(ctx); run.mode = "hold";
  await execTool(ctx, run, "add_to_cart", { need_id: "sheets", product_id: "SHEET1", quantity: 1, must_have: ["twin"], why: "Cheapest twin set found." });
  await execTool(ctx, run, "add_to_cart", { need_id: "charger", product_id: "CHG1", quantity: 1, must_have: ["usb-c"], why: "Cheapest USB-C charger found." });
  await ctx.saveRun(run);
  await buy(ctx, run);
  assert.equal(run.status, "AWAITING_APPROVAL"); assert.equal(ctx.fake.paypal.completedCaptures(), 0); assert.ok(run.cart.paypalOrderId);
  await buy(ctx, run, { approve: true });
  assert.equal(run.status, "BOUGHT"); assert.equal(run.order.amount, "39.50"); assert.equal(ctx.fake.paypal.completedCaptures(), 1);
  await buy(ctx, run, { approve: true }); await buy(ctx, run);
  assert.equal(ctx.fake.paypal.completedCaptures(), 1, "a replayed approval buys nothing more");
});
test("purchase: food in the cart with no allergy information stops the run in NEEDS_INFO; supplying it completes the purchase", async () => {
  const ctx = await testCtx({ products: catalogue() }); const run = mkRun({ allergies: null });
  run.seen.FORM1 = catalogue()[3];
  await execTool(ctx, run, "record_needs", { needs: [{ id: "formula", label: "Infant formula", quantity: 1 }] });
  await execTool(ctx, run, "add_to_cart", { need_id: "formula", product_id: "FORM1", quantity: 1, must_have: ["formula"], why: "Cheapest formula that says infant formula." });
  await ctx.saveRun(run);
  await buy(ctx, run);
  assert.equal(run.status, "NEEDS_INFO"); assert.equal(ctx.fake.paypal.completedCaptures(), 0);
  run.allergies = "None known"; await buy(ctx, run);
  assert.equal(run.status, "BOUGHT"); assert.equal(ctx.fake.paypal.completedCaptures(), 1);
});
test("purchase: a price that moved between search and checkout is accepted only while inside the limit", async () => {
  const ctx = await testCtx({ products: catalogue() }); const run = await toolRun(ctx);
  await execTool(ctx, run, "add_to_cart", { need_id: "sheets", product_id: "SHEET1", quantity: 1, must_have: ["twin"], why: "Cheapest twin set found." });
  ctx.fake.channel3.products.set("SHEET1", { ...catalogue()[0], offers: [offer("kohls.com", 30)] });
  await ctx.saveRun(run); await buy(ctx, run);
  assert.equal(run.status, "BOUGHT"); assert.equal(run.order.amount, "30.00"); assert.ok(run.events.some((e) => /changed from \$24\.50 to \$30\.00/.test(e.text)));
  const ctx2 = await testCtx({ products: catalogue() }); const run2 = await toolRun(ctx2);
  await execTool(ctx2, run2, "add_to_cart", { need_id: "sheets", product_id: "SHEET1", quantity: 1, must_have: ["twin"], why: "Cheapest twin set found." });
  ctx2.fake.channel3.products.set("SHEET1", { ...catalogue()[0], offers: [offer("kohls.com", 95)] });
  await ctx2.saveRun(run2); await buy(ctx2, run2);
  assert.notEqual(run2.status, "BOUGHT"); assert.equal(ctx2.fake.paypal.completedCaptures(), 0);
});
test("purchase: stock lost at checkout moves the line to another retailer when one has it", async () => {
  const ctx = await testCtx({ products: catalogue() }); const run = await toolRun(ctx);
  const inStock = { ...catalogue()[6], offers: [offer("target.com", 12), offer("bestbuy.com", 14)] };
  run.seen.OOS1 = inStock; ctx.fake.channel3.products.set("OOS1", inStock);
  await execTool(ctx, run, "add_to_cart", { need_id: "charger", product_id: "OOS1", quantity: 1, must_have: ["usb-c"], why: "Cheapest USB-C charger found." });
  assert.equal(run.lines[0].domain, "target.com");
  await execTool(ctx, run, "decline_need", { need_id: "sheets", reason: "Not needed in this test case." });
  ctx.fake.channel3.products.set("OOS1", catalogue()[6]);       // live catalogue now has target.com out of stock
  await ctx.saveRun(run); await buy(ctx, run);
  assert.equal(run.status, "BOUGHT"); assert.equal(run.order.amount, "14.00"); assert.ok(run.events.some((e) => /Moved the line to bestbuy\.com/.test(e.text)));
});
test("purchase: nothing to buy means no cart and no PayPal call", async () => {
  const ctx = await testCtx({ products: catalogue() }); const run = await toolRun(ctx);
  await execTool(ctx, run, "decline_need", { need_id: "sheets", reason: "Nothing matched the wording." }); await execTool(ctx, run, "decline_need", { need_id: "charger", reason: "Nothing matched the wording." });
  await ctx.saveRun(run); await buy(ctx, run);
  assert.equal(run.status, "NOTHING_BOUGHT"); assert.equal(ctx.fake.paypal.calls.filter((c) => c[0] === "createOrder").length, 0);
});

// ---------------------------------------------------------------- the model loop
const scripted = (turns) => { let i = 0; return { converse: async () => { const t = turns[i++]; if (t instanceof Error) throw t; return { output: { message: { role: "assistant", content: t } } }; } }; };
const use = (name, input, id = name + Math.random()) => ({ toolUse: { toolUseId: id, name, input } });

test("agent: a scripted model that tries to overspend is stopped by the server and finishes within budget", async () => {
  const ctx = await testCtx({ products: catalogue() }); const run = mkRun({ capCents: 5000 }); await ctx.saveRun(run);
  ctx.bedrock = scripted([
    [use("record_needs", { needs: [{ id: "sheets", label: "Twin sheet set", quantity: 1 }] })],
    [use("search_products", { need_id: "sheets", query: "twin sheet set", must_have: ["twin"] })],
    [use("add_to_cart", { need_id: "sheets", product_id: "PRICEY", quantity: 1, must_have: ["twin"], why: "The best twin set available." })],
    [use("add_to_cart", { need_id: "sheets", product_id: "SHEET1", quantity: 1, must_have: ["twin"], why: "Cheapest twin set that fits the budget." })],
    [use("complete_checkout", { summary: "Bought one twin sheet set within budget." })],
  ]);
  await runAgent(ctx, run);
  assert.equal(run.lines.length, 1); assert.equal(run.lines[0].productId, "SHEET1"); assert.equal(run.submitted, true);
  assert.ok(run.lines[0].lineCents <= run.spendableCents); assert.equal(run.model.source, "bedrock");
  assert.equal(run.summary, "Bought one twin sheet set within budget.");
});
test("agent: when the model is throttled mid-run, the rules finish it and the run says so", async () => {
  const ctx = await testCtx({ products: catalogue() }); const run = mkRun({ capCents: 20000 }); run.request = "twin sheets and a phone charger with a cable"; await ctx.saveRun(run);
  ctx.bedrock = scripted([[use("record_needs", { needs: [{ id: "sheets", label: "Twin sheet set", quantity: 1 }, { id: "charger", label: "Phone charger and cable", quantity: 1 }] })], Object.assign(new Error("Too many requests"), { name: "ThrottlingException" })]);
  await runAgent(ctx, run);
  assert.equal(run.model.source, "hybrid"); assert.match(run.model.notes[0], /unavailable after 1 turn/);
  assert.ok(run.needs.every((n) => n.status !== "open")); assert.ok(run.summary.length > 0); assert.equal(run.summarySource, "system");
});
test("agent: rule-based mode declines prescription medicine and reports what it could not read", async () => {
  const ctx = await testCtx({ products: catalogue() }); const run = mkRun({ capCents: 20000 }); run.request = "A replacement albuterol inhaler for the father.";
  await rulesFill(ctx, run);
  assert.equal(run.needs[0].status, "declined"); assert.match(run.needs[0].reason, /prescriber or pharmacist/); assert.equal(run.lines.length, 0);
});
test("agent: rule-based mode will not buy baby oil because its name contains 'formula'", async () => {
  const oil = product("OIL1", "Cocoa Butter Formula with Vitamin E Baby Oil", [offer("iherb.com", 8.5)], { description: "Baby oil formula for skin.", category: "Health & Beauty > Skin Care" });
  const ctx = await testCtx({ products: [oil, catalogue()[3]] }); const run = mkRun({ capCents: 20000 }); run.request = "infant formula powder for the baby";
  await rulesFill(ctx, run);
  assert.deepEqual(run.lines.map((l) => l.productId), ["FORM1"]);
});
test("agent: a model that never calls complete_checkout still ends with every need closed explicitly", async () => {
  const ctx = await testCtx({ products: catalogue() }); const run = mkRun(); await ctx.saveRun(run);
  ctx.bedrock = scripted([[use("record_needs", { needs: [{ id: "a", label: "Thing A", quantity: 1 }] })], [{ text: "Done." }], [{ text: "Done." }]]);
  await runAgent(ctx, run);
  assert.equal(run.needs[0].status, "declined"); assert.match(run.needs[0].reason, /ran out of turns|without finding/);
});

// ---------------------------------------------------------------- HTTP surface: validation, state transitions, webhook
const ev = (ctx, method, path, body, headers = {}) => handle(ctx, { requestContext: { http: { method } }, rawPath: path, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const goodRun = { request: "Twin sheets for two children and a phone charger.", capCents: 20000, reference: "T-77", mode: "buy", delivery, authorised: true, allergies: "None known" };
test("http: the new-request form is validated server-side", async () => {
  const ctx = await testCtx({ products: catalogue() });
  for (const [patch, re] of [[{ authorised: false }, /authorised/], [{ capCents: 50 }, /budget must be/], [{ capCents: 99_999_999 }, /budget must be/], [{ reference: "Jane Q. Public!" }, /reference/], [{ request: "short" }, /12 to 1,500/], [{ delivery: { line1: "x", city: "y", state: "California", postal: "9" } }, /delivery address/]]) {
    const r = await ev(ctx, "POST", "/api/runs", { ...goodRun, ...patch });
    assert.equal(r.statusCode, 400, JSON.stringify(patch)); assert.match(JSON.parse(r.body).error, re);
  }
  assert.equal((await ev(ctx, "POST", "/api/runs", "{not json")).statusCode, 400);
  const ok = await ev(ctx, "POST", "/api/runs", goodRun); assert.equal(ok.statusCode, 202);
});
test("http: approve, info and cancel only work in the right state, and approve is accepted once", async () => {
  const ctx = await testCtx({ products: catalogue() }); const queue = []; ctx.enqueue = async (j) => queue.push(j);
  const mk = async (status, extra = {}) => { const run = mkRun(); run.id = `r${status.toLowerCase()}${Math.random().toString(36).slice(2, 5)}`; run.status = status; Object.assign(run, extra); await ctx.saveRun(run); return run.id; };
  const held = await mk("AWAITING_APPROVAL"), working = await mk("WORKING"), needs = await mk("NEEDS_INFO", { allergies: null });
  assert.equal((await ev(ctx, "POST", `/api/runs/${working}/approve`)).statusCode, 409);
  assert.equal((await ev(ctx, "POST", `/api/runs/${held}/approve`)).statusCode, 202);
  assert.equal((await ev(ctx, "POST", `/api/runs/${held}/approve`)).statusCode, 409, "second approval refused");
  assert.equal(queue.filter((j) => j.kind === "approve").length, 1);
  assert.equal((await ev(ctx, "POST", `/api/runs/${needs}/info`, { allergies: "" })).statusCode, 400);
  assert.equal((await ev(ctx, "POST", `/api/runs/${needs}/info`, { allergies: "Peanuts" })).statusCode, 202);
  assert.equal((await ev(ctx, "POST", `/api/runs/${working}/cancel`)).statusCode, 409);
  const held2 = await mk("AWAITING_APPROVAL");
  assert.equal((await ev(ctx, "POST", `/api/runs/${held2}/cancel`)).statusCode, 200);
  assert.equal(JSON.parse((await ev(ctx, "GET", `/api/runs/${held2}`)).body).status, "CANCELLED");
  assert.equal((await ev(ctx, "GET", "/api/runs/nope")).statusCode, 404);
});
test("http: the run list is small rows, newest first; the full run hides the product cache", async () => {
  const ctx = await testCtx({ products: catalogue() });
  const a = mkRun(); a.id = "ra"; await ctx.saveRun(a); await new Promise((r) => setTimeout(r, 5)); const b = mkRun(); b.id = "rb"; await ctx.saveRun(b);
  const list = JSON.parse((await ev(ctx, "GET", "/api/runs")).body).runs;
  assert.deepEqual(list.map((r) => r.id), ["rb", "ra"]); assert.equal(list[0].seen, undefined);
  assert.equal(JSON.parse((await ev(ctx, "GET", "/api/runs/ra")).body).seen, undefined);
});
test("webhook: the listener answers 200 at once and stores the raw body; verification happens afterwards", async () => {
  const ctx = await testCtx({ products: catalogue() }); const jobs = []; ctx.enqueue = async (j) => jobs.push(j); ctx.env.WEBHOOK_ID = "WH1";
  const hdr = { "paypal-transmission-id": "T1", "paypal-transmission-sig": "S", "paypal-cert-url": "https://api.paypal.com/c", "paypal-auth-algo": "SHA256withRSA", "paypal-transmission-time": "2026-10-02T00:00:00Z" };
  const body = JSON.stringify({ id: "WH-EVT-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { custom_id: "errand:CART-1", supplementary_data: { related_ids: { order_id: "ORDER1" } } } });
  const r = await ev(ctx, "POST", "/api/webhooks/paypal", body, hdr);
  assert.equal(r.statusCode, 200); assert.equal(ctx.fake.paypal.calls.filter((c) => c[0] === "verifyWebhook").length, 0, "nothing verified before the 200");
  assert.deepEqual(jobs[0], { kind: "webhook", key: "evt#T1" });
  assert.equal(JSON.parse((await ev(ctx, "POST", "/api/webhooks/paypal", body, hdr)).body).duplicate, true, "a redelivery is acknowledged and not re-queued");
  await runJob(ctx, jobs[0]);
  const rec = await ctx.store.get("evt#T1"); assert.equal(rec.state, "confirmed"); assert.equal(rec.orderId, "ORDER1");
  assert.deepEqual((await ctx.store.get("hook#ORDER1")).types, ["PAYMENT.CAPTURE.COMPLETED"]);
});
test("webhook: a TAMPERED payload fails verification and is rejected; another app's event is ignored", async () => {
  const ctx = await testCtx({ products: catalogue() }); const jobs = []; ctx.enqueue = async (j) => jobs.push(j); ctx.env.WEBHOOK_ID = "WH1";
  const h = (id) => ({ "paypal-transmission-id": id, "paypal-transmission-sig": "S", "paypal-cert-url": "c", "paypal-auth-algo": "a", "paypal-transmission-time": "t" });
  const tampered = JSON.stringify({ id: "E2", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { custom_id: "errand:CART-1", amount: { value: "TAMPERED" }, supplementary_data: { related_ids: { order_id: "ORDER1" } } } });
  assert.equal((await ev(ctx, "POST", "/api/webhooks/paypal", tampered, h("T2"))).statusCode, 200);
  const other = JSON.stringify({ id: "E3", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { custom_id: "holdfast:xyz", supplementary_data: { related_ids: { order_id: "OTHER" } } } });
  assert.equal((await ev(ctx, "POST", "/api/webhooks/paypal", other, h("T3"))).statusCode, 200);
  assert.equal((await ev(ctx, "POST", "/api/webhooks/paypal", "garbage{", h("T4"))).statusCode, 200);
  for (const j of jobs) await runJob(ctx, j);
  assert.equal((await ctx.store.get("evt#T2")).state, "rejected"); assert.equal(await ctx.store.get("hook#ORDER1"), null, "a rejected event changes nothing");
  assert.equal((await ctx.store.get("evt#T3")).state, "ignored");
  assert.equal((await ctx.store.get("evt#T4")).state, "rejected");
});
