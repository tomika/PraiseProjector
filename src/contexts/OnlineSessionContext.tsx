import React, { createContext, ReactNode, useCallback, useContext, useRef, useState } from "react";
import type { DisplayUpdateResult } from "../../common/cloudApi";
import { v4 as uuidv4 } from "uuid";
import { useAuth } from "./AuthContext";

export type OnlineSessionPhase = "disabled" | "starting" | "active" | "error";
type OnlineSessionError = Exclude<DisplayUpdateResult, "DONE" | "SKIPPED">;

interface OnlineSessionState {
  phase: OnlineSessionPhase;
  error?: OnlineSessionError;
}

interface OnlineSessionContextType {
  guestSessionId: string | null;
  sessionOwnerId: string | null;
  canPublish: boolean;
  state: OnlineSessionState;
  ensureGuestSession: () => string;
  clearGuestSession: () => void;
  setStarting: () => void;
  setActive: () => void;
  setError: (error: OnlineSessionError) => void;
  setDisabled: () => void;
}

const OnlineSessionContext = createContext<OnlineSessionContextType | undefined>(undefined);

export function OnlineSessionProvider({ children }: { children: ReactNode }) {
  const { authStatus, user } = useAuth();
  const [guestSessionId, setGuestSessionId] = useState<string | null>(null);
  const [state, setState] = useState<OnlineSessionState>({ phase: "disabled" });
  const guestSessionIdRef = useRef<string | null>(null);

  const ensureGuestSession = useCallback(() => {
    if (!guestSessionIdRef.current) {
      guestSessionIdRef.current = `guest_${uuidv4()}`;
      setGuestSessionId(guestSessionIdRef.current);
    }
    return guestSessionIdRef.current;
  }, []);

  const clearGuestSession = useCallback(() => {
    guestSessionIdRef.current = null;
    setGuestSessionId(null);
  }, []);
  const setStarting = useCallback(() => setState({ phase: "starting" }), []);
  const setActive = useCallback(() => setState({ phase: "active" }), []);
  const setError = useCallback((error: OnlineSessionError) => setState({ phase: "error", error }), []);
  const setDisabled = useCallback(() => setState({ phase: "disabled" }), []);
  const sessionOwnerId = authStatus === "authenticated" ? (user?.leaderId ?? null) : authStatus === "guest" ? guestSessionId : null;
  const canPublish = authStatus === "guest" || (authStatus === "authenticated" && !!user?.leaderId);

  return (
    <OnlineSessionContext.Provider
      value={{
        guestSessionId,
        sessionOwnerId,
        canPublish,
        state,
        ensureGuestSession,
        clearGuestSession,
        setStarting,
        setActive,
        setError,
        setDisabled,
      }}
    >
      {children}
    </OnlineSessionContext.Provider>
  );
}

export function useOnlineSession(): OnlineSessionContextType {
  const context = useContext(OnlineSessionContext);
  if (!context) throw new Error("useOnlineSession must be used within OnlineSessionProvider");
  return context;
}

export function useOptionalOnlineSession(): OnlineSessionContextType | undefined {
  return useContext(OnlineSessionContext);
}
