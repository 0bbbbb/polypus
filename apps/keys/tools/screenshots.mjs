import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dir, "../../..");
const out = path.join(__dir, "../screenshots");
const PORT = 4174;
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

async function shot(page, name, vpName) {
  const file = vpName === "1440x900" ? `${name}.png` : `${name}-${vpName}.png`;
  await page.screenshot({ path: path.join(out, file), fullPage: true });
}

try {
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  for (const [vpName, vp] of viewports) {
    const page = await browser.newPage({ viewport: vp });

    await page.goto(`http://127.0.0.1:${PORT}/#/traders`, { waitUntil: "networkidle", timeout: 60000 });
    await page.getByText("Copy traders whose trades stay private", { exact: false }).waitFor({ timeout: 30000 });
    await page.waitForFunction(() => /alice-18e5\.testnet/.test(document.body.innerText), { timeout: 45000 });
    await page.waitForTimeout(400);
    await shot(page, "home", vpName);

    await page.goto(`http://127.0.0.1:${PORT}/#/trader/alice-18e5.testnet`, { waitUntil: "networkidle", timeout: 60000 });
    await page.evaluate(() => sessionStorage.clear());
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#btn-buy-key").waitFor({ timeout: 30000 });
    await page.waitForFunction(() => /You pay ~|Choose how you want/.test(document.body.innerText), { timeout: 45000 });
    await shot(page, "trader-locked", vpName);

    await page.click("#btn-demo-unlock");
    await page.waitForFunction(() => /Key delivered to your copy agent/.test(document.body.innerText), { timeout: 15000 });
    await page.waitForTimeout(1200);
    await shot(page, "trader-unlocked", vpName);

    await page.locator(".agent-section, #copy-agent").first().scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);
    await shot(page, "copy-agent", vpName);

    await page.locator(".proof").first().evaluate(el => el.setAttribute("open", ""));
    await page.waitForTimeout(200);
    await shot(page, "proof-drawer", vpName);

    await page.close();
  }
  await browser.close();
  console.log("Wrote screenshots to", out);
} finally {
  preview.kill("SIGTERM");
}
