# Errand

An agent that buys what someone needs when they cannot buy it themselves.

A caseworker describes what a household needs in plain words. The agent finds real products through **Channel3**, builds a cart, and pays from a relief fund through **PayPal**, inside a budget it cannot exceed. It explains every substitution. When nothing it finds genuinely meets a need, it says so and buys nothing for that item.

|  |  |
|---|---|
| App | https://d3n7w9lu68fwyf.cloudfront.net |
| API (Lambda Function URL) | https://4vvvsttoc52utczl4olukgdsh40jsbam.lambda-url.us-east-1.on.aws/ |
| Cart API base (PayPal-facing) | https://4vvvsttoc52utczl4olukgdsh40jsbam.lambda-url.us-east-1.on.aws/merchant-cart (also `/api/paypal/v1/merchant-cart`) |
| Repository layout, tests, logs | this directory: `BUILD-LOG.md`, `TEST-RESULTS.md`, `frontend/DESIGN-LOG.md` |
| Licence | MIT |

Everything is **PayPal sandbox**. No real money moves and no retailer is contacted. Section "What is real and what is not" says exactly where the line is.

Built for the PayPal AI Hackathon (deadline 12 Nov 2026), aimed at two prizes: Best Use of Channel3 and Best Use of Agentic Commerce.

---

## The situation this is built for

Disaster aid fails on paperwork before it fails on money. These figures are computed from FEMA's own open data (OpenFEMA `IndividualsAndHouseholdsProgramValidRegistrations` v2, disasters declared on or after 1 January 2022, queried 1-2 October 2026) and the Federal Register. The full working is in `research/disaster/FINDINGS.md`, finding 4.

| Figure | What it is | Source |
|---|---|---|
| 61.9% | of registrants were awarded $0 or only a flat payment under $800 (4,701,420 of 7,596,530) | OpenFEMA counts |
| 94.1% | for the January 2025 Los Angeles fires, DR-4856: 245,643 of 261,118 got nothing or one flat $770 | OpenFEMA counts |
| 630,954 | coded denials since 2022 were for process, not loss: 157,217 "needs to submit documentation" and 473,737 "did not respond to FEMA outreach or withdrew" | OpenFEMA `ineligibleReason` codes 3 and 4 |
| $770 / $790 | the flat Serious Needs payment, for disasters declared from 1 Oct 2024 / from 1 Oct 2025 | 89 FR 84922; 91 FR 61431 |

Caveats that apply every time: these are counts computed from FEMA's API, not FEMA headline figures; a $0 award does not mean the household received nothing from anyone (SBA referrals, insurance, charity are not in this data); "did not respond" includes people who withdrew; a household that got exactly the flat amount may have had a small loss.

**What the product does not claim.** It does not fix FEMA's verification problem, decide eligibility, or replace aid. It covers one narrow gap: a caseworker or charity holds a small fund, a household needs ordinary things now (sheets, a charger, formula), and nobody has time to shop for them item by item against a budget. The example households are invented.

---

## What happens in a request

