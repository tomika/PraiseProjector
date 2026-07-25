import { app, ipcMain } from "electron";
import axios from "axios";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

type ProxyConfig = {
  cloudApiHost?: string;
  proxyAllowedHosts?: string[];
};

let cachedProxyConfig: ProxyConfig | null = null;

const loadProxyConfig = (): ProxyConfig => {
  if (cachedProxyConfig) return cachedProxyConfig;

  const candidates: string[] = [];
  if (app.isPackaged) {
    candidates.push(path.join(app.getPath("userData"), "proxy-config.json"));
    candidates.push(path.join(path.dirname(app.getPath("exe")), "proxy-config.json"));
    candidates.push(path.join(app.getAppPath(), "proxy-config.json"));
  }
  candidates.push(path.join(process.cwd(), "proxy-config.json"));

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as ProxyConfig;
      cachedProxyConfig = {
        cloudApiHost: typeof parsed.cloudApiHost === "string" ? parsed.cloudApiHost.trim() : "",
        proxyAllowedHosts: Array.isArray(parsed.proxyAllowedHosts)
          ? parsed.proxyAllowedHosts.map((host) => String(host).trim().toLowerCase()).filter((host) => host.length > 0)
          : [],
      };
      return cachedProxyConfig;
    } catch {
      // ignore and try next candidate
    }
  }

  cachedProxyConfig = { cloudApiHost: "", proxyAllowedHosts: [] };
  return cachedProxyConfig;
};

export const getProxyConfigValue = (key: string): string => {
  const config = loadProxyConfig();
  if (key === "VITE_CLOUD_API_HOST") return config.cloudApiHost || "";
  if (key === "PP_PROXY_ALLOWED_HOSTS") return (config.proxyAllowedHosts || []).join(",");
  return "";
};

const getProdAllowedHosts = (): Set<string> => {
  const raw = getProxyConfigValue("PP_PROXY_ALLOWED_HOSTS");
  const hosts = raw
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);

  // Convenience fallback: derive from VITE_CLOUD_API_HOST if explicit list not provided.
  if (hosts.length === 0) {
    const cloudApiHost = getProxyConfigValue("VITE_CLOUD_API_HOST");
    if (cloudApiHost) {
      try {
        const hostname = new URL(cloudApiHost).hostname.toLowerCase();
        if (hostname) hosts.push(hostname);
      } catch {
        // ignore malformed URL and keep list empty
      }
    }
  }

  return new Set(hosts);
};

const isPrivateOrLocalAddress = (hostname: string): boolean => {
  const normalized = hostname.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;

  const ipVersion = net.isIP(normalized);
  if (!ipVersion) return false;

  if (ipVersion === 4) {
    if (normalized.startsWith("10.")) return true;
    if (normalized.startsWith("127.")) return true;
    if (normalized.startsWith("192.168.")) return true;

    const secondOctet = Number(normalized.split(".")[1]);
    if (normalized.startsWith("172.") && secondOctet >= 16 && secondOctet <= 31) return true;
    return false;
  }

  // IPv6
  return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:") || normalized === "::1";
};

const validateProxyTarget = (baseUrl: string): { ok: boolean; error?: string } => {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, error: "Invalid base URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only HTTP(S) proxy targets are allowed" };
  }

  const host = parsed.hostname.toLowerCase();
  const isDev = !!process.env.VITE_DEV_SERVER_URL;
  const prodAllowedHosts = getProdAllowedHosts();

  if (isDev && isPrivateOrLocalAddress(host)) {
    return { ok: true };
  }

  // Always block private/local destinations outside dev mode.
  if (isPrivateOrLocalAddress(host)) {
    return { ok: false, error: `Private or local proxy target not allowed: ${host}` };
  }

  // Optional production allowlist via environment variable.
  // If PP_PROXY_ALLOWED_HOSTS is unset, any public host is allowed.
  if (prodAllowedHosts.size === 0 || prodAllowedHosts.has(host)) {
    return { ok: true };
  }

  return { ok: false, error: `Proxy target host not allowed: ${host}` };
};

// ─── In-memory cookie jar ──────────────────────────────────────────────────
// Minimal cookie handling so that HttpOnly Set-Cookie headers (especially the
// pp_refresh token) survive across requests — matching browser behaviour.
// Cookies are keyed by origin (scheme + host + port).
// Optionally persisted to disk when user opts into "Remember Me".

