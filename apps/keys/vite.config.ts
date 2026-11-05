import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  base: "./",
  resolve: {
    alias: {
      "@polypus/sdk": path.resolve(__dirname, "../../sdk/src"),
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
