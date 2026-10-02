// The four endpoints of the PayPal Cart API v1 (developer.paypal.com/api/agentic-commerce/v1), implemented as the
// MERCHANT side: PayPal's cart service is the caller, this service answers. Operations:
//   POST /merchant-cart                  createCart
//   GET  /merchant-cart/{cartId}         getCart
//   PUT  /merchant-cart/{cartId}         updateCart   (full replacement, as the spec insists)
//   POST /merchant-cart/{cartId}/checkout completeCheckout
// Payment follows PayPal's "Orders API v2 integration pattern" from developer.paypal.com/store-sync/integrate:
// createCart makes a PayPal order and returns its id as payment_method.token; completeCheckout captures it.
// The one deviation is how the order gets approved. PayPal's flow has the buyer approve in a browser; here the order
// is confirmed against the budget holder's vaulted PayPal wallet instead (confirm-payment-source with a vault_id),
// then captured. That is what lets an agent buy with nobody at a keyboard.
//
// Safety rules enforced here, independent of the agent: the cart total never exceeds the limit carried in the signed
// token (or the fund ceiling), prices and stock are re-read from Channel3 on every create/update, and checkout is a
// state machine guarded by conditional writes so a replay captures once.
import { createHash, randomBytes } from "node:crypto";
import { verifyBearer } from "./jwt.mjs";
import { ConditionFailed } from "./store.mjs";
import { blockReasons, bestOffer, dollars, isIngestible, FUND_CEILING_CENTS, MAX_QTY } from "./policy.mjs";
import { PayPalError } from "./paypal.mjs";

const money = (c) => ({ currency_code: "USD", value: dollars(c) });
const toC = (m) => (m && m.value !== undefined ? Math.round(Number(m.value) * 100) : null);
const debugId = () => randomBytes(6).toString("hex");
const err = (status, name, message, extra = {}) => ({ status, body: { name, message, debug_id: debugId(), ...extra } });
const businessErr = (name, message, issue) => err(422, name, message, { business_context: issue });
export const TERMS_VERSION = "errand-fund-policy-2026-10";
export const LOCK_MS = 60_000;

const issue = (code, type, message, user_message, context, extra = {}) => ({ code, type, message, user_message, ...(context ? { context } : {}), ...extra });

export const newCartId = () => `CART-${Date.now().toString(36).toUpperCase()}${randomBytes(3).toString("hex").toUpperCase()}`;
const hashItems = (lines) => createHash("sha1").update(JSON.stringify(lines.map((l) => [l.variant_id, l.quantity, toC(l.price)]))).digest("hex");

// Strip internals before a cart leaves the service.
export function publicCart(rec) {
  const { _x, ...rest } = rec;
  return rest;
}