1. The caseworker writes what the household needs, a budget, a delivery address and one of two modes: **buy when ready** or **show me the cart first**. They tick that they are authorised to spend from the fund for this household. They are asked for allergy information; left empty, the agent stops before buying any food or formula and asks.
2. A language model (Claude Sonnet 4.5 on Bedrock, Converse tool use) splits the request into needs and searches Channel3 for each. The server, not the model, decides what may go in the cart.
3. For each need the agent fills it, fills it with a **substitution it must explain**, or **declines** it with a reason and a next step. A refusal is a correct result.
4. The cart is submitted to the **Cart API** (PayPal's agentic-commerce contract, implemented here), which re-reads every price and stock level from Channel3, checks the spend limit, and creates a PayPal order.
5. In "buy when ready" mode the order is paid at once from the fund's vaulted PayPal wallet. In "show me the cart first" mode it waits for **Approve and pay**.
6. PayPal's `PAYMENT.CAPTURE.COMPLETED` webhook arrives, is verified, and shows on the receipt.

If nothing can be bought, the run ends `NOTHING_BOUGHT` with no cart and no PayPal call.

---

## For the submission

Deck copy, kept out of the app on purpose. Paste into the Devpost description and the video script. Sources and caveats are in "The situation this is built for" above and in `research/disaster/FINDINGS.md`, finding 4.

- **61.9%** of people who registered with FEMA after a disaster declared on or after 1 January 2022 were awarded $0 or only a flat payment under $800 (4,701,420 of 7,596,530). Source: OpenFEMA, IndividualsAndHouseholdsProgramValidRegistrations v2, counts computed 1-2 Oct 2026.
- **94.1%** of registrations for the January 2025 Los Angeles fires (DR-4856) got nothing or one flat $770 payment (245,643 of 261,118). Source: OpenFEMA, same dataset.
- **630,954** coded denials since 2022 were for process, not loss: 157,217 needed to submit documentation and 473,737 did not answer FEMA outreach or withdrew. Withdrawals are counted with non-response. Source: OpenFEMA `ineligibleReason` codes 3 and 4.

The $770 / $790 flat Serious Needs figure (89 FR 84922; 91 FR 61431) stays in the app as a note beside the budget field.

---

## Channel3: what was used

Channel3 returns normalised product data (titles, images with alt text, per-retailer offers with price and availability, attributes) from one API.

| Surface | How it is used |
|---|---|
| **MCP server** `https://mcp.trychannel3.com/` (Streamable HTTP, JSON-RPC 2.0) | `backend/channel3.mjs` is an MCP client: `initialize`, `notifications/initialized`, then `tools/call`. It follows Channel3's rule of echoing the `thread_id` from every result into the next call, and retries 429 and 5xx with backoff. |
| `search_products` | One product type per query, constraints inside the sentence (the tool takes no filters). Up to 8 products back. |
| `get_products` | Full detail by id: description, features, attributes, every retailer offer with live price. Called again by `add_to_cart` and by the Cart API on every create and update. |
| Image `alt_text` | Channel3's generated alt text is used on product images in the UI. |

**Where the Channel3 data forced real engineering.** Three things in the live catalogue shaped the design, each checked against the live server on 2 October 2026:

- **Search and detail prices disagree** for the same product (Seni underwear: $39.99 in search, $23.99 in detail). The agent never prices from a search result; `add_to_cart` and the Cart API re-read the live offer.
- **"N95 respirator" returns no N95 respirators.** Six phrasings returned CPAP filters, steam inhalers, fashion face masks, a breathalyser mouthpiece, and Intel "N95" laptops. A matching rule that only looked for the word "N95" would put a $349 laptop in a disaster survivor's cart. The agent declines the need, and `must_have` requires the product noun as well as the constraint (see the test "the word N95 alone would match a laptop").
- **"Albuterol inhaler" returned veterinary albuterol sold at Tractor Supply and Petco on 2 October (the catalogue changes; a later query returned none, and the code does not depend on it).** Offers from animal retailers and text that says prescription-only are refused in code.

**What was not available.**

- **REST API key and the 20,000 hackathon credits.** The sign-up form (`trychannel3.com/sign-up/developer`) sits behind a Cloudflare Turnstile challenge and cannot be completed from this machine. The deployment uses the MCP **free tier, no key**. If a key is ever set as `CHANNEL3_API_KEY`, the client sends it as `X-API-Key`, as Channel3's MCP setup page describes. If the free tier's quota runs out during judging, Channel3's `#channel3` Discord channel is where credits are topped up.
- **Channel3 Checkout** (`POST /checkout`) is "coming soon, request early access" in Channel3's docs. Not available. The retailer link for each line (`buy.trychannel3.com/...`) is recorded on the receipt but nothing is bought from a retailer.
- **Penny Shop, Zamana and Folk**, the example implementations named in the brief, could not be found on Channel3's public site, docs index (`llms.txt`) or developer page, so they were not consulted.

---

## PayPal Cart API (agentic commerce): what was built

PayPal ships three unrelated things under "agentic commerce". Two are not buildable by 12 November: **Agent Ready** (ACP and UCP) runs on Braintree and needs early access plus Google's enablement; the **MCP commerce tools** sell gift cards only. The third is the **PayPal Cart API v1**, `developer.paypal.com/api/agentic-commerce/v1`, and that is what this project implements.

### The direction of the contract

You implement the endpoints; PayPal's cart service calls you, with a PayPal-signed `Authorization: Bearer` JWT that you must verify. The spec has **four operations** (not 42; the brief's figure does not match the live schema, saved at `docs/evidence/agentic-commerce-v1-schema.json`):

