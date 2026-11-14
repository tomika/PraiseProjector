// Exercise production persistence in an isolated Chromium profile and origin.
// No user browser profile or real application database is opened.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const esbuild = require("esbuild");

async function main() {
  const candidates = [
    process.env.PP_TEST_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  const executable = candidates.find((file) => fs.existsSync(file));
  if (!executable) throw new Error("Set PP_TEST_BROWSER to a Chromium browser executable");
  const root = path.resolve(__dirname, "..");
  const out = path.join(root, "dist", "tests", "database");
  fs.mkdirSync(out, { recursive: true });
  const bundle = await esbuild.build({
    entryPoints: [path.join(root, "tests/database-storage.browser.ts")],
    bundle: true,
    write: false,
    outdir: path.join(out, "bundle"),
    platform: "browser",
    format: "iife",
    define: { "import.meta.env": "{}", __APP_VERSION__: JSON.stringify(require("../package.json").version) },
    logLevel: "silent",
  });
  const profile = fs.mkdtempSync(path.join(out, "browser-"));
  let browser;
  let timer;
  let server;
  let testUrl;
  let pageSocket;
  let pageReady;
  let commandId = 0;
  const pendingCommands = new Map();
  async function pageCommand(method, params = {}) {
    if (!pageReady)
      pageReady = (async () => {
        const [port] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        // Browsers may open their own pages too (Edge: edge://sync-confirmation-dialog/).
        const page = pages.find((entry) => entry.type === "page" && typeof entry.url === "string" && entry.url.startsWith(testUrl));
        if (!page) throw new Error("Test page is unavailable");
        pageSocket = new WebSocket(page.webSocketDebuggerUrl);
        pageSocket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          const pending = pendingCommands.get(message.id);
          if (!pending) return;
          pendingCommands.delete(message.id);
          if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
          else pending.resolve(message.result);
        };
        await new Promise((resolve, reject) => {
          pageSocket.onopen = resolve;
          pageSocket.onerror = reject;
        });
      })();
    await pageReady;
    return new Promise((resolve, reject) => {
      const id = ++commandId;
      const timeout = setTimeout(() => {
        pendingCommands.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 10000);
      pendingCommands.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      pageSocket.send(JSON.stringify({ id, method, params }));
    });
  }

  try {
    const outcome = new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        if (req.url.startsWith("/viewport?")) {
          const url = new URL(req.url, "http://localhost");
          pageCommand("Emulation.setDeviceMetricsOverride", {
            width: Number(url.searchParams.get("width")),
            height: Number(url.searchParams.get("height")),
            deviceScaleFactor: 1,
            mobile: false,
          })
            .then(() => res.end("ok"))
            .catch((error) => {
              res.statusCode = 500;
              res.end(String(error));
            });
        } else if (req.url.startsWith("/capture?")) {
          const name = new URL(req.url, "http://localhost").searchParams.get("name");
          if (!/^[a-z-]+$/.test(name ?? "")) {
            res.statusCode = 400;
            res.end("Invalid capture name");
            return;
          }
          pageCommand("Page.captureScreenshot", { format: "png" })
            .then((result) => {
              fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(result.data, "base64"));
              res.end("ok");
            })
            .catch((error) => {
              res.statusCode = 500;
              res.end(String(error));
            });
        } else if (req.url === "/progress") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", () => {
            console.log(body);
            res.end("ok");
          });
        } else if (req.url === "/result" && req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => {
            body += chunk;
          });
          req.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch (error) {
              reject(error);
            }
            res.end("ok");
          });
        } else if (req.url === "/test.js") {
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
          res.end(bundle.outputFiles.find((file) => file.path.endsWith(".js")).contents);
        } else if (req.url === "/test.css") {
          res.setHeader("Content-Type", "text/css; charset=utf-8");
          res.end(bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.contents ?? "");
        } else {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/test.css"><script>
            window.onerror = (message, file, line) => fetch('/result', { method: 'POST', body: JSON.stringify({ tests: [{ name: 'browser startup', error: message + ' at ' + file + ':' + line }] }) });
            window.onunhandledrejection = (event) => fetch('/result', { method: 'POST', body: JSON.stringify({ tests: [{ name: 'unhandled rejection', error: String(event.reason) }] }) });
          </script><script src="/test.js"></script>`);
        }
      });
      server.listen(0, "127.0.0.1", () => {
        const url = `http://127.0.0.1:${server.address().port}`;
        testUrl = url;
        browser = spawn(
          executable,
          [
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--remote-debugging-port=0",
            `--user-data-dir=${profile}`,
            url,
          ],
          { windowsHide: true, stdio: "ignore" }
        );
        browser.on("error", reject);
        browser.on("exit", (code) => reject(new Error(`Browser exited before tests completed (${code})`)));
      });
      timer = setTimeout(() => reject(new Error("Browser database tests timed out")), 120000);
    });
    const result = await outcome;
    for (const test of result.tests) console.log(`${test.error ? "FAIL" : "PASS"} ${test.name}${test.error ? `\n${test.error}` : ""}`);
    console.log(`${result.tests.length} browser database tests, ${result.tests.filter((test) => test.error).length} failures`);
    if (result.tests.some((test) => test.error)) process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    pageSocket?.close();
    if (server) server.close();
    try {
      const [port, endpoint] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
      const ws = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 3000);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
        ws.onclose = ws.onerror = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
    } catch {
      if (browser) browser.kill();
    }
    // Resolve and check the cleanup target before recursive removal on Windows.
    if (!path.resolve(profile).startsWith(path.resolve(out) + path.sep)) throw new Error("Invalid test profile path");
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
