// Deterministic rules the model cannot talk its way around: what counts as a purchasable product, whether it
// literally mentions what the caseworker needs, and what a cart may cost. Pure functions, tested without a network.
import { productText } from "./channel3.mjs";

export const RESERVE_PCT = 10;        // held back from the cap for tax and shipping, which Channel3 does not return. Never charged.
export const MAX_QTY = 12;
export const FUND_CEILING_CENTS = 100_000;   // no single cart above $1,000, whatever the request says

export const fmt = (c) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const dollars = (c) => (c / 100).toFixed(2);

export function budgetOf(capCents) {
  const cap = Math.max(0, Math.min(Math.round(capCents), FUND_CEILING_CENTS));
  const reserve = Math.floor((cap * RESERVE_PCT) / 100);
  return { capCents: cap, reserveCents: reserve, spendableCents: cap - reserve };
}

const ANIMAL_DOMAINS = /(^|\.)(petco|petsmart|chewy|tractorsupply|petmeds|entirelypets|1800petmeds|petsuppliesplus|allivet|valleyvet|jefferspet)\.com$/i;
const ANIMAL_TEXT = /\b(veterinar\w*|for (?:dogs|cats|horses|pets|livestock|cattle)|equine|canine|feline|livestock|pet (?:medication|supplies))\b|animals? & pet supplies/i;
const RX_TEXT = /\b(prescription only|rx only|by prescription|prescription drug|inhalation aerosol|hfa inhal\w*|sulfate hfa|legend drug)\b/i;
const FOOD_TEXT = /\b(formula|baby food|infant cereal|snack|food|beverage|nutrition|vitamin|supplement|drink)\b/i;

// Reasons an offer cannot be bought for this purpose. Empty array means it may be considered.
export function blockReasons(product, offer) {
  const why = [];
  const text = `${product.title} ${product.description} ${product.category}`;
  if (!offer) return ["no offer"];
  if (offer.condition && offer.condition !== "new") why.push(`sold as ${offer.condition}, not new`);
  if (offer.availability !== "InStock") why.push(`not in stock (${offer.availability})`);
  if (ANIMAL_DOMAINS.test(offer.domain || "") || ANIMAL_TEXT.test(text)) why.push("sold for animals, not people");
  if (RX_TEXT.test(text)) why.push("prescription medicine; this agent cannot buy it");
  return why;
}
export const isIngestible = (product) => FOOD_TEXT.test(`${product.title} ${product.category}`);

// Offer an agent should price from: cheapest in-stock new offer that nothing blocks. Optionally pinned to a retailer.
export function bestOffer(product, domain) {
  const ok = (product.offers || []).filter((o) => (!domain || o.domain === domain) && blockReasons(product, o).length === 0);
  return ok.sort((a, b) => a.priceCents - b.priceCents)[0] || null;
}

// Each requirement is a term the product text must literally contain. "a|b" means either. Returns the ones missing.
export function missingRequirements(product, terms) {
  const t = productText(product);
  return (terms || []).filter((req) => !String(req).toLowerCase().split("|").some((alt) => alt.trim() && t.includes(alt.trim())));
}

// Pack size read from the title or description, for a per-unit comparison. null when it cannot be read.
export function packCount(product) {
  const t = `${product.title} ${product.description}`.toLowerCase();
  const m = /\b(\d{1,4})\s*[- ]?(?:count|ct|pack|pk|pieces|pcs|diapers|masks|respirators|wipes|sheets|cans?)\b/.exec(t) || /\bpack of (\d{1,4})\b/.exec(t);
  const n = m ? Number(m[1]) : null;
  return n && n > 1 && n <= 1000 ? n : null;
}

export function compactProduct(p, { domain, terms } = {}) {
  const offer = bestOffer(p, domain);
  const any = offer || p.offers?.[0] || null;
  const blocked = any ? blockReasons(p, any) : ["no offer"];
  const miss = terms?.length ? missingRequirements(p, terms) : [];
  const n = packCount(p);
  return {
    id: p.id,
    title: p.title.slice(0, 110),
    brand: p.brands.join("/") || null,
    price: any ? dollars(any.priceCents) : null,
    retailer: any?.domain || null,
    other_offers: (p.offers || []).filter((o) => o !== any).slice(0, 3).map((o) => `${dollars(o.priceCents)} ${o.domain}`),
    pack_count: n,
    unit_price: n && any ? (any.priceCents / n / 100).toFixed(2) : null,
    problems: blocked.length ? blocked : undefined,
    missing_requirements: miss.length ? miss : undefined,
    category: p.category.split(" > ").slice(-2).join(" > "),
  };
}
