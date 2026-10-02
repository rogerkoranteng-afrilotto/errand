// Illustrative cases and the evidence behind them. The households are invented; the figures are not.
// Sources are in research/disaster/FINDINGS.md (finding 4), queried 1-2 October 2026.
export const EVIDENCE = [
  { figure: "61.9%", text: "of people who registered with FEMA after a disaster declared on or after 1 January 2022 were awarded $0 or only a flat payment under $800 (4,701,420 of 7,596,530).", source: "OpenFEMA, IndividualsAndHouseholdsProgramValidRegistrations v2, counts computed 1-2 Oct 2026" },
  { figure: "94.1%", text: "of registrations for the January 2025 Los Angeles fires (DR-4856) got nothing or one flat $770 payment (245,643 of 261,118).", source: "OpenFEMA, same dataset" },
  { figure: "630,954", text: "coded denials since 2022 were for process, not loss: 157,217 needed to submit documentation and 473,737 did not answer FEMA outreach or withdrew. Withdrawals are counted with non-response.", source: "OpenFEMA ineligibleReason codes 3 and 4" },
  { figure: "$770", text: "is the flat Serious Needs payment for disasters declared from 1 October 2024; it is $790 from 1 October 2025.", source: "89 FR 84922 (24 Oct 2024); 91 FR 61431 (29 Sep 2026)" },
];

export const SCENARIOS = [
  {
    id: "burned-out-family",
    title: "Watch it refuse the medicine",
    blurb: "Ash cleanup, bedding and baby supplies go in the cart. The prescription item does not, and it says why.",
    reference: "LA-0417", capCents: 77000, mode: "buy", allergies: "None known",
    request: "A family of four lost nearly everything in the Eaton fire and has no paperwork to show FEMA. They need N95 masks for clearing ash from the house, two twin sheet sets for the children, infant formula powder (two cans), size 4 diapers, a phone charger with a cable, and a replacement albuterol rescue inhaler for the father.",
  },
  {
    id: "tight-budget",
    title: "Watch the budget run out",
    blurb: "A $120 cap that does not reach the end of the list. It buys what it can and names what it skipped.",
    reference: "LA-0522", capCents: 12000, mode: "buy", allergies: "",
    request: "A single adult is staying in a motel after the fire. They need a basic pot and pan set, a twin sheet set, and a phone charger with a cable. Spend as little as the need allows.",
  },
  {
    id: "hold-for-approval",
    title: "Watch it stop and ask",
    blurb: "Infant formula with no allergy information on file. It builds the cart and refuses to pay until a person answers.",
    reference: "LA-0609", capCents: 30000, mode: "hold", allergies: "",
    request: "A mother with a seven-month-old lost her car and her home in the fire. She needs infant formula powder (two cans), size 3 diapers, and a pack of baby wipes.",
  },
];

export const DEFAULT_DELIVERY = { line1: "Example Relief Office, 100 Example Way", city: "Pasadena", state: "CA", postal: "91101" };
