import React, { useState, useEffect, useCallback, useRef } from "react";
import { buildLocalUrl, generateQRCodeSVG } from "../../hooks/useSessionUrl";
import { Settings } from "../../types";
import { useLocalization } from "../../localization/LocalizationContext";
import "./WebServerSettings.css";

interface ClientInfoEntry {
  id: string;
  deviceName: string;
  isLeaderModeClient: boolean;
  isConnected: boolean;
}

interface WebServerSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

interface UfwStatus {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
}

const getClientIdentifier = (id: string): string => {
  const parts = id.split("@");
  return parts[parts.length - 1] || id;
};

const getClientDeviceName = (id: string): string => {
  const parts = id.split("@");
  return parts.length > 1 ? parts[0] : "";
};

const sameIdentifierSet = (a: Set<string>, b: Set<string>): boolean => {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
};

const WebServerSettings: React.FC<WebServerSettingsProps> = ({ settings, updateSetting }) => {
  const { t } = useLocalization();
  const [connectedClients, setConnectedClients] = useState<ClientInfoEntry[]>([]);
  const [networkAddresses, setNetworkAddresses] = useState<string[]>([]);
  const [domainDropdownOpen, setDomainDropdownOpen] = useState(false);
  const domainContainerRef = useRef<HTMLDivElement>(null);
  const [ufwStatus, setUfwStatus] = useState<UfwStatus | null>(null);
  const [ufwLoading, setUfwLoading] = useState(false);
  const [ufwResult, setUfwResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [ufwCopied, setUfwCopied] = useState(false);
  const [pendingRevokedLeaderClients, setPendingRevokedLeaderClients] = useState<Set<string>>(new Set());

  // Load connected clients from backend
  const refreshClients = useCallback(async () => {
    if (window.electronAPI?.getConnectedClients) {
      try {
        const clientsMap = new Map<string, ClientInfoEntry>();
        // Add leader-mode clients first
        for (const leaderEntry of settings.leaderModeClients) {
          const parts = leaderEntry.split("@");
          const deviceName = parts.length > 1 ? parts[0] : "";
          const id = parts[parts.length - 1];
          clientsMap.set(id, { id: leaderEntry, deviceName, isLeaderModeClient: true, isConnected: false });
        }

        for (const client of await window.electronAPI.getConnectedClients()) {
          const id = getClientIdentifier(client.id);
          const existing = clientsMap.get(id);
          if (existing) {
            existing.isConnected = true;
            // Update device name in case it changed or was missing from admin entry
            existing.deviceName = client.deviceName;
          } else {
            clientsMap.set(id, {
              id: client.id,
              deviceName: client.deviceName,
              isLeaderModeClient: false,
              isConnected: true,
            });
          }
        }
        const clients = Array.from(clientsMap.values());
        const leaderClientIdentifiers = new Set(settings.leaderModeClients.map(getClientIdentifier));
        const backendLeaderIdentifiers = new Set(
          clients.filter((client) => client.isLeaderModeClient).map((client) => getClientIdentifier(client.id))
        );
        const isSettingsSyncedToBackend = sameIdentifierSet(leaderClientIdentifiers, backendLeaderIdentifiers);

        setConnectedClients((prev) => {
          const merged = new Map<string, ClientInfoEntry>();
          const previousRows = new Map(prev.map((client) => [getClientIdentifier(client.id), client]));

          for (const client of clients) {
            const identifier = getClientIdentifier(client.id);
            merged.set(identifier, {
              ...client,
              isLeaderModeClient: settings.allClientsCanUseLeaderMode || leaderClientIdentifiers.has(identifier),
              // Backend list includes saved leader-mode entries too; non-leader rows are guaranteed live connections.
              isConnected: !client.isLeaderModeClient,
            });
          }

          // Keep leader-mode rows from local settings visible even when offline.
          for (const leaderClientId of settings.leaderModeClients) {
            const identifier = getClientIdentifier(leaderClientId);
            if (!merged.has(identifier)) {
              const previous = previousRows.get(identifier);
              merged.set(identifier, {
                id: previous?.id ?? leaderClientId,
                deviceName: previous?.deviceName || getClientDeviceName(leaderClientId),
                isLeaderModeClient: true,
                isConnected: false,
              });
            }
          }

          // Keep locally revoked rows visible until backend reflects saved settings.
          if (pendingRevokedLeaderClients.size > 0) {
            for (const identifier of pendingRevokedLeaderClients) {
              if (!merged.has(identifier)) {
                const previous = previousRows.get(identifier);
                if (previous) {
                  merged.set(identifier, {
                    ...previous,
                    isLeaderModeClient: false,
                    isConnected: false,
                  });
                }
              }
            }

            if (isSettingsSyncedToBackend) {
              setPendingRevokedLeaderClients((current) => {
                const next = new Set(current);
                for (const identifier of current) {
                  const row = merged.get(identifier);
                  if (row && !row.isConnected && !row.isLeaderModeClient) {
                    merged.delete(identifier);
                    next.delete(identifier);
                  }
                }
                return next;
              });
            }
          }

          return Array.from(merged.values()).sort((a, b) => {
            const nameA = (a.deviceName || getClientIdentifier(a.id)).toLocaleLowerCase();
            const nameB = (b.deviceName || getClientIdentifier(b.id)).toLocaleLowerCase();
            return nameA.localeCompare(nameB);
          });
        });
      } catch (error) {
        console.error("Failed to get connected clients:", error);
      }
    }
  }, [pendingRevokedLeaderClients, settings.leaderModeClients, settings.allClientsCanUseLeaderMode]);

  // Refresh clients on mount and periodically
  useEffect(() => {
    refreshClients();
    const interval = setInterval(refreshClients, 5000); // Refresh every 5 seconds
    return () => clearInterval(interval);
  }, [refreshClients]);

  // Toggle client leader-mode access (matching C# OnClientItemDoubleClicked)
  const toggleClientLeaderMode = (client: ClientInfoEntry) => {
    const clientIdentifier = getClientIdentifier(client.id);
    const leaderClientIdentifiers = new Set(settings.leaderModeClients.map(getClientIdentifier));
    const isCurrentlyLeaderModeClient = settings.allClientsCanUseLeaderMode || leaderClientIdentifiers.has(clientIdentifier);

    if (isCurrentlyLeaderModeClient) {
      // Remove from explicit leader-mode list (identifier-based to handle "Device@ID" vs "ID" entries)
      const newList = settings.leaderModeClients.filter((entry) => getClientIdentifier(entry) !== clientIdentifier);
      updateSetting("leaderModeClients", newList);
      setPendingRevokedLeaderClients((prev) => {
        const next = new Set(prev);
        next.add(clientIdentifier);
        return next;
      });
    } else {
      // Add to explicit leader-mode list if not already present by identifier
      if (!leaderClientIdentifiers.has(clientIdentifier)) {
        updateSetting("leaderModeClients", [...settings.leaderModeClients, client.id]);
      }
      setPendingRevokedLeaderClients((prev) => {
        const next = new Set(prev);
        next.delete(clientIdentifier);
        return next;
      });
    }

    // Update local list immediately so label changes before backend sync/save
    setConnectedClients((prev) =>
      prev.map((c) => (getClientIdentifier(c.id) === clientIdentifier ? { ...c, isLeaderModeClient: !isCurrentlyLeaderModeClient } : c))
    );
  };

  // Fetch machine's network addresses for the domain combobox
  useEffect(() => {
    window.electronAPI
      ?.getNetworkAddresses?.()
      .then(setNetworkAddresses)
      .catch(() => {});
  }, []);

  // Auto-populate domain name with most probable address when field is empty
  useEffect(() => {
    if (!settings.webServerDomainName && networkAddresses.length > 0) {
      updateSetting("webServerDomainName", networkAddresses[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [networkAddresses]);

  // Close domain dropdown when clicking outside its container
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (domainContainerRef.current && !domainContainerRef.current.contains(e.target as Node)) {
        setDomainDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  // Check UFW status once on mount (Linux only)
  useEffect(() => {
    if (!window.electronAPI?.ufwManage) return;
    window.electronAPI
      .ufwManage("status")
      .then((result) => {
        if (result.supported) {
          setUfwStatus({ supported: true, installed: result.installed ?? false, enabled: result.enabled ?? false });
        }
      })
      .catch(() => {});
  }, []);

  // Reset apply/remove result when port changes (old result refers to old port)
  useEffect(() => {
    setUfwResult(null);
  }, [settings.webServerPort]);

  const ufwRules = `sudo ufw allow ${settings.webServerPort}/tcp && sudo ufw allow 1974:1983/udp`;

  const handleUfwCopy = () => {
    navigator.clipboard.writeText(ufwRules).then(() => {
      setUfwCopied(true);
      setTimeout(() => setUfwCopied(false), 2000);
    });
  };

  const handleUfw = async (action: "apply" | "remove") => {
    if (!window.electronAPI?.ufwManage) return;
    setUfwLoading(true);
    setUfwResult(null);
    try {
      const result = await window.electronAPI.ufwManage(action, settings.webServerPort);
      setUfwResult({ success: result.success ?? false, error: result.error });
    } catch (err) {
      setUfwResult({ success: false, error: String(err) });
    } finally {
      setUfwLoading(false);
    }
  };

  // Build the web server URL from settings
  const webServerUrl = buildLocalUrl(settings);

  return (
    <div className="container-fluid">
      <div className="form-check mb-3">
        <input
          className="form-check-input"
          type="checkbox"
          id="enableWebServer"
          checked={settings.iWebEnabled}
          onChange={(e) => updateSetting("iWebEnabled", e.target.checked)}
        />
        <label className="form-check-label" htmlFor="enableWebServer">
          {t("EnableWebServer")}
        </label>
      </div>
      <fieldset disabled={!settings.iWebEnabled}>
        <div className="row">
          {/* Left column: Server settings */}
          <div className="col-md-7">
            <div className="form-group">
              <label htmlFor="serverPort">{t("ServerPort")}</label>
              <input
                type="number"
                className="form-control"
                id="serverPort"
                value={settings.webServerPort}
                onChange={(e) => updateSetting("webServerPort", parseInt(e.target.value))}
              />
              {ufwStatus?.supported && settings.webServerPort < 1024 && (
                <small className="text-danger">
                  Ports below 1024 require root privileges on Linux and will not work without special configuration.
                </small>
              )}
            </div>
            <div className="form-group">
              <label htmlFor="serverPath">{t("RootPath")}</label>
              <div className="input-group">
                <input
                  type="text"
                  className="form-control"
                  id="serverPath"
                  value={settings.webServerPath}
                  onChange={(e) => updateSetting("webServerPath", e.target.value)}
                />
                <div className="input-group-append">
                  <button className="btn btn-outline-secondary" type="button" onClick={() => updateSetting("webServerPath", "/")}>
                    {t("Default")}
                  </button>
                </div>
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="serverDomain">{t("Domain")}</label>
              <div className="d-flex gap-2 align-items-stretch" ref={domainContainerRef}>
                <div className="flex-grow-1 position-relative">
                  <div className="input-group">
                    <input
                      type="text"
                      className="form-control"
                      id="serverDomain"
                      value={settings.webServerDomainName}
                      onChange={(e) => updateSetting("webServerDomainName", e.target.value)}
                      onFocus={() => networkAddresses.length > 0 && setDomainDropdownOpen(true)}
                      autoComplete="off"
                    />
                    {networkAddresses.length > 0 && (
                      <button
                        className="btn btn-outline-secondary"
                        type="button"
                        tabIndex={-1}
                        title="Show suggestions"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setDomainDropdownOpen((o) => !o);
                        }}
                        onTouchEnd={(e) => {
                          e.preventDefault();
                          setDomainDropdownOpen((o) => !o);
                        }}
                      >
                        ▾
                      </button>
                    )}
                  </div>
                  {domainDropdownOpen && networkAddresses.length > 0 && (
                    <ul className="dropdown-menu show w-100 mb-0 domain-dropdown-menu">
                      {networkAddresses.map((addr) => (
                        <li key={addr}>
                          <button
                            className="dropdown-item"
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              updateSetting("webServerDomainName", addr);
                              setDomainDropdownOpen(false);
                            }}
                            onTouchEnd={(e) => {
                              e.preventDefault();
                              updateSetting("webServerDomainName", addr);
                              setDomainDropdownOpen(false);
                            }}
                          >
                            {addr}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <button
                  className="btn btn-outline-secondary"
                  type="button"
                  onClick={() => {
                    updateSetting("webServerDomainName", networkAddresses[0] ?? "localhost");
                    setDomainDropdownOpen(false);
                  }}
                >
                  {t("Default")}
                </button>
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="maxResponseTime">{t("MaxResponseTime")}</label>
              <input
                type="number"
                className="form-control"
                id="maxResponseTime"
                value={settings.longPollTimeout}
                onChange={(e) => updateSetting("longPollTimeout", parseInt(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label htmlFor="netDisplayJpegQuality">{t("NetDisplayJpegQuality")}</label>
              <div className="d-flex align-items-center gap-2">
                <input
                  type="range"
                  className="form-range flex-grow-1"
                  id="netDisplayJpegQuality"
                  min={1}
                  max={100}
                  step={1}
                  value={Math.max(1, Math.min(100, settings.netDisplayJpegQuality || 70))}
                  onChange={(e) => updateSetting("netDisplayJpegQuality", parseInt(e.target.value, 10))}
                />
                <span className="small text-muted netdisplay-quality-value">
                  {Math.max(1, Math.min(100, settings.netDisplayJpegQuality || 70))}%
                </span>
              </div>
              <small className="form-text text-muted">{t("NetDisplayJpegQualityHelp")}</small>
            </div>
            <div className="form-check mt-3">
              <input
                className="form-check-input"
                type="checkbox"
                id="webServerAcceptLanClientsOnly"
                checked={settings.webServerAcceptLanClientsOnly}
                onChange={(e) => updateSetting("webServerAcceptLanClientsOnly", e.target.checked)}
              />
              <label className="form-check-label" htmlFor="webServerAcceptLanClientsOnly">
                {t("WebServerAcceptLanClientsOnly")}
              </label>
            </div>
          </div>
          {/* Right column: QR Code */}
          <div className="col-md-5 d-flex flex-column align-items-center justify-content-center">
            {webServerUrl ? (
              <div className="text-center clickable" onClick={() => window.open(webServerUrl, "_blank")}>
                <div dangerouslySetInnerHTML={{ __html: generateQRCodeSVG(webServerUrl, 160) }} />
                <div className="mt-2 small text-muted text-break">{webServerUrl}</div>
              </div>
            ) : (
              <div className="text-muted text-center">
                <small>{t("EnableWebServerToSeeQR")}</small>
              </div>
            )}
          </div>
        </div>

        {/* UFW firewall section — Linux only, shown when UFW is installed */}
        {ufwStatus?.supported && ufwStatus.installed && (
          <div className="mt-3 pt-3 border-top">
            <div className="d-flex align-items-center gap-2 mb-2">
              <strong className="small">UFW Firewall</strong>
              <span className={`badge ${ufwStatus.enabled ? "bg-success" : "bg-secondary"}`}>{ufwStatus.enabled ? "Active" : "Inactive"}</span>
            </div>
            <div className="input-group input-group-sm mb-2">
              <input type="text" className="form-control font-monospace" readOnly value={ufwRules} aria-label="UFW rules" />
              <button className="btn btn-outline-secondary" type="button" onClick={handleUfwCopy}>
                {ufwCopied ? "Copied!" : "Copy"}
              </button>
            </div>
            <div className="d-flex align-items-center gap-2">
              <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => handleUfw("apply")} disabled={ufwLoading}>
                {ufwLoading ? "…" : "Apply rules"}
              </button>
              <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => handleUfw("remove")} disabled={ufwLoading}>
                Remove rules
              </button>
              {ufwResult && (
                <small className={ufwResult.success ? "text-success" : "text-danger"}>
                  {ufwResult.success ? "Done" : (ufwResult.error ?? "Failed")}
                </small>
              )}
            </div>
          </div>
        )}
      </fieldset>

      <hr />

      <div className="form-check">
        <input
          className="form-check-input"
          type="checkbox"
          id="registerLocalServer"
          checked={settings.registerLocalServer}
          onChange={(e) => updateSetting("registerLocalServer", e.target.checked)}
        />
        <label className="form-check-label" htmlFor="registerLocalServer">
          {t("RegisterLocalServer")}
        </label>
      </div>
      <div className="form-check">
        <input
          className="form-check-input"
          type="checkbox"
          id="allClientsAdmin"
          checked={settings.allClientsCanUseLeaderMode}
          onChange={(e) => updateSetting("allClientsCanUseLeaderMode", e.target.checked)}
        />
        <label className="form-check-label" htmlFor="allClientsAdmin">
          {t("AllClientsAreAdmins")}
        </label>
      </div>

      {/* Leader-mode client list - shown when all-clients-leader-mode is disabled. */}
      {!settings.allClientsCanUseLeaderMode && (
        <div className="mt-3">
          <div className="d-flex justify-content-between align-items-center mb-2">
            <label className="form-label mb-0">{t("AdminClients")}</label>
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={refreshClients} title={t("Refresh")}>
              <i className="fa fa-refresh"></i>
            </button>
          </div>
          <p className="text-muted small">{t("AdminClientsDescription")}</p>

          {/* List of connected clients (matching C# lvClients ListView) */}
          <div className="admin-clients-list border rounded mb-2">
            {connectedClients.length === 0 ? (
              <div className="text-muted p-2 text-center small">{t("NoAdminClients")}</div>
            ) : (
              <table className="table table-sm table-hover mb-0">
                <thead>
                  <tr>
                    <th className="small text-center client-state-col"></th>
                    <th className="small">{t("DeviceName")}</th>
                    <th className="small">{t("Identifier")}</th>
                    <th className="small text-center">{t("Status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {connectedClients.map((client, index) => {
                    const parts = client.id.split("@");
                    const identifier = parts[parts.length - 1];
                    return (
                      <tr key={index} className="admin-client-row" onClick={() => toggleClientLeaderMode(client)}>
                        <td className="small text-center align-middle" title={client.isConnected ? t("ClientConnected") : t("ClientDisconnected")}>
                          <i className={`fa fa-circle ${client.isConnected ? "text-success" : "text-secondary"}`} aria-hidden="true"></i>
                        </td>
                        <td className="small">{client.deviceName || "-"}</td>
                        <td className="small">
                          <code>{identifier}</code>
                        </td>
                        <td className="small text-center">
                          {client.isLeaderModeClient ? (
                            <span className="badge bg-success">{t("Admin")}</span>
                          ) : (
                            <span className="badge bg-secondary">{t("Guest")}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default WebServerSettings;
