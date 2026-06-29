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
import { icon, makeEmbeddedSvgTransparent } from "./assets";

type AuthResultAnim = "access-granted" | "access-denied";

export function LoginDialog() {
  const store = useClientViewStore();
  const state = useClientViewState();
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  // Default "keep me signed in" on for native hosts (Android), off in a plain
  // browser — matches the legacy `keepLoggedIn.checked = !!hostDevice`.
  const [keep, setKeep] = useState(state.capabilities.hasHostBridge);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authResultAnim, setAuthResultAnim] = useState<AuthResultAnim | null>(null);
  // Held false until the embedded SVG has loaded AND been made transparent, so the
  // animation is revealed only once its canvas can't flash white for a frame.
  const [animReady, setAnimReady] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);
  const resultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    userRef.current?.focus();
  }, []);

  useEffect(() => {
    return () => {
      if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
    };
  }, []);

  const showAuthResult = (anim: AuthResultAnim, duration: number, after?: () => void): void => {
    if (resultTimerRef.current) clearTimeout(resultTimerRef.current);
    setAnimReady(false);
    setAuthResultAnim(anim);
    resultTimerRef.current = setTimeout(() => {
      setAuthResultAnim(null);
      resultTimerRef.current = null;
      after?.();
    }, duration);
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const username = user.trim();
    if (!username || !password || pending || authResultAnim) return;
    setPending(true);
    setError(null);
    try {
      await store.login(username, password, keep);
      setPassword("");
      showAuthResult("access-granted", 1000, () => store.closeLoginDialog());
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sign in failed";
      setError(message);
      setPassword("");
      showAuthResult("access-denied", 1500);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="cv-modal-backdrop" onClick={() => store.closeLoginDialog()}>
      <form className="cv-dialog cv-login-dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)}>
        <div className="cv-login-row">
          <label className="cv-login-icon" htmlFor="cv-login-user" title="Username">
            <img className="btnImg" src={icon("user.svg")} alt="" />
          </label>
          <input
            id="cv-login-user"
            ref={userRef}
            type="text"
            autoComplete="username"
            aria-label="Username"
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
        </div>

        <div className="cv-login-row">
          <label className="cv-login-icon" htmlFor="cv-login-password" title="Password">
            <img className="btnImg" src={icon("keys.svg")} alt="" />
          </label>
          <input
            id="cv-login-password"
            type="password"
            autoComplete="current-password"
            aria-label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <label className={`cv-login-icon cv-store-session${keep ? " cv-store-session-on" : ""}`} title="Keep me signed in">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            <img className="btnImg" src={icon("save.svg")} alt="" />
          </label>
        </div>

        {authResultAnim && (
          <div
            className="cv-auth-result-overlay"
            role="status"
            aria-label={error ?? (authResultAnim === "access-granted" ? "Sign in accepted" : "Sign in failed")}
          >
            {/* Rounded dark-gray box behind the animation (legacy reused the
                #confirm-dialog panel, #3333 + rounded + shadow, over the form). */}
            <div className="cv-auth-result-box">
              <object
                key={authResultAnim}
                className={`cv-auth-result-anim${animReady ? " cv-auth-result-anim-ready" : ""}`}
                type="image/svg+xml"
                data={icon(`${authResultAnim}.svg`)}
                onLoad={(e) => {
                  makeEmbeddedSvgTransparent(e.currentTarget);
                  setAnimReady(true);
                }}
              >
                <img className="cv-auth-result-fallback" src={icon(`${authResultAnim}.svg`)} alt="" />
              </object>
            </div>
          </div>
        )}

        <div className="cv-dialog-actions">
          <button
            type="submit"
            className="cv-confirm-btn cv-login-ok"
            title="Sign in"
            aria-label="Sign in"
            disabled={pending || !!authResultAnim || !user.trim() || !password}
          >
            <img className="btnImg" src={icon("ok.svg")} alt="" />
          </button>
          <button
            type="button"
            className="cv-confirm-btn cv-login-cancel"
            title="Cancel"
            aria-label="Cancel"
            onClick={() => store.closeLoginDialog()}
          >
            <img className="btnImg" src={icon("cancel.svg")} alt="" />
          </button>
        </div>
      </form>
    </div>
  );
}