/** name → value */
type CookieMap = Map<string, string>;

/** origin → CookieMap */
const cookieJar = new Map<string, CookieMap>();
let cookieGeneration = 0;

/** Path to persisted cookie file. Resolved lazily after app is ready. */
let cookieFilePath = "";
let cookieWriteSequence = 0;

/** When true, cookie jar changes are automatically written to disk. */
let cookiePersistenceEnabled = false;

function getCookieFilePath(): string {
  if (!cookieFilePath) {
    cookieFilePath = path.join(app.getPath("userData"), "pp-cookies.json");
  }
  return cookieFilePath;
}

/** Load persisted cookies from disk into the in-memory jar (called once at init). */
function loadPersistedCookies(): void {
  try {
    const filePath = getCookieFilePath();
    if (!fs.existsSync(filePath)) return;
    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, Record<string, string>>;
    for (const [origin, cookies] of Object.entries(data)) {
      const jar = new Map<string, string>();
      for (const [name, value] of Object.entries(cookies)) {
        jar.set(name, value);
      }
      cookieJar.set(origin, jar);
      console.debug(`[Proxy Cookie] Restored ${jar.size} cookie(s) for ${origin}: ${[...jar.keys()].join(", ")}`);
    }
    cookiePersistenceEnabled = true;
    console.info(`[Proxy Cookie] Loaded persisted cookies for ${Object.keys(data).length} origin(s) — auto-persist enabled`);
  } catch {
    // Ignore parse/read errors — start with empty jar
  }
}

/** Persist the current in-memory cookie jar to disk. */
function persistCookiesToDisk(): void {
  try {
    const data: Record<string, Record<string, string>> = {};
    let cookieCount = 0;
    for (const [origin, jar] of cookieJar.entries()) {
      const cookies: Record<string, string> = {};
      for (const [name, value] of jar.entries()) {
        cookies[name] = value;
        ++cookieCount;
      }
      data[origin] = cookies;
    }
    const json = JSON.stringify(data);
    const generation = cookieGeneration;
    const writeSequence = ++cookieWriteSequence;
    const filePath = getCookieFilePath();
    const tempPath = `${filePath}.${process.pid}.${writeSequence}.tmp`;
    // Use async write to avoid blocking the main-process event loop
    fs.promises
      .writeFile(tempPath, json, "utf8")
      .then(async () => {
        if (generation !== cookieGeneration || writeSequence !== cookieWriteSequence || !cookiePersistenceEnabled) {
          await fs.promises.unlink(tempPath).catch(() => undefined);
          return;
        }
        await fs.promises.unlink(filePath).catch(() => undefined);
        await fs.promises.rename(tempPath, filePath);
        console.info(`[Proxy Cookie] Persisted ${cookieCount} cookie(s) across ${Object.keys(data).length} origin(s) to disk`);
      })
      .catch((error: unknown) => {
        void fs.promises.unlink(tempPath).catch(() => undefined);
        console.error("[Proxy Cookie] Failed to persist cookies", error);
      });
  } catch (error) {
    console.error("[Proxy Cookie] Failed to persist cookies", error);
  }
}

/** Delete persisted cookie file from disk. */
function clearPersistedCookies(): void {
  try {
    const filePath = getCookieFilePath();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.info("[Proxy Cookie] Cleared persisted cookies from disk");
    }
  } catch (error) {
    console.error("[Proxy Cookie] Failed to clear persisted cookies", error);
  }
}

/** Invalidate every response that started with the previous cookie state. */
function clearCookieState(): void {
  cookieGeneration++;
  cookiePersistenceEnabled = false;
  clearPersistedCookies();
  cookieJar.clear();
}

function getOrigin(url: string): string {
  try {
    const u = new URL(url);
    return u.origin; // e.g. "https://example.com"
  } catch {
    return url;
  }
}

