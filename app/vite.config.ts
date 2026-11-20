import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static client-rendered SPA. It only calls the API on its own origin (/api/...):
// in production Vercel rewrites /api/* to Railway (vercel.json) and Railway also
// serves this build itself. A cross-origin API URL cannot work (the session cookie
// is __Host-/SameSite=Strict and photo URLs are relative), so `vite` dev proxies
// /api to the local API instead (Host is kept, so its origin check passes).
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  server: { proxy: { "/api": "http://localhost:3000" } },
});
