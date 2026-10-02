// Loads PayPal's saved Cart API schema into Ajv (shared by contract.test.mjs and the deployed e2e).
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
export const raw = readFileSync(new URL("../docs/evidence/agentic-commerce-v1-schema.json", import.meta.url), "utf8");
export const doc = JSON.parse(raw);
(function fold(n) { if (Array.isArray(n)) return n.forEach(fold); if (n && typeof n === "object") { if ("nullable" in n) { if (n.nullable && typeof n.type === "string") n.type = [n.type, "null"]; delete n.nullable; } Object.values(n).forEach(fold); } })(doc);
const ajv = new Ajv2020({ strict: false, allErrors: true }); addFormats(ajv); ajv.addSchema(doc, "ac");
export function check(name, value) { const v = ajv.getSchema(`ac#/components/schemas/${name}`); if (!v(value)) throw new Error(`${name}: ${JSON.stringify(v.errors.slice(0, 3))}`); }
export function checkCheckout(value) { const s = doc.paths["/merchant-cart/{cartId}/checkout"].post.responses["200"].content["application/json"].schema; const v = ajv.compile({ ...s, components: doc.components }); if (!v(value)) throw new Error(`checkout 200: ${JSON.stringify(v.errors.slice(0, 3))}`); }
