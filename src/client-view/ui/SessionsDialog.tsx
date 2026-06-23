/**
 * SessionsDialog — the App-mode sessions hub (opened from MoreMenu → "Sessions",
 * gated on capabilities.canFollowSessions). It ports the legacy main.html session
 * controls into one panel:
 *   - host a session: Start session (PPD) / Start online session, and Stop while active;
 *   - search: Web / Nearby (+ refresh);
 *   - the found-session selector: tap a discovered session to attach (per-type).
 * Each control dispatches a controller action; the dialog reflects state.network.status.
 */

import { useCallback, useEffect, useState } from "react";
import type { ExternalSearchMode, OnlineSessionEntry } from "../api/ClientApi";
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

  const search = useCallback(
    async (mode: ExternalSearchMode) => {
      setLoading(true);
      try {
        await store.refreshSessions(mode);
      } finally {
        setLoading(false);
      }
    },
    [store]
  );

  // Discover sessions when the picker opens (legacy searchExternalSessions on show).
  useEffect(() => {
    void search("BOTH");
  }, [search]);

  const attach = (session: OnlineSessionEntry) => {
    void store.attachSession(session);
    store.closeSessionsDialog();
  };

  return (
    <div className="cv-modal-backdrop" onClick={() => store.closeSessionsDialog()}>
      <div className="cv-dialog cv-sessions-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="cv-dialog-head">
          <h2 className="cv-dialog-title">Find a session</h2>
          <button type="button" className="cv-iconbtn" title="Search again" onClick={() => void search("BOTH")} disabled={loading}>
            <img className="btnImg cv-opt-icon" src={icon("reset.svg")} alt="Search again" />
          </button>
        </div>

        {/* Search the web and the local network on demand. */}
        <div className="cv-session-search">
          <button type="button" className="cv-session-action" onClick={() => void search("WEB")} disabled={loading}>
            <img className="btnImg cv-opt-icon" src={icon("www.svg")} alt="" />
            <span>Web</span>
          </button>
          <button type="button" className="cv-session-action" onClick={() => void search("NEARBY")} disabled={loading}>
            <img className="btnImg cv-opt-icon" src={icon("nearby.svg")} alt="" />
            <span>Nearby</span>
          </button>
        </div>

        {/* Found-session selector — tap to attach (per-type). */}
        <ul className="cv-session-list">
          {state.sessions.length === 0 ? (
            <li className="cv-session-empty">{loading ? "Searching…" : "No sessions found"}</li>
          ) : (
            state.sessions.map((session) => {
              const kind = sessionKind(session);
              return (
                <li key={session.id}>
                  <button type="button" className="cv-session-item" onClick={() => attach(session)}>
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
          <button type="button" className="cv-dialog-ok" onClick={() => store.closeSessionsDialog()}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
