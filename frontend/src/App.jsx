import { useEffect, useRef, useState } from "react";
import { useRoute } from "./util.jsx";
import Request from "./pages/Request.jsx";
import Run from "./pages/Run.jsx";
import History from "./pages/History.jsx";
import How from "./pages/How.jsx";

const THEMES = ["system", "light", "dark"];
function readTheme() {
  try { const t = localStorage.getItem("errand-theme"); return THEMES.includes(t) ? t : "light"; } catch { return "light"; }
}

function ThemeButton() {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") el.removeAttribute("data-theme"); else el.setAttribute("data-theme", theme);
    try { localStorage.setItem("errand-theme", theme); } catch { /* storage blocked */ }
  }, [theme]);
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  return (
    <button type="button" className="theme-btn" onClick={() => setTheme(next)} aria-label={`Theme: ${theme}. Switch to ${next}.`}>
      Theme: {theme}
    </button>
  );
}

const TITLES = { request: "New request", runs: "Requests", run: "Request", how: "How it works" };

export default function App() {
  const route = useRoute();
  const mainRef = useRef(null);
  const first = useRef(true);
  const parts = route.split("/").filter(Boolean);
  let view = "request", id = null;
  if (parts[0] === "runs" && parts[1]) { view = "run"; id = decodeURIComponent(parts[1]); }
  else if (parts[0] === "runs") view = "runs";
  else if (parts[0] === "how") view = "how";

  useEffect(() => {
    document.title = `${TITLES[view]} | Errand`;
    if (first.current) { first.current = false; return; }
    window.scrollTo(0, 0);
    const h = mainRef.current && mainRef.current.querySelector("h1");
    if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
  }, [route]); // eslint-disable-line react-hooks/exhaustive-deps

  const cur = (v) => (view === v || (v === "runs" && view === "run") ? "page" : undefined);

  return (
    <>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); const m = document.getElementById("main"); m.setAttribute("tabindex", "-1"); m.focus(); }}>Skip to main content</a>
      <header className="masthead">
        <div className="wrap">
          <a className="wordmark" href="#/">Errand</a>
          <nav className="nav" aria-label="Main">
            <a href="#/" aria-current={cur("request")}>New request</a>
            <a href="#/runs" aria-current={cur("runs")}>Requests</a>
            <a href="#/how" aria-current={cur("how")}>How it works</a>
            <ThemeButton />
          </nav>
        </div>
      </header>
      <main id="main" ref={mainRef}>
        <div className="wrap">
          {view === "request" && <Request />}
          {view === "runs" && <History />}
          {view === "run" && <Run key={id} id={id} />}
          {view === "how" && <How />}
        </div>
      </main>
      <footer className="foot">
        <div className="wrap">Product data from Channel3. MIT licence.</div>
      </footer>
    </>
  );
}
