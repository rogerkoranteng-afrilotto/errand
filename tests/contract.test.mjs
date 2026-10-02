// Validates what the merchant side RETURNS (and what the buying side SENDS) against PayPal's published OpenAPI schema,
// saved from developer.paypal.com/api/agentic-commerce/v1/schema.json on 2 Oct 2026 (sha256 in docs/evidence).
// Run: node --test tests/contract.test.mjs        Add LIVE_SCHEMA=1 to also check the saved copy still matches PayPal's.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { handleCartApi } from "../backend/cartapi.mjs";
import { signAgentToken } from "../backend/jwt.mjs";
import { testCtx, product, offer } from "./helpers.mjs";

const raw = readFileSync(new URL("../docs/evidence/agentic-commerce-v1-schema.json", import.meta.url), "utf8");
const doc = JSON.parse(raw);
// The published document mixes OpenAPI 3.0 `nullable` into a 3.1 file. Fold it into JSON Schema form so a validator can run.
(function fold(n) { if (Array.isArray(n)) return n.forEach(fold); if (n && typeof n === "object") { if ("nullable" in n) { if (n.nullable && typeof n.type === "string") n.type = [n.type, "null"]; delete n.nullable; } Object.values(n).forEach(fold); } })(doc);
const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv); ajv.addSchema(doc, "ac");
const schema = (name) => ajv.getSchema(`ac#/components/schemas/${name}`);
const validate = (name, value) => { const v = schema(name); const okk = v(value); assert.ok(okk, `${name}: ${JSON.stringify(v.errors?.slice(0, 4))}\n${JSON.stringify(value).slice(0, 400)}`); };
const respSchema = (method, path, status) => doc.paths[path][method].responses[status]?.content?.["application/json"]?.schema;
const validateInline = (s, value) => { const v = ajv.compile({ ...s, components: doc.components }); const r = v(value); assert.ok(r, JSON.stringify(v.errors?.slice(0, 4))); };

const cat = [product("A1", "Twin Sheet Set", [offer("kohls.com", 24.5)], { description: "twin sheet set" }), product("F1", "Infant Formula Powder", [offer("cvs.com", 25)], { category: "Food > Formula", description: "infant formula" }), product("B1", "Twin Sheet Deluxe", [offer("qvc.com", 900)], { description: "twin sheet" })];
const addr = { address_line_1: "1 Example Way", admin_area_2: "Pasadena", admin_area_1: "CA", postal_code: "91101", country_code: "US" };
const terms = { type: "TERMS_ACCEPTANCE", status: "COMPLETED", value: { type: "TERMS_ACCEPTANCE", accepted: true, terms_version: "v1" } };
const mk = (items, extra = {}) => ({ items, customer: { name: { given_name: "H", surname: "T" } }, shipping_address: addr, payment_method: { type: "paypal" }, checkout_fields: [terms], ...extra });

test("the saved schema is the one PayPal publishes (set LIVE_SCHEMA=1 to compare)", async (t) => {
  console.log(`      saved copy sha256 ${createHash("sha256").update(raw).digest("hex").slice(0, 16)}..., ${Object.keys(doc.paths).length} paths, ${Object.keys(doc.components.schemas).length} schemas`);
  if (!process.env.LIVE_SCHEMA) return t.skip("LIVE_SCHEMA not set");
  const live = await (await fetch("https://developer.paypal.com/api/agentic-commerce/v1/schema.json")).text();
  assert.equal(createHash("sha256").update(live).digest("hex"), createHash("sha256").update(raw).digest("hex"));
});

