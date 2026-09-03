import React, { useState, useRef, useContext, useEffect, ReactNode, useCallback } from "react";
import { SessionResponse } from "../../common/pp-types";
import { cloudApi, isCloudApiErrorKind } from "../../common/cloudApi";
import { cloudApiBaseUrl } from "../config";
import { Database } from "../../db-common/Database";

type AuthStatus = "guest" | "authenticated" | "offline";

interface AuthContextType {
  authStatus: AuthStatus;
  networkUnavailable: boolean;
  recheckNetworkAvailability: () => Promise<boolean>;
  restoreStoredSession: () => Promise<boolean>;
  isAuthenticated: boolean;
  isGuest: boolean;
  username: string | null;
  user: SessionResponse | null;
  token: string | null;
  isLoading: boolean;
  login: (username: string, password?: string) => Promise<boolean>;
  logout: () => Promise<void>;
  changeUser: () => Promise<string | null>;
  loadInitialCredentials: () => Promise<void>;
  updateToken: (newToken: string) => void;
  markSessionExpired: () => void;
  /** Persist the current session token to localStorage (called after "Remember Me" confirmation). */
  commitSession: () => void;
  onLoginSuccess?: (leaderId?: string) => void;
  setOnLoginSuccess: (callback: (leaderId?: string) => void) => void;
}

// Use a module-level variable to preserve context across HMR reloads
// This prevents "useAuth must be used within an AuthProvider" errors during development
const AuthContext = React.createContext<AuthContextType | undefined>(undefined);
AuthContext.displayName = "AuthContext";

const shouldUseBearerHeader = typeof window !== "undefined" && !!window.electronAPI;
const AUTH_REQUEST_TIMEOUT_MS = 4_000;

// Guard against React StrictMode double-mount calling loadInitialCredentials
// concurrently, which causes two session requests racing each other (the server
// may rotate/invalidate the token on the first request, making the second 401).
let credentialLoadInFlight = false;

async function getDeviceClientId(): Promise<string> {
  const key = "pp-client-id";
  let id = localStorage.getItem(key);
  if (!id) {
    const randomPart = Math.random().toString(36).slice(2);
    const hostname = (await window.electronAPI?.getHostname?.().catch(() => undefined)) ?? navigator.userAgent.slice(0, 20);
    id = hostname + ":" + randomPart;
    localStorage.setItem(key, id);
  }
  await window.hostDevice?.storePreference?.("clientId", id);
  return id;
}

async function configureNativeNotifications(sessionToken: string, acquirePermission: boolean): Promise<void> {
  const hostDevice = window.hostDevice;
  if (!hostDevice?.enableNotification) return;
  const preference = hostDevice.retrievePreference ? await Promise.resolve(hostDevice.retrievePreference("notifsEnabled")) : "";
  if (preference === "false") return;
  await Promise.resolve(hostDevice.enableNotification(sessionToken, "PraiseProjector", "PraiseProjector Notifications", 60, acquirePermission));
}

