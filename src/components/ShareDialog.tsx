import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { QRCodeSVG } from "qrcode.react";
import { useLocalization } from "../localization/LocalizationContext";
import { registerShareDialogOpener, ShareDialogRequest } from "../services/shareDialogBridge";
import "./ShareDialog.css";

interface ShareDialogProps {
  request: ShareDialogRequest;
  onClose: () => void;
}

/**
 * In-app share dialog: a QR code plus a copyable link. Shown when no native share sheet is
 * available (Electron desktop, or a desktop browser without the Web Share API). Opened imperatively
 * via {@link registerShareDialogOpener} / openShareDialog so `shareService` can trigger it.
 */
const ShareDialog: React.FC<ShareDialogProps> = ({ request, onClose }) => {
  const { t } = useLocalization();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(request.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      console.warn("ShareDialog", "Failed to copy link", error);
    }
  };

  const closeLabel = t("Close");

  const dialog = (
    <div className="share-dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="share-dialog" role="dialog" aria-modal="true" aria-label={request.title} onClick={(e) => e.stopPropagation()}>
        <div className="share-dialog-head">
          <div className="share-dialog-title" title={request.title}>
            {request.title}
          </div>
          <button type="button" className="share-dialog-close" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
        <div className="share-dialog-code">
          <QRCodeSVG value={request.url} size={240} level="M" includeMargin />
        </div>
        <div className="share-dialog-hint">{t("ShareDialogScanHint")}</div>
        <div className="share-dialog-link-row">
          <input
            className="share-dialog-link"
            type="text"
            readOnly
            value={request.url}
            aria-label={request.url}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button type="button" className="share-dialog-copy" onClick={() => void copyLink()}>
            {copied ? t("ShareDialogCopied") : t("ShareDialogCopyLink")}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(dialog, document.body) : dialog;
};

/** Mount once (in App). Listens for openShareDialog() calls and renders the dialog. */
export const ShareDialogHost: React.FC = () => {
  const [request, setRequest] = useState<ShareDialogRequest | null>(null);
  useEffect(() => registerShareDialogOpener((r) => setRequest(r)), []);
  if (!request) return null;
  return <ShareDialog request={request} onClose={() => setRequest(null)} />;
};

export default ShareDialog;
