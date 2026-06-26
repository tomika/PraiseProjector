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
import type { OnlineSessionEntry } from "../api/ClientApi";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { SessionsForm, classifyOnlineSession, type SessionRow } from "../../shared/SessionsForm";
import { icon } from "./assets";

/** Re-discover sessions this often while the dialog is open (mirrors the desktop hub). */
const SESSION_POLL_MS = 2000;
const FALLBACK_BROADCAST = "255.255.255.255";

export function SessionsDialog() {
  const store = useClientViewStore();
  const state = useClientViewState();

  const [onlineStarting, setOnlineStarting] = useState(false);
  const [searched, setSearched] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [broadcastAddress, setBroadcastAddress] = useState(FALLBACK_BROADCAST);
  const [addressError, setAddressError] = useState(false);
  const [addressOptions, setAddressOptions] = useState<{ value: string; label: string }[]>([]);
  const mountedRef = useRef(true);
  // Host-supplied default broadcast address (to reset to) + the live value for the poller.
  const defaultAddressRef = useRef(FALLBACK_BROADCAST);
  const addressRef = useRef(broadcastAddress);
  addressRef.current = broadcastAddress;
  const addressErrorRef = useRef(addressError);
  addressErrorRef.current = addressError;

  // Seed the scan-address picker + default from the host bridge on open.
  useEffect(() => {
    let active = true;
    void store.getScanAddresses().then(({ options, default: def }) => {
      if (!active) return;
      setAddressOptions(options);
      const addr = def || FALLBACK_BROADCAST;
      defaultAddressRef.current = addr;
      setBroadcastAddress(addr);
    });
    return () => {
      active = false;
    };
  }, [store]);

  const refresh = useCallback(async () => {
    try {
      await store.refreshSessions("BOTH", addressErrorRef.current ? undefined : addressRef.current);
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

  const caps = state.capabilities;

  const handleConnect = (id: string) => {
    const session = state.sessions.find((s) => s.id === id);
    if (session) void store.attachSession(session);
    store.closeSessionsDialog();
  };

  const handleStartOnline = async () => {
    setOnlineStarting(true);
    try {
      await store.startOnlineSession();
    } finally {
      if (mountedRef.current) setOnlineStarting(false);
    }
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
      startOnline={
        caps.canHostOnlineSession
          ? {
              label: "Start online session",
              title: "Register this device as an online session others can follow",
              starting: onlineStarting,
              onStart: () => void handleStartOnline(),
            }
          : undefined
      }
      closeLabel="Close"
      onClose={() => store.closeSessionsDialog()}
    />
  );
}
