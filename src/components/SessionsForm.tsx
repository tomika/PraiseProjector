import React, { useState, useCallback, useRef, useEffect } from "react";
import { useLocalization } from "../localization/LocalizationContext";
import { useAuth } from "../contexts/AuthContext";
import { cloudApi } from "../../common/cloudApi";
import { OnlineSessionEntry } from "../../common/pp-types";
import { P2PSessionInfo } from "../types/electron.d";
import {
  getHostDeviceDiscoveredSessions,
  getLocalBroadcastAddresses,
  initHostDevicePpd,
  isHostDevicePpdAvailable,
  scanHostDeviceSessions,
} from "../services/hostDevicePpd";
import { getCurrentDisplay } from "../state/CurrentSongStore";
import { SessionsForm as SharedSessionsForm, classifyOnlineSession, type SessionKind, type SessionRow } from "../shared/SessionsForm";
import { icon } from "../client-view/ui/assets";

interface SessionsFormProps {
  onClose: () => void;
  cloudHostBasePath: string;
  onConnect?: (
    sessionId: string,
    sessionUrl: string,
    sessionType: "local" | "cloud",
    udpDetails?: { address: string; port: number; hostId: string }
  ) => void;
}

// Unified session type for display
interface SessionDisplay {
  id: string;
  name: string;
  /** Connect path: local = UDP/PPD peer (carries udpDetails); cloud = followed via cloudApi. */
  type: "local" | "cloud";
  /** Type-column classification (ppd / webclient / online). */
  kind: SessionKind;
  url: string;
  // For local sessions
  address?: string;
  port?: number;
  hostId?: string; // hostname from offer's "id" field
  // For cloud sessions
  lastUpdate?: string;
}

/**
 * Desktop GUI sessions hub. Thin wrapper over the shared <SessionsForm>: owns the
 * data wiring (continuous local-UDP scan + cloud online-session fetch, host
 * controls, broadcast address) and feeds the shared presentational form, which
 * renders the desktop skin.
 */
