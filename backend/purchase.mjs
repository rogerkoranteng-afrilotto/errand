// The buying side. In production PayPal's cart service would call the four Cart API endpoints. PayPal only does that
// for accounts it has onboarded, which this one is not, so the agent plays that role itself: it calls the same four
// endpoints, over HTTP, with a short-lived token signed by this deployment (issuer "errand-agent"). Nothing here
// bypasses the merchant side: every price check, limit check and PayPal call happens inside cartapi.mjs.
import { signAgentToken } from "./jwt.mjs";
import { logEvent, committed } from "./tools.mjs";
import { fmt, dollars } from "./policy.mjs";
import { TERMS_VERSION } from "./cartapi.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cartBody(run) {
  const fields = [{ type: "TERMS_ACCEPTANCE", status: "COMPLETED", value: { type: "TERMS_ACCEPTANCE", accepted: true, terms_version: TERMS_VERSION, acceptance_date: run.authorisedAt || run.createdAt } }];
  if (run.allergies) fields.push({ type: "ALLERGY_INFORMATION", status: "COMPLETED", value: { type: "ALLERGY_INFORMATION", allergies: /^(none|no|nil|n\/a)\b/i.test(run.allergies.trim()) ? [] : [run.allergies.trim()] } });
  if (run.instructions) fields.push({ type: "DELIVERY_INSTRUCTIONS", status: "COMPLETED", value: { type: "DELIVERY_INSTRUCTIONS", instructions: run.instructions } });
  return {
    items: run.lines.map((l) => ({ variant_id: l.variantId, quantity: l.qty, price: { currency_code: "USD", value: dollars(l.unitCents) } })),
    customer: { name: { given_name: "Household", surname: run.reference } },
    shipping_address: { address_line_1: run.delivery.line1, admin_area_2: run.delivery.city, admin_area_1: run.delivery.state, postal_code: run.delivery.postal, country_code: "US" },
    payment_method: { type: "paypal" },
    checkout_fields: fields,
  };
}

export function agentClient(ctx, run) {
  const token = () => signAgentToken(ctx.agentKey, { run: run.id, limit_cents: run.spendableCents, sub: "relief-fund" }, { now: ctx.now() });
  return (method, path, body) => ctx.cartCall(method, path, body, token());
}

const note = (run, cart) => { run.cart = { id: cart.id, status: cart.status, validation_status: cart.validation_status, issues: (cart.validation_issues || []).map((i) => i.user_message || i.message), paypalOrderId: cart.payment_method?.token || null, total: cart.totals?.total?.value || null }; };

// Create or repair the cart until it validates. Returns { cart } or { stop: 'NEEDS_INFO'|'FAILED', why }.
async function prepareCart(ctx, run, call) {
  let body = cartBody(run), cart, r;
  if (run.cart?.id) {
    // Existing cart (resume after info, or approval after a hold): PUT revalidates prices and stock.
    r = await call("PUT", `/merchant-cart/${run.cart.id}`, body);
    if (r.status === 422 && r.body?.name === "CART_ALREADY_CHECKED_OUT") return { done: (await call("GET", `/merchant-cart/${run.cart.id}`)).body };   // never start a second cart for a paid run
    if (r.status === 404) run.cart = null;
  }
  if (!run.cart?.id) r = await call("POST", "/merchant-cart", body);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (r.status === 422) {
      const ctxt = r.body?.business_context;
      logEvent(run, "cartapi", `Cart API refused the cart: ${ctxt?.user_message || r.body?.message}`);
      return { stop: "FAILED", why: ctxt?.user_message || r.body?.message || "The cart API refused the cart." };
    }
    if (r.status >= 400) { logEvent(run, "cartapi", `Cart API error ${r.status}: ${r.body?.message}`); return { stop: "FAILED", why: r.body?.message || `Cart API error ${r.status}` }; }
    cart = r.body; note(run, cart);
    if (cart.validation_status === "VALID") return { cart };

    // Repairs the buying side may make on its own. Anything else stops and says why.
    const issues = cart.validation_issues || [];
    const missing = issues.find((i) => i.context?.specific_issue === "MISSING_CHECKOUT_FIELDS");
    if (missing && missing.context.required_fields?.includes("ALLERGY_INFORMATION") && !run.allergies) {
      logEvent(run, "cartapi", "The cart has food or formula in it and no allergy information. Waiting for the caseworker.");
      return { stop: "NEEDS_INFO", why: "Allergy information is needed before food or formula can be bought." };
    }
    let changed = false;
    for (const i of issues) {
      const c = i.context || {};
      if (c.specific_issue === "PRICE_MISMATCH") {
        const l = run.lines.find((x) => x.variantId === i.variant_id);
        if (l) { const was = l.unitCents; l.unitCents = Math.round(Number(c.current_price) * 100); l.lineCents = l.unitCents * l.qty; changed = true; logEvent(run, "cartapi", `Price of ${l.name.slice(0, 50)} changed from ${fmt(was)} to ${fmt(l.unitCents)}. Accepted the new price while inside the budget.`, { lineId: l.id }); }
      } else if (c.specific_issue === "ITEM_OUT_OF_STOCK" || c.specific_issue === "VARIANT_NOT_AVAILABLE") {
        const l = run.lines.find((x) => x.variantId === i.variant_id);
        if (!l) continue;
        const alt = (c.suggested_alternatives || [])[0];
        if (alt) { logEvent(run, "cartapi", `${l.name.slice(0, 50)} went out of stock at ${l.domain}. Moved the line to ${alt.split("@")[1]}.`, { lineId: l.id }); l.variantId = alt; l.domain = alt.split("@")[1]; changed = true; }
        else {
          run.lines = run.lines.filter((x) => x !== l); changed = true;
          const n = run.needs.find((x) => x.id === l.needId);
          if (n && !run.lines.some((x) => x.needId === n.id)) { n.status = "declined"; n.reason = `${l.name.slice(0, 80)} went out of stock at ${l.domain} before checkout and no other retailer had it.`; n.nextStep = "Ask again to search for a replacement."; }
          logEvent(run, "decline", `Dropped ${l.name.slice(0, 60)}: out of stock at checkout.`, { needId: l.needId });
        }
      }
    }
    if (!changed) { const why = issues.map((i) => i.user_message || i.message).join(" "); logEvent(run, "cartapi", `Cart is not valid: ${why}`); return { stop: "FAILED", why }; }
    if (!run.lines.length) return { stop: "FAILED", why: "Nothing left to buy after stock checks." };
    if (committed(run) > run.spendableCents) return { stop: "FAILED", why: `Prices rose and the cart is now ${fmt(committed(run))}, above the ${fmt(run.spendableCents)} limit.` };
    r = await call("PUT", `/merchant-cart/${cart.id}`, cartBody(run));
  }
  return { stop: "FAILED", why: "The cart did not validate after several repairs." };
}

