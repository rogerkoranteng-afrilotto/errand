// Errand UI check: WCAG contrast from the real CSS tokens, then DOM checks at four widths.
// Needs the built app served (cd frontend && npx vite preview --port 4391) and the dev API on :8787.
// usage: BASE=http://localhost:4391/ node scripts/ui-check.mjs
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const css = readFileSync(new URL("../frontend/src/styles.css", import.meta.url), "utf8");
const block = (re) => { const m = re.exec(css); if (!m) throw new Error("block not found: " + re); const o = {}; for (const t of m[1].matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})/g)) o[t[1]] = t[2]; return { o, raw: m[1].replace(/\s+/g, " ").trim() }; };
const light = block(/^:root\s*\{([^}]*)\}/m);
const dark = block(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/);
const media = block(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/);

const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [foreground, background, minimum, what it is used for]
const PAIRS = [
  ["ink", "page", 4.5, "body text on page"], ["ink", "surface", 4.5, "body text on panels and inputs"],
  ["ink-2", "page", 4.5, "secondary text on page"], ["ink-2", "surface", 4.5, "secondary text on panels"],
  ["ink-2", "bar-free", 4.5, "disabled button text"], ["ink", "bar-free", 4.5, "secondary button hover"],
  ["on-primary", "primary", 4.5, "primary button text"],
  ["ok-text", "ok-tint", 4.5, "bought chip and mark"], ["ok-text", "page", 4.5, "bought mark on page"],
  ["signal", "signal-tint", 4.5, "refusal, error and failed text"], ["signal", "page", 4.5, "not-bought mark on page"],
  ["accent", "surface", 3, "rose border and icon on panels"], ["accent", "page", 3, "rose underline on page"],
  ["accent", "signal-tint", 3, "rose border on its tint"],
  ["edge", "surface", 3, "input and control borders"], ["edge", "page", 3, "control borders on page"],
  ["primary", "page", 3, "olive links and marks"], ["bar-fill", "bar-free", 3, "budget bar fill on track"],
];
let fail = 0;
console.log("CONTRAST (WCAG 2.x, from frontend/src/styles.css)");
if (JSON.stringify(dark.o) !== JSON.stringify(media.o)) { console.log("FAIL  dark theme block and prefers-color-scheme block differ"); fail++; } else console.log("PASS  dark tokens identical in manual and automatic dark blocks");
for (const [name, set] of [["light", light.o], ["dark", dark.o]]) {
  for (const [f, b, min, use] of PAIRS) {
    if (!set[f] || !set[b]) { console.log(`FAIL  ${name} missing token ${f}/${b}`); fail++; continue; }
    const r = ratio(set[f], set[b]); const ok = r >= min; if (!ok) fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(5)} ${f} ${set[f]} on ${b} ${set[b]}  ${r.toFixed(2)}:1 (need ${min})  ${use}`);
  }
}

const BASE = process.env.BASE || "http://localhost:4391/";
const API = process.env.API || "http://localhost:8787";
const runs = ["rmuqfvfjc41c4d3", "rmuqfw2q7b75e45", "rmuqfvwrecf04c1", "rmuqfw9moe3574d", "rfixturefailed", "rfixtureworking"];
const pages = [["request", "#/"], ["history", "#/runs"], ["how", "#/how"], ...runs.map((r) => ["run " + r.slice(0, 8), "#/runs/" + r])];
const browser = await chromium.launch({ executablePath: "/home/rogerkorantenng/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox"] });
console.log("\nDOM CHECKS (" + BASE + ", API " + API + ")");
const consoleErrors = [];
for (const scheme of ["light", "dark"]) for (const w of [360, 768, 1280, 1920]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, colorScheme: scheme });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") { if (!/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); }; });
  page.on("pageerror", (e) => consoleErrors.push(e.message));
  page.on("response", (r) => { if (r.status() === 404) consoleErrors.push("404 " + r.url().slice(0, 120)); });
  for (const [name, hash] of pages) {
    await page.goto(BASE + hash);
    await page.waitForSelector("h1"); await page.waitForTimeout(400);
    if (name === "request") await page.waitForSelector(".example");
    if (name === "how") await page.waitForSelector(".tbl");
    await page.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
    const problems = await page.evaluate(() => {
      const out = [];
      const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest(".sr-only") && !el.classList.contains("sr-only") && !el.classList.contains("skip"); };
      if (document.documentElement.scrollWidth > window.innerWidth) out.push(`horizontal overflow: ${document.documentElement.scrollWidth} > ${window.innerWidth}`);
      for (const el of document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, summary")) {
        if (!vis(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 37.4 || r.height < 37.4) out.push(`control too small ${Math.round(r.width)}x${Math.round(r.height)}: <${el.tagName.toLowerCase()}> ${(el.textContent || el.id || el.name || "").trim().slice(0, 30)}`);
      }
      for (const img of document.images) {
        const a = (img.getAttribute("alt") || "").trim();
        if (!a) out.push("img without alt: " + img.src.slice(0, 50));
        else if (/\.(png|jpe?g|gif|webp|svg)$/i.test(a) || /^[0-9a-f-]{20,}$/i.test(a)) out.push("img alt looks like a filename: " + a);
      }
      const hs = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(vis || (() => true));
      const h1s = hs.filter((h) => h.tagName === "H1").length;
      if (h1s !== 1) out.push(`h1 count ${h1s}`);
      let prev = 0;
      for (const h of hs) { const l = +h.tagName[1]; if (prev && l > prev + 1) out.push(`heading skips h${prev} to h${l}: ${h.textContent.trim().slice(0, 30)}`); prev = l; }
      for (const el of document.querySelectorAll("input:not([type=hidden]), select, textarea")) {
        const has = (el.labels && el.labels.length) || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
        if (!has) out.push("input without label: " + (el.id || el.name));
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n; const seen = new Set();
      while ((n = walker.nextNode())) {
        if (!n.textContent.trim()) continue;
        const el = n.parentElement; if (!el || seen.has(el) || !vis(el)) continue; seen.add(el);
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 13.4) out.push(`text ${fs.toFixed(1)}px < 13.4px: "${n.textContent.trim().slice(0, 30)}"`);
      }
      return [...new Set(out)];
    });
    if (problems.length) { fail += problems.length; for (const p of problems) console.log(`FAIL  ${scheme} ${w}px ${name}: ${p}`); }
  }
  // 200% text zoom: no horizontal scroll on the busiest pages
  await page.addStyleTag({ content: "html{font-size:200% !important}" });
  for (const [name, hash] of [pages[0], pages[3], pages[2]]) {
    await page.goto(BASE + hash); await page.waitForSelector("h1"); await page.waitForTimeout(400);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 0) { fail++; console.log(`FAIL  ${scheme} ${w}px 200% text ${name}: horizontal overflow by ${over}px`); }
  }
  await ctx.close();
  console.log(`done  ${scheme} ${w}px: ${pages.length} pages + 200% text zoom`);
}
await browser.close();
const ce = [...new Set(consoleErrors)];
if (ce.length) { fail += ce.length; ce.forEach((c) => console.log("FAIL  console error: " + c)); } else console.log("PASS  no console errors on any page");
console.log(fail ? `\nRESULT: ${fail} FAILURE(S)` : "\nRESULT: ALL CHECKS PASSED");
process.exit(fail ? 1 : 0);