async function disableNativeNotificationRegistration(): Promise<void> {
  const hostDevice = window.hostDevice;
  if (!hostDevice) return;
  if (hostDevice.disableNotification) {
    await Promise.resolve(hostDevice.disableNotification());
  } else if (hostDevice.enableNotification) {
    // Compatibility with older Android hosts where an empty token was the
    // notification-unregister operation.
    await Promise.resolve(hostDevice.enableNotification("", "PraiseProjector", "PraiseProjector Notifications", 60, false));
  }
  await Promise.resolve(hostDevice.cancelAllNotifications?.());
}

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<SessionResponse | null>(null);
  const [token, _setToken] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const setToken = (t: string | null) => {
    tokenRef.current = t;
    _setToken(t);
  };
  const [username, setUsername] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>("guest");
  const [networkUnavailable, setNetworkUnavailable] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isVerificationPending, setIsVerificationPending] = useState(false);
  const [onLoginSuccess, setOnLoginSuccessCallback] = useState<((leaderId?: string) => void) | undefined>();
  const guestCookieCleanupRetriedRef = useRef(false);
  // Monotonic auth-intent counter. Every login/logout bumps it so a backgrounded
  // logout can tell whether it still represents the current intent before it wipes
  // cookies. Guards against a stale logout clearing a newer session's cookie jar.
  const authEpochRef = useRef(0);
  const authRequestControllerRef = useRef<AbortController | null>(null);

  const setOnLoginSuccess = useCallback((callback: (leaderId?: string) => void) => {
    setOnLoginSuccessCallback(() => callback);
  }, []);

  /** Persist tokens from a successful session response.
   *  When `persist` is true (default), the access token is written to
   *  localStorage so it can survive page reloads / short app restarts.
   *  Set `persist=false` for fresh logins until the user decides on "Remember Me". */
  const applySession = useCallback((session: SessionResponse, persist = true, acquireNotifications = false) => {
    setUser(session);
    setToken(session.token);
    setNetworkUnavailable(false);
    cloudApi.setToken(shouldUseBearerHeader ? session.token : null);
    cloudApi.setFixedHeader("X-PP-Expected-User", session.login);
    setAuthStatus("authenticated");
    localStorage.removeItem("auth_token");
    if (persist) {
      localStorage.setItem("pp_session_token", session.token);
    } else {
      // Remove stale token from a previous user so it doesn't get sent on restart.
      localStorage.removeItem("pp_session_token");
    }
    if (session.token)
      void configureNativeNotifications(session.token, acquireNotifications).catch((error) =>
        console.error("Notifications", "Failed to configure native notifications", error)
      );
  }, []);

  const verifySession = async (
    username: string,
    authToken?: string | null,
    options?: { signal?: AbortSignal; epoch?: number }
  ): Promise<SessionResponse | null> => {
    try {
      const authType = authToken ? (authToken.startsWith("Bearer ") ? "Bearer" : authToken.startsWith("Basic ") ? "Basic" : "raw") : "cookie-only";
      console.debug("[Auth] verifySession:", { username, authType });
      cloudApi.setToken(authToken ?? null);
      const clientId = await getDeviceClientId();
      const response = await cloudApi.fetchSession(clientId, {
        skipRefresh: true,
        signal: options?.signal,
        timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
      });
      if (options?.epoch !== undefined && authEpochRef.current !== options.epoch) return null;
      if (response.login === username) {
        console.debug("[Auth] verifySession: success for", username);
        return response;
      }
      // Login mismatch: the server resolved a different user (typically from
      // shared HttpOnly cookies set by a browser session on the same origin).
      // Clear the stale cookies so they don't silently authenticate future
      // requests.  The server is known to be reachable (fetchSession succeeded),
      // so the logout call should reliably clear the HttpOnly cookies via
      // Set-Cookie: …; Max-Age=0 in the response.
      console.debug("[Auth] verifySession: login mismatch, expected", username, "got", response.login, "— clearing stale session");
      if (response.login) {
        cloudApi.setToken(null);
        try {
          await cloudApi.logoutSession(clientId, {
            signal: options?.signal,
            timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
            clearCookiesAfterSnapshot: true,
          });
        } catch {
          // Ignore errors (e.g. network issues) since we're clearing local state anyway
        }
        if (options?.epoch === undefined || authEpochRef.current === options.epoch) {
          await window.electronAPI?.clearPersistedCookies?.();
        }
      }
      return null;
    } catch (error) {
      if (isCloudApiErrorKind(error, "network")) {
        console.debug("[Auth] verifySession: network unavailable");
        throw error;
      }
      console.debug("[Auth] verifySession: failed", error instanceof Error ? error.message : error);
      return null;
    }
  };

  const loadInitialCredentials = useCallback(async () => {
    // Prevent concurrent execution (React StrictMode double-mount). The server
    // may rotate the session token on first use, so a second parallel request
    // with the same token would get 401.
    if (credentialLoadInFlight) return;
    credentialLoadInFlight = true;
    const myEpoch = authEpochRef.current;
    authRequestControllerRef.current?.abort();
    const controller = new AbortController();
    authRequestControllerRef.current = controller;

    setIsLoading(true);
    setIsVerificationPending(true);
    try {
      // In Electron, resolve the cloud API base URL from the main process (proxy-config.json)
      // before any API calls. Without this, the renderer falls back to window.location.origin
      // which is file:// in production builds, causing proxy validation to fail.
      if (window.electronAPI?.getCloudApiHost) {
        const host = await window.electronAPI.getCloudApiHost();
        if (host) {
          cloudApi.setBaseUrl(host);
        }
      } else {
        // Web mode: use the build-time / runtime resolved base URL
        cloudApi.setBaseUrl(cloudApiBaseUrl);
      }

      // Set clientId early so cloudApi can use it for automatic token refresh.
      const clientId = await getDeviceClientId();
      cloudApi.setClientId(clientId);

      const storedUsername = localStorage.getItem("auth_username")?.trim() || "";
      const storedLegacyToken = localStorage.getItem("auth_token")?.trim() || "";
      const storedSessionToken = localStorage.getItem("pp_session_token")?.trim() || "";
      console.debug("[Auth] loadInitialCredentials:", {
        hasUsername: !!storedUsername,
        hasSessionToken: !!storedSessionToken,
        hasLegacyToken: !!storedLegacyToken,
        isElectron: !!window.electronAPI,
      });

      if (storedUsername) {
        setUsername(storedUsername);
        await Database.switchUser(storedUsername);
        // The user's local database is now ready. Unblock the UI immediately so
        // offline startup (state restore + playlist song switching) is never
        // gated on the network session verification below, which hangs until the
        // TCP timeout when offline. Verification still runs and is awaited (so
        // restoreStoredSession() reflects its outcome), but only updates auth
        // state — it no longer holds up local rendering.
        setIsLoading(false);
      } else {
        setUsername(null);
        setUser(null);
        setToken(null);
        setNetworkUnavailable(false);
        cloudApi.setToken(null);
        cloudApi.setFixedHeader("X-PP-Expected-User", "");

        // Switch to the guest (anonymous) database and unblock the UI BEFORE the
        // network cookie-mismatch check below, so offline guest startup is never
        // gated on a cloud round-trip. The DB switch is local; the gated effects
        // (App state restore / playlist song load) safely proceed once it is done
        // — they re-resolve the ready database via Database.waitForReady().
        setAuthStatus("guest");
        if (Database.getCurrentUsername() !== "") {
          await Database.switchUser("");
        }
        setIsLoading(false);

        // PWAs and multiple browser tabs share HttpOnly cookies with the main
        // browser session on the same origin, while localStorage is separate.
        // If the browser is logged in but this instance has no stored username,
        // the shared cookies would silently authenticate every fetch request as
        // the browser's user while the UI shows "Guest".  verifySession with an
        // empty expected login detects the mismatch and clears the stale cookies.
        // Awaited so restoreStoredSession() reflects the outcome, but the UI is
        // already usable via the setIsLoading(false) above.
        try {
          await verifySession("", null, { signal: controller.signal, epoch: myEpoch });
        } catch (error) {
          if (!isCloudApiErrorKind(error, "network")) {
            throw error;
          }
          console.debug("[Auth] loadInitialCredentials: guest session verification skipped while offline");
        }

        return;
      }

      let session: SessionResponse | null = null;
      let networkUnavailable = false;

      // Try restoring the session using the stored access token (Bearer).
      if (storedSessionToken) {
        console.debug("[Auth] loadInitialCredentials: trying Bearer token");
        try {
          session = await verifySession(storedUsername, `Bearer ${storedSessionToken}`, {
            signal: controller.signal,
            epoch: myEpoch,
          });
        } catch (error) {
          if (isCloudApiErrorKind(error, "network")) {
            networkUnavailable = true;
          } else {
            throw error;
          }
        }
      }

      // If Bearer token failed or was missing, try cookie-only session renewal.
      // In browser mode the browser sends the HttpOnly pp_refresh cookie; in
      // Electron mode the proxy cookie jar does the same.
      if (!session && !networkUnavailable) {
        console.debug("[Auth] loadInitialCredentials: trying cookie-only renewal");
        try {
          session = await verifySession(storedUsername, null, { signal: controller.signal, epoch: myEpoch });
        } catch (error) {
          if (isCloudApiErrorKind(error, "network")) {
            networkUnavailable = true;
          } else {
            throw error;
          }
        }
      }

      // Backward-compatible fallback for older deployments that stored token in localStorage.
      if (!session && !networkUnavailable && storedLegacyToken) {
        console.debug("[Auth] loadInitialCredentials: trying legacy token");
        try {
          session = await verifySession(storedUsername, storedLegacyToken, {
            signal: controller.signal,
            epoch: myEpoch,
          });
        } catch (error) {
          if (isCloudApiErrorKind(error, "network")) {
            networkUnavailable = true;
          } else {
            throw error;
          }
        }
      }

      if (authEpochRef.current !== myEpoch) return;

      if (session) {
        console.debug("[Auth] loadInitialCredentials: session restored for", storedUsername);
        applySession(session);
        return;
      }

      if (networkUnavailable) {
        console.debug("[Auth] loadInitialCredentials: network unavailable, preserving stored session data");
        setUser(null);
        setToken(null);
        setNetworkUnavailable(true);
        cloudApi.setToken(null);
        setAuthStatus("offline");
        return;
      }

      console.debug("[Auth] loadInitialCredentials: all methods failed, setting offline");
      localStorage.removeItem("auth_token");
      localStorage.removeItem("pp_session_token");
      await window.electronAPI?.clearPersistedCookies?.();
      if (authEpochRef.current !== myEpoch) return;
      setUser(null);
      setToken(null);
      setNetworkUnavailable(false);
      cloudApi.setToken(null);
      setAuthStatus("offline");
    } catch (error) {
      if (!isCloudApiErrorKind(error, "aborted")) {
        console.error("Auth", "Failed to load initial credentials", error);
      }
    } finally {
      credentialLoadInFlight = false;
      if (authRequestControllerRef.current === controller) {
        authRequestControllerRef.current = null;
      }
      setIsVerificationPending(false);
      if (authEpochRef.current === myEpoch) setIsLoading(false);
    }
  }, [applySession]);

  const login = async (username: string, password?: string): Promise<boolean> => {
    // Invalidate any in-flight logout so its backgrounded cookie-clear cannot wipe
    // the session cookie this login is about to establish.
    const myEpoch = ++authEpochRef.current;
    authRequestControllerRef.current?.abort();
    const controller = new AbortController();
    authRequestControllerRef.current = controller;
    setIsLoading(true);
    try {
      const authToken = password ? `Basic ${btoa(`${username}:${password}`)}` : null;
      if (!authToken) {
        return false;
      }
      const clientId = await getDeviceClientId();
      cloudApi.setClientId(clientId);
      // Explicit user switch/login: clear fixed expected-user header so the
      // session request is not constrained by the previous authenticated user.
      cloudApi.setFixedHeader("X-PP-Expected-User", "");
      // Clear active HttpOnly cookie auth before switching users so the new
      // login cannot be shadowed by stale cookies from a previous account.
      try {
        cloudApi.setToken(null);
        await cloudApi.logoutSession(clientId, {
          signal: controller.signal,
          timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
          clearCookiesAfterSnapshot: true,
        });
      } catch {
        // Ignore pre-login logout errors and continue with explicit credentials.
      }
      if (authEpochRef.current !== myEpoch) return false;
      const session = await verifySession(username, authToken, { signal: controller.signal, epoch: myEpoch });
      if (authEpochRef.current !== myEpoch) return false;
      if (session && session.token) {
        // Don't persist session token yet — wait for "Remember Me" decision.
        // In non-Electron mode, always persist (browser cookies handle refresh).
        const isElectron = typeof window !== "undefined" && !!window.electronAPI;
        applySession(session, !isElectron, true);
        setUsername(username);
        localStorage.setItem("auth_username", username);

        await Database.switchUser(username);
        if (authEpochRef.current !== myEpoch) return false;

        if (onLoginSuccess) {
          onLoginSuccess(session.leaderId);
        }

        return true;
      }
      setNetworkUnavailable(false);
      setAuthStatus(username ? "offline" : "guest");
      return false;
    } catch (error) {
      if (isCloudApiErrorKind(error, "network")) {
        setNetworkUnavailable(true);
        setAuthStatus(username ? "offline" : "guest");
        throw error;
      }
      console.error("Auth", "Login failed", error);
      setNetworkUnavailable(false);
      setAuthStatus(username ? "offline" : "guest");
      return false;
    } finally {
      if (authRequestControllerRef.current === controller) {
        authRequestControllerRef.current = null;
      }
      if (authEpochRef.current === myEpoch) setIsLoading(false);
    }
  };

  const logout = async () => {
    // Snapshot this logout's intent. A later login/logout bumps the epoch, letting
    // the backgrounded task below detect it has been superseded.
    const myEpoch = ++authEpochRef.current;
    authRequestControllerRef.current?.abort();
    const controller = new AbortController();
    authRequestControllerRef.current = controller;
    setIsLoading(true);
    let logoutRequestStarted = false;
    try {
      try {
        await disableNativeNotificationRegistration();
      } catch (error) {
        console.error("Notifications", "Failed to disable native notifications", error);
      }
      const clientId = await getDeviceClientId();
      cloudApi.setClientId(clientId);
      cloudApi.setToken(null);
      // The server-side logout must not block the local sign-out: when offline it
      // would hang until the TCP timeout. Fire it in the background and clear the
      // persisted cookies only AFTER the request has been sent (so the logout
      // request still carries the session cookie), while the local sign-out below
      // runs immediately.
      logoutRequestStarted = true;
      void (async () => {
        try {
          await cloudApi.logoutSession(clientId, {
            signal: controller.signal,
            timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
            clearCookiesAfterSnapshot: true,
          });
        } catch (error) {
          if (!isCloudApiErrorKind(error, "aborted")) {
            console.error("Auth", "Logout API call failed", error);
          }
        } finally {
          if (authRequestControllerRef.current === controller) {
            authRequestControllerRef.current = null;
          }
        }
      })();
    } catch (error) {
      // Local sign-out (below) must always run, even if resolving the client id
      // fails — never let logout() reject.
      console.error("Auth", "Logout failed", error);
    } finally {
      if (!logoutRequestStarted) {
        await window.electronAPI?.clearPersistedCookies?.();
      }
      setUser(null);
      setToken(null);
      setUsername(null);
      setAuthStatus("guest");
      setNetworkUnavailable(false);
      cloudApi.setToken(null);
      cloudApi.setFixedHeader("X-PP-Expected-User", "");
      localStorage.removeItem("auth_username");
      localStorage.removeItem("auth_token");
      localStorage.removeItem("pp_session_token");

      await Database.switchUser("");

      if (authEpochRef.current === myEpoch) setIsLoading(false);
    }
  };

  const updateToken = useCallback(
    (newToken: string) => {
      if (newToken) {
        setToken(newToken);
        setNetworkUnavailable(false);
        if (!username) {
          const storedUsername = localStorage.getItem("auth_username")?.trim() || "";
          if (storedUsername) {
            setUsername(storedUsername);
          }
        }
        setAuthStatus("authenticated");
        cloudApi.setToken(shouldUseBearerHeader ? newToken : null);
        localStorage.removeItem("auth_token");
        localStorage.setItem("pp_session_token", newToken);
        void configureNativeNotifications(newToken, false).catch((error) =>
          console.error("Notifications", "Failed to refresh native notification registration", error)
        );
      }
    },
    [username]
  );

  const recheckNetworkAvailability = useCallback(async (): Promise<boolean> => {
    try {
      const clientId = await getDeviceClientId();
      cloudApi.setClientId(clientId);
      cloudApi.invalidatePeekCache();
      await cloudApi.fetchPeek(true);
      setNetworkUnavailable(false);
      return true;
    } catch (error) {
      if (isCloudApiErrorKind(error, "network")) {
        setNetworkUnavailable(true);
        return false;
      }
      // Auth/HTTP errors still mean the server is reachable.
      setNetworkUnavailable(false);
      return true;
    }
  }, []);

  const restoreStoredSession = useCallback(async (): Promise<boolean> => {
    await loadInitialCredentials();
    return cloudApi.isAuthed();
  }, [loadInitialCredentials]);

  const markSessionExpired = useCallback(() => {
    void disableNativeNotificationRegistration().catch((error) => console.error("Notifications", "Failed to disable native notifications", error));
    setUser(null);
    setToken(null);
    setNetworkUnavailable(false);
    cloudApi.setToken(null);
    localStorage.removeItem("auth_token");
    localStorage.removeItem("pp_session_token");
    setAuthStatus(username ? "offline" : "guest");
    cloudApi.setFixedHeader("X-PP-Expected-User", username ?? "");
    if (!username) window.electronAPI?.clearPersistedCookies?.();
  }, [username]);

  const commitSession = useCallback(() => {
    const t = tokenRef.current;
    if (t) {
      localStorage.setItem("pp_session_token", t);
    }
  }, []);

  const changeUser = async (): Promise<string | null> => {
    await logout();
    return null;
  };

  // One-shot hardening for guest mode: if a previous authenticated cookie
  // survived an offline transition, retry server-side logout once when online.
  useEffect(() => {
    const isGuestMode = authStatus === "guest" && !username;
    if (!isGuestMode) {
      guestCookieCleanupRetriedRef.current = false;
      return;
    }
    if (isLoading || isVerificationPending || guestCookieCleanupRetriedRef.current) return;

    const tryGuestCookieCleanup = async () => {
      if (guestCookieCleanupRetriedRef.current) return;
      guestCookieCleanupRetriedRef.current = true;
      try {
        const clientId = await getDeviceClientId();
        cloudApi.setClientId(clientId);
        cloudApi.setToken(null);
        cloudApi.setFixedHeader("X-PP-Expected-User", "");
        await cloudApi.logoutSession(clientId, {
          timeoutMs: AUTH_REQUEST_TIMEOUT_MS,
          clearCookiesAfterSnapshot: true,
        });
      } catch (error) {
        console.debug("[Auth] guest cleanup retry failed", error);
      }
    };

    if (navigator.onLine) {
      void tryGuestCookieCleanup();
      return;
    }

    const handleOnline = () => {
      window.removeEventListener("online", handleOnline);
      void tryGuestCookieCleanup();
    };

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [authStatus, username, isLoading, isVerificationPending]);

  // Listen for automatic token refresh events from cloudApi.
  // When cloudApi transparently refreshes the access token via the refresh cookie,
  // it dispatches this event so we can update React state and localStorage.
  useEffect(() => {
    const handleTokensRefreshed = (e: Event) => {
      const detail = (e as CustomEvent).detail as { accessToken?: string };
      if (detail.accessToken) {
        updateToken(detail.accessToken);
      }
    };

    window.addEventListener("pp-tokens-refreshed", handleTokensRefreshed);
    return () => window.removeEventListener("pp-tokens-refreshed", handleTokensRefreshed);
  }, [updateToken]);

  const value = {
    authStatus,
    networkUnavailable,
    recheckNetworkAvailability,
    restoreStoredSession,
    isAuthenticated: authStatus === "authenticated",
    isGuest: !username,
    username,
    user,
    token,
    isLoading,
    login,
    logout,
    changeUser,
    loadInitialCredentials,
    updateToken,
    markSessionExpired,
    commitSession,
    onLoginSuccess,
    setOnLoginSuccess,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    // During HMR, the context might temporarily be undefined
    // Provide a fallback that doesn't break the app during hot reload
    if (import.meta.hot) {
      console.warn("Auth", "useAuth called outside of AuthProvider - this may be a HMR issue, retrying...");
      return {
        authStatus: "guest",
        networkUnavailable: false,
        recheckNetworkAvailability: async () => true,
        restoreStoredSession: async () => false,
        isAuthenticated: false,
        isGuest: true,
        username: null,
        user: null,
        token: null,
        isLoading: true,
        login: async () => false,
        logout: async () => {},
        changeUser: async () => null,
        loadInitialCredentials: async () => {},
        updateToken: () => {},
        markSessionExpired: () => {},
        commitSession: () => {},
        onLoginSuccess: undefined,
        setOnLoginSuccess: () => {},
      };
    }
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
