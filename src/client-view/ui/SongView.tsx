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

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  useClientPerformancePreferences,
  useClientPerformanceProfile,
  useClientViewState,
  useClientViewStore,
} from "../controller/ClientViewContext";
import { isViewingRemoteDisplay } from "../controller/ClientViewStore";
import { recordChordProRenderDuration } from "../../shared/clientPerformanceProfile";
import { resolvePerformanceFeature } from "../../shared/performanceSettings";
import { chordProAPI } from "../../../chordpro/chordProApi";
import { findLargestLargerFittingFontSize, scaleFitWidthMetric } from "../../../chordpro/layout/auto-font-size";
import { PageFlip } from "../../../chordpro/pageFlip";
import {
  CHORDFORMAT_BB,
  CHORDFORMAT_INKEY,
  CHORDFORMAT_NOCHORDS,
  CHORDFORMAT_NOSECTIONDUP,
  CHORDFORMAT_SIMPLIFIED,
  CHORDFORMAT_SUBSCRIPT,
} from "../../../chordpro/chord_drawer";
import type { ChordProEditorOptions } from "../../../chordpro/chordpro_editor";
import type { ChordProStylesSettings } from "../../../chordpro/chordpro_styles";
import type { Display } from "../api/ClientApi";
import type { DisplaySettings, NavEntry, NavigationMode, ZoomSizingMode } from "../controller/ClientViewStore";
import { icon } from "./assets";
import { shouldUsePagingLayout } from "../../utils/viewLayout";
import { ZOOM_MODE_ROTATION, ZoomSizingModeGlyph, type ZoomSizingModeMeta } from "./zoomSizingModes";

type BoundEditor = ReturnType<typeof chordProAPI.bind>;
const fitGenerations = new WeakMap<HTMLDivElement, number>();
const CLIENT_VIEW_EDITOR_OPTIONS: ChordProEditorOptions = { viewportAlignedTitle: true };

interface FitVisualState {
  readonly width: string;
  readonly transform: string;
  readonly transformOrigin: string;
  readonly marginBottom: string;
  readonly scrollTop: number;
}

interface PendingTurnFit {
  readonly songId: string;
  readonly visual: FitVisualState;
}

// A decisively vertical drag on the song pane (past the slop, and more vertical
// than horizontal) is claimed by the axis lock below purely so it can never also
// turn into a page flip mid-gesture; the page then either scrolls (if it
// overflows) or the gesture is simply inert. See the pointer-plumbing effect.
const GESTURE_SLOP_PX = 8;
const ZOOM_PINCH_PIXELS_PER_STEP = 28;
const MAX_AUTO_FONT_SIZE = 256;

const NAVIGATION_MODE_META: Record<NavigationMode, { icon: string; label: string }> = {
  database: { icon: "database.svg", label: "Song database navigation" },
  playlist: { icon: "playlist.svg", label: "Current playlist navigation" },
  filter: { icon: "magnifier.svg", label: "Filtered database navigation" },
  archive: { icon: "calendar.svg", label: "Archived playlist navigation" },
};

const isWidePaneViewport = (): boolean => typeof window !== "undefined" && !shouldUsePagingLayout(window.innerWidth, window.innerHeight);

function isInsideChordSelector(target: EventTarget | null, root: HTMLElement): boolean {
  return target instanceof Element && !!target.closest(".chordSelector") && root.contains(target);
}

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

function advanceFitGeneration(host: HTMLDivElement): number {
  const generation = (fitGenerations.get(host) ?? 0) + 1;
  fitGenerations.set(host, generation);
  return generation;
}

/** Clear any scaling this module applied to an editor host, restoring its natural
 *  (unscaled) layout so it can be blanked. Also drops the pending-fit hide below,
 *  so a host cleared for reuse is never left invisible. */
function clearFit(host: HTMLDivElement): number {
  const generation = advanceFitGeneration(host);
  host.style.removeProperty("width");
  host.style.removeProperty("transform");
  host.style.removeProperty("transform-origin");
  host.style.removeProperty("margin-bottom");
  host.style.removeProperty("visibility");
  host.style.removeProperty("opacity");
  return generation;
}

function captureFitVisualState(host: HTMLDivElement): FitVisualState {
  return {
    width: host.style.width,
    transform: host.style.transform,
    transformOrigin: host.style.transformOrigin,
    marginBottom: host.style.marginBottom,
    scrollTop: host.parentElement?.scrollTop ?? 0,
  };
}

function applyFitVisualState(host: HTMLDivElement, state: FitVisualState): void {
  host.style.width = state.width;
  host.style.transform = state.transform;
  host.style.transformOrigin = state.transformOrigin;
  host.style.marginBottom = state.marginBottom;
  if (host.parentElement) host.parentElement.scrollTop = state.scrollTop;
}

/**
 * Scale the whole editor (song + title/meta overlays) as ONE unit so it fits the
 * pane and the overlays stay aligned with the song and it top-aligns like the
 * original. FIT (full page) fits both dimensions; SCROLL (full width) fits the
 * width and lets the pane scroll vertically.
 *
 * A HOST IS NEVER PAINTED UNFITTED. The DOM backend settles asynchronously
 * (measurement, web fonts, ABC) but makes its root visible on its FIRST commit,
 * so anything that leaves the host without a transform in between gets a frame
 * of the song at natural size — the page-turn flash. Two rules prevent it:
 * the previous transform is KEPT until the new one is computed (unlike the old
 * canvas path, this cannot affect the measurement: the size comes from the
 * renderer's logical snapshot, and `cw`/`ch` come from a `.cv-page`, which either
 * clips or reserves a stable scrollbar gutter), and a host with no transform to
 * keep is hidden until its first fit lands. `visibility` (not `display`) so the
 * renderer still measures a real viewport width.
 *
 * We scale with `transform: scale()`, NOT `zoom`. `zoom` scales the layout box in
 * Chromium but not in Firefox (which keeps the box at its unzoomed size and paints
 * the scaled content in its top-left corner), so `zoom` mis-placed the song in
 * Firefox. We also centre horizontally with an explicit, MEASURED `translateX`
 * rather than `text-align`/`transform-origin`: when the song's natural width
 * exceeds the pane the engines disagree on where an over-wide inline-block sits
 * (Firefox clamps it to the start edge), so centring by origin scaled about the
 * wrong point and the song drifted right. `.cv-page` pins the editor's left edge at
 * the pane's left, so the scaled width `ew*z` is centred by translating it right by
 * `(cw - ew*z) / 2`. Origin is top-left so the translate is in un-scaled pane
 * pixels and the song stays top-aligned. Because `transform` never affects the
 * layout box, we compensate the block size with a margin so the `.cv-scroll`
 * container measures the SCALED height and scrolls a tall full-width song correctly
 * (a no-op in clipped full-page mode).
 */
