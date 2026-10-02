// End-to-end against the DEPLOYED stack: real Lambda, real DynamoDB, real Channel3 MCP, real Bedrock, real PayPal sandbox.
// Usage: node --dns-result-order=ipv4first tests/e2e.deployed.mjs [--skip-agent]
// Reads the API URL, the agent's signing key and the vault token from .deploy-state/ and PayPal credentials from ../../.env.
import { readFileSync } from "node:fs";
import { generateKeyPairSync, createSign } from "node:crypto";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { createPayPal, cfg } from "../backend/paypal.mjs";
import { createChannel3 } from "../backend/channel3.mjs";
import { agentKey, signAgentToken } from "../backend/jwt.mjs";
import { bestOffer } from "../backend/policy.mjs";
import { DEFAULT_DELIVERY, SCENARIOS } from "../backend/scenarios.mjs";
import { check as schemaCheck, checkCheckout } from "./schema.mjs";

for (const l of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) process.env[m[1]] = m[2]; }
const st = (f) => readFileSync(new URL(`../.deploy-state/${f}`, import.meta.url), "utf8").trim();
const API = st("api-url").replace(/\/$/, "");
const key = agentKey(st("agent-key.b64"));
const pp = createPayPal(cfg());
const ddb = new DynamoDBClient({ region: "us-east-1" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (x) => Buffer.from(x).toString("base64url");

let pass = 0, fail = 0;
async function check(name, fn) {
  try { const note = await fn(); pass++; console.log(`PASS  ${name}${note ? "\n        " + note : ""}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n        ${String(e.message).split("\n")[0]}`); }
}
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || "expected equal"}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || "assertion failed"); };
const http = async (method, path, body, token) => {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 200) }; }
  return { status: r.status, body: j };
};
const tok = (claims, o) => signAgentToken(key, claims, o);
const vault = st("vault-token-id");
const payerId = (await pp.getPaymentToken(vault)).payment_source.paypal.payer_id;
const captures = async (orderId) => ((await pp.getOrder(orderId)).purchase_units[0].payments?.captures || []);

console.log(`API ${API}\nfund payer ${payerId}\n`);

// ------------------------------------------------------------------ the product source
const c3 = createChannel3();
let cheap;
await check("Channel3 MCP: search_products returns normalised products with prices and real alt text", async () => {
  const ps = await c3.search("USB-C wall charger with cable");
  ok(ps.length >= 3, `only ${ps.length} results`);
  ok(ps.every((p) => p.offers.length && Number.isInteger(p.offers[0].priceCents)), "offers without integer cents");
  ok(ps.some((p) => p.images.some((i) => i.alt.length > 15)), "no descriptive alt text");
  cheap = ps.filter((p) => bestOffer(p)).sort((a, b) => bestOffer(a).priceCents - bestOffer(b).priceCents)[0];
  ok(cheap, "nothing buyable");
  const live = (await c3.details([cheap.id]))[0];
  eq(live.id, cheap.id, "get_products id");
  return `thread ${c3.threadId}; cheapest ${cheap.id} ${cheap.title.slice(0, 50)} $${(bestOffer(live).priceCents / 100).toFixed(2)} at ${bestOffer(live).domain}`;
});
const variant = `${cheap.id}@${bestOffer(cheap).domain}`;
const body = (over = {}) => ({
  items: [{ variant_id: variant, quantity: 1 }], customer: { name: { given_name: "Household", surname: "E2E" } },
  shipping_address: { address_line_1: DEFAULT_DELIVERY.line1, admin_area_2: DEFAULT_DELIVERY.city, admin_area_1: DEFAULT_DELIVERY.state, postal_code: DEFAULT_DELIVERY.postal, country_code: "US" },
  payment_method: { type: "paypal" }, checkout_fields: [{ type: "TERMS_ACCEPTANCE", status: "COMPLETED", value: { type: "TERMS_ACCEPTANCE", accepted: true, terms_version: "errand-fund-policy-2026-10" } }], ...over,
});

