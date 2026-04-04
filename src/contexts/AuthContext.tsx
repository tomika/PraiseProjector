import React, { useState, useRef, useContext, useEffect, ReactNode, useCallback } from "react";
import { SessionResponse } from "../../common/pp-types";
import { cloudApi } from "../../common/cloudApi";
import { cloudApiBaseUrl } from "../config";
import { Database } from "../../db-common/Database";

type AuthStatus = "guest" | "authenticated" | "offline";

interface AuthContextType {
  authStatus: AuthStatus;
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
  return id;
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
  const [isLoading, setIsLoading] = useState(true);
  const [onLoginSuccess, setOnLoginSuccessCallback] = useState<((leaderId?: string) => void) | undefined>();

  const setOnLoginSuccess = useCallback((callback: (leaderId?: string) => void) => {
    setOnLoginSuccessCallback(() => callback);
  }, []);

  /** Persist tokens from a successful session response.
   *  When `persist` is true (default), the access token is written to
   *  localStorage so it can survive page reloads / short app restarts.
   *  Set `persist=false` for fresh logins until the user decides on "Remember Me". */
  const applySession = useCallback((session: SessionResponse, persist = true) => {
    setUser(session);
    setToken(session.token);
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
  }, []);

  const verifySession = async (username: string, authToken?: string | null): Promise<SessionResponse | null> => {
    try {
      const authType = authToken ? (authToken.startsWith("Bearer ") ? "Bearer" : authToken.startsWith("Basic ") ? "Basic" : "raw") : "cookie-only";
      console.debug("[Auth] verifySession:", { username, authType });
      cloudApi.setToken(authToken ?? null);
      const clientId = await getDeviceClientId();
      const response = await cloudApi.fetchSession(clientId, { skipRefresh: true });
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
          await cloudApi.logoutSession(clientId);
        } catch {
          // Ignore errors (e.g. network issues) since we're clearing local state anyway
        }
        await window.electronAPI?.clearPersistedCookies?.();
      }
      return null;
    } catch (error) {
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

    setIsLoading(true);
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
      } else {
        setUsername(null);
        setUser(null);
        setToken(null);
        cloudApi.setToken(null);
        cloudApi.setFixedHeader("X-PP-Expected-User", "");

        // PWAs and multiple browser tabs share HttpOnly cookies with the main
        // browser session on the same origin, while localStorage is separate.
        // If the browser is logged in but this instance has no stored username,
        // the shared cookies would silently authenticate every fetch request as
        // the browser's user while the UI shows "Guest".  verifySession with an
        // empty expected login detects the mismatch and clears the stale cookies.
        await verifySession("", null);

        setAuthStatus("guest");
        if (Database.getCurrentUsername() !== "") {
          await Database.switchUser("");
        }
        return;
      }

      let session: SessionResponse | null = null;

      // Try restoring the session using the stored access token (Bearer).
      if (storedSessionToken) {
        console.debug("[Auth] loadInitialCredentials: trying Bearer token");
        session = await verifySession(storedUsername, `Bearer ${storedSessionToken}`);
      }

      // If Bearer token failed or was missing, try cookie-only session renewal.
      // In browser mode the browser sends the HttpOnly pp_refresh cookie; in
      // Electron mode the proxy cookie jar does the same.
      if (!session) {
        console.debug("[Auth] loadInitialCredentials: trying cookie-only renewal");
        session = await verifySession(storedUsername, null);
      }

      // Backward-compatible fallback for older deployments that stored token in localStorage.
      if (!session && storedLegacyToken) {
        console.debug("[Auth] loadInitialCredentials: trying legacy token");
        session = await verifySession(storedUsername, storedLegacyToken);
      }

      if (session) {
        console.debug("[Auth] loadInitialCredentials: session restored for", storedUsername);
        applySession(session);
        return;
      }

      console.debug("[Auth] loadInitialCredentials: all methods failed, setting offline");
      localStorage.removeItem("auth_token");
      localStorage.removeItem("pp_session_token");
      await window.electronAPI?.clearPersistedCookies?.();
      setUser(null);
      setToken(null);
      cloudApi.setToken(null);
      setAuthStatus("offline");
    } catch (error) {
      console.error("Auth", "Failed to load initial credentials", error);
    } finally {
      credentialLoadInFlight = false;
      setIsLoading(false);
    }
  }, [applySession]);

  const login = async (username: string, password?: string): Promise<boolean> => {
    setIsLoading(true);
    try {
      const authToken = password ? `Basic ${btoa(`${username}:${password}`)}` : null;
      if (!authToken) {
        setIsLoading(false);
        return false;
      }
      // Explicit user switch/login: clear fixed expected-user header so the
      // session request is not constrained by the previous authenticated user.
      cloudApi.setFixedHeader("X-PP-Expected-User", "");
      // Clear proxy cookie jar before explicit login so stale session cookies
      // from a previous user don't shadow the Basic auth credentials.
      await window.electronAPI?.clearPersistedCookies?.();
      const session = await verifySession(username, authToken);
      if (session && session.token) {
        // Don't persist session token yet — wait for "Remember Me" decision.
        // In non-Electron mode, always persist (browser cookies handle refresh).
        const isElectron = typeof window !== "undefined" && !!window.electronAPI;
        applySession(session, !isElectron);
        setUsername(username);
        localStorage.setItem("auth_username", username);

        await Database.switchUser(username);

        if (onLoginSuccess) {
          onLoginSuccess(session.leaderId);
        }

        setIsLoading(false);
        return true;
      }
      setAuthStatus(username ? "offline" : "guest");
      setIsLoading(false);
      return false;
    } catch (error) {
      console.error("Auth", "Login failed", error);
      setAuthStatus(username ? "offline" : "guest");
      setIsLoading(false);
      return false;
    }
  };

  const logout = async () => {
    setIsLoading(true);
    try {
      if (token) {
        await cloudApi.logoutSession(await getDeviceClientId());
      }
    } catch (error) {
      console.error("Auth", "Logout API call failed", error);
    } finally {
      setUser(null);
      setToken(null);
      setUsername(null);
      setAuthStatus("guest");
      cloudApi.setToken(null);
      cloudApi.setFixedHeader("X-PP-Expected-User", "");
      localStorage.removeItem("auth_username");
      localStorage.removeItem("auth_token");
      localStorage.removeItem("pp_session_token");
      // Clear persisted cookies (Electron "Remember Me")
      window.electronAPI?.clearPersistedCookies?.();

      await Database.switchUser("");

      setIsLoading(false);
    }
  };

  const updateToken = useCallback(
    (newToken: string) => {
      if (newToken) {
        setToken(newToken);
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
      }
    },
    [username]
  );

  const markSessionExpired = useCallback(() => {
    setUser(null);
    setToken(null);
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
