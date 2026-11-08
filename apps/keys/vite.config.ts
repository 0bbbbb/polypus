import { defineConfig } from "vite";
import path from "node:path";

const proxy = { "/api": { target: "http://127.0.0.1:8787", changeOrigin: true } };

export default defineConfig({
  envDir: __dirname,
  base: "./",
  resolve: {
    alias: {
      "@polypus/sdk": path.resolve(__dirname, "../../sdk/src"),
    },
  },
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  define: { global: "globalThis" },
  server: { port: 5174, host: "127.0.0.1", proxy },
  preview: { port: 4174, host: "127.0.0.1", proxy },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
