import type { Guardrails as G } from "../api/types";
import { fromBase6, num, toBase6 } from "../lib/format";
import { TOKENS } from "../state/actions";

export function guardrailRows(g: G): [string, string][] {
  return [
    ["Max per trade", `${num(fromBase6(g.maxTradeQuote), 0)} pUSD`],
    ["Copy size", `${g.copyRatioBps / 100}% of trader`],
    ["Tokens", g.allowedTokens.length ? g.allowedTokens.join(" · ") : "none"],
  ];
}

export function GuardrailsSummary({ g }: { g: G }) {
  return (
    <dl class="dl">
      {guardrailRows(g).map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function GuardrailsEditor({ value, onChange, disabled }: { value: G; onChange: (g: G) => void; disabled?: boolean }) {
  const max = fromBase6(value.maxTradeQuote);
  const ratio = value.copyRatioBps / 100;
  const set = (p: Partial<G>) => onChange({ ...value, ...p });

  return (
    <div class="gr" aria-disabled={disabled}>
      <label class="gr__row">
        <span class="gr__k">Max per trade</span>
        <span class="field">
          <input
            type="number"
            inputMode="decimal"
            min={1}
            max={100000}
            step={10}
            value={max}
            disabled={disabled}
            onInput={e => {
              const v = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(v) && v >= 0) set({ maxTradeQuote: toBase6(clamp(v, 0, 1_000_000)) });
            }}
          />
          <span class="field__unit">pUSD</span>
        </span>
      </label>

      <div class="gr__row gr__row--stack">
        <div class="gr__line">
          <span class="gr__k">Copy size</span>
          <span class="stepper">
            <button type="button" disabled={disabled || ratio <= 5} onClick={() => set({ copyRatioBps: clamp(value.copyRatioBps - 500, 500, 20000) })} aria-label="Decrease copy size">−</button>
            <span class="stepper__v tnum">{ratio}%</span>
            <button type="button" disabled={disabled || ratio >= 200} onClick={() => set({ copyRatioBps: clamp(value.copyRatioBps + 500, 500, 20000) })} aria-label="Increase copy size">+</button>
          </span>
        </div>
        <input
          class="range"
          type="range"
          min={5}
          max={200}
          step={5}
          value={ratio}
          disabled={disabled}
          style={{ "--r": (ratio - 5) / 195 }}
          aria-label="Copy size, percent of trader notional"
          onInput={e => set({ copyRatioBps: Number((e.target as HTMLInputElement).value) * 100 })}
        />
        <span class="gr__hint">{ratio === 100 ? "1:1 with the trader" : `${ratio}% of each trade's notional, capped at max per trade`}</span>
      </div>

      <div class="gr__row">
        <span class="gr__k">Tokens</span>
        <span class="toggles" role="group" aria-label="Token allowlist">
          {TOKENS.map(t => {
            const on = value.allowedTokens.includes(t);
            return (
              <button
                key={t}
                type="button"
                class={on ? "toggle is-on" : "toggle"}
                aria-pressed={on}
                disabled={disabled}
                onClick={() => set({ allowedTokens: on ? value.allowedTokens.filter(x => x !== t) : [...value.allowedTokens, t] })}
              >
                {t}
              </button>
            );
          })}
        </span>
      </div>

    </div>
  );
}

export function sameGuardrails(a: G | null | undefined, b: G | null | undefined) {
  if (!a || !b) return false;
  return a.maxTradeQuote === b.maxTradeQuote && a.copyRatioBps === b.copyRatioBps && a.dailyLossLimitBps === b.dailyLossLimitBps &&
    [...a.allowedTokens].sort().join() === [...b.allowedTokens].sort().join();
}
