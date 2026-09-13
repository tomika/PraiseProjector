/**
 * TextConfirmDialog — a plain yes/no question with localized text.
 *
 * The legacy {@link ConfirmDialog} carries its message as an animated SVG, so it
 * can only ask the handful of questions those assets exist for. This one is for
 * wording that has no animation (leaving the view with unfinished edits), and is
 * driven by the store's `confirmText` state plus a promise resolved by
 * `resolveTextConfirm` — so callers can `await store.confirmMessage(…)`.
 *
 * OK resolves true; Cancel, a backdrop click, or Esc resolve false (Enter = OK).
 */

import { useEffect } from "react";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { useLocalization } from "../../localization/LocalizationContext";

export function TextConfirmDialog() {
  const store = useClientViewStore();
  const state = useClientViewState();
  const { t } = useLocalization();
  const request = state.confirmText;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        store.resolveTextConfirm(false);
        return;
      }
      if (e.key !== "Enter") return;
      // A focused button answers for itself (Enter fires its click). Swallowing
      // the key here would confirm even while Cancel holds the focus — and this
      // dialog guards unsaved work, so that answer is the destructive one.
      if (document.activeElement instanceof HTMLButtonElement) return;
      e.preventDefault();
      store.resolveTextConfirm(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [store]);

  if (!request) return null;

  return (
    <div className="cv-modal-backdrop" onClick={() => store.resolveTextConfirm(false)}>
      <div className="cv-dialog cv-text-confirm-dialog" role="alertdialog" aria-label={t(request.titleKey)} onClick={(e) => e.stopPropagation()}>
        <div className="cv-dialog-title">{t(request.titleKey)}</div>
        <div className="cv-text-confirm-message">{t(request.messageKey)}</div>
        <div className="cv-dialog-actions">
          <button type="button" className="cv-dialog-cancel" onClick={() => store.resolveTextConfirm(false)}>
            {t("Cancel")}
          </button>
          <button type="button" className="cv-dialog-ok" autoFocus onClick={() => store.resolveTextConfirm(true)}>
            {t("Continue")}
          </button>
        </div>
      </div>
    </div>
  );
}
