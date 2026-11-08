import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(__dir, "..");
const root = path.join(app, "../..");
const out = path.join(app, "screenshots");
const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}`;
const API = "http://127.0.0.1:8787";
const TRADERS = ["alice-18e5.testnet", "bob-18e5.testnet"];
const VP = { 1440: { width: 1440, height: 900 }, 390: { width: 390, height: 844 } };
const only = process.argv.slice(2);
const want = name => !only.length || only.some(o => name.startsWith(o));

if (!process.env.SKIP_BUILD) execSync("npm run build -w apps/keys", { cwd: root, stdio: "inherit" });
try { execSync(`fuser -k ${PORT}/tcp`, { stdio: "ignore" }); } catch {}

const health = await fetch(`${API}/api/health`).then(r => r.json()).catch(() => null);
if (!health) { console.error(`No API on ${API}. Start it (npm run mock:api, or the real agents/api).`); process.exit(1); }

const preview = spawn(path.join(root, "node_modules/.bin/vite"), ["preview", "--port", String(PORT), "--host", "127.0.0.1", "--strictPort"], { cwd: app, stdio: "ignore" });
for (let i = 0; i < 40; i++) {
  if (await fetch(BASE).then(r => r.ok, () => false)) break;
  await new Promise(r => setTimeout(r, 250));
}

const shot = async (page, name, { full = true } = {}) => {
  if (!want(name)) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: full });
  console.log("  ", name);
};
const settle = page => page.waitForTimeout(1400);

const browser = await chromium.launch({ headless: true });
const errors = [];
const ctx = async (w, identity) => {
  const c = await browser.newContext({ viewport: VP[w], deviceScaleFactor: w === 390 ? 2 : 1, reducedMotion: "no-preference" });
  if (identity) await c.addInitScript(id => localStorage.setItem("polypus.identity", JSON.stringify(id)), identity);
  const page = await c.newPage();
  page.on("pageerror", e => errors.push(`${w}: ${e.message}`));
  page.on("console", m => m.type() === "error" && !/1click|chaindefuser|Failed to load resource/i.test(m.text()) && errors.push(`${w}: ${m.text()}`));
  return page;
};

try {
  await mkdir(out, { recursive: true });

  for (const w of [1440, 390]) {
    const page = await ctx(w);
    await page.goto(`${BASE}/#/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".tt__row:not(.is-skel)", { timeout: 30000 });
    await page.waitForSelector(".act__row .tag", { timeout: 15000 }).catch(() => {});
    await settle(page);
    await shot(page, `discover-${w}`);

    await page.goto(`${BASE}/#/t/${TRADERS[0]}`);
    await page.waitForSelector(".ft__row.is-sealed", { timeout: 30000 });
    await page.waitForSelector(".pay__quote:not(:has(.skel))", { timeout: 15000 }).catch(() => {});
    await settle(page);
    await shot(page, `trader-locked-${w}`);

    await page.click(".hdr .btn--dark");
    await page.waitForSelector(".wl__item:not(.wl__item--skel)", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(500);
    await shot(page, `wallet-modal-${w}`, { full: false });
    await page.context().close();
  }

  const big = await ctx(1440);
  let trader = null;
  for (const t of TRADERS) {
    await big.goto(`${BASE}/#/t/${t}`);
    await big.waitForSelector(".buy, .active, .prog", { timeout: 30000 });
    const btn = big.getByRole("button", { name: "Try with a demo account" });
    if (await btn.count() && await btn.isEnabled()) {
      await btn.click();
      const ok = await big.waitForSelector(".prog", { timeout: 20000 }).then(() => true, () => false);
      if (ok) { trader = t; break; }
      console.warn("demo purchase did not start:", await big.locator(".buy__err").textContent().catch(() => "?"));
    }
  }
  const demoId = { kind: "demo", account: health.demo?.account ?? "carol-18e5.testnet" };
  trader ??= TRADERS[0];
  const small = await ctx(390, demoId);
  await small.goto(`${BASE}/#/t/${trader}`);

  if (await big.locator(".prog").count()) {
    await big.waitForSelector(".tl__step.is-done ~ .tl__step.is-active, .tl__step:nth-child(3).is-active", { timeout: 30000 }).catch(() => {});
    await big.waitForTimeout(800);
    await shot(big, "trader-timeline-1440", { full: false });
    await small.waitForSelector(".prog", { timeout: 15000 }).catch(() => {});
    await small.evaluate(() => document.getElementById("buy")?.scrollIntoView({ block: "start" }));
    await small.waitForTimeout(600);
    await shot(small, "trader-timeline-390", { full: false });
  } else console.warn("no in-flight timeline to capture (already holding?)");

  await big.waitForSelector(".active", { timeout: 90000 }).catch(() => {});
  const pf = await fetch(`${API}/api/portfolio/${demoId.account}`).then(r => r.json()).catch(() => null);
  const unlockT = pf?.keys?.find(k => k.trader === trader && k.decrypted.length)?.trader ?? pf?.keys?.find(k => k.decrypted.length)?.trader ?? trader;
  for (const [w, page] of [[1440, big], [390, small]]) {
    await page.goto(`${BASE}/#/t/${unlockT}`);
    await page.reload();
    await page.waitForSelector(".ft__row.is-open", { timeout: 60000 });
    await settle(page);
    await shot(page, `trader-unlocked-${w}`);
  }

  for (const [w, page] of [[1440, big], [390, small]]) {
    await page.goto(`${BASE}/#/portfolio`);
    await page.waitForSelector(".key .ct__row, .key .key__none", { timeout: 30000 });
    await settle(page);
    await shot(page, `portfolio-${w}`);
    await page.goto(`${BASE}/#/proof`);
    await page.waitForSelector(".pproof", { timeout: 30000 });
    await settle(page);
    await shot(page, `proof-${w}`);
  }
  if (errors.length) console.warn("page errors:\n" + [...new Set(errors)].join("\n"));
  console.log("Wrote screenshots to", out);
} finally {
  await browser.close().catch(() => {});
  preview.kill("SIGTERM");
}