async function resolveItems(ctx, items, limitItemsToRun) {
  const issues = [];
  const ids = [...new Set(items.map((i) => String(i.variant_id || i.item_id || "").split("@")[0]).filter(Boolean))];
  const products = new Map((await ctx.channel3.details(ids)).map((p) => [p.id, p]));
  const lines = [];
  for (const it of items) {
    const vid = String(it.variant_id || it.item_id || "");
    const [pid, dom] = vid.split("@");
    const qty = Number(it.quantity);
    if (!pid) { issues.push(issue("DATA_ERROR", "MISSING_FIELD", "Item has no variant_id", "An item is missing its identifier.", { specific_issue: "REQUIRED_FIELD_MISSING", field_name: "variant_id" })); continue; }
    if (!Number.isInteger(qty) || qty < 1) { issues.push(issue("DATA_ERROR", "INVALID_DATA", `Quantity for ${vid} must be a whole number of at least 1`, "A quantity is not valid.", { specific_issue: "INVALID_ITEM_DATA", field_name: "quantity", provided_value: String(it.quantity) }, { variant_id: vid })); continue; }
    if (qty > MAX_QTY) { issues.push(issue("BUSINESS_RULE_ERROR", "BUSINESS_RULE", `Quantity ${qty} exceeds the per-line maximum of ${MAX_QTY}`, `At most ${MAX_QTY} of one item can be bought in one cart.`, { specific_issue: "MAXIMUM_QUANTITY_EXCEEDED", total_quantity: qty, maximum_amount: String(MAX_QTY) }, { variant_id: vid, resolution_options: [{ action: "MODIFY_CART", label: `Reduce to ${MAX_QTY} or fewer` }] })); continue; }
    const p = products.get(pid);
    if (!p) { issues.push(issue("DATA_ERROR", "INVALID_DATA", `Channel3 has no product ${pid}`, "That product could not be found.", { specific_issue: "ITEM_NOT_FOUND", field_name: "variant_id", provided_value: vid }, { variant_id: vid, resolution_options: [{ action: "REMOVE_ITEM", label: "Remove this item" }] })); continue; }
    const offer = dom ? p.offers.find((o) => o.domain === dom) : bestOffer(p);
    if (!offer) {
      issues.push(issue("INVENTORY_ISSUE", "BUSINESS_RULE", `No usable offer for ${vid}`, `${p.title} is not available to buy right now.`, { specific_issue: "VARIANT_NOT_AVAILABLE", variant_id: vid, requested_quantity: qty, available_quantity: 0 }, { variant_id: vid, resolution_options: [{ action: "SUGGEST_ALTERNATIVE", label: "Find a replacement" }] }));
      continue;
    }
    const alt = p.offers.filter((o) => o !== offer && blockReasons(p, o).length === 0).map((o) => `${p.id}@${o.domain}`);
    const blocked = blockReasons(p, offer);
    if (blocked.some((b) => b.startsWith("not in stock"))) {
      issues.push(issue("INVENTORY_ISSUE", "BUSINESS_RULE", `${vid} is ${offer.availability} at ${offer.domain}`, `${p.title} is out of stock at ${offer.domain}.`, { specific_issue: "ITEM_OUT_OF_STOCK", variant_id: vid, requested_quantity: qty, available_quantity: 0, suggested_alternatives: alt }, { variant_id: vid, resolution_options: [{ action: alt.length ? "SUGGEST_ALTERNATIVE" : "REMOVE_ITEM", label: alt.length ? "Buy from another retailer" : "Remove this item" }] }));
      continue;
    }
    if (blocked.length) {
      issues.push(issue("DATA_ERROR", "BUSINESS_RULE", `${vid} cannot be bought under the fund policy: ${blocked.join("; ")}`, `${p.title} cannot be bought with this fund: ${blocked.join("; ")}.`, { specific_issue: "INVALID_ITEM_DATA", field_name: "variant_id", provided_value: vid }, { variant_id: vid, resolution_options: [{ action: "REMOVE_ITEM", label: "Remove this item" }] }));
      continue;
    }
    const price = it.price && toC(it.price) !== null ? toC(it.price) : null;
    if (price !== null && price !== offer.priceCents) {
      const up = offer.priceCents > price;
      issues.push(issue("PRICING_ERROR", "BUSINESS_RULE", `Price for ${vid} is ${dollars(offer.priceCents)}, request said ${dollars(price)}`, `The price of ${p.title} changed from ${dollars(price)} to ${dollars(offer.priceCents)}.`,
        { specific_issue: "PRICE_MISMATCH", variant_id: vid, original_price: dollars(price), current_price: dollars(offer.priceCents), currency_code: "USD", ...(up ? { price_increase: dollars(offer.priceCents - price) } : { price_decrease: dollars(price - offer.priceCents) }) },
        { variant_id: vid, resolution_options: [{ action: "ACCEPT_NEW_PRICE", label: `Accept ${dollars(offer.priceCents)}`, metadata: { cost_impact: dollars((offer.priceCents - price) * qty), priority: "HIGH", auto_applicable: false } }] }));
    }
    const main = p.images.find((i) => i.main) || p.images[0];
    lines.push({
      variant_id: `${p.id}@${offer.domain}`, parent_id: p.id, quantity: qty, name: p.title.slice(0, 127), description: `${p.brands.join(", ")} via ${offer.domain}`.slice(0, 127),
      item_url: offer.url, price: money(offer.priceCents), domain: offer.domain, image: main?.url || null, alt: main?.alt || p.title, ingestible: isIngestible(p),
    });
  }
  // The schema wants a cart to keep its items. Items that could not be resolved stay in the response as requested,
  // flagged by an issue, and are excluded from the totals and from the PayPal order (which is only made when the cart is valid).
  const unresolved = items.filter((it) => { const [pid, dom] = String(it.variant_id || it.item_id || "").split("@"); return !lines.some((l) => l.parent_id === pid && (!dom || l.domain === dom)); })
    .map((it) => ({ variant_id: String(it.variant_id || it.item_id || "unknown"), quantity: Number.isInteger(Number(it.quantity)) && Number(it.quantity) >= 1 ? Number(it.quantity) : 1 }));
  return { lines, issues, unresolved };
}

