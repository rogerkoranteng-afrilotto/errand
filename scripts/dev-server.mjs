// Local API for front-end work: the real handler on http://localhost:8787 with an in-memory store, real Channel3,
// real PayPal sandbox, Cart API called in-process. Flags: --rules (never call Bedrock), --seed (load fixtures/*.json).
import http from "node:http";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { makeContext, handle, runJob } from "../backend/index.mjs";
import { memoryStore } from "../backend/store.mjs";
import { handleCartApi } from "../backend/cartapi.mjs";

for (const l of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) process.env[m[1]] = m[2]; }
const dir = new URL("../.deploy-state/", import.meta.url);
const vault = ["vault-token-id", "vault-token-id-shared"].map((f) => new URL(f, dir)).find((u) => existsSync(u));
const env = { ...process.env, TABLE: "none", AGENT_JWT_KEY: readFileSync(new URL("agent-key.b64", dir), "utf8").trim(), VAULT_TOKEN_ID: readFileSync(vault, "utf8").trim() };
const rules = process.argv.includes("--rules");
const bedrock = rules ? { converse: async () => { const e = new Error("rules mode"); e.name = "ThrottlingException"; throw e; } } : undefined;
const store = memoryStore();
let ctx;
ctx = makeContext(env, {
  store, bedrock,
  enqueue: async (job) => { setImmediate(() => runJob(ctx, job).catch((e) => console.error("job", e))); },
  cartCall: async (method, path, body, token) => handleCartApi(ctx, { method, path, headers: { authorization: `Bearer ${token}` }, rawBody: body ? JSON.stringify(body) : "" }),
});
if (process.argv.includes("--seed")) {
  const fx = new URL("../frontend/fixtures/", import.meta.url);
  if (existsSync(fx)) for (const f of readdirSync(fx).filter((x) => x.endsWith(".json"))) { const r = JSON.parse(readFileSync(new URL(f, fx), "utf8")); await ctx.saveRun({ seen: {}, ...r }); console.log("seeded", r.id, r.status); }
}
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const u = new URL(req.url, "http://x");
  res.setHeader("access-control-allow-origin", "*"); res.setHeader("access-control-allow-headers", "content-type,authorization"); res.setHeader("access-control-allow-methods", "GET,POST,PUT,OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const r = await handle(ctx, { requestContext: { http: { method: req.method } }, rawPath: u.pathname, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") || undefined });
  res.writeHead(r.statusCode, r.headers); res.end(r.body);
}).listen(8787, () => console.log("errand dev API on :8787", rules ? "(rules mode)" : "(Bedrock)"));
