/**
 * MainToolbar — the top control bar (#mainToolbar in the legacy index.html):
 * Prev / Options / Capo / Transpose / network status / Fullscreen / Next.
 * Every control dispatches a controller action; none touches the backend.
 *
 * The button ORDER is data-driven and INDEPENDENT per layout (see uiConfig):
 * TOOLBAR_ORDER_HORIZONTAL drives the paging strip (left-to-right) and
 * TOOLBAR_ORDER_VERTICAL the wide-pane column (top-to-bottom). The toolbar is a
 * vertical column exactly when wide-pane layout is active and the options panel
 * is closed.
 */

import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useClientPerformanceProfile, useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { isViewingRemoteDisplay, showsNetworkIndicator, hasFullViewTodo, hasBackgroundSessionsFound } from "../controller/ClientViewStore";
import type { NetworkStatus } from "../api/ClientApi";
import { TOOLBAR_ORDER_HORIZONTAL, TOOLBAR_ORDER_VERTICAL, type ToolbarButtonKey } from "./uiConfig";
import { icon } from "./assets";
import { useLongPress } from "./useLongPress";
import { useWheelDragOpen, type WheelDragOpenPayload } from "./useWheelDragOpen";
import { WheelPicker } from "./WheelPicker";
import { shouldUsePagingLayout } from "../../utils/viewLayout";

// Ranges/labels mirror the original initShiftAndCapo():
//   transpose −11..+11 → "11b … 1b 0 1♯ … 11♯" (literal "b" flat, ♯ = U+266F)
//   capo      −1..11    → "" for −1 (no capo), else the number
const TRANSPOSE_RANGE = Array.from({ length: 23 }, (_, i) => i - 11);
const CAPO_RANGE = Array.from({ length: 13 }, (_, i) => i - 1);

const SHARP = "♯";
const transposeOption = (v: number) => (v === 0 ? "0" : v < 0 ? `${Math.abs(v)}b` : `${v}${SHARP}`);
const transposeValue = (v: number) => (v === 0 ? "" : v < 0 ? `${Math.abs(v)}b` : `${v}${SHARP}`);

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

