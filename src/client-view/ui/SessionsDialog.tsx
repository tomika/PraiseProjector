/**
 * SessionsDialog — discover and follow online/nearby sessions, gated off
 * capabilities.canFollowSessions (the cloud-backed client; the served client
 * auto-follows its serving host and the desktop embed IS the host, so both
 * declare it false). Mirrors the legacy #sessionList picker: a list of
 * discoverable sessions (cloud + nearby/PPD), tapping one follows it. Reflects
 * state.network.status and offers stop-following while watching.
 */

import { useCallback, useEffect, useState } from "react";
import type { OnlineSessionEntry } from "../api/ClientApi";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { icon } from "./assets";

// Classify a session for its badge, mirroring the legacy sessionType switch:
// no localUrl → cloud (WAN); nrb://|udp:// → nearby (PPD); else a LAN server.
function sessionKind(session: OnlineSessionEntry): { label: string; image: string } {
  const url = session.localUrl;
  if (!url) return { label: "Online", image: "online.svg" };
  if (url.startsWith("nrb://") || url.startsWith("udp://")) return { label: "Nearby", image: "nearby.svg" };
  return { label: "LAN", image: "wifi.svg" };
}

export function SessionsDialog() {
  const store = useClientViewStore();
  const state = useClientViewState();
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await store.refreshSessions("BOTH");
    } finally {
      setLoading(false);
    }
  }, [store]);

  // Discover sessions when the picker opens (legacy searchExternalSessions on show).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const follow = (session: OnlineSessionEntry) => {
    void store.watchSession(session);
    store.closeSessionsDialog();
  };

  const watching = state.network.status === "watching" || state.network.status === "leading";

  return (
    <div className="cv-modal-backdrop" onClick={() => store.closeSessionsDialog()}>
      <div className="cv-dialog cv-sessions-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="cv-dialog-head">
          <h2 className="cv-dialog-title">Follow a session</h2>
          <button type="button" className="cv-iconbtn" title="Search again" onClick={() => void refresh()} disabled={loading}>
            <img className="btnImg cv-opt-icon" src={icon("reset.svg")} alt="Search again" />
          </button>
        </div>

        <ul className="cv-session-list">
          {state.sessions.length === 0 ? (
            <li className="cv-session-empty">{loading ? "Searching…" : "No sessions found"}</li>
          ) : (
            state.sessions.map((session) => {
              const kind = sessionKind(session);
              return (
                <li key={session.id}>
                  <button type="button" className="cv-session-item" onClick={() => follow(session)}>
                    <img className="btnImg cv-opt-icon" src={icon(kind.image)} alt="" />
                    <span className="cv-session-name">{session.name}</span>
                    <span className="cv-session-kind">{kind.label}</span>
                  </button>
                </li>
              );
            })
          )}
        </ul>

        <div className="cv-dialog-actions">
          {watching && (
            <button
              type="button"
              className="cv-dialog-cancel"
              onClick={() => {
                void store.stopWatching();
                store.closeSessionsDialog();
              }}
            >
              Stop following
            </button>
          )}
          <button type="button" className="cv-dialog-ok" onClick={() => store.closeSessionsDialog()}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
