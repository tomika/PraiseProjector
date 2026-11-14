import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { databaseStorage, type StorageMode, type StoragePolicy } from "../../db-common/DatabaseStorage";
import { useLocalization, type StringKey } from "../localization/LocalizationContext";
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

/** What the user has to acknowledge before each format is applied. */
const acknowledgments: Record<StorageMode, StringKey[]> = {
  partitioned: ["StorageChoiceBackup", "StorageChoiceDowngrade"],
  legacy: ["StorageChoiceBackup", "StorageChoiceEnergy", "StorageChoiceWear"],
};

/** Keeps Tab inside one dialog; the heading counts as the first stop. */
function trapFocus(event: ReactKeyboardEvent<HTMLElement>, heading: HTMLElement | null) {
  if (event.key !== "Tab") return;
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("input:not(:disabled),button:not(:disabled)")];
  if (!controls.length) {
    event.preventDefault();
    return;
  }
  const first = controls[0],
    last = controls[controls.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === heading)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/** Positive "new feature" mark: a database with a spark, not a warning sign. */
function UpgradeIcon() {
  return (
    <svg className="storage-choice-icon" viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="storage-choice-icon-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2563eb" />
          <stop offset="1" stopColor="#0d9488" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill="url(#storage-choice-icon-bg)" />
      <g fill="none" stroke="#fff" strokeWidth="3.2" strokeLinejoin="round">
        <ellipse cx="29" cy="20" rx="13" ry="5" />
        <path d="M16 20v24c0 2.8 5.8 5 13 5s13-2.2 13-5V20" />
        <path d="M16 32c0 2.8 5.8 5 13 5s13-2.2 13-5" />
      </g>
      <path d="M50 8l2.2 5.8L58 16l-5.8 2.2L50 24l-2.2-5.8L42 16l5.8-2.2Z" fill="#fde68a" />
    </svg>
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
  // The format whose confirmation dialog is open, and what has been ticked there.
  const [pending, setPending] = useState<StorageMode | null>(null);
  const [checked, setChecked] = useState<StringKey[]>([]);
  // Startup check failure (shown on the main panel) vs. a failed confirmation.
  const [prepareError, setPrepareError] = useState(false);
  const [chooseError, setChooseError] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const mainDialog = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
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
          setPrepareError(true);
          // Only the explicit-choice runtime may offer the formats.
          setStatus(current === "choice" ? "choose" : "failed");
        }
      });
    return () => {
      active = false;
    };
  }, [hasHostDevice, attempt]);

  // Only Electron reaches the dialog: Android never asks, so an Android trial
  // bundle is promoted by the application's own successful start.
  const dialogOpen = status === "choose" || status === "saving";
  useEffect(() => {
    if (!dialogOpen) return;
    if (pending) confirmHeading.current?.focus();
    else heading.current?.focus();
  }, [dialogOpen, pending]);
  useEffect(() => {
    // The main panel stays visible under the confirmation but cannot be reached.
    if (mainDialog.current) mainDialog.current.inert = !!pending;
  }, [pending, dialogOpen]);

  const openConfirmation = (mode: StorageMode, button: HTMLButtonElement) => {
    opener.current = button;
    setChecked([]);
    setChooseError(false);
    setPending(mode);
  };
  const closeConfirmation = () => {
    if (busy.current) return;
    setPending(null);
    setChooseError(false);
    const button = opener.current;
    // Focus returns to the option that was chosen once the main panel is interactive again.
    setTimeout(() => button?.focus(), 0);
  };

  const choose = async (mode: StorageMode) => {
    if (busy.current || !acknowledgments[mode].every((key) => checked.includes(key))) return;
    busy.current = true;
    setStatus("saving");
    setChooseError(false);
    try {
      await databaseStorage.choose(mode);
      setStatus("ready");
    } catch (reason) {
      console.error("Storage choice", reason);
      setChooseError(true);
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
            setPrepareError(false);
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
  const required = pending ? acknowledgments[pending] : [];
  const complete = required.every((key) => checked.includes(key));
  return (
    <div className="modal-backdrop show storage-choice-backdrop">
      <div
        ref={mainDialog}
        className="modal d-block"
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-choice-title"
        aria-describedby="storage-choice-intro"
        aria-hidden={pending ? true : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
          }
          trapFocus(event, heading.current);
        }}
      >
        <section className="storage-choice-panel">
          <header>
            <UpgradeIcon />
            <div>
              <span className="storage-choice-eyebrow">{t("StorageChoiceEyebrow")}</span>
              <h1 id="storage-choice-title" ref={heading} tabIndex={-1}>
                {t("StorageChoiceTitle")}
              </h1>
            </div>
          </header>
          <p id="storage-choice-intro" className="storage-choice-intro">
            {t("StorageChoiceIntro")}
          </p>
          <div className="storage-choice-options">
            <article className="storage-choice-option storage-choice-option-new">
              <h2>
                {t("StorageChoiceNewTitle")}
                <span className="storage-choice-badge">{t("StorageChoiceRecommended")}</span>
              </h2>
              <p>{t("StorageChoiceNewDescription")}</p>
              <p className="storage-choice-note">{t("StorageChoiceCompatibility")}</p>
              <button
                type="button"
                className="btn btn-primary storage-choice-action"
                data-mode="partitioned"
                onClick={(event) => openConfirmation("partitioned", event.currentTarget)}
              >
                {t("StorageChoiceNewAction")}
              </button>
            </article>
            <article className="storage-choice-option storage-choice-option-old">
              <h2>{t("StorageChoiceOldTitle")}</h2>
              <p>{t("StorageChoiceOldDescription")}</p>
              <button
                type="button"
                className="btn btn-outline-secondary storage-choice-action"
                data-mode="legacy"
                onClick={(event) => openConfirmation("legacy", event.currentTarget)}
              >
                {t("StorageChoiceOldAction")}
              </button>
            </article>
          </div>
          {prepareError && !pending && (
            <>
              <p role="alert" className="storage-choice-error">
                {t("StorageChoiceError")}
              </p>
              <RecoveryExport />
            </>
          )}
        </section>
      </div>
      {pending && (
        <div
          className="modal d-block storage-choice-confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="storage-choice-confirm-title"
          aria-describedby="storage-choice-confirm-intro"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeConfirmation();
            }
            trapFocus(event, confirmHeading.current);
          }}
        >
          <section className={`storage-choice-panel storage-choice-confirm-panel storage-choice-confirm-${pending}`} aria-busy={saving}>
            <h1 id="storage-choice-confirm-title" ref={confirmHeading} tabIndex={-1}>
              {t(pending === "partitioned" ? "StorageChoiceConfirmNewTitle" : "StorageChoiceConfirmOldTitle")}
            </h1>
            <p id="storage-choice-confirm-intro">{t("StorageChoiceConfirmIntro")}</p>
            <div className="storage-choice-acknowledgments">
              {required.map((key) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={checked.includes(key)}
                    disabled={saving}
                    onChange={(event) => {
                      const on = event.target.checked;
                      setChecked((list) => (on ? [...list, key] : list.filter((item) => item !== key)));
                    }}
                  />
                  <span>{t(key)}</span>
                </label>
              ))}
            </div>
            {saving && (
              <p role="status" className="storage-choice-status">
                {t("StorageChoiceSaving")}
              </p>
            )}
            {chooseError && (
              <>
                <p role="alert" className="storage-choice-error">
                  {t("StorageChoiceError")}
                </p>
                {!saving && <RecoveryExport />}
              </>
            )}
            <div className="storage-choice-confirm-actions">
              <button type="button" className="btn btn-outline-secondary" disabled={saving} onClick={closeConfirmation}>
                {t("StorageChoiceBack")}
              </button>
              <button
                type="button"
                className="btn btn-primary storage-choice-confirm-action"
                disabled={saving || !complete}
                onClick={() => void choose(pending)}
              >
                {t(pending === "partitioned" ? "StorageChoiceConfirmNew" : "StorageChoiceConfirmOld")}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
