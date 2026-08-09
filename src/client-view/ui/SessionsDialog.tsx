/**
 * SessionsDialog — the client-view host for the shared <SessionsForm> (opened from
 * MoreMenu → "Sessions", App mode only).
 *
 * It keeps the client-view-specific concerns (discovering sessions through the
 * store, starting an online session, attaching on a row's connect button) and
 * renders the shared form with the client-view skin. Discovery is continuous
 * (polled) to mirror the desktop sessions hub, driven through the chosen broadcast
 * address. The scan-address picker and its default are seeded from the host
 * bridge (store.getScanAddresses) — previously the cv hard-coded 255.255.255.255,
 * which doesn't reach the local subnet, so no offered services were found.
 *
 * The discovered sessions are classified into the three kinds shown in the table:
 *   - ppd         → local UDP/nearby peer (nrb://|udp:// localUrl);
 *   - webclient   → a LAN web client (an http(s) localUrl, opened by attach);
 *   - online      → a cloud session followed via display_query (no localUrl).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ExternalSearchMode, OnlineSessionEntry, SessionFeatureKey } from "../api/ClientApi";
import {
  readClientViewSessionsFoundPopup,
  readSessionToggleSettings,
  sessionKindMatchesMode,
  type SessionToggleSettings,
} from "../api/sessionFeatureSettings";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { SessionsForm, classifyOnlineSession, type SessionRow } from "../../shared/SessionsForm";
import { useOptionalOnlineSession } from "../../contexts/OnlineSessionContext";
import { buildCloudUrl, buildLocalUrl } from "../../hooks/useSessionUrl";
import { useLocalization } from "../../localization/LocalizationContext";
import { readPersistedSettings } from "../../services/settingsStore";
import { icon } from "./assets";

/** Emit a local (UDP/Nearby) scan round this often while the dialog is open. */
const LOCAL_SCAN_MS = 1000;
/** Cloud session-list cadence. Separate from the local scan on purpose: the two used
 *  to share one poll and one in-flight guard, so a slow cloud request (up to its 3 s
 *  timeout) delayed the next local scan past the peers' liveness window and rows kept
 *  dropping out and coming back. */
const CLOUD_FETCH_MS = 5000;
/** Wide scan rounds right after opening, so the first hit does not wait a full period. */
const OPENING_BURST_MS = [0, 250, 750];
const STARTUP_AUTO_CLOSE_MS = 10_000;
const FALLBACK_BROADCAST = "255.255.255.255";

type SessionConnectionRow = { row: SessionRow; target: OnlineSessionEntry };

function buildConnectionRows(sessions: OnlineSessionEntry[]): SessionConnectionRow[] {
  return sessions.flatMap((session) => {
    const kind = classifyOnlineSession(session.localUrl);
    if (kind === "webclient" && session.id.startsWith("udp_")) {
      return [
        { row: { id: `web:${session.id}`, name: session.name, kind: "webclient" }, target: session },
        { row: { id: `ppd:${session.id}`, name: session.name, kind: "ppd" }, target: { ...session, localUrl: undefined } },
      ];
    }
    return [{ row: { id: `${kind}:${session.id}`, name: session.name, kind }, target: session }];
  });
}