async function pay(ctx, run, call, cart) {
  const fund = await ctx.fund();
  const body = { payment_method: { type: "paypal", token: cart.payment_method.token, payer_id: fund.payerId } };
  for (let i = 0; i < 6; i++) {
    const r = await call("POST", `/merchant-cart/${cart.id}/checkout`, body);
    if (r.status === 409) { await sleep(1500); continue; }
    if (r.status === 200 && r.body.status === "COMPLETED") return { ok: true, cart: r.body };
    const why = r.body?.business_context?.user_message || r.body?.message || `Cart API error ${r.status}`;
    logEvent(run, "cartapi", `Checkout refused: ${why}`);
    return { ok: false, why };
  }
  return { ok: false, why: "Checkout was still running after several tries." };
}

// stage 'prepare' builds a valid cart; stage 'pay' captures it. buy() does both unless the run is held.
function recordPaid(run, c) {
  const pc = c.payment_confirmation;
  run.order = { cartId: c.id, merchantOrderNumber: pc.merchant_order_number, paypalOrderId: pc.paypal_order_id, captureId: pc.paypal_capture_id, amount: pc.captured_amount, capturedAt: pc.captured_at, webhook: run.order?.webhook || "pending", webhookAt: run.order?.webhookAt || null };
  note(run, c); run.status = "BOUGHT";
}

export async function buy(ctx, run, { approve = false } = {}) {
  const call = agentClient(ctx, run);
  if (run.order) return run;                       // already paid: a replayed job or a double click buys nothing
  if (!run.lines.length) { run.status = "NOTHING_BOUGHT"; logEvent(run, "done", "Nothing was bought: every need was declined."); await ctx.saveRun(run); return run; }
  run.status = "BUYING"; await ctx.saveRun(run);

  const prep = await prepareCart(ctx, run, call);
  if (prep.done) { recordPaid(run, prep.done); await ctx.saveRun(run); return run; }
  if (prep.stop) {
    run.status = prep.stop; run.failure = prep.why;
    await ctx.saveRun(run); return run;
  }
  logEvent(run, "cartapi", `Cart ${prep.cart.id} is valid at ${fmt(Math.round(Number(prep.cart.totals.total.value) * 100))}. PayPal order ${prep.cart.payment_method.token} created.`);
  if (run.mode === "hold" && !approve) {
    run.status = "AWAITING_APPROVAL"; await ctx.saveRun(run);
    logEvent(run, "done", "Held for the caseworker's approval. Nothing has been charged."); await ctx.saveRun(run);
    return run;
  }
  const paid = await pay(ctx, run, call, prep.cart);
  if (!paid.ok) { run.status = "FAILED"; run.failure = paid.why; await ctx.saveRun(run); return run; }
  const c = paid.cart, pc = c.payment_confirmation;
  recordPaid(run, c);
  logEvent(run, "paypal", `Paid ${fmt(Math.round(Number(pc.captured_amount) * 100))} from the fund through PayPal. Order ${pc.paypal_order_id}, capture ${pc.paypal_capture_id}.`);
  logEvent(run, "done", "Purchase complete.");
  await ctx.saveRun(run);
  return run;
}
