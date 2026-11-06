import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocalization } from "../localization/LocalizationContext";
import "./MessageBox.css";

interface MessageBoxProps {
  title?: string;
  message: string;
  onConfirm: () => void;
  onNo?: () => void;
  onCancel?: () => void;
  confirmText?: string;
  noText?: string;
  cancelText?: string;
  showCancel?: boolean;
  /** When true the confirm button is styled as a danger (red) button */
  confirmDanger?: boolean;
}

const STACKED_CLASS = "messagebox-footer--stacked";

const MessageBox: React.FC<MessageBoxProps> = ({
  title,
  message,
  onConfirm,
  onNo,
  onCancel,
  confirmText,
  noText,
  cancelText,
  showCancel = true,
  confirmDanger,
}) => {
  const { t } = useLocalization();

  // Use localized defaults if not provided
  const displayTitle = title || t("Confirm");
  const displayConfirmText = confirmText || (onNo ? t("Yes") : t("OK"));
  const displayNoText = noText || t("No");
  const displayCancelText = cancelText || t("Cancel");

  const showCancelButton = !!onCancel && showCancel;
  const showNoButton = !!onNo;

  const footerRef = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);

  // Stack the buttons vertically when they don't fit on one row. Plain flex-wrap
  // split three slightly-too-long localized labels 2+1, orphaning the primary
  // button on its own line. Whether the row fits depends on the label lengths,
  // so it is measured rather than guessed with a breakpoint.
  useLayoutEffect(() => {
    const footer = footerRef.current;
    if (!footer) return;
    const update = () => {
      // Measure the single-row form: drop the stacked class just for this
      // synchronous measurement (nothing is painted in between). Unstacked, the
      // buttons keep their natural widths and the dialog grows to its max width
      // for the row, which is exactly what has to be compared.
      const wasStacked = footer.classList.contains(STACKED_CLASS);
      if (wasStacked) footer.classList.remove(STACKED_CLASS);
      const style = getComputedStyle(footer);
      const buttons = Array.from(footer.children) as HTMLElement[];
      const gap = parseFloat(style.columnGap) || 0;
      const needed = buttons.reduce((sum, button) => sum + button.getBoundingClientRect().width, 0) + gap * Math.max(0, buttons.length - 1);
      const available =
        footer.getBoundingClientRect().width -
        (parseFloat(style.paddingLeft) || 0) -
        (parseFloat(style.paddingRight) || 0) -
        (parseFloat(style.borderLeftWidth) || 0) -
        (parseFloat(style.borderRightWidth) || 0);
      if (wasStacked) footer.classList.add(STACKED_CLASS);
      setStacked(needed > available + 0.5);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [displayCancelText, displayNoText, displayConfirmText, showCancelButton, showNoButton]);

  // Portalled to document.body so confirms/alerts stay visible even when the host
  // tree is hidden (e.g. while the embedded client view is shown and a delegated
  // DBSync confirm fires). Fixed-position overlay, so the body mount is safe.
  return createPortal(
    <div className="messagebox-overlay">
      <div className="messagebox-container" onClick={(e) => e.stopPropagation()}>
        <div className="messagebox-header">
          <h5 className="messagebox-title">{displayTitle}</h5>
        </div>
        <div className="messagebox-body">
          <p>{message}</p>
        </div>
        <div ref={footerRef} className={stacked ? `messagebox-footer ${STACKED_CLASS}` : "messagebox-footer"}>
          {showCancelButton && (
            <button className="btn btn-secondary" onClick={onCancel}>
              {displayCancelText}
            </button>
          )}
          {showNoButton && (
            <button className="btn btn-outline-secondary" onClick={onNo}>
              {displayNoText}
            </button>
          )}
          <button className={confirmDanger ? "btn btn-danger" : "btn btn-primary"} onClick={onConfirm} autoFocus>
            {displayConfirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default MessageBox;
