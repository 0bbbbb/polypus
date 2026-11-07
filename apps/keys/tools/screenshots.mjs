import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(__dir, "../screenshots");
const routes = [
  ["leaderboard", "#/leaderboard"],
  ["trader", "#/trader/alice-18e5.testnet"],
  ["checkout", "#/checkout/alice-18e5.testnet"],
  ["follower", "#/follower"],
  ["explorer", "#/explorer/alice-18e5.testnet"],
];
const viewports = [
  ["1440x900", { width: 1440, height: 900 }],
  ["1024x768", { width: 1024, height: 768 }],
  ["390x844", { width: 390, height: 844 }],
];

const vite = spawn("npm", ["run", "dev", "-w", "apps/keys"], {
  cwd: path.join(__dir, "../../.."),
  stdio: "ignore",
  env: { ...process.env, VITE_LIVE: "1" },
});
await new Promise(r => setTimeout(r, 3500));
try {
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  for (const [vpName, vp] of viewports) {
    const page = await browser.newPage({ viewport: vp });
  for (const [name, hash] of routes) {
      await page.goto(`http://127.0.0.1:5174/${hash}`, { waitUntil: "networkidle", timeout: 20000 });
      await page.waitForTimeout(1200);
      const file = vpName === "1440x900" ? `${name}.png` : `${name}-${vpName}.png`;
      await page.screenshot({ path: path.join(out, file), fullPage: true });
    }
    await page.close();
  }
  await browser.close();
  console.log("Wrote screenshots to", out);
} finally {
  vite.kill("SIGTERM");
}
