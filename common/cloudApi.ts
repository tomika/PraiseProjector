import * as t from "io-ts";
import { decode } from "./io-utils";
import {
  Display,
  DisplayStylesQueryResponse,
  OnlineSessionEntry,
  PeekResponse,
  PlaylistEntry,
  PendingSongOperation,
  SessionResponse,
  SongDBPendingEntry,
  SongDBEntry,
  SongFound,
  SyncRequest,
  SyncResponse,
  LeaderDBProfile,
  EditSongResponse,
  DeviceDataResponse,
  SuggestResponse,
  SongPreferenceEntry,
} from "./pp-types";
import {
  displayCodec,
  leadersResponseCodec,
  onlineSessionEntryListCodec,
  peekResponseCodec,
  sessionResponseCodec,
  songHistoryResponseCodec,
  songsResponseCodec,
  syncResponseCodec,
  editSongResponseCodec,
  netDisplayDataCodec,
  displayStylesQueryResponseCodec,
  pendingSongsResponseCodec,
} from "./pp-codecs";
import type { NetDisplayData, SongHistoryEntry } from "./pp-types";
import type { ChordProStylesSettings } from "./chordpro-styles";

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;
type CloudRequestOptions = {
  signal?: AbortSignal;
  allowEmpty?: boolean;
  skipRefresh?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
  clearCookiesAfterSnapshot?: boolean;
  responseType?: "json" | "text";
  includePpHeaders?: boolean;
  cache?: RequestCache;
  allowSignedOutSession?: boolean;
};

export type DisplayUpdateResult = "DONE" | "SKIPPED" | "NO_SESSION" | "UNAUTHORIZED" | "UNKNOWN_LEADER" | "ERROR";

export type DisplaySessionTarget = { leaderId: string; sessionId?: never } | { sessionId: string; leaderId?: never };

export type FcmTestResult = {
  attempted: number;
  sent: number;
  unregistered: number;
  retry: number;
};

const DISPLAY_UPDATE_RESULTS = new Set<DisplayUpdateResult>(["DONE", "SKIPPED", "NO_SESSION", "UNAUTHORIZED", "UNKNOWN_LEADER", "ERROR"]);

export function isGuestDisplaySessionId(value: string): boolean {
  return value.startsWith("guest_");
}

function appendDisplayTarget(endpoint: string, target?: Partial<DisplaySessionTarget>): string {
  if (target?.leaderId && target?.sessionId) throw new Error("A display request cannot target both a leader and a guest session");
  if (target?.sessionId) return `${endpoint}${endpoint.includes("?") ? "&" : "?"}session=${encodeURIComponent(target.sessionId)}`;
  if (target?.leaderId) {
    const key = isGuestDisplaySessionId(target.leaderId) ? "session" : "leader";
    return `${endpoint}${endpoint.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(target.leaderId)}`;
  }
  return endpoint;
}

type ProxyRequestOptions = {
  requestId: string;
  timeoutMs?: number;
  clearCookiesAfterSnapshot?: boolean;
  omitCookies?: boolean;
};

function isRetryableStatus(status: number) {
  return status === 429 || status === 503;
}

function getRetryDelay(retryAfterHeader: string | null, attempt: number) {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader);
    if (!isNaN(seconds)) return seconds * 1000;
  }
  return BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export type CloudApiErrorKind = "auth" | "network" | "http" | "aborted";

export class CloudApiError extends Error {
  readonly kind: CloudApiErrorKind;
  readonly status?: number;
  readonly endpoint?: string;

  constructor(kind: CloudApiErrorKind, message: string, options?: { status?: number; endpoint?: string }) {
    super(message);
    this.name = "CloudApiError";
    this.kind = kind;
    this.status = options?.status;
    this.endpoint = options?.endpoint;
  }
}

export function isCloudApiErrorKind(error: unknown, kind: CloudApiErrorKind): boolean {
  return error instanceof CloudApiError && error.kind === kind;
}

/** A short-lived v2 access token (`atk.…`), with or without a Bearer prefix.
 *  It cannot renew a session by itself; `/session` renews with the refresh cookie. */
export function isAccessToken(token: string | null | undefined): boolean {
  return !!token && token.replace(/^Bearer /, "").startsWith("atk.");
}

function isLikelyNetworkErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("network error") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("fetch failed") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("econnrefused") ||
    normalized.includes("econnreset") ||
    normalized.includes("enotfound") ||
    normalized.includes("ehostunreach") ||
    normalized.includes("host unreachable") ||
    normalized.includes("dns") ||
    normalized.includes("offline") ||
    normalized.includes("unable to connect")
  );
}

function isNavigatorOffline(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.onLine === "boolean" && navigator.onLine === false;
}

function shouldSkipRetryBackoffForOffline503(status: number, hint?: string): boolean {
  if (status !== 503) return false;
  if (isNavigatorOffline()) return true;
  return !!hint && isLikelyNetworkErrorMessage(hint);
}

function getOfflineErrorMessage(hint?: string): string {
  const text = hint?.trim();
  if (text) return text;
  return isNavigatorOffline() ? "Device appears to be offline" : "Offline";
}

/**
 * Electron IPC proxy interface for server calls
 */
interface IProxyAPI {
  proxyGet(
    baseUrl: string,
    path: string,
    headers?: Record<string, string>,
    options?: ProxyRequestOptions
  ): Promise<{ data: unknown; ppHeaders: Record<string, string> } | { error: { message: string; status?: number; data?: unknown } }>;
  proxyPost(
    baseUrl: string,
    path: string,
    data: unknown,
    headers?: Record<string, string>,
    options?: ProxyRequestOptions
  ): Promise<{ data: unknown; ppHeaders: Record<string, string> } | { error: { message: string; status?: number; data?: unknown } }>;
  proxyAbort?(requestId: string): void;
}

