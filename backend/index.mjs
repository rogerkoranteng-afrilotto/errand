// Lambda entry point (Function URL, no API Gateway). One function serves:
//   - the app's JSON API under /api/*
//   - the inbound PayPal Cart API (/merchant-cart..., also /api/paypal/v1/merchant-cart...)
//   - the PayPal webhook listener, which answers 200 first and verifies afterwards in an async self-invocation
//   - async jobs (an agent run, an approval, a webhook) delivered as direct invocations
import { randomBytes } from "node:crypto";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { createChannel3 } from "./channel3.mjs";
import { createPayPal, cfg as ppCfg } from "./paypal.mjs";
import { dynamoStore, ConditionFailed } from "./store.mjs";
import { agentKey, fetchPaypalJwks, PAYPAL_JWKS_URL, AGENT_ISS } from "./jwt.mjs";
import { handleCartApi, TERMS_VERSION } from "./cartapi.mjs";
import { budgetOf, FUND_CEILING_CENTS, RESERVE_PCT, fmt } from "./policy.mjs";
import { newRun, logEvent } from "./tools.mjs";
import { runAgent } from "./agent.mjs";
import { buy } from "./purchase.mjs";
import { SCENARIOS, EVIDENCE, DEFAULT_DELIVERY } from "./scenarios.mjs";

const json = (status, body, extra = {}) => ({ statusCode: status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra }, body: JSON.stringify(body) });
const newId = () => `r${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

// ---------- context (built once per container, injectable for tests)
export function makeContext(env = process.env, overrides = {}) {
  const store = overrides.store || dynamoStore(env.TABLE || "errand");
  const paypal = overrides.paypal || createPayPal(ppCfg(env));
  const lambda = new LambdaClient({ region: env.AWS_REGION || "us-east-1" });
  const bedrockClient = new BedrockRuntimeClient({ region: env.AWS_REGION || "us-east-1", maxAttempts: 6, retryMode: "adaptive" });
  const ctx = {
    env, store, paypal,
    channel3: overrides.channel3 || createChannel3({ apiKey: env.CHANNEL3_API_KEY || "" }),
    bedrock: overrides.bedrock || { converse: (p) => bedrockClient.send(new ConverseCommand(p)) },
    modelId: env.BEDROCK_MODEL || "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    agentKey: overrides.agentKey ?? agentKey(env.AGENT_JWT_KEY),
    paypalJwks: overrides.paypalJwks || ((o) => fetchPaypalJwks(o)),
    now: overrides.now || (() => Date.now()),
    async saveRun(run, opts = {}) {
      run.updatedAt = new Date().toISOString();
      // DynamoDB items cap at 400 KB. The product cache is the only unbounded part; if the run gets near the cap, keep
      // just the products that are in the cart.
      if (JSON.stringify(run).length > 330_000) { const keep = new Set(run.lines.map((l) => l.productId)); for (const id of Object.keys(run.seen || {})) if (!keep.has(id)) delete run.seen[id]; }
      await store.put(`run#${run.id}`, "run", run, { status: run.status, ...opts });
      await store.put(`idx#${run.id}`, "runidx", summaryRow(run));      // small rows for the list, so listing never reads whole runs
    },
    logCall(c) { const id = `call#${Date.now()}-${randomBytes(2).toString("hex")}`; return store.put(id, "call", { ...c, t: new Date().toISOString() }, { ttlDays: 3 }).catch(() => {}); },
    // Fund = the budget holder's vaulted PayPal wallet. Read once, then cached for the container's life.
    async fund() {
      if (ctx._fund !== undefined) return ctx._fund;
      const vaultId = env.VAULT_TOKEN_ID;
      if (!vaultId) return (ctx._fund = null);
      try {
        const t = await paypal.getPaymentToken(vaultId);
        const pp = t.payment_source?.paypal || {};
        ctx._fund = { vaultId, payerId: pp.payer_id, name: env.FUND_NAME || pp.name?.full_name || "Relief fund", email: pp.email_address || "", ceilingCents: FUND_CEILING_CENTS };
      } catch (e) { console.error("fund lookup failed", e.message); ctx._fund = null; }
      return ctx._fund;
    },
    // Where the agent's own cart calls go. In Lambda that is this function's public URL (the real HTTP contract).
    async cartCall(method, path, body, token) {
      if (overrides.cartCall) return overrides.cartCall(method, path, body, token);
      const base = env.API_URL ? env.API_URL.replace(/\/$/, "") : null;
      const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text(); let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { j = { message: text.slice(0, 200) }; }
      return { status: r.status, body: j };
    },
    async enqueue(job) {
      if (overrides.enqueue) return overrides.enqueue(job);
      await lambda.send(new InvokeCommand({ FunctionName: env.AWS_LAMBDA_FUNCTION_NAME, InvocationType: "Event", Payload: Buffer.from(JSON.stringify({ job })) }));
    },
  };
  return ctx;
}
let ctxSingleton;
const getCtx = () => (ctxSingleton ||= makeContext());

