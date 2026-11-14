import { useEffect, useRef, useState, type ReactNode } from "react";
import { databaseStorage, type StorageMode, type StoragePolicy } from "../../db-common/DatabaseStorage";
import { useLocalization } from "../localization/LocalizationContext";
import { FileSaveUnsupportedError, saveGeneratedFile } from "../services/fileSave";
import { prepareStorageForThisRuntime, storageRuntimePolicy } from "../services/storageRuntime";
import "./StorageChoiceGate.css";

/** Saves every stored database row unchanged, for when the app cannot start. */
async function saveRecoveryFile(): Promise<boolean> {
  const fileName = `pp-storage-recovery-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
  const text = await databaseStorage.exportRecoveryData();
  return (await saveGeneratedFile(new Blob([text], { type: "application/json" }), fileName)) === "saved";
}

/** Offered whenever the gate reports an error: the user can keep their data
 * even if neither a retry nor a choice succeeds. */
function RecoveryExport() {
  const { t } = useLocalization();
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed" | "unsupported">("idle");
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
              setState(reason instanceof FileSaveUnsupportedError ? "unsupported" : "failed");
            });
        }}
      >
        {t("StorageRecoveryExport")}
      </button>
      {state === "saved" && <p role="status">{t("StorageRecoveryExportDone")}</p>}
      {state === "failed" && <p role="alert">{t("StorageRecoveryExportFailed")}</p>}
      {state === "unsupported" && <p role="alert">{t("FileSaveUnsupported")}</p>}
    </div>
  );
}

/** Keep all database consumers unmounted until the storage format is settled as
 * the runtime's policy says (Electron consent, automatic conversion or the old
 * format kept without asking), including resumable cleanup. */
export function StorageChoiceGate({ children }: { children: ReactNode }) {
  const { t } = useLocalization();
  const hasHostDevice = !!window.hostDevice;
  // Null until a native host's policy is known (it reads the stored format first).
  const [policy, setPolicy] = useState<StoragePolicy | null>(hasHostDevice ? null : "automatic");
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
    let current: StoragePolicy | null = null;
    const prepare = async () => {
      current = await storageRuntimePolicy();
      if (active) setPolicy(current);
      return prepareStorageForThisRuntime(current);
    };
    prepare()
      .then((choice) => {
        if (active) setStatus(choice ? "ready" : "choose");
      })
      .catch((reason) => {
        console.error("Storage choice", reason);
        if (active) {
          setError(true);
          // Only the explicit-choice runtime may offer the formats.
          setStatus(current === "choice" ? "choose" : "failed");
        }
      });
    return () => {
      active = false;
    };
  }, [hasHostDevice, attempt]);
  useEffect(() => {
    // Only Electron reaches the dialog: Android never asks, so an Android trial
    // bundle is promoted by the application's own successful start.
    if (status === "choose") heading.current?.focus();
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
        <p role="alert">{t(policy === "automatic" ? "StorageAutoMigrationError" : "StorageSetupError")}</p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setError(false);
            setStatus("checking");
            setAttempt((value) => value + 1);
          }}
        >
          {t(policy === "automatic" ? "StorageAutoMigrationRetry" : "StorageSetupRetry")}
        </button>
        <RecoveryExport />
      </div>
    );
  }
  if (status === "checking")
    return (
      <div className="storage-choice-loading" role="status">
        {t(policy === "automatic" ? "StorageAutoMigrationProgress" : "StorageChoiceChecking")}
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
