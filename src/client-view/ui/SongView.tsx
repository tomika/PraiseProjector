/**
 * SongView — read-only projection of the current display, with the page-turn
 * animation.
 *
 * Wraps the shared, Database-free `chordProAPI` bridge (chordpro/chordProApi)
 * rather than the heavier src/components/ChordProEditor.tsx, which imports the
 * Database and would break the servability boundary. The flip itself is the
 * shared, framework-agnostic {@link PageFlip} controller (chordpro/pageFlip),
 * the same one the desktop ChordProEditor drives — so there is one page-turn
 * implementation, not a copy per host.
 *
 * Three pages are stacked in a perspective container: the CURRENT page (the
 * projected song) and the PREV / NEXT neighbour pages sitting behind it. A
 * horizontal swipe — or the toolbar Prev/Next buttons via the imperative
 * {@link SongViewHandle} — rotates the current page around its edge in 3D,
 * revealing the neighbour, then advances the display. The neighbour list is the
 * controller's explicit navigation source.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useClientViewState, useClientViewStore } from "../controller/ClientViewContext";
import { isViewingRemoteDisplay } from "../controller/ClientViewStore";
import { chordProAPI } from "../../../chordpro/chordProApi";
import { PageFlip } from "../../../chordpro/pageFlip";
import {
  CHORDFORMAT_BB,
  CHORDFORMAT_INKEY,
  CHORDFORMAT_NOCHORDS,
  CHORDFORMAT_NOSECTIONDUP,
  CHORDFORMAT_SIMPLIFIED,
  CHORDFORMAT_SUBSCRIPT,
} from "../../../chordpro/chord_drawer";
import type { Display } from "../api/ClientApi";
import type { DisplaySettings, NavEntry, NavigationMode } from "../controller/ClientViewStore";
import { icon } from "./assets";

type BoundEditor = ReturnType<typeof chordProAPI.bind>;

const NAVIGATION_MODE_META: Record<NavigationMode, { icon: string; label: string }> = {
  database: { icon: "database.svg", label: "Song database navigation" },
  playlist: { icon: "playlist.svg", label: "Current playlist navigation" },
  filter: { icon: "magnifier.svg", label: "Filtered database navigation" },
  archive: { icon: "calendar.svg", label: "Archived playlist navigation" },
};

/** Imperative handle the toolbar uses so its Prev/Next buttons trigger the same
 *  animated turn as a swipe (instead of an instant, un-animated song change). */
export interface SongViewHandle {
  navigate(next: boolean): void;
}

// The guitar chord-box renderer (chordpro_editor.ts) only draws when a
// ChordSelector instance exists, and chordProApi.ensureChordSelector() creates
// one only if a #chordsel element is present. We mount it hidden so guitar/piano
// boxes render (piano works without it, but guitar requires it). Same markup the
// legacy client and src/components/ChordProEditor use.
const CHORDSEL_MARKUP = `
  <div id="chordsel" class="chordSelector" style="display: none;">
    <button id="closeSelector" type="button" class="chord-selector-close" aria-label="Close selector">&times;</button>
    <table style="width: 100%">
      <tr>
        <td>Base&nbsp;note</td><td><select id="baseNoteSel"></select></td>
        <td>&nbsp;&nbsp;Bass&nbsp;note</td><td><select id="bassNoteSel"></select></td>
      </tr>
      <tr><td>Chord</td><td colspan="3"><div><label id="customSpan" for="modifier"></label><select id="modifier"></select></div></td></tr>
      <tr><td>Symbol</td><td colspan="3"><input id="subscript" type="text" /></td></tr>
      <tr><td>Steps</td><td colspan="3"><div><label for="steps">1-</label><input id="steps" type="text" /></div></td></tr>
      <tr><td>Notes</td><td colspan="3"><div><label id="baseNoteSpan"></label><input id="notes" type="text" /></div></td></tr>
    </table>
    <table style="width: 100%;">
      <tr>
        <td style="height: 100px; width: 30%;"><div id="musicChordBox" style="max-width:100px; display: block;"></div><input type="button" id="applySelector" value="OK"></td>
        <td style="height: 100px; width: 42%;"><canvas id="pianoChordBox"></canvas></td>
        <td style="height: 100px; width: 28%;"><canvas id="guitarChordBox"></canvas></td>
      </tr>
    </table>
  </div>
`;

