import { createChannel3 } from "../backend/channel3.mjs";
const c = createChannel3();
const qs = process.argv.slice(2);
for (const q of qs) {
  const t = Date.now();
  const ps = await c.search(q);
  console.log(`\n## ${q}  (${Date.now()-t} ms, ${ps.length})`);
  for (const p of ps) console.log(` ${p.id} | ${p.title.slice(0,70)} | ${p.brands.join("/")} | ${p.offers.map(o=>`$${(o.priceCents/100).toFixed(2)} ${o.domain} ${o.availability}`).join("; ")}`);
}
