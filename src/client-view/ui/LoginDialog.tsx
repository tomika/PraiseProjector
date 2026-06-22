/**
 * LoginDialog — cloud authentication, gated off capabilities.canLogin (true only
 * for the cloud-backed client; the host-gated served client and the desktop
 * embed declare canLogin=false, so this never appears there). Mirrors the legacy
 * #loginDialog (username / password / keep-logged-in) and the cloud editor's
 * AuthDialog wording.
 *
 * NOTE (webserver gap): POST /session 504s on the Electron embedded webserver,
 * so login only works against the cloud. Because canLogin is false in the served
 * context, the dialog stays hidden there and that limitation is never reached.
 */

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";

export function LoginDialog() {
  const store = useClientViewStore();
  const state = useClientViewState();
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  // Default "keep me signed in" on for native hosts (Android), off in a plain
  // browser — matches the legacy `keepLoggedIn.checked = !!hostDevice`.
  const [keep, setKeep] = useState(state.capabilities.hasHostBridge);
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    userRef.current?.focus();
  }, []);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const username = user.trim();
    if (!username || !password || pending) return;
    setPending(true);
    setError(null);
    try {
      await store.login(username, password, keep);
      setPassword("");
      store.closeLoginDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
      setPassword("");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="cv-modal-backdrop" onClick={() => store.closeLoginDialog()}>
      <form className="cv-dialog cv-login-dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)}>
        <h2 className="cv-dialog-title">Sign in</h2>

        <label className="cv-field">
          <span>Username</span>
          <input ref={userRef} type="text" autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} />
        </label>

        <label className="cv-field">
          <span>Password</span>
          <div className="cv-field-input">
            <input
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button type="button" className="cv-reveal" onClick={() => setShowPassword((v) => !v)}>
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </label>

        <label className="cv-check">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          <span>Keep me signed in</span>
        </label>

        {error && (
          <p className="cv-dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="cv-dialog-actions">
          <button type="button" className="cv-dialog-cancel" onClick={() => store.closeLoginDialog()}>
            Cancel
          </button>
          <button type="submit" className="cv-dialog-ok" disabled={pending || !user.trim() || !password}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}
