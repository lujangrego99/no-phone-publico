import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5180, proxy: { "/api": "http://127.0.0.1:8890" } },
  build: { outDir: "dist", emptyOutDir: true },
});