const SessionsForm: React.FC<SessionsFormProps> = ({ onClose, cloudHostBasePath, onConnect }) => {
  const { t } = useLocalization();
  const { user } = useAuth();
  const selfId = user?.leaderId || "";

  const [sessions, setSessions] = useState<SessionDisplay[]>([]);
  const [broadcastAddress, setBroadcastAddress] = useState("255.255.255.255");
  const [addressError, setAddressError] = useState(false);
  const [addressOptions, setAddressOptions] = useState<{ value: string; label: string }[]>([]);
  const [scanAddress, setScanAddress] = useState<string | null>(null);
  const [hasHostDevicePpd, setHasHostDevicePpd] = useState(false);
  const [onlineStarting, setOnlineStarting] = useState(false);
  const [scanning, setScanning] = useState(false);
  // Host-supplied default broadcast address, used to (re)seed and to reset to.
  const defaultAddressRef = useRef("255.255.255.255");

  // Detect the HostDevice PPD bridge on mount (gates local discovery + hosting).
  useEffect(() => {
    const checkElectron = () => {
      const hasHostDevice = isHostDevicePpdAvailable();
      setHasHostDevicePpd(hasHostDevice);
      console.debug("App", `SessionsForm: HostDevice PPD: ${hasHostDevice}`);
    };
    checkElectron();
    // Also check after a short delay in case APIs are loaded async
    const timeout = setTimeout(checkElectron, 100);
    return () => clearTimeout(timeout);
  }, []);

  // Scan timer ref
  const scanTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Initialize the broadcast address + the picker's options from the host bridge
  // (Electron multi-NIC lister / Android info), falling back to the global broadcast.
  useEffect(() => {
    const initBroadcastAddress = async () => {
      if (isHostDevicePpdAvailable()) await initHostDevicePpd();
      const { options, default: def } = await getLocalBroadcastAddresses();
      const addr = def || "255.255.255.255";
      defaultAddressRef.current = addr;
      setAddressOptions(options);
      setBroadcastAddress(addr);
      setScanAddress(addr);
    };
    void initBroadcastAddress();
  }, []);

  // Update online session list (matching C# UpdateOnlineSessionList)
  const updateOnlineSessionList = useCallback(
    (onlineSessions: OnlineSessionEntry[]) => {
      setSessions((prevSessions) => {
        // Filter out self and create a map of online sessions
        const onlineMap = new Map<string, OnlineSessionEntry>();
        for (const session of onlineSessions) {
          if (session.id !== selfId) {
            onlineMap.set(session.id, session);
          }
        }

        // Keep local sessions, remove outdated cloud sessions, add new cloud sessions
        const localSessions = prevSessions.filter((s) => s.type === "local");
        const existingCloudIds = new Set(prevSessions.filter((s) => s.type === "cloud").map((s) => s.id));

        // Remove cloud sessions no longer in the list
        const updatedCloudSessions = prevSessions.filter((s) => s.type === "cloud" && onlineMap.has(s.id));

        // Add new cloud sessions
        for (const [id, session] of onlineMap) {
          if (!existingCloudIds.has(id)) {
            updatedCloudSessions.push({
              id: session.id,
              name: session.name,
              type: "cloud",
              // An http(s) localUrl is a LAN web client; an nrb://|udp:// one is a
              // nearby PPD peer; no localUrl is a cloud (online) session.
              kind: classifyOnlineSession(session.localUrl),
              url: session.localUrl || `${cloudHostBasePath}/view_session?leader=${session.id}`,
              lastUpdate: session.lastUpdate,
            });
          }
        }

        return [...localSessions, ...updatedCloudSessions];
      });
    },
    [selfId, cloudHostBasePath]
  );

  // Update local session list from UDP scan results
  const updateLocalSessionList = useCallback((localSessions: P2PSessionInfo[]) => {
    setSessions((prevSessions) => {
      // Filter out stale local sessions (older than 3 seconds)
      const now = Date.now();
      const staleThreshold = 3000;

      // Create map of new local sessions
      const localMap = new Map<string, P2PSessionInfo>();
      for (const session of localSessions) {
        if (now - session.detected < staleThreshold) {
          localMap.set(session.id, session);
        }
      }

      // Keep cloud sessions, replace local sessions with fresh data
      const cloudSessions = prevSessions.filter((s) => s.type === "cloud");

      const newLocalSessions: SessionDisplay[] = [];
      for (const [, session] of localMap) {
        newLocalSessions.push({
          id: session.id,
          name: session.name,
          type: "local",
          // Locally-scanned sessions are always nearby/UDP PPD peers.
          kind: "ppd",
          url: session.url,
          address: session.address,
          port: session.port,
          hostId: session.hostId,
        });
      }

      return [...newLocalSessions, ...cloudSessions];
    });
  }, []);

  // Scan timer tick (matching C# OnTimerTick)
  const onTimerTick = useCallback(async () => {
    setScanning(true);
    try {
      // 1. Scan for local sessions via HostDevice (Android/Electron parity)
      if (hasHostDevicePpd) {
        const tryAddress = broadcastAddress;
        const result = await scanHostDeviceSessions(tryAddress);

        if (result.success) {
          if (result.address && result.address !== scanAddress) {
            setScanAddress(result.address);
            setAddressError(false);
          }
        } else if (tryAddress !== scanAddress) {
          setAddressError(true);
        }

        const discovered = getHostDeviceDiscoveredSessions();
        updateLocalSessionList(discovered);
      }

      // 2. Fetch online sessions from cloud (works in both Electron and web mode)
      try {
        const onlineSessions = await cloudApi.fetchOnlineSessions();
        console.debug("App", `SessionsForm: Fetched online sessions: ${onlineSessions.length}`);
        updateOnlineSessionList(onlineSessions);
      } catch (error) {
        console.error("App", "Failed to fetch online sessions", error);
      }
    } finally {
      setScanning(false);
    }
  }, [hasHostDevicePpd, broadcastAddress, scanAddress, updateLocalSessionList, updateOnlineSessionList]);

  // Start/stop scan timer
  useEffect(() => {
    // Initial scan - use setTimeout to avoid calling setState synchronously in effect
    const initialTimeout = setTimeout(() => {
      onTimerTick();
    }, 0);

    // Start periodic scanning (every 1 second, matching C# scanTimer.Interval = 1000)
    scanTimerRef.current = setInterval(onTimerTick, 1000);

    return () => {
      clearTimeout(initialTimeout);
      if (scanTimerRef.current) {
        clearInterval(scanTimerRef.current);
        scanTimerRef.current = null;
      }
    };
  }, [onTimerTick]);

  // Connect to a specific session row (the per-row plug button). Enables "watch
  // mode" for that session (matching C# SessionsForm Connect).
  const handleConnect = (id: string) => {
    const session = sessions.find((s) => s.id === id);
    if (session) {
      console.info("App", `Connecting to session: ${session.id} ${session.url} ${session.type}`);

      if (onConnect) {
        const udpDetails =
          session.type === "local" && session.address && session.port && session.hostId
            ? { address: session.address, port: session.port, hostId: session.hostId }
            : undefined;
        onConnect(session.id, session.url, session.type, udpDetails);
      }
    }
    onClose();
  };

  // Start an online (cloud) session by force-registering the current projected display
  // under our leader id — the /display_update upsert makes us discoverable at once.
  const handleStartOnline = useCallback(async () => {
    if (!selfId) return;
    setOnlineStarting(true);
    try {
      const d = getCurrentDisplay();
      await cloudApi.sendDisplayUpdate({
        songId: d.songId,
        from: d.from,
        to: d.to,
        section: d.section,
        sectionRepeatCounts: d.sectionRepeatCounts,
        sectionRepeatNonce: d.sectionRepeatNonce,
        transpose: d.transpose,
        leaderId: selfId,
        playlist: d.playlist,
        song: d.song,
        message: d.message,
        instructions: d.instructions,
      });
    } catch (error) {
      console.error("App", "Failed to start online session", error);
    } finally {
      setOnlineStarting(false);
    }
  }, [selfId]);

  const handleAddressChange = (value: string) => {
    setBroadcastAddress(value);

    // Validate IP address format
    const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipPattern.test(value)) {
      setAddressError(true);
    } else {
      const parts = value.split(".").map(Number);
      const valid = parts.every((p) => p >= 0 && p <= 255);
      setAddressError(!valid);
    }
  };

  const handleResetAddress = () => {
    setBroadcastAddress(defaultAddressRef.current);
    setAddressError(false);
  };

  // Dialog accessible name with the resolved scan address (no visible title bar).
  const title = scanAddress ? `${t("SessionsTitle")} - ${scanAddress}` : t("SessionsTitle");

  const rows: SessionRow[] = sessions.map((s) => ({ id: s.id, name: s.name, kind: s.kind }));

  return (
    <SharedSessionsForm
      variant="desktop"
      title={title}
      emptyLabel={t("NoSessionsFound")}
      sessions={rows}
      onConnect={handleConnect}
      connectLabel={t("SessionsConnect")}
      scanning={scanning}
      scanIcon={icon("radar.svg")}
      webModeNotice={hasHostDevicePpd ? null : `🌐 ${t("WebModeSessionsNotice") || "Local network sessions are only available in the desktop app."}`}
      details={
        hasHostDevicePpd
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
      startOnline={
        selfId
          ? {
              label: t("SessionsStartOnline") || "Start online session",
              title: t("SessionsStartOnlineTooltip") || "Register this device as an online session others can follow",
              starting: onlineStarting,
              onStart: () => void handleStartOnline(),
            }
          : undefined
      }
      closeLabel={t("Close")}
      onClose={onClose}
      switchUi={{
        label: t("SessionsSwitchUI"),
        onClick: () => {
          window.dispatchEvent(new Event("pp-show-client-view"));
          onClose();
        },
      }}
    />
  );
};

export default SessionsForm;
