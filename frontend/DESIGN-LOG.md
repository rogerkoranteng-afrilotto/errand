# Errand front end: design log

Stack: React 18, Vite, plain CSS (`src/styles.css`), hash routing, no router/state/UI libraries. Fonts bundled from `@fontsource` (Newsreader headings, Atkinson Hyperlegible body), no external requests. Screens: `#/`, `#/runs`, `#/runs/:id`, `#/how`.
Screenshots: `shots/r1` .. `shots/r6` (4 widths x light/dark; r1b, r4 are quick rounds; r3 also holds the live-flow shots `live-*.png`). Tools: `shots/shoot.mjs`, `shots/live.mjs`, `scripts/ui-check.mjs`.

## Round 1 (score 5/10)
Faults: product images blank in screenshots (lazy loading, 1 MB CDN images); checkbox row broken (`.field > label` rule overrode the grid, text fell under the box); on phones the receipt sat above the needs list; horizontal overflow at 200% text on request and run pages (long unbreakable domain names, grid items without `min-width:0`, a 12rem button).
Fixes: eager image loading, `.field > label.choice` override, stacked order budget / action / needs / receipt, `min-width:0` on grid children, `overflow-wrap:anywhere` on source lines and link buttons.

## Round 2 (6.5/10)
Faults: approval card sat below the budget so the one action that matters was second; "Not bought" repeated three times per refusal (chip, mark, box title); budget reserve hatched in rose, which spent the single signal colour on a non-problem; How page intro touched the first rule; contrast check flagged a focus-ring pair that is never adjacent (ring is offset 2px onto the page).
Fixes: action panel first, mark dropped for declined needs (the box says it), reserve hatch now neutral ink, spacing, removed the invalid pair.

## Round 3 (7.5/10)
Live flow proven in the browser (see below). Faults: running request showed an empty "Needs (0)" list; failed run put "What went wrong" at the very bottom; failed or cancelled runs still labelled products "In the cart"; address row squeezed the ZIP error into a 4-word column; h1 broke mid-word at 200% on 360 px.
Fixes: placeholder "Reading the request..." while there are no needs, failure panel first, lines read "Chosen, not paid" when the run did not buy, address row is a wrapping flex row with short error text ("Five digits, such as 91101."), h1 minimum size lowered, product photo stacks above text when the layout is very narrow in rem.

## Round 4-6 (8.5/10)
Checked 200% text at all widths, keyboard focus (3px ring, offset), dark theme on every run state, validation state at 360/768/1280. `scripts/ui-check.mjs` passes at 360/768/1280/1920 in light and dark, plus 200% text zoom.
A media query in rem does not follow a text-only zoom, so layout breakpoints were kept simple (flex wrap, minmax(0,1fr)) rather than relying on them.

## Live flow (r3/live-*.png)
- `tight-budget` example: submitted, watched Searching, ended Bought with a receipt (PayPal sandbox).
- `hold-for-approval` example: label became "Find and hold for approval", stopped at Needs information, "Save and continue" with "None known", then Waiting for approval, "Approve and pay", ended Bought.
- No console errors on any page or in the live run.

## Final score: 8.5/10
Not 9 because:
- Atkinson Hyperlegible draws a slashed zero, so "$0.00" reads a little like "$Ø.ØØ". It is deliberate in the typeface (it is there to prevent 0/O confusion), but it looks odd next to the serif figures.
- Product photos are up to 1 MB each from Channel3's CDN and arrive late on slow connections; the grey placeholder shows meanwhile.
- The How page uses a single reading column and leaves the right side empty on wide screens.
- The Request page puts the fund line twice (aside and under the button). Deliberate, since the button is where the decision happens.
- No automated screen-reader pass (NVDA/VoiceOver) was run; roles, labels and live regions were checked in the DOM only.

## API REQUESTS
None required. Two notes: `GET /api/runs` returns `declined` as a count and `committedCents` for non-bought runs is the cart value (the history page shows spent as 0 unless BOUGHT); the `working` fixture never advances because the dev server serves it statically, so it polls forever.

## Round 7 (request page layout, after the deck copy was moved to the README)
Fault: with the evidence column gone, the right column held only the fund card and about 1,700 of 2,185 px sat empty beside a narrow form. Fix: single centred column (52 rem), form grouped into 1 What is needed / 2 Where it goes / 3 How to pay, reference and budget side by side, allergies and instructions side by side (both stack below 46 rem), fund card moved inline into "How to pay" and shortened, duplicate fund sentence under the button removed, textarea and spacing tightened. Page height at 1280: 2,185 -> 2,141 px (original with the statistics: 2,163). Checked at 360, 768, 1280, 1920; `scripts/ui-check.mjs` passes.
