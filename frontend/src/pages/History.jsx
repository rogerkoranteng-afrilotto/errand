import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { ACTIVE, Chip, Icon, fmtDate, go, money } from "../util.jsx";

export default function History() {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const timer = useRef(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    clearTimeout(timer.current);
    try {
      const r = await api.runs();
      if (!alive.current) return;
      setRuns(r.runs); setError(null);
      if (r.runs.some((x) => ACTIVE.has(x.status))) timer.current = setTimeout(load, 4000);
    } catch (e) { if (alive.current) setError(e.message); }
  }, []);
  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; clearTimeout(timer.current); }; }, [load]);

  const sorted = runs ? [...runs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) : null;

  return (
    <>
      <div className="page-head">
        <h1>Requests</h1>
        <p>Every request this fund has handled, newest first. Open one to see what was bought, what was refused, and why.</p>
      </div>
      {error && (
        <div className="notice bad" role="alert">
          <Icon name="alert" />
          <div className="retry"><span>{error}</span><button type="button" className="btn secondary" onClick={load}>Try again</button></div>
        </div>
      )}
      {!sorted && !error && <p role="status" className="muted">Loading requests.</p>}
      {sorted && sorted.length === 0 && (
        <div className="empty">
          <h2>No requests yet</h2>
          <p className="muted">When a caseworker sends a request, it appears here with its status.</p>
          <button type="button" className="btn" onClick={() => go("/")}>Make a request</button>
        </div>
      )}
      {sorted && sorted.length > 0 && (
        <table className="tbl">
          <caption className="sr-only">Requests, newest first</caption>
          <thead>
            <tr><th scope="col">Household</th><th scope="col">Status</th><th scope="col" className="r">Spent of budget</th><th scope="col" className="r">Not bought</th><th scope="col">Date</th></tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const spent = r.status === "BOUGHT" ? r.committedCents : 0;
              const nb = Array.isArray(r.declined) ? r.declined.length : Number(r.declined) || 0;
              return (
                <tr key={r.id}>
                  <td className="first"><a className="ref" href={"#/runs/" + r.id}>{r.reference}</a></td>
                  <td data-label="Status"><Chip status={r.status} /></td>
                  <td className="r num" data-label="Spent of budget">{money(spent)} of {money(r.capCents)}</td>
                  <td className="r num" data-label="Not bought">{nb} {nb === 1 ? "item" : "items"}</td>
                  <td data-label="Date" className="num">{fmtDate(r.createdAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
