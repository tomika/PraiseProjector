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
} from "./pp-codecs";
import type { NetDisplayData, SongHistoryEntry } from "./pp-types";
import type { ChordProStylesSettings } from "../chordpro/chordpro_styles";

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Electron IPC proxy interface for server calls
 */
interface IProxyAPI {
  proxyGet(
    baseUrl: string,
    path: string,
    headers?: Record<string, string>
  ): Promise<{ data: unknown; ppHeaders: Record<string, string> } | { error: { message: string; status?: number; data?: unknown } }>;
  proxyPost(
    baseUrl: string,
    path: string,
    data: unknown,
    headers?: Record<string, string>
  ): Promise<{ data: unknown; ppHeaders: Record<string, string> } | { error: { message: string; status?: number; data?: unknown } }>;
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
  // Base URL for API calls (set via setBaseUrl)
  private baseUrl: string = "";
  // Track in-flight requests for abort support
  private inFlightRequests = new Set<AbortController>();
  private fixedHeaders = new Map<string, string>();
  private proxyApi?: IProxyAPI;

  // Peek response cache — avoids duplicate network calls within the TTL window.
  // Default TTL (10 s) matches MIN_PEEK_INTERVAL_SECONDS in UserPanel.
  // Callers that want a guaranteed fresh result call invalidatePeekCache() first.
  static readonly DEFAULT_PEEK_CACHE_TTL_MS = 10_000;
  private peekCache: { result: PeekResponse; expiresAt: number } | null = null;
  private peekInFlight: Promise<PeekResponse> | null = null;
  private peekCacheTtlMs = CloudApiService.DEFAULT_PEEK_CACHE_TTL_MS;

  /** Override the peek cache TTL (milliseconds). Call with the user-configured
   *  peek interval so that all callers share the same deduplication window. */
  setPeekCacheTtl(ms: number): void {
    this.peekCacheTtlMs = Math.max(1_000, ms);
  }

  /** Force the next fetchPeek() to go to the network regardless of cache age. */
  invalidatePeekCache(): void {
    this.peekCache = null;
  }

  setProxy(proxyApi: IProxyAPI) {
    this.proxyApi = proxyApi;
  }