async function settledSnapshot(api: BoundEditor) {
  const snapshot = api.getLayoutSnapshot();
  return snapshot.settled ? snapshot : api.whenLayoutSettled();
}

/**
 * Apply a renderer mutation and wait for its frame. A very large auto-wrap
 * trial can leave no usable line width after scaled margins/tag lanes. The
 * renderer correctly leaves that layout pending, but waiting for settlement in
 * that case would never finish because there is no geometry to commit. Treat a
 * frame with no new revision as a non-fitting trial instead.
 */
async function snapshotAfterUpdate(api: BoundEditor, update: () => void) {
  const before = api.getLayoutSnapshot();
  update();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const after = api.getLayoutSnapshot();
  if (!after.settled && after.revision === before.revision) return null;
  return after.settled ? after : api.whenLayoutSettled(before.revision);
}

async function fitAndZoom(
  host: HTMLDivElement,
  api: BoundEditor,
  sizingMode: ZoomSizingMode,
  requestedFontSize: number,
  autoWrap: boolean,
  fitViewport?: HTMLElement | null
): Promise<boolean> {
  try {
    return await fitAndZoomInternal(host, api, sizingMode, requestedFontSize, autoWrap, fitViewport);
  } catch {
    // A page can be disposed while its asynchronous DOM layout is settling.
    host.style.removeProperty("visibility");
    host.style.removeProperty("opacity");
    return false;
  }
}

/**
 * Auto wrap makes FIT_PAGE and FIT_WIDTH share one height-filling geometry.
 * Leaving FIT_WIDTH in scroll mode would reserve its stable scrollbar gutter,
 * narrowing the wrap boundary enough to produce different line breaks and font
 * search results. Manual sizing still scrolls, as does plain unwrapped
 * FIT_WIDTH.
 */
function usesVerticalScroll(sizingMode: ZoomSizingMode, autoWrap: boolean): boolean {
  return sizingMode === "MANUAL" || (sizingMode === "FIT_WIDTH" && !autoWrap);
}

async function fitAndZoomInternal(
  host: HTMLDivElement,
  api: BoundEditor,
  sizingMode: ZoomSizingMode,
  requestedFontSize: number,
  autoWrap: boolean,
  fitViewport?: HTMLElement | null
): Promise<boolean> {
  const scrollMode = usesVerticalScroll(sizingMode, autoWrap);
  const manualFontSize = sizingMode === "MANUAL";
  const automaticFontGrowth = autoWrap && !manualFontSize;
  const container = host.parentElement;
  if (container) {
    container.classList.toggle("cv-scroll", scrollMode);
    container.classList.toggle("cv-line-wrap", autoWrap);
  }
  if (fitViewport && fitViewport !== container && fitViewport.classList.contains("cv-page")) {
    fitViewport.classList.toggle("cv-scroll", scrollMode);
    fitViewport.classList.toggle("cv-line-wrap", autoWrap);
  }
  // The current page is temporarily lifted and unclipped while it turns. Measure
  // against an unlifted sibling page so the scrollbar gutter and content box are
  // identical before and after the page swap.
  const cw = fitViewport?.clientWidth || container?.clientWidth || 1;
  const ch = fitViewport?.clientHeight || container?.clientHeight || 1;
  const generation = advanceFitGeneration(host);
  // Wrapped layout always needs the pane width as its line-breaking boundary,
  // including FIT_PAGE where the final composite may subsequently scale down.
  if (scrollMode || autoWrap) host.style.width = `${cw}px`;
  else host.style.removeProperty("width");
  if (automaticFontGrowth) host.style.opacity = "0";
  else if (!host.style.transform) host.style.visibility = "hidden";
  // Automatic modes first need the unwrapped natural layout to establish the
  // existing FIT_WIDTH visual font. MANUAL can apply its independent wrapping
  // immediately because its requested font size must never be changed.
  api.setLineWrapping(manualFontSize && autoWrap, manualFontSize && autoWrap, false);
  api.setContentFontSize(manualFontSize ? requestedFontSize : null, false);
  api.fitToPane(scrollMode, { width: cw, height: ch });
  let finalSnapshot = await settledSnapshot(api);
  // A resize and the React display effect can start two fits in the same frame.
  // They share one mutable editor, so a superseded fit must stop before it
  // switches auto wrapping/font size below. Otherwise the stale fit can
  // overwrite the active fit's state, leaving the host hidden with its previous
  // transform (or revealing that stale, over-large transform).
  if (fitGenerations.get(host) !== generation) return false;

  const scaledFitWidthHeight = (snapshot: ReturnType<BoundEditor["getLayoutSnapshot"]>) => scaleFitWidthMetric(snapshot.height, cw, snapshot.width);

  if (automaticFontGrowth) {
    const naturalFontSize = api.getContentFontSize();
    const fitWidthFontSize = Math.max(6, Math.ceil(scaleFitWidthMetric(naturalFontSize, cw, finalSnapshot.width)));
    api.setLineWrapping(true, false, false);
    api.setContentFontSize(fitWidthFontSize, false);
    api.update();
    const wrappedFitWidthSnapshot = await settledSnapshot(api);
    if (fitGenerations.get(host) !== generation) return false;
    finalSnapshot = wrappedFitWidthSnapshot;

    if (scaledFitWidthHeight(wrappedFitWidthSnapshot) <= ch - 1) {
      const fittedFontSize = await findLargestLargerFittingFontSize({
        base: fitWidthFontSize,
        max: Math.max(MAX_AUTO_FONT_SIZE, fitWidthFontSize),
        isCancelled: () => fitGenerations.get(host) !== generation,
        fits: async (candidate) => {
          const snapshot = await snapshotAfterUpdate(api, () => {
            api.setContentFontSize(candidate, false);
            api.update();
          });
          return snapshot !== null && scaledFitWidthHeight(snapshot) <= ch - 1;
        },
      });
      if (fitGenerations.get(host) !== generation) return false;
      api.setContentFontSize(fittedFontSize ?? fitWidthFontSize, false);
      api.update();
      finalSnapshot = await settledSnapshot(api);
    }
  }
  const applySnapshot = (snapshot: ReturnType<BoundEditor["getLayoutSnapshot"]>) => {
    if (fitGenerations.get(host) !== generation || !snapshot.width || !snapshot.height) return false;
    const ew = snapshot.width;
    const eh = snapshot.height;
    const z = manualFontSize ? 1 : scrollMode ? cw / ew : Math.min(cw / ew, ch / eh);
    const tx = (cw - ew * z) / 2;
    api.setViewportAlignedTitleGeometry(cw / z, tx / z);
    host.style.transformOrigin = "top left";
    host.style.transform = `translateX(${tx}px) scale(${z})`;
    if (manualFontSize) host.style.removeProperty("margin-bottom");
    else host.style.marginBottom = `${eh * (z - 1)}px`;
    host.style.removeProperty("visibility");
    host.style.removeProperty("opacity");
    return true;
  };

  if (fitGenerations.get(host) !== generation) return false;
  // Nothing to scale from yet. Keep whatever transform is already on the host —
  // a page turn hands over the revealed neighbour's, a re-fit keeps its own — and
  // hide the host outright if it has none, rather than let the renderer's first
  // commit paint the song at natural size.
  return applySnapshot(finalSnapshot);
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
  chordProStyles: ChordProStylesSettings | null,
  dark: boolean,
  sizingMode: ZoomSizingMode,
  fitViewport?: HTMLElement | null
): void {
  // suppressDraw: apply settings + transpose before the first paint; fitAndZoom()
  // below issues the single draw. Keeps preloaded neighbour pages flash-free too.
  api.load(text, false, undefined, undefined, true, CLIENT_VIEW_EDITOR_OPTIONS);
  api.setStyles(chordProStyles, false);
  const maxText = settings.maxText;
  const tagMode = maxText ? settings.zoomTagMode : "VISIBLE";
  const boxType = settings.chordBoxType === "NO_CHORDS" ? "" : settings.chordBoxType;
  const flags = settings.chordBoxType === "NO_CHORDS" ? CHORDFORMAT_NOCHORDS : buildChordFlags(settings);
  const autoWrap = maxText && settings.zoomAutoWrap;
  api.setDisplayMode(
    maxText ? !settings.zoomHideTitle : true,
    maxText ? !settings.zoomHideMeta : true,
    tagMode !== "HIDDEN",
    tagMode === "ABBREV",
    autoWrap,
    flags,
    boxType,
    autoWrap && sizingMode === "MANUAL"
  );
  if (shift !== 0) api.transpose(shift);
  api.darkMode(dark);
  void fitAndZoom(host, api, sizingMode, settings.zoomFontSize, autoWrap, fitViewport);
}