// ------------------------------------------------------------------ the inbound Cart API contract, over HTTP
console.log("\n-- Cart API: authentication (PayPalJWT)");
await check("no Authorization header -> 401", async () => eq((await http("POST", "/merchant-cart", body())).status, 401));
await check("garbage bearer -> 401", async () => eq((await http("POST", "/merchant-cart", body(), "not.a.jwt")).status, 401));
await check("a JWT claiming PayPal's real key id but signed by a stranger's key -> 401 bad_signature", async () => {
  const keys = (await (await fetch("https://www.paypal.ai/.well-known/jwks.json")).json()).keys;
  const kid = keys[0].kid;
  const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid })), pay = b64u(JSON.stringify({ merchant_id: "49CDGTCKZ2V8A", scope: ["cart"], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 }));
  const jwt = `${head}.${pay}.${b64u(createSign("RSA-SHA256").update(`${head}.${pay}`).sign(stranger.privateKey))}`;
  const r = await http("POST", "/merchant-cart", body(), jwt);
  eq(r.status, 401); ok(/bad_signature/.test(r.body.message), r.body.message);
  return `PayPal kid ${kid}: ${r.body.message}`;
});
await check("a genuine agent token with its payload edited (limit raised) -> 401", async () => {
  const [h, p, s] = tok({ run: "e2e", limit_cents: 500 }).split(".");
  const forged = { ...JSON.parse(Buffer.from(p, "base64url")), limit_cents: 99_000_000 };
  const r = await http("POST", "/merchant-cart", body(), `${h}.${b64u(JSON.stringify(forged))}.${s}`);
  eq(r.status, 401); return r.body.message;
});
await check("an expired agent token -> 401", async () => { const r = await http("POST", "/merchant-cart", body(), tok({ run: "e2e" }, { now: Date.now() - 7200_000, ttlSec: 60 })); eq(r.status, 401); return r.body.message; });
await check("alg=none token -> 401", async () => {
  const jwt = `${b64u(JSON.stringify({ alg: "none", typ: "JWT", kid: key.kid }))}.${b64u(JSON.stringify({ iss: "errand-agent", aud: "errand-cart-api", exp: Math.floor(Date.now() / 1000) + 600 }))}.`;
  eq((await http("POST", "/merchant-cart", body(), jwt)).status, 401);
});

console.log("\n-- Cart API: createCart, getCart, updateCart (limits), completeCheckout (idempotency)");
let cart, order;
await check("createCart with a valid token -> 201, live Channel3 price, PayPal order id as payment_method.token", async () => {
  const r = await http("POST", "/merchant-cart", body(), tok({ run: "e2e-1", limit_cents: 60_000 }));
  eq(r.status, 201, JSON.stringify(r.body).slice(0, 300)); eq(r.body.validation_status, "VALID");
  cart = r.body; order = cart.payment_method.token; ok(order, "no order token");
  schemaCheck("PayPalCart", r.body);
  const po = await pp.getOrder(order);
  eq(po.status, "CREATED", "PayPal order status"); eq(po.purchase_units[0].custom_id, `errand:${cart.id}`);
  return `${cart.id} total $${cart.totals.total.value}, PayPal order ${order} (${po.status})`;
});
await check("getCart returns the same cart", async () => { const r = await http("GET", `/merchant-cart/${cart.id}`, null, tok({ run: "e2e-1", limit_cents: 60_000 })); eq(r.status, 200); eq(r.body.id, cart.id); });
await check("getCart for an unknown id -> 404", async () => eq((await http("GET", "/merchant-cart/CART-NOPE", null, tok({ run: "x" }))).status, 404));
await check("updateCart over the ORIGINAL limit is refused 422 even with a token claiming a bigger limit", async () => {
  const small = await http("POST", "/merchant-cart", body(), tok({ run: "e2e-2", limit_cents: bestOffer(cheap).priceCents + 500 }));
  eq(small.status, 201, JSON.stringify(small.body).slice(0, 200));
  const raise = await http("PUT", `/merchant-cart/${small.body.id}`, body({ items: [{ variant_id: variant, quantity: 12 }] }), tok({ run: "e2e-2", limit_cents: 90_000 }));
  eq(raise.status, 422); eq(raise.body.name, "PURCHASE_LIMIT_EXCEEDED"); schemaCheck("BusinessError", raise.body);
  return `exceeds_by ${raise.body.business_context.context.exceeds_by}`;
});
await check("updateCart replaces the cart: omitting shipping_address drops it and reports SHIPPING_ERROR", async () => {
  const r = await http("PUT", `/merchant-cart/${cart.id}`, { items: [{ variant_id: variant, quantity: 1 }] }, tok({ run: "e2e-1", limit_cents: 60_000 }));
  eq(r.status, 200); schemaCheck("PayPalCart", r.body); ok(r.body.validation_issues.some((i) => i.code === "SHIPPING_ERROR"), "no SHIPPING_ERROR"); eq(r.body.shipping_address, undefined);
  const back = await http("PUT", `/merchant-cart/${cart.id}`, body(), tok({ run: "e2e-1", limit_cents: 60_000 }));
  eq(back.body.validation_status, "VALID"); eq(back.body.payment_method.token, order, "same content keeps the same PayPal order");
});
await check("checkout by a payer who is not the vaulted fund account -> 422, nothing captured", async () => {
  const r = await http("POST", `/merchant-cart/${cart.id}/checkout`, { payment_method: { type: "paypal", token: order, payer_id: "NOTTHEFUND" } }, tok({ run: "e2e-1", limit_cents: 60_000 }));
  eq(r.status, 422); eq(r.body.name, "PAYMENT_METHOD_NOT_ACCEPTED"); eq((await captures(order)).length, 0);
});
let confirmation;
await check("checkout -> 200 COMPLETED with payment_confirmation; PayPal shows exactly one capture", async () => {
  const r = await http("POST", `/merchant-cart/${cart.id}/checkout`, { payment_method: { type: "paypal", token: order, payer_id: payerId } }, tok({ run: "e2e-1", limit_cents: 60_000 }));
  eq(r.status, 200, JSON.stringify(r.body).slice(0, 300)); eq(r.body.status, "COMPLETED"); confirmation = r.body.payment_confirmation; checkCheckout(r.body);
  const caps = await captures(order); eq(caps.length, 1, "captures at PayPal");
  return `${confirmation.merchant_order_number}, capture ${caps[0].id}, $${caps[0].amount.value}`;
});
await check("REPLAYED checkout x4 (sequential) returns the identical confirmation and PayPal still shows ONE capture", async () => {
  for (let i = 0; i < 4; i++) {
    const r = await http("POST", `/merchant-cart/${cart.id}/checkout`, { payment_method: { type: "paypal", token: order, payer_id: payerId } }, tok({ run: "e2e-1", limit_cents: 60_000 }));
    eq(r.status, 200); eq(JSON.stringify(r.body.payment_confirmation), JSON.stringify(confirmation), "confirmation changed");
  }
  eq((await captures(order)).length, 1, "captures at PayPal after replays");
});
await check("SIX CONCURRENT checkouts on a fresh cart produce one capture", async () => {
  const c2 = await http("POST", "/merchant-cart", body(), tok({ run: "e2e-3", limit_cents: 60_000 })); eq(c2.status, 201);
  const o2 = c2.body.payment_method.token;
  const rs = await Promise.all(Array.from({ length: 6 }, () => http("POST", `/merchant-cart/${c2.body.id}/checkout`, { payment_method: { type: "paypal", token: o2, payer_id: payerId } }, tok({ run: "e2e-3", limit_cents: 60_000 }))));
  ok(rs.every((r) => r.status === 200 || r.status === 409), rs.map((r) => r.status).join(","));
  ok(rs.some((r) => r.status === 200), "none completed");
  eq((await captures(o2)).length, 1, "captures at PayPal");
  return `statuses ${rs.map((r) => r.status).join(",")}; captures 1`;
});

