import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  // The server bundle runs as a Cloudflare Worker — there is no node_modules at
  // runtime. Vite's default SSR build leaves npm deps as bare external imports
  // (react, @tanstack/*, …), which resolve on a Node server but throw
  // "No such module" in a Worker. Bundle them all in. (node: builtins stay
  // external — nodejs_compat provides them.)
  ssr: {
    noExternal: true,
    // `cloudflare:workers` is a workerd runtime built-in that exposes the Worker
    // env / bindings (D1 `DB`, R2 `STORAGE`). Like node: builtins it must NOT be
    // bundled; the runtime provides it.
    external: ["cloudflare:workers"],
  },
  build: {
    // Keep `cloudflare:*` external in the SSR rollup pass too.
    rollupOptions: { external: [/^cloudflare:/] },
  },
  plugins: [
    // SVGs can import as React components via `?react` (sized 1em, currentColor).
    svgr({
      svgrOptions: {
        icon: true,
        svgProps: { fill: "currentColor" },
        svgoConfig: {
          plugins: [
            { name: "preset-default", params: { overrides: { removeViewBox: false } } },
          ],
        },
      },
    }),
    // TanStack Start must run before React's plugin. `vite build` emits a
    // Workers-shaped SSR bundle (dist/server/server.js — `export default { fetch }`)
    // plus dist/client (hashed static assets).
    tanstackStart({ server: { entry: "server" } }),
    react(),
    tailwindcss(),
    tsconfigPaths(),
  ],
});
