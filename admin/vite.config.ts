import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  // Demo en GitHub Pages: VITE_BASE=/no-phone-publico/ VITE_DEMO=1 npm run build -- --outDir ../dist-demo
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5180, proxy: { "/api": "http://127.0.0.1:8890" } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
