import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { Icon, go, money } from "../util.jsx";

const EMPTY = {
  reference: "", request: "", budget: "770", line1: "", city: "", state: "", postal: "",
  allergies: "", instructions: "", mode: "buy", authorised: false,
};
let draft = null; // survives moving between pages, lost on reload

function parseDollars(s) {
  const t = String(s).trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

function validate(f, ceilingCents) {
  const e = {};
  const ref = f.reference.trim();
  if (!ref) e.reference = "Enter a household reference, such as a case number.";
  else if (!/^[A-Za-z0-9 _-]{2,24}$/.test(ref)) e.reference = "Use 2 to 24 letters, digits, spaces or hyphens. Do not use a name.";
  const req = f.request.trim();
  if (!req) e.request = "Describe what the household needs.";
  else if (req.length < 12) e.request = "Write a little more. The description needs at least 12 characters.";
  else if (req.length > 1500) e.request = `Shorten the description by ${req.length - 1500} characters. The limit is 1,500.`;
  const cents = parseDollars(f.budget);
  if (cents === null) e.budget = "Enter the budget in dollars, for example 770 or 284.50.";
  else if (cents < 1000) e.budget = `The budget must be at least ${money(1000)}.`;
  else if (cents > ceilingCents) e.budget = `The budget cannot be more than ${money(ceilingCents)}, the fund's limit for one request.`;
  if (!f.line1.trim()) e.line1 = "Enter the street address.";
  if (!f.city.trim()) e.city = "Enter the city.";
  if (!/^[A-Za-z]{2}$/.test(f.state.trim())) e.state = "Two letters, such as CA.";
  if (!/^\d{5}(-\d{4})?$/.test(f.postal.trim())) e.postal = "Five digits, such as 91101.";
  if (!f.authorised) e.authorised = "Confirm that you are authorised to spend from this fund for this household.";
  return e;
}

function Field({ id, label, hint, error, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint && <span className="hint" id={id + "-hint"}>{hint}</span>}
      {children}
      {error && <div className="err" id={id + "-err"}><Icon name="alert" /><span>{error}</span></div>}
    </div>
  );
}

