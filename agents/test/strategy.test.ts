import assert from "node:assert/strict";
import test from "node:test";
import { replay, makeRecord } from "../shared/book.js";
import { decide, type Series } from "../shared/strategy.js";

const H = 3_600_000;
const now = Date.UTC(2026, 10, 12, 12);

function hourly(prices: number[]): Series {
  return prices.map((p, i) => [now - (prices.length - 1 - i) * H, p]);
}

test("kestrel buys SOL on a 3h breakout above the 24h average", () => {
  const flat = Array(21).fill(100);
  const d = decide("kestrel", replay([]), { SOL: hourly([...flat, 100, 101, 102]), JUP: hourly(Array(24).fill(1)) }, now);
  assert.equal(d?.side, "buy");
  assert.equal(d?.sym, "SOL");
});

test("kestrel stays out when price is below the average", () => {
  const d = decide("kestrel", replay([]), { SOL: hourly(Array(24).fill(100).map((p, i) => p - i * 0.1)), JUP: hourly(Array(24).fill(1)) }, now);
  assert.equal(d, null);
});

test("kestrel sells an open position at stop-loss", () => {
  const buy = makeRecord("t", 1, { side: "buy", sym: "SOL", usd: 300, qty: 3, price: 100 }, new Date(now - 2 * H), "test");
  const d = decide("kestrel", replay([buy]), { SOL: hourly([...Array(23).fill(100), 96]) }, now);
  assert.equal(d?.side, "sell");
});

test("heron buys a dip below the 24h average and sells on reversion", () => {
  const dip = [...Array(8).fill(100), ...Array.from({ length: 16 }, (_, i) => 100 - (i + 1) * 0.2)];
  const d = decide("heron", replay([]), { SOL: hourly(dip), BONK: hourly(Array(24).fill(1)) }, now);
  assert.equal(d?.side, "buy");
  assert.equal(d?.sym, "SOL");
  const buy = makeRecord("t", 1, { side: "buy", sym: "SOL", usd: 250, qty: 250 / 97, price: 97 }, new Date(now - 2 * H), "test");
  const out = decide("heron", replay([buy]), { SOL: hourly([...Array(23).fill(98), 100]), BONK: hourly(Array(24).fill(1)) }, now);
  assert.equal(out?.side, "sell");
});

test("positions outside the strategy universe are closed", () => {
  const buy = makeRecord("t", 1, { side: "buy", sym: "JUP", usd: 100, qty: 100, price: 1 }, new Date(now - 2 * H), "test");
  const d = decide("heron", replay([buy]), { JUP: hourly(Array(24).fill(1)), SOL: hourly(Array(24).fill(100)), BONK: hourly(Array(24).fill(1)) }, now);
  assert.equal(d?.sym, "JUP");
  assert.equal(d?.side, "sell");
});