  setToken(token: string | null): void {
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

  getAuthorizationHeader(): string {
    return this.authToken ?? "";
  }

  isAuthed(): boolean {
    return !!this.authToken;
  }

  setFixedHeader(name: string, value: string): void {
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
    if (!this.clientId) return false;
    if (this.refreshPromise) return this.refreshPromise;

    console.debug("[CloudApi] refreshSession: starting token refresh", {
      clientId: this.clientId,
      baseUrl: this.baseUrl,
      hadAuthToken: !!this.authToken,
      accessTokenExp: this.accessTokenExp,
    });
    this.refreshPromise = (async () => {
      const savedAuth = this.authToken;
      const savedExp = this.accessTokenExp;
      try {
        // Clear the expired access token so the request relies on the refresh
        // cookie alone (server's v2 refresh flow at /session).
        this.authToken = null;
        this.accessTokenExp = 0;

        const response = await this.fetchSession(this.clientId, { skipRefresh: true });

        if (response.token) {
          console.debug("[CloudApi] refreshSession: success, new token received", {
            login: response.login,
            hasLeaderId: !!response.leaderId,
          });
          this.setToken(response.token);
          // Notify AuthContext to persist the new access token
          window.dispatchEvent(
            new CustomEvent("pp-tokens-refreshed", {
              detail: { accessToken: response.token },
            })
          );
          return true;
        }
      } catch (e) {
        // Refresh failed — restore previous token (caller will handle 401)
        console.debug("[CloudApi] refreshSession: failed", {
          error: e instanceof Error ? e.message : e,
          restoringPreviousToken: !!savedAuth,
        });
        this.authToken = savedAuth;
        this.accessTokenExp = savedExp;
      }
      return false;
    })();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  setBaseUrl(url: string): void {
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
    if (this.authToken && !mergedHeaders["Authorization"] && !mergedHeaders["authorization"]) {
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

  private async apiCall<T>(
    endpoint: string,
    postData?: unknown,
    options?: { signal?: AbortSignal; allowEmpty?: boolean; skipRefresh?: boolean }
  ): Promise<T> {
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

    // Create an AbortController for this request if one isn't provided
    const controller = new AbortController();
    const combinedSignal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;

    // Track this request for potential abort
    this.inFlightRequests.add(controller);

    try {
      if (combinedSignal.aborted) {
        throw new Error("aborted");
      }

      // Proactively refresh the access token before it expires (the refresh
      // cookie is handled transparently by the proxy cookie jar / browser).
      if (!options?.skipRefresh && this.isAccessTokenExpiringSoon()) {
        console.debug("[CloudApi] apiCall: access token expiring soon, proactive refresh", {
          endpoint,
          accessTokenExp: this.accessTokenExp,
        });
        await this.refreshSession();
      }

      // Check if we're in Electron and should use the proxy
      let refreshAttempted = false;

      for (let attempt = 0; ; attempt++) {
        const headers = this.getHeaders();

        if (this.proxyApi) {
          // Use Electron IPC proxy to avoid CORS issues
          const result =
            postData !== undefined
              ? await this.proxyApi.proxyPost(this.baseUrl, path, postData as string | Record<string, string>, headers)
              : await this.proxyApi.proxyGet(this.baseUrl, path, headers);

          if (combinedSignal.aborted) {
            throw new Error("aborted");
          }

          // Check for error response from proxy
          if (result && "error" in result) {
            const errorResult = result as { error: { message: string; status?: number } };
            if (errorResult.error.status && isRetryableStatus(errorResult.error.status) && attempt < MAX_RETRIES) {
              const delay = getRetryDelay(null, attempt);
              console.warn(`Server returned ${errorResult.error.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
              await sleep(delay);
              continue;
            }
            if (errorResult.error.status === 401) {
              // Clear token on 401 so auth state reflects the failed session.
              this.authToken = null;
              // Try refreshing the access token once before giving up
              if (!refreshAttempted && !options?.skipRefresh) {
                refreshAttempted = true;
                console.debug("[CloudApi] apiCall: Electron proxy returned 401, attempting refresh", { endpoint });
                if (await this.refreshSession()) {
                  console.debug("[CloudApi] apiCall: refresh after Electron 401 succeeded", { endpoint });
                  continue;
                }
                console.debug("[CloudApi] apiCall: refresh after Electron 401 failed", { endpoint });
              }
              throw new Error("401");
            }
            throw new Error(errorResult.error.message || "Unknown error");
          }

          // Proxy methods may return { data, ppHeaders }, unwrap payload for generic apiCall consumers.
          const resultData = result && "data" in result ? (result as { data: unknown }).data : null;

          if (options?.allowEmpty && (resultData === "" || resultData == null)) {
            return null as T;
          }

          return resultData as T;
        } else {
          const url = `${this.baseUrl}${path}`;

          const response =
            postData !== undefined
              ? await fetch(url, {
                  method: "POST",
                  headers,
                  body: JSON.stringify(postData),
                  // Allow HttpOnly session cookie auth in web mode.
                  credentials: "include",
                  signal: combinedSignal,
                })
              : await fetch(url, {
                  headers,
                  credentials: "include",
                  signal: combinedSignal,
                });

          if (!response.ok) {
            if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
              const delay = getRetryDelay(response.headers.get("Retry-After"), attempt);
              console.warn(`Server returned ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
              await sleep(delay);
              continue;
            }
            if (response.status === 401) {
              // Clear token on 401 so auth state reflects the failed session.
              this.authToken = null;
              // Try refreshing the access token once before giving up
              if (!refreshAttempted && !options?.skipRefresh) {
                refreshAttempted = true;
                console.debug("[CloudApi] apiCall: fetch returned 401, attempting refresh", { endpoint });
                if (await this.refreshSession()) {
                  console.debug("[CloudApi] apiCall: refresh after fetch 401 succeeded", { endpoint });
                  continue;
                }
                console.debug("[CloudApi] apiCall: refresh after fetch 401 failed", { endpoint });
              }
              throw new Error("401");
            }
            throw new Error(`HTTP ${response.status}`);
          }

          if (options?.allowEmpty) {
            const text = await response.text();
            if (!text.trim()) {
              return null as T;
            }
            return JSON.parse(text) as T;
          }

          return response.json() as T;
        }
      }
    } finally {
      // Clean up tracking
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

  async fetchLeaders(version: number, options?: { signal?: AbortSignal }) {
    const endpoint = version > 0 ? `/leaders?version=${version}` : "/leaders";
    const response = await this.apiCall<unknown>(endpoint, undefined, options);
    return this.parseResponse(leadersResponseCodec, response);
  }

  async fetchSession(clientId: string, options?: { signal?: AbortSignal; skipRefresh?: boolean }): Promise<SessionResponse> {
    const response = await this.apiCall<unknown>("/session", { clientId }, options);
    return this.parseResponse(sessionResponseCodec, response);
  }

  async logoutSession(clientId: string, options?: { signal?: AbortSignal }): Promise<SessionResponse> {
    const response = await this.apiCall<unknown>("/session", { clientId, logout: true }, options);
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
  async fetchOnlineSessions(): Promise<OnlineSessionEntry[]> {
    try {
      const response = await this.apiCall<unknown>("/view_session?list=only");
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
  async fetchPeek(): Promise<PeekResponse> {
    const now = Date.now();
    if (this.peekCache && now < this.peekCache.expiresAt) {
      return this.peekCache.result;
    }
    if (this.peekInFlight) {
      return this.peekInFlight;
    }
    const request = (async () => {
      try {
        const response = await this.apiCall<unknown>("/peek");
        const result = this.parseResponse(peekResponseCodec, response);
        this.peekCache = { result, expiresAt: Date.now() + this.peekCacheTtlMs };
        return result;
      } finally {
        this.peekInFlight = null;
      }
    })();
    this.peekInFlight = request;
    return request;
  }

  /**
   * Fetch list of pending songs awaiting review
   */
  async fetchPendingSongs(): Promise<SongDBPendingEntry[]> {
    return this.apiCall<SongDBPendingEntry[]>("/pending_songs");
  }

  /**
   * Fetch count of pending songs awaiting review
   */
  async fetchPendingSongsCount(): Promise<number> {
    const peek = await this.fetchPeek();
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
    if (display.instructions != null) command += "&instructions=" + encodeURIComponent(display.instructions);
    if (display.message != null) command += "&message=" + encodeURIComponent(display.message);
    if (display.chordProStylesRev != null) command += "&chordpro_styles_rev=" + encodeURIComponent(display.chordProStylesRev);
    if (options?.leaderId) command += "&leader=" + encodeURIComponent(options.leaderId);
    if (options?.forced) command += "&forced=true";

    const path = command.startsWith("/") ? command : `/${command}`;

    // Create an AbortController for this request and track it for abortAll()
    const controller = new AbortController();
    const combinedSignal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    this.inFlightRequests.add(controller);

    try {
      if (this.proxyApi) {
        const headers = this.getHeaders();
        const result = await this.proxyApi.proxyGet(this.baseUrl, path, headers);
        if (result && typeof result === "object" && "error" in result) {
          const errorResult = result as { error: { message?: string; status?: number } };
          const status = errorResult.error?.status;
          if (status === 401) this.authToken = null;
          throw new Error(status ? String(status) : errorResult.error?.message || "Unknown error");
        }
        const data = result && typeof result === "object" && "data" in result ? (result as { data: unknown }).data : result;
        return {
          display: this.parseResponse(displayCodec, data),
          ppHeaders:
            result && typeof result === "object" && "ppHeaders" in result ? ((result as { ppHeaders?: Record<string, string> }).ppHeaders ?? {}) : {},
        };
      }

      // Fallback path for web mode (and older preload implementations).
      const url = `${this.baseUrl}${path}`;
      const response = await fetch(url, {
        headers: this.getHeaders(),
        credentials: "include",
        signal: combinedSignal,
      });
      if (!response.ok) {
        if (response.status === 401) this.authToken = null;
        throw new Error(String(response.status));
      }
      const text = await response.text();
      return {
        display: this.parseResponse(displayCodec, text),
        ppHeaders: extractPpHeadersFromFetch(response.headers),
      };
    } finally {
      // Clean up tracking
      this.inFlightRequests.delete(controller);
    }
  }

  async fetchDisplayStylesQuery(options?: {
    leaderId?: string;
    rev?: string;
    signal?: AbortSignal;
  }): Promise<DisplayStylesQueryResponse> {
    let endpoint = "/display_styles_query";
    const params: string[] = [];
    if (options?.leaderId) params.push(`leader=${encodeURIComponent(options.leaderId)}`);
    if (options?.rev) params.push(`rev=${encodeURIComponent(options.rev)}`);
    if (params.length > 0) endpoint += `?${params.join("&")}`;
    const response = await this.apiCall<unknown>(endpoint, undefined, { signal: options?.signal });
    return this.parseResponse(displayStylesQueryResponseCodec, response);
  }

  async sendDisplayStylesUpdate(data: {
    chordProStyles: ChordProStylesSettings;
    chordProStylesRev?: string;
    leaderId?: string;
  }): Promise<string> {
    const payload: Record<string, unknown> = {
      chordProStyles: data.chordProStyles,
    };
    if (data.chordProStylesRev) payload.chordProStylesRev = data.chordProStylesRev;
    if (data.leaderId) payload.leader = data.leaderId;

    return this.apiCall<string>("/display_styles_update", payload);
  }

  /**
   * Display update data type matching C# UpdateWebDisplay values
   */
  private lastDisplaySent: Record<string, string> = {};

  /**
   * Send display update to cloud server (matching C# UpdateWebDisplay)
   * Returns true if update was sent, false if skipped (no change or disabled)
   */
  async sendDisplayUpdate(data: {
    songId: string;
    from: number;
    to: number;
    transpose?: number;
    leaderId?: string;
    playlist?: PlaylistEntry[];
    song: string;
    message?: string;
    instructions?: string;
  }): Promise<boolean> {
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
    if (data.leaderId) {
      values.leader = data.leaderId;
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
    const valuesJson = JSON.stringify(values);
    if (valuesJson === JSON.stringify(this.lastDisplaySent)) {
      return false; // No change, skip upload
    }

    try {
      console.info("Sync", "Sending display update");

      // Build headers with form encoding
      const headers = this.applyCommonHeaders({
        "Content-Type": "application/json",
        "X-PP-Intent": "control-update",
      });

      // Check if we're in Electron and should use the proxy
      if (this.proxyApi) {
        const result = await this.proxyApi.proxyPost(this.baseUrl, "/display_update", JSON.stringify(values), headers);

        // Check for error response from proxy
        if (result && "error" in result) {
          const errorResult = result as { error: { message: string; status?: number } };
          console.warn("Sync", `Display update failed: ${errorResult.error.message}`);
          return false;
        }

        this.lastDisplaySent = values;
        console.info("Sync", "Display update sent successfully");
        return true;
      } else {
        // Web mode: use direct fetch with Vite proxy
        const url = `${this.baseUrl}/display_update`;
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(values),
          credentials: "include",
        });

        if (response.ok) {
          this.lastDisplaySent = values;
          console.info("Sync", "Display update sent successfully");
          return true;
        } else {
          console.warn("Sync", `Display update failed: ${response.status} ${response.statusText}`);
          return false;
        }
      }
    } catch (error) {
      // Network errors are expected if cloud server is not configured or unreachable
      // Use debug level to avoid alarming users
      console.debug("Sync", "Display update skipped (server not reachable)", error instanceof Error ? error.message : error);
      return false;
    }
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
  async searchSongs(text: string, limit?: number): Promise<SongFound[]> {
    let endpoint = `/search?text=${encodeURIComponent(text)}`;
    if (limit !== undefined) endpoint += `&limit=${limit}`;
    return this.apiCall<SongFound[]>(endpoint);
  }

  /**
   * Fetch leader profiles with optional version filter.
   * Used by the client app; version is optional (omit for full list).
   */
  async fetchLeadersProfiles(version?: number): Promise<LeaderDBProfile[]> {
    const endpoint = version ? `/leaders?version=${version}` : "/leaders";
    const response = await this.apiCall<unknown>(endpoint);
    return this.parseResponse(leadersResponseCodec, response);
  }

  /** Send JSON POST request to arbitrary endpoint (legacy method name kept for compatibility). */
  async sendPost(
    endpoint: string,
    formFields: Record<string, string | number | boolean | SongPreferenceEntry[]>,
    extraHeaders?: Record<string, string>
  ): Promise<string> {
    const headers = this.applyCommonHeaders({
      "Content-Type": "application/json",
      ...extraHeaders,
    });

    const payload = JSON.stringify(formFields);

    // Check if we're in Electron and should use the proxy
    if (this.proxyApi) {
      // Use Electron IPC proxy
      const result = await this.proxyApi.proxyPost(this.baseUrl, endpoint, payload, headers);
      if (result && "error" in result) {
        const errorResult = result as { error: { message: string; status?: number } };
        throw new Error(errorResult.error.message);
      }
      const responseData = result && "data" in result ? (result as { data: unknown }).data : result;
      return typeof responseData === "string" ? responseData : JSON.stringify(responseData);
    } else {
      // Web mode: use fetch
      const url = `${this.baseUrl}${endpoint}`;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.text();
    }
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
  async storeList(forced: boolean, data: { label: string; scheduled: number; songs: SongPreferenceEntry[] }): Promise<string> {
    const result = await this.apiCall<string | null>(`/store_list?forced=${forced}`, data, { allowEmpty: true });
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
