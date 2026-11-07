export type GuardrailsWire = {
  maxTradeQuote: string;
  allowedTokens: string[];
  dailyLossLimitBps: number;
  copyRatioBps: number;
};

export { type GuardrailsWire as Guardrails };
