/**
 * OptionsOverlay — the slide-in panel (#options.overlay) holding the chord
 * options, search bar and song list. Visibility is driven by the controller's
 * `optionsOpen` flag (legacy openOptions/closeOptions). The close button and
 * picking a song both return to the song view.
 */

import { useEffect, useRef } from "react";
import { installPinchZoomHandler } from "../../../common/utils";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { isAppWatching, isFollowerView, isViewingRemoteDisplay } from "../controller/ClientViewStore";
import { icon } from "./assets";
import { LeaderPlaylistPicker } from "./LeaderPlaylistPicker";
import { OptionsBar } from "./OptionsBar";
import { PlaylistEditor } from "./PlaylistEditor";
import { SearchBar } from "./SearchBar";
import { SongList } from "./SongList";

const LIST_ROW_FONT_SIZE_KEY = "pp-client-view-list-row-font-size";
const LIST_ROW_FONT_SIZE_DEFAULT = 17;
const LIST_ROW_FONT_SIZE_MIN = 12;
const LIST_ROW_FONT_SIZE_MAX = 30;

const clampListRowFontSize = (value: number) => Math.min(LIST_ROW_FONT_SIZE_MAX, Math.max(LIST_ROW_FONT_SIZE_MIN, value));

function readStoredListRowFontSize(): number {
  try {
    const value = Number.parseFloat(window.localStorage?.getItem(LIST_ROW_FONT_SIZE_KEY) ?? "");
    return Number.isFinite(value) ? clampListRowFontSize(value) : LIST_ROW_FONT_SIZE_DEFAULT;
  } catch {
    return LIST_ROW_FONT_SIZE_DEFAULT;
  }
}

function storeListRowFontSize(value: number): void {
  try {
    window.localStorage?.setItem(LIST_ROW_FONT_SIZE_KEY, String(value));
  } catch {
    /* storage is optional in embedded webviews */
  }
}

export function OptionsOverlay({ onHome }: { onHome?: () => void }) {
  const store = useClientViewStore();
  const state = useClientViewState();
  const contentRef = useRef<HTMLDivElement>(null);
  const pinchBaselineRowFontSize = useRef(LIST_ROW_FONT_SIZE_DEFAULT);

  // Follower (Client mode, no control): no song browser — only the chord options
  // above and a single netdisplay button (legacy setLeader(false)).
  const follower = isFollowerView(state);
  // App mode while watching a session is also view-only (legacy ppdWatchMode): hide
  // the browser, but offer a Stop-following button instead of netdisplay (the cloud
  // App has no host /netdisplay route — that button is Client/host-served only).
  const appWatching = isAppWatching(state);
  const viewer = isViewingRemoteDisplay(state);
  const canEdit = state.capabilities.canEditWorkingPlaylist;
  const editingPlaylist = canEdit && state.listMode === "playlist";
  const leaderLists = canEdit && state.listMode === "leaderlists";

  useEffect(() => {
    if (!state.optionsOpen || !state.hotkeySongId) return;
    const frame = requestAnimationFrame(() => contentRef.current?.querySelector("#list tr.cv-hotkey-row")?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [state.hotkeySongId, state.listMode, state.optionsOpen]);

  useEffect(() => {
    const content = contentRef.current;
    const mainView = content?.closest<HTMLElement>("#mainView");
    if (!content || !mainView) return;

    mainView.style.setProperty("--cv-list-row-font-size", `${readStoredListRowFontSize()}px`);

    let cleanupPinch: (() => void) | undefined;
    let raf = 0;
    const readCurrentRowFontSize = () => {
      const styles = window.getComputedStyle(mainView);
      const list = content.querySelector<HTMLElement>("#list");
      const raw = styles.getPropertyValue("--cv-list-row-font-size") || (list ? window.getComputedStyle(list).fontSize : "");
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) ? clampListRowFontSize(parsed) : LIST_ROW_FONT_SIZE_DEFAULT;
    };
    const install = () => {
      cleanupPinch?.();
      cleanupPinch = undefined;
      const list = content.querySelector<HTMLElement>("#list");
      if (!list) return;
      const pixelsPerStep = Math.max(20, Math.min(window.innerWidth, window.innerHeight) / 20);
      const cleanupTouch = installPinchZoomHandler(
        list,
        (steps, gestureStart) => {
          if (gestureStart) {
            pinchBaselineRowFontSize.current = readCurrentRowFontSize();
            return;
          }
          const next = Math.round(clampListRowFontSize(pinchBaselineRowFontSize.current + steps));
          mainView.style.setProperty("--cv-list-row-font-size", `${next}px`);
          storeListRowFontSize(next);
        },
        pixelsPerStep
      );
      // Ctrl+wheel mirrors the pinch gesture for desktop/mouse users (one row-size
      // step per notch, same clamp/persist path as the touch pinch above).
      const onWheel = (ev: WheelEvent) => {
        if (!ev.ctrlKey) return;
        ev.preventDefault();
        const current = readCurrentRowFontSize();
        const next = clampListRowFontSize(current + (ev.deltaY > 0 ? -1 : 1));
        if (next !== current) {
          mainView.style.setProperty("--cv-list-row-font-size", `${next}px`);
          storeListRowFontSize(next);
        }
      };
      list.addEventListener("wheel", onWheel, { passive: false });
      cleanupPinch = () => {
        cleanupTouch();
        list.removeEventListener("wheel", onWheel);
      };
    };
    const scheduleInstall = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(install);
    };
    scheduleInstall();
    const observer = new MutationObserver(scheduleInstall);
    observer.observe(content, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
      cleanupPinch?.();
    };
  }, []);

  return (
    <div id="options" className={`overlay${state.optionsOpen ? " open" : ""}`}>
      <div ref={contentRef} className="overlay-content">
        <div className="options">
          {/* OptionsBar holds the chord controls plus the panel chrome: close ends
              its first row, the more-menu ends its second row. */}
          <div className="cv-options-header">
            <OptionsBar onHome={onHome} />
          </div>
          {!viewer && <SearchBar />}
        </div>
        {follower ? (
          <div className="cv-netdisplay-wrap">
            <button type="button" className="cv-netdisplay-btn" title="Open net display" onClick={() => store.openNetDisplay()}>
              <img className="cv-netdisplay-icon" src={icon("netdisplay.png")} alt="" />
              <span>Net display</span>
            </button>
          </div>
        ) : appWatching && !state.lockedToSession ? (
          <div className="cv-netdisplay-wrap">
            <button type="button" className="cv-netdisplay-btn" title="Stop following" onClick={() => void store.stopWatching()}>
              <img className="cv-netdisplay-icon" src={icon("stop.svg")} alt="" />
              <span>Stop following</span>
            </button>
          </div>
        ) : viewer ? null : editingPlaylist ? (
          <PlaylistEditor />
        ) : leaderLists ? (
          <LeaderPlaylistPicker />
        ) : (
          <SongList />
        )}
      </div>
    </div>
  );
}