export function SessionsDialog() {
  const { t } = useLocalization();
  const hostOnlineSession = useOptionalOnlineSession();
  const store = useClientViewStore();
  const state = useClientViewState();

  const [searched, setSearched] = useState(false);
  const [broadcastAddress, setBroadcastAddress] = useState(FALLBACK_BROADCAST);
  const [addressError, setAddressError] = useState(false);
  const [addressOptions, setAddressOptions] = useState<{ value: string; label: string }[]>([]);
  const [sessionToggleSettings, setSessionToggleSettings] = useState<SessionToggleSettings>(() => readSessionToggleSettings());
  const [sessionUrlSettings, setSessionUrlSettings] = useState(() => readPersistedSettings());
  const [localWebServerHost, setLocalWebServerHost] = useState("");
  const mountedRef = useRef(true);
  // Host-supplied default broadcast address (to reset to) + the live value for the poller.
  const defaultAddressRef = useRef(FALLBACK_BROADCAST);
  const addressRef = useRef(broadcastAddress);
  addressRef.current = broadcastAddress;
  const addressErrorRef = useRef(addressError);
  addressErrorRef.current = addressError;
  const localScanInFlightRef = useRef(false);
  const cloudFetchInFlightRef = useRef(false);
  // While the dialog runs hidden as the startup auto-scan, probe only the sources
  // chosen in Settings (startupScanMode); once it's a visible/manual hub, scan BOTH.
  const startupScanModeRef = useRef<ExternalSearchMode | null>(null);
  startupScanModeRef.current = state.sessionsDialogStartupHidden ? state.startupScanMode : null;

  // Seed the scan-address picker + default from the host bridge on open.
  useEffect(() => {
    let active = true;
    void store.getScanAddresses().then(({ options, default: def }) => {
      if (!active) return;
      setAddressOptions(options);
      const addr = def || FALLBACK_BROADCAST;
      defaultAddressRef.current = addr;
      setBroadcastAddress(addr);
      store.updateStartupSessionScanAddress(options.length > 0 ? addr : undefined);
    });
    return () => {
      active = false;
    };
  }, [store]);

  // A blank configured domain is valid, but a QR shared with another device must
  // contain a LAN address rather than buildLocalUrl's loopback fallback.
  useEffect(() => {
    let active = true;
    void store.getLocalNetworkAddresses().then((addresses) => {
      if (active) setLocalWebServerHost(addresses[0] ?? "");
    });
    return () => {
      active = false;
    };
  }, [store]);

  useEffect(() => {
    const refreshToggles = () => {
      setSessionToggleSettings(readSessionToggleSettings());
      setSessionUrlSettings(readPersistedSettings());
    };
    window.addEventListener("pp-settings-changed", refreshToggles);
    return () => window.removeEventListener("pp-settings-changed", refreshToggles);
  }, []);

  const setSessionToggle = async (key: SessionFeatureKey, value: boolean) => {
    setSessionToggleSettings((current) => ({ ...current, [key]: value }));
    await store.setSessionFeatureEnabled(key, value);
    setSessionToggleSettings(readSessionToggleSettings());
  };

  // Emit a local scan round. Only SENDS — the answering offers land in hostDevicePpd
  // and reach the store through the change subscription below, so a peer shows up as
  // soon as it replies instead of on the following poll tick.
  const scanLocal = useCallback(
    async (broad: boolean) => {
      const mode: ExternalSearchMode = startupScanModeRef.current ?? "BOTH";
      if (mode !== "BOTH" && mode !== "NEARBY") return;
      if (localScanInFlightRef.current) return;
      localScanInFlightRef.current = true;
      try {
        await store.refreshLocalSessions(addressErrorRef.current ? FALLBACK_BROADCAST : addressRef.current, { broad });
      } finally {
        localScanInFlightRef.current = false;
        if (mountedRef.current) setSearched(true);
      }
    },
    [store]
  );

  // Local discovery: burst, then settle into a steady cadence. Answering offers reach
  // the store through its ClientApi session subscription, so this only drives sending.
  useEffect(() => {
    mountedRef.current = true;
    const burstTimers = OPENING_BURST_MS.map((delay) => setTimeout(() => void scanLocal(true), delay));
    const timer = setInterval(() => void scanLocal(false), LOCAL_SCAN_MS);
    return () => {
      mountedRef.current = false;
      for (const burstTimer of burstTimers) clearTimeout(burstTimer);
      clearInterval(timer);
    };
  }, [scanLocal]);

  // Cloud session list on its own, slower loop (see CLOUD_FETCH_MS).
  useEffect(() => {
    let cancelled = false;
    const fetchOnline = async () => {
      // Re-read per round, not once at setup: a hidden startup scan can be revealed
      // into a full manual hub, which widens the mode from WEB/NEARBY to BOTH.
      const mode: ExternalSearchMode = startupScanModeRef.current ?? "BOTH";
      if (mode !== "BOTH" && mode !== "WEB") return;
      if (cloudFetchInFlightRef.current) return;
      cloudFetchInFlightRef.current = true;
      try {
        await store.refreshOnlineSessions();
      } finally {
        cloudFetchInFlightRef.current = false;
        if (!cancelled && mountedRef.current) setSearched(true);
      }
    };
    void fetchOnline();
    const timer = setInterval(() => void fetchOnline(), CLOUD_FETCH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [store]);

  useEffect(() => {
    if (!state.sessionsDialogStartupHidden) return;
    const timer = setTimeout(() => store.closeStartupSessionsDialogIfHidden(), STARTUP_AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [state.sessionsDialogStartupHidden, store]);

  // While the startup scan runs hidden, only auto-reveal when a found session's
  // type matches the popup mask; any other found session badges the button instead.
  useEffect(() => {
    if (!state.sessionsDialogStartupHidden || state.sessions.length === 0) return;
    const popupMode = readClientViewSessionsFoundPopup();
    const anyPopupWorthy = buildConnectionRows(state.sessions).some(({ row }) => sessionKindMatchesMode(row.kind, popupMode));
    if (anyPopupWorthy) store.revealStartupSessionsDialog();
    else store.markBackgroundSessionsFound();
  }, [state.sessionsDialogStartupHidden, state.sessions, store]);

  const caps = state.capabilities;

  // A single UDP offer can expose two independent connection paths. Keep the
  // original session id for the transport lookup, but give each visible choice a
  // distinct row id and override the PPD choice's URL so attach() follows it
  // instead of opening the advertised HTTP endpoint.
  const connectionRows = buildConnectionRows(state.sessions);

  const handleConnect = (id: string) => {
    const connection = connectionRows.find(({ row }) => row.id === id);
    if (connection) void store.attachSession(connection.target);
    store.closeSessionsDialog();
  };

  const handleAddressChange = (value: string) => {
    setBroadcastAddress(value);
    const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipPattern.test(value)) {
      setAddressError(true);
    } else {
      const parts = value.split(".").map(Number);
      setAddressError(!parts.every((p) => p >= 0 && p <= 255));
    }
  };

  const handleResetAddress = () => {
    setBroadcastAddress(defaultAddressRef.current);
    setAddressError(false);
  };

  const sessionKindIcon: Record<SessionRow["kind"], string> = {
    online: icon("www.svg"),
    webclient: icon("wifi.svg"),
    ppd: icon("tablet.svg"),
  };
  // Stable order — discovery order re-shuffles as offers arrive, which reads as rows
  // vanishing and returning. Mirrors the desktop hub.
  const kindOrder: Record<SessionRow["kind"], number> = { ppd: 0, webclient: 1, online: 2 };
  const rows: SessionRow[] = connectionRows
    .map(({ row }) => ({ ...row, icon: sessionKindIcon[row.kind] }))
    .sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const hasWebServerBackend = caps.hasWebServerBackend;
  const hasPpdBackend = caps.hasHostBridge;
  // Online hosting needs a live OnlineSession controller to drive. Its provider is
  // mounted only in the full renderer (main.tsx), so a STANDALONE client view — the
  // cloud PWA and the /public.html showcase — has none: without this gate the toggle
  // stayed interactive while starting nothing (no session, no status, no QR).
  // Deliberately NOT caps.canHostOnlineSession: in the AppDirect embed that flag IS
  // the externalWebDisplayEnabled setting, so gating the control on it would latch
  // the switch off permanently once turned off.
  const canHostOnline = !!hostOnlineSession?.canPublish;
  const cloudSessionUrl = hostOnlineSession
    ? hostOnlineSession.state.phase === "active" && hostOnlineSession.sessionOwnerId
      ? buildCloudUrl(hostOnlineSession.sessionOwnerId)
      : null
    : state.leader?.id
      ? buildCloudUrl(state.leader.id)
      : null;
  const cloudStatusText =
    hostOnlineSession?.state.phase === "starting"
      ? t("OnlineSessionStarting")
      : hostOnlineSession?.state.phase === "active"
        ? t("OnlineSessionActive")
        : hostOnlineSession?.state.phase === "error"
          ? hostOnlineSession.state.error === "NO_SESSION"
            ? t("OnlineSessionNoSession")
            : hostOnlineSession.state.error === "UNAUTHORIZED"
              ? t("OnlineSessionUnauthorized")
              : hostOnlineSession.state.error === "UNKNOWN_LEADER"
                ? t("OnlineSessionUnknownLeader")
                : t("OnlineSessionError")
          : undefined;
  const localSessionUrl = buildLocalUrl({
    ...sessionUrlSettings,
    iWebEnabled: sessionToggleSettings.iWebEnabled,
    webServerDomainName: sessionUrlSettings.webServerDomainName || localWebServerHost,
  });

  if (state.sessionsDialogStartupHidden) return null;

  return (
    <SessionsForm
      variant="cv"
      isDark={state.isDark}
      title={t("SessionsTitle")}
      emptyLabel={searched ? t("NoSessionsFound") : t("SessionsTitle")}
      sessions={rows}
      onConnect={handleConnect}
      connectLabel={t("SessionsConnect")}
      // Discovery runs continuously while the dialog is open, so the indicator
      // reflects that state rather than an individual round (mirrors the desktop hub).
      scanning={hasPpdBackend}
      scanIcon={icon("radar.svg")}
      details={
        caps.hasHostBridge
          ? {
              addressLabel: t("SessionsAddress"),
              resetLabel: t("SessionsResetAddress"),
              address: broadcastAddress,
              addressError,
              addressOptions,
              pickLabel: "⮟",
              onAddressChange: handleAddressChange,
              onResetAddress: handleResetAddress,
            }
          : undefined
      }
      sessionToggles={[
        {
          id: "cloud-session",
          title: t("SessionsCloudToggleTitle"),
          description: t("SessionsCloudToggleDescription"),
          icon: icon("cloud-session.svg"),
          qrUrl: cloudSessionUrl,
          qrLabel: t("SessionsCloudToggleTitle"),
          showText: false,
          isFeatureEnabled: canHostOnline && sessionToggleSettings.externalWebDisplayEnabled,
          isControlDisabled: !canHostOnline,
          statusText: cloudStatusText,
          statusTone: hostOnlineSession?.state.phase === "error" ? "error" : hostOnlineSession?.state.phase === "active" ? "success" : "progress",
          onToggle: (nextFeatureEnabled) => {
            if (nextFeatureEnabled) hostOnlineSession?.setStarting();
            else hostOnlineSession?.setDisabled();
            void setSessionToggle("externalWebDisplayEnabled", nextFeatureEnabled);
          },
        },
        {
          id: "iweb-session",
          title: t("SessionsIWebToggleTitle"),
          description: t("SessionsIWebToggleDescription"),
          icon: icon("iweb-session.svg"),
          qrUrl: localSessionUrl,
          qrLabel: t("SessionsIWebToggleTitle"),
          showText: false,
          isFeatureEnabled: hasWebServerBackend && sessionToggleSettings.iWebEnabled,
          isControlDisabled: !hasWebServerBackend,
          onToggle: (nextFeatureEnabled) => void setSessionToggle("iWebEnabled", nextFeatureEnabled),
        },
        {
          id: "ppd-session",
          title: t("SessionsPpdToggleTitle"),
          description: t("SessionsPpdToggleDescription"),
          icon: icon("ppd-session.svg"),
          showText: false,
          isFeatureEnabled: hasPpdBackend && sessionToggleSettings.ppdSessionEnabled,
          isControlDisabled: !hasPpdBackend,
          onToggle: (nextFeatureEnabled) => {
            void (async () => {
              await setSessionToggle("ppdSessionEnabled", nextFeatureEnabled);
              if (nextFeatureEnabled) await store.startLocalSession();
              else await store.stopLocalSession();
            })();
          },
        },
      ]}
      closeLabel={t("Close")}
      onClose={() => store.closeSessionsDialog()}
    />
  );
}
