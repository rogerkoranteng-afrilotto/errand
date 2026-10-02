// PayPal REST client for the pieces this project uses. Endpoints checked against the live specs:
//   developer.paypal.com/api/orders/v2/schema.json         create, get, confirm-payment-source, capture
//   developer.paypal.com/api/payment-tokens/v3/schema.json vault (PayPal wallet only; card vaulting returns 403 here)
//   developer.paypal.com/api/webhooks/v1/schema.json       register, verify-webhook-signature
// PayPal-Request-Id makes create and capture idempotent.
export function cfg(env = process.env) {
  return { api: env.PAYPAL_API || "https://api-m.sandbox.paypal.com", id: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_SECRET, fetchImpl: fetch };
}

export class PayPalError extends Error {
  constructor(where, status, body) {
    const issue = body?.details?.[0]?.issue || body?.name || "error";
    super(`PayPal ${where} ${status} ${issue}: ${body?.details?.[0]?.description || body?.message || ""}`);
    this.where = where; this.status = status; this.body = body; this.issue = issue;
  }
}

export function createPayPal(c = cfg()) {
  let cached = { token: null, exp: 0 };
  const f = c.fetchImpl || fetch;
  async function accessToken() {
    if (cached.token && Date.now() < cached.exp) return cached.token;
    const r = await f(`${c.api}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(`${c.id}:${c.secret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const j = await r.json();
    if (!r.ok) throw new PayPalError("oauth", r.status, j);
    cached = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
    return cached.token;
  }
  async function call(method, path, body, requestId) {
    const headers = { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const r = await f(`${c.api}${path}`, { method, headers, body: body === undefined || body === null ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const text = await r.text();
    let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { j = { message: text.slice(0, 200) }; }
    if (!r.ok) throw new PayPalError(`${method} ${path}`, r.status, j);
    return j;
  }
  return {
    call,
    // ---- Vault (the budget holder approves once in a browser; the agent buys against the token afterwards)
    createSetupToken: (returnUrl, cancelUrl) => call("POST", "/v3/vault/setup-tokens", { payment_source: { paypal: { usage_type: "MERCHANT", usage_pattern: "UNSCHEDULED_POSTPAID", experience_context: { return_url: returnUrl, cancel_url: cancelUrl } } } }),
    createPaymentToken: (setupTokenId, requestId) => call("POST", "/v3/vault/payment-tokens", { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } }, requestId),
    getPaymentToken: (id) => call("GET", `/v3/vault/payment-tokens/${id}`),
    // ---- Orders
    createOrder: (body, requestId) => call("POST", "/v2/checkout/orders", body, requestId),
    getOrder: (id) => call("GET", `/v2/checkout/orders/${id}`),
    confirmWithVault: (id, vaultId) => call("POST", `/v2/checkout/orders/${id}/confirm-payment-source`, {
      payment_source: { paypal: { vault_id: vaultId, stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT", usage_pattern: "UNSCHEDULED_POSTPAID" } } },
    }),
    capture: (id, requestId) => call("POST", `/v2/checkout/orders/${id}/capture`, {}, requestId),
    getCapture: (id) => call("GET", `/v2/payments/captures/${id}`),
    // ---- Webhooks
    registerWebhook: (url, types) => call("POST", "/v1/notifications/webhooks", { url, event_types: types.map((name) => ({ name })) }),
    listWebhooks: () => call("GET", "/v1/notifications/webhooks"),
    deleteWebhook: (id) => call("DELETE", `/v1/notifications/webhooks/${id}`),
    // The signature covers the exact bytes PayPal sent, so the raw body is spliced into the request as text.
    // Re-serialising a parsed object changes key order and fails verification.
    verifyWebhook: (webhookId, headers, rawBody) => call("POST", "/v1/notifications/verify-webhook-signature",
      `{"auth_algo":${JSON.stringify(headers["paypal-auth-algo"] || "")},"cert_url":${JSON.stringify(headers["paypal-cert-url"] || "")},"transmission_id":${JSON.stringify(headers["paypal-transmission-id"] || "")},"transmission_sig":${JSON.stringify(headers["paypal-transmission-sig"] || "")},"transmission_time":${JSON.stringify(headers["paypal-transmission-time"] || "")},"webhook_id":${JSON.stringify(webhookId)},"webhook_event":${rawBody}}`),
  };
}
export const cents = (v) => Math.round(Number(v) * 100);
export const money = (c) => (c / 100).toFixed(2);