function checkoutFields(provided, { ingestible, hasDeliveryNote }) {
  const out = [], issues = [];
  const by = new Map((provided || []).map((f) => [f.type, f]));
  const need = (type, required, okFn) => {
    const f = by.get(type);
    const ok = f && f.status === "COMPLETED" && okFn(f.value || {});
    if (ok) { out.push({ type, status: "COMPLETED", value: f.value }); return; }
    if (required) {
      out.push({ type, status: "PENDING", context: { required: true }, validation_issue: { code: "DATA_ERROR", type: "MISSING_FIELD", message: `${type} is required before checkout`, field: type } });
      issues.push(type);
    }
  };
  need("TERMS_ACCEPTANCE", true, (v) => v.accepted === true);
  need("ALLERGY_INFORMATION", ingestible, (v) => Array.isArray(v.allergies));
  need("DELIVERY_INSTRUCTIONS", false, (v) => typeof v.instructions === "string" && v.instructions.trim().length > 0);
  need("DELIVERY_DATE_PREFERENCE", false, (v) => !!(v.preferred_date || v.time_window));
  for (const f of provided || []) if (!out.some((o) => o.type === f.type)) out.push({ type: f.type, status: "REJECTED", validation_issue: { code: "DATA_ERROR", type: "INVALID_DATA", message: `${f.type} is not used by this merchant or its value is not valid`, field: f.type } });
  return { fields: out, missing: issues };
}

const validAddress = (a) => a && a.country_code && a.address_line_1 && a.admin_area_2 && a.admin_area_1 && a.postal_code;

