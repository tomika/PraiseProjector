import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useLocalization } from "../localization/LocalizationContext";
import { useSettings } from "../hooks/useSettings";
import { useAuth } from "../contexts/AuthContext";
import { cloudApi } from "../../common/cloudApi";
import { OnlineSessionEntry } from "../../common/pp-types";
import { P2PSessionInfo } from "../types/electron.d";
import { webBluetoothService } from "../services/webBluetooth";
import { getHostDeviceDiscoveredSessions, initHostDevicePpd, isHostDevicePpdAvailable, scanHostDeviceSessions } from "../services/hostDevicePpd";
import "./SessionsForm.css";
import { useLeader } from "../contexts/LeaderContext";
import { useSessionUrl, buildCloudUrl, generateQRCodeSVG, buildLocalUrl } from "../hooks/useSessionUrl";

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
  type: "local" | "cloud";
  url: string;
  // For local sessions
  address?: string;
  port?: number;
  hostId?: string; // hostname from offer's "id" field
  // For cloud sessions
  lastUpdate?: string;
}

const SessionsForm: React.FC<SessionsFormProps> = ({ onClose, cloudHostBasePath, onConnect }) => {
  const { t } = useLocalization();
  const { settings } = useSettings();
  const { user } = useAuth();
  const { selectedLeader, guestLeaderId } = useLeader();
  const selfId = user?.leaderId || "";

  const [sessions, setSessions] = useState<SessionDisplay[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionDisplay | null>(null);
  const [broadcastAddress, setBroadcastAddress] = useState("255.255.255.255");
  const [addressError, setAddressError] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [scanAddress, setScanAddress] = useState<string | null>(null);
  // Check for Electron APIs - use state to ensure stable value after initial detection
  const [isElectron, setIsElectron] = useState(false);
  const [hasHostDevicePpd, setHasHostDevicePpd] = useState(false);
  // Check for Web Bluetooth availability (works in browser without pairing)
  const [_hasWebBluetooth, setHasWebBluetooth] = useState(false);
  const [_bleConnecting, setBleConnecting] = useState(false);

  // Detect Electron and Web Bluetooth on mount
  useEffect(() => {
    const checkElectron = () => {
      const hasHostDevice = isHostDevicePpdAvailable();
      const hasElectron = typeof window !== "undefined" && !!window.electronAPI;
      setHasHostDevicePpd(hasHostDevice);
      setIsElectron(hasElectron);
      console.debug("App", `SessionsForm: Electron runtime: ${hasElectron}, HostDevice PPD: ${hasHostDevice}`);
    };

    // Check for Web Bluetooth
    setHasWebBluetooth(webBluetoothService.isAvailable());

    // Check immediately
    checkElectron();

    // Also check after a short delay in case APIs are loaded async
    const timeout = setTimeout(checkElectron, 100);
    return () => clearTimeout(timeout);
  }, []);

  // Draggable dialog state
  const dialogRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [isMobile, setIsMobile] = useState(false);

  // Scan timer ref
  const scanTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Detect mobile viewport
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth <= 768);
    };

    checkMobile();
    window.addEventListener("resize", checkMobile);

    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  // Center dialog on mount and resize (only when not in mobile mode)
  useEffect(() => {
    if (!dialogRef.current) return;

    if (isMobile) {
      // Clear inline styles when switching to mobile mode - let CSS handle positioning
      dialogRef.current.style.left = "";
      dialogRef.current.style.top = "";
      return;
    }

    const centerDialog = () => {
      const dialog = dialogRef.current;
      if (!dialog) return;

      const windowWidth = window.innerWidth;
      const windowHeight = window.innerHeight;
      const dialogWidth = dialog.offsetWidth;
      const dialogHeight = dialog.offsetHeight;

      dialog.style.left = `${Math.max(0, (windowWidth - dialogWidth) / 2)}px`;
      dialog.style.top = `${Math.max(0, (windowHeight - dialogHeight) / 2)}px`;
    };

    centerDialog();
    window.addEventListener("resize", centerDialog);

    return () => window.removeEventListener("resize", centerDialog);
  }, [isMobile]);

  // Initialize broadcast address from HostDevice if available
  useEffect(() => {
    const initBroadcastAddress = async () => {
      if (isHostDevicePpdAvailable()) {
        await initHostDevicePpd();
        try {
          const infoRaw = await window.hostDevice?.info?.(2);
          const info = typeof infoRaw === "string" ? (JSON.parse(infoRaw) as { broadcast?: string }) : undefined;
          const addr = info?.broadcast || "255.255.255.255";
          setBroadcastAddress(addr);
          setScanAddress(addr);
          return;
        } catch {
          // Fall through to default address.
        }
      }
      setBroadcastAddress("255.255.255.255");
      setScanAddress("255.255.255.255");
    };
    initBroadcastAddress();
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

  const handleMouseDown = (e: React.MouseEvent) => {
    if (isMobile || !dialogRef.current) return;

    const rect = dialogRef.current.getBoundingClientRect();
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
    setIsDragging(true);
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dialogRef.current) return;

      const newLeft = e.clientX - dragOffset.x;
      const newTop = e.clientY - dragOffset.y;

      // Keep dialog within viewport
      const maxLeft = window.innerWidth - dialogRef.current.offsetWidth;
      const maxTop = window.innerHeight - dialogRef.current.offsetHeight;

      dialogRef.current.style.left = `${Math.max(0, Math.min(maxLeft, newLeft))}px`;
      dialogRef.current.style.top = `${Math.max(0, Math.min(maxTop, newTop))}px`;
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  // Get local URL
  const localUrl = useSessionUrl("local");

  const handleBrowserClick = () => {
    // If a cloud session is selected, open that session's URL
    // If no session selected, open local webserver URL (matching C# OnStartBrowser)
    let url = "";

    if (selectedSession) {
      if (selectedSession.type === "cloud") {
        url = selectedSession.url;
      } else {
        // For local sessions, we can't directly open in browser (different device)
        // Show the local URL instead
        url = selectedSession.url;
      }
    } else if (isElectron) {
      url = buildLocalUrl(settings, true) || "";
    } else {
      url = buildCloudUrl(selectedLeader?.id || guestLeaderId);
    }

    if (url) {
      window.open(url, "_blank");
      onClose();
    }
  };

  const handleConnectClick = () => {
    // Connect to selected session (matching C# SessionsForm Connect button)
    // This enables "watch mode" for the selected session
    if (selectedSession) {
      console.info("App", `Connecting to session: ${selectedSession.id} ${selectedSession.url} ${selectedSession.type}`);

      // Notify parent about the connection with full session details
      if (onConnect) {
        const udpDetails =
          selectedSession.type === "local" && selectedSession.address && selectedSession.port && selectedSession.hostId
            ? { address: selectedSession.address, port: selectedSession.port, hostId: selectedSession.hostId }
            : undefined;
        onConnect(selectedSession.id, selectedSession.url, selectedSession.type, udpDetails);
      }
    }
    onClose();
  };

  const handleSessionSelect = (session: SessionDisplay) => {
    setSelectedSession(session);
  };

  const handleAddressChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
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

  const handleResetAddress = async () => {
    if (isHostDevicePpdAvailable()) {
      try {
        const infoRaw = await window.hostDevice?.info?.(2);
        const info = typeof infoRaw === "string" ? (JSON.parse(infoRaw) as { broadcast?: string }) : undefined;
        setBroadcastAddress(info?.broadcast || "255.255.255.255");
      } catch {
        setBroadcastAddress("255.255.255.255");
      }
    } else {
      setBroadcastAddress("255.255.255.255");
    }
    setAddressError(false);
  };

  const toggleDetails = () => {
    setShowDetails(!showDetails);
  };

  // Open OS Bluetooth settings for device pairing (Classic Bluetooth/SPP)
  const _handleOpenBluetoothSettings = async () => {
    if (window.electronAPI?.openBluetoothSettings) {
      await window.electronAPI.openBluetoothSettings();
    }
  };

  // Connect via Web Bluetooth (BLE) - no pairing required!
  const _handleWebBluetoothConnect = async () => {
    if (!webBluetoothService.isAvailable()) {
      console.warn("Web Bluetooth not available");
      return;
    }

    try {
      setBleConnecting(true);

      // Request device from user (browser shows selection dialog)
      const device = await webBluetoothService.requestDevice();
      if (!device) {
        // User cancelled
        setBleConnecting(false);
        return;
      }

      // Connect to the device
      const connected = await webBluetoothService.connect();
      if (connected) {
        console.info("App", `Connected to BLE device: ${device.name}`);

        // Add as a local session
        setSessions((prev) => [
          ...prev,
          {
            id: `ble_${device.id}`,
            name: `🔵 ${device.name}`,
            type: "local",
            url: "",
            hostId: device.id,
          },
        ]);
      }
    } catch (error) {
      console.error("Web Bluetooth connection failed:", error);
    } finally {
      setBleConnecting(false);
    }
  };

  const isBrowserEnabled = settings?.externalWebDisplayEnabled || (isElectron && settings?.iWebEnabled);

  // Compute the URL that the Browser button would open (for the QR code)
  const browserUrl = useMemo(() => {
    if (selectedSession) return selectedSession.url;
    if (isElectron) return localUrl || "";
    return buildCloudUrl(selectedLeader?.id || guestLeaderId);
  }, [selectedSession, isElectron, localUrl, selectedLeader?.id, guestLeaderId]);

  // QR code popout toggle
  const [qrExpanded, setQrExpanded] = useState(false);
  const qrPopoutRef = useRef<HTMLDivElement>(null);

  // Close expanded QR on click outside
  useEffect(() => {
    if (!qrExpanded) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (qrPopoutRef.current && !qrPopoutRef.current.contains(e.target as Node)) {
        setQrExpanded(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [qrExpanded]);

  // Title with scan address (matching C# Text = Properties.Strings.SessionsTitle + " - " + scanAddress)
  const title = scanAddress ? `${t("SessionsTitle")} - ${scanAddress}` : t("SessionsTitle");

  return (
    <div className="sessions-modal-backdrop">
      <div ref={dialogRef} className={`sessions-modal-dialog ${isMobile ? "sessions-modal-mobile" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="sessions-modal-header" onMouseDown={handleMouseDown}>
          <h5 className="sessions-modal-title">{title}</h5>
          <button type="button" className="btn-close" onClick={onClose} aria-label="Close"></button>
        </div>
        <div className="sessions-modal-body">
          {/* Web mode notice - local sessions not available */}
          {!hasHostDevicePpd && (
            <div className="alert alert-info py-2 mb-2" role="alert">
              <small>🌐 {t("WebModeSessionsNotice") || "Local network sessions are only available in the desktop app."}</small>
            </div>
          )}
          <div className="sessions-list-container">
            <table className="table table-hover sessions-table">
              <thead>
                <tr>
                  <th className="session-type-col">{t("SessionsTypeCol")}</th>
                  <th>{t("SessionsNameCol")}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="text-muted text-center">
                      {t("NoSessionsFound")}
                    </td>
                  </tr>
                ) : (
                  sessions.map((session) => (
                    <tr
                      key={session.id}
                      className={selectedSession?.id === session.id ? "table-active" : ""}
                      onClick={() => handleSessionSelect(session)}
                    >
                      <td className="session-type-icon">{session.type === "local" ? "🛜" : "🌐"}</td>
                      <td>{session.name}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Details section - collapsed by default (matching C# SwapDetails) */}
          {hasHostDevicePpd && (
            <>
              <div className="details-toggle">
                <button className="btn btn-link btn-sm" onClick={toggleDetails}>
                  {showDetails ? "▲" : "▼"}
                </button>
              </div>

              {showDetails && (
                <div className="details-section">
                  <div className="input-group input-group-sm">
                    <label htmlFor="broadcast-address" className="input-group-text">
                      {t("SessionsAddress")}
                    </label>
                    <input
                      id="broadcast-address"
                      type="text"
                      className={`form-control ${addressError ? "is-invalid" : ""}`}
                      value={broadcastAddress}
                      onChange={handleAddressChange}
                    />
                    <button className="btn btn-outline-secondary" type="button" onClick={handleResetAddress}>
                      {t("SessionsResetAddress")}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <div className="sessions-modal-footer">
          {/* //Bluetooth options - DISABLED: untested, re-enable when ready
          (
            <div className="bluetooth-buttons">
              {isElectron && window.electronAPI?.openBluetoothSettings && (
                <button
                  type="button"
                  className="btn btn-outline-secondary btn-sm"
                  onClick={handleOpenBluetoothSettings}
                  title={t("BluetoothSettingsTooltip") || "Open Bluetooth settings to pair devices"}
                >
                  ⚙️ {t("BluetoothSettings") || "Bluetooth Settings"}
                </button>
              )}
              {hasWebBluetooth && (
                <button
                  type="button"
                  className="btn btn-outline-primary btn-sm"
                  onClick={handleWebBluetoothConnect}
                  disabled={bleConnecting}
                  title={t("WebBluetoothTooltip") || "Connect to a BLE device without pairing"}
                >
                  {bleConnecting ? "..." : "🔵"} {t("WebBluetooth") || "Quick BLE Connect"}
                </button>
              )}
            </div>
          )*/}

          <div className="session-action-buttons">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              {t("Cancel")}
            </button>
            <button type="button" className="btn btn-primary" onClick={handleConnectClick} disabled={!selectedSession}>
              {t("SessionsConnect")}
            </button>
            <div className="sessions-browser-btn-wrapper" ref={qrPopoutRef}>
              {qrExpanded && browserUrl && (
                <div className="sessions-qr-popout" onClick={() => setQrExpanded(false)}>
                  <div dangerouslySetInnerHTML={{ __html: generateQRCodeSVG(browserUrl, 160) }} />
                  <div className="sessions-qr-popout-url">{browserUrl}</div>
                </div>
              )}
              <button
                type="button"
                className="btn btn-primary d-flex align-items-center gap-2"
                onClick={handleBrowserClick}
                disabled={!isBrowserEnabled}
              >
                {isBrowserEnabled && browserUrl && (
                  <div
                    className="sessions-browser-qr"
                    dangerouslySetInnerHTML={{ __html: generateQRCodeSVG(browserUrl, 30) }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setQrExpanded((v) => !v);
                    }}
                  />
                )}
                {t("SessionsBrowser")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SessionsForm;
