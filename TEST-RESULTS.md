# Test results

Run on 2 October 2026. Every block below is pasted output, unedited apart from trimming the TAP header. API: `https://4vvvsttoc52utczl4olukgdsh40jsbam.lambda-url.us-east-1.on.aws/`.

**Failures, stated plainly**
- The first full deployed run had **one failure**: `updateCart over the ORIGINAL limit...` got HTTP 200 instead of 201 because live Channel3 `get_products` returned "no product 5twqWfj" for an id it had just returned from search. That is a transient Channel3 inconsistency, not a defect in this service (the service correctly reported `ITEM_NOT_FOUND`). The same suite re-run without the agent section passed 19 of 19; both outputs are below.
- An earlier deployed run caught two real test defects (a limit set below the product price, and a terms field missing the schema's required `terms_version`). Both were test bugs and are fixed.
- The contract test caught one real service defect (empty `items` array), fixed before these runs; see BUILD-LOG.
- UI self-score is 8.5 of 10, below the 9 the standing bar asks for. See `frontend/DESIGN-LOG.md`.

## 1. Unit tests (offline): `node --test tests/unit.test.mjs`
```
✔ jwt: an agent-signed token verifies; payload, signature, alg and expiry attacks are rejected (31.59656ms)
✔ jwt: a token signed by PayPal's key (injected JWKS) verifies; the same kid signed by another key does not (53.574532ms)
✔ policy: the reserve is 10% of the cap and the ceiling holds (1.039348ms)
✔ policy: animals, prescription text, stock and condition block an offer (0.927762ms)
✔ policy: requirement words must appear in the product text; a|b means either (0.514034ms)
✔ channel3: SSE and JSON bodies parse; products normalise to integer cents with real alt text (0.329696ms)
✔ tools: a line over the remaining budget is refused by the server, not by the model (41.312524ms)
✔ tools: a product that does not mention the required word is refused (37.571106ms)
✔ tools: the word N95 alone would match a laptop; the product noun in must_have stops it (31.532495ms)
✔ tools: veterinary and prescription items cannot be added even if the model insists (40.744401ms)
✔ tools: a product never seen in a search cannot be bought; quantity and why are validated (47.091851ms)
✔ tools: a substitution is recorded, the need turns 'substituted', and the live price is re-read (14.701124ms)
✔ tools: a need cannot be declined while it has a line; complete_checkout lists open needs (22.389971ms)
✔ cart api: no token, a bad token and a wrong route are refused before any work (59.628056ms)
✔ cart api createCart: a valid cart returns 201, PayPal's order id as the token, and totals from live Channel3 prices (40.202336ms)
✔ cart api: a price that moved is PRICING_ERROR/PRICE_MISMATCH with ACCEPT_NEW_PRICE and no order is made (33.171511ms)
✔ cart api: out of stock returns INVENTORY_ISSUE/ITEM_OUT_OF_STOCK with another retailer suggested (14.89436ms)
✔ cart api: unknown, veterinary and over-quantity items each get their own typed issue (21.336512ms)
✔ cart api: a cart over the token's limit is refused with 422 PURCHASE_LIMIT_EXCEEDED and creates no PayPal order (46.945246ms)
✔ cart api: the fund ceiling binds even a token that claims a higher limit (31.09966ms)
✔ cart api: food with no allergy information is REQUIRES_ADDITIONAL_INFORMATION; adding it makes the cart valid (94.277655ms)
✔ cart api: PUT replaces the whole cart (omitted fields are dropped) and cannot raise the original limit (19.15267ms)
✔ cart api checkout: the vaulted fund account pays; a different payer_id on an unapproved order is refused (71.694491ms)
✔ cart api checkout: a REPLAYED checkout purchases once and returns the same confirmation (25.186674ms)
✔ cart api checkout: eight CONCURRENT checkouts capture once (30.199805ms)
✔ cart api checkout: if PayPal already captured (duplicate refusal), that is treated as success (13.754859ms)
✔ cart api checkout: a declined payment returns 422 PAYMENT_DECLINED and the cart can be retried (36.4498ms)
✔ cart api: checkout on an invalid cart is refused and getCart reports completion (64.008013ms)
✔ purchase: a held run creates the cart and order but charges nothing; approving it buys once, and approving again buys nothing more (24.606137ms)
✔ purchase: food in the cart with no allergy information stops the run in NEEDS_INFO; supplying it completes the purchase (81.408366ms)
✔ purchase: a price that moved between search and checkout is accepted only while inside the limit (40.744989ms)
✔ purchase: stock lost at checkout moves the line to another retailer when one has it (28.184323ms)
✔ purchase: nothing to buy means no cart and no PayPal call (23.740717ms)
✔ agent: a scripted model that tries to overspend is stopped by the server and finishes within budget (47.264907ms)
✔ agent: when the model is throttled mid-run, the rules finish it and the run says so (22.840901ms)
✔ agent: rule-based mode declines prescription medicine and reports what it could not read (32.32455ms)
✔ agent: rule-based mode will not buy baby oil because its name contains 'formula' (19.203484ms)
✔ agent: a model that never calls complete_checkout still ends with every need closed explicitly (24.746751ms)
✔ http: the new-request form is validated server-side (28.321377ms)
✔ http: approve, info and cancel only work in the right state, and approve is accepted once (33.464401ms)
✔ http: the run list is small rows, newest first; the full run hides the product cache (26.180014ms)
✔ webhook: the listener answers 200 at once and stores the raw body; verification happens afterwards (35.98399ms)
✔ webhook: a TAMPERED payload fails verification and is rejected; another app's event is ignored (14.211167ms)
ℹ tests 43
ℹ suites 0
ℹ pass 43
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1571.213958
```

## 2. Contract tests against PayPal's published schema: `LIVE_SCHEMA=1 node --test tests/contract.test.mjs`
```
      saved copy sha256 aa1d9b07907e1281..., 3 paths, 37 schemas
      createCart valid -> 201
      createCart price moved -> 200
      createCart food without allergy info -> 200
      createCart unknown + restricted + oversize -> 200
      createCart no address -> 200
      createCart over limit -> 422
      createCart empty items -> 400
      getCart -> 200
      getCart 404 -> 404
      updateCart -> 200
      updateCart over limit -> 422
      checkout wrong token -> 422
      checkout missing payer_id -> 400
      checkout -> 200
      checkout replay -> 200
      401 body -> 401
✔ the saved schema is the one PayPal publishes (set LIVE_SCHEMA=1 to compare) (648.980834ms)
✔ every response the merchant side produces validates against PayPal's schema (188.659332ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1030.512741
```

## 3. PayPal sandbox, PayPal JWKS, Channel3 MCP: `node --test tests/sandbox.test.mjs`
```
      https://www.paypal.ai/.well-known/jwks.json -> kid 5874bc103b80920f
✔ PayPal JWKS: the published signing key is reachable and is RS256 (1785.867873ms)
      vault 9me21520kn045363h payer PE7HVYAQSEA96
✔ vault: the fund's token is a PayPal wallet with a payer id (no card) (885.722655ms)
      two creates with one Request-Id -> 8GW09731CL540224J both times
✔ orders: the same PayPal-Request-Id returns the SAME order, not a second one (1218.699975ms)
      order 19143968MD898252P captured as 55U38965J45228714
      replay with the same Request-Id -> same capture id
      replay with a new Request-Id -> 422 ORDER_ALREADY_CAPTURED (the service treats this as success)
✔ hands-free payment: CREATED order -> confirm with vault -> APPROVED -> capture COMPLETED, no browser (5289.616481ms)
✔ orders: Channel3 CDN image URLs are rejected by PayPal, which is why order items carry no image_url (408.450244ms)
      forged event -> FAILURE
✔ webhook verification: PayPal refuses a request whose headers do not match any real delivery (368.694162ms)
      N95 query: 8 results, an actual N95 respirator among them: false, Intel "N95" laptops among them: 2; albuterol query: 0 of 8 sold at pet/farm retailers
✔ Channel3 MCP: search then get_products on the same thread; price comes back in cents; the N95 and inhaler cases behave as documented (9086.887366ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 19137.852978
```

## 4. Deployed stack, full run (Lambda, DynamoDB, Bedrock, Channel3, PayPal): `node tests/e2e.deployed.mjs`
```
API https://4vvvsttoc52utczl4olukgdsh40jsbam.lambda-url.us-east-1.on.aws
fund payer PE7HVYAQSEA96

PASS  Channel3 MCP: search_products returns normalised products with prices and real alt text
        thread thr_273b24b0-dbc7-4ab6-bd91-0a6b40d67da0; cheapest 5twqWfj Samsung USB-C Wall Charger with Cable, 15W, Black $19.97 at bestbuy.com

-- Cart API: authentication (PayPalJWT)
PASS  no Authorization header -> 401
PASS  garbage bearer -> 401
PASS  a JWT claiming PayPal's real key id but signed by a stranger's key -> 401 bad_signature
        PayPal kid 5874bc103b80920f: Bearer token rejected: bad_signature
PASS  a genuine agent token with its payload edited (limit raised) -> 401
        Bearer token rejected: bad_signature
PASS  an expired agent token -> 401
        Bearer token rejected: expired
PASS  alg=none token -> 401

-- Cart API: createCart, getCart, updateCart (limits), completeCheckout (idempotency)
PASS  createCart with a valid token -> 201, live Channel3 price, PayPal order id as payment_method.token
        CART-MUQGYOGQDB7C20 total $19.97, PayPal order 1RP560040F125900B (CREATED)
PASS  getCart returns the same cart
PASS  getCart for an unknown id -> 404
FAIL  updateCart over the ORIGINAL limit is refused 422 even with a token claiming a bigger limit
        {"id":"CART-MUQGYQJS327873","status":"INCOMPLETE","validation_status":"INVALID","validation_issues":[{"code":"DATA_ERROR","type":"INVALID_DATA","message":"Channel3 has no product 5twqWfj","user_messag: got 200, wanted 201
PASS  updateCart replaces the cart: omitting shipping_address drops it and reports SHIPPING_ERROR
PASS  checkout by a payer who is not the vaulted fund account -> 422, nothing captured
PASS  checkout -> 200 COMPLETED with payment_confirmation; PayPal shows exactly one capture
        ERR-MUQGYOGQDB7C20, capture 8NR34851J8320562J, $19.97
PASS  REPLAYED checkout x4 (sequential) returns the identical confirmation and PayPal still shows ONE capture
PASS  SIX CONCURRENT checkouts on a fresh cart produce one capture
        statuses 200,409,409,409,409,409; captures 1

-- Webhook listener
PASS  PayPal's real PAYMENT.CAPTURE.COMPLETED for this purchase arrives, verifies and is attributed to this app
        PAYMENT.CAPTURE.COMPLETED confirmed for order 1RP560040F125900B; first delivery arrived on its own
PASS  a TAMPERED copy of that event (amount edited, headers untouched) is answered 200 and then REJECTED
        HTTP 200 in 305 ms, then state=rejected reason="signature FAILURE"
PASS  a forged event with no PayPal signature headers at all is answered 200 and rejected
        PayPal POST /v1/notifications/verify-webhook-signature 400 must match "^(?!\d+$)\w+\S+": Request is not well-formed, syntactically incorrect, or violates schema

-- The agent (Bedrock tool use, Channel3 MCP, Cart API, PayPal)
PASS  family of four: buys what it can inside the budget, refuses the inhaler, and every purchase matches PayPal
        model bedrock/10 turns; 5 lines $166.25 of $693.00; declined: N95 masks for ash clearing | Albuterol rescue inhaler
PASS  the same purchase, replayed through the Cart API after the run, buys nothing more
PASS  the run's order shows PayPal's webhook confirmation
        events PAYMENT.CAPTURE.COMPLETED
PASS  hold flow: food in the cart + no allergy information stops in NEEDS_INFO with no charge
        Allergy information is needed before food or formula can be bought.
PASS  supplying the allergy information moves it to AWAITING_APPROVAL (mode=hold): cart and PayPal order exist, nothing is captured
        order 8EK68099XF224740W created, 0 captures
PASS  approve -> BOUGHT; a second approve is refused 409; PayPal shows one capture
        capture 0PN38460WE4500234 $70.88
PASS  a request nobody can fulfil (insulin, inhaler) ends NOTHING_BOUGHT with no cart and no PayPal order
        Insulin pens: Insulin pens are prescription medication and cannot be purchased throu | Replacement rescue inhaler: Rescue inhalers are prescription medication and cannot be purchased th

25 passed, 1 failed
```

## 5. Deployed stack, Cart API and webhook section re-run: `node tests/e2e.deployed.mjs --skip-agent`
```
API https://4vvvsttoc52utczl4olukgdsh40jsbam.lambda-url.us-east-1.on.aws
fund payer PE7HVYAQSEA96

PASS  Channel3 MCP: search_products returns normalised products with prices and real alt text
        thread thr_0bc5fb44-1194-4425-a33c-eedd205d869a; cheapest 5twqWfj Samsung USB-C Wall Charger with Cable, 15W, Black $19.97 at bestbuy.com

-- Cart API: authentication (PayPalJWT)
PASS  no Authorization header -> 401
PASS  garbage bearer -> 401
PASS  a JWT claiming PayPal's real key id but signed by a stranger's key -> 401 bad_signature
        PayPal kid 5874bc103b80920f: Bearer token rejected: bad_signature
PASS  a genuine agent token with its payload edited (limit raised) -> 401
        Bearer token rejected: bad_signature
PASS  an expired agent token -> 401
        Bearer token rejected: expired
PASS  alg=none token -> 401

-- Cart API: createCart, getCart, updateCart (limits), completeCheckout (idempotency)
PASS  createCart with a valid token -> 201, live Channel3 price, PayPal order id as payment_method.token
        CART-MUQH2ZAX32BF85 total $19.97, PayPal order 2G463335LM1015050 (CREATED)
PASS  getCart returns the same cart
PASS  getCart for an unknown id -> 404
PASS  updateCart over the ORIGINAL limit is refused 422 even with a token claiming a bigger limit
        exceeds_by 214.67
PASS  updateCart replaces the cart: omitting shipping_address drops it and reports SHIPPING_ERROR
PASS  checkout by a payer who is not the vaulted fund account -> 422, nothing captured
PASS  checkout -> 200 COMPLETED with payment_confirmation; PayPal shows exactly one capture
        ERR-MUQH2ZAX32BF85, capture 3T103526356085546, $19.97
PASS  REPLAYED checkout x4 (sequential) returns the identical confirmation and PayPal still shows ONE capture
PASS  SIX CONCURRENT checkouts on a fresh cart produce one capture
        statuses 200,409,409,409,409,409; captures 1

-- Webhook listener
PASS  PayPal's real PAYMENT.CAPTURE.COMPLETED for this purchase arrives, verifies and is attributed to this app
        PAYMENT.CAPTURE.COMPLETED confirmed for order 2G463335LM1015050; first delivery arrived on its own
PASS  a TAMPERED copy of that event (amount edited, headers untouched) is answered 200 and then REJECTED
        HTTP 200 in 297 ms, then state=rejected reason="signature FAILURE"
PASS  a forged event with no PayPal signature headers at all is answered 200 and rejected
        PayPal POST /v1/notifications/verify-webhook-signature 400 must match "^[a-zA-Z0-9]+$": Request is not well-formed, syntactically incorrect, or violates schema.

19 passed, 0 failed
```

## 6. Interface: `node scripts/ui-check.mjs` (contrast from real CSS values, then DOM checks at 360/768/1280/1920, light and dark, with 200% text)
```
CONTRAST (WCAG 2.x, from frontend/src/styles.css)
PASS  dark tokens identical in manual and automatic dark blocks
PASS  light ink #1D2113 on page #EFEEE2  14.07:1 (need 4.5)  body text on page
PASS  light ink #1D2113 on surface #F8F7EF  15.28:1 (need 4.5)  body text on panels and inputs
PASS  light ink-2 #4A5037 on page #EFEEE2  7.22:1 (need 4.5)  secondary text on page
PASS  light ink-2 #4A5037 on surface #F8F7EF  7.84:1 (need 4.5)  secondary text on panels
PASS  light ink-2 #4A5037 on bar-free #DAD9C2  5.89:1 (need 4.5)  disabled button text
PASS  light ink #1D2113 on bar-free #DAD9C2  11.48:1 (need 4.5)  secondary button hover
PASS  light on-primary #FFFFFF on primary #4F5B1E  7.37:1 (need 4.5)  primary button text
PASS  light ok-text #333D0C on ok-tint #E0E6BE  8.95:1 (need 4.5)  bought chip and mark
PASS  light ok-text #333D0C on page #EFEEE2  9.92:1 (need 4.5)  bought mark on page
PASS  light signal #7E2A3C on signal-tint #F3DCE0  7.06:1 (need 4.5)  refusal, error and failed text
PASS  light signal #7E2A3C on page #EFEEE2  7.88:1 (need 4.5)  not-bought mark on page
PASS  light accent #A8475C on surface #F8F7EF  5.25:1 (need 3)  rose border and icon on panels
PASS  light accent #A8475C on page #EFEEE2  4.84:1 (need 3)  rose underline on page
PASS  light accent #A8475C on signal-tint #F3DCE0  4.33:1 (need 3)  rose border on its tint
PASS  light edge #6E7456 on surface #F8F7EF  4.55:1 (need 3)  input and control borders
PASS  light edge #6E7456 on page #EFEEE2  4.19:1 (need 3)  control borders on page
PASS  light primary #4F5B1E on page #EFEEE2  6.32:1 (need 3)  olive links and marks
PASS  light bar-fill #4F5B1E on bar-free #DAD9C2  5.16:1 (need 3)  budget bar fill on track
PASS  dark  ink #E8E9D8 on page #14170E  14.74:1 (need 4.5)  body text on page
PASS  dark  ink #E8E9D8 on surface #1D2114  13.34:1 (need 4.5)  body text on panels and inputs
PASS  dark  ink-2 #B5B8A0 on page #14170E  8.91:1 (need 4.5)  secondary text on page
PASS  dark  ink-2 #B5B8A0 on surface #1D2114  8.07:1 (need 4.5)  secondary text on panels
PASS  dark  ink-2 #B5B8A0 on bar-free #333A22  5.84:1 (need 4.5)  disabled button text
PASS  dark  ink #E8E9D8 on bar-free #333A22  9.65:1 (need 4.5)  secondary button hover
PASS  dark  on-primary #14170E on primary #B7C46A  9.60:1 (need 4.5)  primary button text
PASS  dark  ok-text #D8E39A on ok-tint #2B3417  9.57:1 (need 4.5)  bought chip and mark
PASS  dark  ok-text #D8E39A on page #14170E  13.27:1 (need 4.5)  bought mark on page
PASS  dark  signal #F0B6C3 on signal-tint #3A1E26  8.74:1 (need 4.5)  refusal, error and failed text
PASS  dark  signal #F0B6C3 on page #14170E  10.52:1 (need 4.5)  not-bought mark on page
PASS  dark  accent #D9788E on surface #1D2114  5.49:1 (need 3)  rose border and icon on panels
PASS  dark  accent #D9788E on page #14170E  6.07:1 (need 3)  rose underline on page
PASS  dark  accent #D9788E on signal-tint #3A1E26  5.04:1 (need 3)  rose border on its tint
PASS  dark  edge #7F8566 on surface #1D2114  4.26:1 (need 3)  input and control borders
PASS  dark  edge #7F8566 on page #14170E  4.70:1 (need 3)  control borders on page
PASS  dark  primary #B7C46A on page #14170E  9.60:1 (need 3)  olive links and marks
PASS  dark  bar-fill #B7C46A on bar-free #333A22  6.28:1 (need 3)  budget bar fill on track

DOM CHECKS (http://localhost:4391/, API http://localhost:8787)
done  light 360px: 9 pages + 200% text zoom
done  light 768px: 9 pages + 200% text zoom
done  light 1280px: 9 pages + 200% text zoom
done  light 1920px: 9 pages + 200% text zoom
done  dark 360px: 9 pages + 200% text zoom
done  dark 768px: 9 pages + 200% text zoom
done  dark 1280px: 9 pages + 200% text zoom
done  dark 1920px: 9 pages + 200% text zoom
PASS  no console errors on any page

RESULT: ALL CHECKS PASSED
```