// ---------- jobs
export async function runJob(ctx, job) {
  if (job.kind === "webhook") return processWebhook(ctx, job.key);
  const run = await ctx.store.get(`run#${job.id}`);
  if (!run) return;
  try {
    if (job.kind === "run") {
      await runAgent(ctx, run);
      await buy(ctx, run);
    } else if (job.kind === "approve") {
      logEvent(run, "approve", "The caseworker approved the purchase."); await buy(ctx, run, { approve: true });
    } else if (job.kind === "resume") {
      await buy(ctx, run);
    }
  } catch (e) {
    console.error("job failed", job, e?.stack || e);
    run.status = "FAILED"; run.failure = `Unexpected error: ${String(e.message).slice(0, 200)}`;
    logEvent(run, "error", run.failure); await ctx.saveRun(run);
  }
}

// ---------- webhook: store raw, answer 200, verify afterwards
async function processWebhook(ctx, key) {
  const rec = await ctx.store.get(key);
  if (!rec || rec.state !== "received") return;
  const webhookId = ctx.env.WEBHOOK_ID;
  let ev; try { ev = JSON.parse(rec.raw); } catch { rec.state = "rejected"; rec.reason = "not JSON"; return ctx.store.put(key, "evt", rec, { status: rec.state, ttlDays: 14 }); }
  rec.eventType = ev.event_type || null;
  let verdict = "ERROR";
  try { verdict = (await ctx.paypal.verifyWebhook(webhookId, rec.headers, rec.raw)).verification_status; } catch (e) { rec.reason = String(e.message).slice(0, 160); }
  if (verdict !== "SUCCESS") { rec.state = "rejected"; rec.reason = rec.reason || `signature ${verdict}`; return ctx.store.put(key, "evt", rec, { status: rec.state, ttlDays: 14 }); }
  const res = ev.resource || {};
  const custom = res.custom_id || res.purchase_units?.[0]?.custom_id || "";
  const orderId = res.supplementary_data?.related_ids?.order_id || (String(ev.event_type).startsWith("CHECKOUT.ORDER") ? res.id : null);
  if (!String(custom).startsWith("errand:") || !orderId) { rec.state = "ignored"; rec.reason = "event for another application"; return ctx.store.put(key, "evt", rec, { status: rec.state, ttlDays: 14 }); }
  rec.state = "confirmed"; rec.orderId = orderId;
  await ctx.store.put(key, "evt", rec, { status: rec.state, ttlDays: 14 });
  const prev = (await ctx.store.get(`hook#${orderId}`)) || { types: [] };
  if (!prev.types.includes(ev.event_type)) prev.types.push(ev.event_type);
  prev.at = new Date().toISOString(); prev.eventId = ev.id;
  await ctx.store.put(`hook#${orderId}`, "hook", prev, { ttlDays: 30 });
}