function extractPpHeadersFromFetch(headers: Headers): Record<string, string> {
  const ppHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower.startsWith("x-pp-")) ppHeaders[lower.substring(5)] = value;
  });
  return ppHeaders;
}

export class CloudApiService {
  private authToken: string | null = null;
  private accessTokenExp: number = 0; // unix seconds
  private clientId: string = "";
  private refreshPromise: Promise<boolean> | null = null;
  private authGeneration = 0;
  private tokenRevision = 0;
  private sessionEnabled = true;
  // Base URL for API calls (set via setBaseUrl)
  private baseUrl: string = "";
  // Track in-flight requests for abort support
  private inFlightRequests = new Set<AbortController>();
  private fixedHeaders = new Map<string, string>();
  private proxyApi?: IProxyAPI;
  private proxyRequestSequence = 0;

  // Peek response cache — avoids duplicate network calls within the TTL window.
  // Default TTL (10 s) matches MIN_PEEK_INTERVAL_SECONDS in UserPanel.
  // Callers that want a guaranteed fresh result call invalidatePeekCache() first.
  static readonly DEFAULT_PEEK_CACHE_TTL_MS = 10_000;
  private peekCache: {
    result: PeekResponse;
    expiresAt: number;
    includeUpstream: boolean;
  } | null = null;
  private peekInFlight: {
    request: Promise<PeekResponse>;
    includeUpstream: boolean;
  } | null = null;
  private peekCacheTtlMs = CloudApiService.DEFAULT_PEEK_CACHE_TTL_MS;
  private peekGeneration = 0;

  /** Override the peek cache TTL (milliseconds). Call with the user-configured
   *  peek interval so that all callers share the same deduplication window. */
  setPeekCacheTtl(ms: number): void {
    this.peekCacheTtlMs = Math.max(1_000, ms);
  }

  /** Force the next fetchPeek() to go to the network regardless of cache age. */
  invalidatePeekCache(): void {
    this.peekCache = null;
    this.peekInFlight = null;
    this.peekGeneration++;
  }

  setProxy(proxyApi: IProxyAPI) {
    this.proxyApi = proxyApi;
  }

  setToken(token: string | null): void {
    if (this.authToken !== token) this.authGeneration++;
    this.applyToken(token);
  }

  /** Cancel work belonging to the previous login/logout intent, even in cookie mode. */
  resetSession(): void {
    this.authGeneration++;
    this.abortAll();
    this.refreshPromise = null;
    this.applyToken(null);
    this.invalidatePeekCache();
  }

  /** HttpOnly cookies may survive an offline logout in a PWA. Never use them
   * again until an explicit login succeeds, including after a page restart. */
  setSessionEnabled(enabled: boolean): void {
    this.sessionEnabled = enabled;
    try {
      if (typeof window !== "undefined") {
        if (enabled) window.localStorage.removeItem(this.getSessionStateKey());
        else window.localStorage.setItem(this.getSessionStateKey(), "signed-out");
      }
    } catch {
      // Private/disabled storage still preserves the current document's intent.
    }
    if (!enabled) this.resetSession();
  }

  getSessionStateKey(): string {
    return `pp-session-state:${this.baseUrl.replace(/\/+$/, "")}`;
  }

  isSessionEnabled(): boolean {
    if (!this.sessionEnabled) return false;
    try {
      if (typeof window !== "undefined") return window.localStorage.getItem(this.getSessionStateKey()) !== "signed-out";
    } catch {
      // Fall back to the current document's state.
    }
    return this.sessionEnabled;
  }

  private applyToken(token: string | null): void {
    if (this.getTokenIdentity(this.authToken) !== this.getTokenIdentity(token)) this.invalidatePeekCache();
    this.authToken = token;
    this.accessTokenExp = 0;
    if (token) {
      // Extract expiry from access tokens (atk.<base64url_payload>.<sig>)
      const raw = token.startsWith("Bearer ") ? token.substring(7) : token;
      if (raw.startsWith("atk.")) {
        try {
          const payload = raw.split(".")[1];
          const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
          const claims = JSON.parse(json) as { exp?: number };
          if (claims.exp) this.accessTokenExp = claims.exp;
        } catch {
          /* ignore parse errors */
        }
      }
    }
  }