// Build the full cart record from a request body. Used by create and by update (which replaces everything).
async function build(ctx, body, { id, limit, runId, prior }) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return { error: err(400, "INVALID_REQUEST", "items must contain at least one item", { details: [{ field: "items", issue: "REQUIRED" }] }) };
  const { lines, issues, unresolved } = await resolveItems(ctx, items);
  const subtotal = lines.reduce((s, l) => s + toC(l.price) * l.quantity, 0);

  if (subtotal > limit) {
    return { error: businessErr("PURCHASE_LIMIT_EXCEEDED", `Cart total ${dollars(subtotal)} is above the limit of ${dollars(limit)}`,
      issue("BUSINESS_RULE_ERROR", "BUSINESS_RULE", `Cart total ${dollars(subtotal)} exceeds the spend limit ${dollars(limit)}`, `This cart costs ${dollars(subtotal)} and the limit is ${dollars(limit)}. Remove items or reduce quantities.`,
        { specific_issue: "PURCHASE_LIMIT_EXCEEDED", current_amount: dollars(subtotal), maximum_amount: dollars(limit), exceeds_by: dollars(subtotal - limit) },
        { resolution_options: [{ action: "REMOVE_ITEM", label: "Remove an item" }, { action: "MODIFY_CART", label: "Reduce quantities" }] })) };
  }

  const ship = body.shipping_address;
  if (!validAddress(ship)) issues.push(issue("SHIPPING_ERROR", "MISSING_FIELD", "A complete shipping_address is required", "A delivery address is needed.", { specific_issue: "MISSING_SHIPPING_ADDRESS" }, { field: "shipping_address", resolution_options: [{ action: "UPDATE_ADDRESS", label: "Add the delivery address" }] }));

  const { fields, missing } = checkoutFields(body.checkout_fields, { ingestible: lines.some((l) => l.ingestible) });
  if (missing.length) issues.push(issue("DATA_ERROR", "MISSING_FIELD", `Missing checkout fields: ${missing.join(", ")}`, missing.includes("ALLERGY_INFORMATION") ? "Allergy information is needed before food or formula can be bought." : "Required information is missing.",
    { specific_issue: "MISSING_CHECKOUT_FIELDS", required_fields: missing }, { resolution_options: [{ action: "PROVIDE_MISSING_FIELD", label: "Provide the missing information" }] }));

  const pm = String(body.payment_method?.type || "paypal").toLowerCase();
  if (pm !== "paypal") issues.push(issue("PAYMENT_ERROR", "INVALID_DATA", "Only PayPal is accepted", "Only PayPal can be used.", { specific_issue: "PAYMENT_METHOD_NOT_ACCEPTED", payment_method: pm, supported_payment_methods: ["paypal"] }));

  const hard = issues.filter((i) => i.type !== "MISSING_FIELD");
  const validation_status = !issues.length ? "VALID" : hard.length ? "INVALID" : "REQUIRES_ADDITIONAL_INFORMATION";
  const status = !issues.length ? (prior ? "READY" : "CREATED") : "INCOMPLETE";
  const rec = {
    id, status, validation_status, validation_issues: issues,
    items: [...lines, ...unresolved], customer: body.customer || undefined, shipping_address: ship || undefined, billing_address: body.billing_address || undefined,
    checkout_fields: fields,
    available_shipping_options: [{ id: "retailer-direct", name: "Shipped by the retailer", description: "Channel3 returns no shipping rate; the fund reserve covers it and is never charged.", price: money(0), is_selected: true }],
    totals: { subtotal: money(subtotal), shipping: money(0), tax: money(0), discount: money(0), total: money(subtotal) },
    payment_method: { type: pm === "paypal" ? (body.payment_method?.type || "paypal") : pm },
    applied_coupons: [],
    _x: { runId: runId || null, limitCents: limit, itemsHash: hashItems(lines), order: prior?._x?.order || null, createdAt: prior?._x?.createdAt || ctx.now(), updatedAt: ctx.now(), lock: null },
  };
  return { rec };
}

async function ensureOrder(ctx, rec) {
  if (rec.validation_status !== "VALID") return;
  const h = rec._x.itemsHash, cur = rec._x.order;
  if (cur && cur.itemsHash === h) { rec.payment_method.token = cur.id; return; }
  const total = toC(rec.totals.total);
  const sa = rec.shipping_address;
  const body = {
    intent: "CAPTURE",
    purchase_units: [{
      reference_id: "default", custom_id: `errand:${rec.id}`, invoice_id: `ERRAND-${rec.id}-${h.slice(0, 6).toUpperCase()}`,
      description: `Errand purchase ${rec.id}`.slice(0, 127),
      amount: { currency_code: "USD", value: dollars(total), breakdown: { item_total: money(total) } },
      items: rec.items.map((l) => ({ name: l.name.slice(0, 127), quantity: String(l.quantity), unit_amount: l.price, sku: l.variant_id.slice(0, 127), url: l.item_url, description: l.description, category: "PHYSICAL_GOODS" })),
      shipping: { name: { full_name: (rec.customer?.name && `${rec.customer.name.given_name || ""} ${rec.customer.name.surname || ""}`.trim()) || "Household delivery" }, address: { address_line_1: sa.address_line_1, address_line_2: sa.address_line_2, admin_area_2: sa.admin_area_2, admin_area_1: sa.admin_area_1, postal_code: sa.postal_code, country_code: sa.country_code } },
    }],
  };
  const o = await ctx.paypal.createOrder(body, `errand-order-${rec.id}-${h.slice(0, 10)}`);
  rec._x.order = { id: o.id, itemsHash: h, createdAt: ctx.now() };
  rec.payment_method.token = o.id;
  const approve = (o.links || []).find((l) => l.rel === "approve" || l.rel === "payer-action");
  if (approve) rec.payment_method.approval_url = approve.href;
}