function buildChordFlags(s: DisplaySettings): number {
  let flags: number = s.chordMode;
  if (s.subscript) flags |= CHORDFORMAT_SUBSCRIPT;
  if (s.bb) flags |= CHORDFORMAT_BB;
  if (s.simplified) flags |= CHORDFORMAT_SIMPLIFIED;
  if (s.noSecChordDup) flags |= CHORDFORMAT_NOSECTIONDUP;
  if (s.autoTone) flags |= CHORDFORMAT_INKEY;
  return flags;
}

/**
 * Scale the whole editor (song canvas + title/meta overlays) as ONE unit via
 * `zoom`, so it fits the pane and the overlays stay aligned with the song and it
 * top-aligns like the original. FIT (full page) fits both dimensions; SCROLL
 * (full width) fits the width and lets the pane scroll vertically. Zoom is
 * cleared before measuring so the editor's natural rendered size is read.
 */
function fitAndZoom(host: HTMLDivElement, api: BoundEditor, scrollMode: boolean): void {
  const container = host.parentElement;
  if (container) container.classList.toggle("cv-scroll", scrollMode);
  host.style.removeProperty("zoom");
  api.fitToPane(scrollMode);
  const ew = host.offsetWidth || 1;
  const eh = host.offsetHeight || 1;
  const cw = container?.clientWidth || ew;
  const ch = container?.clientHeight || eh;
  const z = scrollMode ? cw / ew : Math.min(cw / ew, ch / eh);
  host.style.setProperty("zoom", String(z));
}

/** Render a song into an editor and fit it to its pane. Used for the neighbour
 *  pages; the current page uses the slightly richer effect below (transpose
 *  delta + highlight). Mirrors praiseprojector.ts displayChanged(). */
function renderSong(
  host: HTMLDivElement,
  api: BoundEditor,
  text: string,
  shift: number,
  settings: DisplaySettings,
  dark: boolean,
  scrollMode: boolean
): void {
  // suppressDraw: apply settings + transpose before the first paint; fitAndZoom()
  // below issues the single draw. Keeps preloaded neighbour pages flash-free too.
  api.load(text, false, undefined, undefined, true);
  const maxText = settings.maxText;
  const tagMode = maxText ? settings.zoomTagMode : "VISIBLE";
  const boxType = settings.chordBoxType === "NO_CHORDS" ? "" : settings.chordBoxType;
  const flags = settings.chordBoxType === "NO_CHORDS" ? CHORDFORMAT_NOCHORDS : buildChordFlags(settings);
  api.setDisplayMode(
    maxText ? !settings.zoomHideTitle : true,
    maxText ? !settings.zoomHideMeta : true,
    tagMode !== "HIDDEN",
    tagMode === "ABBREV",
    maxText,
    flags,
    boxType
  );
  if (shift !== 0) api.transpose(shift);
  api.darkMode(dark);
  fitAndZoom(host, api, scrollMode);
}

