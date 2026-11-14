import { useEffect, useRef, useState, type ReactNode } from "react";
import { databaseStorage, type StorageMode } from "../../db-common/DatabaseStorage";
import { useLocalization } from "../localization/LocalizationContext";
import { reportPageLoadedSuccessfully } from "../services/webAppLaunchReport";
import { isAutomaticStorageRuntime, prepareStorageForThisRuntime } from "../services/storageRuntime";
import "./StorageChoiceGate.css";

/** Saves every stored database row unchanged, for when the app cannot start. */
async function saveRecoveryFile(): Promise<boolean> {
  const fileName = `pp-storage-recovery-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
  const text = await databaseStorage.exportRecoveryData();
  if (window.electronAPI?.saveDatabaseFile) {
    const bytes = new TextEncoder().encode(text);
    const result = await window.electronAPI.saveDatabaseFile(bytes.buffer as ArrayBuffer, fileName);
    if (!result.success && result.error !== "Cancelled") throw new Error(result.error ?? "Save failed");
    return result.success;
  }
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

/** Offered whenever the gate reports an error: the user can keep their data
 * even if neither a retry nor a choice succeeds. */
function RecoveryExport() {
  const { t } = useLocalization();
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  return (
    <div className="storage-choice-recovery">
      <button
        type="button"
        className="btn btn-outline-secondary"
        disabled={state === "saving"}
        onClick={() => {
          setState("saving");
          saveRecoveryFile()
            .then((saved) => setState(saved ? "saved" : "idle"))
            .catch((reason) => {
              console.error("Storage recovery export", reason);
              setState("failed");
            });
        }}
      >
        {t("StorageRecoveryExport")}
      </button>
      {state === "saved" && <p role="status">{t("StorageRecoveryExportDone")}</p>}
      {state === "failed" && <p role="alert">{t("StorageRecoveryExportFailed")}</p>}
    </div>
  );
}

/** Keep all database consumers unmounted until native consent or automatic PWA
 * conversion completes, including resumable cleanup. */
export function StorageChoiceGate({ children }: { children: ReactNode }) {
  const { t } = useLocalization();
  const hasHostDevice = !!window.hostDevice;
  const [automaticMigration, setAutomaticMigration] = useState(!hasHostDevice);
  const [status, setStatus] = useState<"checking" | "choose" | "saving" | "ready" | "failed">("checking");
  const [attempt, setAttempt] = useState(0);
  const [backup, setBackup] = useState(false);
  const [downgrade, setDowngrade] = useState(false);
  const [energy, setEnergy] = useState(false);
  const [wear, setWear] = useState(false);
  const [error, setError] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (status === "ready") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [status]);

  useEffect(() => {
    let active = true;
    let automatic = !hasHostDevice;
    const prepare = async () => {
      automatic = await isAutomaticStorageRuntime();
      if (active) setAutomaticMigration(automatic);
      return prepareStorageForThisRuntime(automatic);
    };
    prepare()
      .then((choice) => {
        if (active) setStatus(choice ? "ready" : "choose");
      })
      .catch((reason) => {
        console.error("Storage choice", reason);
        if (active) {
          setError(true);
          setStatus(automatic ? "failed" : "choose");
        }
      });
    return () => {
      active = false;
    };
  }, [hasHostDevice, attempt]);
  useEffect(() => {
    if (status === "choose") {
      heading.current?.focus();
      // Waiting for this mandatory decision is a healthy Android bundle launch,
      // not a failed trial that should revert to the factory/previous bundle.
      reportPageLoadedSuccessfully();
    }
  }, [status]);

  const choose = async (mode: StorageMode) => {
    if (busy.current || !backup || (mode === "partitioned" ? !downgrade : !energy || !wear)) return;
    busy.current = true;
    setStatus("saving");
    setError(false);
    try {
      await databaseStorage.choose(mode);
      setStatus("ready");
    } catch (reason) {
      console.error("Storage choice", reason);
      setError(true);
      setStatus("choose");
    } finally {
      busy.current = false;
    }
  };

  if (status === "ready") return <>{children}</>;
  if (status === "failed") {
    return (
      <div className="storage-choice-loading">
        <p role="alert">{t("StorageAutoMigrationError")}</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setError(false);
            setStatus("checking");
            setAttempt((value) => value + 1);
          }}
        >
          {t("StorageAutoMigrationRetry")}
        </button>
        <RecoveryExport />
      </div>
    );
  }
  if (status === "checking")
    return (
      <div className="storage-choice-loading" role="status">
        {t(automaticMigration ? "StorageAutoMigrationProgress" : "StorageChoiceChecking")}
      </div>
    );
  const saving = status === "saving";
  return (
    <div className="modal-backdrop show storage-choice-backdrop">
      <div
        className="modal d-block"
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-choice-title"
        aria-describedby="storage-choice-intro"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
          }
          if (event.key === "Tab") {
            const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("input:not(:disabled),button:not(:disabled)")];
            const first = controls[0],
              last = controls[controls.length - 1];
            if (!controls.length) {
              event.preventDefault();
              return;
            }
            if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <section className="storage-choice-panel" aria-busy={saving}>
          <header>
            <svg className="storage-choice-warning" viewBox="0 0 100 90" aria-hidden="true">
              <path d="M50 4 97 86H3Z" fill="#dc2626" />
              <path d="M50 28v28" stroke="white" strokeWidth="8" strokeLinecap="round" />
              <circle cx="50" cy="71" r="5" fill="white" />
            </svg>
            <h1 id="storage-choice-title" ref={heading} tabIndex={-1}>
              {t("StorageChoiceTitle")}
            </h1>
          </header>
          <div id="storage-choice-intro" className="storage-choice-explanation">
            <p>{t("StorageChoiceIntro")}</p>
            <p>{t("StorageChoiceNewDescription")}</p>
            <p>{t("StorageChoiceCompatibility")}</p>
            <p>{t("StorageChoiceOldDescription")}</p>
          </div>
          <div className="storage-choice-acknowledgments">
            <label>
              <input type="checkbox" checked={backup} disabled={saving} onChange={(e) => setBackup(e.target.checked)} />
              <span>{t("StorageChoiceBackup")}</span>
            </label>
            <label>
              <input type="checkbox" checked={downgrade} disabled={saving} onChange={(e) => setDowngrade(e.target.checked)} />
              <span>{t("StorageChoiceDowngrade")}</span>
            </label>
            <label>
              <input type="checkbox" checked={energy} disabled={saving} onChange={(e) => setEnergy(e.target.checked)} />
              <span>{t("StorageChoiceEnergy")}</span>
            </label>
            <label>
              <input type="checkbox" checked={wear} disabled={saving} onChange={(e) => setWear(e.target.checked)} />
              <span>{t("StorageChoiceWear")}</span>
            </label>
          </div>
          <div className="storage-choice-actions">
            <button
              type="button"
              className="btn storage-choice-action"
              disabled={saving || !backup || !downgrade}
              onClick={() => void choose("partitioned")}
            >
              {t("StorageChoiceNewAction")}
            </button>
            <button
              type="button"
              className="btn storage-choice-action"
              disabled={saving || !backup || !energy || !wear}
              onClick={() => void choose("legacy")}
            >
              {t("StorageChoiceOldAction")}
            </button>
          </div>
          {saving && (
            <p role="status" className="storage-choice-status">
              {t("StorageChoiceSaving")}
            </p>
          )}
          {error && (
            <>
              <p role="alert" className="storage-choice-error">
                {t("StorageChoiceError")}
              </p>
              {!saving && <RecoveryExport />}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