console.log("\n-- Webhook listener");
let evtKey = null;
await check("PayPal's real PAYMENT.CAPTURE.COMPLETED for this purchase arrives, verifies and is attributed to this app", async () => {
  let rec = null;
  for (let i = 0; i < 24 && !rec; i++) {
    const r = await http("GET", "/api/webhooks/recent");
    rec = r.body.events.find((e) => e.orderId === order && e.state === "confirmed");
    if (!rec) await sleep(5000);
  }
  let natural = true;
  if (!rec) {   // delivery can lag in the sandbox; ask PayPal to resend so the verify path is still exercised, and say so
    natural = false;
    const evs = await pp.call("GET", "/v1/notifications/webhooks-events?page_size=20&event_type=PAYMENT.CAPTURE.COMPLETED");
    const mine = evs.events.find((e) => e.resource?.supplementary_data?.related_ids?.order_id === order);
    ok(mine, "PayPal has no event for the order");
    await pp.call("POST", `/v1/notifications/webhooks-events/${mine.id}/resend`, { webhook_ids: [st("webhook-id")] });
    for (let i = 0; i < 12 && !rec; i++) { await sleep(4000); rec = (await http("GET", "/api/webhooks/recent")).body.events.find((e) => e.orderId === order && e.state === "confirmed"); }
  }
  ok(rec, "never confirmed"); return `${rec.eventType} confirmed for order ${order}; first delivery ${natural ? "arrived on its own" : "needed a PayPal resend"}`;
});
await check("a TAMPERED copy of that event (amount edited, headers untouched) is answered 200 and then REJECTED", async () => {
  const list = (await http("GET", "/api/webhooks/recent")).body.events; ok(list.length, "no events");
  // find the stored raw event for our order straight from DynamoDB (the API never exposes raw bodies)
  const { ScanCommand } = await import("@aws-sdk/client-dynamodb");
  const scan = await ddb.send(new ScanCommand({ TableName: "errand", FilterExpression: "kind = :k", ExpressionAttributeValues: { ":k": { S: "evt" } } }));
  const mine = scan.Items.map((i) => ({ pk: i.pk.S, d: JSON.parse(i.d.S) })).find((x) => x.d.orderId === order && x.d.state === "confirmed");
  ok(mine, "stored event not found");
  const ev = JSON.parse(mine.d.raw); ev.resource.amount.value = "0.01"; ev.summary = "TAMPERED";
  const hdr = { ...mine.d.headers, "paypal-transmission-id": `tamper-${Date.now()}` };
  const t0 = Date.now();
  const r = await fetch(API + "/api/webhooks/paypal", { method: "POST", headers: { "content-type": "application/json", ...hdr }, body: JSON.stringify(ev) });
  const ms = Date.now() - t0;
  eq(r.status, 200, "listener status"); ok(ms < 3000, `listener took ${ms} ms`);
  let rec = null;
  for (let i = 0; i < 15 && !rec; i++) { await sleep(2000); const tid = hdr["paypal-transmission-id"]; const out = await ddb.send(new GetItemCommand({ TableName: "errand", Key: { pk: { S: `evt#${tid}` } } })); const d = out.Item && JSON.parse(out.Item.d.S); if (d && d.state !== "received") rec = d; }
  ok(rec, "never processed"); eq(rec.state, "rejected"); evtKey = rec;
  return `HTTP 200 in ${ms} ms, then state=${rec.state} reason="${rec.reason}"`;
});
await check("a forged event with no PayPal signature headers at all is answered 200 and rejected", async () => {
  const id = `forged-${Date.now()}`;
  const r = await fetch(API + "/api/webhooks/paypal", { method: "POST", headers: { "content-type": "application/json", "paypal-transmission-id": id }, body: JSON.stringify({ id: "WH-FAKE", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { custom_id: "errand:CART-FAKE", supplementary_data: { related_ids: { order_id: "FAKEORDER" } } } }) });
  eq(r.status, 200); let d = null;
  for (let i = 0; i < 15 && !d; i++) { await sleep(2000); const out = await ddb.send(new GetItemCommand({ TableName: "errand", Key: { pk: { S: `evt#${id}` } } })); const x = out.Item && JSON.parse(out.Item.d.S); if (x && x.state !== "received") d = x; }
  ok(d, "never processed"); eq(d.state, "rejected"); return d.reason;
});

