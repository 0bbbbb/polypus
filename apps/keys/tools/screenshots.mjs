import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dir, "../../..");
const out = path.join(__dir, "../screenshots");
const PORT = 4174;
const routes = [
  ["leaderboard", "#/leaderboard", "Attested performance"],
  ["trader", "#/trader/alice-18e5.testnet", "Activity feed"],
  ["checkout", "#/checkout/alice-18e5.testnet", "Buy key"],
  ["follower", "#/follower", "Copy agent"],
  ["explorer", "#/explorer/alice-18e5.testnet", "Public settlement"],
];
const viewports = [
  ["1440x900", { width: 1440, height: 900 }],
  ["1024x768", { width: 1024, height: 768 }],
  ["390x844", { width: 390, height: 844 }],
];

execSync("npm run build -w apps/keys", { cwd: root, stdio: "inherit" });
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
try {
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  for (const [vpName, vp] of viewports) {
    const page = await browser.newPage({ viewport: vp });
    for (const [name, hash, marker] of routes) {
      await page.goto(`http://127.0.0.1:${PORT}/${hash}`, { waitUntil: "networkidle", timeout: 60000 });
      await page.getByText(marker, { exact: false }).first().waitFor({ state: "visible", timeout: 30000 });
      if (name === "follower") {
        await page.locator(".kc__copied li").first().waitFor({ state: "visible", timeout: 30000 });
      }
      await page.waitForTimeout(500);
      const file = vpName === "1440x900" ? `${name}.png` : `${name}-${vpName}.png`;
      await page.screenshot({ path: path.join(out, file), fullPage: true });
    }
    await page.close();
  }
  await browser.close();
  console.log("Wrote screenshots to", out);
} finally {
  preview.kill("SIGTERM");
}
