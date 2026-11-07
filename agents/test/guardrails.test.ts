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
