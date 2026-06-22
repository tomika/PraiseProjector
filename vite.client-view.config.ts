import { defineConfig } from "vite";
import path from "node:path";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import pkg from "./package.json";

/**
 * Dedicated build of the standalone client view into public/app/client-view, so
 * the Electron embedded webserver (staticDir = public/app) serves it at
 * /client-view/ with zero extra static-mount config.
 *
 * - base "./" keeps the hashed bundle self-contained at that mount point,
 * - publicDir false avoids re-copying the legacy assets (already in public/app),
 * - the entry HTML (client-view.html) resolves the legacy asset base and the API
 *   base at runtime (window.__ppAssetBase / window.__ppApiBase).
 *
 * Build with: npm run build:client-view
 */
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  base: "./",
  publicDir: false,
  build: {
    outDir: "public/app/client-view",
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "client-view.html"),
    },
  },
  define: {
    // Required so src/config.ts compiles; the served runtime overrides the API
    // base via window.__ppApiBase, so these values are not actually used there.
    "import.meta.env.VITE_API_BASE_URL": JSON.stringify("/praiseprojector"),
    "import.meta.env.VITE_CLOUD_API_HOST": JSON.stringify(""),
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(""),
    __APP_SHOW_COMMIT__: JSON.stringify(false),
  },
});
