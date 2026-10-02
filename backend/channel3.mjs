// Channel3 over MCP (Streamable HTTP, JSON-RPC 2.0). Server: https://mcp.trychannel3.com/
// Verified live on 2 Oct 2026: initialize -> notifications/initialized -> tools/call.
// Tools used: search_products (one product type per call, up to 8 cards) and get_products (full detail by id, up to 40).
// The free tier needs no key. If CHANNEL3_API_KEY is set it is sent as X-API-Key, per Channel3's MCP setup page.
// Every result carries a thread_id that must be passed back on the next call; this client does that.

const URL_DEFAULT = "https://mcp.trychannel3.com/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const toCents = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 100));

// Channel3 returns SSE ("event: message\ndata: {...}") for tools/call and JSON-RPC for errors; accept both.
export function parseRpcBody(text) {
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const datas = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter((l) => l.startsWith("{"));
  if (!datas.length) throw new Error(`channel3: empty MCP response: ${t.slice(0, 120)}`);
  return JSON.parse(datas[datas.length - 1]);
}

export function normalizeProduct(p) {
  const offers = (p.offers || []).map((o) => ({
    url: o.url,
    domain: o.domain,
    priceCents: toCents(o.price?.price),
    compareAtCents: toCents(o.price?.compare_at_price),
    currency: o.price?.currency || "USD",
    availability: o.availability || "Unknown",
    condition: o.condition || "unknown",
  })).filter((o) => o.priceCents !== null);
  const images = (p.images || []).map((i) => ({ url: i.cleaned_url || i.url, alt: i.alt_text || "", main: !!i.is_main_image, shot: i.shot_type || "" }));
  const attrs = [];
  for (const [k, v] of Object.entries(p.structured_attributes || {})) attrs.push(`${k}: ${[].concat(v).join(", ")}`);
  return {
    id: p.id,
    title: p.title || "",
    brands: (p.brands || []).map((b) => b.name),
    description: p.description || "",
    category: (p.category?.path || []).map((c) => c.title).join(" > "),
    age: p.age || null,
    keyFeatures: p.key_features || [],
    attributes: attrs,
    materials: p.materials || [],
    images,
    offers,
    variants: p.variants || null,
  };
}

// Text the requirement check runs against. Lower-cased, one blob.
export function productText(p) {
  return [p.title, p.brands.join(" "), p.description, p.keyFeatures.join(" "), p.attributes.join(" "), p.category, p.materials.join(" ")].join(" \n ").toLowerCase();
}

export function createChannel3({ url = URL_DEFAULT, apiKey = "", fetchImpl = fetch, retries = 3 } = {}) {
  let sid = null, threadId = null, seq = 10, inited = null;

  async function post(body, withSession = true) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (apiKey) headers["x-api-key"] = apiKey;
    if (withSession && sid) headers["mcp-session-id"] = sid;
    let last;
    for (let i = 0; i <= retries; i++) {
      try {
        const r = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body) });
        if (r.status === 429 || r.status >= 500) { last = new Error(`channel3 HTTP ${r.status}`); await sleep(400 * 2 ** i); continue; }
        if (r.status === 404 && withSession) { sid = null; inited = null; throw Object.assign(new Error("channel3 session expired"), { expired: true }); }
        const text = await r.text();
        if (!r.ok) throw new Error(`channel3 HTTP ${r.status}: ${text.slice(0, 160)}`);
        return { res: r, json: text ? parseRpcBody(text) : null };
      } catch (e) { if (e.expired) throw e; last = e; if (i < retries) await sleep(400 * 2 ** i); }
    }
    throw last;
  }

  async function init() {
    if (inited) return inited;
    inited = (async () => {
      const { res } = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "errand", version: "1.0.0" } } }, false);
      sid = res.headers.get("mcp-session-id");
      await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    })();
    try { await inited; } catch (e) { inited = null; throw e; }
    return inited;
  }

  async function call(name, args, again = true) {
    await init();
    if (threadId) args = { ...args, thread_id: threadId };
    try {
      const { json } = await post({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } });
      if (json.error) throw new Error(`channel3 ${name}: ${json.error.message}`);
      const r = json.result;
      if (r.isError) throw new Error(`channel3 ${name}: ${r.content?.[0]?.text?.slice(0, 200)}`);
      const tid = r.content?.map((c) => c.text || "").join("\n").match(/thread_id:\s*(thr_[\w-]+)/);
      if (tid) threadId = tid[1];
      return r.structuredContent || {};
    } catch (e) { if (e.expired && again) return call(name, args, false); throw e; }
  }

  return {
    // One product type per query; constraints go inside the sentence (the tool takes no filters).
    async search(query) {
      const sc = await call("search_products", { query });
      return (sc.products || []).map(normalizeProduct);
    },
    async details(ids) {
      const sc = await call("get_products", { product_ids: ids.slice(0, 40) });
      return (sc.products || []).map(normalizeProduct);
    },
    get threadId() { return threadId; },
  };
}