test("every response the merchant side produces validates against PayPal's schema", async () => {
  const ctx = await testCtx({ products: cat });
  const call = (method, path, body, limit = 20000) => handleCartApi(ctx, { method, path, headers: { authorization: `Bearer ${signAgentToken(ctx.agentKey, { run: "c", limit_cents: limit })}` }, rawBody: body ? JSON.stringify(body) : "" });
  const seen = [];
  const note = (label, r, check) => { check(r.body); seen.push(`${label} -> ${r.status}`); };

  // requests we send are valid PayPalCart documents
  for (const req of [mk([{ variant_id: "A1@kohls.com", quantity: 1, price: { currency_code: "USD", value: "24.50" } }]), mk([{ variant_id: "F1@cvs.com", quantity: 2 }])]) validate("PayPalCart", req);

  const created = await call("POST", "/merchant-cart", mk([{ variant_id: "A1@kohls.com", quantity: 1, price: { currency_code: "USD", value: "24.50" } }]));
  note("createCart valid", created, (b) => { validate("PayPalCart", b); assert.equal(b.validation_status, "VALID"); });
  assert.equal(created.status, 201); validateInline(respSchema("post", "/merchant-cart", "201"), created.body);

  note("createCart price moved", await call("POST", "/merchant-cart", mk([{ variant_id: "A1@kohls.com", quantity: 1, price: { currency_code: "USD", value: "10.00" } }])), (b) => { validate("PayPalCart", b); assert.equal(b.validation_issues[0].context.specific_issue, "PRICE_MISMATCH"); });
  note("createCart food without allergy info", await call("POST", "/merchant-cart", mk([{ variant_id: "F1@cvs.com", quantity: 1 }])), (b) => { validate("PayPalCart", b); assert.equal(b.validation_status, "REQUIRES_ADDITIONAL_INFORMATION"); });
  note("createCart unknown + restricted + oversize", await call("POST", "/merchant-cart", mk([{ variant_id: "ZZZ@x.com", quantity: 1 }, { variant_id: "A1@kohls.com", quantity: 99 }])), (b) => { validate("PayPalCart", b); assert.equal(b.validation_issues.length, 2); });
  note("createCart no address", await call("POST", "/merchant-cart", mk([{ variant_id: "A1@kohls.com", quantity: 1 }], { shipping_address: undefined })), (b) => validate("PayPalCart", b));
  const over = await call("POST", "/merchant-cart", mk([{ variant_id: "B1@qvc.com", quantity: 1 }]));
  assert.equal(over.status, 422); note("createCart over limit", over, (b) => validate("BusinessError", b)); validateInline(respSchema("post", "/merchant-cart", "422"), over.body);
  note("createCart empty items", await call("POST", "/merchant-cart", { items: [] }), (b) => validate("Error", b));

  const id = created.body.id;
  note("getCart", await call("GET", `/merchant-cart/${id}`), (b) => validate("PayPalCart", b));
  note("getCart 404", await call("GET", "/merchant-cart/NOPE"), (b) => validate("Error", b));
  note("updateCart", await call("PUT", `/merchant-cart/${id}`, mk([{ variant_id: "A1@kohls.com", quantity: 2 }])), (b) => validate("PayPalCart", b));
  note("updateCart over limit", await call("PUT", `/merchant-cart/${id}`, mk([{ variant_id: "B1@qvc.com", quantity: 1 }])), (b) => validate("BusinessError", b));
  const cur = (await call("GET", `/merchant-cart/${id}`)).body;
  note("checkout wrong token", await call("POST", `/merchant-cart/${id}/checkout`, { payment_method: { type: "paypal", token: "WRONG", payer_id: "PAYER-FUND" } }), (b) => validate("BusinessError", b));
  note("checkout missing payer_id", await call("POST", `/merchant-cart/${id}/checkout`, { payment_method: { type: "paypal", token: cur.payment_method.token } }), (b) => validate("Error", b));
  const done = await call("POST", `/merchant-cart/${id}/checkout`, { payment_method: { type: "paypal", token: cur.payment_method.token, payer_id: "PAYER-FUND" } });
  assert.equal(done.status, 200); note("checkout", done, () => validateInline(respSchema("post", "/merchant-cart/{cartId}/checkout", "200"), done.body));
  assert.ok(done.body.payment_confirmation.merchant_order_number);
  note("checkout replay", await call("POST", `/merchant-cart/${id}/checkout`, { payment_method: { type: "paypal", token: cur.payment_method.token, payer_id: "PAYER-FUND" } }), (b) => validateInline(respSchema("post", "/merchant-cart/{cartId}/checkout", "200"), b));
  note("401 body", await handleCartApi(ctx, { method: "POST", path: "/merchant-cart", headers: {}, rawBody: "{}" }), (b) => validate("Error", b));
  for (const s of seen) console.log(`      ${s}`);
});