/** Extract cookies from Set-Cookie response headers and store them. */
function captureResponseCookies(url: string, response: { headers?: Record<string, unknown> }): void {
  const raw = response.headers?.["set-cookie"];
  if (!raw) {
    if (new URL(url).pathname === "/session") {
      console.debug("[Proxy Cookie] No Set-Cookie headers on /session response");
    }
    return;
  }

  const origin = getOrigin(url);
  let jar = cookieJar.get(origin);
  if (!jar) {
    jar = new Map();
    cookieJar.set(origin, jar);
  }

  const items = Array.isArray(raw) ? raw : [raw];
  for (const setCookie of items) {
    if (typeof setCookie !== "string") continue;
    // Parse "name=value; attr; attr…"
    const nameValue = setCookie.split(";")[0];
    const eqIdx = nameValue.indexOf("=");
    if (eqIdx < 1) continue;
    const name = nameValue.substring(0, eqIdx).trim();
    const value = nameValue.substring(eqIdx + 1).trim();

    // Honour Max-Age=0 / Expires in the past → delete the cookie.
    const lower = setCookie.toLowerCase();
    const maxAgeMatch = lower.match(/max-age\s*=\s*(-?\d+)/);
    if (maxAgeMatch && parseInt(maxAgeMatch[1]) <= 0) {
      console.debug(`[Proxy Cookie] Deleting cookie: ${name} (Max-Age=0)`);
      jar.delete(name);
      continue;
    }

    console.debug(`[Proxy Cookie] Stored: ${name} (len=${value.length}) for ${origin}`);
    jar.set(name, value);
  }

  console.debug(`[Proxy Cookie] Jar for ${origin} now has ${jar.size} cookie(s): ${[...jar.keys()].join(", ")}`);

  // Auto-persist to disk when "Remember Me" is active.
  if (cookiePersistenceEnabled) {
    persistCookiesToDisk();
  }
}

