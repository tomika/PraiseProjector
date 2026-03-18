import * as t from "io-ts";
import { Song } from "../classes/Song";
import { decode } from "../../common/io-utils";
import {
  Display,
  OnlineSessionEntry,
  PlaylistEntry,
  PendingSongOperation,
  SessionResponse,
  SongDBPendingEntry,
  SyncRequest,
  SyncResponse,
} from "../../common/pp-types";
import {
  displayCodec,
  errorResponseCodec,
  leadersResponseCodec,
  onlineSessionEntryListCodec,
  sessionResponseCodec,
  songHistoryResponseCodec,
  songsResponseCodec,
  syncResponseCodec,
} from "../../common/pp-codecs";

/**
 * Cloud API service for external API calls to praiseprojector.hu
 * Uses Electron proxy in Electron mode, Vite proxy in web dev mode
 */
import { cloudApiBaseUrl } from "../config";
import { isRight } from "fp-ts/lib/Either";

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

class CloudApiService {
  private authToken: string | null = null;
  private accessTokenExp: number = 0; // unix seconds
  private clientId: string = "";
  private refreshPromise: Promise<boolean> | null = null;
  // Default to configured cloudApiHost (single source of truth)
  private baseUrl: string = cloudApiBaseUrl;

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

    console.debug("[CloudApi] refreshSession: starting token refresh (clientId present, cookie-only)");
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
          console.debug("[CloudApi] refreshSession: success, new token received");
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
        console.debug("[CloudApi] refreshSession: failed", e instanceof Error ? e.message : e);
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

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Prevent browser from showing its default login dialog on 401
      "X-Requested-With": "XMLHttpRequest",
      "X-PP-Auth-Mode": "v2",
    };
    if (this.authToken) {
      // Token already contains auth type prefix (Bearer or Basic)
      if (this.authToken.startsWith("Basic ") || this.authToken.startsWith("Bearer ")) {
        headers["Authorization"] = this.authToken;
      } else {
        // Assume it's a bearer token if no prefix
        headers["Authorization"] = `Bearer ${this.authToken}`;
      }
    }
    return headers;
  }

  private parseResponse<T, O>(codec: t.Type<T, O, unknown>, value: unknown): T {
    try {
      return decode(codec, value);
    } catch (error) {
      const validation = errorResponseCodec.decode(value);
      if (isRight(validation)) throw new Error(`API error: ${validation.right.error}`);
      throw error;
    }
  }

  private async apiCall<T>(
    endpoint: string,
    postData?: unknown,
    options?: { signal?: AbortSignal; allowEmpty?: boolean; skipRefresh?: boolean }
  ): Promise<T> {
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

    if (options?.signal?.aborted) {
      throw new Error("aborted");
    }

    // Proactively refresh the access token before it expires (the refresh
    // cookie is handled transparently by the proxy cookie jar / browser).
    if (!options?.skipRefresh && this.isAccessTokenExpiringSoon()) {
      console.debug("[CloudApi] apiCall: access token expiring soon, proactive refresh for", endpoint);
      await this.refreshSession();
    }

    // Check if we're in Electron and should use the proxy
    const isElectron = typeof window !== "undefined" && !!window.electronAPI;
    let refreshAttempted = false;

    for (let attempt = 0; ; attempt++) {
      const headers = this.getHeaders();

      if (isElectron && window.electronAPI?.proxyPost && window.electronAPI?.proxyGet) {
        // Use Electron IPC proxy to avoid CORS issues
        let result: unknown;
        if (postData !== undefined) {
          result = await window.electronAPI.proxyPost(this.baseUrl, path, postData, headers);
        } else {
          result = await window.electronAPI.proxyGet(this.baseUrl, path, headers);
        }

        if (options?.signal?.aborted) {
          throw new Error("aborted");
        }

        // Check for error response from proxy
        if (result && typeof result === "object" && "error" in result) {
          const errorResult = result as { error: { message: string; status?: number } };
          if (errorResult.error.status && isRetryableStatus(errorResult.error.status) && attempt < MAX_RETRIES) {
            const delay = getRetryDelay(null, attempt);
            console.warn(`Server returned ${errorResult.error.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
            await sleep(delay);
            continue;
          }
          if (errorResult.error.status === 401) {
            // Try refreshing the access token once before giving up
            if (!refreshAttempted && !options?.skipRefresh) {
              refreshAttempted = true;
              if (await this.refreshSession()) continue;
            }
            throw new Error("401");
          }
          throw new Error(errorResult.error.message || "Unknown error");
        }

        if (options?.allowEmpty && (result === "" || result == null)) {
          return null as T;
        }

        return result as T;
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
                signal: options?.signal,
              })
            : await fetch(url, {
                headers,
                credentials: "include",
                signal: options?.signal,
              });

        if (!response.ok) {
          if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
            const delay = getRetryDelay(response.headers.get("Retry-After"), attempt);
            console.warn(`Server returned ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
            await sleep(delay);
            continue;
          }
          if (response.status === 401) {
            // Try refreshing the access token once before giving up
            if (!refreshAttempted && !options?.skipRefresh) {
              refreshAttempted = true;
              if (await this.refreshSession()) continue;
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
  async fetchSongHistory(songId: string): Promise<Song[]> {
    const response = await this.apiCall<unknown>(`/history?songId=${songId}`);
    const entries = this.parseResponse(songHistoryResponseCodec, response);

    const songs: Song[] = [];
    for (const entry of entries) {
      let change = entry.uploader + "@";
      try {
        change += new Date(entry.created).toLocaleString();
      } catch {
        change += entry.created;
      }
      const song = new Song(entry.songdata.text, entry.songdata.system, change);
      songs.push(song);
    }
    return songs;
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
   * Fetch list of pending songs awaiting review
   */
  async fetchPendingSongs(): Promise<SongDBPendingEntry[]> {
    return this.apiCall<SongDBPendingEntry[]>("/pending_songs");
  }

  /**
   * Fetch count of pending songs awaiting review
   */
  async fetchPendingSongsCount(): Promise<number> {
    return this.apiCall<number>("/pending_songs?c=1");
  }

  /**
   * Submit a pending song operation (approve/reject/keep/revoke)
   */
  async updatePendingSongState(songId: string, version: number, state: PendingSongOperation): Promise<string> {
    return this.apiCall<string>(`/psop?id=${encodeURIComponent(songId)}&version=${version}&state=${state}`);
  }

  async fetchDisplayQuery(command: string, options?: { signal?: AbortSignal }): Promise<Display | null> {
    const path = command.startsWith("/") ? command : `/${command}`;
    const response = await this.apiCall<unknown>(path, undefined, { ...options, allowEmpty: true });
    if (response == null || response === "") {
      return null;
    }
    return this.parseResponse(displayCodec, response);
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
      const headers: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-PP-Intent": "control-update",
      };

      // Add authorization header
      if (this.authToken) {
        if (this.authToken.startsWith("Basic ") || this.authToken.startsWith("Bearer ")) {
          headers["Authorization"] = this.authToken;
        } else {
          headers["Authorization"] = `Bearer ${this.authToken}`;
        }
      }

      // Check if we're in Electron and should use the proxy
      const isElectron = typeof window !== "undefined" && !!window.electronAPI;

      if (isElectron && window.electronAPI?.proxyPost) {
        // Use Electron IPC proxy - send form data as URLSearchParams string
        const formData = new URLSearchParams();
        for (const [key, value] of Object.entries(values)) {
          formData.append(key, value);
        }
        const result = await window.electronAPI.proxyPost(this.baseUrl, "/display_update", formData.toString(), headers);

        // Check for error response from proxy
        if (result && typeof result === "object" && "error" in result) {
          const errorResult = result as { error: { message: string; status?: number } };
          console.warn("Sync", `Display update failed: ${errorResult.error.message}`);
          return false;
        }

        this.lastDisplaySent = values;
        console.info("Sync", "Display update sent successfully");
        return true;
      } else {
        // Web mode: use direct fetch with Vite proxy
        const formData = new URLSearchParams();
        for (const [key, value] of Object.entries(values)) {
          formData.append(key, value);
        }

        const url = `${this.baseUrl}/display_update`;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            ...headers,
          },
          body: formData,
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
}

export const cloudApi = new CloudApiService();
