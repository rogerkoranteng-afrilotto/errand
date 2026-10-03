# BUILD LOG (running)

Project 9 of 10, PayPal AI Hackathon (deadline 12 Nov 2026). Chases two prizes at once: Best Use of Channel3 and Best Use of Agentic Commerce. Name: **Errand**.

## 2026-10-02 What was probed before any code was written

### Channel3
- `trychannel3.com/llms.txt`, `/auth.md`, `/.well-known/mcp/server-card.json` and `/.well-known/api-catalog` all exist and are machine readable. The MCP server is `https://mcp.trychannel3.com/` (Streamable HTTP). **The free tier needs no key.** It exposes `search_products`, `get_products` and three storefront-UI tools (`browse_products`, `get_similar`, `get_details`, `get_price_history`).
- Every result carries a `thread_id` that must be echoed on the next call. The client does this.
- Search is semantic with **no filters**: every constraint goes inside the sentence. It returns up to 8 products with `offers[]` (domain, price, availability, condition), `images[]` with generated **alt_text**, and on `get_products` also description, key_features and structured_attributes.
- **Prices differ between `search_products` and `get_products` for the same product** (Seni underwear: $39.99 in search, $23.99 in detail). The agent therefore never trusts a search price; `add_to_cart` and the Cart API both re-read the live offer.
- The catalogue is noisy in ways that matter: "N95 respirator" in six phrasings returned CPAP filters, steam inhalers, fashion face masks and a breathalyser mouthpiece, **never an N95**. "Albuterol inhaler" returned **veterinary albuterol sold at Tractor Supply and Petco**. Those two results are why the refusal logic exists, and they are the strongest honest-refusal cases in the demo.
- `POST /checkout` is "coming soon, request early access" in Channel3's own docs. **Not available.** The cart's retailer links are recorded, not purchased.
- Self-serve API key: the sign-up form sits behind a Cloudflare Turnstile challenge, so it cannot be completed from this machine. REST access (`x-api-key`, 20,000 hackathon credits via the `#channel3` Discord) therefore was **not obtained**. The MCP free tier is used; the client sends `X-API-Key` if `CHANNEL3_API_KEY` is ever set.

### PayPal Cart API (agentic commerce)
- The live spec has **4 operations, not 42** (createCart, getCart, updateCart, completeCheckout) and 37 component schemas. The "42 endpoints" figure in the brief does not match `developer.paypal.com/api/agentic-commerce/v1/schema.json`.
- `developer.paypal.com/store-sync/integrate` documents what the brief called "the critical inversion", in more detail than the spec: PayPal calls the merchant with `Authorization: Bearer <PayPal JWT>`; the merchant verifies it against **`https://www.paypal.ai/.well-known/jwks.json`** (one RS256 key, kid `5874bc103b80920f`, fetched live and used); under the Orders v2 pattern `createCart` makes a PayPal order and returns its id as `payment_method.token`, and `completeCheckout` captures it. Errors split into `200 + validation_issues` for fixable problems and `422 BusinessError` for hard ones.
- Access to Store Sync / agentic commerce services is gated by a form (`paypal.com/us/business/ai#form`). PayPal's cart service will not call this account. **Unobtainable**; see README.
- Claims inside PayPal's JWT are documented only by one example. The verifier checks signature, RS256-only, `kid`, `exp`, `nbf`, and nothing it cannot cite.
- Order `items[].image_url` is rejected by PayPal (`INVALID_PARAMETER_SYNTAX`) for Channel3 CDN URLs, which have no file extension. Images stay in the run record; the PayPal order omits them.

### PayPal payments
- **Confirmed in the sandbox**: an order created with `intent CAPTURE` and no payment source (status `CREATED`, exactly what the Cart API pattern wants) can be moved to `APPROVED` by `POST /v2/checkout/orders/{id}/confirm-payment-source` with `payment_source.paypal.vault_id` plus `stored_credential` (MERCHANT / SUBSEQUENT / UNSCHEDULED_POSTPAID), then captured. No browser. That is the whole hands-free path.
- Vault: the budget holder's wallet was vaulted once before this build (token `9me21520kn045363h`, created earlier entry on the same sandbox app) and is reused here as the fund. A fresh vaulting needs a human to approve at PayPal; the sandbox login page loads in headless Chromium but its "Create an Account" step never navigated, so no new buyer was created. `scripts/vault.mjs` does the two API steps; the browser approval is manual.
- Webhook slots: 6 of 10 were in use at the start (others are building at the same time; it reached 8 during the session). This project registers one and reuses it on every deploy.