export const SongView = forwardRef<SongViewHandle, { display: Display; settings: DisplaySettings; dark: boolean }>(function SongView(
  { display, settings, dark },
  ref
) {
  const store = useClientViewStore();
  const state = useClientViewState();
  const { optionsOpen, showInstructions, highlightOn, highlightControl, highlightOpacity } = state;
  const canUsePlaylistNavigation = store.canUsePlaylistNavigation();
  const canAddCurrentSongToPlaylist = store.currentSongCanBeAddedToPlaylist();
  const hasSongText = !!display.song?.trim();
  const playlistReturnTitle = canUsePlaylistNavigation
    ? "Return to current song in playlist navigation"
    : state.playlist.length === 0
      ? "Current playlist is empty"
      : "Playlist navigation is unavailable";

  const swipeRef = useRef<HTMLDivElement>(null);
  const currentPageRef = useRef<HTMLDivElement>(null);
  const prevPageRef = useRef<HTMLDivElement>(null);
  const nextPageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const prevHostRef = useRef<HTMLDivElement>(null);
  const nextHostRef = useRef<HTMLDivElement>(null);

  const apiRef = useRef<BoundEditor | null>(null);
  const prevApiRef = useRef<BoundEditor | null>(null);
  const nextApiRef = useRef<BoundEditor | null>(null);

  const loadedTextRef = useRef<string | null>(null);
  const appliedTransposeRef = useRef(0);
  const scrollModeRef = useRef(false);
  const [navigationActionsHidden, setNavigationActionsHidden] = useState(false);

  // The shared page-turn controller (chordpro/pageFlip), the same one the desktop
  // ChordProEditor drives. Created in an effect so its config closures — which
  // read the stable refs/store — are never evaluated during render; they see live
  // state on every gesture.
  const flipRef = useRef<PageFlip | null>(null);
  useEffect(() => {
    const flip = new PageFlip({
      container: () => swipeRef.current,
      currentPage: () => currentPageRef.current,
      prevPage: () => prevPageRef.current,
      nextPage: () => nextPageRef.current,
      hasNeighbour: (next) => !!store.neighbourEntry(next),
      onAdvance: (next) => void (next ? store.nextSong() : store.prevSong()),
      // The client uses `visibility` (not `display`) so the neighbour stays laid
      // out and measurable behind the opaque current page.
      setNeighbourVisible: (page, visible) => {
        page.style.visibility = visible ? "visible" : "hidden";
      },
      // Stop un-clipping at the full-view box; the page rotates within it.
      isFlipBoundary: (el) => el.id === "mainView",
      // In split landscape the song pane must keep clipping the revealed
      // neighbour, but the turning page itself may overlap the options panel.
      liftCurrentPageDuringFlip: () => true,
      // No page-turn navigation in view-only mode: a plain Client follower, or App
      // mode while watching a session. Mirrors MainToolbar hiding btnPrev/btnNext
      // (legacy setLeader(false)/ppdWatchMode). Read live state so a mid-session
      // capability/leader-mode change takes effect without rebuilding the flip.
      canFlip: () => {
        const s = store.getSnapshot();
        return !isViewingRemoteDisplay(s);
      },
      isInteractive: () => !apiRef.current?.isInMarkingState(),
      isChordSelectorOpen: () => !!apiRef.current?.hasChordSelectorOpen(),
      onFlipActiveChange: setNavigationActionsHidden,
    });
    flipRef.current = flip;
    return () => {
      flip.dispose();
      flipRef.current = null;
    };
  }, [store]);

  useImperativeHandle(ref, () => ({ navigate: (next: boolean) => flipRef.current?.turn(next) }), []);

  // Track landscape orientation. In closed-landscape the main toolbar sits as a
  // vertical bar on the RIGHT (see client-view.css) and the song pane is
  // wide-and-short, where fit-page would shrink the song to nothing — so that
  // layout forces full-width SCROLL mode (see the display effect below).
  const [landscape, setLandscape] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(orientation: landscape)").matches);
  useEffect(() => {
    const mql = window.matchMedia?.("(orientation: landscape)");
    if (!mql) return;
    const onChange = () => setLandscape(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  // "Toolbar on the right" ⟺ landscape AND options closed (matches the
  // `@media (orientation: landscape) #mainView:not(.options-open)` CSS rule).
  const toolbarOnRight = landscape && !optionsOpen;
  // Closed-landscape (toolbar on the right) forces full-width SCROLL geometry
  // regardless of the user's zoom preset; otherwise honour the zoom setting.
  const scrollMode = toolbarOnRight || (settings.maxText && settings.zoomScrollable);
  // Mirror into a ref the once-bound ResizeObserver can read.
  useEffect(() => {
    scrollModeRef.current = scrollMode;
  }, [scrollMode]);

  // Pointer plumbing: forward swipe gestures to the shared controller. We do NOT
  // setPointerCapture — capturing on #swipe-handler would steal taps from the
  // editor canvas inside it and break the editor's lyrics-hit (highlight) handler.
  // Instead, once a swipe starts anywhere in the pane, track that pointer on
  // window so margins/overlays around the rendered ChordPro canvas keep swiping.
  useEffect(() => {
    const el = swipeRef.current;
    if (!el) return;
    let pointerId: number | null = null;
    const clearSelection = () => window.getSelection()?.removeAllRanges();
    const stopTracking = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      document.documentElement.classList.remove(PageFlip.SELECTION_GUARD_CLASS);
      clearSelection();
    };
    const down = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      pointerId = e.pointerId;
      document.documentElement.classList.add(PageFlip.SELECTION_GUARD_CLASS);
      clearSelection();
      flipRef.current?.handlePointer("down", e);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    };
    const move = (e: PointerEvent) => {
      if (!e.isPrimary || pointerId !== e.pointerId) return;
      e.preventDefault();
      clearSelection();
      flipRef.current?.handlePointer("move", e);
    };
    const up = (e: PointerEvent) => {
      if (pointerId !== e.pointerId) return;
      pointerId = null;
      stopTracking();
      flipRef.current?.handlePointer("up", e);
    };
    const cancel = (e: PointerEvent) => {
      if (pointerId !== e.pointerId) return;
      pointerId = null;
      stopTracking();
      flipRef.current?.cancel();
    };
    el.addEventListener("pointerdown", down);
    return () => {
      el.removeEventListener("pointerdown", down);
      stopTracking();
    };
  }, []);

  // ── editors: bind the three pages once; re-fit all on pane resize ─────────────
  useEffect(() => {
    const host = hostRef.current;
    const pane = swipeRef.current;
    if (!host || !pane) return;
    apiRef.current = chordProAPI.bind(host);
    if (prevHostRef.current) prevApiRef.current = chordProAPI.bind(prevHostRef.current);
    if (nextHostRef.current) nextApiRef.current = chordProAPI.bind(nextHostRef.current);

    // Re-fit + re-zoom on pane resize / orientation change. Observe the PANE
    // (the perspective container), not the zoomed hosts (which would feed back
    // into the observer and loop).
    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (apiRef.current && hostRef.current) fitAndZoom(hostRef.current, apiRef.current, scrollModeRef.current);
        if (prevApiRef.current && prevHostRef.current) fitAndZoom(prevHostRef.current, prevApiRef.current, scrollModeRef.current);
        if (nextApiRef.current && nextHostRef.current) fitAndZoom(nextHostRef.current, nextApiRef.current, scrollModeRef.current);
      });
    });
    observer.observe(pane);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
      apiRef.current?.dispose();
      prevApiRef.current?.dispose();
      nextApiRef.current?.dispose();
      apiRef.current = prevApiRef.current = nextApiRef.current = null;
      loadedTextRef.current = null;
    };
  }, []);

  // ── current page: reflect display + render-setting changes ────────────────────
  // Reload only when the song text changes; re-apply display flags and highlight
  // on every change (cheap). Mirrors praiseprojector.ts displayChanged().
  useEffect(() => {
    const api = apiRef.current;
    const host = hostRef.current;
    if (!api || !host) return;
    const text = display.song ?? "";
    if (!text) {
      // Nothing projected: clear the editor so stale song content cannot remain
      // visible under the empty-state hint.
      if (loadedTextRef.current !== "") api.load("", false);
      loadedTextRef.current = "";
      appliedTransposeRef.current = 0;
      host.style.removeProperty("zoom");
      api.highlight(0, 0);
      api.setLyricsHitHandler(null);
      return;
    }
    if (loadedTextRef.current !== text) {
      loadedTextRef.current = text;
      // Construct without an initial paint (suppressDraw) so transpose/capo and
      // display settings are applied before the first draw — the closing
      // fitAndZoom() below draws once. Without this the editor briefly paints the
      // untransposed song (a one-frame flash on every song switch).
      api.load(text, false, undefined, undefined, true);
      // A freshly loaded document starts at shift 0.
      appliedTransposeRef.current = 0;
    }
    // The editor's net shift is the manual transpose minus the capo: a capo on
    // fret N displays the chords N semitones lower (praiseprojector.ts capoChanged
    // applies the same delta). chordProAPI.transpose() is relative, so apply only
    // the delta from what is already applied.
    const activeCapo = settings.useCapo ? Math.max(display.capo ?? 0, 0) : 0;
    const wantShift = (display.transpose ?? 0) - activeCapo;
    const shiftDelta = wantShift - appliedTransposeRef.current;
    if (shiftDelta !== 0) {
      api.transpose(shiftDelta);
      appliedTransposeRef.current = wantShift;
    }
    // maxText (zoom) applies the user's zoom preset; otherwise show full title /
    // meta / tags. Mirrors praiseprojector.ts displayChanged().
    const maxText = settings.maxText;
    const tagMode = maxText ? settings.zoomTagMode : "VISIBLE";
    // NO_CHORDS is a pseudo box-type: hide chords entirely with an empty box.
    const boxType = settings.chordBoxType === "NO_CHORDS" ? "" : settings.chordBoxType;
    const flags = settings.chordBoxType === "NO_CHORDS" ? CHORDFORMAT_NOCHORDS : buildChordFlags(settings);
    api.setDisplayMode(
      maxText ? !settings.zoomHideTitle : true,
      maxText ? !settings.zoomHideMeta : true,
      tagMode !== "HIDDEN",
      tagMode === "ABBREV",
      maxText, // autoSplit long lines in zoom mode
      flags,
      boxType
    );
    api.darkMode(dark);
    // Instructions: set the text on the editor, then toggle the overlay via the
    // render mode (legacy displayChanged → enableInstructionRendering): "FULL" in
    // scroll mode, "FIRST_LINE" in fit mode, "" off. Re-applied on every load
    // since api.load() rebuilds the editor instance. fitAndZoom redraws, so
    // draw=false here is enough.
    api.applyInstructions(display.instructions ?? "", false);
    api.enableInstructionRendering(showInstructions ? (scrollMode ? "FULL" : "FIRST_LINE") : "", false);
    // Scale the editor as a unit to fit the pane (full page) or fit width + scroll.
    fitAndZoom(host, api, scrollMode);
    // Show the display's highlighted range only when highlight is on (legacy chkHighlight).
    if (highlightOn) {
      api.highlight(display.from ?? 0, display.to ?? 0);
    } else {
      api.highlight(0, 0);
    }
    // Leader highlight control: while on, a tap on a lyrics section pushes its
    // {from,to,section} as the display highlight. Re-installed after each load.
    api.setLyricsHitHandler(highlightControl ? (hit) => void store.pushHighlight(hit.from, hit.to, hit.section) : null);
    // If this load completed a page turn, drop the rotated-away page on top of the
    // revealed neighbour (a no-op when no turn is pending).
    requestAnimationFrame(() => flipRef.current?.finishPending());
  }, [display, settings, dark, scrollMode, showInstructions, highlightOn, highlightControl, store]);

  // ── neighbour pages: preload prev/next for the flip reveal ────────────────────
  useEffect(() => {
    let cancelled = false;
    const load = async (entry: NavEntry | undefined, host: HTMLDivElement | null, api: BoundEditor | null) => {
      if (!api || !host) return;
      if (!entry) {
        api.load("", false);
        host.style.removeProperty("zoom");
        return;
      }
      try {
        const data = await store.getSongData(entry.songId);
        if (cancelled) return;
        const shift = (entry.transpose ?? 0) - (settings.useCapo ? Math.max(entry.capo ?? 0, 0) : 0);
        renderSong(host, api, data.text, shift, settings, dark, scrollMode);
      } catch {
        /* a neighbour that fails to load simply won't reveal during a flip */
      }
    };
    void load(store.neighbourEntry(false), prevHostRef.current, prevApiRef.current);
    void load(store.neighbourEntry(true), nextHostRef.current, nextApiRef.current);
    return () => {
      cancelled = true;
    };
  }, [
    display.songId,
    state.navigationMode,
    state.songs,
    state.searchResults,
    state.playlist,
    state.leaderProfiles,
    state.selectedLeaderId,
    state.selectedPlaylistLabel,
    settings,
    dark,
    scrollMode,
    store,
  ]);

  // Push highlight opacity to all three editor instances immediately when it
  // changes (triggered by the opacity slider dialog), then redraw the current
  // page. Neighbour pages don't show highlights but we sync them so they stay
  // accurate when they become current after a page turn.
  useEffect(() => {
    apiRef.current?.setHighlightOpacity(highlightOpacity);
    prevApiRef.current?.setHighlightOpacity(highlightOpacity);
    nextApiRef.current?.setHighlightOpacity(highlightOpacity);
    apiRef.current?.update();
  }, [highlightOpacity]);

  return (
    <div id="swipe-handler" className="pp-flip-perspective" ref={swipeRef}>
      {/* Prev/next pages sit behind the current page and are revealed as it
          rotates away during a page turn (mirrors praiseprojector.ts). */}
      <div className="cv-page cv-page-prev" ref={prevPageRef}>
        <div className="editor" ref={prevHostRef} tabIndex={-1} />
      </div>
      <div className="cv-page cv-page-next" ref={nextPageRef}>
        <div className="editor" ref={nextHostRef} tabIndex={-1} />
      </div>
      <div className="cv-page cv-page-current" ref={currentPageRef}>
        <div className="editor" id="editor" ref={hostRef} tabIndex={-1} />
      </div>
      {!hasSongText && (
        <div className="cv-empty-state">
          <p className="cv-empty-title">No song selected</p>
          <p className="cv-empty-hint">Tap the options icon to search and pick a song.</p>
        </div>
      )}
      <div
        className={`cv-navigation-actions${navigationActionsHidden || (state.navigationMode === "playlist" && !canAddCurrentSongToPlaylist) ? " cv-navigation-actions-hidden" : ""}`}
      >
        {" "}
        <button
          type="button"
          className={`cv-navigation-mode${canUsePlaylistNavigation ? "" : " cv-navigation-mode-disabled"}`}
          title={playlistReturnTitle}
          aria-label={playlistReturnTitle}
          aria-disabled={!canUsePlaylistNavigation}
          onClick={() => {
            if (canUsePlaylistNavigation) void store.returnCurrentSongToPlaylistNavigation();
          }}
        >
          <img src={icon(NAVIGATION_MODE_META[state.navigationMode].icon)} alt="" />
        </button>
        {canAddCurrentSongToPlaylist && (
          <button
            type="button"
            className="cv-navigation-mode cv-navigation-add-current cv-play-btn"
            title="Add current song to playlist and project it"
            aria-label="Add current song to playlist and project it"
            onClick={() => void store.addCurrentSongToPlaylistAndProject()}
          >
            ▶
          </button>
        )}
      </div>
      {/* Hidden chord-selector host required by the guitar chord-box renderer. */}
      <div dangerouslySetInnerHTML={{ __html: CHORDSEL_MARKUP }} />
    </div>
  );
});
