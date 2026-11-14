import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static client-rendered SPA (no SSR, no Cloudflare). It calls the backend API
// at VITE_API_URL (empty string = same origin). See
// docs/superpowers/plans/2026-11-14-frontend-spa-vercel.md
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
});
