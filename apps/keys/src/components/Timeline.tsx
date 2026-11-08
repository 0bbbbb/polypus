import type { StepKey, Timeline as T, TimelineStep } from "../api/types";
import { clock } from "../lib/format";
import { useNow } from "../lib/hooks";
import { Dec, ICheck, TxLink } from "./ui";

const FALLBACK: Record<StepKey, string> = {
  subscribed: "Subscribed",
  sealed: "Key sealed to agent",
  decrypted: "Trades decrypted",
  copied: "Copied on Solana",
};

const WAITING: Record<StepKey, string> = {
  subscribed: "subscribe() on the registry",
  sealed: "Trader node seals the epoch key to your agent's X25519 key",
  decrypted: "Agent decrypts the feed inside its TEE",
  copied: "Agent signs on Solana devnet via Chain Signatures",
};

export function Timeline({ timeline, compact }: { timeline: T; compact?: boolean }) {
  const steps = timeline.steps;
  const doneN = steps.filter(s => s.status === "done").length;
  return (
    <ol class={`tl${compact ? " tl--compact" : ""}`} aria-label="Key delivery progress" style={{ "--tl-p": doneN / Math.max(1, steps.length) }}>
      {steps.map((s, i) => <Step key={s.key} step={s} n={i + 1} last={i === steps.length - 1} compact={compact} />)}
    </ol>
  );
}

function Step({ step, n, last, compact }: { step: TimelineStep; n: number; last: boolean; compact?: boolean }) {
  const now = useNow();
  const { status } = step;
  const elapsed = status === "active" && step.at ? Math.max(0, Math.round((now - step.at) / 1000)) : null;
  return (
    <li class={`tl__step is-${status}${last ? " is-last" : ""}`}>
      <span class="tl__mark" aria-hidden="true">
        {status === "done" ? <ICheck size={11} /> : status === "error" ? <b>!</b> : <span class="tl__n">{n}</span>}
      </span>
      <div class="tl__body">
        <div class="tl__row">
          <span class="tl__label">{status === "done" ? <Dec text={step.label || FALLBACK[step.key]} /> : step.label || FALLBACK[step.key]}</span>
          <span class="tl__time tnum">
            {status === "done" && step.at ? clock(step.at, true) : status === "active" ? (elapsed != null ? `${elapsed}s` : "now") : status === "error" ? "failed" : ""}
          </span>
        </div>
        {!compact || status !== "done" ? (
          <p class="tl__detail">{step.detail || (status === "waiting" ? WAITING[step.key] : "")}</p>
        ) : null}
        {step.txs.length > 0 && (
          <div class="tl__txs">
            {step.txs.slice(0, compact ? 2 : 4).map(tx => <TxLink key={tx.hash} tx={tx} />)}
            {step.txs.length > (compact ? 2 : 4) && <span class="tl__more">+{step.txs.length - (compact ? 2 : 4)}</span>}
          </div>
        )}
      </div>
    </li>
  );
}