| Operation | Method and path | Behaviour here |
|---|---|---|
| `createCart` | `POST /merchant-cart` | Resolves every item against live Channel3 data, totals it, checks the limit, makes a PayPal order and returns its id as `payment_method.token`. **201** when valid, **200 + `validation_issues`** when fixable, **422 BusinessError** when a hard rule is broken. |
| `getCart` | `GET /merchant-cart/{cartId}` | Returns the stored cart, plus `payment_confirmation` once completed. 404 if unknown. |
| `updateCart` | `PUT /merchant-cart/{cartId}` | **Full replacement**, as the spec insists: omitted fields are dropped. Re-prices, re-checks stock. The original spend limit cannot be raised by a later call. |
| `completeCheckout` | `POST /merchant-cart/{cartId}/checkout` | Confirms and captures the order. Returns `status: COMPLETED` with `payment_confirmation` (`merchant_order_number`, `order_review_page`). |

### Authentication: `PayPalJWT`

`backend/jwt.mjs` verifies RS256 bearer tokens with `node:crypto` only. It accepts `alg RS256` and nothing else (so `none` and HS256 key-confusion tokens fail), requires a `kid`, verifies the signature, then `exp`, `nbf`, and an `iat` not in the future. PayPal's public key set is fetched live from **`https://www.paypal.ai/.well-known/jwks.json`** (one key, `kid 5874bc103b80920f`, cached for an hour, refetched once on an unknown `kid`).

PayPal documents the claims inside its token with one example only. The verifier checks signature, algorithm, key id and time claims and **nothing it cannot cite**. It does not check `merchant_id` or `scope`.

### The honest limit: PayPal will not call this account

PayPal's agentic-commerce services are gated behind a request form (`paypal.com/us/business/ai#form`) and onboarding by PayPal's AI team. That enablement was not obtainable. So nothing from PayPal's cart service ever reaches these endpoints, and **no real PayPal-signed token has been seen by this service.**

What was done instead, stated as what it is:

- The **buying side plays PayPal's cart service role.** The agent signs a ten-minute RS256 token (`iss errand-agent`, key held in the Lambda's environment, public half published at `/.well-known/jwks.json`) and calls the Lambda's **own public Function URL over HTTP**, using the same four endpoints. Nothing on the merchant side is skipped for it: prices, stock, limits, the PayPal order and the capture are all handled inside the Cart API.
- The merchant side trusts **two issuers**: PayPal's JWKS keys, and the agent's key. A request with a token signed by neither is refused.
- The PayPal-issued path is tested only with an **injected** key set (a locally generated key pair standing in for PayPal's), and the live deployment is tested to **reject** forgeries that claim PayPal's real key id. Whether PayPal's real tokens carry claims this verifier would refuse is unknown until PayPal calls the endpoint.
- It is **not** claimed that this service is registered with PayPal, listed in Store Sync, or reachable from ChatGPT or Gemini.

### How closely the responses follow PayPal's schema

`tests/contract.test.mjs` validates, against PayPal's published OpenAPI document, the requests the buying side sends and sixteen kinds of response the merchant side returns (201, 200 with each issue type, 400, 401, 404, 422, completed checkout and its replay). The deployed e2e validates live responses the same way. This test caught one real deviation while building: a cart whose every item was unresolvable came back with `items: []`, which `PayPalCart.items` (`minItems: 1`) forbids. Unresolved items now stay in the response, flagged by an issue.

Parts of the type system in use:

| Type | Used for |
|---|---|
| `validation_status` `VALID` / `INVALID` / `REQUIRES_ADDITIONAL_INFORMATION`; `status` `CREATED` / `READY` / `INCOMPLETE` / `COMPLETED` | cart lifecycle |
| `INVENTORY_ISSUE` / `ITEM_OUT_OF_STOCK` with `suggested_alternatives` (the same product at another retailer) and `VARIANT_NOT_AVAILABLE` | stock lost between search and checkout; the buying side moves the line to the suggested retailer |
| `PRICING_ERROR` / `PRICE_MISMATCH` with `ACCEPT_NEW_PRICE` and `cost_impact` | Channel3 prices move; the buying side accepts a new price only while the cart stays inside its limit |
| `BUSINESS_RULE_ERROR` / `PURCHASE_LIMIT_EXCEEDED` (`exceeds_by`) and `MAXIMUM_QUANTITY_EXCEEDED` | the budget cap, enforced as a 422 |
| `DATA_ERROR` / `ITEM_NOT_FOUND`, `INVALID_ITEM_DATA`, `MISSING_CHECKOUT_FIELDS` | unknown product; animal and prescription items; missing fields |
| `SHIPPING_ERROR` / `MISSING_SHIPPING_ADDRESS` | no delivery address |
| `PAYMENT_ERROR` / `PAYMENT_METHOD_NOT_ACCEPTED`, `PAYMENT_DECLINED` | wrong payer, wrong token, PayPal refusal |
| `CheckoutField` `TERMS_ACCEPTANCE` | required; set from the caseworker's authorisation tick |
| `CheckoutField` `ALLERGY_INFORMATION` | **required whenever the cart holds food or formula**; without it the cart is `REQUIRES_ADDITIONAL_INFORMATION` and the run stops and asks the caseworker |
| `CheckoutField` `DELIVERY_INSTRUCTIONS` | passed from the form; `DELIVERY_DATE_PREFERENCE` is accepted and echoed but the agent never sets it |

**Not implemented:** coupons and `applied_coupons`, gift options, age verification, custom engraving and sizing fields (a cart that sends them gets the field back `REJECTED`), geo-coordinates, Braintree. Responses for 401 and 409, which the spec does not define, use the spec's `Error` shape. `payment_method.type` echoes the casing the caller used (the schema says `paypal`; PayPal's guide writes `PAYPAL`).

