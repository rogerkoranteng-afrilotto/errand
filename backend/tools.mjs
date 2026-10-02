// The agent's tools and the run state they change. Every rule that protects the budget lives here or in
// cartapi.mjs, in code. The model proposes; these functions decide.
import { blockReasons, bestOffer, missingRequirements, compactProduct, packCount, fmt, dollars, MAX_QTY } from "./policy.mjs";

export const TOOL_SPECS = [
  { name: "record_needs", description: "First call. Split the caseworker's request into separate needs, one per product type. Each need gets a short id (letters, digits, hyphen), a plain label and a quantity.",
    schema: { type: "object", properties: { needs: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, quantity: { type: "integer", minimum: 1 }, notes: { type: "string" } }, required: ["id", "label", "quantity"] } } }, required: ["needs"] } },
  { name: "search_products", description: "Search Channel3's catalogue for ONE product type. Put every constraint (size, count, material, price ceiling) inside the query sentence; the catalogue takes no filters. Returns up to 8 products with price, retailer and problems. Results are noisy; judge them.",
    schema: { type: "object", properties: { need_id: { type: "string" }, query: { type: "string" }, must_have: { type: "array", items: { type: "string" }, description: "Words a correct product must literally mention. Use 'a|b' for either. Each result reports which are missing." } }, required: ["need_id", "query"] } },
  { name: "get_product_details", description: "Full detail for up to 6 products: description, features, attributes, every retailer offer with live price. Use when a title does not settle whether a product meets the need.",
    schema: { type: "object", properties: { product_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 } }, required: ["product_ids"] } },
  { name: "compare_substitutes", description: "Side-by-side of candidate products for one need: price, pack count, price per unit, retailer, and whether each mentions the must_have words. Sorted so qualifying, cheapest-per-unit products come first.",
    schema: { type: "object", properties: { need_id: { type: "string" }, product_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 }, must_have: { type: "array", items: { type: "string" } } }, required: ["need_id", "product_ids"] } },
  { name: "check_budget", description: "The cap, the reserve held back for tax and shipping, what is already in the cart, and what is left to spend.",
    schema: { type: "object", properties: {} } },
  { name: "add_to_cart", description: "Put a product in the cart for a need. The server re-reads the live price, refuses anything out of stock, sold for animals, prescription-only, or that does not mention every must_have word, and refuses anything that would go over budget. Set substitution_note whenever you are not buying exactly what was asked.",
    schema: { type: "object", properties: { need_id: { type: "string" }, product_id: { type: "string" }, quantity: { type: "integer", minimum: 1 }, retailer: { type: "string", description: "Optional domain, e.g. target.com. Default is the cheapest in-stock offer." }, must_have: { type: "array", items: { type: "string" } }, why: { type: "string", description: "One plain sentence: why this product meets the need." }, substitution_note: { type: "string", description: "Only if this is not what was asked: what was asked, what is being bought, and why." } }, required: ["need_id", "product_id", "quantity", "must_have", "why"] } },
  { name: "remove_from_cart", description: "Take a line out of the cart, for example to replace it with a better one.",
    schema: { type: "object", properties: { line_id: { type: "string" } }, required: ["line_id"] } },
  { name: "decline_need", description: "Refuse to buy for a need because nothing found genuinely meets it, or it cannot be bought by this agent. Give the reason in plain words and what the caseworker should do instead. This is a correct outcome, not a failure.",
    schema: { type: "object", properties: { need_id: { type: "string" }, reason: { type: "string" }, next_step: { type: "string" } }, required: ["need_id", "reason"] } },
  { name: "complete_checkout", description: "Call once, when every need is filled or declined. Submits the cart. You never pay directly: the system pays through PayPal under the budget rules. Give a short plain summary for the caseworker.",
    schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } },
];

export const toolConfig = () => ({ tools: TOOL_SPECS.map((t) => ({ toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.schema } } })) });

export function newRun({ id, reference, request, capCents, budget, mode, delivery, instructions, allergies, now }) {
  return {
    id, reference, request, mode,
    capCents: budget.capCents, reserveCents: budget.reserveCents, spendableCents: budget.spendableCents,
    delivery, instructions: instructions || "", allergies: allergies || null,
    status: "QUEUED", createdAt: now, updatedAt: now,
    needs: [], lines: [], seen: {}, events: [], model: { source: "bedrock", turns: 0, notes: [] }, cart: null, order: null, summary: "", submitted: false,
  };
}

export const committed = (run) => run.lines.reduce((s, l) => s + l.lineCents, 0);
export const remaining = (run) => run.spendableCents - committed(run);
export function logEvent(run, kind, text, extra = {}) { run.events.push({ t: new Date().toISOString(), kind, text, ...extra }); if (run.events.length > 200) run.events.splice(0, run.events.length - 200); }