/** Build a Cookie header string for the given URL. */
function getCookieHeader(url: string): string {
  const jar = cookieJar.get(getOrigin(url));
  if (!jar || jar.size === 0) return "";
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** Merge stored cookies into the outgoing request headers. */
function applyRequestCookies(url: string, headers: Record<string, string>): Record<string, string> {
  // When the request already carries an explicit Authorization header, skip
  // cookie injection. This prevents stale session cookies from a previous user
  // from shadowing the explicit credentials (e.g. Basic auth for impersonation
  // or a Bearer token for a different user).
  if (headers["Authorization"] || headers["authorization"]) return headers;
  const cookie = getCookieHeader(url);
  if (!cookie) {
    if (new URL(url).pathname === "/session") {
      console.warn("[Proxy Cookie] No cookies available for /session request");
    }
    return headers;
  }
  const names = cookie.split("; ").map((c) => c.split("=")[0]);
  console.debug(`[Proxy Cookie] Attaching cookies to ${new URL(url).pathname}: ${names.join(", ")}`);
  return { ...headers, Cookie: cookie };
}

export function initializeProxy() {
  const proxyRequests = new Map<string, AbortController>();

  // Load any persisted cookies from a previous "Remember Me" session.
  loadPersistedCookies();

  ipcMain.handle("persist-cookies", () => {
    cookiePersistenceEnabled = true;
    persistCookiesToDisk();
    return true;
  });

  ipcMain.handle("clear-persisted-cookies", () => {
    clearCookieState();
    return true;
  });

  ipcMain.on("proxy-abort", (_event, requestId: string) => {
    proxyRequests.get(requestId)?.abort();
  });

  ipcMain.handle("get-cloud-api-host", () => {
    const config = loadProxyConfig();
    const host = config.cloudApiHost || "";
    return host ? `${host.replace(/\/+$/, "")}/praiseprojector` : "";
  });

  ipcMain.handle(
    "proxy-get",
    async (
      _event,
      baseUrl: string,
      path: string,
      headers?: Record<string, string>,
      options?: { requestId: string; timeoutMs?: number; clearCookiesAfterSnapshot?: boolean }
    ) => {
      const validation = validateProxyTarget(baseUrl);
      if (!validation.ok) {
        if (options?.clearCookiesAfterSnapshot) clearCookieState();
        console.warn(`[Proxy GET] Blocked target: ${baseUrl} (${validation.error || "validation failed"})`);
        return {
          error: {
            message: validation.error || "Proxy target validation failed",
            status: 400,
          },
        };
      }

      const url = `${baseUrl}${path}`;
      const requestHeaders = applyRequestCookies(url, headers || {});
      const requestCookieGeneration = cookieGeneration;
      if (options?.clearCookiesAfterSnapshot) clearCookieState();
      const controller = new AbortController();
      if (options?.requestId) proxyRequests.set(options.requestId, controller);
      const captureCookies = (response: { headers?: Record<string, unknown> }) => {
        if (cookieGeneration === requestCookieGeneration) {
          captureResponseCookies(url, response);
        } else {
          console.debug(`[Proxy Cookie] Ignoring stale response cookies for ${new URL(url).pathname}`);
        }
      };
      console.debug(`[Proxy GET] Request: ${url}`);
      try {
        const response = await axios.get(url, {
          headers: requestHeaders,
          signal: controller.signal,
          timeout: options?.timeoutMs,
        });
        captureCookies(response);

        const ppHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers || {})) {
          const lowerKey = key.toLowerCase();
          if (!lowerKey.startsWith("x-pp-")) continue;
          const headerValue = Array.isArray(value) ? value.join(",") : String(value ?? "");
          ppHeaders[lowerKey.substring(5)] = headerValue;
        }

        const dataSize = JSON.stringify(response.data).length;
        console.debug(`[Proxy GET] Response: ${url} - Status: ${response.status}, Size: ${dataSize} bytes`);
        return {
          data: response.data,
          ppHeaders,
        };
      } catch (error) {
        console.error(`[Proxy GET] Failed: ${url}`, error);
        if (axios.isAxiosError(error)) {
          if (error.response) captureCookies(error.response);
          return {
            error: {
              message: error.message,
              status: error.response?.status,
              data: error.response?.data,
            },
          };
        }
        return {
          error: {
            message: "An unknown error occurred",
          },
        };
      } finally {
        if (options?.requestId) proxyRequests.delete(options.requestId);
      }
    }
  );

  ipcMain.handle(
    "proxy-post",
    async (
      _event,
      baseUrl: string,
      path: string,
      data: unknown,
      headers?: Record<string, string>,
      options?: { requestId: string; timeoutMs?: number; clearCookiesAfterSnapshot?: boolean }
    ) => {
      const validation = validateProxyTarget(baseUrl);
      if (!validation.ok) {
        if (options?.clearCookiesAfterSnapshot) clearCookieState();
        console.warn(`[Proxy POST] Blocked target: ${baseUrl} (${validation.error || "validation failed"})`);
        return {
          error: {
            message: validation.error || "Proxy target validation failed",
            status: 400,
          },
        };
      }

      const url = `${baseUrl}${path}`;
      const requestHeaders = applyRequestCookies(url, {
        "Content-Type": "application/json",
        ...(headers || {}),
      });
      const requestCookieGeneration = cookieGeneration;
      if (options?.clearCookiesAfterSnapshot) clearCookieState();
      const controller = new AbortController();
      if (options?.requestId) proxyRequests.set(options.requestId, controller);
      const captureCookies = (response: { headers?: Record<string, unknown> }) => {
        if (cookieGeneration === requestCookieGeneration) {
          captureResponseCookies(url, response);
        } else {
          console.debug(`[Proxy Cookie] Ignoring stale response cookies for ${new URL(url).pathname}`);
        }
      };
      const requestSize = JSON.stringify(data).length;
      console.debug(`[Proxy POST] Request: ${url} - Payload: ${requestSize} bytes`);
      try {
        const response = await axios.post(url, data, {
          headers: requestHeaders,
          signal: controller.signal,
          timeout: options?.timeoutMs,
        });
        captureCookies(response);

        const ppHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(response.headers || {})) {
          const lowerKey = key.toLowerCase();
          if (!lowerKey.startsWith("x-pp-")) continue;
          const headerValue = Array.isArray(value) ? value.join(",") : String(value ?? "");
          ppHeaders[lowerKey.substring(5)] = headerValue;
        }

        const responseSize = JSON.stringify(response.data).length;
        console.debug(`[Proxy POST] Response: ${url} - Status: ${response.status}, Size: ${responseSize} bytes`);
        return {
          data: response.data,
          ppHeaders,
        };
      } catch (error) {
        console.error(`[Proxy POST] Failed: ${url}`, error);
        if (axios.isAxiosError(error)) {
          if (error.response) captureCookies(error.response);
          return {
            error: {
              message: error.message,
              status: error.response?.status,
              data: error.response?.data,
            },
          };
        }
        return {
          error: {
            message: "An unknown error occurred",
          },
        };
      } finally {
        if (options?.requestId) proxyRequests.delete(options.requestId);
      }
    }
  );
}
