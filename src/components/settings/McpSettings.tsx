import React, { useCallback, useEffect, useState } from "react";
import type { McpServerStatus } from "../../../common/mcp-bridge";
import { MCP_DEFAULT_PORT } from "../../../common/mcp-bridge";
import { useLocalization } from "../../localization/LocalizationContext";
import { Settings } from "../../types";

interface McpSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

type SnippetKind = "stdio" | "http";

/** True where the Electron main process hosts the MCP endpoint. */
export const isMcpRuntimeAvailable = (): boolean => typeof window !== "undefined" && !!window.electronAPI?.getMcpStatus;

function snippet(kind: SnippetKind, status: McpServerStatus): string {
  if (kind === "http") {
    return `claude mcp add --transport http praiseprojector ${status.url} --header "Authorization: Bearer ${status.token}"`;
  }
  const server: Record<string, unknown> = { command: status.stdio.command, args: status.stdio.args };
  if (Object.keys(status.stdio.env).length) server.env = status.stdio.env;
  return JSON.stringify({ mcpServers: { praiseprojector: server } }, null, 2);
}

const McpSettings: React.FC<McpSettingsProps> = ({ settings, updateSetting }) => {
  const { t } = useLocalization();
  const [status, setStatus] = useState<McpServerStatus | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [kind, setKind] = useState<SnippetKind>("stdio");
  const [copied, setCopied] = useState("");

  const refresh = useCallback(() => {
    void window.electronAPI
      ?.getMcpStatus?.()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(refresh, [refresh]);

  const copy = (what: string, value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(what);
      window.setTimeout(() => setCopied(""), 2000);
    });
  };

  const regenerate = () => {
    void window.electronAPI
      ?.regenerateMcpToken?.()
      .then(setStatus)
      .catch(() => undefined);
  };

  // The switches are saved with the dialog; the running server reflects the saved state.
  const pendingRestart = !!status && (status.enabled !== settings.mcpEnabled || (settings.mcpEnabled && status.port !== settings.mcpPort));
  const statusText = !status
    ? ""
    : pendingRestart
      ? t("McpStatusPending")
      : status.error
        ? `${t("McpStatusError")} ${status.error}`
        : status.running
          ? `${t("McpStatusRunning")} ${status.url}`
          : t("McpStatusStopped");

  return (
    <div className="settings-page">
      <p className="text-muted small">{t("McpIntro")}</p>

      <div className="form-check mb-2">
        <input
          type="checkbox"
          className="form-check-input"
          id="mcpEnabled"
          checked={settings.mcpEnabled}
          onChange={(e) => updateSetting("mcpEnabled", e.target.checked)}
        />
        <label className="form-check-label" htmlFor="mcpEnabled">
          {t("McpEnable")}
        </label>
      </div>

      <div className="d-flex align-items-center gap-2 mb-2">
        <label htmlFor="mcpPort" className={`mb-0 ${settings.mcpEnabled ? "" : "text-muted"}`}>
          {t("McpPort")}
        </label>
        <input
          type="number"
          className="form-control form-control-sm"
          style={{ width: "7em" }}
          id="mcpPort"
          min={1024}
          max={65535}
          disabled={!settings.mcpEnabled}
          value={settings.mcpPort}
          onChange={(e) => updateSetting("mcpPort", Number.parseInt(e.target.value, 10) || MCP_DEFAULT_PORT)}
        />
        <span className={`small ${status?.error && !pendingRestart ? "text-danger" : "text-muted"}`}>{statusText}</span>
      </div>

      <div className="form-check">
        <input
          type="checkbox"
          className="form-check-input"
          id="mcpAllowChanges"
          disabled={!settings.mcpEnabled}
          checked={settings.mcpAllowChanges}
          onChange={(e) => updateSetting("mcpAllowChanges", e.target.checked)}
        />
        <label className="form-check-label" htmlFor="mcpAllowChanges">
          {t("McpAllowChanges")}
        </label>
        <div className="text-muted small">{t("McpAllowChangesDescription")}</div>
      </div>
      <div className="form-check ms-4">
        <input
          type="checkbox"
          className="form-check-input"
          id="mcpConfirmChanges"
          disabled={!settings.mcpEnabled || !settings.mcpAllowChanges}
          checked={settings.mcpConfirmChanges}
          onChange={(e) => updateSetting("mcpConfirmChanges", e.target.checked)}
        />
        <label className="form-check-label" htmlFor="mcpConfirmChanges">
          {t("McpConfirmChanges")}
        </label>
      </div>
      <div className="form-check mb-3">
        <input
          type="checkbox"
          className="form-check-input"
          id="mcpAllowLiveControl"
          disabled={!settings.mcpEnabled}
          checked={settings.mcpAllowLiveControl}
          onChange={(e) => updateSetting("mcpAllowLiveControl", e.target.checked)}
        />
        <label className="form-check-label" htmlFor="mcpAllowLiveControl">
          {t("McpAllowLiveControl")}
        </label>
        <div className="text-muted small">{t("McpAllowLiveControlDescription")}</div>
      </div>

      {status && (
        <>
          <label htmlFor="mcpToken" className="mb-1">
            {t("McpToken")}
          </label>
          <div className="input-group input-group-sm mb-1">
            <input type={showToken ? "text" : "password"} className="form-control" id="mcpToken" readOnly value={status.token} />
            <button className="btn btn-outline-secondary" type="button" onClick={() => setShowToken((shown) => !shown)}>
              {showToken ? t("McpHide") : t("McpShow")}
            </button>
            <button className="btn btn-outline-secondary" type="button" onClick={() => copy("token", status.token)}>
              {copied === "token" ? t("McpCopied") : t("McpCopy")}
            </button>
            <button className="btn btn-outline-secondary" type="button" onClick={regenerate}>
              {t("McpRegenerate")}
            </button>
          </div>
          <div className="text-muted small mb-3">{t("McpTokenDescription")}</div>

          <div className="d-flex align-items-center gap-2 mb-1">
            <span>{t("McpConnect")}</span>
            <select
              className="form-select form-select-sm"
              style={{ width: "auto" }}
              value={kind}
              onChange={(e) => setKind(e.target.value as SnippetKind)}
            >
              <option value="stdio">{t("McpConnectStdio")}</option>
              <option value="http">{t("McpConnectHttp")}</option>
            </select>
            <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => copy("snippet", snippet(kind, status))}>
              {copied === "snippet" ? t("McpCopied") : t("McpCopy")}
            </button>
            <button className="btn btn-sm btn-outline-secondary" type="button" onClick={refresh}>
              {t("McpRefresh")}
            </button>
          </div>
          <textarea
            className="form-control form-control-sm font-monospace"
            readOnly
            rows={kind === "stdio" ? 9 : 3}
            value={showToken || kind === "stdio" ? snippet(kind, status) : snippet(kind, { ...status, token: "…" })}
          />
          <div className="text-muted small mt-1">{t(kind === "stdio" ? "McpConnectStdioDescription" : "McpConnectHttpDescription")}</div>
        </>
      )}
    </div>
  );
};

export default McpSettings;
