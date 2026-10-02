import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { ACTIVE, Chip, Icon, fmtDate, fmtTime, money, moneyStr, statusOf, go } from "../util.jsx";

function useRun(id) {
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const timer = useRef(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await api.run(id);
      if (!alive.current) return;
      setRun(r); setError(null);
      if (ACTIVE.has(r.status)) timer.current = setTimeout(load, 2000);
    } catch (e) {
      if (alive.current) setError(e);
    }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; clearTimeout(timer.current); };
  }, [load, tick]);

  const refresh = () => { clearTimeout(timer.current); setTick((t) => t + 1); };
  return { run, error, refresh };
}

function Budget({ run }) {
  const spendable = run.spendableCents || 0;
  const bought = run.status === "BOUGHT";
  const spent = bought ? Math.round(Number(run.order && run.order.amount ? run.order.amount : 0) * 100) || run.committedCents || 0 : 0;
  const carted = run.committedCents || 0;
  const held = run.reserveCents || 0;
  const cap = run.capCents || spendable + held || 1;
  const shown = bought ? spent : carted;
  const pct = (n) => Math.max(0, Math.min(100, (n / cap) * 100));
  const text = bought
    ? `Spent ${money(spent)} of ${money(spendable)} available. ${money(held)} held back for tax and shipping.`
    : run.status === "AWAITING_APPROVAL" || run.status === "NEEDS_INFO" || ACTIVE.has(run.status)
      ? `In the cart: ${money(carted)} of ${money(spendable)} available. Nothing charged yet. ${money(held)} held back for tax and shipping.`
      : `Spent ${money(0)} of ${money(spendable)} available. ${money(held)} held back for tax and shipping.`;
  const label = bought ? "Spent" : (run.status === "AWAITING_APPROVAL" || run.status === "NEEDS_INFO" || ACTIVE.has(run.status)) ? "In the cart" : "Spent";
  const val = label === "Spent" ? (bought ? spent : 0) : shown;
  return (
    <section className="panel budget second-o" aria-labelledby="budget-h">
      <h2 id="budget-h" className="sr-only">Budget</h2>
      <div className="small muted" style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      <div><span className="big num">{money(val)}</span> <span className="of num">of {money(spendable)} available</span></div>
      <div className="bar" role="img" aria-label={text}>
        <div className="spent" style={{ width: pct(val) + "%" }} />
        <div style={{ flex: 1 }} />
        <div className="held" style={{ width: pct(held) + "%" }} />
      </div>
      <ul className="legend-list num">
        <li><span>{label}</span><span>{money(val)}</span></li>
        <li><span>Left to spend</span><span>{money(Math.max(0, spendable - val))}</span></li>
        <li><span>Held back for tax and shipping</span><span>{money(held)}</span></li>
        <li><span>Budget</span><span>{money(cap)}</span></li>
      </ul>
      <p className="cap small muted">{text}</p>
    </section>
  );
}

function Thumb({ line }) {
  const [bad, setBad] = useState(false);
  if (!line.image || bad) return <div className="thumb-ph">No image</div>;
  return <img className="thumb" src={line.image} alt={line.alt || line.name} width="96" height="96" onError={() => setBad(true)} />;
}

function Need({ need, lines, runStatus }) {
  const bought = runStatus === "BOUGHT";
  const subst = need.status === "substituted" || lines.some((l) => l.substitution);
  let mark;
  if (need.status === "declined") mark = null;
  else if (need.status === "open") mark = <span className="mark"><Icon name="clock" />Looking</span>;
  else mark = <span className="mark ok"><Icon name="check" />{bought ? (subst ? "Bought, substituted" : "Bought") : ["FAILED", "CANCELLED", "NOTHING_BOUGHT"].includes(runStatus) ? "Chosen, not paid" : subst ? "In the cart, substituted" : "In the cart"}</span>;
  return (
    <li className="need">
      <div className="need-head">
        <h3>{need.label} <span className="q num">x {need.qty}</span></h3>
        {mark}
      </div>
      {need.status === "open" && (
        <div className="looking"><span className="dot pulse" aria-hidden="true" /> Looking for a product that meets this need.</div>
      )}
      {need.status === "declined" && (
        <div className="declined">
          <h4><Icon name="slash" />Not bought</h4>
          <dl>
            <div><dt>Reason</dt><dd>{need.reason}</dd></div>
            {need.nextStep && <div><dt>What to do instead</dt><dd>{need.nextStep}</dd></div>}
          </dl>
        </div>
      )}
      {lines.map((l) => (
        <div className="pl" key={l.id}>
          <Thumb line={l} />
          <div>
            <div className="name">{l.name}</div>
            <div className="meta">{l.brand ? l.brand + ", " : ""}{l.domain}</div>
            <div className="math num"><span>{l.qty} x {money(l.unitCents)}</span><span className="tot">{money(l.lineCents)}</span></div>
            {l.why && <p className="why"><b>Why: </b>{l.why}</p>}
            {l.substitution && <div className="sub"><b>Substitution</b>{l.substitution}</div>}
          </div>
        </div>
      ))}
    </li>
  );
}