async function onWebhook(ctx, headers, raw) {
  const id = headers["paypal-transmission-id"] || randomBytes(6).toString("hex");
  const key = `evt#${id}`;
  const keep = {}; for (const k of ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"]) keep[k] = headers[k] || "";
  try { await ctx.store.put(key, "evt", { state: "received", headers: keep, raw, receivedAt: new Date().toISOString() }, { status: "received", ifAbsent: true, ttlDays: 14 }); }
  catch (e) { if (!(e instanceof ConditionFailed)) throw e; return json(200, { received: true, duplicate: true }); }
  try { await ctx.enqueue({ kind: "webhook", key }); } catch (e) { console.error("enqueue webhook failed", e.message); }
  return json(200, { received: true });
}

// ---------- API
const ACTIVE = new Set(["QUEUED", "WORKING", "BUYING"]);

function publicRun(run, hook) {
  const { seen, ...rest } = run;
  const out = { ...rest };
  if (out.order && hook) out.order = { ...out.order, webhook: "confirmed", webhookAt: hook.at, webhookEvents: hook.types };
  out.committedCents = run.lines.reduce((s, l) => s + l.lineCents, 0);
  return out;
}
function summaryRow(r) { return ({ id: r.id, reference: r.reference, status: r.status, updatedAt: r.updatedAt, capCents: r.capCents, committedCents: r.lines.reduce((s, l) => s + l.lineCents, 0), needs: r.needs.length, declined: r.needs.filter((n) => n.status === "declined").length, createdAt: r.createdAt, orderId: r.order?.paypalOrderId || null, mode: r.mode }); }

function validateNew(b) {
  const bad = (m) => ({ error: m });
  const request = String(b.request || "").trim();
  if (request.length < 12 || request.length > 1500) return bad("Describe what the household needs in 12 to 1,500 characters.");
  const cap = Math.round(Number(b.capCents));
  if (!Number.isFinite(cap) || cap < 1000 || cap > FUND_CEILING_CENTS) return bad(`The budget must be between ${fmt(1000)} and ${fmt(FUND_CEILING_CENTS)}.`);
  const reference = String(b.reference || "").trim();
  if (!/^[A-Za-z0-9 _-]{2,24}$/.test(reference)) return bad("The household reference needs 2 to 24 letters, digits, spaces or hyphens. Do not use a name.");
  const mode = b.mode === "hold" ? "hold" : "buy";
  const d = b.delivery || {};
  const delivery = { line1: String(d.line1 || "").trim().slice(0, 80), city: String(d.city || "").trim().slice(0, 40), state: String(d.state || "").trim().toUpperCase().slice(0, 2), postal: String(d.postal || "").trim().slice(0, 10) };
  if (!delivery.line1 || !delivery.city || !/^[A-Z]{2}$/.test(delivery.state) || !/^\d{5}(-\d{4})?$/.test(delivery.postal)) return bad("Add a delivery address: street, city, a two-letter state and a five-digit ZIP.");
  if (b.authorised !== true) return bad("Confirm that you are authorised to spend from this fund for this household.");
  return { request, cap, reference, mode, delivery, instructions: String(b.instructions || "").trim().slice(0, 300), allergies: String(b.allergies || "").trim().slice(0, 200) || null };
}

async function api(ctx, method, path, headers, raw) {
  const body = () => { try { return raw ? JSON.parse(raw) : {}; } catch { return null; } };

  if (path === "/api/health") return json(200, { ok: true, t: new Date().toISOString() });
  if (path === "/.well-known/jwks.json") return json(200, { keys: ctx.agentKey ? [ctx.agentKey.jwk] : [] });

  if (path === "/api/config" && method === "GET") {
    const fund = await ctx.fund();
    return json(200, {
      fund: fund ? { name: fund.name, connected: true, ceilingCents: fund.ceilingCents, account: fund.email.replace(/^(.).*(@.*)$/, "$1***$2") } : { name: "Relief fund", connected: false, ceilingCents: FUND_CEILING_CENTS },
      reservePct: RESERVE_PCT, model: ctx.modelId, termsVersion: TERMS_VERSION,
      channel3: { transport: "MCP (Streamable HTTP)", server: "https://mcp.trychannel3.com/", auth: ctx.env.CHANNEL3_API_KEY ? "API key" : "free tier, no key", tools: ["search_products", "get_products"] },
      scenarios: SCENARIOS, evidence: EVIDENCE, defaultDelivery: DEFAULT_DELIVERY,
    });
  }

  if (path === "/api/cart-api/status" && method === "GET") {
    let jwks = { ok: false, kids: [], error: null };
    try { const keys = await fetchPaypalJwks(); jwks = { ok: keys.length > 0, kids: keys.map((k) => k.kid), error: null }; } catch (e) { jwks.error = String(e.message).slice(0, 120); }
    const calls = (await ctx.store.list("call")).slice(0, 15);
    return json(200, {
      spec: "https://developer.paypal.com/api/agentic-commerce/v1/schema.json",
      operations: [{ id: "createCart", method: "POST", path: "/merchant-cart" }, { id: "getCart", method: "GET", path: "/merchant-cart/{cartId}" }, { id: "updateCart", method: "PUT", path: "/merchant-cart/{cartId}" }, { id: "completeCheckout", method: "POST", path: "/merchant-cart/{cartId}/checkout" }],
      baseUrl: ctx.env.API_URL || null,
      paypalJwks: { url: PAYPAL_JWKS_URL, ...jwks },
      agentIssuer: { iss: AGENT_ISS, kid: ctx.agentKey?.kid || null, jwks: ctx.env.API_URL ? `${ctx.env.API_URL.replace(/\/$/, "")}/.well-known/jwks.json` : null },
      recentCalls: calls,
    });
  }

  if (path === "/api/webhooks/recent" && method === "GET") {
    const evts = (await ctx.store.list("evt")).slice(0, 12);
    return json(200, { events: evts.map((e) => ({ state: e.state, reason: e.reason || null, eventType: e.eventType || null, orderId: e.orderId || null, receivedAt: e.receivedAt })) });
  }

  if (path === "/api/runs" && method === "GET") {
    const runs = (await ctx.store.list("runidx")).slice(0, 30);
    return json(200, { runs });
  }
  if (path === "/api/runs" && method === "POST") {
    const b = body(); if (!b) return json(400, { error: "Body is not valid JSON." });
    const v = validateNew(b); if (v.error) return json(400, { error: v.error });
    const fund = await ctx.fund(); if (!fund) return json(503, { error: "No PayPal account is connected to the fund yet." });
    const active = (await ctx.store.list("runidx")).filter((r) => ACTIVE.has(r.status) && Date.now() - Date.parse(r.updatedAt) < 20 * 60_000);
    if (active.length >= 3) return json(429, { error: "Three requests are already being worked on. Try again in a minute." });
    const run = newRun({ id: newId(), reference: v.reference, request: v.request, capCents: v.cap, budget: budgetOf(v.cap), mode: v.mode, delivery: v.delivery, instructions: v.instructions, allergies: v.allergies, now: new Date().toISOString() });
    run.authorisedAt = run.createdAt;
    logEvent(run, "queued", `Request received for household ${run.reference}. Budget ${fmt(run.capCents)}, ${fmt(run.reserveCents)} held back.`);
    await ctx.saveRun(run);
    await ctx.enqueue({ kind: "run", id: run.id });
    return json(202, { id: run.id });
  }

  const m = /^\/api\/runs\/([\w-]+)(?:\/(approve|info|cancel))?$/.exec(path);
  if (m) {
    const run = await ctx.store.get(`run#${m[1]}`);
    if (!run) return json(404, { error: "No such request." });
    if (!m[2] && method === "GET") {
      const hook = run.order?.paypalOrderId ? await ctx.store.get(`hook#${run.order.paypalOrderId}`) : null;
      return json(200, publicRun(run, hook));
    }
    if (method !== "POST") return json(405, { error: "Method not allowed." });
    if (m[2] === "approve") {
      if (run.status !== "AWAITING_APPROVAL") return json(409, { error: `This request is ${run.status}, not waiting for approval.` });
      run.status = "BUYING";
      try { await ctx.saveRun(run, { ifStatus: ["AWAITING_APPROVAL"] }); } catch (e) { if (e instanceof ConditionFailed) return json(409, { error: "Already approved." }); throw e; }
      await ctx.enqueue({ kind: "approve", id: run.id });
      return json(202, { id: run.id });
    }
    if (m[2] === "info") {
      if (run.status !== "NEEDS_INFO") return json(409, { error: `This request is ${run.status}, not waiting for information.` });
      const b = body() || {}; const a = String(b.allergies || "").trim().slice(0, 200);
      if (!a) return json(400, { error: "Enter the allergies, or write None known." });
      run.allergies = a; run.status = "BUYING"; logEvent(run, "info", `Allergy information added: ${a}`);
      try { await ctx.saveRun(run, { ifStatus: ["NEEDS_INFO"] }); } catch (e) { if (e instanceof ConditionFailed) return json(409, { error: "Already submitted." }); throw e; }
      await ctx.enqueue({ kind: "resume", id: run.id });
      return json(202, { id: run.id });
    }
    if (m[2] === "cancel") {
      if (!["AWAITING_APPROVAL", "NEEDS_INFO"].includes(run.status)) return json(409, { error: `A request that is ${run.status} cannot be cancelled.` });
      run.status = "CANCELLED"; logEvent(run, "done", "Cancelled by the caseworker. Nothing was charged.");
      try { await ctx.saveRun(run, { ifStatus: ["AWAITING_APPROVAL", "NEEDS_INFO"] }); } catch (e) { if (e instanceof ConditionFailed) return json(409, { error: "The request changed." }); throw e; }
      return json(200, { id: run.id });
    }
  }
  return json(404, { error: "Not found." });
}

// ---------- Lambda handler
export const handler = (event) => handle(getCtx(), event);   // the Lambda runtime may pass extra arguments; never let one become the context

export async function handle(ctx, event) {
  if (event.job) { await runJob(ctx, event.job); return { ok: true }; }

  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  const path = event.rawPath || event.path || "/";
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body) : "";
  try {
    if (/^(\/api\/paypal\/v1)?\/merchant-cart(\/|$)/.test(path) || /^\/api\/merchant-cart(\/|$)/.test(path)) {
      const r = await handleCartApi(ctx, { method, path, headers, rawBody: raw });
      return json(r.status, r.body);
    }
    if (path === "/api/webhooks/paypal" && method === "POST") return await onWebhook(ctx, headers, raw);
    return await api(ctx, method, path, headers, raw);
  } catch (e) {
    console.error("request failed", method, path, e?.stack || e);
    return json(500, { error: "The service failed while handling this request." });
  }
}
