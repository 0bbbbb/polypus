import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GUARDRAILS, evaluateCopy, guardrailsHash } from "../shared/guardrails.js";

test("guardrails hash is stable", () => {
  const a = guardrailsHash(DEFAULT_GUARDRAILS);
  const b = guardrailsHash(DEFAULT_GUARDRAILS);
  assert.equal(a, b);
  assert.match(a, /^sha256-/);
});

test("evaluateCopy respects max notional", () => {
  const ok = evaluateCopy({ quoteAmount: "100", base: { symbol: "SOL" } }, DEFAULT_GUARDRAILS);
  assert.equal(ok.action, "copy");
  const big = evaluateCopy({ quoteAmount: "999999999", base: { symbol: "SOL" } }, DEFAULT_GUARDRAILS);
  assert.equal(big.action, "resize");
});

test("sizeCopy scales, caps and filters", async () => {
  const { sizeCopy } = await import("../shared/guardrails.js");
  const g = { maxTradeQuote: "100000000", allowedTokens: ["SOL"], dailyLossLimitBps: 500, copyRatioBps: 5000 };
  assert.equal(sizeCopy({ quoteAmount: "120000000", base: { symbol: "SOL" } }, g).copiedQuote, 60000000n);
  assert.equal(sizeCopy({ quoteAmount: "400000000", base: { symbol: "SOL" } }, g).action, "resize");
  assert.equal(sizeCopy({ quoteAmount: "400000000", base: { symbol: "SOL" } }, g).copiedQuote, 100000000n);
  assert.equal(sizeCopy({ quoteAmount: "10000000", base: { symbol: "BONK" } }, g).action, "skip");
});

test("pnl engine marks positions", async () => {
  const { computePnl, makeRecord } = await import("../shared/book.js");
  const t0 = Date.now() - 3600_000;
  const buy = makeRecord("a.testnet", 1, { side: "buy", sym: "SOL", usd: 200, qty: 2, price: 100 }, new Date(t0), "test");
  const sell = makeRecord("a.testnet", 1, { side: "sell", sym: "SOL", usd: 110, qty: 1, price: 110 }, new Date(t0 + 60_000), "test");
  const r = computePnl([buy, sell], { SOL: 120 });
  // realized +10, unrealized 1 * (120 - 100) = +20 → +30 / 2000 = 150 bps
  assert.equal(r.pnlBps, 150);
  assert.equal(r.tradeCount, 2);
  assert.equal(r.winRateBps, 10000);
});