---

## PayPal payments: how an agent pays with nobody at a browser

An agent cannot start a new PayPal-wallet payment without a human in a browser. So the human is involved **once**, earlier:

1. **Vault.** The budget holder approves their PayPal wallet once; PayPal returns a payment token (`/v3/vault/payment-tokens`). Only the PayPal wallet is vaulted. Card vaulting is not enabled on this account (403) and no card is touched.
2. **Order, not yet approved.** `createCart` makes an Orders v2 order (`intent CAPTURE`, status `CREATED`). This is exactly PayPal's documented Cart API pattern.
3. **Confirm against the vault.** `completeCheckout` calls `POST /v2/checkout/orders/{id}/confirm-payment-source` with the `vault_id` and a merchant-initiated `stored_credential`. The order becomes `APPROVED` with no browser. (Confirmed in the sandbox on 2 October 2026.)
4. **Capture** with `PayPal-Request-Id`. Done.

Only the **vaulted fund account** may pay this way. A checkout that names any other `payer_id` on an unapproved order is refused 422. An order that a human already approved is simply captured.

**The vaulted wallet is shared.** Vaulting needs a person to approve at PayPal's sandbox login. The sandbox login page loaded in headless Chromium but its "Create an Account" step never navigated, so no new buyer was created. This deployment reuses the wallet vaulted for the Holdfast entry (same sandbox app, same business account). `scripts/vault.mjs` performs the two API steps for a fresh vaulting; the browser approval in between is manual.

### One purchase, even if everything is replayed

| Layer | What it does |
|---|---|
| `PayPal-Request-Id` | Order creation is keyed on cart id plus a hash of the cart's content; capture on cart id. PayPal returns the original result for a repeated id. |
| Cart state machine | `CREATED / READY` to `COMPLETING` to `COMPLETED` by conditional DynamoDB writes. A second request meets a live lock and gets 409; a crashed attempt's lock expires after 60 seconds and the next attempt takes over, safely, because every PayPal call underneath is idempotent. |
| Completed cart | Answers every replay with the stored confirmation. PayPal's capture endpoint is never reached again. |
| `ORDER_ALREADY_CAPTURED` | Treated as success: the service reads the order and returns the existing capture. |
| Run layer | `buy()` returns immediately if the run already has an order; `approve` is a conditional status change, so a double click is a 409. |

Proved in `TEST-RESULTS.md`: four sequential replays and six concurrent checkouts, on the deployed stack, each ending with exactly one capture at PayPal.

### Webhooks

The listener (`POST /api/webhooks/paypal`) stores the raw body, **answers 200 at once**, and hands verification to an asynchronous self-invocation. That job calls PayPal's `verify-webhook-signature` with the **raw bytes spliced in as text** (re-serialising a parsed object changes key order and fails verification), then attributes the event by `custom_id` prefix `errand:`. Webhooks are per app, so other projects' events arrive here too; those are acknowledged and marked `ignored`. A tampered payload is rejected (`signature FAILURE`), and so is a forged event with no signature headers. `GET /api/webhooks/recent` lists the last events and their states.

