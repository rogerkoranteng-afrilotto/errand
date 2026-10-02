// Produces frontend/fixtures/*.json from REAL runs (Channel3 + PayPal sandbox; rules mode so it is quick and does not
// spend model quota), plus two synthetic states (WORKING, FAILED) that are hard to catch live. Design aid only.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { makeContext, handle, runJob } from "../backend/index.mjs";
import { memoryStore } from "../backend/store.mjs";
import { handleCartApi } from "../backend/cartapi.mjs";
import { SCENARIOS, DEFAULT_DELIVERY } from "../backend/scenarios.mjs";
for (const l of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) process.env[m[1]] = m[2]; }
const dir = new URL("../.deploy-state/", import.meta.url);
const vault = ["vault-token-id", "vault-token-id-shared"].map((f) => new URL(f, dir)).find((u) => existsSync(u));
const env = { ...process.env, TABLE: "none", AGENT_JWT_KEY: readFileSync(new URL("agent-key.b64", dir), "utf8").trim(), VAULT_TOKEN_ID: readFileSync(vault, "utf8").trim() };
const useModel = process.argv.includes("--model");
const bedrock = useModel ? undefined : { converse: async () => { const e = new Error("rules"); e.name = "ThrottlingException"; throw e; } };
const queue = []; let ctx;
ctx = makeContext(env, { store: memoryStore(), bedrock, enqueue: async (j) => { queue.push(j); }, cartCall: async (m, p, b, t) => handleCartApi(ctx, { method: m, path: p, headers: { authorization: `Bearer ${t}` }, rawBody: b ? JSON.stringify(b) : "" }) });
const ev = (method, path, body) => handle(ctx, { requestContext: { http: { method } }, rawPath: path, headers: {}, body: body ? JSON.stringify(body) : undefined });
const drain = async () => { while (queue.length) await runJob(ctx, queue.shift()); };
const make = async (name, sc, over = {}) => {
  const r = await ev("POST", "/api/runs", { request: sc.request, capCents: sc.capCents, reference: sc.reference, mode: sc.mode, delivery: DEFAULT_DELIVERY, authorised: true, allergies: sc.allergies, ...over });
  const id = JSON.parse(r.body).id; await drain();
  const run = JSON.parse((await ev("GET", `/api/runs/${id}`)).body);
  writeFileSync(new URL(`../frontend/fixtures/${name}.json`, import.meta.url), JSON.stringify(run, null, 1));
  console.log(name, run.status, run.lines.length, "lines");
  return run;
};
const [family, tight, hold] = SCENARIOS;
await make("bought", family);
await make("needs-info", hold);
await make("awaiting-approval", hold, { allergies: "None known", reference: "LA-0610" });
await make("nothing-bought", tight, { request: "A man needs his insulin pens and a replacement rescue inhaler after the fire destroyed his home.", reference: "LA-0711" });
const b = JSON.parse(readFileSync(new URL("../frontend/fixtures/bought.json", import.meta.url), "utf8"));
writeFileSync(new URL("../frontend/fixtures/failed.json", import.meta.url), JSON.stringify({ ...b, id: "rfixturefailed", reference: "LA-0815", status: "FAILED", order: null, failure: "PayPal did not accept the payment.", events: [...b.events.slice(0, -3), { t: new Date().toISOString(), kind: "cartapi", text: "Checkout refused: PayPal did not accept the payment." }] }, null, 1));
writeFileSync(new URL("../frontend/fixtures/working.json", import.meta.url), JSON.stringify({ ...b, id: "rfixtureworking", reference: "LA-0902", status: "WORKING", order: null, cart: null, summary: "", submitted: false, needs: b.needs.map((n, i) => (i > 2 ? { ...n, status: "open", reason: "", nextStep: "" } : n)), lines: b.lines.slice(0, 2), events: b.events.slice(0, 9) }, null, 1));
console.log("done");
