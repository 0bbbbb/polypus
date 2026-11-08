/** Human labels + 1Click origin assets for the pay-with selector (probe amounts only; no spend). */
export type PayOption = {
  id: string;
  label: string;
  chain: string;
  originAsset: string;
  amount: string;
};

export const PAY_OPTIONS: PayOption[] = [
  {
    id: "usdc-base",
    label: "USDC on Base",
    chain: "Base",
    originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    amount: "2000000",
  },
  {
    id: "eth",
    label: "ETH",
    chain: "Ethereum",
    originAsset: "nep141:eth-0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE.omft.near",
    amount: "500000000000000000",
  },
  {
    id: "sol",
    label: "SOL",
    chain: "Solana",
    originAsset: "nep141:sol.omft.near",
    amount: "150000000",
  },
  {
    id: "btc",
    label: "BTC",
    chain: "Bitcoin",
    originAsset: "nep141:btc.omft.near",
    amount: "50000",
  },
];

export const QUOTE_DESTINATION =
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
