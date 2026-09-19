import React, { useState, useRef, useCallback } from "react";
import { useLocalization } from "../localization/LocalizationContext";
import "./AuthDialog.css";

interface AuthDialogProps {
  /** May be async — while the returned promise is pending the dialog stays open in a locked "signing in" state. */
  onConfirm: (username: string, password: string, token: string) => void | Promise<void>;
  onCancel: () => void;
  onLogout?: () => void;
  showOffline?: boolean;
  initialUsername?: string;
  initialToken?: string;
}

const AuthDialog: React.FC<AuthDialogProps> = ({ onConfirm, onCancel, onLogout, showOffline = false, initialUsername = "", initialToken = "" }) => {
  const { t } = useLocalization();
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // The login request keeps the dialog open but locks the whole form until it settles.
  const [submitting, setSubmitting] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const refocusObserverRef = useRef<MutationObserver | null>(null);
  const refocusAfterSubmitRef = useRef(false);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refocusObserverRef.current?.disconnect();
      refocusObserverRef.current = null;
    };
  }, []);

  // A failed login pops a MessageBox over this dialog (portalled to body, its OK button
  // autofocused), so grabbing focus right away would only fight with it — wait it out.
  const focusPasswordWhenUnblocked = useCallback(() => {
    const tryFocus = () => {
      if (document.querySelector(".messagebox-overlay")) return false;
      passwordRef.current?.focus();
      return true;
    };

    refocusObserverRef.current?.disconnect();
    refocusObserverRef.current = null;
    if (tryFocus()) return;

    const observer = new MutationObserver(() => {
      if (!mountedRef.current || tryFocus()) {
        observer.disconnect();
        if (refocusObserverRef.current === observer) refocusObserverRef.current = null;
      }
    });
    refocusObserverRef.current = observer;
    observer.observe(document.body, { childList: true, subtree: true });
  }, []);

  const runConfirm = useCallback(
    async (user: string, pass: string, token: string) => {
      setSubmitting(true);
      try {
        await onConfirm(user, pass, token);
      } finally {
        // On success the parent closes (unmounts) us; otherwise hand the form back.
        // The refocus itself has to wait for the re-render that re-enables the field,
        // so it is only armed here and carried out by the effect below.
        if (mountedRef.current) {
          refocusAfterSubmitRef.current = true;
          setSubmitting(false);
        }
      }
    },
    [onConfirm]
  );

  React.useEffect(() => {
    if (submitting || !refocusAfterSubmitRef.current) return;
    refocusAfterSubmitRef.current = false;
    focusPasswordWhenUnblocked();
  }, [submitting, focusPasswordWhenUnblocked]);

  React.useEffect(() => {
    // Reset state when dialog opens (fixes Electron input issue on second open)
    setUsername(initialUsername);
    setPassword(""); // Always clear password for security
    setShowPassword(false); // Always hide password on open

    // Auto-submit if token is present
    if (initialToken) {
      void runConfirm(initialUsername, "", initialToken);
      return;
    }

    // Focus appropriate field on mount only
    if (!initialUsername && usernameRef.current) {
      usernameRef.current.focus();
    } else if (passwordRef.current) {
      passwordRef.current.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUsername, initialToken]);

  const handleOK = () => {
    if (submitting) return;
    const trimmedUsername = username.trim();
    const trimmedPassword = password.trim();
    // Clear password immediately after submit for security
    setPassword("");
    setShowPassword(false);
    void runConfirm(trimmedUsername, trimmedPassword, "");
  };

  const handleCancel = () => {
    if (submitting) return;
    // Clear password on cancel for security
    setPassword("");
    setShowPassword(false);
    onCancel();
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleOK();
    }
  };

  return (
    <div className="modal-backdrop show auth-dialog-backdrop">
      <div className="modal d-block">
        <div className="modal-dialog modal-dialog-centered" onClick={(e) => e.stopPropagation()}>
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title">{t("Authentication")}</h5>
            </div>
            <div className="modal-body">
              {/* Hidden fields to trick browser autofill */}
              <input type="text" name="fake_username" className="d-none" aria-hidden="true" tabIndex={-1} />
              <input type="password" name="fake_password" className="d-none" aria-hidden="true" tabIndex={-1} />
              <div className="mb-3">
                <label htmlFor="pp-auth-user" className="form-label">
                  {t("Username")}
                </label>
                <input
                  id="pp-auth-user"
                  name="pp-auth-user"
                  ref={usernameRef}
                  type="text"
                  className="form-control"
                  autoComplete="off"
                  value={username}
                  disabled={submitting}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyPress={handleKeyPress}
                />
              </div>
              <div className="mb-3">
                <label htmlFor="pp-auth-pass" className="form-label">
                  {t("Password")}
                </label>
                <div className="input-group">
                  <input
                    id="pp-auth-pass"
                    name="pp-auth-pass"
                    ref={passwordRef}
                    type={showPassword ? "text" : "password"}
                    className="form-control"
                    autoComplete="new-password"
                    value={password}
                    disabled={submitting}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyPress={handleKeyPress}
                  />
                  <button
                    className="btn btn-outline-secondary"
                    type="button"
                    disabled={submitting}
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={t("TogglePasswordVisibility")}
                  >
                    {showPassword ? (
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                        <path d="M13.359 11.238C15.06 9.72 16 8 16 8s-3-5.5-8-5.5a7.028 7.028 0 0 0-2.79.588l.77.771A5.944 5.944 0 0 1 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.134 13.134 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755-.165.165-.337.328-.517.486l.708.709z" />
                        <path d="M11.297 9.176a3.5 3.5 0 0 0-4.474-4.474l.823.823a2.5 2.5 0 0 1 2.829 2.829l.822.822zm-2.943 1.299.822.822a3.5 3.5 0 0 1-4.474-4.474l.823.823a2.5 2.5 0 0 0 2.829 2.829z" />
                        <path d="M3.35 5.47c-.18.16-.353.322-.518.487A13.134 13.134 0 0 0 1.172 8l.195.288c.335.48.83 1.12 1.465 1.755C4.121 11.332 5.881 12.5 8 12.5c.716 0 1.39-.133 2.02-.36l.77.772A7.029 7.029 0 0 1 8 13.5C3 13.5 0 8 0 8s.939-1.721 2.641-3.238l.708.709zm10.296 8.884-12-12 .708-.708 12 12-.708.708z" />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                        <path d="M16 8s-3-5.5-8-5.5S0 8 0 8s3 5.5 8 5.5S16 8 16 8zM1.173 8a13.133 13.133 0 0 1 1.66-2.043C4.12 4.668 5.88 3.5 8 3.5c2.12 0 3.879 1.168 5.168 2.457A13.133 13.133 0 0 1 14.828 8c-.058.087-.122.183-.195.288-.335.48-.83 1.12-1.465 1.755C11.879 11.332 10.119 12.5 8 12.5c-2.12 0-3.879-1.168-5.168-2.457A13.134 13.134 0 0 1 1.172 8z" />
                        <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM4.5 8a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={handleOK} disabled={submitting}>
                {submitting ? (
                  <>
                    <span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>
                    {t("LoggingIn")}
                  </>
                ) : (
                  t("OK")
                )}
              </button>
              {showOffline && onLogout && (
                <button className="btn btn-secondary" onClick={onLogout} disabled={submitting}>
                  {t("Guest")}
                </button>
              )}
              <button className="btn btn-secondary" onClick={handleCancel} disabled={submitting}>
                {t("Cancel")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AuthDialog;