  // Used only to scope cached metadata, never to authenticate a token.
  private getTokenIdentity(token: string | null): string | null {
    const raw = token?.startsWith("Bearer ") ? token.substring(7) : token;
    if (raw?.startsWith("atk.")) {
      try {
        const payload = raw.split(".")[1];
        const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: unknown };
        if (typeof claims.sub === "string" && claims.sub) return `user:${claims.sub}`;
      } catch {
        // Unknown/legacy tokens keep the conservative per-token invalidation.
      }
    }
    return raw === null ? null : `token:${raw}`;
  }

  getAuthorizationHeader(): string {
    return this.authToken ?? "";
  }

  isAuthed(): boolean {
    return this.isSessionEnabled() && !!this.authToken;
  }

  setFixedHeader(name: string, value: string): void {
    if (name.toLowerCase() === "x-pp-expected-user" && this.fixedHeaders.get(name) !== value) {
      this.authGeneration++;
      this.invalidatePeekCache();
    }
    this.fixedHeaders.set(name, value);
  }

  setClientId(id: string): void {
    this.clientId = id;
  }

  /** True when the access token is expired or will expire within 2 minutes. */
  private isAccessTokenExpiringSoon(): boolean {
    if (!this.accessTokenExp) return false;
    return this.accessTokenExp - Math.floor(Date.now() / 1000) < 120;
  }

  /**
   * Renew the session using the refresh cookie (handled transparently by the
   * Electron proxy cookie jar, or by the browser in web mode).
   * Concurrent callers share a single in-flight request.
   */
  private async refreshSession(): Promise<boolean> {
    if (!this.isSessionEnabled()) return false;
    if (!this.clientId) return false;
    if (this.refreshPromise) return this.refreshPromise;

    console.debug("[CloudApi] refreshSession: starting token refresh", {
      clientId: this.clientId,
      baseUrl: this.baseUrl,
      hadAuthToken: !!this.authToken,
      accessTokenExp: this.accessTokenExp,
    });
    const generation = this.authGeneration;
    const request = (async () => {
      const savedAuth = this.authToken;
      try {
        // Override authentication for this request only. Other requests must
        // never observe a temporary logout or send another user's credentials.
        const response = await this.fetchSession(this.clientId, {
          skipRefresh: true,
          authToken: null,
          timeoutMs: 4_000,
        });
        if (generation !== this.authGeneration) throw new CloudApiError("aborted", "Session changed during refresh");

        const expectedUser = this.fixedHeaders.get("X-PP-Expected-User");
        if (expectedUser && response.login !== expectedUser) return false;

        if (response.token) {
          this.tokenRevision++;
          console.debug("[CloudApi] refreshSession: success, new token received", {
            login: response.login,
            hasLeaderId: !!response.leaderId,
          });
          // Preserve the transport's auth mode: browser/Android use cookies.
          if (savedAuth) this.applyToken(response.token);
          // Notify AuthContext to persist the new access token
          if (typeof window !== "undefined")
            window.dispatchEvent(
              new CustomEvent("pp-tokens-refreshed", {
                detail: { accessToken: response.token, login: response.login },
              })
            );
          return true;
        }
      } catch (e) {
        if (generation !== this.authGeneration) throw new CloudApiError("aborted", "Session changed during refresh");
        // A temporary outage must not be reported as an expired session.
        if (!isCloudApiErrorKind(e, "auth")) throw e;
        console.debug("[CloudApi] refreshSession: failed", {
          error: e instanceof Error ? e.message : e,
        });
      }
      return false;
    })();
    this.refreshPromise = request;

    try {
      return await request;
    } finally {
      if (this.refreshPromise === request) this.refreshPromise = null;
    }
  }

  setBaseUrl(url: string): void {
    if (url !== this.baseUrl) {
      this.authGeneration++;
      this.invalidatePeekCache();
    }
    this.baseUrl = url;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Abort all in-flight requests (used by praiseprojector.ts to cancel pending operations)
   */
  abortAll(): void {
    for (const controller of this.inFlightRequests) {
      try {
        controller.abort();
      } catch {
        // Ignore abort errors
      }
    }
    this.inFlightRequests.clear();
  }

  private applyCommonHeaders(headers: Record<string, string>): Record<string, string> {
    const mergedHeaders = { ...headers };
    for (const [name, value] of this.fixedHeaders) {
      mergedHeaders[name] = value;
    }
    if (this.isSessionEnabled() && this.authToken && !mergedHeaders["Authorization"] && !mergedHeaders["authorization"]) {
      if (this.authToken.startsWith("Basic ") || this.authToken.startsWith("Bearer ")) {
        mergedHeaders["Authorization"] = this.authToken;
      } else {
        mergedHeaders["Authorization"] = `Bearer ${this.authToken}`;
      }
    }
    return mergedHeaders;
  }

  private getHeaders(): Record<string, string> {
    return this.applyCommonHeaders({
      "Content-Type": "application/json",
      // Prevent browser from showing its default login dialog on 401
      "X-Requested-With": "XMLHttpRequest",
      "X-PP-Auth-Mode": "v2",
    });
  }

  private normalizeDecodedValue(value: unknown): unknown {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return value;
    }
  }

  private parseResponse<T, O>(codec: t.Type<T, O, unknown>, value: unknown): T {
    const normalized = this.normalizeDecodedValue(value);
    return decode(codec, normalized);
  }

  private emitCloudNetworkError(endpoint: string, message: string): void {
    if (typeof window === "undefined") {
      return;
    }
    window.dispatchEvent(
      new CustomEvent("pp-cloud-network-error", {
        detail: { endpoint, message },
      })
    );
  }

  private normalizeCloudApiError(error: unknown, endpoint: string): CloudApiError {
    if (error instanceof CloudApiError) {
      return error;
    }

    if (error instanceof Error) {
      if (error.name === "AbortError" || error.message.includes("aborted")) {
        return new CloudApiError("aborted", "aborted", { endpoint });
      }
      if (isLikelyNetworkErrorMessage(error.message)) {
        return new CloudApiError("network", error.message, { endpoint });
      }
      return new CloudApiError("http", error.message, { endpoint });
    }

    return new CloudApiError("http", "Unknown error", { endpoint });
  }

  private waitForRefresh(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.reject(new CloudApiError("aborted", "aborted"));
    // A caller may stop waiting without cancelling the shared refresh needed by
    // another request. The refresh has its own timeout and auth-generation guard.
    return new Promise((resolve, reject) => {
      const abort = () => reject(new CloudApiError("aborted", "aborted"));
      signal.addEventListener("abort", abort, { once: true });
      void this.refreshSession()
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private async apiCall<T>(endpoint: string, postData?: unknown, options?: CloudRequestOptions): Promise<T> {
    const sessionEnabled = this.isSessionEnabled();
    const useCookies = sessionEnabled || !!options?.allowSignedOutSession;
    const generation = this.authGeneration;
    const sessionChanged = () =>
      generation !== this.authGeneration || (!options?.allowSignedOutSession && sessionEnabled !== this.isSessionEnabled());
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const timeoutMs = options?.timeoutMs === undefined ? undefined : Math.max(1, options.timeoutMs);

    // Create an AbortController for this request if one isn't provided
    const controller = new AbortController();
    const combinedSignal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let timedOut = false;
    const timeoutHandle =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs);

    // Track this request for potential abort
    this.inFlightRequests.add(controller);

    try {
      if (combinedSignal.aborted) {
        throw new CloudApiError("aborted", "aborted", { endpoint });
      }

      // Proactively refresh the access token before it expires (the refresh
      // cookie is handled transparently by the proxy cookie jar / browser).
      if (sessionEnabled && !options?.skipRefresh && this.isAccessTokenExpiringSoon()) {
        console.debug("[CloudApi] apiCall: access token expiring soon, proactive refresh", {
          endpoint,
          accessTokenExp: this.accessTokenExp,
        });
        // Renewal before expiry is best-effort: the current token may still
        // authorize this request. A refresh after an actual 401 must still fail.
        await this.waitForRefresh(combinedSignal).catch((error) => {
          if (isCloudApiErrorKind(error, "aborted")) throw error;
        });
      }

      // Check if we're in Electron and should use the proxy
      let refreshAttempted = false;

      for (let attempt = 0; ; attempt++) {
        if (combinedSignal.aborted || sessionChanged()) {
          throw new CloudApiError("aborted", "Session changed or request aborted", { endpoint });
        }
        const requestRevision = this.tokenRevision;
        const headers = { ...this.getHeaders(), ...options?.headers };

        if (this.proxyApi) {
          // Use Electron IPC proxy to avoid CORS issues
          const requestId = `cloud-${Date.now()}-${++this.proxyRequestSequence}`;
          const proxyOptions: ProxyRequestOptions = {
            requestId,
            timeoutMs,
            clearCookiesAfterSnapshot: options?.clearCookiesAfterSnapshot,
            omitCookies: !useCookies,
          };
          const abortProxy = () => this.proxyApi?.proxyAbort?.(requestId);
          combinedSignal.addEventListener("abort", abortProxy, { once: true });
          let result;
          try {
            result =
              postData !== undefined
                ? await this.proxyApi.proxyPost(this.baseUrl, path, postData as string | Record<string, string>, headers, proxyOptions)
                : await this.proxyApi.proxyGet(this.baseUrl, path, headers, proxyOptions);
          } finally {
            combinedSignal.removeEventListener("abort", abortProxy);
          }

          if (combinedSignal.aborted || sessionChanged()) {
            throw timedOut
              ? new CloudApiError("network", `Request timed out after ${timeoutMs}ms`, { endpoint })
              : new CloudApiError("aborted", "aborted", { endpoint });
          }

          // Check for error response from proxy
          if (result && "error" in result) {
            const errorResult = result as { error: { message: string; status?: number } };
            const status = errorResult.error.status;
            const message = errorResult.error.message || "";
            if (status && isRetryableStatus(status) && attempt < MAX_RETRIES) {
              if (shouldSkipRetryBackoffForOffline503(status, message)) {
                throw new CloudApiError("network", getOfflineErrorMessage(message), { status, endpoint });
              }
              const delay = getRetryDelay(null, attempt);
              console.warn(`Server returned ${status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
              await sleep(delay, combinedSignal);
              continue;
            }
            if (errorResult.error.status === 401) {
              // Try refreshing the access token once before giving up
              if (sessionEnabled && !refreshAttempted && !options?.skipRefresh) {
                refreshAttempted = true;
                // Another request may already have renewed this rejected token.
                if (requestRevision !== this.tokenRevision) continue;
                console.debug("[CloudApi] apiCall: Electron proxy returned 401, attempting refresh", { endpoint });
                if (await this.waitForRefresh(combinedSignal)) {
                  console.debug("[CloudApi] apiCall: refresh after Electron 401 succeeded", { endpoint });
                  continue;
                }
                console.debug("[CloudApi] apiCall: refresh after Electron 401 failed", { endpoint });
              }
              if (combinedSignal.aborted || sessionChanged()) throw new CloudApiError("aborted", "Session changed or request aborted", { endpoint });
              if (!options?.skipRefresh) this.setToken(null);
              throw new CloudApiError("auth", "401", { status: 401, endpoint });
            }

            if (!errorResult.error.status || isLikelyNetworkErrorMessage(errorResult.error.message || "")) {
              throw new CloudApiError("network", errorResult.error.message || "Network error", { endpoint });
            }

            throw new CloudApiError("http", errorResult.error.message || "Unknown error", {
              status: errorResult.error.status,
              endpoint,
            });
          }

          // Proxy methods may return { data, ppHeaders }, unwrap payload for generic apiCall consumers.
          const resultData = result && "data" in result ? (result as { data: unknown }).data : null;
          if (options?.includePpHeaders) {
            return { data: resultData, ppHeaders: result && "ppHeaders" in result ? result.ppHeaders : {} } as T;
          }

          if (options?.allowEmpty && (resultData === "" || resultData == null)) {
            return null as T;
          }

          return resultData as T;
        } else {
          const url = `${this.baseUrl}${path}`;

          let response: Response;
          try {
            // The Android fetch shim consumes this extension; browsers ignore it.
            const init: RequestInit & { ppClearSessionCookies?: boolean } = {
              method: postData !== undefined ? "POST" : "GET",
              headers,
              body: postData !== undefined ? JSON.stringify(postData) : undefined,
              credentials: useCookies ? "include" : "omit",
              signal: combinedSignal,
              cache: options?.cache,
              ppClearSessionCookies: options?.clearCookiesAfterSnapshot,
            };
            response = await fetch(url, init);
          } catch (fetchError) {
            throw this.normalizeCloudApiError(fetchError, endpoint);
          }
          if (combinedSignal.aborted || sessionChanged()) {
            throw new CloudApiError("aborted", "Session changed or request aborted", { endpoint });
          }

          if (!response.ok) {
            let retryHint: string | undefined;
            if (response.status === 503) {
              try {
                retryHint = (await response.clone().text()).trim();
              } catch {
                retryHint = undefined;
              }
            }
            if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
              if (shouldSkipRetryBackoffForOffline503(response.status, retryHint)) {
                throw new CloudApiError("network", getOfflineErrorMessage(retryHint), { status: response.status, endpoint });
              }
              const delay = getRetryDelay(response.headers.get("Retry-After"), attempt);
              console.warn(`Server returned ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
              await sleep(delay, combinedSignal);
              continue;
            }
            if (response.status === 401) {
              // Try refreshing the access token once before giving up
              if (sessionEnabled && !refreshAttempted && !options?.skipRefresh) {
                refreshAttempted = true;
                if (requestRevision !== this.tokenRevision) continue;
                console.debug("[CloudApi] apiCall: fetch returned 401, attempting refresh", { endpoint });
                if (await this.waitForRefresh(combinedSignal)) {
                  console.debug("[CloudApi] apiCall: refresh after fetch 401 succeeded", { endpoint });
                  continue;
                }
                console.debug("[CloudApi] apiCall: refresh after fetch 401 failed", { endpoint });
              }
              if (combinedSignal.aborted || sessionChanged()) throw new CloudApiError("aborted", "Session changed or request aborted", { endpoint });
              if (!options?.skipRefresh) this.setToken(null);
              throw new CloudApiError("auth", "401", { status: 401, endpoint });
            }
            throw new CloudApiError("http", `HTTP ${response.status}`, { status: response.status, endpoint });
          }

          if (options?.allowEmpty) {
            const text = await response.text();
            if (!text.trim()) {
              return null as T;
            }
            return JSON.parse(text) as T;
          }

          const data = await (options?.responseType === "text" ? response.text() : response.json());
          if (combinedSignal.aborted || sessionChanged()) {
            throw new CloudApiError("aborted", "Session changed or request aborted", { endpoint });
          }
          return (options?.includePpHeaders ? { data, ppHeaders: extractPpHeadersFromFetch(response.headers) } : data) as T;
        }
      }
    } catch (error) {
      if (timedOut) {
        const timeoutError = new CloudApiError("network", `Request timed out after ${timeoutMs}ms`, { endpoint });
        this.emitCloudNetworkError(endpoint, timeoutError.message);
        throw timeoutError;
      }
      const normalizedError = this.normalizeCloudApiError(error, endpoint);
      if (normalizedError.kind === "network") {
        this.emitCloudNetworkError(endpoint, normalizedError.message);
      }
      throw normalizedError;
    } finally {
      // Clean up tracking
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      this.inFlightRequests.delete(controller);
    }
  }

  /**
   * Sync database with cloud
   */
  async syncDatabase(request: SyncRequest, options?: { signal?: AbortSignal }): Promise<SyncResponse> {
    console.info("Sync", `Starting sync with database version: ${request.version}`);
    console.info("Sync", `Uploading ${request.songs.length} songs and ${request.profiles.length} leaders`);
    const response = await this.apiCall<unknown>("/dbsync?version=2", request, options);
    return this.parseResponse(syncResponseCodec, response);
  }

  async fetchSongs(version: number, options?: { signal?: AbortSignal }) {
    const endpoint = version > 0 ? `/songs?version=${version}` : "/songs";
    const response = await this.apiCall<unknown>(endpoint, undefined, options);
    return this.parseResponse(songsResponseCodec, response);
  }

  async fetchLeaders(version: number, options?: { signal?: AbortSignal; fresh?: boolean }) {
    let endpoint = version > 0 ? `/leaders?version=${version}` : "/leaders";
    if (options?.fresh) {
      endpoint += `${endpoint.includes("?") ? "&" : "?"}_ppRefresh=${Date.now()}-${++this.proxyRequestSequence}`;
    }
    const response = await this.apiCall<unknown>(endpoint, undefined, {
      signal: options?.signal,
      cache: options?.fresh ? "no-store" : undefined,
    });
    return this.parseResponse(leadersResponseCodec, response);
  }

  async fetchSession(
    clientId: string,
    options?: { signal?: AbortSignal; skipRefresh?: boolean; timeoutMs?: number; authToken?: string | null }
  ): Promise<SessionResponse> {
    const token = options?.authToken;
    const explicitLogin = !!token?.startsWith("Basic ");
    if (!explicitLogin && !this.isSessionEnabled()) throw new CloudApiError("auth", "Session was signed out", { status: 401 });
    // /session needs a long-lived refresh credential, even when access is still
    // valid. Sending an access bearer suppresses Electron's cookie injection and
    // makes a remembered login fail renewal. Keep legacy bearers and Basic login.
    const useRefreshCookie = isAccessToken(token === undefined ? this.authToken : token);
    const authorization = !useRefreshCookie && token ? (/^(Basic|Bearer) /.test(token) ? token : `Bearer ${token}`) : "";
    const response = await this.apiCall<unknown>(
      "/session",
      { clientId },
      {
        ...options,
        skipRefresh: true,
        allowSignedOutSession: explicitLogin,
        headers: token === undefined && !useRefreshCookie ? undefined : { Authorization: authorization },
      }
    );
    const session = this.parseResponse(sessionResponseCodec, response);
    if (explicitLogin && session.token) this.setSessionEnabled(true);
    return session;
  }

  async logoutSession(
    clientId: string,
    options?: { signal?: AbortSignal; timeoutMs?: number; clearCookiesAfterSnapshot?: boolean }
  ): Promise<SessionResponse> {
    this.setSessionEnabled(false);
    const response = await this.apiCall<unknown>(
      "/session",
      { clientId, logout: true },
      {
        ...options,
        skipRefresh: true,
        allowSignedOutSession: true,
        headers: { Authorization: "" },
      }
    );
    return this.parseResponse(sessionResponseCodec, response);
  }

  /**
   * Fetch song history from cloud
   */
  async fetchSongHistory(songId: string): Promise<SongHistoryEntry[]> {
    const response = await this.apiCall<unknown>(`/history?songId=${songId}`);
    const entries = this.parseResponse(songHistoryResponseCodec, response);
    return entries;
  }

  /**
   * Fetch list of online sessions from cloud (matching C# view_session?list=only)
   * Returns array of sessions that can be watched/connected to
   */
  async fetchOnlineSessions(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<OnlineSessionEntry[]> {
    try {
      const response = await this.apiCall<unknown>("/view_session?list=only", undefined, options);
      const sessions = this.parseResponse(onlineSessionEntryListCodec, response) as OnlineSessionEntry[];
      return sessions || [];
    } catch (error) {
      console.error("API", "Failed to fetch online sessions", error);
      return [];
    }
  }

  /**
   * Fetch lightweight sync metadata.
   * Results are cached for `peekCacheTtlMs` (default 10 s) so that multiple
   * callers (UserPanel, legacy app, fetchPendingSongsCount …) in quick
   * succession share a single network round-trip.  In-flight deduplication
   * ensures only one request is outstanding at a time.
   */
  async fetchPeek(includeUpstream = false): Promise<PeekResponse> {
    const now = Date.now();
    if (this.peekCache && this.peekCache.includeUpstream === includeUpstream && now < this.peekCache.expiresAt) {
      return this.peekCache.result;
    }
    if (this.peekInFlight && this.peekInFlight.includeUpstream === includeUpstream) {
      return this.peekInFlight.request;
    }
    const generation = this.peekGeneration;
    const request = (async () => {
      try {
        const endpoint = includeUpstream ? "/peek?version=2" : "/peek";
        const response = await this.apiCall<unknown>(endpoint);
        const result = this.parseResponse(peekResponseCodec, response);
        if (generation === this.peekGeneration) {
          this.peekCache = {
            result,
            expiresAt: Date.now() + this.peekCacheTtlMs,
            includeUpstream,
          };
        }
        return result;
      } finally {
        if (generation === this.peekGeneration && this.peekInFlight?.includeUpstream === includeUpstream) this.peekInFlight = null;
      }
    })();
    this.peekInFlight = { request, includeUpstream };
    return request;
  }

  /**
   * Fetch list of pending songs awaiting review
   */
  async fetchPendingSongs(includeUpstream = false): Promise<SongDBPendingEntry[]> {
    const endpoint = includeUpstream ? "/pending_songs?version=2" : "/pending_songs";
    const response = await this.apiCall<unknown>(endpoint);
    return this.parseResponse(pendingSongsResponseCodec, response);
  }

  /**
   * Fetch count of pending songs awaiting review
   */
  async fetchPendingSongsCount(includeUpstream = false): Promise<number> {
    const peek = await this.fetchPeek(includeUpstream);
    return peek.pendingSongCount;
  }

  /**
   * Submit a pending song operation (approve/reject/keep/revoke)
   */
  async updatePendingSongState(songId: string, version: number, state: PendingSongOperation): Promise<string> {
    return this.apiCall<string>(`/psop?id=${encodeURIComponent(songId)}&version=${version}&state=${state}`);
  }

  async fetchDisplayQuery(
    display: Display,
    options?: {
      signal?: AbortSignal;
      leaderId?: string;
      sessionId?: string;
      forced?: boolean;
    }
  ): Promise<{ display: Display; ppHeaders: Record<string, string> }> {
    let command =
      "display_query?id=" +
      display.songId +
      "&from=" +
      display.from +
      "&to=" +
      display.to +
      "&transpose=" +
      display.transpose +
      "&capo=" +
      ((display.capo ?? -1) >= 0 ? display.capo : "") +
      "&playlist_id=" +
      encodeURIComponent(display.playlist_id || "");
    if (display.section != null) command += "&section=" + encodeURIComponent(display.section);
    if (display.sectionRepeatCounts?.length) command += "&sectionRepeatCounts=" + encodeURIComponent(JSON.stringify(display.sectionRepeatCounts));
    if (display.sectionRepeatNonce != null) command += "&sectionRepeatNonce=" + encodeURIComponent(display.sectionRepeatNonce.toString());
    if (display.instructions != null) command += "&instructions=" + encodeURIComponent(display.instructions);
    if (display.message != null) command += "&message=" + encodeURIComponent(display.message);
    if (display.chordProStylesRev != null) command += "&chordpro_styles_rev=" + encodeURIComponent(display.chordProStylesRev);
    if (options?.leaderId && options?.sessionId) throw new Error("A display query cannot target both a leader and a guest session");
    if (options?.sessionId) command += "&session=" + encodeURIComponent(options.sessionId);
    else if (options?.leaderId) {
      const key = isGuestDisplaySessionId(options.leaderId) ? "session" : "leader";
      command += `&${key}=` + encodeURIComponent(options.leaderId);
    }
    if (options?.forced) command += "&forced=true";

    const path = command.startsWith("/") ? command : `/${command}`;

    const response = await this.apiCall<{ data: unknown; ppHeaders: Record<string, string> }>(path, undefined, {
      signal: options?.signal,
      responseType: "text",
      includePpHeaders: true,
    });
    return { display: this.parseResponse(displayCodec, response.data), ppHeaders: response.ppHeaders };
  }

  async fetchDisplayStylesQuery(options?: {
    leaderId?: string;
    sessionId?: string;
    rev?: string;
    signal?: AbortSignal;
  }): Promise<DisplayStylesQueryResponse> {
    let endpoint = "/display_styles_query";
    const params: string[] = [];
    if (options?.leaderId && options?.sessionId) throw new Error("A display styles query cannot target both a leader and a guest session");
    if (options?.sessionId) params.push(`session=${encodeURIComponent(options.sessionId)}`);
    else if (options?.leaderId) {
      const key = isGuestDisplaySessionId(options.leaderId) ? "session" : "leader";
      params.push(`${key}=${encodeURIComponent(options.leaderId)}`);
    }
    if (options?.rev) params.push(`rev=${encodeURIComponent(options.rev)}`);
    if (params.length > 0) endpoint += `?${params.join("&")}`;
    const response = await this.apiCall<unknown>(endpoint, undefined, { signal: options?.signal });
    return this.parseResponse(displayStylesQueryResponseCodec, response);
  }

  async sendDisplayStylesUpdate(
    data: { chordProStyles: ChordProStylesSettings; chordProStylesRev?: string },
    target?: Partial<DisplaySessionTarget>
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      chordProStyles: data.chordProStyles,
    };
    if (data.chordProStylesRev) payload.chordProStylesRev = data.chordProStylesRev;
    return this.apiCall<string>(appendDisplayTarget("/display_styles_update", target), payload);
  }

  /**
   * Display update data type matching C# UpdateWebDisplay values
   */
  private lastDisplaySent = "";

  /**
   * Send display update to cloud server (matching C# UpdateWebDisplay)
   * The publishing target is kept out of the body and sent as a query parameter.
   */
  async sendDisplayUpdate(
    data: {
      songId: string;
      from: number;
      to: number;
      section?: number;
      sectionRepeatCounts?: Display["sectionRepeatCounts"];
      sectionRepeatNonce?: number;
      transpose?: number;
      playlist?: PlaylistEntry[];
      song: string;
      message?: string;
      instructions?: string;
    },
    options?: Partial<DisplaySessionTarget> & { force?: boolean }
  ): Promise<DisplayUpdateResult> {
    // Build values to send (matching C# values dictionary)
    const values: Record<string, string> = {
      ppu: "true",
      id: data.songId,
      from: data.from.toString(),
      to: data.to.toString(),
      song: data.song,
    };

    if (data.transpose !== undefined && data.transpose !== 0) {
      values.transpose = data.transpose.toString();
    }
    if (data.section !== undefined) {
      values.section = data.section.toString();
    }
    if (data.sectionRepeatCounts?.length) {
      values.sectionRepeatCounts = JSON.stringify(data.sectionRepeatCounts);
    }
    if (data.sectionRepeatNonce != null) {
      values.sectionRepeatNonce = data.sectionRepeatNonce.toString();
    }
    if (data.playlist) {
      values.playlist = data.playlist.map((entry) => JSON.stringify(entry)).join("\n");
    }
    if (data.message) {
      values.message = data.message;
    }
    if (data.instructions) {
      values.instructions = data.instructions;
    }

    // Compare with last sent to avoid duplicate uploads (matching C# CompareNameValueCollections)
    const endpoint = appendDisplayTarget("/display_update", options);
    const valuesJson = JSON.stringify({ endpoint, values });
    if (!options?.force && valuesJson === this.lastDisplaySent) {
      return "SKIPPED";
    }

    try {
      console.info("Sync", "Sending display update");

      const response = await this.apiCall<unknown>(endpoint, values, {
        responseType: "text",
        headers: { "X-PP-Intent": "control-update" },
      });
      const normalized = String(response).trim().toUpperCase() as DisplayUpdateResult;
      const result = DISPLAY_UPDATE_RESULTS.has(normalized) ? normalized : "ERROR";
      if (result === "DONE") {
        this.lastDisplaySent = valuesJson;
        console.info("Sync", "Display update sent successfully");
      } else {
        console.warn("Sync", `Display update returned ${result}`);
      }
      return result;
    } catch (error) {
      console.debug("Sync", "Display update failed", error instanceof Error ? error.message : error);
      throw error;
    }
  }

  /** Minimal preference update mirroring the legacy client's preferenceUpdate():
   *  POSTs /display_update with ONLY the song id plus the single changed
   *  transpose/capo value. Unlike {@link sendDisplayUpdate} this sends transpose
   *  even when it is 0 (so a value can be reset to zero) and can send capo at all
   *  (sendDisplayUpdate carries neither reliably). No dedup — a repeat of the same
   *  value is harmless and legacy preference updates were never deduped either. */
  async sendDisplayPreference(fields: { id: string; transpose?: number; capo?: number }, target?: Partial<DisplaySessionTarget>): Promise<string> {
    const values: Record<string, string | number> = { id: fields.id };
    if (fields.transpose !== undefined) values.transpose = fields.transpose.toString();
    if (fields.capo !== undefined) values.capo = fields.capo.toString();
    return this.sendPost(appendDisplayTarget("/display_update", target), values, { "X-PP-Intent": "control-update" });
  }

  // =========================================================================
  // Additional endpoints for client (praiseprojector.ts)
  // =========================================================================

  /** Fetch all songs with optional version/group filters */
  async fetchAllSongs(version?: number, groupId?: string): Promise<SongDBEntry[]> {
    let endpoint = "/songs";
    const params: string[] = [];
    if (groupId) params.push(`group=${encodeURIComponent(groupId)}`);
    if (version !== undefined) params.push(`version=${version}`);
    if (params.length > 0) endpoint += "?" + params.join("&");
    return this.apiCall<SongDBEntry[]>(endpoint);
  }

  /** Fetch songs by ID list with optional capo preference */
  async fetchSongsById(ids: string[], useCapo?: boolean): Promise<SongDBEntry[]> {
    const idParam = ids.map((id) => encodeURIComponent(id)).join(",");
    let endpoint = `/songs?id=${idParam}`;
    if (useCapo !== undefined) endpoint += `&useCapo=${useCapo}`;
    return this.apiCall<SongDBEntry[]>(endpoint);
  }

  /** Search for songs by text query */
  async searchSongs(text: string, limit?: number, songIds?: string[]): Promise<SongFound[]> {
    let endpoint = `/search?text=${encodeURIComponent(text)}`;
    if (limit !== undefined) endpoint += `&limit=${limit}`;
    if (songIds?.length) endpoint += `&songId=${songIds.map((id) => encodeURIComponent(id)).join(",")}`;
    return this.apiCall<SongFound[]>(endpoint);
  }

  /**
   * Fetch leader profiles with optional version filter.
   * Used by the client app; version is optional (omit for full list).
   */
  async fetchLeadersProfiles(version?: number, options?: { fresh?: boolean }): Promise<LeaderDBProfile[]> {
    return this.fetchLeaders(version ?? 0, { fresh: options?.fresh });
  }

  /** Send JSON POST request to arbitrary endpoint (legacy method name kept for compatibility). */
  async sendPost(
    endpoint: string,
    formFields: Record<string, string | number | boolean | SongPreferenceEntry[]>,
    extraHeaders?: Record<string, string>
  ): Promise<string> {
    const result = await this.apiCall<unknown>(endpoint, formFields, { headers: extraHeaders, responseType: "text" });
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  /** Send an immediate push to this client's FCM registration (test-mode servers only). */
  async sendFcmTestNotification(): Promise<FcmTestResult> {
    return this.apiCall<FcmTestResult>("/notification-test", { clientId: this.clientId });
  }

  /** Save a note/marking for a song */
  async updateNote(songId: string, text: string): Promise<void> {
    await this.apiCall<unknown>(`/note?id=${encodeURIComponent(songId)}&text=${encodeURIComponent(text)}`, undefined, { allowEmpty: true });
  }

  /** Check if the current user has permission to edit a song */
  async checkEditable(songId: string): Promise<boolean> {
    return this.apiCall<boolean>(`/editable?songId=${encodeURIComponent(songId)}`);
  }

  /** Fetch a song locked for editing (returns current version and song text) */
  async fetchEditSong(id: string): Promise<EditSongResponse> {
    const response = await this.apiCall<unknown>("/editsong", { id });
    return this.parseResponse(editSongResponseCodec, response);
  }

  /** Submit an edited song as a suggestion */
  async suggestSong(id: string, version: number, song: string): Promise<SuggestResponse> {
    return this.apiCall<SuggestResponse>("/suggest", { id, version, song });
  }

  /** Upload (store) a playlist to the server. Returns "OK", "OVERWRITE", or an error string */
  async storeList(forced: boolean, data: { label: string; scheduled: number; songs: SongPreferenceEntry[] }, leaderId?: string): Promise<string> {
    const leaderParam = leaderId ? `&leader=${encodeURIComponent(leaderId)}` : "";
    const result = await this.apiCall<string | null>(`/store_list?forced=${forced}${leaderParam}`, data, {
      allowEmpty: true,
      headers: { "X-PP-Intent": "control-update" },
    });
    return result ?? "";
  }

  /** Fetch device update data (e.g. initPage version/URL for Android) */
  async fetchDeviceData(data: string): Promise<DeviceDataResponse> {
    return this.apiCall<DeviceDataResponse>(`/device?data=${encodeURIComponent(data)}`);
  }

  /** Fetch image by ID. Returns the image identifier/data returned by the server */
  async fetchImage(id: string): Promise<NetDisplayData> {
    const result = await this.apiCall<unknown>(`/image?id=${encodeURIComponent(id)}`);
    return this.parseResponse(netDisplayDataCodec, result);
  }

  /** Request or verify highlight permission. Returns "GRANTED", "NOPE", or leader name */
  async fetchHighlightPermission(leader: string, deviceId: string, verifyOnly: boolean): Promise<string> {
    const mode = verifyOnly ? "verify" : "request";
    return this.apiCall<string>(`/highlight?permission=${mode}&leader=${encodeURIComponent(leader)}&deviceId=${encodeURIComponent(deviceId)}`);
  }

  /** Send highlight to server (lyrics line selection) */
  async sendHighlight(params: {
    line?: number;
    from?: number;
    to?: number;
    section?: number;
    leader: string;
    deviceId?: string;
    message?: string;
  }): Promise<void> {
    let endpoint = "/highlight?";
    if (params.line !== undefined) endpoint += `line=${params.line}&`;
    if (params.from !== undefined) endpoint += `from=${params.from}&`;
    if (params.to !== undefined) endpoint += `to=${params.to}&`;
    if (params.section !== undefined) endpoint += `section=${params.section}&`;
    endpoint += `leader=${encodeURIComponent(params.leader)}`;
    if (params.deviceId) endpoint += `&deviceId=${encodeURIComponent(params.deviceId)}`;
    if (params.message) endpoint += `&message=${encodeURIComponent(params.message)}`;
    await this.apiCall<unknown>(endpoint, undefined, { allowEmpty: true });
  }
}

export const cloudApi = new CloudApiService();