export default function Request() {
  const [cfg, setCfg] = useState(null);
  const [cfgErr, setCfgErr] = useState(null);
  const [f, setF] = useState(() => draft || EMPTY);
  const [errors, setErrors] = useState({});
  const [serverErr, setServerErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const summaryRef = useRef(null);

  const loadCfg = () => { setCfgErr(null); api.config().then((c) => { setCfg(c); }).catch((e) => setCfgErr(e.message)); };
  useEffect(loadCfg, []);
  useEffect(() => { draft = f; }, [f]);
  // first visit: pre-fill the delivery address from the fund's default
  useEffect(() => {
    if (cfg && cfg.defaultDelivery && !draft_touched(f)) {
      setF((p) => ({ ...p, line1: cfg.defaultDelivery.line1 || "", city: cfg.defaultDelivery.city || "", state: cfg.defaultDelivery.state || "", postal: cfg.defaultDelivery.postal || "" }));
    }
  }, [cfg]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => {
    const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setF((p) => ({ ...p, [k]: v }));
    if (errors[k]) setErrors((p) => { const n = { ...p }; delete n[k]; return n; });
  };

  const fill = (s) => {
    const d = (cfg && cfg.defaultDelivery) || {};
    setF({
      reference: s.reference, request: s.request, budget: String(s.capCents / 100), line1: d.line1 || "", city: d.city || "", state: d.state || "", postal: d.postal || "",
      allergies: s.allergies || "", instructions: "", mode: s.mode === "hold" ? "hold" : "buy", authorised: false,
    });
    setErrors({}); setServerErr(null);
  };

  const ceiling = (cfg && cfg.fund && cfg.fund.ceilingCents) || 100000;
  const connected = !cfg || (cfg.fund && cfg.fund.connected);
  const cents = parseDollars(f.budget);
  const blocked = !cfg ? (cfgErr ? "The server could not be reached, so the request cannot be sent yet." : "Loading the fund details.") : !connected ? "No PayPal account is connected to the fund yet, so nothing can be bought." : null;

  const submit = async (ev) => {
    ev.preventDefault();
    setServerErr(null);
    const v = validate(f, ceiling);
    setErrors(v);
    const keys = Object.keys(v);
    if (keys.length) {
      setTimeout(() => {
        const first = ["reference", "request", "budget", "line1", "city", "state", "postal", "authorised"].find((k) => v[k]);
        const el = document.getElementById(first === "authorised" ? "authorised" : first);
        if (el) el.focus();
      }, 0);
      return;
    }
    setBusy(true);
    try {
      const r = await api.create({
        request: f.request.trim(), capCents: parseDollars(f.budget), reference: f.reference.trim(), mode: f.mode,
        delivery: { line1: f.line1.trim(), city: f.city.trim(), state: f.state.trim().toUpperCase(), postal: f.postal.trim() },
        instructions: f.instructions.trim(), allergies: f.allergies.trim(), authorised: true,
      });
      draft = null;
      go("/runs/" + r.id);
    } catch (e) {
      setServerErr(e.message);
    } finally { setBusy(false); }
  };

  const hold = f.mode === "hold";
  const nErr = Object.keys(errors).length;
  const ids = (id, hint) => ({ id, "aria-describedby": [hint ? id + "-hint" : null, errors[id] ? id + "-err" : null].filter(Boolean).join(" ") || undefined, "aria-invalid": errors[id] ? "true" : undefined });

  return (
    <>
      <div className="page-head">
        <h1>It buys what a household needs, and refuses what it shouldn’t.</h1>
        <p>Describe what a household needs in plain words. The agent searches real products and buys within the budget. Where nothing meets a need, or an allergy is unanswered, it buys nothing for that item and says why. Try the baby-supplies example to watch it stop.</p>
      </div>

      {cfgErr && (
        <div className="notice bad" role="alert">
          <Icon name="alert" />
          <div className="retry"><span>The server could not be reached. What you type here is kept.</span><button type="button" className="btn secondary" onClick={loadCfg}>Try again</button></div>
        </div>
      )}

      <div className="request-col">
        <div>
          {cfg && cfg.scenarios && cfg.scenarios.length > 0 && (
            <section aria-labelledby="ex-h" style={{ marginBottom: "2rem" }}>
              <h2 id="ex-h" style={{ fontSize: "1.25rem", marginBottom: "0.6rem" }}>See it decide</h2>
              <div className="examples" style={{ marginBottom: 0 }}>
                {cfg.scenarios.map((s) => (
                  <button type="button" key={s.id} className="example" onClick={() => fill(s)}>
                    <span className="t">{s.title}</span>
                    <span className="d">{s.blurb}</span>
                  </button>
                ))}
              </div>
              
            </section>
          )}

          <form onSubmit={submit} noValidate aria-label="New request">
            <fieldset className="grp"><legend className="grp-h">1. What is needed</legend>
            <div className="pair">
            <Field id="reference" label="Household reference" hint="A case number. Do not enter a name." error={errors.reference}>
              <input type="text" value={f.reference} onChange={set("reference")} maxLength={24} autoComplete="off" {...ids("reference", true)} />
            </Field>

            <Field id="budget" label="Budget" hint={`The most the agent may spend, in dollars, up to ${money(ceiling)}. A tenth of the budget is held back for tax and shipping and is never charged. For scale: FEMA's flat Serious Needs payment is $770 (disasters declared from 1 Oct 2024) or $790 (from 1 Oct 2025).`} error={errors.budget}>
              <div className="money"><span aria-hidden="true">$</span><input type="text" inputMode="decimal" value={f.budget} onChange={set("budget")} autoComplete="off" {...ids("budget", true)} /></div>
              {cents !== null && cents >= 1000 && cents <= ceiling && (
                <p className="live-budget num">Available for products: {money(Math.floor(cents * 0.9))}. Held back: {money(cents - Math.floor(cents * 0.9))}.</p>
              )}
            </Field>
            </div>
            <Field id="request" label="What the household needs" hint="Plain words. Include quantities and sizes." error={errors.request}>
              <textarea value={f.request} onChange={set("request")} {...ids("request", true)} />
            </Field>

            </fieldset>
            <fieldset className="grp"><legend className="grp-h">2. Where it goes</legend>
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="legend" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>Delivery address</legend>
              <div className="addr">
                <div className="f-line1"><Field id="line1" label="Delivery street address" error={errors.line1}><input type="text" value={f.line1} onChange={set("line1")} autoComplete="off" {...ids("line1")} /></Field></div>
                <div className="f-city"><Field id="city" label="City" error={errors.city}><input type="text" value={f.city} onChange={set("city")} autoComplete="off" {...ids("city")} /></Field></div>
                <div className="f-state"><Field id="state" label="State" error={errors.state}><input type="text" value={f.state} onChange={set("state")} maxLength={2} autoComplete="off" {...ids("state")} /></Field></div>
                <div className="f-zip"><Field id="postal" label="ZIP code" error={errors.postal}><input type="text" inputMode="numeric" value={f.postal} onChange={set("postal")} maxLength={10} autoComplete="off" {...ids("postal")} /></Field></div>
              </div>
            </fieldset>

            <div className="pair">
            <Field id="allergies" label="Allergies or dietary limits for food or formula" hint="Write None known if there are none. Left empty, the agent stops before buying food or formula and asks.">
              <input type="text" value={f.allergies} onChange={set("allergies")} maxLength={200} autoComplete="off" {...ids("allergies", true)} />
            </Field>

            <Field id="instructions" label="Delivery instructions (optional)" hint="For example, a gate code or a time window.">
              <input type="text" value={f.instructions} onChange={set("instructions")} maxLength={300} autoComplete="off" {...ids("instructions", true)} />
            </Field>
            </div>
            </fieldset>
            <fieldset className="grp"><legend className="grp-h">3. How to pay</legend>
            <section className="panel fund" aria-labelledby="fund-h">
            <h3 id="fund-h" className="fund-h">Paying from: {cfg ? cfg.fund.name : "Relief fund"}</h3>
            {cfg && connected && <p className="fund-p">Funded from {cfg.fund.account}. No retailer is contacted.</p>}
            {cfg && !connected && <div className="notice bad" style={{ margin: 0 }}><Icon name="alert" /><div><b>The fund is not connected.</b>No PayPal account is attached to this fund, so the form cannot send a request.</div></div>}
            {!cfg && <p className="muted">{cfgErr ? "Fund details could not be loaded." : "Loading fund details."}</p>}
          </section>
            <fieldset>
              <legend className="legend">When to pay</legend>
              <label className="choice">
                <input type="radio" name="mode" value="buy" checked={f.mode === "buy"} onChange={set("mode")} />
                <span><span className="t">Buy when ready</span><span className="d">The agent pays as soon as the cart is complete.</span></span>
              </label>
              <label className="choice">
                <input type="radio" name="mode" value="hold" checked={f.mode === "hold"} onChange={set("mode")} />
                <span><span className="t">Show me the cart first</span><span className="d">The agent stops with the cart ready. Nothing is charged until you approve it.</span></span>
              </label>
            </fieldset>

            <div className="field">
              <label className="choice" htmlFor="authorised" style={{ marginTop: 0 }}>
                <input type="checkbox" id="authorised" checked={f.authorised} onChange={set("authorised")} aria-invalid={errors.authorised ? "true" : undefined} aria-describedby={errors.authorised ? "authorised-err" : undefined} />
                <span><span className="t">I am authorised to spend from this fund for this household</span></span>
              </label>
              {errors.authorised && <div className="err" id="authorised-err"><Icon name="alert" /><span>{errors.authorised}</span></div>}
            </div>

            </fieldset>

            <div className="submit-area">
              {nErr > 0 && <div className="notice bad" role="alert" ref={summaryRef} style={{ marginTop: 0 }}><Icon name="alert" /><div><b>{nErr === 1 ? "One field needs attention." : `${nErr} fields need attention.`}</b>The messages are next to each field.</div></div>}
              {serverErr && <div className="notice bad" role="alert"><Icon name="alert" /><div><b>The request was not sent.</b>{serverErr}</div></div>}
              <button type="submit" className="btn" disabled={busy || !!blocked} aria-describedby="submit-note">
                {busy ? "Sending request" : hold ? "Find and hold for approval" : "Find and buy"}
              </button>
              <p className="submit-note" id="submit-note">
                {blocked || ""}
              </p>
            </div>
          </form>
        </div>

      </div>
    </>
  );
}

function draft_touched(f) {
  return !!(f.line1 || f.city || f.state || f.postal || f.reference || f.request);
}
