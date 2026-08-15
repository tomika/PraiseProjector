import React, { useCallback, useEffect, useRef, useState } from "react";
import type { WebServerConnectedClient } from "../../../common/webserver-interface";
import type { Settings } from "../../types";
import { useLocalization } from "../../localization/LocalizationContext";
import { buildManagedClients, getMatchingLeaderEntries, type ManagedClient, type ManagedClientProtocol } from "../../services/clientManagement";
import { getHostedPpdClients, onHostedPpdClientsChanged } from "../../services/hostedPpdClients";
import { getWebServerInterface } from "../../services/webServerBridge";

interface ClientsSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const ClientsSettings: React.FC<ClientsSettingsProps> = ({ settings, updateSetting }) => {
  const { t } = useLocalization();
  const [clients, setClients] = useState<ManagedClient[]>([]);
  const [pendingRevokedClients, setPendingRevokedClients] = useState<Set<string>>(new Set());
  const refreshSequence = useRef(0);

  const refreshClients = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    let webClients: WebServerConnectedClient[] = [];
    const webServer = getWebServerInterface();
    if (webServer) {
      try {
        const result = await webServer.query({ kind: "clients", projectingOnly: false });
        if (result.kind === "clients") webClients = result.clients;
      } catch (error) {
        console.error("Failed to get web clients:", error);
      }
    }
    if (sequence !== refreshSequence.current) return;

    const current = buildManagedClients(settings.leaderModeClients, webClients, getHostedPpdClients(), settings.allClientsCanUseLeaderMode);
    setClients((previous) => {
      const merged = new Map(current.map((client) => [client.key, client]));
      const previousByKey = new Map(previous.map((client) => [client.key, client]));
      // The webserver still uses the last saved settings until OK is pressed. Keep
      // a just-revoked offline row visible as Guest instead of making it vanish.
      for (const key of pendingRevokedClients) {
        if (!merged.has(key)) {
          const oldClient = previousByKey.get(key);
          const representedByActivePpdRow = oldClient?.ppdPeers.some((oldPeer) =>
            current.some((client) => client.ppdPeers.some((peer) => peer.deviceId === oldPeer.deviceId))
          );
          if (oldClient && !representedByActivePpdRow) {
            merged.set(key, { ...oldClient, isConnected: false, isLeaderModeClient: false });
          }
        }
      }
      return [...merged.values()];
    });
  }, [pendingRevokedClients, settings.allClientsCanUseLeaderMode, settings.leaderModeClients]);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refreshClients(), 0);
    const interval = window.setInterval(() => void refreshClients(), 5000);
    const unsubscribePpd = onHostedPpdClientsChanged(() => void refreshClients());
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
      unsubscribePpd();
    };
  }, [refreshClients]);

  const toggleClientLeaderMode = (client: ManagedClient) => {
    if (settings.allClientsCanUseLeaderMode) return;
    const matchingEntries = getMatchingLeaderEntries(client, settings.leaderModeClients);
    if (matchingEntries.length > 0) {
      const revoked = new Set(matchingEntries);
      updateSetting(
        "leaderModeClients",
        settings.leaderModeClients.filter((entry) => !revoked.has(entry))
      );
      setPendingRevokedClients((previous) => new Set(previous).add(client.key));
      setClients((previous) => previous.map((row) => (row.key === client.key ? { ...row, isLeaderModeClient: false } : row)));
      return;
    }

    updateSetting("leaderModeClients", [...settings.leaderModeClients, client.id]);
    setPendingRevokedClients((previous) => {
      const next = new Set(previous);
      next.delete(client.key);
      return next;
    });
    setClients((previous) => previous.map((row) => (row.key === client.key ? { ...row, isLeaderModeClient: true } : row)));
  };

  const protocolLabel = (protocol: ManagedClientProtocol): string => {
    if (protocol === "web") return t("ClientProtocolWeb");
    if (protocol === "ppd-nearby") return t("ClientProtocolPpdNearby");
    return t("ClientProtocolPpdUdp");
  };

  return (
    <div className="container-fluid">
      <div className="form-check">
        <input
          className="form-check-input"
          type="checkbox"
          id="allClientsAdmin"
          checked={settings.allClientsCanUseLeaderMode}
          onChange={(event) => updateSetting("allClientsCanUseLeaderMode", event.target.checked)}
        />
        <label className="form-check-label" htmlFor="allClientsAdmin">
          {t("AllClientsAreAdmins")}
        </label>
      </div>

      <div className={`client-access-list mt-3 ${settings.allClientsCanUseLeaderMode ? "disabled" : ""}`}>
        <div className="d-flex justify-content-between align-items-center mb-2">
          <label className="form-label mb-0">{t("AdminClients")}</label>
          <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => void refreshClients()} title={t("Refresh")}>
            <i className="fa fa-refresh"></i>
          </button>
        </div>
        <p className="text-muted small">{t("ClientsDescription")}</p>

        <div className="admin-clients-list clients-settings-list border rounded mb-2">
          {clients.length === 0 ? (
            <div className="text-muted p-2 text-center small">{t("NoAdminClients")}</div>
          ) : (
            <table className="table table-sm table-hover mb-0">
              <thead>
                <tr>
                  <th className="small text-center client-state-col"></th>
                  <th className="small">{t("DeviceName")}</th>
                  <th className="small">{t("ClientProtocol")}</th>
                  <th className="small">{t("Identifier")}</th>
                  <th className="small text-center">{t("Status")}</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => (
                  <tr key={client.key} className="admin-client-row" onClick={() => toggleClientLeaderMode(client)}>
                    <td className="small text-center align-middle" title={client.isConnected ? t("ClientConnected") : t("ClientDisconnected")}>
                      <i className={`fa fa-circle ${client.isConnected ? "text-success" : "text-secondary"}`} aria-hidden="true"></i>
                    </td>
                    <td className="small">{client.deviceName || "-"}</td>
                    <td className="small">
                      <span className="client-protocol-badges">
                        {client.protocols.length > 0 ? (
                          client.protocols.map((protocol) => (
                            <span key={protocol} className="badge bg-secondary">
                              {protocolLabel(protocol)}
                            </span>
                          ))
                        ) : (
                          <span className="text-muted">{t("ClientProtocolSaved")}</span>
                        )}
                      </span>
                    </td>
                    <td className="small">
                      <code>{client.identifier}</code>
                      {client.ppdPeers
                        .filter((peer) => peer.deviceId !== client.identifier)
                        .map((peer) => (
                          <div key={peer.deviceId} className="text-muted client-address">
                            {t("ClientPpdDeviceId")}: {peer.deviceId}
                          </div>
                        ))}
                      {client.address && client.address !== client.identifier && <div className="text-muted client-address">{client.address}</div>}
                    </td>
                    <td className="small text-center">
                      {client.isLeaderModeClient ? (
                        <span className="badge bg-success">{t("Admin")}</span>
                      ) : (
                        <span className="badge bg-secondary">{t("Guest")}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};

export default ClientsSettings;
