import { defineConfig, loadEnv } from "vite";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import electron from "vite-plugin-electron";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import pkg from "./package.json";

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  const isWeb = mode === "web";
  const isDev = command === "serve";
  const isElectronBuild = command === "build" && !isWeb;
  const env = loadEnv(mode, __dirname, "");
  const cloudApiHost = env.VITE_CLOUD_API_HOST || process.env.VITE_CLOUD_API_HOST || "";
  const cloudApiBaseUrl = cloudApiHost ? `${cloudApiHost}/praiseprojector` : "";
  const appCommit =
    process.env.PP_COMMIT_SHA ||
    process.env.GIT_COMMIT ||
    (() => {
      try {
        return execSync("git rev-parse --short HEAD", { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] })
          .toString()
          .trim();
      } catch {
        return "";
      }
    })();
  const appCommitMessage =
    process.env.PP_COMMIT_MESSAGE ||
    process.env.GIT_COMMIT_MESSAGE ||
    (() => {
      try {
        return execSync("git log -1 --pretty=%s", { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] })
          .toString()
          .trim();
      } catch {
        return "";
      }
    })();
  const showCommitInAbout = Boolean(appCommit) && appCommitMessage !== `v${pkg.version}`;
  // Web builds (dev and prod) use a relative path so the runtime host is derived
  // from window.location.origin in config.ts — allowing the webapp to work on any host.
  // Electron builds use the absolute cloudApiBaseUrl when VITE_CLOUD_API_HOST is set,
  // otherwise fall back to relative path (runtime origin detection).
  const apiBaseUrl = isWeb ? "/praiseprojector" : cloudApiBaseUrl || "/praiseprojector";

  // The web build (cloud PWA + the artifact the Electron/Android host webservers serve
  // and the public /webapp deploy) gets its own outDir so it never collides with the
  // Electron *renderer* build (base "./", loaded via file://) which keeps dist/webapp.
  const webOutDir = "dist/web";
  const legacyWebappAssetSourceDir = path.join(__dirname, "public", "app");
  const soundfontSourceDir = path.join(__dirname, "public", "app", "soundfont");

  return {
    plugins: [
      react(),
      tsconfigPaths(),
      {
        name: "root-soundfont-assets",
        configureServer(server) {
          server.middlewares.use("/webapp", (req, res, next) => {
            const requestPath = decodeURIComponent((req.url || "/").split("?")[0]);
            const cleanPath = requestPath.replace(/^\/+/, "");
            const allowed =
              cleanPath === "chordpro.css" ||
              cleanPath === "chordselector.css" ||
              cleanPath.startsWith("images/") ||
              cleanPath.startsWith("soundfont/");
            if (!allowed) {
              next();
              return;
            }
            const filePath = path.normalize(path.join(legacyWebappAssetSourceDir, cleanPath));
            if (!filePath.startsWith(legacyWebappAssetSourceDir + path.sep)) {
              next();
              return;
            }
            fs.stat(filePath, (statError, stat) => {
              if (statError || !stat.isFile()) {
                next();
                return;
              }
              fs.createReadStream(filePath).pipe(res);
            });
          });
          server.middlewares.use("/soundfont", (req, res, next) => {
            const requestPath = decodeURIComponent((req.url || "/").split("?")[0]);
            const filePath = path.normalize(path.join(soundfontSourceDir, requestPath));
            if (!filePath.startsWith(soundfontSourceDir + path.sep)) {
              next();
              return;
            }
            fs.stat(filePath, (statError, stat) => {
              if (statError || !stat.isFile()) {
                next();
                return;
              }
              res.setHeader("Content-Type", "application/javascript; charset=utf-8");
              fs.createReadStream(filePath).pipe(res);
            });
          });
        },
        closeBundle() {
          // The desktop renderer is loaded from dist/webapp with base "./"; keep
          // the React app's soundfont URL independent from the historical asset tree.
          if (command !== "build" || isWeb) return;
          const soundfontOutDir = path.join(__dirname, "dist", "webapp", "soundfont");
          fs.rmSync(soundfontOutDir, { recursive: true, force: true });
          fs.cpSync(soundfontSourceDir, soundfontOutDir, { recursive: true });
        },
      },
      // Inject a unique per-build CACHE_VERSION into sw.js so every new deploy
      // triggers proper service-worker cache invalidation without manual edits.
      {
        name: "patch-sw-cache-version",
        closeBundle() {
          // Only the web build emits a service worker (the Electron renderer build
          // is loaded via file:// and never registers one).
          if (command !== "build" || !isWeb) return;
          const swPath = path.join(__dirname, webOutDir, "sw.js");
          try {
            const content = fs.readFileSync(swPath, "utf8");
            // Derive a stable build ID from the content of the entry HTML pages.
            // Vite embeds content-hashed asset filenames in each page, so this hash
            // changes if and only if the actual bundle output changed. client-view.html
            // is included so a follower-client-only change still busts the SW cache.
            const entryPages = ["index.html", "client-view.html"];
            const entryContent = entryPages
              .map((page) => {
                const p = path.join(__dirname, webOutDir, page);
                return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
              })
              .join("\n");
            const shortHash = crypto.createHash("sha256").update(entryContent).digest("hex").slice(0, 8);
            const buildId = `${pkg.version}-${shortHash}`;
            const patched = content.replace(/const CACHE_VERSION = '[^']*'/, `const CACHE_VERSION = '${buildId}'`);
            if (patched === content) {
              console.warn("[patch-sw] CACHE_VERSION pattern not found in dist/webapp/sw.js");
              return;
            }
            fs.writeFileSync(swPath, patched, "utf8");
            console.log(`[patch-sw] ${webOutDir}/sw.js CACHE_VERSION → ${buildId}`);
          } catch {
            // sw.js absent in this build variant (e.g. electron-only) — skip
          }
        },
      },
      !isWeb &&
        electron([
          {
            // Main-Process entry file of the Electron App.
            entry: "electron/main.ts",
            // Prevent auto-launching Electron; VS Code launch config will start it
            onstart() {
              // Intentionally noop to avoid duplicate Electron instances in dev
            },
            vite: {
              build: {
                sourcemap: isDev,
                minify: !isDev,
                outDir: "dist/electron",
                rollupOptions: {
                  external: ["electron-updater", "@abandonware/bleno"],
                },
              },
            },
          },
          {
            entry: path.join(__dirname, "electron/preload.ts"),
            onstart(options) {
              options.reload();
            },
            vite: {
              build: {
                sourcemap: isDev,
                minify: !isDev,
                outDir: "dist/electron",
                emptyOutDir: false,
              },
            },
          },
        ]),
    ],
    base: isElectronBuild ? "./" : isDev ? "/" : "/webapp/",
    build: {
      outDir: isWeb ? webOutDir : "dist/webapp",
      sourcemap: isDev,
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        // Web builds emit the standalone client view as a second page alongside
        // the main app. The Electron build keeps its single index.html entry.
        input: isWeb
          ? {
              main: path.resolve(__dirname, "index.html"),
              "client-view": path.resolve(__dirname, "client-view.html"),
            }
          : undefined,
        output: {
          // Function form (not the object/array form): the array form matches by
          // package *entry id*, so shared runtime modules like `react/jsx-runtime`
          // are NOT captured by `'react'` and Rollup buckets them with whichever
          // chunk references them first. That leaked the JSX runtime into
          // vendor-react-editor, forcing the standalone client-view page to preload
          // the editor-only react-dnd chunk it never uses. Routing by node_modules
          // path keeps the shared React runtime in vendor-react.
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            const inPkg = (...names: string[]) => names.some((n) => id.includes(`node_modules/${n}/`));
            // Editor-only React libraries — checked BEFORE react core so the page
            // that uses native HTML5 drag-and-drop (client-view) never pulls them
            // into its initial payload (Phase C bundle diet).
            if (inPkg("react-dnd", "react-dnd-html5-backend", "dnd-core", "@react-dnd", "react-resizable-panels")) return "vendor-react-editor";
            // React core + the shared runtime (jsx-runtime, scheduler) every entry needs.
            if (inPkg("react", "react-dom", "react-is", "scheduler")) return "vendor-react";
            if (inPkg("pdfjs-dist")) return "vendor-pdf";
            // Music - ABC notation (dynamically imported; see chordpro/abcjs-lazy.ts)
            if (inPkg("abcjs")) return "vendor-abcjs";
            // Music - MIDI (dynamically imported; see chordpro/midi.ts)
            if (inPkg("midi.js")) return "vendor-midi";
            // Word document processing (mammoth) is intentionally left unassigned so
            // it bundles with the lazy-loaded SongImporterWizard.
            if (inPkg("diff")) return "vendor-diff";
            if (inPkg("fp-ts", "io-ts")) return "vendor-fp";
            if (inPkg("localforage")) return "vendor-storage";
            if (inPkg("qrcode.react")) return "vendor-qrcode";
            if (inPkg("uuid", "bootstrap", "axios")) return "vendor-utils";
            return undefined;
          },
        },
      },
    },
    // Add proxy configuration for web app development
    server: {
      ...(isDev
        ? {
            fs: {
              allow: [path.resolve(__dirname, "..")],
            },
          }
        : {}),
      proxy: cloudApiHost
        ? {
            "/praiseprojector": {
              target: `${cloudApiHost}/praiseprojector`,
              changeOrigin: true,
              secure: true,
              rewrite: (path) => path.replace(/^\/praiseprojector/, ""),
            },
          }
        : undefined,
    },
    define: {
      "import.meta.env.VITE_API_BASE_URL": JSON.stringify(apiBaseUrl),
      "import.meta.env.VITE_CLOUD_API_HOST": JSON.stringify(cloudApiHost),
      __APP_VERSION__: JSON.stringify(pkg.version),
      __APP_COMMIT__: JSON.stringify(appCommit),
      __APP_SHOW_COMMIT__: JSON.stringify(showCommitInAbout),
    },
  };
});