Webhook slots on the shared sandbox app were nearly full (6 of 10 at the start, 8 by the end). `scripts/register-webhook.mjs` reuses an existing registration for the URL and refuses to take an eleventh.

### Not used

Payouts, Invoicing, Subscriptions and Log in with PayPal work on this account but have no job here. `/v1/reporting/transactions` returns 403 and is not used.

---

## The agent

Claude Sonnet 4.5 (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) through Bedrock Converse with nine tools. The model proposes; code decides.

| Tool | Does |
|---|---|
| `record_needs` | Splits the request into needs with ids and quantities |
| `search_products` | Channel3 search for one product type; returns up to 8 results, each with price, retailer, `problems` and `missing_requirements` |
| `get_product_details` | Channel3 `get_products` for up to 6 products |
| `compare_substitutes` | Side by side: price, pack count, price per unit, retailer, requirement match; sorted |
| `check_budget` | Cap, reserve, spendable, in cart, remaining |
| `add_to_cart` | Adds a line, or refuses (see below) |
| `remove_from_cart` | Takes a line out |
| `decline_need` | The refusal: a reason and what to do instead |
| `complete_checkout` | Submits the cart for payment; the agent never pays directly |

### What the server refuses whatever the model says

| Rule | Enforced in | Test |
|---|---|---|
| A line over the remaining budget | `tools.mjs add_to_cart`, again in `cartapi.mjs` as a 422 | unit: "a line over the remaining budget is refused by the server"; e2e: update over the original limit |
| A product that does not mention every `must_have` word | `add_to_cart` | unit: "does not mention the required word"; "N95 laptop" |
| Animal retailers and text; prescription-only text; not new; not in stock | `policy.mjs blockReasons`, in the tool and in the Cart API | unit: "veterinary and prescription items cannot be added" |
| A product that never appeared in a search this run | `add_to_cart` | unit |
| The search-time price | `add_to_cart` re-reads the live offer | unit: "the live price is re-read" |
| Quantity above 12, a fund ceiling of $1,000 per cart | tool, Cart API | unit |
| Food in the cart without allergy information | Cart API (`REQUIRES_ADDITIONAL_INFORMATION`) | unit and deployed e2e |

**Reserve.** One tenth of the cap is held back for tax and shipping, which Channel3 does not return. It is never charged: the PayPal order total is exactly the sum of the lines.

**Prompt injection.** Product text comes from retailers. The system prompt says to treat it as data, and none of the controls above depend on the prompt: a hijacked model still cannot exceed the limit, buy an animal product, or skip the Cart API.

**When the model is unavailable.** The Bedrock account is limited to about 10 requests a minute, shared. When the model throttles, the run finishes with a small set of fixed rules (`agent.mjs RULES`: respirators, sheets, formula, diapers, wipes, charger, cookware, and a refusal for prescription medicine). The run record, the interface notice and the summary all say so (`model.source` is `rules` or `hybrid`). Rule-based mode only recognises those items; anything else in the request is not bought. It is a safety net, not a second agent. The summary shown for a run is labelled when the system rather than the model wrote it.

---

## Architecture

```
 browser  ->  CloudFront -> S3                      React + Vite single page
    |
    | fetch (JSON)
    v
 Lambda Function URL  (one function, Node 22, no API Gateway)
    |--  /api/*              runs, config, status         DynamoDB (on demand, one table)
    |--  /merchant-cart...   PayPal Cart API v1 (inbound)   ^
    |--  /api/webhooks/paypal  200 first, verify after     |
    |--  async self-invocations: run, approve, resume, webhook
    |
    |-> Bedrock Converse (tool use)   Channel3 MCP   PayPal REST (orders, vault, webhooks)
    '-> its own Function URL, with a signed token, as PayPal's cart service would
```

| Path | |
|---|---|
| `backend/channel3.mjs` | MCP client and product normalisation |
| `backend/jwt.mjs` | RS256 verification, PayPal JWKS, the agent's issuer |
| `backend/cartapi.mjs` | the four endpoints, validation, order creation, checkout state machine |
| `backend/policy.mjs` | block rules, requirement matching, budget, reserve |
| `backend/tools.mjs` | the nine tools and the run state they change |
| `backend/agent.mjs` | the Converse loop, the rule-based fallback |
| `backend/purchase.mjs` | the buying side: create, repair, hold, pay |
| `backend/index.mjs` | routes, async jobs, webhook listener |
| `frontend/` | the interface (`DESIGN-LOG.md` has the review rounds) |
| `scripts/` | `vault.mjs`, `register-webhook.mjs`, dev server, fixtures, UI checks |
| `tests/` | unit, contract, sandbox, deployed e2e |
| `deploy.sh` | the whole deployment with the plain `aws` CLI |

