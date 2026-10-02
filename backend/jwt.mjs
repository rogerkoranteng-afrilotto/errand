// RS256 verification for the PayPalJWT bearer token on the inbound Cart API, using node:crypto only.
//
// What PayPal documents (developer.paypal.com/store-sync/integrate): every call to the merchant API carries
// "Authorization: Bearer <jwt>"; verify the signature with PayPal's public key at
// https://www.paypal.ai/.well-known/jwks.json and validate the expiry. The claims inside the token are NOT
// documented beyond one example (merchant_id, scope, iat, exp), so this verifier checks signature, algorithm,
// key id and time claims and nothing it cannot cite.
//
// Two issuers are trusted:
//   paypal       keys from PayPal's JWKS. This is the production path: PayPal's cart service is the caller.
//   errand-agent keys from this deployment's own signing key. PayPal will not call an account that has not been
//                through Agentic Commerce onboarding, so the agent's checkout presents a token it signs itself
//                to the same four endpoints. Its public key is served at /.well-known/jwks.json.
import { createPublicKey, createPrivateKey, createHash, sign as cSign, verify as cVerify } from "node:crypto";

export const PAYPAL_JWKS_URL = "https://www.paypal.ai/.well-known/jwks.json";
export const AGENT_ISS = "errand-agent";
export const AGENT_AUD = "errand-cart-api";
const b64u = (b) => Buffer.from(b).toString("base64url");
const fromB64u = (s) => Buffer.from(s, "base64url");

export function agentKey(pemB64) {
  if (!pemB64) return null;
  const priv = createPrivateKey(Buffer.from(pemB64, "base64").toString("utf8"));
  const pub = createPublicKey(priv);
  const jwk = pub.export({ format: "jwk" });
  const kid = createHash("sha256").update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest("hex").slice(0, 16);
  return { priv, jwk: { ...jwk, kid, use: "sig", alg: "RS256" }, kid };
}

export function signAgentToken(key, claims, { now = Date.now(), ttlSec = 600 } = {}) {
  const iat = Math.floor(now / 1000);
  const head = { alg: "RS256", typ: "JWT", kid: key.kid };
  const body = { iss: AGENT_ISS, aud: AGENT_AUD, iat, exp: iat + ttlSec, scope: ["cart"], ...claims };
  const data = `${b64u(JSON.stringify(head))}.${b64u(JSON.stringify(body))}`;
  return `${data}.${b64u(cSign("RSA-SHA256", Buffer.from(data), key.priv))}`;
}

let jwksCache = { at: 0, keys: [] };
export async function fetchPaypalJwks({ fetchImpl = fetch, force = false, ttlMs = 3600_000 } = {}) {
  if (!force && jwksCache.keys.length && Date.now() - jwksCache.at < ttlMs) return jwksCache.keys;
  const r = await fetchImpl(PAYPAL_JWKS_URL);
  if (!r.ok) throw new Error(`PayPal JWKS HTTP ${r.status}`);
  const j = await r.json();
  jwksCache = { at: Date.now(), keys: j.keys || [] };
  return jwksCache.keys;
}
export const _resetJwksCache = () => { jwksCache = { at: 0, keys: [] }; };

const parse = (t) => {
  const p = String(t || "").split(".");
  if (p.length !== 3 || p.some((x) => !x)) return null;
  try { return { head: JSON.parse(fromB64u(p[0]).toString()), body: JSON.parse(fromB64u(p[1]).toString()), data: `${p[0]}.${p[1]}`, sig: fromB64u(p[2]) }; } catch { return null; }
};

// Returns { ok:true, issuer, claims } or { ok:false, reason }. Never throws on a bad token.
export async function verifyBearer(header, { agent, paypalJwks = fetchPaypalJwks, now = Date.now(), skewSec = 30 } = {}) {
  const m = /^Bearer\s+(\S+)$/i.exec(header || "");
  if (!m) return { ok: false, reason: "missing_bearer" };
  const t = parse(m[1]);
  if (!t) return { ok: false, reason: "malformed" };
  if (t.head.alg !== "RS256") return { ok: false, reason: "alg_not_allowed" };      // rejects none, HS256 key-confusion, etc.
  if (!t.head.kid) return { ok: false, reason: "no_kid" };

  let jwk = null, issuer = null;
  if (agent && t.head.kid === agent.kid) { jwk = agent.jwk; issuer = "agent"; }
  else {
    let keys = []; try { keys = await paypalJwks(); } catch (e) { return { ok: false, reason: "jwks_unreachable" }; }
    jwk = keys.find((k) => k.kid === t.head.kid);
    if (!jwk) { try { keys = await paypalJwks({ force: true }); jwk = keys.find((k) => k.kid === t.head.kid); } catch { /* keep */ } }
    if (jwk) issuer = "paypal";
  }
  if (!jwk) return { ok: false, reason: "unknown_kid" };

  let good = false;
  try { good = cVerify("RSA-SHA256", Buffer.from(t.data), createPublicKey({ key: jwk, format: "jwk" }), t.sig); } catch { good = false; }
  if (!good) return { ok: false, reason: "bad_signature" };

  const s = Math.floor(now / 1000), c = t.body;
  if (typeof c.exp !== "number") return { ok: false, reason: "no_exp" };
  if (c.exp + skewSec < s) return { ok: false, reason: "expired" };
  if (typeof c.nbf === "number" && c.nbf - skewSec > s) return { ok: false, reason: "not_yet_valid" };
  if (typeof c.iat === "number" && c.iat - 300 > s) return { ok: false, reason: "iat_in_future" };
  if (issuer === "agent" && (c.iss !== AGENT_ISS || c.aud !== AGENT_AUD)) return { ok: false, reason: "bad_issuer" };
  return { ok: true, issuer, claims: c };
}
