/**
 * MainToolbar — the top control bar (#mainToolbar in the legacy index.html):
 * Prev / Options / Capo / Transpose / network status / Fullscreen / Next.
 * Every control dispatches a controller action; none touches the backend.
 *
 * The button ORDER is data-driven and INDEPENDENT per layout (see uiConfig):
 * TOOLBAR_ORDER_HORIZONTAL drives the portrait strip (left→right) and
 * TOOLBAR_ORDER_VERTICAL the landscape column (top→bottom). The toolbar is a
 * vertical column exactly when landscape AND the options panel is closed (the
 * `@media (orientation: landscape) #mainView:not(.options-open)` CSS rule).
 */

import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { isViewingRemoteDisplay, showsNetworkIndicator, hasFullViewTodo } from "../controller/ClientViewStore";
import type { NetworkStatus } from "../api/ClientApi";
import { TOOLBAR_ORDER_HORIZONTAL, TOOLBAR_ORDER_VERTICAL, type ToolbarButtonKey } from "./uiConfig";
import { icon } from "./assets";
import { useLongPress } from "./useLongPress";

const LONG_PRESS_MS = 500;

// Ranges/labels mirror the original initShiftAndCapo():
//   transpose −11..+11 → "11b … 1b 0 1♯ … 11♯" (literal "b" flat, ♯ = U+266F)
//   capo      −1..11    → "" for −1 (no capo), else the number
const TRANSPOSE_RANGE = Array.from({ length: 23 }, (_, i) => i - 11);
const CAPO_RANGE = Array.from({ length: 13 }, (_, i) => i - 1);

const SHARP = "♯";
const transposeOption = (v: number) => (v === 0 ? "0" : v < 0 ? `${Math.abs(v)}b` : `${v}${SHARP}`);
const transposeValue = (v: number) => (v === 0 ? "" : v < 0 ? `${Math.abs(v)}b` : `${v}${SHARP}`);
const capoOption = (v: number) => (v >= 0 ? String(v) : "");

// Human-readable labels for the network indicator's tooltip (state.network.status
// from the active ClientApi adapter). Unknown values fall back to the raw status.
const NET_STATUS_LABEL: Record<string, string> = {
  startup: "Connecting…",
  watching: "Connected",
  online: "Connected",
  leading: "Leading session",
  offline: "Disconnected",
  error: "Connection error",
};

const NET_STATUS_ICON: Record<NetworkStatus, string> = {
  startup: "startup.svg",
  watching: "online.svg",
  online: "online.svg",
  leading: "online-leader.svg",
  offline: "offline.svg",
  error: "offline.svg",
};

// Every status icon is rendered at once (see the netstatus control) and switched
// by a CSS class — so this is just DOM order, not priority. Listing them keeps the
// netstatus map iteration typed without an `Object.keys` cast.
const NET_STATUSES: NetworkStatus[] = ["startup", "watching", "online", "leading", "offline", "error"];

