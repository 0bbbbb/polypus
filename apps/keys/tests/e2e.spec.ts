import { test, expect } from "@playwright/test";

test("leaderboard and trader screens load", async ({ page }) => {
  await page.goto("http://127.0.0.1:5174/#/leaderboard");
  await expect(page.locator("text=Polypus Keys")).toBeVisible();
  await page.goto("http://127.0.0.1:5174/#/trader/alice-18e5.testnet");
  await expect(page.locator("text=Activity feed")).toBeVisible();
});