function getDisplayChordProStyles(display: Display): ChordProStylesSettings | null {
  const styles = display.chordProStyles;
  if (!styles || typeof styles !== "object" || !("light" in styles) || !("dark" in styles)) return null;
  return styles as ChordProStylesSettings;
}

export const SongView = forwardRef<SongViewHandle, { display: Display; settings: DisplaySettings; dark: boolean }>(function SongView(
  { display, settings, dark },
  ref
) {
  const store = useClientViewStore();
  const state = useClientViewState();
  const performanceProfile = useClientPerformanceProfile();
  const performancePreferences = useClientPerformancePreferences();
  const pageTurnEnabled = resolvePerformanceFeature(performancePreferences.clientViewPageTurnMode, performanceProfile.chordProSlow);
  const neighbourPreloadingEnabled = pageTurnEnabled;
  const { optionsOpen, showInstructions, highlightOn, highlightControl, highlightOpacity } = state;
  const viewingRemoteDisplay = isViewingRemoteDisplay(state);
  const canUsePlaylistNavigation = store.canUsePlaylistNavigation();
  const canAddCurrentSongToPlaylist = store.currentSongCanBeAddedToPlaylist();
  const hasSongText = !!display.song?.trim();
  // display_query parses fresh arrays/objects on every response. Derive stable
  // structural values so unchanged repeat/style payloads retain identity.
  const chordProStylesJson = JSON.stringify(getDisplayChordProStyles(display));
  const sectionRepeatCountsJson = JSON.stringify(display.sectionRepeatCounts ?? null);
  const chordProStyles = useMemo(() => (JSON.parse(chordProStylesJson) as ChordProStylesSettings | null) ?? null, [chordProStylesJson]);
  const sectionRepeatCounts = useMemo(
    () => (JSON.parse(sectionRepeatCountsJson) as Display["sectionRepeatCounts"] | null) ?? undefined,
    [sectionRepeatCountsJson]
  );
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
  const appliedStylesRef = useRef<ChordProStylesSettings | null | undefined>(undefined);
  const appliedTransposeRef = useRef(0);
  const sizingModeRef = useRef<ZoomSizingMode>("FIT_PAGE");
  const zoomFontSizeRef = useRef(settings.zoomFontSize);
  const autoWrapRef = useRef(false);
  const pinchActiveRef = useRef(false);
  const pinchSuppressPointerRef = useRef(false);
  const pendingTurnFitRef = useRef<PendingTurnFit | null>(null);
  const pageTurnEnabledRef = useRef(pageTurnEnabled);
  const zoomModeToastTimerRef = useRef<number | null>(null);
  // True from the moment a page starts rotating until the controller has reset it
  // and re-hidden the neighbours. Two things depend on it: the navigation actions
  // fade out, and neighbour preloading waits (see the neighbour effect).
  const [flipActive, setFlipActive] = useState(false);
  const [zoomModeToast, setZoomModeToast] = useState<ZoomSizingModeMeta | null>(null);

  const showZoomModeToast = useCallback((mode: ZoomSizingModeMeta) => {
    if (zoomModeToastTimerRef.current !== null) window.clearTimeout(zoomModeToastTimerRef.current);
    setZoomModeToast(mode);
    zoomModeToastTimerRef.current = window.setTimeout(() => {
      zoomModeToastTimerRef.current = null;
      setZoomModeToast(null);
    }, 1000);
  }, []);

  const rotateZoomMode = useCallback(
    (direction: -1 | 1) => {
      const displaySettings = store.getSnapshot().displaySettings;
      const currentValue = displaySettings.maxText ? displaySettings.zoomSizingMode : null;
      const currentIndex = Math.max(
        0,
        ZOOM_MODE_ROTATION.findIndex((mode) => mode.value === currentValue)
      );
      const nextMode = ZOOM_MODE_ROTATION[(currentIndex + direction + ZOOM_MODE_ROTATION.length) % ZOOM_MODE_ROTATION.length];
      store.setZoomMode(nextMode.value);
      showZoomModeToast(nextMode);
    },
    [showZoomModeToast, store]
  );

  useEffect(
    () => () => {
      if (zoomModeToastTimerRef.current !== null) window.clearTimeout(zoomModeToastTimerRef.current);
    },
    []
  );

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
      onAdvance: (next) => {
        const entry = store.neighbourEntry(next);
        const source = next ? nextHostRef.current : prevHostRef.current;
        pendingTurnFitRef.current = entry && source?.style.transform ? { songId: entry.songId, visual: captureFitVisualState(source) } : null;
        void (next ? store.nextSong() : store.prevSong());
      },
      // The client uses `visibility` (not `display`) so the neighbour stays laid
      // out and measurable behind the opaque current page.
      setNeighbourVisible: (page, visible) => {
        page.style.visibility = visible ? "visible" : "hidden";
      },
      // Stop un-clipping at the full-view box; the page rotates within it.
      isFlipBoundary: (el) => el.id === "mainView",
      // In split pane layout the song pane must keep clipping the revealed
      // neighbour, but the turning page itself may overlap the options panel.
      liftCurrentPageDuringFlip: () => true,
      // No page-turn navigation in view-only mode: a plain Client follower, or App
      // mode while watching a session. Mirrors MainToolbar hiding btnPrev/btnNext
      // (legacy setLeader(false)/ppdWatchMode). Read live state so a mid-session
      // capability/leader-mode change takes effect without rebuilding the flip.
      // NOTE: deliberately independent of the performance preference — on a slow
      // device the swipe must still navigate (see animateTurn below).
      canFlip: () => {
        const s = store.getSnapshot();
        return !isViewingRemoteDisplay(s);
      },
      // The performance preference only governs the ANIMATION (and, with it, the
      // pre-rendered neighbour pages). Off ⇒ the horizontal swipe advances the
      // song instantly instead of rotating a page.
      animateTurn: () => pageTurnEnabledRef.current,
      isInteractive: () => !apiRef.current?.isInMarkingState(),
      isChordSelectorOpen: () => !!apiRef.current?.hasChordSelectorOpen(),
      handleChordBoxTouch: (e, down) => apiRef.current?.handleExternalChordBoxTouch(e, down, true) ?? false,
      onFlipActiveChange: setFlipActive,
    });
    flipRef.current = flip;
    return () => {
      flip.dispose();
      flipRef.current = null;
    };
  }, [store]);

  useEffect(() => {
    pageTurnEnabledRef.current = pageTurnEnabled;
    if (pageTurnEnabled) return;
    flipRef.current?.cancel();
    pendingTurnFitRef.current = null;
  }, [pageTurnEnabled]);

  useImperativeHandle(
    ref,
    () => ({
      navigate: (next: boolean) => {
        if (!pageTurnEnabled) void (next ? store.nextSong() : store.prevSong());
        else flipRef.current?.turn(next);
      },
    }),
    [pageTurnEnabled, store]
  );

  // Track the shared paging/pane breakpoint. In closed wide-pane layout the main toolbar sits as a
  // vertical bar on the RIGHT (see client-view.css) and the song pane is
  // wide-and-short, where fit-page would shrink the song to nothing — so that
  // layout forces full-width SCROLL mode (see the display effect below).
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
  // "Toolbar on the right" means wide-pane layout AND options closed.
  const toolbarOnRight = widePane && !optionsOpen;
  // Closed wide-pane layout (toolbar on the right) forces full-width geometry;
  // otherwise honour the selected zoom sizing mode while maxText is on.
  const sizingMode: ZoomSizingMode = toolbarOnRight ? "FIT_WIDTH" : settings.maxText ? settings.zoomSizingMode : "FIT_PAGE";
  const autoWrap = settings.maxText && settings.zoomAutoWrap;
  const scrollMode = usesVerticalScroll(sizingMode, autoWrap);
  // Mirror into a ref the once-bound ResizeObserver can read.
  useEffect(() => {
    sizingModeRef.current = sizingMode;
    zoomFontSizeRef.current = settings.zoomFontSize;
    autoWrapRef.current = autoWrap;
  }, [autoWrap, settings.zoomFontSize, sizingMode]);

  useEffect(() => {
    const el = swipeRef.current;
    if (!el) return;

    const trackedTouchIds = new Set<number>();
    let pinchGestureActive = false;
    let pinchMoved = false;
    let lastPinchSteps = 0;
    let pinchStartDistance: number | null = null;
    let pinchBaselineFontSize = 0;
    let pinchAdjustsFont = false;
    let pinchPreviewHost: HTMLDivElement | null = null;
    let pinchPreviewTransform = "";
    // Count only touches that STARTED inside the pane (touch events keep firing at
    // their start target). event.touches is the global list — a finger resting on
    // the toolbar or bezel area must not keep the pinch "active" forever after the
    // real pinch fingers have lifted (which suppressed and cancelled every
    // subsequent swipe: another "frozen page" state).
    const trackedTouches = (touches: TouchList): Touch[] => {
      const result: Touch[] = [];
      for (let i = 0; i < touches.length; i++) {
        if (trackedTouchIds.has(touches[i].identifier)) result.push(touches[i]);
      }
      return result;
    };
    const touchDistance = (touches: readonly Touch[]) => Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);
    const restorePinchPreview = () => {
      if (pinchPreviewHost) pinchPreviewHost.style.transform = pinchPreviewTransform;
      pinchPreviewHost = null;
      pinchPreviewTransform = "";
    };
    const finishPinch = (cancelled: boolean) => {
      const cycleMode = pinchGestureActive && !pinchMoved && !cancelled;
      const finalFontSize = Math.max(10, Math.min(64, pinchBaselineFontSize + lastPinchSteps));
      const commitFontSize = pinchGestureActive && pinchAdjustsFont && pinchMoved && !cancelled && finalFontSize !== pinchBaselineFontSize;
      restorePinchPreview();
      pinchGestureActive = false;
      pinchStartDistance = null;
      trackedTouchIds.clear();
      pinchActiveRef.current = false;
      if (cycleMode) rotateZoomMode(1);
      else if (commitFontSize) store.setManualZoomFontSize(finalFontSize);
    };
    const onTouchStart = (event: TouchEvent) => {
      for (let i = 0; i < event.changedTouches.length; i++) {
        const touch = event.changedTouches[i];
        if (touch.target instanceof Node && el.contains(touch.target)) trackedTouchIds.add(touch.identifier);
      }
      const touches = trackedTouches(event.touches);
      if (touches.length !== 2 || pinchGestureActive) return;
      pinchGestureActive = true;
      pinchMoved = false;
      lastPinchSteps = 0;
      pinchStartDistance = touchDistance(touches);
      const displaySettings = store.getSnapshot().displaySettings;
      pinchBaselineFontSize = displaySettings.zoomFontSize;
      pinchAdjustsFont = displaySettings.maxText && displaySettings.zoomSizingMode === "MANUAL";
      pinchPreviewHost = pinchAdjustsFont ? hostRef.current : null;
      pinchPreviewTransform = pinchPreviewHost?.style.transform ?? "";
      pinchActiveRef.current = true;
      pinchSuppressPointerRef.current = true;
      flipRef.current?.cancel();
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!pinchGestureActive || pinchStartDistance == null) return;
      const touches = trackedTouches(event.touches);
      if (touches.length !== 2) return;
      const fontDelta = (touchDistance(touches) - pinchStartDistance) / ZOOM_PINCH_PIXELS_PER_STEP;
      const steps = Math.round(fontDelta);
      if (pinchPreviewHost && pinchBaselineFontSize > 0) {
        const previewFontSize = Math.max(10, Math.min(64, pinchBaselineFontSize + fontDelta));
        const scale = previewFontSize / pinchBaselineFontSize;
        pinchPreviewHost.style.transform = `${pinchPreviewTransform} scale(${scale})`;
      }
      if (steps !== lastPinchSteps) {
        pinchMoved = true;
        lastPinchSteps = steps;
      }
      if (event.cancelable) event.preventDefault();
    };
    const onTouchEnd = (event: TouchEvent) => {
      for (let i = 0; i < event.changedTouches.length; i++) trackedTouchIds.delete(event.changedTouches[i].identifier);
      if (!pinchGestureActive || trackedTouches(event.touches).length >= 2) return;
      finishPinch(false);
    };
    const onTouchCancel = () => {
      if (pinchGestureActive) finishPinch(true);
      else trackedTouchIds.clear();
    };

    // Modern tablet/WebView path: capture both touch pointers on the stable pane.
    // The ChordPro renderer replaces its own descendants after every font step;
    // pointer capture keeps the gesture alive across those replacements so line
    // wrapping and the real font size can update at every detent.
    const pointerTouches = new Map<number, { x: number; y: number }>();
    let pointerPinchActive = false;
    let pointerPinchMoved = false;
    let pointerPinchStartDistance = 0;
    let pointerPinchLastSteps = 0;
    const pointerDistance = () => {
      const points = [...pointerTouches.values()];
      return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    };
    const releasePointerCaptures = () => {
      for (const id of pointerTouches.keys()) {
        if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
      }
    };
    const finishPointerPinch = (cancelled: boolean) => {
      const cycleMode = pointerPinchActive && !pointerPinchMoved && !cancelled;
      releasePointerCaptures();
      pointerTouches.clear();
      pointerPinchActive = false;
      pinchActiveRef.current = false;
      if (cycleMode) rotateZoomMode(1);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !(event.target instanceof Node) || !el.contains(event.target)) return;
      pointerTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointerTouches.size !== 2 || pointerPinchActive) return;
      pointerPinchActive = true;
      pointerPinchMoved = false;
      pointerPinchLastSteps = 0;
      pointerPinchStartDistance = pointerDistance();
      pinchActiveRef.current = true;
      pinchSuppressPointerRef.current = true;
      flipRef.current?.cancel();
      for (const id of pointerTouches.keys()) {
        try {
          el.setPointerCapture(id);
        } catch {
          // The pointer may already have ended between the two down events.
        }
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!pointerTouches.has(event.pointerId)) return;
      pointerTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!pointerPinchActive || pointerTouches.size !== 2) return;
      const steps = Math.round((pointerDistance() - pointerPinchStartDistance) / ZOOM_PINCH_PIXELS_PER_STEP);
      if (steps !== pointerPinchLastSteps) {
        pointerPinchMoved = true;
        const delta = steps - pointerPinchLastSteps;
        pointerPinchLastSteps = steps;
        store.adjustManualZoomFontSize(delta);
      }
      event.preventDefault();
    };
    const onPointerEnd = (event: PointerEvent) => {
      if (!pointerTouches.delete(event.pointerId)) return;
      if (pointerPinchActive && pointerTouches.size < 2) finishPointerPinch(event.type === "pointercancel");
    };
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      const delta = Math.abs(ev.deltaY) >= Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;
      if (delta === 0) return;
      if (ev.shiftKey) rotateZoomMode(delta < 0 ? -1 : 1);
      else store.adjustManualZoomFontSize(delta < 0 ? 1 : -1);
    };
    const supportsPointerPinch = "PointerEvent" in window;
    el.addEventListener("wheel", onWheel, { passive: false });
    if (supportsPointerPinch) {
      el.addEventListener("pointerdown", onPointerDown, true);
      window.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
      window.addEventListener("pointerup", onPointerEnd, true);
      window.addEventListener("pointercancel", onPointerEnd, true);
    } else {
      el.addEventListener("touchstart", onTouchStart, true);
      window.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
      window.addEventListener("touchend", onTouchEnd, true);
      window.addEventListener("touchcancel", onTouchCancel, true);
    }
    return () => {
      restorePinchPreview();
      releasePointerCaptures();
      pinchActiveRef.current = false;
      pinchSuppressPointerRef.current = false;
      el.removeEventListener("wheel", onWheel);
      if (supportsPointerPinch) {
        el.removeEventListener("pointerdown", onPointerDown, true);
        window.removeEventListener("pointermove", onPointerMove, true);
        window.removeEventListener("pointerup", onPointerEnd, true);
        window.removeEventListener("pointercancel", onPointerEnd, true);
      } else {
        el.removeEventListener("touchstart", onTouchStart, true);
        window.removeEventListener("touchmove", onTouchMove, true);
        window.removeEventListener("touchend", onTouchEnd, true);
        window.removeEventListener("touchcancel", onTouchCancel, true);
      }
    };
  }, [rotateZoomMode, store]);

  // Pointer plumbing: forward swipe gestures to the shared controller. We do NOT
  // setPointerCapture — capturing on #swipe-handler would steal taps from the
  // editor canvas inside it and break the editor's lyrics-hit (highlight) handler.
  // Instead, once a swipe starts anywhere in the pane, track that pointer on
  // window so margins/overlays around the rendered ChordPro canvas keep swiping.
  //
  // On top of the controller's horizontal page-turn, a decisively VERTICAL drag
  // is arbitrated away from it: on the first move past the slop we lock the
  // gesture to one axis. A vertical drag is then NEVER forwarded to the
  // controller, so a tiny sideways wobble can't begin (and strand) a page-turn
  // flip — the cause of the gestures freezing until the next song change.
  useEffect(() => {
    const el = swipeRef.current;
    if (!el) return;
    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    // null until the gesture passes the slop and commits to an axis; then locked
    // so the page-turn controller and a vertical drag never both act on it.
    let axis: "flip" | "ignore" | null = null;
    const clearSelection = () => window.getSelection()?.removeAllRanges();
    const stopTracking = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      document.documentElement.classList.remove(PageFlip.SELECTION_GUARD_CLASS);
      clearSelection();
    };
    // A decisively vertical drag is locked to "ignore" only when the page is NOT
    // itself scrollable; when it overflows, that same drag is the controller's
    // scroll (matching PageFlip's own scroll test), so we leave it to the
    // controller instead of swallowing it.
    const pageScrolls = () => {
      const page = currentPageRef.current;
      return !!page && page.scrollHeight > page.clientHeight;
    };
    const down = (e: PointerEvent) => {
      // Track by pointerId, NOT by isPrimary: with isPrimary-gating a second
      // finger (or a palm edge) resting anywhere on the screen made every new
      // touch non-primary, so the song pane ignored ALL input — the single most
      // common "the app froze" report. When idle, the first pointer to land on
      // the pane is tracked, whichever it is.
      if (pointerId !== null) {
        // A pointer is already tracked. A genuine extra finger is simply ignored
        // (it must not restart or corrupt the gesture in progress). But a PRIMARY
        // down can only occur when no other touch is active — i.e. our tracked
        // stream died without a pointerup/pointercancel (WebView app-switch,
        // native gesture swallowing the end event). Recover instead of staying
        // deaf forever.
        if (!e.isPrimary) return;
        stopTracking();
        pointerId = null;
        flipRef.current?.cancel();
      }
      // Gestures cannot start while a page-turn animation / completed-turn reload
      // is in flight — the controller ignores them anyway; not tracking them
      // keeps the chord-box side effects from firing mid-turn.
      if (flipRef.current?.animating) {
        e.preventDefault();
        return;
      }
      if (isInsideChordSelector(e.target, el)) return;
      // A finished pinch leaves its one-shot pointer suppression armed; a fresh
      // single-finger gesture must not inherit it (it would eat this whole swipe).
      if (!pinchActiveRef.current) pinchSuppressPointerRef.current = false;
      if (apiRef.current?.handleExternalChordBoxTouch(e, true)) {
        flipRef.current?.cancel();
        return;
      }
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      axis = null;
      document.documentElement.classList.add(PageFlip.SELECTION_GUARD_CLASS);
      clearSelection();
      flipRef.current?.handlePointer("down", e);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    };
    const move = (e: PointerEvent) => {
      if (pointerId !== e.pointerId) return;
      if (pinchActiveRef.current || pinchSuppressPointerRef.current) {
        e.preventDefault();
        clearSelection();
        flipRef.current?.cancel();
        return;
      }
      e.preventDefault();
      clearSelection();
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // Decide the axis once, on the first move past the slop, then keep it. Until
      // then withhold moves from the controller so a tiny horizontal wobble at the
      // start of a vertical drag cannot begin a flip on the very first move.
      if (axis === null) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < GESTURE_SLOP_PX) return;
        // Decisively vertical (more than 1.5x the horizontal travel) and the page
        // isn't scrolling: lock the axis to "ignore" so it can never turn into a
        // flip either.
        if (Math.abs(dy) > Math.abs(dx) * 1.5 && !pageScrolls()) {
          axis = "ignore";
          flipRef.current?.cancel(); // drop the controller's pending gesture
          return;
        }
        axis = "flip";
      }
      if (axis === "flip") flipRef.current?.handlePointer("move", e);
    };
    const up = (e: PointerEvent) => {
      if (pointerId !== e.pointerId) return;
      pointerId = null;
      stopTracking();
      if (pinchActiveRef.current || pinchSuppressPointerRef.current) {
        pinchSuppressPointerRef.current = false;
        flipRef.current?.cancel();
        return;
      }
      // 'ignore' (a decisively vertical drag, already dropped by the controller in
      // move) does nothing here either. 'flip' (page-turn / scroll) or an
      // unclassified tap lets the controller finish, or harmlessly clears its
      // gesture state for a tap.
      if (axis !== "ignore") flipRef.current?.handlePointer("up", e);
    };
    const cancel = (e: PointerEvent) => {
      if (pointerId !== e.pointerId) return;
      pointerId = null;
      pinchSuppressPointerRef.current = false;
      stopTracking();
      flipRef.current?.cancel();
    };
    // Safety net: if the app is backgrounded / the window loses focus mid-gesture
    // (Android app switch, notification shade, screenshot gesture), the pointer
    // stream can end without pointerup OR pointercancel. Unwind everything so no
    // half-turned page or armed selection guard survives the interruption.
    const abortGesture = () => {
      if (pointerId === null && !flipRef.current?.animating) return;
      pointerId = null;
      pinchSuppressPointerRef.current = false;
      stopTracking();
      flipRef.current?.cancel();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") abortGesture();
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("blur", abortGesture);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("blur", abortGesture);
      document.removeEventListener("visibilitychange", onVisibility);
      stopTracking();
    };
  }, []);

  // ── current editor: bind once; re-fit active editors on pane resize ──────────
  useEffect(() => {
    const host = hostRef.current;
    const pane = swipeRef.current;
    if (!host || !pane) return;
    apiRef.current = chordProAPI.bind(host);
    const confirmDiscard = (discard: () => void) => {
      void store.confirm("drop").then((confirmed) => {
        if (confirmed) discard();
      });
    };
    apiRef.current.setChordSelectorDiscardHandler(confirmDiscard);

    // Re-fit + re-zoom on pane resize / orientation change. Observe the PANE
    // (the perspective container), not the zoomed hosts (which would feed back
    // into the observer and loop).
    let raf = 0;
    const scheduleFit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const fitViewport = prevPageRef.current ?? nextPageRef.current ?? pane;
        if (apiRef.current && hostRef.current)
          void fitAndZoom(hostRef.current, apiRef.current, sizingModeRef.current, zoomFontSizeRef.current, autoWrapRef.current, fitViewport);
        if (prevApiRef.current && prevHostRef.current)
          void fitAndZoom(prevHostRef.current, prevApiRef.current, sizingModeRef.current, zoomFontSizeRef.current, autoWrapRef.current, fitViewport);
        if (nextApiRef.current && nextHostRef.current)
          void fitAndZoom(nextHostRef.current, nextApiRef.current, sizingModeRef.current, zoomFontSizeRef.current, autoWrapRef.current, fitViewport);
      });
    };
    const observer = new ResizeObserver(() => {
      scheduleFit();
    });
    observer.observe(pane);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
      apiRef.current?.dispose();
      apiRef.current = null;
      loadedTextRef.current = null;
      appliedStylesRef.current = undefined;
    };
  }, [store]);

  // Neighbour editors are an optional visual performance feature. A persisted
  // slow profile skips binding them on startup; a newly slow profile disposes
  // both immediately while leaving the tiny page shells for stable geometry.
  useEffect(() => {
    if (!neighbourPreloadingEnabled) return;
    const prevHost = prevHostRef.current;
    const nextHost = nextHostRef.current;
    if (!prevHost || !nextHost) return;
    const confirmDiscard = (discard: () => void) => {
      void store.confirm("drop").then((confirmed) => {
        if (confirmed) discard();
      });
    };
    const prevApi = chordProAPI.bind(prevHost);
    const nextApi = chordProAPI.bind(nextHost);
    prevApi.setChordSelectorDiscardHandler(confirmDiscard);
    nextApi.setChordSelectorDiscardHandler(confirmDiscard);
    prevApiRef.current = prevApi;
    nextApiRef.current = nextApi;
    return () => {
      prevApi.dispose();
      nextApi.dispose();
      if (prevApiRef.current === prevApi) prevApiRef.current = null;
      if (nextApiRef.current === nextApi) nextApiRef.current = null;
      clearFit(prevHost);
      clearFit(nextHost);
    };
  }, [neighbourPreloadingEnabled, store]);

  // ── current page: reflect display + render-setting changes ────────────────────
  // Reload only when the song text changes and re-fit only when an input that
  // affects document layout changes. Highlight is deliberately handled by the
  // decoration-only effect below: display_query returns a fresh Display object
  // for every highlight tick, but that must not restart auto-wrap/font fitting.
  useEffect(() => {
    const api = apiRef.current;
    const host = hostRef.current;
    if (!api || !host) return;
    const text = display.song ?? "";
    if (!text) {
      // Nothing projected: clear the editor so stale song content cannot remain
      // visible under the empty-state hint.
      if (loadedTextRef.current !== "") api.load("", false, undefined, undefined, undefined, CLIENT_VIEW_EDITOR_OPTIONS);
      loadedTextRef.current = "";
      appliedStylesRef.current = undefined;
      appliedTransposeRef.current = 0;
      clearFit(host);
      api.setSectionRepeatCounts(undefined, false);
      api.highlight(0, 0, undefined, undefined, false);
      api.setLyricsHitHandler(null);
      pendingTurnFitRef.current = null;
      return;
    }
    const renderStartedAt = performance.now();
    let documentReloaded = false;
    if (loadedTextRef.current !== text) {
      loadedTextRef.current = text;
      // Construct without an initial paint (suppressDraw) so transpose/capo and
      // display settings are applied before the first draw — the closing
      // fitAndZoom() below draws once. Without this the editor briefly paints the
      // untransposed song (a one-frame flash on every song switch).
      api.load(text, false, undefined, undefined, true, CLIENT_VIEW_EDITOR_OPTIONS);
      // A freshly loaded document starts at shift 0.
      appliedTransposeRef.current = 0;
      documentReloaded = true;
    }
    // load() rebuilds the editor document, so styles must be restored after it.
    // On display-only ticks preserve the layout caches unless the shared style
    // object really changed. fitAndZoom() below owns the single paint.
    if (documentReloaded || appliedStylesRef.current !== chordProStyles) {
      api.setStyles(chordProStyles, false);
      appliedStylesRef.current = chordProStyles;
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
      autoWrap,
      flags,
      boxType,
      autoWrap && sizingMode === "MANUAL"
    );
    api.darkMode(dark);
    // Instructions: set the text on the editor, then toggle the overlay via the
    // render mode (legacy displayChanged → enableInstructionRendering): "FULL" in
    // scroll mode, "FIRST_LINE" in fit mode, "" off. Re-applied on every load
    // since api.load() rebuilds the editor instance. fitAndZoom redraws, so
    // draw=false here is enough.
    api.applyInstructions(display.instructions ?? "", false);
    api.enableInstructionRendering(showInstructions ? (scrollMode ? "FULL" : "FIRST_LINE") : "", false);
    api.setSectionRepeatCounts(sectionRepeatCounts, false);
    // Submit the current decoration without drawing; fitAndZoom owns the single
    // document paint for this content/layout change.
    const current = store.getSnapshot();
    const currentDisplay = current.display;
    if (current.highlightOn) {
      api.highlight(currentDisplay.from ?? 0, currentDisplay.to ?? 0, currentDisplay.section, currentDisplay.sectionRepeatNonce, false);
    } else {
      api.highlight(0, 0, undefined, undefined, false);
    }
    const pendingTurnFit = pendingTurnFitRef.current;
    const carriedFit = pendingTurnFit?.songId === display.songId ? pendingTurnFit.visual : null;
    if (pendingTurnFit && !carriedFit) pendingTurnFitRef.current = null;
    if (carriedFit) applyFitVisualState(host, carriedFit);
    // Scale only after all geometry/decorations for this display have been
    // submitted, so settlement represents the exact page that will be revealed.
    const settledFit = fitAndZoom(
      host,
      api,
      sizingMode,
      settings.zoomFontSize,
      autoWrap,
      prevPageRef.current ?? nextPageRef.current ?? swipeRef.current
    );
    const settledFitGeneration = fitGenerations.get(host);
    // Keep the revealed neighbour in place until the incoming current page has
    // its final transform. Swapping earlier exposed a second, slightly larger fit
    // after every completed turn.
    void settledFit.then((applied) => {
      if (!applied) return;
      recordChordProRenderDuration(performance.now() - renderStartedAt);
      requestAnimationFrame(() => {
        if (fitGenerations.get(host) !== settledFitGeneration) return;
        flipRef.current?.finishPending();
        if (pendingTurnFitRef.current === pendingTurnFit) pendingTurnFitRef.current = null;
      });
    });
  }, [
    display.capo,
    display.instructions,
    display.song,
    display.songId,
    display.transpose,
    sectionRepeatCounts,
    chordProStyles,
    settings,
    dark,
    scrollMode,
    showInstructions,
    sizingMode,
    autoWrap,
    store,
  ]);

  // A highlight response is a decoration update only. The ChordPro renderer
  // patches its highlight layer in place, preserving the wrapped song DOM,
  // current fit transform and visible pixels.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    if (highlightOn) api.highlight(display.from ?? 0, display.to ?? 0, display.section, display.sectionRepeatNonce);
    else api.highlight(0, 0, undefined, undefined);
  }, [display.from, display.section, display.sectionRepeatNonce, display.song, display.songId, display.to, highlightOn]);

  // The hit handler is interaction state, not layout state. Re-install it after
  // a document load without coupling ordinary control changes to auto-wrap.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    api.setLyricsHitHandler(display.song && highlightControl ? (hit) => void store.pushHighlight(hit.from, hit.to, hit.section) : null);
  }, [display.song, highlightControl, store]);

  // ── neighbour pages: preload prev/next for the flip reveal ────────────────────
  useEffect(() => {
    // A neighbour page is only PAINTED while a flip reveals it, and a completed
    // turn keeps the revealed one on screen until the incoming current page has
    // settled. Reloading a neighbour during that window swaps the song the user
    // is looking at for the next one along — the page-turn flash. The turn's own
    // song change lands here while the flip is still active, so hold every
    // neighbour load until the controller has hidden them again (it reports that
    // by turning the flip inactive, after `snapBack` → `hideNeighbours`).
    if (!neighbourPreloadingEnabled || flipActive) return;
    let cancelled = false;
    const load = async (entry: NavEntry | undefined, host: HTMLDivElement | null, api: BoundEditor | null) => {
      if (!api || !host) return;
      if (!entry) {
        api.load("", false, undefined, undefined, undefined, CLIENT_VIEW_EDITOR_OPTIONS);
        clearFit(host);
        return;
      }
      try {
        const data = await store.getSongData(entry.songId);
        if (cancelled) return;
        const shift = (entry.transpose ?? 0) - (settings.useCapo ? Math.max(entry.capo ?? 0, 0) : 0);
        renderSong(
          host,
          api,
          data.text,
          shift,
          settings,
          chordProStyles,
          dark,
          sizingMode,
          prevPageRef.current ?? nextPageRef.current ?? swipeRef.current
        );
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
    flipActive,
    neighbourPreloadingEnabled,
    display.songId,
    chordProStyles,
    state.navigationMode,
    state.songs,
    state.searchResults,
    state.playlist,
    state.leaderProfiles,
    state.selectedLeaderId,
    state.selectedPlaylistLabel,
    settings,
    dark,
    sizingMode,
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
      {zoomModeToast &&
        createPortal(
          <div
            key={zoomModeToast.value ?? "OFF"}
            className="cv-zoom-mode-toast"
            role="status"
            aria-live="polite"
            aria-label={`Zoom mode: ${zoomModeToast.label}`}
          >
            <ZoomSizingModeGlyph mode={zoomModeToast} className="cv-zoom-mode-toast-glyph" />
            <span className="cv-zoom-mode-toast-label">{zoomModeToast.label}</span>
          </div>,
          document.body
        )}
      {!viewingRemoteDisplay && (
        <div
          className={`cv-navigation-actions${flipActive || (state.navigationMode === "playlist" && !canAddCurrentSongToPlaylist) ? " cv-navigation-actions-hidden" : ""}`}
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
          {!canAddCurrentSongToPlaylist && (
            <span className="cv-navigation-mode cv-navigation-add-current cv-play-btn cv-navigation-tutorial-placeholder" aria-hidden="true">
              ▶
            </span>
          )}
        </div>
      )}
      {/* Hidden chord-selector host required by the guitar chord-box renderer. */}
      <div dangerouslySetInnerHTML={{ __html: CHORDSEL_MARKUP }} />
    </div>
  );
});