async function limitFor(ctx, claims, prior) {
  const fund = await ctx.fund();
  const fromToken = Number.isFinite(claims?.limit_cents) ? claims.limit_cents : Infinity;
  const fromPrior = prior?._x?.limitCents ?? Infinity;
  return Math.min(fromToken, fromPrior, fund?.ceilingCents || FUND_CEILING_CENTS);
}

export async function createCart(ctx, body, auth) {
  const id = newCartId();
  const limit = await limitFor(ctx, auth.claims, null);
  const { rec, error } = await build(ctx, body, { id, limit, runId: auth.claims?.run, prior: null });
  if (error) return error;
  await ensureOrder(ctx, rec);
  await ctx.store.put(`cart#${id}`, "cart", rec, { status: rec.status, ifAbsent: true });
  return { status: rec.validation_status === "VALID" ? 201 : 200, body: publicCart(rec) };
}

export async function getCart(ctx, id) {
  const rec = await ctx.store.get(`cart#${id}`);
  if (!rec) return err(404, "CART_NOT_FOUND", `No cart ${id}`);
  return { status: 200, body: { ...publicCart(rec), ...(rec._x.completion ? { payment_confirmation: rec._x.completion } : {}) } };
}

export async function updateCart(ctx, id, body, auth) {
  const prior = await ctx.store.get(`cart#${id}`);
  if (!prior) return err(404, "CART_NOT_FOUND", `No cart ${id}`);
  if (prior.status === "COMPLETED" || prior.status === "COMPLETING") return businessErr("CART_ALREADY_CHECKED_OUT", "This cart has been or is being checked out and cannot be replaced.", issue("BUSINESS_RULE_ERROR", "BUSINESS_RULE", "Cart is already checked out", "This cart was already paid for.", { specific_issue: "CART_LIMIT_EXCEEDED" }));
  const limit = await limitFor(ctx, auth.claims, prior);
  const { rec, error } = await build(ctx, body, { id, limit, runId: prior._x.runId, prior });
  if (error) return error;
  await ensureOrder(ctx, rec);
  try { await ctx.store.put(`cart#${id}`, "cart", rec, { status: rec.status, ifStatus: ["CREATED", "READY", "INCOMPLETE"] }); }
  catch (e) { if (e instanceof ConditionFailed) return businessErr("CART_ALREADY_CHECKED_OUT", "The cart changed state while it was being updated.", issue("BUSINESS_RULE_ERROR", "BUSINESS_RULE", "Cart state changed", "Try again.", null)); throw e; }
  return { status: 200, body: publicCart(rec) };
}

const completedResponse = (rec) => ({ status: 200, body: { ...publicCart(rec), payment_confirmation: rec._x.completion } });

