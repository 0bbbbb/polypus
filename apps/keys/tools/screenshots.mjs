import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dir, "../../..");
const out = path.join(__dir, "../screenshots");
const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}`;
const TRADER = "alice-18e5.testnet";
const viewports = [
  ["1440x900", { width: 1440, height: 900 }],
  ["390x844", { width: 390, height: 844 }],
];

execSync("npm run build -w apps/keys", {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, VITE_LIVE: "1", VITE_NEAR_RPC: "https://rpc.testnet.fastnear.com" },
});
try {
  execSync(`fuser -k ${PORT}/tcp 2>/dev/null`, { stdio: "ignore" });
} catch {
  /* free */
}

const preview = spawn("npm", ["run", "preview", "-w", "apps/keys", "--", "--port", String(PORT), "--host", "127.0.0.1"], {
  cwd: root,
  stdio: "ignore",
});
await new Promise(r => setTimeout(r, 2500));

const fileFor = (name, vpName) => path.join(out, vpName === "1440x900" ? `${name}.png` : `${name}-${vpName}.png`);

async function shot(page, name, vpName) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  await page.screenshot({ path: fileFor(name, vpName), fullPage: true });
}

const stageIs = (page, stage, timeout = 45000) =>
  page.waitForFunction(
    s => document.body.dataset.stage === s && document.body.dataset.anim === "0",
    stage,
    { timeout },
  );

function assert(cond, msg) {
  if (!cond) throw new Error(`screenshot check failed: ${msg}`);
}

try {
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  for (const [vpName, vp] of viewports) {
    const page = await browser.newPage({ viewport: vp });

    await page.goto(`${BASE}/#/traders`, { waitUntil: "networkidle", timeout: 60000 });
    await page.getByText("Copy traders whose trades stay private", { exact: false }).waitFor({ timeout: 30000 });
    await page.waitForFunction(() => /alice-18e5\.testnet/.test(document.body.innerText), { timeout: 45000 });
    await page.waitForTimeout(400);
    await shot(page, "home", vpName);

    await page.goto(`${BASE}/#/trader/${TRADER}`, { waitUntil: "networkidle", timeout: 60000 });
    await stageIs(page, "locked");
    await page.waitForFunction(() => !document.querySelector("#buy-quote[aria-busy]"), { timeout: 45000 });
    assert(!(await page.locator(".story-banner").count()), "locked page shows unlocked banner");
    assert((await page.locator("#btn-buy-key").innerText()).trim() === "Buy key", "locked buy button label");
    await page.waitForTimeout(300);
    await shot(page, "trader-locked", vpName);

    await page.click("#btn-buy-key");
    if (vpName === "1440x900") {
      await page.waitForFunction(() => document.body.dataset.stage === "key_bought", null, { timeout: 15000 });
      await page.waitForTimeout(450);
      await page.screenshot({ path: fileFor("trader-decrypting", vpName) });
    }
    await stageIs(page, "copied");
    await page.waitForTimeout(600);
    assert(/Key active/.test(await page.locator("#btn-buy-key").innerText()), "bought button label");
    assert(!(await page.locator(".dec:not(.is-plain)").count()), "feed still redacted after unlock");
    await shot(page, "trader-unlocked", vpName);

    await page.locator("#copy-agent").screenshot({ path: fileFor("copy-agent", vpName) });

    for (const id of ["proof-perf", "proof-key", "proof-copy"]) await page.click(`#${id} summary`);
    await page.waitForTimeout(300);
    await shot(page, "proof-drawer", vpName);

    await page.reload({ waitUntil: "networkidle" });
    await stageIs(page, "locked");
    await page.close();

    const demo = await browser.newPage({ viewport: vp });
    await demo.goto(`${BASE}/?demo=1#/trader/${TRADER}`, { waitUntil: "networkidle", timeout: 60000 });
    await stageIs(demo, "copied");
    await demo.close();
  }
  await browser.close();
  console.log("Wrote screenshots to", out);
} finally {
  preview.kill("SIGTERM");
}
