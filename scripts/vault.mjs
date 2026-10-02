// Vault the budget holder's PayPal SANDBOX wallet once, so the agent can pay with nobody at a browser afterwards.
//   node scripts/vault.mjs                 creates a setup token and prints the approval URL
//   (the budget holder opens it, logs in to a sandbox buyer account and approves; PayPal redirects to the return URL
//    with ?approval_token_id=<setup token>)
//   node scripts/vault.mjs --finish <id>   exchanges the approved setup token for a payment token and saves its id to
//                                          .deploy-state/vault-token-id
// Only the PayPal wallet is vaulted. Card vaulting is not enabled on this account (it returns 403) and no card is touched.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createPayPal, cfg } from "../backend/paypal.mjs";
for (const l of readFileSync(new URL("../../../.env", import.meta.url), "utf8").split("\n")) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) process.env[m[1]] = m[2]; }
const pp = createPayPal(cfg());
const i = process.argv.indexOf("--finish");
if (i < 0) {
  const st = await pp.createSetupToken("https://example.org/errand-approved", "https://example.org/errand-cancelled");
  console.log("setup token:", st.id, "\nopen this URL and approve as the budget holder:\n", st.links.find((l) => l.rel === "approve" || l.rel === "payer-action").href);
} else {
  const t = await pp.createPaymentToken(process.argv[i + 1], `errand-vault-${process.argv[i + 1]}`);
  mkdirSync(new URL("../.deploy-state/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../.deploy-state/vault-token-id", import.meta.url), t.id + "\n");
  console.log("payment token", t.id, "payer", t.payment_source?.paypal?.payer_id, "saved to .deploy-state/vault-token-id");
}