function Actions({ run, refresh }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [al, setAl] = useState("");
  const confirmRef = useRef(null);
  useEffect(() => { if (confirm && confirmRef.current) confirmRef.current.focus(); }, [confirm]);

  const act = async (fn) => {
    setBusy(true); setErr(null);
    try { await fn(); refresh(); setConfirm(false); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const total = run.cart && run.cart.total ? moneyStr(run.cart.total) : money(run.committedCents);

  if (run.status !== "AWAITING_APPROVAL" && run.status !== "NEEDS_INFO") return null;
  const cancelUi = (
    <>
      {!confirm && <button type="button" className="btn secondary" onClick={() => setConfirm(true)} disabled={busy}>Cancel request</button>}
      {confirm && (
        <div className="confirm" role="group" aria-labelledby="cancel-q">
          <p id="cancel-q"><b>Cancel this request?</b> The cart is discarded. Nothing has been charged.</p>
          <div className="btns" style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <button type="button" ref={confirmRef} className="btn danger" disabled={busy} onClick={() => act(() => api.cancel(run.id))}>Yes, cancel request</button>
            <button type="button" className="btn secondary" onClick={() => setConfirm(false)}>Keep request</button>
          </div>
        </div>
      )}
    </>
  );
  if (run.status === "AWAITING_APPROVAL") {
    return (
      <section className="panel actions first-o" aria-labelledby="act-h">
        <h2 id="act-h">Your approval is needed</h2>
        <p>Review the cart. Approving pays {total} from the fund.</p>
        {err && <div className="err" role="alert"><Icon name="alert" /><span>{err}</span></div>}
        <div className="btns">
          <button type="button" className="btn" disabled={busy} onClick={() => act(() => api.approve(run.id))}>{busy ? "Sending approval" : `Approve and pay ${total}`}</button>
          {!confirm && cancelUi}
        </div>
        {confirm && cancelUi}
      </section>
    );
  }
  return (
    <section className="panel actions first-o" aria-labelledby="act-h">
      <h2 id="act-h">Allergy information needed before food or formula can be bought</h2>
      <form onSubmit={(e) => { e.preventDefault(); if (!al.trim()) { setErr("Enter the allergies or dietary limits, or write None known."); return; } act(() => api.info(run.id, al.trim())); }} noValidate style={{ marginTop: "0.75rem" }}>
        <div className="field" style={{ marginBottom: "0.75rem" }}>
          <label htmlFor="al">Allergies or dietary limits</label>
          <span className="hint" id="al-hint">Write None known if there are none.</span>
          <input id="al" type="text" value={al} onChange={(e) => { setAl(e.target.value); setErr(null); }} aria-describedby={"al-hint" + (err ? " al-err" : "")} aria-invalid={err ? "true" : undefined} maxLength={200} autoComplete="off" />
          {err && <div className="err" id="al-err" role="alert"><Icon name="alert" /><span>{err}</span></div>}
        </div>
        <div className="btns">
          <button type="submit" className="btn" disabled={busy}>{busy ? "Saving" : "Save and continue"}</button>
          {!confirm && cancelUi}
        </div>
        {confirm && cancelUi}
      </form>
    </section>
  );
}

function Receipt({ run }) {
  const o = run.order;
  if (!o) return null;
  const conf = o.webhook === "confirmed";
  return (
    <section className="panel receipt after" aria-labelledby="rc-h">
      <h2 id="rc-h" style={{ fontSize: "1.35rem" }}>Receipt</h2>
      <dl>
        <div className="row"><dt>Merchant order number</dt><dd>{o.merchantOrderNumber}</dd></div>
        <div className="row"><dt>PayPal order id</dt><dd>{o.paypalOrderId}</dd></div>
        <div className="row"><dt>Capture id</dt><dd>{o.captureId}</dd></div>
        <div className="row"><dt>Amount</dt><dd className="plain num">{moneyStr(o.amount)}</dd></div>
        <div className="row"><dt>Paid</dt><dd className="plain">{fmtDate(o.capturedAt)}</dd></div>
        <div className="row"><dt>PayPal confirmation</dt><dd className="plain">{conf ? "Received" : "Pending"}</dd></div>
      </dl>
      <p className="small muted" style={{ marginTop: "0.5rem" }}>
        PayPal's confirmation is PayPal's own notification that the payment went through.{conf ? "" : " It has not arrived yet. The payment itself is recorded above."}
      </p>
      {run.lines.length > 0 && (
        <>
          <h3 style={{ fontSize: "1.1rem", marginTop: "1.25rem" }}>Products</h3>
          <p className="small muted">No retailer was paid or contacted. These links open the retailer's page for the product.</p>
          <ul className="links">
            {run.lines.map((l) => (
              <li key={l.id}>
                <a className="btn secondary" href={l.url} target="_blank" rel="noopener noreferrer">
                  <span>Open at {l.domain}<span className="sr-only">, {l.name}, opens the retailer's page in a new tab</span></span>
                  <Icon name="external" />
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Audit({ run }) {
  const working = ACTIVE.has(run.status);
  const ev = run.events || [];
  // the open state follows the run: open while working, closed once finished, unless the reader chose otherwise
  const ref = useRef(null);
  const touched = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (el && !touched.current) el.open = working;
  }, [working]);
  return (
    <details className="audit" ref={ref} open={working} onToggle={() => { touched.current = true; }}>
      <summary>What the agent did ({ev.length} step{ev.length === 1 ? "" : "s"})</summary>
      <p className="audit-note">A record of each step, kept so the spending can be checked.</p>
      <ol>
        {ev.map((e, i) => (
          <li key={i}><time dateTime={e.t}>{fmtTime(e.t)}</time><span>{e.text}</span></li>
        ))}
      </ol>
    </details>
  );
}

export default function Run({ id }) {
  const { run, error, refresh } = useRun(id);

  if (!run && !error) return <p role="status" className="muted">Loading the request.</p>;
  if (!run && error) {
    const nf = error.status === 404;
    return (
      <div>
        <h1>{nf ? "Request not found" : "The request could not be loaded"}</h1>
        <div className="notice bad" role="alert" style={{ marginTop: "1rem", maxWidth: "40rem" }}>
          <Icon name="alert" />
          <div className="retry"><span>{nf ? "There is no request with this address. It may belong to another session." : error.message}</span>
            {!nf && <button type="button" className="btn secondary" onClick={refresh}>Try again</button>}
            {nf && <button type="button" className="btn secondary" onClick={() => go("/runs")}>See all requests</button>}
          </div>
        </div>
      </div>
    );
  }

  const m = statusOf(run.status);
  const byNeed = (nid) => run.lines.filter((l) => l.needId === nid);
  const allDeclined = run.status === "NOTHING_BOUGHT";
  const m0 = run.model || {};

  return (
    <>
      <div className="run-head">
        <span className="ref">Household reference</span>
        <h1>{run.reference}</h1>
        <div className="row">
          <Chip status={run.status} />
          <p className="sentence" role="status">{m.line}</p>
        </div>
        {run.request && <p className="req-text"><b>Request: </b>{run.request}</p>}
      </div>

      {error && (
        <div className="notice bad" role="alert">
          <Icon name="alert" />
          <div className="retry"><span>The server could not be reached. This page shows the last update.</span><button type="button" className="btn secondary" onClick={refresh}>Try again</button></div>
        </div>
      )}

      <div className="run-grid">
        <div className="side">
          <Actions run={run} refresh={refresh} />
          <Budget run={run} />
          {run.status === "BOUGHT" && <Receipt run={run} />}
          {run.status === "FAILED" && (
            <section className="panel first-o" aria-labelledby="fail-h">
              <h2 id="fail-h" style={{ fontSize: "1.35rem" }}>What went wrong</h2>
              <p>{run.failure || "The purchase did not go through."}</p>
              {!run.order && <p style={{ marginTop: "0.5rem" }}><b>Nothing further was charged.</b></p>}
            </section>
          )}
        </div>

        <div className="main-col">
          {allDeclined && (
            <div className="nothing">
              <h2>Nothing was bought.</h2>
              <p>Every item was declined. The reasons are below, with what to do instead.</p>
            </div>
          )}
          {run.status === "CANCELLED" && <p className="muted" style={{ marginBottom: "1rem" }}>The cart was discarded when the request was cancelled.</p>}
          <h2 style={{ fontSize: "1.45rem", marginBottom: "0.6rem" }}>{run.needs.length ? `Needs (${run.needs.length})` : "Needs"}</h2>
          {run.needs.length === 0 && <div className="looking" style={{ padding: "1rem 0", borderTop: "2px solid var(--ink)" }}><span className="dot pulse" aria-hidden="true" /> Reading the request and listing what the household needs.</div>}
          <ul className="needs" hidden={run.needs.length === 0}>
            {run.needs.map((n) => <Need key={n.id} need={n} lines={byNeed(n.id)} runStatus={run.status} />)}
          </ul>

          {run.summary && (
            <section className="summary" aria-labelledby="sum-h">
              <h2 id="sum-h">Summary for the caseworker</h2>
              <p className="text">{run.summary}</p>
              {run.summarySource === "system" && <p className="small muted" style={{ marginTop: "0.4rem" }}>Written by the system from the cart, not by the language model.</p>}
            </section>
          )}

          {m0.source && m0.source !== "bedrock" && m0.notes && m0.notes[0] && (
            <div className="notice" role="status" style={{ marginTop: "1.5rem" }}>
              <Icon name="info" />
              <div><b>How this was decided</b>{m0.notes[0]}</div>
            </div>
          )}

          <Audit run={run} />
        </div>
      </div>
    </>
  );
}
