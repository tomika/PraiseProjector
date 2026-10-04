import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface Props {
  title: string;
  closeLabel: string;
  className: string;
  onClose(): void;
  children: ReactNode;
  footer: ReactNode;
}

/**
 * Modal shell of the hardware settings dialogs. Portaled to <body> so it opens
 * centered over the settings dialog (not at the end of a scrolled tab), closes
 * on Escape / outside click and gives focus back to the control that opened it.
 */
export function HardwareDialog({ title, closeLabel, className, onClose, children, footer }: Props) {
  const titleId = useId();
  const opener = useRef<Element | null>(document.activeElement);
  useEffect(() => {
    const previous = opener.current as HTMLElement | null;
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const closeOnOutside = (event: React.MouseEvent) => {
    if (event.target === event.currentTarget) onClose();
  };
  return createPortal(
    <div className="modal-backdrop show hw-dialog-backdrop" onMouseDown={closeOnOutside}>
      <div
        className="modal d-block"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={closeOnOutside}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
      >
        <div className={`modal-dialog modal-dialog-centered modal-dialog-scrollable ${className}`}>
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title" id={titleId}>
                {title}
              </h5>
              <button type="button" className="btn-close" aria-label={closeLabel} onClick={onClose} />
            </div>
            <div className="modal-body">{children}</div>
            <div className="modal-footer">{footer}</div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
