/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LIVE?: string;
  readonly VITE_NEAR_RPC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