// ------------------------------------------------------------------ the agent, end to end
const poll = async (id, until, max = 300) => {
  const t0 = Date.now(); let run;
  while (Date.now() - t0 < max * 1000) { run = (await http("GET", `/api/runs/${id}`)).body; if (until.includes(run.status)) return run; await sleep(4000); }
  throw new Error(`run ${id} stuck in ${run?.status}`);
};
const submit = async (sc, over = {}) => {
  const r = await http("POST", "/api/runs", { request: sc.request, capCents: sc.capCents, reference: sc.reference, mode: sc.mode, delivery: DEFAULT_DELIVERY, authorised: true, allergies: sc.allergies, ...over });
  eq(r.status, 202, JSON.stringify(r.body)); return r.body.id;
};
if (!process.argv.includes("--skip-agent")) {
  console.log("\n-- The agent (Bedrock tool use, Channel3 MCP, Cart API, PayPal)");
  let famRun;
  await check("family of four: buys what it can inside the budget, refuses the inhaler, and every purchase matches PayPal", async () => {
    const id = await submit(SCENARIOS[0]); famRun = await poll(id, ["BOUGHT", "NOTHING_BOUGHT", "FAILED", "AWAITING_APPROVAL", "NEEDS_INFO"], 420);
    eq(famRun.status, "BOUGHT", famRun.failure || ""); ok(famRun.lines.length >= 2, "fewer than two lines");
    ok(famRun.committedCents <= famRun.spendableCents, `committed ${famRun.committedCents} > spendable ${famRun.spendableCents}`);
    const inhaler = famRun.needs.find((n) => /inhaler|albuterol/i.test(n.label)); ok(inhaler && inhaler.status === "declined", "inhaler not declined");
    const sum = famRun.lines.reduce((s, l) => s + l.lineCents, 0);
    const caps = await captures(famRun.order.paypalOrderId); eq(caps.length, 1, "captures at PayPal"); eq(Math.round(Number(caps[0].amount.value) * 100), sum, "PayPal capture equals the cart lines");
    const po = await pp.getOrder(famRun.order.paypalOrderId); eq(po.purchase_units[0].custom_id, `errand:${famRun.order.cartId}`);
    return `model ${famRun.model.source}/${famRun.model.turns} turns; ${famRun.lines.length} lines $${(sum / 100).toFixed(2)} of $${(famRun.spendableCents / 100).toFixed(2)}; declined: ${famRun.needs.filter((n) => n.status === "declined").map((n) => n.label).join(" | ")}`;
  });
  await check("the same purchase, replayed through the Cart API after the run, buys nothing more", async () => {
    const r = await http("POST", `/merchant-cart/${famRun.order.cartId}/checkout`, { payment_method: { type: "paypal", token: famRun.order.paypalOrderId, payer_id: payerId } }, tok({ run: famRun.id, limit_cents: famRun.spendableCents }));
    eq(r.status, 200); eq(r.body.payment_confirmation.paypal_capture_id, famRun.order.captureId);
    eq((await captures(famRun.order.paypalOrderId)).length, 1, "captures at PayPal");
  });
  await check("the run's order shows PayPal's webhook confirmation", async () => {
    let run; for (let i = 0; i < 20; i++) { run = (await http("GET", `/api/runs/${famRun.id}`)).body; if (run.order.webhook === "confirmed") break; await sleep(4000); }
    if (run.order.webhook !== "confirmed") { const evs = await pp.call("GET", "/v1/notifications/webhooks-events?page_size=20&event_type=PAYMENT.CAPTURE.COMPLETED"); const mine = evs.events.find((e) => e.resource?.supplementary_data?.related_ids?.order_id === run.order.paypalOrderId); if (mine) await pp.call("POST", `/v1/notifications/webhooks-events/${mine.id}/resend`, { webhook_ids: [st("webhook-id")] }); for (let i = 0; i < 12; i++) { await sleep(4000); run = (await http("GET", `/api/runs/${famRun.id}`)).body; if (run.order.webhook === "confirmed") break; } }
    eq(run.order.webhook, "confirmed"); return `events ${run.order.webhookEvents}`;
  });
  let holdId;
  await check("hold flow: food in the cart + no allergy information stops in NEEDS_INFO with no charge", async () => {
    holdId = await submit(SCENARIOS[2], { reference: "E2E-HOLD" });
    const run = await poll(holdId, ["NEEDS_INFO", "AWAITING_APPROVAL", "FAILED", "BOUGHT", "NOTHING_BOUGHT"], 420);
    eq(run.status, "NEEDS_INFO", run.failure || run.status); eq(run.order, null);
    const bad = await http("POST", `/api/runs/${holdId}/info`, { allergies: "" }); eq(bad.status, 400);
    return run.cart?.issues?.[0];
  });
  await check("supplying the allergy information moves it to AWAITING_APPROVAL (mode=hold): cart and PayPal order exist, nothing is captured", async () => {
    eq((await http("POST", `/api/runs/${holdId}/info`, { allergies: "None known" })).status, 202);
    const run = await poll(holdId, ["AWAITING_APPROVAL", "FAILED", "BOUGHT"], 120);
    eq(run.status, "AWAITING_APPROVAL", run.failure || ""); ok(run.cart?.paypalOrderId, "no order");
    eq((await captures(run.cart.paypalOrderId)).length, 0, "captures before approval");
    return `order ${run.cart.paypalOrderId} created, 0 captures`;
  });
  await check("approve -> BOUGHT; a second approve is refused 409; PayPal shows one capture", async () => {
    eq((await http("POST", `/api/runs/${holdId}/approve`)).status, 202);
    eq((await http("POST", `/api/runs/${holdId}/approve`)).status, 409);
    const run = await poll(holdId, ["BOUGHT", "FAILED"], 120); eq(run.status, "BOUGHT", run.failure || "");
    eq((await captures(run.order.paypalOrderId)).length, 1, "captures at PayPal"); return `capture ${run.order.captureId} $${run.order.amount}`;
  });
  await check("a request nobody can fulfil (insulin, inhaler) ends NOTHING_BOUGHT with no cart and no PayPal order", async () => {
    const id = await submit(SCENARIOS[1], { request: "A man needs his insulin pens and a replacement rescue inhaler after the fire destroyed his home.", reference: "E2E-NONE" });
    const run = await poll(id, ["NOTHING_BOUGHT", "BOUGHT", "FAILED", "AWAITING_APPROVAL"], 300);
    eq(run.status, "NOTHING_BOUGHT", `${run.status} ${run.failure || ""}`); eq(run.cart, null); eq(run.lines.length, 0);
    return run.needs.map((n) => `${n.label}: ${n.reason.slice(0, 70)}`).join(" | ");
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