export async function completeCheckout(ctx, id, body, auth) {
  const rec = await ctx.store.get(`cart#${id}`);
  if (!rec) return err(404, "CART_NOT_FOUND", `No cart ${id}`);
  const pm = body?.payment_method || {};
  if (!pm.token) return err(400, "INVALID_REQUEST", "payment_method.token is required", { details: [{ field: "payment_method.token", issue: "REQUIRED" }] });
  if (!pm.payer_id) return err(400, "INVALID_REQUEST", "payment_method.payer_id is required", { details: [{ field: "payment_method.payer_id", issue: "REQUIRED" }] });

  // Replay: a completed cart answers with the stored result. No second PayPal call, no second purchase.
  if (rec.status === "COMPLETED") {
    if (pm.token !== rec._x.order?.id) return businessErr("PAYMENT_TOKEN_MISMATCH", "This cart was paid with a different payment token.", issue("PAYMENT_ERROR", "INVALID_DATA", "Token does not match the cart's order", "This payment token does not belong to this cart.", { specific_issue: "PAYMENT_METHOD_NOT_ACCEPTED", payment_token: pm.token }));
    return completedResponse(rec);
  }
  if (rec.validation_status !== "VALID") {
    return businessErr("CART_NOT_READY", "The cart has unresolved validation issues.", rec.validation_issues[0] || issue("DATA_ERROR", "INVALID_DATA", "Cart is not valid", "Fix the cart before checkout.", null));
  }
  if (pm.token !== rec._x.order?.id) return businessErr("PAYMENT_TOKEN_MISMATCH", "payment_method.token is not this cart's PayPal order.", issue("PAYMENT_ERROR", "INVALID_DATA", "Token does not match the cart's order", "This payment token does not belong to this cart.", { specific_issue: "PAYMENT_METHOD_NOT_ACCEPTED", payment_token: pm.token }));

  const total = toC(rec.totals.total);
  const limit = await limitFor(ctx, auth.claims, rec);
  if (total > limit) return businessErr("PURCHASE_LIMIT_EXCEEDED", `Cart total ${dollars(total)} is above the limit of ${dollars(limit)}`, issue("BUSINESS_RULE_ERROR", "BUSINESS_RULE", "Limit exceeded at checkout", `The limit is ${dollars(limit)}.`, { specific_issue: "PURCHASE_LIMIT_EXCEEDED", current_amount: dollars(total), maximum_amount: dollars(limit), exceeds_by: dollars(total - limit) }));

  // Lock. A live lock means another request is mid-purchase; an expired one means that request died and we take over.
  // The takeover is safe because every PayPal call below is idempotent (PayPal-Request-Id plus the state read).
  if (rec.status === "COMPLETING" && rec._x.lock && rec._x.lock > ctx.now()) return err(409, "CHECKOUT_IN_PROGRESS", "Checkout for this cart is already running. Retry in a few seconds.");
  const prevStatus = rec.status;
  const locking = { ...rec, status: "COMPLETING", _x: { ...rec._x, lock: ctx.now() + LOCK_MS } };
  try { await ctx.store.put(`cart#${id}`, "cart", locking, { status: "COMPLETING", ifStatus: [prevStatus] }); }
  catch (e) { if (e instanceof ConditionFailed) return err(409, "CHECKOUT_IN_PROGRESS", "Checkout for this cart is already running. Retry in a few seconds."); throw e; }

  const unlock = async (extra = {}) => {
    const back = { ...rec, ...extra, status: "READY", _x: { ...rec._x, lock: null } };
    await ctx.store.put(`cart#${id}`, "cart", back, { status: "READY", ifStatus: ["COMPLETING"] }).catch(() => {});
  };

  try {
    const fund = await ctx.fund();
    let order = await ctx.paypal.getOrder(pm.token);
    if (order.status === "CREATED") {
      // Hands-free path: only the vaulted fund account may pay without a browser, and the caller must name it.
      if (!fund?.vaultId || pm.payer_id !== fund.payerId) {
        await unlock();
        return businessErr("PAYMENT_METHOD_NOT_ACCEPTED", "The order is not approved and payer_id is not the vaulted fund account.", issue("PAYMENT_ERROR", "INVALID_DATA", "Unapproved order and payer_id is not the fund account", "This payment needs approval from the fund account.", { specific_issue: "PAYMENT_METHOD_NOT_ACCEPTED", payment_method: "paypal", payment_token: pm.token }));
      }
      order = await ctx.paypal.confirmWithVault(pm.token, fund.vaultId);
    }
    if (order.status === "APPROVED") {
      try { order = await ctx.paypal.capture(pm.token, `errand-capture-${id}`); }
      catch (e) {
        if (e instanceof PayPalError && e.issue === "ORDER_ALREADY_CAPTURED") order = await ctx.paypal.getOrder(pm.token);   // duplicate refusal is success
        else throw e;
      }
    }
    if (order.status !== "COMPLETED") {
      await unlock();
      return businessErr("PAYMENT_NOT_COMPLETED", `PayPal order is ${order.status}`, issue("PAYMENT_ERROR", "BUSINESS_RULE", `Order status ${order.status}`, "The payment did not complete.", { specific_issue: "PAYMENT_DECLINED", payment_token: pm.token }));
    }
    const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
    const completion = {
      merchant_order_number: `ERR-${id.replace("CART-", "")}`,
      order_review_page: `${ctx.env.SITE || ""}/#/runs/${rec._x.runId || id}`,
      paypal_order_id: order.id, paypal_capture_id: cap?.id || null, captured_amount: cap?.amount?.value || null, captured_at: cap?.create_time || ctx.now(),
    };
    const done = { ...rec, status: "COMPLETED", _x: { ...rec._x, lock: null, completion } };
    await ctx.store.put(`cart#${id}`, "cart", done, { status: "COMPLETED", ifStatus: ["COMPLETING"] });
    return completedResponse(done);
  } catch (e) {
    await unlock();
    if (e instanceof PayPalError) {
      const declined = ["INSTRUMENT_DECLINED", "PAYER_ACTION_REQUIRED", "PAYMENT_SOURCE_DECLINED_BY_PROCESSOR", "TRANSACTION_REFUSED"].includes(e.issue);
      return businessErr(declined ? "PAYMENT_DECLINED" : "PAYMENT_ERROR", `PayPal refused: ${e.issue}`, issue("PAYMENT_ERROR", "BUSINESS_RULE", `PayPal ${e.issue}`, "PayPal did not accept the payment.", { specific_issue: declined ? "PAYMENT_DECLINED" : "PAYMENT_PROCESSOR_UNAVAILABLE", processor_error_code: e.issue, payment_token: pm.token }));
    }
    throw e;
  }
}

