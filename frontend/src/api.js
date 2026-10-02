const BASE = (import.meta.env && import.meta.env.VITE_API) || "http://localhost:8787";

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("The server could not be reached.", 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError((data && data.error) || `The server answered with status ${res.status}.`, res.status);
  return data;
}

export const api = {
  config: () => call("GET", "/api/config"),
  runs: () => call("GET", "/api/runs"),
  run: (id) => call("GET", `/api/runs/${encodeURIComponent(id)}`),
  create: (payload) => call("POST", "/api/runs", payload),
  approve: (id) => call("POST", `/api/runs/${encodeURIComponent(id)}/approve`, {}),
  info: (id, allergies) => call("POST", `/api/runs/${encodeURIComponent(id)}/info`, { allergies }),
  cancel: (id) => call("POST", `/api/runs/${encodeURIComponent(id)}/cancel`, {}),
  cartStatus: () => call("GET", "/api/cart-api/status"),
};
