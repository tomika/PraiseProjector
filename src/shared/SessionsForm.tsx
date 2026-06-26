/**
 * SessionsForm — the single, shared session-discovery/host panel used by BOTH the
 * Electron desktop GUI and the client-view (mirrors the <InstructionsEditor>
 * pattern).
 *
 * It owns the presentation: the discovered-session list (each row carries a
 * connect/plug action), the always-visible scan-address picker (an editable combo
 * box), a scan-in-progress indicator and the start-online-session control.
 * Everything data-shaped is injected via props so each host supplies its own
 * wiring:
 *   - `variant` selects the CSS skin ("desktop" base look vs the "cv" reskin
 *     applied through the `.sessions-form--cv` modifier);
 *   - the session list, per-row connect handler and scan-address state are passed
 *     in — the desktop wrapper feeds them from cloudApi/hostDevicePpd, the
 *     client-view wrapper from its ClientApi store.
 *
 * IMPORTANT: this component must stay free of Electron imports so the client-view
 * bundle served by the webserver can include it. Localization is injected via
 * props rather than imported.
 */

import { useEffect, useRef, useState } from "react";
import "./SessionsForm.css";

/** The three discovered-session kinds shown in the type column. */
export type SessionKind = "ppd" | "webclient" | "online";

/** Type-column glyph per kind: nearby PPD broadcast, a LAN web client, the cloud. */
export const KIND_ICON: Record<SessionKind, string> = {
  ppd: "🛜",
  webclient: "💻",
  online: "🌐",
};

/**
 * Classify an online-list entry by its `localUrl`, mirroring the legacy
 * sessionType switch: no localUrl → a cloud (online) session; an nrb://|udp:// URL
 * → a nearby PPD peer; any other (http(s)) URL → a LAN web client.
 */
export function classifyOnlineSession(localUrl?: string): SessionKind {
  if (!localUrl) return "online";
  if (localUrl.startsWith("nrb://") || localUrl.startsWith("udp://")) return "ppd";
  return "webclient";
}

export interface SessionRow {
  id: string;
  name: string;
  kind: SessionKind;
}

export interface SessionsFormStartOnline {
  label: string;
  title?: string;
  starting?: boolean;
  onStart: () => void;
}

export interface SessionsFormDetails {
  addressLabel: string;
  resetLabel: string;
  address: string;
  addressError: boolean;
  /** Selectable scan addresses ({ value, label }) for the picker dropdown. */
  addressOptions: { value: string; label: string }[];
  /** Placeholder shown in the picker when the typed address isn't one of the options. */
  pickLabel: string;
  onAddressChange: (value: string) => void;
  onResetAddress: () => void;
}

export interface SessionsFormProps {
  /** Selects the CSS skin: desktop base styling or the client-view reskin. */
  variant: "desktop" | "cv";
  /** Controlled dark flag (cv passes its own; desktop derives it from data-theme
   *  so it may leave this unset). */
  isDark?: boolean;
  /** Accessible name for the dialog (no visible title bar is rendered). */
  title: string;
  emptyLabel: string;

  sessions: SessionRow[];
  /** Per-row connect/attach action (the plug button at the end of each row). */
  onConnect: (id: string) => void;
  /** Accessible label/tooltip for the per-row connect button. */
  connectLabel: string;

  /** Whether a discovery scan is currently in flight (shows the scan indicator). */
  scanning?: boolean;
  /** URL of the radar.svg indicator icon (resolved per host). */
  scanIcon: string;

  /** Shown above the list when local discovery is unavailable (e.g. web mode). */
  webModeNotice?: string | null;

  /** Always-visible broadcast-address picker. Omit to hide it (no local transport). */
  details?: SessionsFormDetails;

  /** Start-online-session control. Omit to hide it. */
  startOnline?: SessionsFormStartOnline;

  closeLabel: string;
  onClose: () => void;

  /** The "switch to the other UI" button (desktop → client-view). Omit to hide. */
  switchUi?: { label: string; onClick: () => void };
}

