import React, { useCallback, useMemo, useState } from "react";
import { Settings } from "../../types";
import { useLocalization } from "../../localization/LocalizationContext";
import { TypesenseClient } from "../../../common/typesense-client";

interface SearchingSettingsProps {
  settings: Settings;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const ENGINES = [
  { value: "traditional" as const, labelKey: "TraditionalSearch", descKey: "TraditionalSearchDesc" },
  { value: "typesense" as const, labelKey: "TypesenseSearch", descKey: "TypesenseSearchDesc" },
] as const;

const SearchingSettings: React.FC<SearchingSettingsProps> = ({ settings, updateSetting }) => {
  const { t } = useLocalization();
  const method = settings.searchMethod;
  const isTraditional = method === "traditional";
  const isTypesense = method === "typesense";
  const [testState, setTestState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [testError, setTestError] = useState("");

  const testConnection = useCallback(async () => {
    setTestState("testing");
    setTestError("");
    try {
      const url = new URL(settings.typesenseUrl);
      const client = new TypesenseClient(
        url.hostname,
        parseInt(url.port) || (url.protocol === "https:" ? 443 : 8108),
        url.protocol.replace(":", ""),
        settings.typesenseApiKey
      );
      const ok = await client.healthCheck();
      setTestState(ok ? "ok" : "error");
      if (!ok) setTestError(t("TypesenseTestUnhealthy"));
    } catch (e) {
      setTestState("error");
      setTestError(e instanceof Error ? e.message : String(e));
    }
  }, [settings.typesenseUrl, settings.typesenseApiKey, t]);

  const platform = useMemo(() => {
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("win")) return "windows";
    if (ua.includes("mac")) return "macos";
    return "linux";
  }, []);

  return (
    <div className="container-fluid">
      {/* Search Engine Selection */}
      <div className="row mb-3">
        <div className="col-md-12">
          <h5>{t("SearchEngineSelection")}</h5>
          <div className="d-flex gap-3 flex-wrap">
            {ENGINES.map((eng) => (
              <label key={eng.value} className={`card flex-fill mb-0 ${method === eng.value ? "border-primary" : ""}`}>
                <div className="card-body">
                  <div className="form-check">
                    <input
                      className="form-check-input"
                      type="radio"
                      name="searchMethod"
                      checked={method === eng.value}
                      onChange={() => updateSetting("searchMethod", eng.value)}
                    />
                    <span className="form-check-label fw-bold">{t(eng.labelKey)}</span>
                  </div>
                  <small className="text-muted d-block mt-1">{t(eng.descKey)}</small>
                </div>
              </label>
            ))}
          </div>
        </div>
      </div>

      <hr className="my-3" />

      {/* Common Search Settings */}
      <div className="row mb-3">
        <div className="col-md-12">
          <h5>{t("CommonSearchSettings")}</h5>
          <div className="form-group">
            <label htmlFor="searchMaxResults">{t("MaximumResults")}</label>
            <input
              type="number"
              className="form-control"
              id="searchMaxResults"
              min="0"
              max="1000"
              step="10"
              value={settings.searchMaxResults ?? 0}
              onChange={(e) => updateSetting("searchMaxResults", parseInt(e.target.value) || 0)}
            />
            <small className="form-text text-muted">{t("MaximumResultsHint")}</small>
          </div>
        </div>
      </div>

      <hr className="my-3" />

      {/* Traditional Search Settings - only shown when selected */}
      {isTraditional && (
        <div className="row mb-3">
          <div className="col-md-12">
            <h5>{t("TraditionalSearchSettings")}</h5>
            <div className="form-check">
              <input
                className="form-check-input"
                type="checkbox"
                id="enableSimilarTextSearch"
                checked={settings.useTextSimilarities}
                onChange={(e) => updateSetting("useTextSimilarities", e.target.checked)}
              />
              <label className="form-check-label" htmlFor="enableSimilarTextSearch">
                {t("EnableSimilarTextSearch")}
              </label>
              <small className="form-text text-muted d-block">{t("EnableSimilarTextSearchHint")}</small>
            </div>
            <div className="form-check">
              <input
                className="form-check-input"
                type="checkbox"
                id="traditionalSearchCaseSensitive"
                checked={settings.traditionalSearchCaseSensitive ?? false}
                onChange={(e) => updateSetting("traditionalSearchCaseSensitive", e.target.checked)}
              />
              <label className="form-check-label" htmlFor="traditionalSearchCaseSensitive">
                {t("CaseSensitiveSearch")}
              </label>
            </div>
            <div className="form-check">
              <input
                className="form-check-input"
                type="checkbox"
                id="traditionalSearchWholeWords"
                checked={settings.traditionalSearchWholeWords ?? false}
                onChange={(e) => updateSetting("traditionalSearchWholeWords", e.target.checked)}
              />
              <label className="form-check-label" htmlFor="traditionalSearchWholeWords">
                {t("MatchWholeWordsOnly")}
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Typesense Settings - only shown when selected */}
      {isTypesense && (
        <div className="row mb-3">
          <div className="col-md-12">
            <h5>{t("TypesenseSettings")}</h5>

            <div className="form-group mb-2">
              <label htmlFor="typesenseUrl">{t("TypesenseUrl")}</label>
              <input
                type="url"
                className="form-control"
                id="typesenseUrl"
                placeholder="http://127.0.0.1:8108"
                value={settings.typesenseUrl ?? ""}
                onChange={(e) => updateSetting("typesenseUrl", e.target.value)}
              />
              <small className="form-text text-muted">{t("TypesenseUrlHint")}</small>
            </div>

            <div className="form-group mb-3">
              <label htmlFor="typesenseApiKey">{t("TypesenseApiKey")}</label>
              <input
                type="text"
                className="form-control"
                id="typesenseApiKey"
                placeholder={t("TypesenseApiKeyPlaceholder")}
                value={settings.typesenseApiKey ?? ""}
                onChange={(e) => updateSetting("typesenseApiKey", e.target.value)}
              />
              <small className="form-text text-muted">{t("TypesenseApiKeyHint")}</small>
            </div>

            <div className="d-flex align-items-center gap-2 mb-3">
              <button
                className="btn btn-outline-secondary"
                onClick={testConnection}
                disabled={testState === "testing" || !settings.typesenseUrl || !settings.typesenseApiKey}
              >
                {testState === "testing" && <span className="spinner-border spinner-border-sm me-1" role="status" />}
                {testState === "testing" ? t("TypesenseTestTesting") : t("TypesenseTestButton")}
              </button>
              {testState === "ok" && <span className="text-success fw-bold">{t("TypesenseTestSuccess")}</span>}
              {testState === "error" && <span className="text-danger">{testError || t("TypesenseTestFailed")}</span>}
            </div>

            <div className="card bg-light border-secondary mt-3">
              <div className="card-body">
                <h6 className="card-title">{t("TypesenseSetupGuide")}</h6>
                {platform === "windows" ? (
                  <div>
                    <p className="mb-1">{t("TypesenseSetupWindows")}</p>
                    <code className="d-block bg-dark text-light p-2 rounded small mb-2">
                      docker run -p 8108:8108 -v typesense-data:/data typesense/typesense:27.1 --data-dir /data --api-key=
                      {settings.typesenseApiKey || "your_api_key"}
                    </code>
                  </div>
                ) : platform === "macos" ? (
                  <div>
                    <p className="mb-1">{t("TypesenseSetupMac")}</p>
                    <code className="d-block bg-dark text-light p-2 rounded small mb-2">
                      brew install typesense/tap/typesense-server
                      <br />
                      typesense-server --data-dir=/tmp/typesense-data --api-key={settings.typesenseApiKey || "your_api_key"}
                    </code>
                  </div>
                ) : (
                  <div>
                    <p className="mb-1">{t("TypesenseSetupLinux")}</p>
                    <code className="d-block bg-dark text-light p-2 rounded small mb-2">
                      docker run -p 8108:8108 -v typesense-data:/data typesense/typesense:27.1 --data-dir /data --api-key=
                      {settings.typesenseApiKey || "your_api_key"}
                    </code>
                  </div>
                )}
                <small className="text-muted">
                  {t("TypesenseMoreInfo")}{" "}
                  <a href="https://typesense.org/docs/guide/install-typesense.html" target="_blank" rel="noopener noreferrer">
                    typesense.org
                  </a>
                </small>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SearchingSettings;