// ---- Router and authentication. Returns { status, body }.
export async function handleCartApi(ctx, { method, path, headers, rawBody }) {
  const p = path.replace(/^\/api\/paypal\/v1(?=\/)/, "").replace(/^\/api(?=\/merchant-cart)/, "");
  const parts = p.split("/").filter(Boolean);                   // ['merchant-cart', id?, 'checkout'?]
  const log = (auth, status, cartId) => ctx.logCall?.({ method, path: p, auth: auth.ok ? auth.issuer : `rejected:${auth.reason}`, status, cartId: cartId || null });

  const auth = await verifyBearer(headers.authorization, { agent: ctx.agentKey, paypalJwks: ctx.paypalJwks, now: ctx.now() });
  if (!auth.ok) { log(auth, 401); return err(401, "AUTHENTICATION_FAILURE", `Bearer token rejected: ${auth.reason}`); }

  let body = {};
  if (method === "POST" || method === "PUT") {
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { log(auth, 400); return err(400, "INVALID_REQUEST", "Body is not valid JSON"); }
  }
  let r;
  try {
    if (parts[0] !== "merchant-cart") r = err(404, "NOT_FOUND", `No route ${method} ${p}`);
    else if (parts.length === 1 && method === "POST") r = await createCart(ctx, body, auth);
    else if (parts.length === 2 && method === "GET") r = await getCart(ctx, parts[1]);
    else if (parts.length === 2 && method === "PUT") r = await updateCart(ctx, parts[1], body, auth);
    else if (parts.length === 3 && parts[2] === "checkout" && method === "POST") r = await completeCheckout(ctx, parts[1], body, auth);
    else r = err(404, "NOT_FOUND", `No route ${method} ${p}`);
  } catch (e) {
    console.error("cart api failure", e?.stack || e);
    r = err(500, "INTERNAL_SERVER_ERROR", "The merchant API failed while handling the request.");
  }
  log(auth, r.status, parts[1] || r.body?.id);
  return r;
}
