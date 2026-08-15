import React, { useState, useEffect, useRef } from "react";
import { buildLocalUrl, generateQRCodeSVG } from "../../hooks/useSessionUrl";
import { Settings } from "../../types";
import { useLocalization } from "../../localization/LocalizationContext";
import { getLocalNetworkAddresses } from "../../services/hostDevicePpd";
import "./WebServerSettings.css";

interface WebServerSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

interface UfwStatus {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
}

const WebServerSettings: React.FC<WebServerSettingsProps> = ({ settings, updateSetting }) => {
  const { t } = useLocalization();
  const [networkAddresses, setNetworkAddresses] = useState<string[]>([]);
  const [domainDropdownOpen, setDomainDropdownOpen] = useState(false);
  const domainContainerRef = useRef<HTMLDivElement>(null);
  const [ufwStatus, setUfwStatus] = useState<UfwStatus | null>(null);
  const [ufwLoading, setUfwLoading] = useState(false);
  const [ufwResult, setUfwResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [ufwCopied, setUfwCopied] = useState(false);

  // Fetch machine's network addresses through the shared Electron/Android
  // hostDevice contract.
  useEffect(() => {
    let cancelled = false;

    const loadNetworkAddresses = async () => {
      const addresses = await getLocalNetworkAddresses();
      if (!cancelled) setNetworkAddresses(addresses);
    };

    void loadNetworkAddresses();
    return () => {
      cancelled = true;
    };
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
              <label htmlFor="serverPort" className={settings.iWebEnabled ? "" : "text-muted"}>
                {t("ServerPort")}
              </label>
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
              <label htmlFor="serverPath" className={settings.iWebEnabled ? "" : "text-muted"}>
                {t("RootPath")}
              </label>
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
              <label htmlFor="serverDomain" className={settings.iWebEnabled ? "" : "text-muted"}>
                {t("Domain")}
              </label>
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
              <label htmlFor="maxResponseTime" className={settings.iWebEnabled ? "" : "text-muted"}>
                {t("MaxResponseTime")}
              </label>
              <input
                type="number"
                className="form-control"
                id="maxResponseTime"
                value={settings.longPollTimeout}
                onChange={(e) => updateSetting("longPollTimeout", parseInt(e.target.value))}
              />
            </div>
          </div>
          {/* Right column: Local server registration and QR Code */}
          <div className="col-md-5 d-flex flex-column align-items-center justify-content-center qr-code-section">
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
            <br />
            <div className="form-check">
              <input
                className="form-check-input"
                type="checkbox"
                id="registerLocalServer"
                checked={settings.registerLocalServer}
                onChange={(e) => updateSetting("registerLocalServer", e.target.checked)}
              />
              <label className={`form-check-label ${settings.iWebEnabled ? "" : "text-muted"}`} htmlFor="registerLocalServer">
                {t("RegisterLocalServer")}
              </label>
            </div>
          </div>
        </div>

        <hr />

        <div className="form-check mt-3">
          <input
            className="form-check-input"
            type="checkbox"
            id="webServerAcceptLanClientsOnly"
            checked={settings.webServerAcceptLanClientsOnly}
            onChange={(e) => updateSetting("webServerAcceptLanClientsOnly", e.target.checked)}
          />
          <label className={`form-check-label ${settings.iWebEnabled ? "" : "text-muted"}`} htmlFor="webServerAcceptLanClientsOnly">
            {t("WebServerAcceptLanClientsOnly")}
          </label>
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
    </div>
  );
};

export default WebServerSettings;