const isWidePaneViewport = (): boolean => typeof window !== "undefined" && !shouldUsePagingLayout(window.innerWidth, window.innerHeight);

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
  const performanceProfile = useClientPerformanceProfile();
  // View-only: a Client follower, OR App mode while watching a session (legacy
  // ppdWatchMode). Either way no navigation or transpose — the display mirrors the
  // leader (legacy setLeader(false)/ppdWatchMode hid btnPrev/btnNext/divTranspose).
  const follower = isViewingRemoteDisplay(state);
  const [wheel, setWheel] = useState<null | "transpose" | "capo">(null);
  // When the open wheel was summoned by a drag off its trigger, the in-flight
  // pointer to hand to it so it opens already turning (see useWheelDragOpen).
  const [wheelDrag, setWheelDrag] = useState<WheelDragOpenPayload | null>(null);
  const [transposeBtnElement, setTransposeBtnElement] = useState<HTMLDivElement | null>(null);
  const [capoBtnElement, setCapoBtnElement] = useState<HTMLDivElement | null>(null);
  const [transposeValueElement, setTransposeValueElement] = useState<HTMLSpanElement | null>(null);
  const [capoValueElement, setCapoValueElement] = useState<HTMLSpanElement | null>(null);
  const pendingTransposeRef = useRef(state.transpose);
  const pendingCapoRef = useRef(state.capo);

  // The toolbar is a vertical column when wide-pane layout is active and options
  // are closed. This mirrors the full-view tab/pane breakpoint.
  const [widePane, setWidePane] = useState(isWidePaneViewport);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onViewportChange = () => setWidePane(isWidePaneViewport());
    onViewportChange();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", onViewportChange);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("orientationchange", onViewportChange);
    };
  }, []);
  const vertical = widePane && !state.optionsOpen;
  const order = vertical ? TOOLBAR_ORDER_VERTICAL : TOOLBAR_ORDER_HORIZONTAL;

  // Long-press plumbing for the wand (instructions) button. Editing is gated by
  // display-control capability. A long press — or the native contextmenu (touch
  // long-press / right-click) — opens the editor dialog; a short press is the
  // normal show/hide toggle. Shared useLongPress, same as capo/lamp/zoom: ONE
  // long-press implementation (native contextmenu preferred, timer fallback).
  const canEditInstructions = state.capabilities.canControlDisplay;
  const instructionsPress = useLongPress(
    () => store.toggleInstructions(),
    () => store.openInstructionsEditor()
  );

  // Network indicator state (rendered by controls.netstatus below). Tapping forces
  // an immediate reconnect — the new-interface analog of the legacy
  // divNetStatus.onclick → goOnline(). While LEADING there is no remote link to
  // re-establish, so the dot is purely informational there.
  const netStatus = state.network.status;
  const netReconnectable = netStatus !== "leading";
  const netLabel = NET_STATUS_LABEL[netStatus] ?? netStatus;
  const netDetail = netStatus === "error" && state.network.error ? `: ${state.network.error}` : "";
  const netTitle = netReconnectable ? `${netLabel}${netDetail} — tap to reconnect` : `${netLabel}${netDetail}`;
  const openCapoPicker = () => {
    if (!state.displaySettings.useCapo) return;
    pendingCapoRef.current = state.capo;
    setWheelDrag(null);
    setWheel("capo");
  };

  // Capo toggle: short press enables/disables; long press opens the value list.
  const capoPress = useLongPress(
    () => store.setDisplaySetting("useCapo", !state.displaySettings.useCapo),
    () => openCapoPicker()
  );

  // Drag-to-open: dragging horizontally off Transpose or Capo (both wheels are
  // horizontal) opens the wheel already turning under the finger — see
  // useWheelDragOpen + WheelPicker's initialDrag. Purely additive to the tap /
  // long-press triggers above. Capo's drag is gated on useCapo, mirroring
  // openCapoPicker's own precondition.
  const transposeDrag = useWheelDragOpen({
    orientation: "horizontal",
    onOpen: (drag) => {
      pendingTransposeRef.current = state.transpose;
      setWheelDrag(drag);
      setWheel("transpose");
    },
  });
  const capoDrag = useWheelDragOpen({
    orientation: "horizontal",
    enabled: state.displaySettings.useCapo,
    onOpen: (drag) => {
      pendingCapoRef.current = state.capo;
      setWheelDrag(drag);
      setWheel("capo");
    },
  });
  // #capoToggle keeps its long-press / short-press (useLongPress) AND gains the
  // drag-open gesture: both run for every pointer event. The same >slop move that
  // voids the press (useLongPress) is the one that opens the wheel — no conflict.
  const capoToggleHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      capoPress.onPointerDown(e);
      capoDrag.handlers.onPointerDown(e);
    },
    onPointerMove: (e: React.PointerEvent) => {
      capoPress.onPointerMove(e);
      capoDrag.handlers.onPointerMove(e);
    },
    onPointerUp: (e: React.PointerEvent) => {
      capoPress.onPointerUp(e);
      capoDrag.handlers.onPointerUp(e);
    },
    onPointerCancel: (e: React.PointerEvent) => {
      capoPress.onPointerCancel();
      capoDrag.handlers.onPointerCancel(e);
    },
    onPointerLeave: capoPress.onPointerLeave,
    onContextMenu: capoPress.onContextMenu,
  };

  // A layout change that hides/disables a wheel's own control must close it:
  // becoming a follower hides the TRANSPOSE control entirely, and disabling capo
  // revokes the capo wheel's own precondition (openCapoPicker's early return).
  // The capo wheel is deliberately NOT closed for a follower — capo is a
  // per-client local preference that followers may still set on their own client.
  useEffect(() => {
    if (wheel === "transpose" && follower) setWheel(null);
    else if (wheel === "capo" && !state.displaySettings.useCapo) setWheel(null);
  }, [follower, wheel, state.displaySettings.useCapo]);

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
        {(hasFullViewTodo(state) || hasBackgroundSessionsFound(state)) && <span className="cv-todo-dot" aria-label="Action needed" />}
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
        className={`btnDiv${state.showInstructions ? " cv-toolbtn-on" : ""}${state.hotkeyActiveControl === "instructions" ? " cv-hotkey-active" : ""}`}
        title={canEditInstructions ? "Show/hide instructions (hold to edit)" : "Show/hide instructions"}
        {...(canEditInstructions ? instructionsPress : {})}
        onClick={canEditInstructions ? undefined : () => store.toggleInstructions()}
      >
        <img className="btnImg cv-toggle-icon" src={icon("wand.svg")} alt="Instructions" />
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
      <div id="capo" ref={setCapoBtnElement} className={state.hotkeyActiveControl === "capo" ? "cv-hotkey-active" : ""}>
        <div
          id="capoToggle"
          className={`btnDiv${state.displaySettings.useCapo ? " cv-toolbtn-on" : ""}`}
          title={state.displaySettings.useCapo ? "Disable capo (hold to pick value)" : "Enable capo (hold to pick value)"}
          {...capoToggleHandlers}
        >
          <span id="capoValue" ref={setCapoValueElement}>
            {state.displaySettings.useCapo && state.capo > 0 ? state.capo : ""}
          </span>
          <img className="btnImg cv-toggle-icon" src={icon("capo.svg")} alt="Capo" />
        </div>
        <div
          id="capoDropdown"
          className={`btnDiv${state.displaySettings.useCapo ? "" : " cv-disabled"}`}
          title={state.displaySettings.useCapo ? "Select capo value" : "Enable capo first"}
          onClick={openCapoPicker}
        >
          <span className="cv-capo-caret">▼</span>
        </div>
      </div>
    ),
    transpose: follower ? null : (
      <div
        id="transpose"
        ref={setTransposeBtnElement}
        className={`btnDiv${wheel === "transpose" ? " cv-toolbtn-on" : ""}${state.hotkeyActiveControl === "transpose" ? " cv-hotkey-active" : ""}`}
        title="Transpose"
        {...transposeDrag.handlers}
        onClick={() => {
          // A drag that just opened the wheel also fires a trailing click; ignore
          // it so it does not immediately toggle the freshly-opened wheel shut.
          if (transposeDrag.consumeDragOpenClick()) return;
          if (wheel !== "transpose") pendingTransposeRef.current = state.transpose;
          setWheelDrag(null);
          setWheel((w) => (w === "transpose" ? null : "transpose"));
        }}
      >
        {/* The value target is always present, including at zero, so the horizontal
            picker can precisely cover the element whose value it changes. */}
        <span id="shiftValue" ref={setTransposeValueElement}>
          {state.transpose !== 0 ? transposeValue(state.transpose) : <img className="btnImg" src={icon("transpose.svg")} alt="Transpose" />}
        </span>
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
        className={`btnDiv net-${netStatus}${state.hotkeyActiveControl === "network" ? " cv-hotkey-active" : ""}`}
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
      <div
        id="fsdiv"
        className={`btnDiv${state.hotkeyActiveControl === "fullscreen" ? " cv-hotkey-active" : ""}`}
        onClick={() => void store.toggleFullScreen()}
      >
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
    <>
      <div className="widthProtect" id="mainToolbar" ref={pullRef}>
        {order.map((key) => {
          const node = controls[key];
          return node ? <Fragment key={key}>{node}</Fragment> : null;
        })}
      </div>
      {wheel === "transpose" && transposeBtnElement && transposeValueElement && (
        <WheelPicker
          values={TRANSPOSE_RANGE}
          value={state.transpose}
          format={transposeOption}
          onChange={(v) => {
            pendingTransposeRef.current = v;
            if (!performanceProfile.chordProSlow) void store.previewTranspose(v);
          }}
          onClose={() => {
            setWheel(null);
            setWheelDrag(null);
            if (performanceProfile.chordProSlow) {
              void store.previewTranspose(pendingTransposeRef.current).then(() => store.commitTranspose());
            } else {
              void store.commitTranspose();
            }
          }}
          anchor={transposeBtnElement}
          orientation="horizontal"
          selectionAnchor={transposeValueElement}
          initialDrag={wheelDrag ?? undefined}
          ariaLabel="Transpose"
          dark={state.isDark}
        />
      )}
      {wheel === "capo" && capoBtnElement && capoValueElement && (
        <WheelPicker
          values={CAPO_RANGE}
          value={state.capo}
          format={(v) => (v >= 0 ? String(v) : "—")}
          valueText={(v) => (v >= 0 ? String(v) : "no capo")}
          onChange={(v) => {
            pendingCapoRef.current = v;
            if (!performanceProfile.chordProSlow) void store.previewCapo(v);
          }}
          onClose={() => {
            setWheel(null);
            setWheelDrag(null);
            if (performanceProfile.chordProSlow) {
              void store.previewCapo(pendingCapoRef.current).then(() => store.commitCapo());
            } else {
              void store.commitCapo();
            }
          }}
          anchor={capoBtnElement}
          orientation="horizontal"
          selectionAnchor={capoValueElement}
          initialDrag={wheelDrag ?? undefined}
          ariaLabel="Capo"
          dark={state.isDark}
        />
      )}
    </>
  );
}
