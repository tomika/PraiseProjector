/**
 * ConfirmDialog — the animated-SVG confirmation popup (legacy praiseprojector.ts
 * `confirm(anim)`). Its BODY is the animated SVG message itself (e.g. erase.svg,
 * overwrite.svg from the legacy images folder), and the two buttons carry the
 * ok.svg / cancel.svg icons rather than text — exactly the original's look.
 *
 * It is driven by the store's `confirmAnim` state (the SVG name) and a promise
 * resolved by `resolveConfirm`, so callers can simply `await store.confirm("…")`.
 * OK resolves true; Cancel, a backdrop click, or Esc resolve false (Enter = OK).
 */

import { useEffect, useState } from "react";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { icon, makeEmbeddedSvgTransparent } from "./assets";

export function ConfirmDialog() {
  const store = useClientViewStore();
  const state = useClientViewState();
  const anim = state.confirmAnim;
  // Held false until the embedded SVG has loaded AND its canvas has been painted,
  // so the animation fades in cleanly instead of flashing a white first frame
  // (Electron paints embedded <object> documents on a white base — see assets.ts).
  const [animReady, setAnimReady] = useState(false);

  // Keyboard affordances: Esc cancels, Enter confirms (matching common dialogs).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        store.resolveConfirm(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        store.resolveConfirm(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [store]);

  // Re-arm the fade whenever a different animation is shown.
  useEffect(() => setAnimReady(false), [anim]);

  if (!anim) return null;

  return (
    <div className="cv-modal-backdrop" onClick={() => store.resolveConfirm(false)}>
      <div className="cv-dialog cv-confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="cv-confirm-body">
          {/* The message is a SCRIPT-DRIVEN (SVGator) animated SVG, so it must be
              embedded via <object> — a plain <img> runs no scripts and would show
              only the first frame (legacy used <object> for exactly this reason).
              Designed for a dark popup, so it is NOT inverted (no btnImg class).
              The inner <img> is the static fallback if the object can't render. */}
          <object
            key={anim}
            className={`cv-confirm-anim${animReady ? " cv-confirm-anim-ready" : ""}`}
            type="image/svg+xml"
            data={icon(`${anim}.svg`)}
            aria-label="Confirmation"
            onLoad={(e) => {
              makeEmbeddedSvgTransparent(e.currentTarget);
              setAnimReady(true);
            }}
          >
            <img className="cv-confirm-anim-fallback" src={icon(`${anim}.svg`)} alt="" />
          </object>
        </div>
        <div className="cv-dialog-actions">
          <button
            type="button"
            className="cv-confirm-btn cv-confirm-cancel"
            title="Cancel"
            aria-label="Cancel"
            onClick={() => store.resolveConfirm(false)}
          >
            <img className="btnImg" src={icon("cancel.svg")} alt="Cancel" />
          </button>
          <button type="button" className="cv-confirm-btn cv-confirm-ok" title="OK" aria-label="OK" onClick={() => store.resolveConfirm(true)}>
            <img className="btnImg" src={icon("ok.svg")} alt="OK" />
          </button>
        </div>
      </div>
    </div>
  );
}
