import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Icon, fmtTime } from "../util.jsx";

export default function How() {
  const [cfg, setCfg] = useState(null);
  const [cart, setCart] = useState(null);
  const [err, setErr] = useState(null);
  const load = () => {
    setErr(null);
    api.config().then(setCfg).catch(() => {});
    api.cartStatus().then(setCart).catch((e) => setErr(e.message));
  };
  useEffect(load, []);
  const ch = cfg && cfg.channel3;

  return (
    <div className="how">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <h1>How it works and what is real</h1>
        <p>Errand spends someone else's money on someone in difficulty, so this page says exactly what happens and what does not.</p>
      </div>

      <section aria-labelledby="h-steps">
        <h2 id="h-steps">What happens in a request</h2>
        <ol className="steps">
          <li><span>A caseworker describes the need in plain words, sets a budget and confirms they may spend from the fund.</span></li>
          <li><span>The agent turns the description into a list of needs and searches live product data for each one.</span></li>
          <li><span>It checks each result for the wording asked for, stock and seller, and puts only passing products in the cart. Anything it cannot match is declined with a reason.</span></li>
          <li><span>The cart is checked against the budget, then paid through PayPal. With "Show me the cart first", it waits for your approval before paying.</span></li>
          <li><span>You get a receipt, a plain summary, and a record of every step.</span></li>
        </ol>
      </section>

      <section aria-labelledby="h-real">
        <h2 id="h-real">How the money moves</h2>
        <ul className="facts">
          
          <li>The product data is live from Channel3: real products, prices and stock.</li>
          <li>No retailer is paid or contacted. Channel3 Checkout is not available yet, so the cart's retailer links are recorded, not purchased.</li>
          <li>Never enter a real name.</li>
        </ul>
      </section>

      <section aria-labelledby="h-c3">
        <h2 id="h-c3">Channel3</h2>
        <p>Channel3 is the product search the agent uses. It connects through the Model Context Protocol (MCP) and the agent calls two tools: <span className="mono">search_products</span> and <span className="mono">get_products</span>.</p>
        {ch ? (
          <div className="tblwrap">
            <table className="tbl" style={{ marginTop: "0.75rem" }}>
              <caption className="sr-only">Channel3 connection</caption>
              <tbody>
                <tr><th scope="row">Transport</th><td data-label="Transport">{ch.transport}</td></tr>
                <tr><th scope="row">Server</th><td data-label="Server" className="mono">{ch.server}</td></tr>
                <tr><th scope="row">Access</th><td data-label="Access">{ch.auth}</td></tr>
                <tr><th scope="row">Tools</th><td data-label="Tools" className="mono">{(ch.tools || []).join(", ")}</td></tr>
              </tbody>
            </table>
          </div>
        ) : <p className="muted" role="status">Loading the connection details.</p>}
      </section>

      <section aria-labelledby="h-cart">
        <h2 id="h-cart">The PayPal Cart API</h2>
        <p>In production, PayPal's cart service is the caller. It only calls accounts it has onboarded, and this one is not onboarded.</p>
        <p>So the agent calls the same four endpoints itself, with a token it signs. A token signed by PayPal would be checked against PayPal's published keys.</p>
        {err && (
          <div className="notice bad" role="alert"><Icon name="alert" /><div className="retry"><span>The Cart API status could not be loaded: {err}</span><button type="button" className="btn secondary" onClick={load}>Try again</button></div></div>
        )}
        {!cart && !err && <p className="muted" role="status" style={{ marginTop: "0.75rem" }}>Loading the Cart API status.</p>}
        {cart && (
          <>
            <h3 style={{ marginTop: "1.25rem", marginBottom: "0.4rem" }}>The four operations</h3>
            <div className="tblwrap">
              <table className="tbl">
                <caption className="sr-only">Cart API operations</caption>
                <thead><tr><th scope="col">Operation</th><th scope="col">Method</th><th scope="col">Path</th></tr></thead>
                <tbody>
                  {cart.operations.map((o) => (
                    <tr key={o.id}><td data-label="Operation" className="first">{o.id}</td><td data-label="Method" className="mono">{o.method}</td><td data-label="Path" className="mono">{o.path}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3 style={{ marginTop: "1.25rem", marginBottom: "0.4rem" }}>Keys</h3>
            <ul className="facts">
              <li>PayPal's public signing keys: {cart.paypalJwks && cart.paypalJwks.ok ? <>fetched ({cart.paypalJwks.kids.length} key{cart.paypalJwks.kids.length === 1 ? "" : "s"}: <span className="mono">{cart.paypalJwks.kids.join(", ")}</span>)</> : <>not fetched{cart.paypalJwks && cart.paypalJwks.error ? ": " + cart.paypalJwks.error : ""}</>}.</li>
              {cart.agentIssuer && <li>The agent's own issuer: <span className="mono">{cart.agentIssuer.iss}</span>, key id <span className="mono">{cart.agentIssuer.kid}</span>. Its tokens are accepted only by this service.</li>}
            </ul>
            <h3 style={{ marginTop: "1.25rem", marginBottom: "0.4rem" }}>Last calls received</h3>
            {cart.recentCalls && cart.recentCalls.length > 0 ? (
              <div className="tblwrap">
                <table className="tbl">
                  <caption className="sr-only">Recent Cart API calls</caption>
                  <thead><tr><th scope="col">Time</th><th scope="col">Call</th><th scope="col">Token check</th><th scope="col" className="r">HTTP status</th></tr></thead>
                  <tbody>
                    {cart.recentCalls.map((c, i) => (
                      <tr key={i}><td data-label="Time" className="first num">{fmtTime(c.t)}</td><td data-label="Call" className="mono">{c.method} {c.path}</td><td data-label="Token check">{c.auth}</td><td data-label="HTTP status" className="r num">{c.status}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted">No calls received since this server started. Make a request and they appear here.</p>}
          </>
        )}
      </section>

      <section aria-labelledby="h-safe">
        <h2 id="h-safe">Safeguards</h2>
        <ul className="facts">
          <li>The budget cap is enforced in code at three layers: when an item is added, when the cart is checked, and again just before payment.</li>
          <li>A tenth of the budget is held back for tax and shipping and is never charged.</li>
          <li>Each cart can be paid once. Sending the same payment again does nothing.</li>
          <li>The agent refuses prescription medicine and items sold for animals.</li>
          <li>Food and formula are not bought until allergies are stated.</li>
          <li>Every substitution is labelled and explained, and every refusal gives a reason.</li>
        </ul>
      </section>
    </div>
  );
}
