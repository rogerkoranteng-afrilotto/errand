// Registers (or reuses) this project's PayPal webhook. Slots are per app and capped at 10, so it reuses an existing
// registration for the same URL and refuses to register an eleventh. Usage: node scripts/register-webhook.mjs <api-url>
import { readFileSync, writeFileSync } from "node:fs";
import { createPayPal, cfg } from "../backend/paypal.mjs";
for (const l of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) process.env[m[1]] = m[2]; }
const api = (process.argv[2] || readFileSync(new URL("../.deploy-state/api-url", import.meta.url), "utf8")).trim().replace(/\/$/, "");
const url = `${api}/api/webhooks/paypal`;
const pp = createPayPal(cfg());
const { webhooks = [] } = await pp.listWebhooks();
console.log(`${webhooks.length} webhooks registered on this app (limit 10)`);
let hook = webhooks.find((w) => w.url === url);
if (hook) console.log("reusing", hook.id);
else {
  if (webhooks.length >= 10) { console.error("webhook cap reached: prune an unused one first (scripts/register-webhook.mjs does not delete other projects' hooks)"); process.exit(1); }
  hook = await pp.registerWebhook(url, ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED", "CHECKOUT.ORDER.APPROVED", "CHECKOUT.ORDER.COMPLETED"]);
  console.log("registered", hook.id);
}
writeFileSync(new URL("../.deploy-state/webhook-id", import.meta.url), hook.id + "\n");