export function MainToolbar({
  onPrev,
  onNext,
  pullRef,
}: {
  onPrev?: () => void;
  onNext?: () => void;
  /** Attaches the pull-to-refresh gesture (see usePullToRefresh) to the toolbar. */
  pullRef?: RefObject<HTMLDivElement>;
}) {
  const store = useClientViewStore();
  const state = useClientViewState();
  // View-only: a Client follower, OR App mode while watching a session (legacy
  // ppdWatchMode). Either way no navigation or transpose — the display mirrors the
  // leader (legacy setLeader(false)/ppdWatchMode hid btnPrev/btnNext/divTranspose).
  const follower = isViewingRemoteDisplay(state);
  const capoSelectRef = useRef<HTMLSelectElement | null>(null);

  // The toolbar is a vertical column when landscape AND options closed.
  const [landscape, setLandscape] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(orientation: landscape)").matches);
  useEffect(() => {
    const mql = window.matchMedia?.("(orientation: landscape)");
    if (!mql) return;
    const onChange = () => setLandscape(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  const vertical = landscape && !state.optionsOpen;
  const order = vertical ? TOOLBAR_ORDER_VERTICAL : TOOLBAR_ORDER_HORIZONTAL;

  // Long-press plumbing for the wand (instructions) button. Editing is gated by
  // display-control capability. A long press opens the editor dialog; a short
  // press is the normal show/hide toggle.
  const canEditInstructions = state.capabilities.canControlDisplay;
  const instructionsLongPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const instructionsLongFired = useRef(false);

  const onInstructionsPointerDown = (e: React.PointerEvent) => {
    if (!canEditInstructions) return;
    if (e.button !== 0) return;
    e.preventDefault();
    instructionsLongFired.current = false;
    instructionsLongPressTimer.current = setTimeout(() => {
      instructionsLongFired.current = true;
      store.openInstructionsEditor();
    }, LONG_PRESS_MS);
  };
  const onInstructionsPointerUp = (e: React.PointerEvent) => {
    // Guard so we don't double-fire with onClick when canEditInstructions is false.
    if (!canEditInstructions) return;
    if (e.button !== 0) return;
    clearTimeout(instructionsLongPressTimer.current);
    if (!instructionsLongFired.current) store.toggleInstructions();
  };
  const onInstructionsPointerCancel = () => {
    if (!canEditInstructions) return;
    clearTimeout(instructionsLongPressTimer.current);
    instructionsLongFired.current = true;
  };
  const onInstructionsContextMenu = (e: React.MouseEvent) => {
    if (!canEditInstructions) return;
    e.preventDefault();
    clearTimeout(instructionsLongPressTimer.current);
    instructionsLongFired.current = true;
    store.openInstructionsEditor();
  };

  // Network indicator state (rendered by controls.netstatus below). Tapping forces
  // an immediate reconnect — the new-interface analog of the legacy
  // divNetStatus.onclick → goOnline(). While LEADING there is no remote link to
  // re-establish, so the dot is purely informational there.
  const netStatus = state.network.status;
  const netReconnectable = netStatus !== "leading";
  const netLabel = NET_STATUS_LABEL[netStatus] ?? netStatus;
  const netDetail = netStatus === "error" && state.network.error ? `: ${state.network.error}` : "";
  const netTitle = netReconnectable ? `${netLabel}${netDetail} — tap to reconnect` : `${netLabel}${netDetail}`;
  // In App mode the indicator is normally hidden, but a hosted/followed session is a
  // live link worth showing (legacy divNetStatus shown while ppdWatchers != null).
  const netActiveInApp = netStatus === "leading" || netStatus === "watching";

  const openCapoPicker = () => {
    if (!state.displaySettings.useCapo) return;
    const select = capoSelectRef.current;
    if (!select) return;
    const withPicker = select as HTMLSelectElement & { showPicker?: () => void };
    if (typeof withPicker.showPicker === "function") {
      withPicker.showPicker();
      return;
    }
    select.focus();
    select.click();
  };

  // Capo toggle: short press enables/disables; long press opens the value list.
  const capoPress = useLongPress(
    () => store.setDisplaySetting("useCapo", !state.displaySettings.useCapo),
    () => openCapoPicker()
  );

  // One renderer per control key; the order arrays decide which appear and where.
  const controls: Record<ToolbarButtonKey, ReactNode> = {
    prev: follower ? null : (
      <div id="btnPrev" className="btnDiv" onClick={() => (onPrev ? onPrev() : void store.prevSong())}>
        <img className="btnImg" src={icon("left.svg")} alt="Prev" />
      </div>
    ),
    options: (
      <div id="btnOptions" className="btnDiv left-aligned" onClick={() => store.toggleOptions()}>
        <img className="btnImg" src={icon("options.svg")} alt="Options" />
        {hasFullViewTodo(state) && <span className="cv-todo-dot" aria-label="Action needed in full view" />}
      </div>
    ),
    home: state.capabilities.canReturnHome ? (
      <div id="btnHome" className="btnDiv" title="Home" onClick={() => store.returnHome()}>
        <img className="btnImg" src={icon("home.svg")} alt="Home" />
      </div>
    ) : null,
    // Instructions (wand): short press toggles the instructions overlay; long
    // press opens the instructions text editor (when the user can control
    // display — mirrors legacy chkInstructions + editInstructions).
    instructions: (
      <div
        id="btnInstructions"
        className={`btnDiv${state.showInstructions ? " cv-toolbtn-on" : ""}`}
        title={canEditInstructions ? "Show/hide instructions (hold to edit)" : "Show/hide instructions"}
        onPointerDown={onInstructionsPointerDown}
        onPointerUp={onInstructionsPointerUp}
        onPointerLeave={onInstructionsPointerCancel}
        onPointerCancel={onInstructionsPointerCancel}
        onContextMenu={onInstructionsContextMenu}
        onClick={canEditInstructions ? undefined : () => store.toggleInstructions()}
      >
        <img className="btnImg" src={icon("wand.svg")} alt="Instructions" />
      </div>
    ),
    // Clear-highlight (off): visible when the user can clear the active highlight.
    // In App mode (canControlDisplay) shown whenever highlight is on; in Client
    // mode only when highlight control permission has been granted by the server
    // (mirrors legacy: own session → chkHighlight.checked; client → granted).
    unhighlight: (state.capabilities.canControlDisplay ? state.highlightOn : state.highlightControl) ? (
      <div id="btnUnhighlight" className="btnDiv" title="Clear highlight" onClick={() => void store.unhighlight()}>
        <img className="btnImg" src={icon("off.svg")} alt="Clear highlight" />
      </div>
    ) : null,
    // Capo uses a split interaction like the legacy option+toolbar combo:
    // - capo icon toggles useCapo on/off,
    // - small dropdown button opens the capo value list.
    capo: (
      <div id="capo">
        <div
          id="capoToggle"
          className={`btnDiv${state.displaySettings.useCapo ? " cv-toolbtn-on" : ""}`}
          title={state.displaySettings.useCapo ? "Disable capo (hold to pick value)" : "Enable capo (hold to pick value)"}
          {...capoPress}
        >
          <span id="capoValue">{state.displaySettings.useCapo && state.capo > 0 ? state.capo : ""}</span>
          <img className="btnImg" src={icon("capo.svg")} alt="Capo" />
        </div>
        <div
          id="capoDropdown"
          className={`btnDiv${state.displaySettings.useCapo ? "" : " cv-disabled"}`}
          title={state.displaySettings.useCapo ? "Select capo value" : "Enable capo first"}
          onClick={openCapoPicker}
        >
          <span className="cv-capo-caret">▼</span>
        </div>
        <select
          ref={capoSelectRef}
          id="selCapo"
          className="cv-capo-picker"
          title="Capo"
          value={state.capo}
          disabled={!state.displaySettings.useCapo}
          onChange={(e) => void store.setCapo(Number(e.target.value))}
        >
          {CAPO_RANGE.map((value) => (
            <option key={value} value={value}>
              {capoOption(value)}
            </option>
          ))}
        </select>
      </div>
    ),
    transpose: follower ? null : (
      <div id="transpose">
        {/* Like the original, the value replaces the icon once a transpose is set. */}
        {state.transpose !== 0 ? (
          <span id="shiftValue">{transposeValue(state.transpose)}</span>
        ) : (
          <img className="btnImg" src={icon("transpose.svg")} alt="Transpose" />
        )}
        <select id="selShift" title="Transpose" value={state.transpose} onChange={(e) => void store.setTranspose(Number(e.target.value))}>
          {TRANSPOSE_RANGE.map((value) => (
            <option key={value} value={value}>
              {transposeOption(value)}
            </option>
          ))}
        </select>
      </div>
    ),
    // Network status: only shown when the client is following an online session
    // or connected to a server. Hidden in standalone App mode (embedded in
    // Electron) where there is no remote connection to indicate. Tapping forces an
    // immediate reconnect (see netReconnectable above).
    //
    // All status icons stay mounted at once; changing status only toggles the
    // .cv-net-active CSS class (see client-view.css). We deliberately do NOT swap a
    // single <img src>: rewriting src mid-load cancels the in-flight request (it
    // shows as 0 B / "(unknown)" / Initiator "Other" in devtools) and blanks the
    // indicator between frames — very visible when the status flips repeatedly.
    netstatus: showsNetworkIndicator(state) ? (
      <div
        id="netstatus"
        className={`btnDiv net-${netStatus}`}
        title={netTitle}
        onClick={netReconnectable ? () => void store.reconnect() : undefined}
      >
        {NET_STATUSES.map((s) => (
          <img
            key={s}
            className={`btnImg cv-net-icon${s === netStatus ? " cv-net-active" : ""}${s === "startup" ? " cv-spin" : ""}`}
            src={icon(NET_STATUS_ICON[s])}
            alt={NET_STATUS_LABEL[s] ?? s}
          />
        ))}
      </div>
    ) : null,
    fullscreen: (
      <div id="fsdiv" className="btnDiv" onClick={() => void store.toggleFullScreen()}>
        <img
          className="btnImg"
          src={icon(state.isFullScreen ? "restore.svg" : "fullscreen.svg")}
          alt={state.isFullScreen ? "Restore" : "Fullscreen"}
        />
      </div>
    ),
    next: follower ? null : (
      <div id="btnNext" className="btnDiv" onClick={() => (onNext ? onNext() : void store.nextSong())}>
        <img className="btnImg" src={icon("right.svg")} alt="Next" />
      </div>
    ),
  };

  return (
    <div className="widthProtect" id="mainToolbar" ref={pullRef}>
      {order.map((key) => {
        const node = controls[key];
        return node ? <Fragment key={key}>{node}</Fragment> : null;
      })}
    </div>
  );
}