export function SessionsForm({
  variant,
  isDark = false,
  title,
  emptyLabel,
  sessions,
  onConnect,
  connectLabel,
  scanning = false,
  scanIcon,
  webModeNotice,
  details,
  startOnline,
  closeLabel,
  onClose,
  switchUi,
}: SessionsFormProps) {
  const cvModifier = variant === "cv" ? " sessions-form--cv" : "";
  const darkClass = isDark ? " dark" : "";

  // Address-picker dropdown. It is position:fixed (measured from the input) so it
  // escapes the dialog's overflow clipping and can spill outside the dialog.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dropPos, setDropPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const measure = () => {
      const rect = pickerRef.current?.getBoundingClientRect();
      if (rect) setDropPos({ top: rect.bottom + 2, left: rect.left, width: rect.width });
    };
    measure();
    const onPointerDown = (event: PointerEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", measure);
    // Capture phase so scrolling ANY ancestor (the dialog body) re-aligns the list.
    window.addEventListener("scroll", measure, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [pickerOpen]);

  return (
    <div className={`sessions-modal-backdrop sessions-form${cvModifier}${darkClass}`} onClick={onClose}>
      <div className="sessions-modal-dialog" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        {/* Header-less control strip: just the close button (right). */}
        <div className="sessions-topbar">
          <button type="button" className="sessions-close" onClick={onClose} title={closeLabel} aria-label={closeLabel}>
            <span aria-hidden="true">&times;</span>
          </button>
        </div>

        <div className="sessions-modal-body">
          {webModeNotice ? (
            <div className="alert alert-info py-2 mb-2 sessions-web-notice" role="alert">
              <small>{webModeNotice}</small>
            </div>
          ) : null}

          <div className="sessions-list-row">
            <div className={`sessions-scan${scanning ? " is-scanning" : ""}`}>
              <img src={scanIcon} alt="Scanning…" title="Scanning…" />
            </div>
            <div className="sessions-list-container">
              <table className="table table-hover sessions-table">
                <tbody>
                  {sessions.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="text-muted text-center sessions-empty">
                        {emptyLabel}
                      </td>
                    </tr>
                  ) : (
                    sessions.map((session) => (
                      <tr key={session.id}>
                        <td className="session-type-icon" title={session.kind}>
                          {KIND_ICON[session.kind]}
                        </td>
                        <td>{session.name}</td>
                        <td className="session-connect-col">
                          <button
                            type="button"
                            className="sessions-row-connect"
                            onClick={() => onConnect(session.id)}
                            title={connectLabel}
                            aria-label={connectLabel}
                          >
                            🔌
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {details ? (
            <div className="details-section">
              <div className="sessions-addr-row">
                <label htmlFor="broadcast-address" className="sessions-addr-label">
                  {details.addressLabel}
                </label>
                {/* Editable address (free text) with a drop button at its bottom-right
                    that opens a list of interfaces UNDER the input (a native <select>'s
                    list sits beside the field; a <datalist> hides options behind the
                    current value — both rejected for this layout). */}
                <div className="sessions-addr-combo" ref={pickerRef}>
                  <input
                    id="broadcast-address"
                    type="text"
                    className={`sessions-addr-input ${details.addressError ? "is-invalid" : ""}`}
                    value={details.address}
                    onChange={(e) => details.onAddressChange(e.target.value)}
                  />
                  <button
                    type="button"
                    className="sessions-addr-drop"
                    aria-label={details.pickLabel}
                    title={details.pickLabel}
                    disabled={details.addressOptions.length === 0}
                    onClick={() => setPickerOpen((v) => !v)}
                  >
                    <span aria-hidden="true">▾</span>
                  </button>
                  {pickerOpen ? (
                    <ul className="sessions-addr-list" style={dropPos ? { top: dropPos.top, left: dropPos.left, width: dropPos.width } : undefined}>
                      {details.addressOptions.map((option) => (
                        <li key={option.value}>
                          <button
                            type="button"
                            className={`sessions-addr-item ${option.value === details.address ? "is-current" : ""}`}
                            onClick={() => {
                              details.onAddressChange(option.value);
                              setPickerOpen(false);
                            }}
                          >
                            {option.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <button className="sessions-reset-addr-btn" type="button" onClick={details.onResetAddress}>
                  {details.resetLabel}
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {startOnline || switchUi ? (
          <div className="sessions-modal-footer">
            {startOnline ? (
              <div className="session-host-buttons">
                <button
                  type="button"
                  className="btn btn-outline-primary btn-sm sessions-online-btn"
                  onClick={startOnline.onStart}
                  disabled={startOnline.starting}
                  title={startOnline.title}
                >
                  {startOnline.label}
                </button>
              </div>
            ) : null}
            {switchUi ? (
              <div className="sessions-browser-btn-wrapper">
                <button type="button" className="btn btn-primary d-flex align-items-center gap-2 sessions-switch-btn" onClick={switchUi.onClick}>
                  {switchUi.label}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default SessionsForm;