---

## Run it

```bash
# tests that need no network
npm test                                   # unit.test.mjs
node --test tests/contract.test.mjs        # responses against PayPal's saved schema
# against the PayPal sandbox, PayPal's JWKS and Channel3's MCP server
npm run test:sandbox
# against the deployed stack (needs .deploy-state/ and AWS credentials)
npm run test:e2e

# local API with an in-memory store, real Channel3 and PayPal sandbox
node scripts/dev-server.mjs [--rules] [--seed]     # http://localhost:8787
cd frontend && npm i && VITE_API=http://localhost:8787 npm run dev

# deploy (account 854924711083, us-east-1)
./deploy.sh all
```

Credentials are read from `../../.env` and passed to the Lambda's environment by `deploy.sh`. Nothing is committed. `.deploy-state/` (agent signing key, vault token id, URLs) is gitignored.

---

## Interface, accessibility and writing

Olive and dusty rose on a lichen-cream ledger, serif headings (Newsreader) over a hyperlegible body face (Atkinson Hyperlegible), both bundled with no external requests. Dusty rose is the only signal colour and appears only on refusals, errors and failures. Dark mode follows the system and has a manual toggle. Review rounds and honest scores are in `frontend/DESIGN-LOG.md`; screenshots at 360, 768, 1280 and 1920 px in light and dark are in `shots/r1` to `shots/r6`.

**Self-score: 8.5 of 10, not the 9 the standing bar asks for.** What still falls short: Atkinson draws a slashed zero, so "$0.00" looks odd beside the serif figures; product photos are up to 1 MB from Channel3's CDN and show a grey tile until they arrive; the How page leaves the right side empty on wide screens; no screen reader (NVDA, VoiceOver) was run, only DOM roles and labels were checked.

Measured by `node scripts/ui-check.mjs` (output in `TEST-RESULTS.md`):

- **Type:** body 13 pt (17.3 px); nothing below 10 pt (13.3 px).
- **Controls:** every button, link, input, checkbox and radio at least 28 x 28 pt (37.4 px), checked in the DOM at four widths.
- **200% text:** each page checked at 200% text size at every width; no horizontal scroll, no clipped text.
- **Not by colour alone:** every status has an icon and a word.
- **Keyboard:** everything reachable, skip link, 3 px focus ring offset onto the page.
- **Images:** product images carry Channel3's generated alt text.
- **Writing:** plain, no persuasion around money, no telemetry in the main layout; the agent's step log sits behind a disclosure labelled as an audit trail.

Contrast, computed from the real hex values in `frontend/src/styles.css` (4.5 for text up to 17 pt, 3 for large or bold text and for control boundaries):