// Keep stored product records small: they live in the run item.
function remember(run, p) {
  const keep = { id: p.id, title: p.title, brands: p.brands, description: p.description.slice(0, 450), category: p.category, age: p.age, keyFeatures: p.keyFeatures.slice(0, 6), attributes: p.attributes.slice(0, 8), materials: p.materials.slice(0, 4), images: p.images.slice(0, 2), offers: p.offers.slice(0, 6), variants: null };
  run.seen[p.id] = keep;
  const ids = Object.keys(run.seen);
  if (ids.length > 90) for (const old of ids.slice(0, ids.length - 90)) delete run.seen[old];
  return keep;
}
const needOf = (run, id) => run.needs.find((n) => n.id === id);
const fail = (msg, extra = {}) => ({ ok: false, error: msg, ...extra });

export async function execTool(ctx, run, name, input) {
  input = input || {};
  switch (name) {
    case "record_needs": {
      if (run.needs.length) return fail("Needs are already recorded.");
      const seen = new Set(), needs = [];
      for (const n of input.needs || []) {
        const id = String(n.id || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 32);
        if (!id || seen.has(id)) return fail(`Need ids must be unique and non-empty (got "${n.id}").`);
        seen.add(id);
        needs.push({ id, label: String(n.label || id).slice(0, 120), qty: Math.max(1, Math.min(MAX_QTY, Number(n.quantity) || 1)), notes: n.notes ? String(n.notes).slice(0, 200) : "", status: "open", reason: "", nextStep: "" });
      }
      if (!needs.length) return fail("Record at least one need.");
      run.needs = needs;
      logEvent(run, "need", `Read the request as ${needs.length} need${needs.length === 1 ? "" : "s"}: ${needs.map((n) => n.label).join("; ")}.`);
      return { ok: true, needs: needs.map((n) => ({ id: n.id, label: n.label, quantity: n.qty })) };
    }
    case "search_products": {
      const need = needOf(run, input.need_id);
      if (!need) return fail(`Unknown need_id "${input.need_id}". Known: ${run.needs.map((n) => n.id).join(", ")}`);
      const query = String(input.query || "").slice(0, 300);
      if (!query) return fail("query is empty.");
      const found = await ctx.channel3.search(query);
      const terms = (input.must_have || []).map(String);
      const rows = found.map((p) => { remember(run, p); return compactProduct(p, { terms }); });
      const usable = rows.filter((r) => !r.problems && !r.missing_requirements).length;
      logEvent(run, "search", `Searched Channel3 for "${query}": ${found.length} results, ${usable} usable.`, { needId: need.id });
      return { ok: true, query, results: rows, note: usable === 0 ? "No result passed the checks. Rephrase once, or decline the need." : undefined };
    }
    case "get_product_details": {
      const ids = (input.product_ids || []).slice(0, 6).map(String);
      const ps = await ctx.channel3.details(ids);
      const out = ps.map((p) => {
        remember(run, p);
        return { ...compactProduct(p), description: p.description.slice(0, 500), key_features: p.keyFeatures.slice(0, 8), attributes: p.attributes.slice(0, 8), offers: p.offers.slice(0, 6).map((o) => ({ retailer: o.domain, price: dollars(o.priceCents), stock: o.availability, condition: o.condition, problems: blockReasons(p, o).length ? blockReasons(p, o) : undefined })) };
      });
      logEvent(run, "check", `Read full details for ${out.length} product${out.length === 1 ? "" : "s"}.`);
      return { ok: true, products: out };
    }
    case "compare_substitutes": {
      const need = needOf(run, input.need_id);
      if (!need) return fail(`Unknown need_id "${input.need_id}".`);
      const ids = (input.product_ids || []).slice(0, 6).map(String);
      const missing = ids.filter((id) => !run.seen[id]);
      if (missing.length) { for (const p of await ctx.channel3.details(missing)) remember(run, p); }
      const terms = (input.must_have || []).map(String);
      const rows = ids.filter((id) => run.seen[id]).map((id) => compactProduct(run.seen[id], { terms }));
      rows.sort((a, b) => (!!a.problems - !!b.problems) || (!!a.missing_requirements - !!b.missing_requirements) || (Number(a.unit_price ?? a.price ?? 9e9) - Number(b.unit_price ?? b.price ?? 9e9)));
      logEvent(run, "check", `Compared ${rows.length} candidates for "${need.label}".`, { needId: need.id });
      return { ok: true, compared: rows, note: "Sorted: usable first, then by price per unit when the pack count is known, otherwise by price." };
    }
    case "check_budget": {
      return { ok: true, cap: dollars(run.capCents), reserve_for_tax_and_shipping: dollars(run.reserveCents), spendable: dollars(run.spendableCents), in_cart: dollars(committed(run)), remaining: dollars(remaining(run)), lines: run.lines.map((l) => ({ line_id: l.id, need_id: l.needId, name: l.name, qty: l.qty, line_total: dollars(l.lineCents) })) };
    }
    case "add_to_cart": {
      const need = needOf(run, input.need_id);
      if (!need) return fail(`Unknown need_id "${input.need_id}".`);
      if (need.status === "declined") return fail("This need was declined. It cannot get a cart line.");
      const qty = Number(input.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return fail(`quantity must be a whole number from 1 to ${MAX_QTY}.`);
      if (!input.why || String(input.why).trim().length < 8) return fail("why is required: one plain sentence on why this product meets the need.");
      if (!run.seen[input.product_id]) return fail(`Product ${input.product_id} has not appeared in a search in this run. Search first.`);
      // Re-read the live offer. Search prices were seen to differ from detail prices for the same product.
      let p = run.seen[input.product_id];
      try { const live = (await ctx.channel3.details([p.id]))[0]; if (live) p = remember(run, live); } catch { /* fall back to the search-time record */ }
      const offer = input.retailer ? p.offers.find((o) => o.domain === input.retailer) : bestOffer(p);
      if (!offer) {
        if (input.retailer) return fail(`${p.title} has no offer from ${input.retailer}.`);
        const why = [...new Set(p.offers.flatMap((o) => blockReasons(p, o)))];
        return fail(`Cannot buy ${p.title}: ${why.length ? why.join("; ") : "it has no offer"}.`);
      }
      const blocked = blockReasons(p, offer);
      if (blocked.length) return fail(`Cannot buy this: ${blocked.join("; ")}.`);
      const miss = missingRequirements(p, input.must_have || []);
      if (miss.length) return fail(`The product text does not mention: ${miss.join(", ")}. Do not buy it for this need.`);
      if (!(input.must_have || []).length) return fail("must_have is required: list at least one word a correct product must mention.");
      const variantId = `${p.id}@${offer.domain}`;
      if (run.lines.some((l) => l.needId === need.id && l.variantId === variantId)) return fail("That product is already in the cart for this need.");
      const lineCents = offer.priceCents * qty;
      if (lineCents > remaining(run)) return fail(`Over budget: this line is ${fmt(lineCents)} and ${fmt(remaining(run))} is left to spend. Choose something cheaper, a smaller quantity, or decline.`, { remaining: dollars(remaining(run)) });
      const main = p.images.find((i) => i.main) || p.images[0];
      const sub = input.substitution_note && String(input.substitution_note).trim() ? String(input.substitution_note).trim().slice(0, 400) : null;
      const line = { id: `L${run.lines.length + 1}-${Math.random().toString(36).slice(2, 5)}`, needId: need.id, productId: p.id, variantId, name: p.title, brand: p.brands.join("/"), domain: offer.domain, qty, unitCents: offer.priceCents, lineCents, image: main?.url || null, alt: main?.alt || p.title, url: offer.url, why: String(input.why).trim().slice(0, 300), substitution: sub, requirements: input.must_have };
      run.lines.push(line);
      need.status = sub ? "substituted" : "filled";
      logEvent(run, "cart", `Added ${qty} x ${p.title.slice(0, 70)} from ${offer.domain} at ${fmt(offer.priceCents)} each (${fmt(lineCents)}). ${fmt(remaining(run))} left.`, { needId: need.id, lineId: line.id });
      return { ok: true, line_id: line.id, line_total: dollars(lineCents), remaining: dollars(remaining(run)), live_unit_price: dollars(offer.priceCents) };
    }
    case "remove_from_cart": {
      const i = run.lines.findIndex((l) => l.id === input.line_id);
      if (i < 0) return fail(`No line ${input.line_id}.`);
      const [gone] = run.lines.splice(i, 1);
      const need = needOf(run, gone.needId);
      if (need && !run.lines.some((l) => l.needId === need.id)) need.status = "open";
      logEvent(run, "cart", `Removed ${gone.name.slice(0, 70)} from the cart.`, { needId: gone.needId });
      return { ok: true, remaining: dollars(remaining(run)) };
    }
    case "decline_need": {
      const need = needOf(run, input.need_id);
      if (!need) return fail(`Unknown need_id "${input.need_id}".`);
      if (run.lines.some((l) => l.needId === need.id)) return fail("This need already has a cart line. Remove it first.");
      if (!input.reason || String(input.reason).trim().length < 8) return fail("Give the reason in plain words.");
      need.status = "declined"; need.reason = String(input.reason).trim().slice(0, 500); need.nextStep = String(input.next_step || "").trim().slice(0, 300);
      logEvent(run, "decline", `Declined "${need.label}": ${need.reason}`, { needId: need.id });
      return { ok: true };
    }
    case "complete_checkout": {
      const open = run.needs.filter((n) => n.status === "open");
      if (!run.needs.length) return fail("Call record_needs first.");
      if (open.length) return fail(`These needs are still open: ${open.map((n) => `${n.id} (${n.label})`).join("; ")}. Fill or decline each.`);
      run.summary = String(input.summary || "").trim().slice(0, 800);
      run.submitted = true;
      return { ok: true, message: run.lines.length ? (run.mode === "hold" ? "Cart submitted. It will wait for the caseworker's approval before any payment." : "Cart submitted for payment.") : "Nothing to buy. The request is closed with every need declined." };
    }
    default: return fail(`Unknown tool ${name}.`);
  }
}
