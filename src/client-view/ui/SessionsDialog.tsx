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
import { icon } from "./assets";

/** Re-discover sessions this often while the dialog is open (mirrors the desktop hub). */
const SESSION_POLL_MS = 2000;
const STARTUP_AUTO_CLOSE_MS = 10_000;
const FALLBACK_BROADCAST = "255.255.255.255";

export function SessionsDialog() {
  const store = useClientViewStore();
  const state = useClientViewState();

  const [searched, setSearched] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [broadcastAddress, setBroadcastAddress] = useState(FALLBACK_BROADCAST);
  const [addressError, setAddressError] = useState(false);
  const [addressOptions, setAddressOptions] = useState<{ value: string; label: string }[]>([]);
  const [sessionToggleSettings, setSessionToggleSettings] = useState<SessionToggleSettings>(() => readSessionToggleSettings());
  const mountedRef = useRef(true);
  // Host-supplied default broadcast address (to reset to) + the live value for the poller.
  const defaultAddressRef = useRef(FALLBACK_BROADCAST);
  const addressRef = useRef(broadcastAddress);
  addressRef.current = broadcastAddress;
  const addressErrorRef = useRef(addressError);
  addressErrorRef.current = addressError;
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

  useEffect(() => {
    const refreshToggles = () => setSessionToggleSettings(readSessionToggleSettings());
    window.addEventListener("pp-settings-changed", refreshToggles);
    return () => window.removeEventListener("pp-settings-changed", refreshToggles);
  }, []);

  const setSessionToggle = async (key: SessionFeatureKey, value: boolean) => {
    setSessionToggleSettings((current) => ({ ...current, [key]: value }));
    await store.setSessionFeatureEnabled(key, value);
    setSessionToggleSettings(readSessionToggleSettings());
  };

  const refresh = useCallback(async () => {
    try {
      const mode: ExternalSearchMode = startupScanModeRef.current ?? "BOTH";
      await store.refreshSessions(mode, addressErrorRef.current ? undefined : addressRef.current);
    } finally {
      if (mountedRef.current) {
        setSearched(true);
      }
    }
  }, [store]);

  // Discover sessions on open, then keep the list fresh while the dialog is up.
  useEffect(() => {
    mountedRef.current = true;
    setScanning(true);
    void refresh();
    const timer = setInterval(() => void refresh(), SESSION_POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

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
    const anyPopupWorthy = state.sessions.some((s) => sessionKindMatchesMode(classifyOnlineSession(s.localUrl), popupMode));
    if (anyPopupWorthy) store.revealStartupSessionsDialog();
    else store.markBackgroundSessionsFound();
  }, [state.sessionsDialogStartupHidden, state.sessions, store]);

  const caps = state.capabilities;

  const handleConnect = (id: string) => {
    const session = state.sessions.find((s) => s.id === id);
    if (session) void store.attachSession(session);
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

  const rows: SessionRow[] = state.sessions.map((session: OnlineSessionEntry) => ({
    id: session.id,
    name: session.name,
    kind: classifyOnlineSession(session.localUrl),
  }));
  const hasWebServerBackend = caps.hasWebServerBackend;
  const hasPpdBackend = caps.hasHostBridge;

  if (state.sessionsDialogStartupHidden) return null;

  return (
    <SessionsForm
      variant="cv"
      isDark={state.isDark}
      title="Sessions"
      emptyLabel={searched ? "No sessions found" : "Searching…"}
      sessions={rows}
      onConnect={handleConnect}
      connectLabel="Connect"
      scanning={scanning}
      scanIcon={icon("radar.svg")}
      details={
        caps.hasHostBridge
          ? {
              addressLabel: "Address",
              resetLabel: "Reset",
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
          title: "Cloud",
          description: "Publish this session through the cloud.",
          icon: icon("cloud-session.svg"),
          showText: false,
          isFeatureEnabled: sessionToggleSettings.externalWebDisplayEnabled,
          onToggle: (nextFeatureEnabled) => void setSessionToggle("externalWebDisplayEnabled", nextFeatureEnabled),
        },
        {
          id: "iweb-session",
          title: "iWeb",
          description: "Allow local browsers to connect.",
          icon: icon("iweb-session.svg"),
          showText: false,
          isFeatureEnabled: hasWebServerBackend && sessionToggleSettings.iWebEnabled,
          isControlDisabled: !hasWebServerBackend,
          onToggle: (nextFeatureEnabled) => void setSessionToggle("iWebEnabled", nextFeatureEnabled),
        },
        {
          id: "ppd-session",
          title: "PPD",
          description: "Allow nearby devices to follow.",
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
      closeLabel="Close"
      onClose={() => store.closeSessionsDialog()}
    />
  );
}
