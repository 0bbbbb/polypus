import { test, expect } from "@playwright/test";

test("traders and trader story load locked", async ({ page }) => {
  await page.goto("http://127.0.0.1:5174/#/traders");
  await expect(page.locator("text=Polypus Keys").first()).toBeVisible();
  await page.goto("http://127.0.0.1:5174/#/trader/alice-18e5.testnet");
  await expect(page.locator("text=Their trades are hidden")).toBeVisible();
  await expect(page.locator(".story-banner")).toHaveCount(0);
});
