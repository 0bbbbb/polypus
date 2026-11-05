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

const vite = spawn("npm", ["run", "dev", "-w", "apps/keys"], {
  cwd: path.join(__dir, "../../.."),
  stdio: "ignore",
});
await new Promise(r => setTimeout(r, 2500));
try {
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  for (const [name, hash] of routes) {
    await page.goto(`http://127.0.0.1:5174/${hash}`, { waitUntil: "networkidle" });
    await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  }
  await browser.close();
  console.log("Wrote screenshots to", out);
} finally {
  vite.kill("SIGTERM");
}