| Theme | Pair | Foreground | Background | Ratio | Needs | Used for |
|---|---|---|---|---|---|---|
| light | ink on page | #1D2113 | #EFEEE2 | 14.07:1 | 4.5 | body text on page |
| light | ink on surface | #1D2113 | #F8F7EF | 15.28:1 | 4.5 | body text on panels and inputs |
| light | ink-2 on page | #4A5037 | #EFEEE2 | 7.22:1 | 4.5 | secondary text on page |
| light | ink-2 on surface | #4A5037 | #F8F7EF | 7.84:1 | 4.5 | secondary text on panels |
| light | ink-2 on bar-free | #4A5037 | #DAD9C2 | 5.89:1 | 4.5 | disabled button text |
| light | ink on bar-free | #1D2113 | #DAD9C2 | 11.48:1 | 4.5 | secondary button hover |
| light | on-primary on primary | #FFFFFF | #4F5B1E | 7.37:1 | 4.5 | primary button text |
| light | ok-text on ok-tint | #333D0C | #E0E6BE | 8.95:1 | 4.5 | bought chip and mark |
| light | ok-text on page | #333D0C | #EFEEE2 | 9.92:1 | 4.5 | bought mark on page |
| light | signal on signal-tint | #7E2A3C | #F3DCE0 | 7.06:1 | 4.5 | refusal, error and failed text |
| light | signal on page | #7E2A3C | #EFEEE2 | 7.88:1 | 4.5 | not-bought mark on page |
| light | accent on surface | #A8475C | #F8F7EF | 5.25:1 | 3 | rose border and icon on panels |
| light | accent on page | #A8475C | #EFEEE2 | 4.84:1 | 3 | rose underline on page |
| light | accent on signal-tint | #A8475C | #F3DCE0 | 4.33:1 | 3 | rose border on its tint |
| light | edge on surface | #6E7456 | #F8F7EF | 4.55:1 | 3 | input and control borders |
| light | edge on page | #6E7456 | #EFEEE2 | 4.19:1 | 3 | control borders on page |
| light | primary on page | #4F5B1E | #EFEEE2 | 6.32:1 | 3 | olive links and marks |
| light | bar-fill on bar-free | #4F5B1E | #DAD9C2 | 5.16:1 | 3 | budget bar fill on track |
| dark | ink on page | #E8E9D8 | #14170E | 14.74:1 | 4.5 | body text on page |
| dark | ink on surface | #E8E9D8 | #1D2114 | 13.34:1 | 4.5 | body text on panels and inputs |
| dark | ink-2 on page | #B5B8A0 | #14170E | 8.91:1 | 4.5 | secondary text on page |
| dark | ink-2 on surface | #B5B8A0 | #1D2114 | 8.07:1 | 4.5 | secondary text on panels |
| dark | ink-2 on bar-free | #B5B8A0 | #333A22 | 5.84:1 | 4.5 | disabled button text |
| dark | ink on bar-free | #E8E9D8 | #333A22 | 9.65:1 | 4.5 | secondary button hover |
| dark | on-primary on primary | #14170E | #B7C46A | 9.60:1 | 4.5 | primary button text |
| dark | ok-text on ok-tint | #D8E39A | #2B3417 | 9.57:1 | 4.5 | bought chip and mark |
| dark | ok-text on page | #D8E39A | #14170E | 13.27:1 | 4.5 | bought mark on page |
| dark | signal on signal-tint | #F0B6C3 | #3A1E26 | 8.74:1 | 4.5 | refusal, error and failed text |
| dark | signal on page | #F0B6C3 | #14170E | 10.52:1 | 4.5 | not-bought mark on page |
| dark | accent on surface | #D9788E | #1D2114 | 5.49:1 | 3 | rose border and icon on panels |
| dark | accent on page | #D9788E | #14170E | 6.07:1 | 3 | rose underline on page |
| dark | accent on signal-tint | #D9788E | #3A1E26 | 5.04:1 | 3 | rose border on its tint |
| dark | edge on surface | #7F8566 | #1D2114 | 4.26:1 | 3 | input and control borders |
| dark | edge on page | #7F8566 | #14170E | 4.70:1 | 3 | control borders on page |
| dark | primary on page | #B7C46A | #14170E | 9.60:1 | 3 | olive links and marks |
| dark | bar-fill on bar-free | #B7C46A | #333A22 | 6.28:1 | 3 | budget bar fill on track |

---

## What is real and what is not

**Real:** the Channel3 product data and prices; the language model's decisions; the PayPal sandbox orders, captures and webhook signatures; the Cart API implementation and its contract tests; the DynamoDB state.

**Not real, by necessity:**
- The money is PayPal **sandbox**. The payee is the sandbox business account that owns the app, not a retailer.
- **No retailer is contacted or paid.** Channel3 Checkout is not available. A real deployment would put a merchant of record (Channel3 Checkout once it ships, or each retailer) behind the order.
- PayPal's cart service does not call this service (onboarding required); the agent calls it instead.
- Tax and shipping are not modelled. The reserve stands in for them.
- The vaulted wallet is a shared sandbox buyer.
- The households are invented. No names are collected: the form asks for a case reference and warns against entering a name.

## Known gaps

- Part of a run can happen in rule-based mode if Bedrock throttles; this is disclosed on the run but it does reduce quality.
- A unit price is only shown when a pack count can be read from the title; many products do not state one.
- A PayPal order that is created and never paid (a held cart that is cancelled) is left to expire; no void call exists for `CREATED` orders.
- The unit test suite documents one limit it does not close: a lone constraint word such as "n95" matches an Intel laptop; the noun in `must_have` is what stops it, and that depends on the model supplying it. The system prompt requires it and the tools reject the laptop when it does.
- The history list shows the last 30 requests; there is no pagination.
