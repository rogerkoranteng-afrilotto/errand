// Test doubles: a deterministic Channel3 catalogue and a PayPal that records every call and enforces the same
// state machine the real sandbox showed (CREATED -> APPROVED via vault -> COMPLETED, ORDER_ALREADY_CAPTURED on a second capture).
import { generateKeyPairSync } from "node:crypto";
import { memoryStore } from "../backend/store.mjs";
import { agentKey } from "../backend/jwt.mjs";
import { PayPalError } from "../backend/paypal.mjs";

export const offer = (domain, price, over = {}) => ({ url: `https://buy.trychannel3.com/${domain}`, domain, priceCents: Math.round(price * 100), compareAtCents: null, currency: "USD", availability: "InStock", condition: "new", ...over });
export const product = (id, title, offers, over = {}) => ({ id, title, brands: ["Brand"], description: `${title}. A good product.`, category: "Home", age: null, keyFeatures: [], attributes: [], materials: [], images: [{ url: `https://cdn.example/${id}`, alt: `Photo of ${title}`, main: true, shot: "hero" }], offers, variants: null, ...over });

export function fakeChannel3(products) {
  const calls = { search: [], details: [] };
  const by = new Map(products.map((p) => [p.id, p]));
  return {
    calls, products: by,
    async search(q) { calls.search.push(q); const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 2); return products.filter((p) => words.some((w) => `${p.title} ${p.description}`.toLowerCase().includes(w))).slice(0, 8); },
    async details(ids) { calls.details.push(ids); return ids.map((i) => by.get(i)).filter(Boolean); },
  };
}

export function fakePayPal({ payerId = "PAYER-FUND", failCapture = false } = {}) {
  const orders = new Map(); const calls = []; let n = 0;
  const api = {
    calls, orders,
    async createOrder(body, rid) {
      calls.push(["createOrder", rid]);
      for (const o of orders.values()) if (o.rid === rid) return { id: o.id, status: o.status, links: [{ rel: "approve", href: `https://paypal.test/approve/${o.id}` }] };
      const id = `ORDER${++n}`; orders.set(id, { id, rid, body, status: "CREATED", captures: [] });
      return { id, status: "CREATED", links: [{ rel: "approve", href: `https://paypal.test/approve/${id}` }] };
    },
    async getOrder(id) { calls.push(["getOrder", id]); const o = orders.get(id); if (!o) throw new PayPalError("GET order", 404, { name: "RESOURCE_NOT_FOUND" }); return view(o); },
    async confirmWithVault(id, vaultId) { calls.push(["confirmWithVault", id, vaultId]); const o = orders.get(id); if (o.status !== "CREATED") throw new PayPalError("confirm", 422, { details: [{ issue: "ORDER_ALREADY_AUTHORIZED" }] }); o.status = "APPROVED"; return view(o); },
    async capture(id, rid) {
      calls.push(["capture", id, rid]); const o = orders.get(id);
      if (failCapture) throw new PayPalError("capture", 422, { details: [{ issue: "INSTRUMENT_DECLINED" }] });
      if (o.status === "COMPLETED") throw new PayPalError("capture", 422, { details: [{ issue: "ORDER_ALREADY_CAPTURED" }] });
      if (o.status !== "APPROVED") throw new PayPalError("capture", 422, { details: [{ issue: "ORDER_NOT_APPROVED" }] });
      o.status = "COMPLETED"; o.captures.push({ id: `CAP${id}`, status: "COMPLETED", amount: { currency_code: "USD", value: o.body.purchase_units[0].amount.value }, create_time: "2026-10-02T00:00:00Z" }); return view(o);
    },
    async getPaymentToken() { return { payment_source: { paypal: { payer_id: payerId, name: { full_name: "Test Fund" }, email_address: "fund@example.com" } } }; },
    async verifyWebhook(_id, _h, raw) { calls.push(["verifyWebhook"]); return { verification_status: raw.includes("TAMPERED") ? "FAILURE" : "SUCCESS" }; },
  };
  const view = (o) => ({ id: o.id, status: o.status, purchase_units: [{ custom_id: o.body.purchase_units[0].custom_id, payments: { captures: o.captures } }] });
  api.captureCount = () => calls.filter((c) => c[0] === "capture" && !failCapture).length;
  api.completedCaptures = () => [...orders.values()].reduce((s, o) => s + o.captures.length, 0);
  return api;
}

export const keyB64 = () => { const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }); return Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64"); };

export async function testCtx({ products, payerId, failCapture, now } = {}) {
  const { makeContext } = await import("../backend/index.mjs");
  const channel3 = fakeChannel3(products || []);
  const paypal = fakePayPal({ payerId, failCapture });
  const key = agentKey(keyB64());
  let ctx;
  ctx = makeContext({ VAULT_TOKEN_ID: "VAULT1", SITE: "https://site.test", TABLE: "x" }, {
    store: memoryStore(), paypal, channel3, agentKey: key, now: now || (() => Date.now()),
    paypalJwks: async () => [],
    bedrock: { converse: async () => { const e = new Error("no model in this test"); e.name = "ThrottlingException"; throw e; } },
    enqueue: async () => {},
    cartCall: async (method, path, body, token) => { const { handleCartApi } = await import("../backend/cartapi.mjs"); return handleCartApi(ctx, { method, path, headers: { authorization: `Bearer ${token}` }, rawBody: body ? JSON.stringify(body) : "" }); },
  });
  ctx.fake = { channel3, paypal, key };
  return ctx;
}
