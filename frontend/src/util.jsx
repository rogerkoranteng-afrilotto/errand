import { useEffect, useState } from "react";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const money = (cents) => usd.format((Number(cents) || 0) / 100);
export const moneyStr = (s) => usd.format(Number(s) || 0);

const dt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const tm = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
export const fmtDate = (iso) => { try { return iso ? dt.format(new Date(iso)) : ""; } catch { return ""; } };
export const fmtTime = (iso) => { try { return iso ? tm.format(new Date(iso)) : ""; } catch { return ""; } };

export const ACTIVE = new Set(["QUEUED", "WORKING", "BUYING"]);

const P = {
  check: "M5 12.5l4.5 4.5L19 7.5",
  clock: "M12 7v5l3 2",
  pause: "M9.5 8v8M14.5 8v8",
  question: "M9.5 9.5a2.5 2.5 0 115 0c0 1.7-2.5 2-2.5 4M12 17v.5",
  x: "M8 8l8 8M16 8l-8 8",
  alert: "M12 8v5M12 16.5v.5",
  info: "M12 11v5M12 7.5v.5",
  slash: "M7 17L17 7",
};
const CIRCLE = new Set(["check", "clock", "pause", "question", "x", "info", "slash"]);

export function Icon({ name, spin }) {
  const tri = name === "alert";
  return (
    <svg className={"ico" + (spin ? " spin" : "")} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {CIRCLE.has(name) && <circle cx="12" cy="12" r="9.5" />}
      {tri && <path d="M12 3.5l9.5 16.5h-19z" />}
      {name === "external" ? <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" /> : <path d={P[name]} />}
    </svg>
  );
}

export const STATUS = {
  QUEUED: { label: "Starting", icon: "clock", kind: "", spin: true, line: "The request was received. The agent starts shortly." },
  WORKING: { label: "Searching", icon: "clock", kind: "", spin: true, line: "The agent is searching for products and building the cart. Nothing has been charged." },
  BUYING: { label: "Paying", icon: "clock", kind: "", spin: true, line: "Payment is being made through PayPal." },
  NEEDS_INFO: { label: "Needs information", icon: "question", kind: "", line: "The agent stopped before buying food or formula. It needs allergy information to continue." },
  AWAITING_APPROVAL: { label: "Waiting for approval", icon: "pause", kind: "", line: "The cart is ready. Nothing is charged until you approve it." },
  BOUGHT: { label: "Bought", icon: "check", kind: "ok", line: "The payment went through. The receipt is below." },
  NOTHING_BOUGHT: { label: "Nothing bought", icon: "slash", kind: "bad", line: "The agent found nothing that met the need, so it bought nothing. Nothing was charged." },
  FAILED: { label: "Failed", icon: "alert", kind: "bad", line: "The purchase did not go through." },
  CANCELLED: { label: "Cancelled", icon: "x", kind: "", line: "This request was cancelled. Nothing was charged." },
};
export const statusOf = (s) => STATUS[s] || { label: String(s || "Unknown"), icon: "info", kind: "", line: "" };

export function Chip({ status }) {
  const m = statusOf(status);
  return (
    <span className={"chip " + m.kind}>
      <Icon name={m.icon} spin={m.spin} />
      {m.label}
    </span>
  );
}

/* Hash routing */
export function useRoute() {
  const read = () => (window.location.hash.replace(/^#/, "") || "/");
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (path) => { window.location.hash = "#" + path; };
