// Run the whole stack locally against the real PayPal sandbox, the real Channel3 MCP server and (optionally) Bedrock,
// with an in-memory store and the Cart API called in-process. Usage: node scripts/local-run.mjs <scenario-id> [--rules]
import { readFileSync, existsSync } from "node:fs";
import { makeContext, handle, runJob } from "../backend/index.mjs";
import { memoryStore } from "../backend/store.mjs";
import { handleCartApi } from "../backend/cartapi.mjs";
import { SCENARIOS, DEFAULT_DELIVERY } from "../backend/scenarios.mjs";

for (const l of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) process.env[m[1]] = m[2]; }
const dir = new URL("../.deploy-state/", import.meta.url);
const env = { ...process.env, TABLE: "none", AGENT_JWT_KEY: readFileSync(new URL("agent-key.b64", dir), "utf8").trim(), VAULT_TOKEN_ID: existsSync(new URL("vault-token-id", dir)) ? readFileSync(new URL("vault-token-id", dir), "utf8").trim() : readFileSync(new URL("vault-token-id-shared", dir), "utf8").trim() };
const rules = process.argv.includes("--rules");
const bedrock = rules ? { converse: async () => { const e = new Error("rules mode forced"); e.name = "ThrottlingException"; throw e; } } : undefined;

const queue = [];
let ctx;
ctx = makeContext(env, {
  store: memoryStore(), bedrock,
  enqueue: async (job) => { queue.push(job); },
  cartCall: async (method, path, body, token) => handleCartApi(ctx, { method, path, headers: { authorization: `Bearer ${token}` }, rawBody: body ? JSON.stringify(body) : "" }),
});
const sc = SCENARIOS.find((s) => s.id === process.argv[2]) || SCENARIOS[1];
const ev = (method, path, body) => handle(ctx, { requestContext: { http: { method } }, rawPath: path, headers: {}, body: body ? JSON.stringify(body) : undefined });
const post = await ev("POST", "/api/runs", { request: sc.request, capCents: sc.capCents, reference: sc.reference, mode: sc.mode, delivery: DEFAULT_DELIVERY, authorised: true, allergies: sc.allergies });
console.log("create:", post.statusCode, post.body);
const id = JSON.parse(post.body).id;
const t0 = Date.now();
while (queue.length) await runJob(ctx, queue.shift());
const run = JSON.parse((await ev("GET", `/api/runs/${id}`)).body);
console.log(`\nstatus ${run.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s, model ${run.model.source}, turns ${run.model.turns}`);
for (const e of run.events) console.log(` [${e.kind}] ${e.text}`);
console.log("\nneeds:"); for (const n of run.needs) console.log(` - ${n.label}: ${n.status}${n.reason ? " | " + n.reason : ""}${n.nextStep ? " | next: " + n.nextStep : ""}`);
console.log("lines:"); for (const l of run.lines) console.log(` - ${l.qty} x ${l.name.slice(0, 60)} @ ${l.domain} $${(l.unitCents / 100).toFixed(2)}${l.substitution ? " | SUB: " + l.substitution : ""}`);
console.log("order:", JSON.stringify(run.order), "\nfailure:", run.failure || "-", "\nsummary:", run.summary);