## Architecture decisions
- **Agent = Bedrock Converse tool loop** (Claude Sonnet 4.5), nine tools. The model proposes; code decides. Budget, reserve, stock, "sold for animals", prescription text, required wording, quantity and per-line caps are enforced in `tools.mjs` and again in `cartapi.mjs`.
- **The agent calls the Cart API over HTTP, as PayPal's cart service would.** Because PayPal will not call this account, the agent signs a short-lived RS256 token (`iss errand-agent`, key kept in Lambda env) and calls the Lambda's own Function URL. The merchant side accepts either PayPal's JWKS keys or the agent's key. Nothing on the merchant side is skipped for the agent.
- **Limit in the token, ceiling in the fund, cap re-checked at every step.** Token claim `limit_cents` is the run's spendable amount; the cart remembers the first limit it saw and a later PUT cannot raise it; the fund ceiling ($1,000) binds regardless.
- **Idempotency at three layers**: `PayPal-Request-Id` (order create keyed on cart id + content hash, capture keyed on cart id), a conditional-write state machine on the cart (CREATED/READY -> COMPLETING -> COMPLETED) with a 60 s lock that a crashed attempt loses, and a completed cart answering a replay with its stored confirmation. `ORDER_ALREADY_CAPTURED` is treated as success.
- **Webhook**: store the raw body, answer 200, then an async self-invocation verifies with PayPal's `verify-webhook-signature` (raw bytes spliced into the request, never re-serialised) and attributes the event by `custom_id` prefix `errand:`. Other projects' events are marked `ignored`.
- **Refusal is a first-class outcome** (`decline_need`). A run with every need declined ends `NOTHING_BOUGHT` with no cart and no PayPal call.
- **Fallback**: when Bedrock throttles (10 requests a minute, shared) the run finishes with fixed rules, and the run record, the UI notice and the README say so (`model.source` = `rules` or `hybrid`).
- Money is integer cents everywhere. A 10% reserve of the cap is held back for tax and shipping (Channel3 returns neither) and is never charged.

## Defects found and fixed while building
| # | Found by | Defect | Fix |
|---|---|---|---|
| 1 | live local run | PayPal rejected the order: `items[0].image_url` `INVALID_PARAMETER_SYNTAX` | Dropped `image_url` from order items |
| 2 | first model run | Agent bought "Truly Soft Everyday Sheet Set" after passing `must_have: ["sheet"]` only, so size was never checked | Prompt now says `must_have` carries every hard constraint (size, standard, count, connector); verified the next run passed `["twin","sheet"]` |
| 3 | local run | `NOTHING_BOUGHT` status was set but never saved, so the run stayed `WORKING` forever | Save in `buy()` |
| 4 | local run | Rule-based fallback applied "twin" and "size 4" to every item (zero results) | Constraints are tied to the rule that owns them |
| 5 | first deploy | Every route returned 500: the Lambda runtime passes a callback as the third handler argument and the code read it as an injected context | `handler(event)` now ignores extra arguments; tests call `handle(ctx, event)` |
| 6 | unit test | A vetoed product returned "no usable offer" with no reason | The tool now names the blocking reason |
| 7 | e2e | Limit test used a fixed $15 limit against a $19.99 product | Limit is derived from the real price |

(The UI loop is logged in `frontend/DESIGN-LOG.md`; its rounds and scores are copied into the section below when it finishes.)

## UI review loop (full detail in frontend/DESIGN-LOG.md)
Six rounds, screenshots in `shots/r1`..`r6` at 360/768/1280/1920, light and dark. Scores: r1 5, r2 6.5, r3 7.5, r4-r6 8.5. **Final 8.5 of 10: not the 9 the bar asks for.** Remaining: slashed zero in Atkinson Hyperlegible, 1 MB CDN product photos, empty right column on the How page, no screen-reader pass. Lead review of the final run page found one real product fault, not a visual one: rule-based mode bought "Cocoa Butter Formula with Vitamin E Baby Oil" as infant formula. Fixed (formula rule now needs "infant/baby/toddler formula" and a food category) and covered by a test.

## Final state
Deployed with `./deploy.sh all`. Unit 43, contract 2 (1 with live-schema comparison), sandbox 7, deployed e2e 26 (one transient Channel3 failure on the first run, 19/19 on the re-run; see TEST-RESULTS.md).
Side effect to flag: the front-end sub-agent found port 8787 held by another process and killed it; it may have belonged to something sibling project's dev server.
