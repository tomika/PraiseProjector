import { ChordProDocument, ChordProChord, ChordProChordBase, ChordProLine, ChordSystem, ChordProProperties, ChordProAbc } from "./chordpro_base";
import {
  ChordProDirectiveStyles,
  ChordProDisplayProperties,
  ChordProStylesSettings,
  cloneDirectiveStyles,
  cloneDisplayProperties,
  defaultDisplayProperties,
  defaultStyles,
} from "./chordpro_styles";
import { getKeyCodeString } from "./keycodes";
import { ChordSelector } from "./chord_selector";
import { Instrument, playChord } from "./midi";
import type { AbcWysiwygEditor } from "./abc_editor";
import type { NoteTimingEvent, TimingCallbacks, TuneObject, TuneObjectArray } from "abcjs";
import { abcjs, isAbcjsLoaded, loadAbcjs } from "./abcjs-lazy";
import { createDivElement, DifferentialText, DiffTextPreProcessor, VersionedMap, virtualKeyboard } from "../common/utils";
import * as clipboard from "./clipboard";
import { ChordDetails, Key, Mode } from "./note_system";
import { Settings } from "../common/settings";
import { NoteHitBox, Point, Rectangle } from "./ui_base";
import { ChordBoxType, ChordDrawer, CHORDFORMAT_INKEY } from "./chord_drawer";
import { projectDisplaySequence, type DisplaySequence } from "./render/display-plan";
import { buildChordVisualModel } from "./render/chord-visual";
import { safeMetaAlignment } from "./layout/meta-alignment";
import {
  buildChordDropLines,
  hitTestChord,
  hitTestDiagram,
  hitTestOccurrence,
  hitTestTag,
  isTagColumnPoint,
  normalizeClientPoint,
  resolveCaretGeometry,
  resolveChordDropTarget,
  resolveLineCaretHit,
  type ChordDropLine,
} from "./render/dom-interaction";
import {
  DomSongRenderer,
  LayoutSnapshotCoordinator,
  type DomChordStripInput,
  type DomDiagramInput,
  type DomEditingInput,
  type DomMetaInputHost,
  type DomSongRendererInput,
  type InvalidationCategory,
  type LayoutListener,
  type LayoutSnapshot,
} from "./render/dom-song-renderer";

export {
  CHORDFORMAT_LCMOLL,
  CHORDFORMAT_NOMMOL,
  CHORDFORMAT_SUBSCRIPT,
  CHORDFORMAT_BB,
  CHORDFORMAT_SIMPLIFIED,
  CHORDFORMAT_NOSECTIONDUP,
  CHORDFORMAT_NOCHORDS,
  CHORDFORMAT_INKEY,
} from "./chord_drawer";

type MidiPlaybackState = { stop: () => void; playing: boolean; currentTime: number; endTime: number };

function ensureAbcMidiPlaybackStyles() {
  const styleId = "pp-abc-midi-playback-style";
  let style = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = styleId;
    document.head.appendChild(style);
  }
  style.textContent = `
    .pp-abc-midi-current {
      fill: rgb(224, 57, 57) !important;
      stroke: rgb(224, 57, 57) !important;
      filter: drop-shadow(0 0 1.5px rgba(80, 220, 255, 0.85));
    }
  `;
}

const static_ChordProEditor_diacritics = [
  { char: "A", base: /[\u00c0-\u00c6]/g },
  { char: "a", base: /[\u00e0-\u00e6]/g },
  { char: "E", base: /[\u00c8-\u00cb]/g },
  { char: "e", base: /[\u00e8-\u00eb]/g },
  { char: "I", base: /[\u00cc-\u00cf]/g },
  { char: "i", base: /[\u00ec-\u00ef]/g },
  { char: "O", base: /[\u00d2-\u00d8]/g },
  { char: "o", base: /[\u00f2-\u00f8]/g },
  { char: "U", base: /[\u00d9-\u00dc]/g },
  { char: "u", base: /[\u00f9-\u00fc]/g },
  { char: "N", base: /[\u00d1]/g },
  { char: "n", base: /[\u00f1]/g },
  { char: "C", base: /[\u00c7]/g },
  { char: "c", base: /[\u00e7]/g },
];

function remove_diacritics(str: string) {
  static_ChordProEditor_diacritics.forEach((letter) => {
    str = str.replace(letter.base, letter.char);
  });
  return str;
}

function is_word_boundary_char(ch: string) {
  return !/\b/gi.exec(remove_diacritics(ch));
}

function playAbcWithSynth(abcSource: string, bpm: number, onError?: (error?: unknown) => void, playbackVisualObj?: TuneObject): MidiPlaybackState {
  const state: MidiPlaybackState = {
    stop: () => {
      // Replaced after synth initialization.
    },
    playing: false,
    currentTime: 0,
    endTime: 0,
  };

  if (!isAbcjsLoaded()) {
    // abcjs chunk not loaded yet: kick off the load and return inert playback
    // state. The triggering ABC must already be rendered for the user to start
    // playback, so this path is effectively unreachable in practice.
    void loadAbcjs();
    return state;
  }

  ensureAbcMidiPlaybackStyles();

  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let timingCallbacks: TimingCallbacks | null = null;
  let activeElements: Element[] = [];
  let startTime = 0;
  const stopTimer = () => {
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  };

  const clearPlaybackMarker = () => {
    for (const el of activeElements) el.classList.remove("pp-abc-midi-current");
    activeElements = [];
  };

  const applyPlaybackMarker = (event: NoteTimingEvent | null) => {
    clearPlaybackMarker();
    if (!event) return;

    for (const group of event.elements ?? []) {
      for (const el of group ?? []) {
        if (el instanceof Element && el.classList) {
          el.classList.add("pp-abc-midi-current");
          activeElements.push(el);
        }
      }
    }
  };

  const cleanupContainer = (container: HTMLDivElement) => {
    if (container.parentElement) container.parentElement.removeChild(container);
  };

  try {
    let visualObj = playbackVisualObj;
    if (!visualObj) {
      const renderContainer = document.createElement("div");
      renderContainer.style.display = "none";
      document.body.appendChild(renderContainer);

      const rendered = abcjs().renderAbc(renderContainer, abcSource, {
        add_classes: true,
        responsive: "resize",
      }) as TuneObjectArray;

      cleanupContainer(renderContainer);
      visualObj = rendered?.[0];
    }

    if (!visualObj) {
      throw new Error("Could not render ABC for synth playback.");
    }

    timingCallbacks = new (abcjs().TimingCallbacks)(visualObj, {
      ...(isNaN(bpm) ? {} : { qpm: bpm }),
      eventCallback: (event) => {
        applyPlaybackMarker(event);
        return undefined;
      },
    });

    const midiBuffer = new (abcjs().synth.CreateSynth)();
    const options = {
      ...(isNaN(bpm) ? {} : { qpm: bpm }),
    };

    state.stop = () => {
      stopTimer();
      timingCallbacks?.stop();
      clearPlaybackMarker();
      try {
        midiBuffer.stop();
      } catch {
        // Ignore stop errors during teardown.
      }
      state.playing = false;
      state.currentTime = Math.min(state.currentTime, state.endTime || state.currentTime);
    };

    void midiBuffer
      .init({
        visualObj,
        options,
        onEnded: () => {
          stopTimer();
          timingCallbacks?.stop();
          clearPlaybackMarker();
          state.playing = false;
          state.currentTime = state.endTime;
        },
      })
      .then(() => midiBuffer.prime())
      .then(({ duration }) => {
        state.endTime = duration;
        state.currentTime = 0;
        startTime = performance.now();
        state.playing = true;
        midiBuffer.start();
        timingCallbacks?.start();

        progressTimer = setInterval(() => {
          if (!state.playing) return;
          const elapsedSeconds = (performance.now() - startTime) / 1000;
          state.currentTime = Math.min(elapsedSeconds, state.endTime || elapsedSeconds);
          if (state.endTime > 0 && state.currentTime >= state.endTime) {
            state.playing = false;
            stopTimer();
          }
        }, 100);
      })
      .catch((error) => {
        state.playing = false;
        stopTimer();
        timingCallbacks?.stop();
        clearPlaybackMarker();
        onError?.(error);
      });
  } catch (error) {
    clearPlaybackMarker();
    onError?.(error);
  }

  return state;
}

function getRootFontSizePx(): number {
  if (typeof document === "undefined") return 16;
  const computed = parseFloat(getComputedStyle(document.documentElement).fontSize || "");
  if (Number.isFinite(computed) && computed > 0) return computed;
  const inline = parseFloat(document.documentElement.style.fontSize || "");
  if (Number.isFinite(inline) && inline > 0) return inline;
  return 16;
}
/*
function parseTag(tag: string | DifferentialText) {
  const split = (s: string) => {
    const m = /^(.*) ([0-9]+)[*xX]$/.exec(s);
    return m ? { section: m[1], multiplier: parseInt(m[2]) } : { section: s };
  };
  if (typeof tag === "string") return split(tag);
  const c = split(tag.toString(true));
  const p = split(tag.toString(false));
  return {
    section: DifferentialText.create(p.section, c.section),
    multiplier:
      c.multiplier === p.multiplier ? c.multiplier : DifferentialText.create(p.multiplier?.toString() ?? "", c.multiplier?.toString() ?? ""),
  };
}
*/
type ChordProEditorState = {
  data: string;
  cursorTarget: number | string | ChordPosition;
  cursorPos: number;
};

type ChordPosition = { line: number; chord: number };
class ChordProSelection {
  constructor(
    public line: number,
    public col: number
  ) {}

  static fromPos(doc: ChordProDocument, pos: number) {
    for (let i = 0; i < doc.lines.length; ++i) {
      const line = doc.lines[i];
      if (pos < line.lyrics.length) return new ChordProSelection(i, pos);
      pos -= line.lyrics.length;
    }
    return null;
  }

  getPos(doc: ChordProDocument) {
    let count = 0;
    for (let i = 0; i < doc.lines.length; ++i) {
      const line = doc.lines[i];
      if (i === this.line) return count + Math.min(this.col, line.lyrics.length);
      count += line.lyrics.length;
    }
    return count;
  }
}

class ChordProDragStart {
  constructor(
    public readonly startX: number,
    public readonly startY: number,
    public readonly dragStartX: number,
    public readonly dragStartY: number
  ) {}
}

class ChordProHitBox {
  constructor(
    public left: number,
    public top: number,
    public readonly width: number,
    public readonly height: number
  ) {}
}
class ChordProChordHitBox extends ChordProHitBox {
  constructor(
    left: number,
    top: number,
    width: number,
    height: number,
    public readonly chord: ChordProChord
  ) {
    super(left, top, width, height);
  }
}

class ChordTemplateHitBox extends ChordProHitBox {
  constructor(
    left: number,
    top: number,
    width: number,
    height: number,
    public readonly chord: string
  ) {
    super(left, top, width, height);
  }
}

class ChordProTagHitBox extends ChordProHitBox {
  constructor(
    left: number,
    top: number,
    width: number,
    height: number,
    public readonly target: ChordProLine,
    public readonly parameter: string
  ) {
    super(left, top, width, height);
  }
}

class ChordProLineHitBox extends ChordProHitBox {
  constructor(
    left: number,
    top: number,
    width: number,
    height: number,
    public readonly target: ChordProLine,
    public readonly column: number
  ) {
    super(left, top, width, height);
  }
}

class ChordBoxHitBox extends ChordProHitBox {
  notes: number[] | null = null;
  constructor(
    left: number,
    top: number,
    width: number,
    height: number,
    public readonly chord: string
  ) {
    super(left, top, width, height);
  }
}
class PianoChordHitBox extends ChordBoxHitBox {
  constructor(left: number, top: number, width: number, height: number, chord: string) {
    super(left, top, width, height, chord);
  }
}

class GuitarChordHitBox extends ChordBoxHitBox {
  constructor(left: number, top: number, width: number, height: number, chord: string) {
    super(left, top, width, height, chord);
  }
}

class AbcHitBox extends ChordProHitBox {
  constructor(
    left: number,
    top: number,
    width: number,
    height: number,
    readonly abc: ChordProAbc
  ) {
    super(left, top, width, height);
  }
}

type ActionTarget = ChordProChord | ChordProLine | ChordProChordHitBox | ChordProTagHitBox | ChordProLineHitBox | ChordTemplateHitBox | null;

export { Instructions } from "./chordpro_instructions";
export type { InstructionItem } from "./chordpro_instructions";
import { clampTranspose, InstructionItem, Instructions } from "./chordpro_instructions";

export type InstructionsRenderMode = "" | "COMMENT" | "FIRST_LINE" | "FULL";
export type HighlightingParams = { lyrics: string; from: number; to: number; section?: number };
export type SectionRepeatCount = { section: number; from: number; to: number; multiplier: number };

export interface ChordProEditorEventHandlers {
  UpdateChordProData?: (text: string) => void;
  LogFromWebEditor?: (message: string) => void;
  OnLineSel?: (line: number) => void;
  OnLineDblclk?: (line: number) => void;
  OnCopy?: (chordProText: string) => unknown;
  OnPaste?: () => unknown;
}

export interface ChordProEditorOptions {
  /**
   * Align the title metadata row to the host viewport instead of the song's
   * natural-width surface. Used by the full editor, whose song body stays
   * centred independently of an over-long title.
   */
  readonly viewportAlignedTitle?: boolean;
}

/**
 * Caret column for a click at `x` inside a chord/tag text box: the boundary
 * whose prefix width is NEAREST to the click, a tie preferring the later
 * boundary (standard past-the-midpoint placement). The previous strict
 * `width < x` scan could never return the final boundary from inside a
 * text-tight hitbox, so the caret was unreachable after the last character.
 * Boundaries are UTF-16 indices, exactly like the editing model it feeds.
 */
export function caretColumnForClick(text: string, measurePrefixWidth: (endIndex: number) => number, x: number) {
  let best = 0;
  let bestDistance = Math.abs(x);
  for (let end = 1; end <= text.length; ++end) {
    const distance = Math.abs(measurePrefixWidth(end) - x);
    if (distance <= bestDistance) {
      best = end;
      bestDistance = distance;
    }
  }
  return best;
}

export class ChordProEditor extends ChordDrawer {
  private chordPro: ChordProDocument | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private maxUndoSize = 1000;
  private undoBuffer: ChordProEditorState[] = [];
  private redoBuffer: ChordProEditorState[] = [];
  private currentShift = 0;
  private instructions?: Instructions;
  /** Cached result of the shared raw/instructed projection. */
  private displaySequence?: DisplaySequence;
  /** The projected lines actually displayed, derived from `displaySequence`. */
  private displayLines?: ChordProLine[];
  /**
   * For each `Instructions.items[i]`, the index of the first instruction item
   * that shares its repeat group (same section value + transpose). Used by
   * highlight matching so that a projection targeting one occurrence of a
   * repeated section also lights up other occurrences (e.g. the original
   * expanded block when projecting onto its ellipsis preview, and vice versa).
   */
  private instructedSectionGroups?: number[];
  /**
   * Label text for each instructed item (same index as
   * `instructedSectionGroups`). Used as fallback for empty grid tags.
   */
  private instructedSectionLabels?: string[];

  private systemPasteContent = "";
  private clipboardTextArea: HTMLTextAreaElement | null = null;
  private ownsClipboardTextArea = false;
  private removeTouchEvents: (() => void) | null = null;
  private lastMouseDownHadHit = false;
  private touchActive = false;
  private suppressNextClickTs = false;
  private lastTouchTapTime = 0;
  private lastTouchTapPos: Point | null = null;
  /** Touch long-press → context menu (timer fallback for platforms whose native
   *  touch `contextmenu` we suppress via preventDefault, and for iOS/WebKit which
   *  never fires it). */
  private longPressTimer: number | null = null;
  private longPressFired = false;
  private longPressStart: { x: number; y: number } | null = null;
  private longPressSelection: { start: number | ChordProSelection | null; end: number | ChordProSelection | null } | null = null;
  private lastLongPressTime = 0;
  private keyEventTarget: HTMLElement | null = null;
  private composing = false;
  private pendingCanvasFocusAfterMetaBlur = false;
  private windowPasteListenerAttached = false;
  private disposed = false;
  private documentRevision = 0;
  private displayRevision = 0;
  private styleRevision = 0;
  private semanticDocumentText = "";
  /** PRINT is a per-instance host mode; it never persists in global settings. */
  private readonly printSurface: boolean;
  private domRenderer: DomSongRenderer | null = null;
  private readonly canvasLayout = new LayoutSnapshotCoordinator();
  private readonly viewportAlignedTitle: boolean;
  private domMetaInputHost: DomMetaInputHost | null = null;
  /** Post-commit hook that keeps the DOM caret in view; owned with the renderer. */
  private domCaretScrollUnsubscribe: (() => void) | null = null;
  /**
   * Root-local drop marker for an in-flight chord drag, resolved by
   * `applyChordDrag`. It is decoration state, never document state.
   */
  private chordDropMarker: { x: number; y: number } | null = null;
  private contextMenuElement: HTMLDivElement | null = null;
  private readonly handleContextMenu = (e: MouseEvent) => {
    // A native contextmenu (desktop right-click, or an OS touch long-press that
    // beat our fallback timer) is authoritative — cancel the pending timer.
    if (this.longPressTimer != null) {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    // Our timer already opened the menu for this touch: swallow the OS's
    // trailing native contextmenu so it doesn't reopen it.
    if (this.longPressFired || Date.now() - this.lastLongPressTime < 700) {
      e.preventDefault();
      return;
    }
    // Native touch long-press in progress: restore the selection the synthetic
    // mousedown cleared (mouse right-click never clears it) and suppress the
    // trailing tap on release.
    if (this.longPressSelection) {
      this.selectionStart = this.longPressSelection.start;
      this.selectionEnd = this.longPressSelection.end;
      this.longPressFired = true;
      this.lastLongPressTime = Date.now();
    }
    this.onContextMenu(e);
  };
  private readonly dismissContextMenu = (e: Event) => {
    if (e instanceof MouseEvent && this.contextMenuElement?.contains(e.target as Node)) return;
    this.hideContextMenu();
  };
  private readonly handleMouseUp = (e: MouseEvent) => {
    this.onMouseUp(e);
  };
  private readonly handleMouseDown = (e: MouseEvent) => {
    this.onMouseDown(e);
  };
  private readonly handleMouseMove = (e: MouseEvent) => {
    this.onMouseMove(e);
  };
  private readonly handleMouseLeave = (e: MouseEvent) => {
    this.onMouseLeave(e);
  };
  private readonly handleMouseEnter = (e: MouseEvent) => {
    this.onMouseEnter(e);
  };
  private readonly handleKeyDown = (evt: Event) => {
    const e = evt as KeyboardEvent;
    const handled = this.onKeyDown(e);
    if (handled) e.preventDefault();
  };
  private readonly handleKeyPress = (evt: Event) => {
    const e = evt as KeyboardEvent;
    const handled = this.onKeyPressed(e);
    if (handled) e.preventDefault();
  };
  private readonly handleCompositionStart = () => {
    this.composing = true;
  };
  private readonly handleCompositionEnd = () => {
    this.composing = false;
    // Process the composed text from the textarea
    if (this.textarea) {
      const text = this.textarea.value;
      if (text) {
        for (const ch of text) {
          this.insertCharFromInput(ch);
        }
        this.textarea.value = "";
      }
    }
  };
  private readonly handleTextareaInput = () => {
    if (this.composing || !this.textarea) return;
    const text = this.textarea.value;
    if (!text) return;
    this.textarea.value = "";
    for (const ch of text) {
      this.insertCharFromInput(ch);
    }
  };
  private insertCharFromInput(ch: string) {
    if (this.readOnly || !this.chordPro) return;
    // Simulate what onKeyPressed does for a single character
    let s = ch;
    if (s === "\t") s = " ";
    if (s !== " ") s = s.trim();
    if (s === "" || s.length !== 1) return;

    let draw = this.eraseSelection();
    if (!draw) this.saveState();

    if (this.actionTarget instanceof ChordProTagHitBox) {
      const line_obj = this.actionTarget.target;
      const name = this.actionTarget.parameter;
      const value = line_obj.styles.get(name);
      const cursorPos = this.cursorPos || 0;
      this.setTagName(line_obj, name, value.substr(0, cursorPos) + s + value.substr(cursorPos));
      this.cursorPos = cursorPos + 1;
      draw = true;
    } else if (this.actionTarget && !(this.actionTarget instanceof ChordProHitBox)) {
      const cursorPos = this.cursorPos || 0;
      this.actionTarget.insertString(cursorPos, s);
      this.cursorPos = cursorPos + 1;
      if (this.actionTarget instanceof ChordProChord) this.convertChordPrefixToPos(this.actionTarget);
      draw = true;
    }

    if (draw) {
      this.draw();
    }
  }
  private readonly handleWindowPaste = (evt: ClipboardEvent) => {
    this.systemPasteContent = evt.clipboardData?.getData("text/plain") || "";
    // Only prevent default if the paste target is the editor canvas or its proxy textarea.
    // Allow native paste in standard input/textarea elements (e.g. the ChordPro code tab).
    const target = evt.target as HTMLElement | null;
    const isExternalInput = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
    if (!isExternalInput) {
      evt.preventDefault();
    }
  };
  onCopy: ((plain: string, chordpro: string) => void) | null = null;
  onPaste: (() => void) | null = null;

  onLog: ((s: string) => void) | null = null;
  onLineSel: ((line: number) => void) | null = null;
  onLineDblclk: ((line: number) => void) | null = null;
  onChange: ((chordProCode: string) => void) | null = null;
  onLyricsHit: ((hit: HighlightingParams) => void) | null = null;

  targetRatio = 0;
  /**
   * Set by `fitToPane`: this instance's host scales the rendered song to fit a
   * fixed pane box, so the song's natural width decides how small the lyrics get.
   * Metadata is then clipped to the song width instead of inflating it (see
   * `layoutSong`). A host that renders at natural size in a scrollable pane — the
   * full-view editor — leaves this false and lets a long title simply overflow.
   */
  private fitsToPane = false;
  displayProps: ChordProDisplayProperties;
  scale: number;
  /**
   * Opacity multiplier applied to the highlighted-line background fill.
   * 0 = invisible, 1 = fully opaque. Persisted by the host app via
   * displaySettings.highlightOpacity.
   */
  highlightOpacity = 1.0;

  private showTitle = true;
  private showMeta = true;
  private showTag = true;
  private abbrevTag = false;
  private autoSplitLines = false;
  private displayNormalizedChord = false;
  private differentialDisplay = false;
  private instructionsRenderMode: InstructionsRenderMode = "";
  private instructionEditorActive = false;
  private instructionsPaneCleanup: (() => void) | null = null;
  private instructionsCoordinatorCleanup: (() => void) | null = null;
  private instructionsThemeUpdater: (() => void) | null = null;
  private instructionsInteractionUnlockAt = 0;
  private instructionsInteractionUnlockTimer: number | null = null;

  private directiveStyles: ChordProDirectiveStyles;
  private customStyles: ChordProStylesSettings | null = null;
  private keyIsAuto = false;

  private inApplyState = false;
  private multiChordChangeEnabled = true;
  private currentlyMarked?: Set<ChordProLine | ChordProChord>;
  private chordBoxType: ChordBoxType = "";
  private highlighted: { from: number; to: number; section?: number; repeatIndex?: number; repeatTotal?: number; repeatNonce?: number } | null = null;
  private sectionRepeatCounts?: SectionRepeatCount[];
  private lastMouseDown: { x: number; y: number } | null = null;
  private prevClickTime = 0;

  private prevText = "";
  private metaMeasureSpan: HTMLSpanElement | null = null;
  private actionTarget: ActionTarget = null;

  private cursorPos: number | null = null;
  private selectionStart: number | ChordProSelection | null = null;
  private selectionEnd: number | ChordProSelection | null = null;
  /**
   * The lines currently displayed, in display order.
   *
   * Derived from the shared projection rather than written by any paint pass, so
   * rendering is never what populates controller state.
   */
  private get displayedLines(): ChordProLine[] {
    return this.getDisplayLines() ?? this.chordPro?.lines ?? [];
  }
  private dragData: ChordProDragStart | ChordProSelection | number | null = null;

  private metaInputs = new Map<string, { row: HTMLDivElement; prefix: HTMLSpanElement; value: HTMLInputElement }>();

  private abcEditor: AbcWysiwygEditor | null = null;
  private activeAbcBlock: ChordProAbc | null = null;
  private abcjsLoadPending = false;
  private readonly rxStartsWithChord: RegExp;

  private midiPlayer?: MidiPlaybackState;
  private localeHandler?: (s: string) => string;
  private tooltipHandler?: (key: string) => string | undefined;
  private abcLocale: "en" | "hu" = "en";
  private stylesBaseRootFontPx = getRootFontSizePx();

  log(s: string) {
    if (this.onLog) this.onLog(s.toString());
    else console.log(s);
  }

  constructor(
    system: ChordSystem,
    private parent_div: HTMLDivElement,
    chp: string,
    editable: boolean,
    scale?: number,
    chordSelector?: ChordSelector,
    private drawingSuppressed?: boolean,
    referenceChp?: string,
    routeTouch = true,
    _bCorrectParentScroll = true,
    eventHandlers?: ChordProEditorEventHandlers,
    options?: ChordProEditorOptions
  ) {
    super(system, chordSelector, !editable);
    this.printSurface = !!this.parent_div.closest(".print-editor-area");
    this.viewportAlignedTitle = !!options?.viewportAlignedTitle && !this.printSurface;
    this.rxStartsWithChord = new RegExp("^" + system.chordLikeRegexPattern);

    if (eventHandlers) {
      this.onChange = eventHandlers.UpdateChordProData ? (s) => eventHandlers.UpdateChordProData?.(s) : null;
      this.onLog = eventHandlers.LogFromWebEditor ? (s) => eventHandlers.LogFromWebEditor?.(s) : null;
      this.onLineSel = eventHandlers.OnLineSel ? (p) => eventHandlers.OnLineSel?.(p) : null;
      this.onLineDblclk = eventHandlers.OnLineDblclk ? (p) => eventHandlers.OnLineDblclk?.(p) : null;
      this.onCopy = eventHandlers.OnCopy
        ? (_plain, chordpro) => {
            eventHandlers.OnCopy?.(chordpro ?? "");
          }
        : null;
      this.onPaste = eventHandlers.OnPaste
        ? () => {
            eventHandlers.OnPaste?.();
          }
        : null;
    }

    this.parent_div.tabIndex = -1;

    // Create hidden textarea for mobile soft keyboard support and as key event target.
    // On touch devices, focusing this textarea triggers the soft keyboard.
    // Characters typed via soft keyboard are captured via the 'input' event.
    const inputProxy = document.createElement("textarea");
    inputProxy.setAttribute("autocapitalize", "off");
    inputProxy.setAttribute("autocomplete", "off");
    inputProxy.setAttribute("autocorrect", "off");
    inputProxy.setAttribute("spellcheck", "false");
    inputProxy.style.position = "absolute";
    inputProxy.style.opacity = "0";
    inputProxy.style.height = "1px";
    inputProxy.style.width = "1px";
    inputProxy.style.top = "0";
    inputProxy.style.left = "0";
    inputProxy.style.padding = "0";
    inputProxy.style.border = "none";
    inputProxy.style.outline = "none";
    inputProxy.style.resize = "none";
    inputProxy.style.overflow = "hidden";
    inputProxy.style.zIndex = "-1";
    inputProxy.style.pointerEvents = "none";
    inputProxy.tabIndex = -1;
    this.parent_div.appendChild(inputProxy);
    this.textarea = inputProxy;
    /*    
    //this.parent_div.contentEditable = "true";
    this.parent_div.ondrop = null;
    this.parent_div.ondragover = (e) => {
      e.preventDefault();
      return false;
    };
    this.parent_div.draggable = false;
    this.parent_div.ondragstart = (e) => {
      e.preventDefault();
      return false;
    };
*/
    this.metaInputs.clear();

    if (this.abcEditor) {
      this.abcEditor.dispose();
      this.abcEditor = null;
    }
    this.activeAbcBlock = null;

    const computedPosition = getComputedStyle(this.parent_div).position;
    if (!computedPosition || computedPosition === "static") {
      this.parent_div.style.position = "relative";
    }

    this.scale = scale || 1.0;

    if (this.scale > 1) {
      this.showTitle = false;
      this.showMeta = false;
      this.abbrevTag = true;
    }

    this.displayProps = defaultDisplayProperties();
    this.directiveStyles = defaultStyles(this.displayProps.lyricsFont, this.isDark, (key) => this.localeHandler?.(key) ?? key);

    this.clearActionState();

    this.parent_div.addEventListener("mouseup", this.handleMouseUp);
    this.parent_div.addEventListener("mousedown", this.handleMouseDown);
    this.parent_div.addEventListener("mousemove", this.handleMouseMove);
    this.parent_div.addEventListener("mouseleave", this.handleMouseLeave);
    this.parent_div.addEventListener("mouseenter", this.handleMouseEnter);
    this.parent_div.addEventListener("contextmenu", this.handleContextMenu);

    const keytarget = (this.textarea || this.parent_div) as HTMLElement;
    this.keyEventTarget = keytarget;
    keytarget.addEventListener("keydown", this.handleKeyDown);
    keytarget.addEventListener("keypress", this.handleKeyPress);

    // Listen for input/composition events on the textarea for mobile soft keyboard support
    if (this.textarea) {
      this.textarea.addEventListener("input", this.handleTextareaInput);
      this.textarea.addEventListener("compositionstart", this.handleCompositionStart);
      this.textarea.addEventListener("compositionend", this.handleCompositionEnd);
    }

    if (routeTouch) this.installTouchHandlers();
    else this.removeTouchEvents = null;

    if (!Object.prototype.hasOwnProperty.call(window, "clipboardData")) {
      const id = "ChordProEditor_SelfGen_TextArea";

      const existingClipboard = document.getElementById(id) as HTMLTextAreaElement | null;
      if (existingClipboard) {
        this.clipboardTextArea = existingClipboard;
        this.ownsClipboardTextArea = false;
      } else {
        const textarea = document.createElement("textarea");
        textarea.id = id;
        textarea.style.position = "fixed";
        textarea.style.left = "-999999px";
        this.parent_div.appendChild(textarea);
        this.clipboardTextArea = textarea;
        this.ownsClipboardTextArea = true;
      }

      this.systemPasteContent = "";
      window.addEventListener("paste", this.handleWindowPaste);
      this.windowPasteListenerAttached = true;
    }

    if (chp) {
      if (referenceChp) {
        const substitutor = new DiffTextPreProcessor();
        const old = new ChordProDocument(this.system, referenceChp).generateDocument();
        const act = new ChordProDocument(this.system, chp).generateDocument();
        const diff = DifferentialText.create(old, act, { preprocessor: substitutor });
        const lines: DifferentialText[] = [];
        let line = new DifferentialText();
        diff.forEachChunk((chunk) => {
          let first = true;
          for (let text of chunk.text.split("\n")) {
            if (!first) {
              lines.push(line);
              line = new DifferentialText();
            }
            if (!text && first) text = String.fromCharCode(0x23ce);
            if (text) line.append(text, chunk.added);
            first = false;
          }
        });
        if (line.count) lines.push(line);
        this.differentialDisplay = true;
        this.chordPro = new ChordProDocument(this.system, lines);
      } else this.chordPro = new ChordProDocument(this.system, chp);

      this.invalidateDisplaySequence();

      let m = /# notes:(.*)/.exec(chp);
      if (m && m[1]) {
        const value = m[1].trim();
        const rx = /M([0-9]+)(?:\/([0-9]+))?/g;
        while ((m = rx.exec(value))) {
          const lineIndex = parseInt(m[1]);
          if (lineIndex >= 0 && lineIndex < this.chordPro.lines.length) {
            const line_obj = this.chordPro.lines[lineIndex];
            if (m[2]) {
              const chordIndex = parseInt(m[2]);
              if (chordIndex >= 0 && chordIndex < line_obj.chords.length) line_obj.chords[chordIndex].marked = -1;
            } else line_obj.marked = -1;
          }
        }
      }

      this.prevText = this.chordProCode;
      this.completeDocumentMutation();
    }

    this.reconcileRenderBackend();
    this.draw();
  }

  installLocaleHandler(handler: (s: string) => string) {
    this.localeHandler = handler;
    this.applyStylesForCurrentTheme();
    this.invalidateStyleSemantics();
    this.draw();
  }

  installTooltipHandler(handler: (key: string) => string | undefined) {
    this.tooltipHandler = handler;
  }

  setAbcLocale(locale: "en" | "hu") {
    this.abcLocale = locale;
    this.abcEditor?.setLocale(locale);
  }

  private localize(s: string, prefix = "ChpMenu"): string {
    return this.localeHandler?.(prefix + s.replace(/_/g, " ")) ?? s;
  }

  /**
   * Install touch event handlers that selectively claim touch gestures.
   * When a touch hits an interactive editor element (chord, line, meta, etc.),
   * the gesture is claimed: touch events are converted to mouse events and
   * browser default behaviour (scrolling) is prevented.
   * When no element is hit, touch events are left alone so the browser
   * can scroll the container normally.
   */
  private installTouchHandlers() {
    const listenerOpts: AddEventListenerOptions = { capture: true, passive: false };

    const isFormElement = (e: TouchEvent): boolean => {
      if (e.changedTouches.length !== 1) return true;
      const target = e.target as HTMLElement;
      const tag = target.tagName?.toUpperCase();
      if (tag === "SELECT" || tag === "OPTION" || tag === "INPUT" || tag === "BUTTON") return true;
      for (const el of e.composedPath?.() || []) {
        if (el instanceof HTMLElement) {
          const t = el.tagName.toUpperCase();
          if (t === "SELECT" || t === "INPUT" || t === "BUTTON") return true;
        }
      }
      return false;
    };

    const dispatchMouse = (type: string, touch: Touch) => {
      const ev = document.createEvent("MouseEvent");
      ev.initMouseEvent(type, true, true, window, 1, touch.screenX, touch.screenY, touch.clientX, touch.clientY, false, false, false, false, 0, null);
      touch.target.dispatchEvent(ev);
    };

    // Long-press → context menu. Sits above the platform's default touch-hold
    // delay; movement past the slop voids it (that's a scroll/drag/selection).
    const LONG_PRESS_MS = 650;
    const MOVE_SLOP_PX = 10;

    const cancelLongPressTimer = () => {
      if (this.longPressTimer != null) {
        window.clearTimeout(this.longPressTimer);
        this.longPressTimer = null;
      }
    };

    const fireLongPress = () => {
      this.longPressTimer = null;
      const start = this.longPressStart;
      if (!start) return;
      this.longPressFired = true;
      this.lastLongPressTime = Date.now();
      // Restore the selection the synthetic mousedown cleared so Cut/Copy act on
      // it — mouse right-click (button 2) never clears it in onMouseDown.
      if (this.longPressSelection) {
        this.selectionStart = this.longPressSelection.start;
        this.selectionEnd = this.longPressSelection.end;
      }
      this.dragData = null;
      this.touchActive = false;
      this.draw();
      const menuEvent = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 2,
        buttons: 2,
        clientX: start.x,
        clientY: start.y,
        screenX: start.x,
        screenY: start.y,
      });
      this.onContextMenu(menuEvent);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (isFormElement(e)) return;
      this.suppressNextClickTs = true;
      // Snapshot state for a possible long-press BEFORE the synthetic mousedown
      // mutates it (onMouseDown clears the selection).
      const t0 = e.changedTouches[0];
      this.longPressFired = false;
      this.longPressStart = { x: t0.clientX, y: t0.clientY };
      this.longPressSelection = { start: this.selectionStart, end: this.selectionEnd };
      dispatchMouse("mousedown", e.changedTouches[0]);
      cancelLongPressTimer();
      this.longPressTimer = window.setTimeout(fireLongPress, LONG_PRESS_MS);
      // After onMouseDown ran, check if an interactive element was hit. In
      // read-only display mode, also claim blank canvas/page touches so the
      // outer page-flip controller receives the full synthetic mouse gesture.
      this.touchActive = this.readOnly || this.lastMouseDownHadHit;
      if (this.touchActive) {
        e.preventDefault();
        e.stopPropagation();
      }
      // If not active, browser handles scrolling normally
    };

    const onTouchMove = (e: TouchEvent) => {
      // Void a pending long-press on any real movement, regardless of whether
      // the canvas claimed the gesture (scroll on a blank area also cancels).
      if (this.longPressTimer != null && this.longPressStart && e.changedTouches.length >= 1) {
        const t = e.changedTouches[0];
        if (Math.hypot(t.clientX - this.longPressStart.x, t.clientY - this.longPressStart.y) > MOVE_SLOP_PX) {
          cancelLongPressTimer();
          this.longPressStart = null;
          this.longPressSelection = null;
        }
      }
      if (!this.touchActive || e.changedTouches.length !== 1) return;
      dispatchMouse("mousemove", e.changedTouches[0]);
      e.preventDefault();
      e.stopPropagation();
    };

    const onTouchEnd = (e: TouchEvent) => {
      cancelLongPressTimer();
      this.longPressStart = null;
      this.longPressSelection = null;
      if (this.longPressFired) {
        // The long-press already opened the context menu; swallow this release
        // so it isn't treated as a tap/double-tap and no mouseup is sent. The
        // preventDefault also suppresses the compat click that would otherwise
        // land on the freshly opened menu.
        this.longPressFired = false;
        this.touchActive = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.changedTouches.length !== 1) return;
      if (this.touchActive) {
        const touch = e.changedTouches[0];
        dispatchMouse("mouseup", touch);

        // Mobile browsers don't reliably emit dblclick; detect a local double-tap.
        const now = Date.now();
        const pos = this.lastMouseDown ?? this.normalizeClientPos(touch.clientX, touch.clientY);
        const prev = this.lastTouchTapPos;
        const isDoubleTap =
          this.lastTouchTapTime > 0 &&
          now - this.lastTouchTapTime <= 500 &&
          !!prev &&
          Math.abs(prev.x - pos.x) <= 32 &&
          Math.abs(prev.y - pos.y) <= 32;

        if (isDoubleTap) {
          this.lastTouchTapTime = 0;
          this.lastTouchTapPos = null;
          const dbl = new MouseEvent("dblclick", {
            bubbles: true,
            cancelable: true,
            view: window,
            button: 0,
            clientX: touch.clientX,
            clientY: touch.clientY,
            screenX: touch.screenX,
            screenY: touch.screenY,
          });
          // Route the double-tap through the same handler the mouse
          // double-click uses so touch and mouse behave identically:
          // readOnly ABC → MIDI, readOnly line → onLineDblclk, editable ABC →
          // editor, editable chord/template → chord dialog.
          this.onDoubleClick(dbl);
        } else {
          this.lastTouchTapTime = now;
          this.lastTouchTapPos = pos;
        }

        e.preventDefault();
        e.stopPropagation();
      }
      this.touchActive = false;
    };

    const onTouchCancel = () => {
      cancelLongPressTimer();
      this.longPressStart = null;
      this.longPressSelection = null;
      this.longPressFired = false;
      this.touchActive = false;
      this.suppressNextClickTs = false;
      this.lastTouchTapTime = 0;
      this.lastTouchTapPos = null;
    };

    this.parent_div.addEventListener("touchstart", onTouchStart, listenerOpts);
    this.parent_div.addEventListener("touchmove", onTouchMove, listenerOpts);
    this.parent_div.addEventListener("touchend", onTouchEnd, listenerOpts);
    this.parent_div.addEventListener("touchcancel", onTouchCancel, listenerOpts);

    this.removeTouchEvents = () => {
      cancelLongPressTimer();
      this.parent_div.removeEventListener("touchstart", onTouchStart, listenerOpts);
      this.parent_div.removeEventListener("touchmove", onTouchMove, listenerOpts);
      this.parent_div.removeEventListener("touchend", onTouchEnd, listenerOpts);
      this.parent_div.removeEventListener("touchcancel", onTouchCancel, listenerOpts);
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.instructionsCoordinatorCleanup?.();
    this.instructionsCoordinatorCleanup = null;
    this.instructionsPaneCleanup?.();
    this.instructionsPaneCleanup = null;
    this.instructionsThemeUpdater = null;
    if (this.instructionsInteractionUnlockTimer != null) {
      window.clearTimeout(this.instructionsInteractionUnlockTimer);
      this.instructionsInteractionUnlockTimer = null;
    }
    this.domCaretScrollUnsubscribe?.();
    this.domCaretScrollUnsubscribe = null;
    this.domRenderer?.dispose();
    this.domRenderer = null;
    this.canvasLayout.dispose();

    this.parent_div.removeEventListener("mouseup", this.handleMouseUp);
    this.parent_div.removeEventListener("mousedown", this.handleMouseDown);
    this.parent_div.removeEventListener("mousemove", this.handleMouseMove);
    this.parent_div.removeEventListener("mouseleave", this.handleMouseLeave);
    this.parent_div.removeEventListener("mouseenter", this.handleMouseEnter);
    this.parent_div.removeEventListener("contextmenu", this.handleContextMenu);
    this.hideContextMenu();

    if (this.keyEventTarget) {
      this.keyEventTarget.removeEventListener("keydown", this.handleKeyDown);
      this.keyEventTarget.removeEventListener("keypress", this.handleKeyPress);
      this.keyEventTarget = null;
    }

    this.metaInputs.clear();

    // Clean up abc editor
    if (this.abcEditor) {
      this.abcEditor.dispose();
      this.abcEditor = null;
    }
    this.activeAbcBlock = null;

    // Clean up mobile input proxy textarea
    if (this.textarea) {
      this.textarea.removeEventListener("input", this.handleTextareaInput);
      this.textarea.removeEventListener("compositionstart", this.handleCompositionStart);
      this.textarea.removeEventListener("compositionend", this.handleCompositionEnd);
      if (this.textarea.parentElement) {
        this.textarea.parentElement.removeChild(this.textarea);
      }
      this.textarea = null;
    }

    if (this.removeTouchEvents) {
      this.removeTouchEvents();
      this.removeTouchEvents = null;
    }

    if (this.windowPasteListenerAttached) {
      window.removeEventListener("paste", this.handleWindowPaste);
      this.windowPasteListenerAttached = false;
    }

    if (this.ownsClipboardTextArea && this.clipboardTextArea?.parentElement) {
      this.clipboardTextArea.parentElement.removeChild(this.clipboardTextArea);
    }
    this.clipboardTextArea = null;
    this.ownsClipboardTextArea = false;

    if (this.midiPlayer) {
      this.midiPlayer.stop();
      this.midiPlayer = undefined;
    }
  }

  private isDark = false;

  darkMode(dark: boolean) {
    if (this.isDark !== dark) {
      this.isDark = dark;
      this.chordSelector?.setDarkMode(dark);
      this.applyStylesForCurrentTheme();
      this.invalidateStyleSemantics();
      const input = this.createDomRendererInput();
      if (this.domRenderer && input) this.domRenderer.updateTheme(input);
      this.instructionsThemeUpdater?.();
      this.draw();
    }
  }

  setStyles(styles: ChordProStylesSettings | null) {
    this.customStyles = styles;
    // Remember the root font size at which these styles were authored/applied.
    this.stylesBaseRootFontPx = getRootFontSizePx();
    this.applyStylesForCurrentTheme();
    this.chordsSizeCache = new VersionedMap<string, number, number>(-1);
    for (const lo of this.chordPro?.lines || []) lo.invalidateCache();
    this.invalidateStyleSemantics();
    this.draw();
  }

  private scalePxTokens(value: string, factor: number): string {
    if (!value || !Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 0.0001) return value;
    return value.replace(/(\d+(?:\.\d+)?)px/gi, (_match, num) => {
      const parsed = parseFloat(num);
      if (!Number.isFinite(parsed)) return _match;
      return `${Math.max(1, Math.round(parsed * factor))}px`;
    });
  }

  private applyRootFontScale(display: ChordProDisplayProperties, directives: ChordProDirectiveStyles) {
    const base = this.stylesBaseRootFontPx || 16;
    const current = getRootFontSizePx();
    if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(current) || current <= 0) return;
    const factor = current / base;
    if (Math.abs(factor - 1) < 0.0001) return;

    display.tagFont = this.scalePxTokens(display.tagFont, factor);
    display.chordFont = this.scalePxTokens(display.chordFont, factor);
    display.lyricsFont = this.scalePxTokens(display.lyricsFont, factor);
    display.commentBorder = this.scalePxTokens(display.commentBorder, factor);
    display.chordLineHeight = Math.max(1, Math.round(display.chordLineHeight * factor));
    display.lyricsLineHeight = Math.max(1, Math.round(display.lyricsLineHeight * factor));
    display.chordLyricSep = Math.max(0, Math.round(display.chordLyricSep * factor));
    display.chordBorder = Math.max(0, Math.round(display.chordBorder * factor));

    for (const key of Object.keys(directives)) {
      const style = directives[key];
      if (!style) continue;
      if (style.font) style.font = this.scalePxTokens(style.font, factor);
      if (typeof style.height === "number") style.height = Math.max(0, Math.round(style.height * factor));
      if (typeof style.indent === "number") style.indent = Math.max(0, Math.round(style.indent * factor));
    }
  }

  private applyStylesForCurrentTheme() {
    const defaults = defaultDisplayProperties(this.isDark);
    const defaultDirectiveStyles = defaultStyles(defaults.lyricsFont, this.isDark, (key) => this.localeHandler?.(key) ?? key);
    const currentTheme = this.isDark ? this.customStyles?.dark : this.customStyles?.light;

    if (!currentTheme) {
      this.displayProps = defaults;
      this.directiveStyles = defaultDirectiveStyles;
      return;
    }

    this.displayProps = cloneDisplayProperties({
      ...defaults,
      ...currentTheme.display,
      guitarChordSize: {
        ...defaults.guitarChordSize,
        ...(currentTheme.display?.guitarChordSize ?? {}),
      },
      pianoChordSize: {
        ...defaults.pianoChordSize,
        ...(currentTheme.display?.pianoChordSize ?? {}),
      },
    });

    const mergedDirectiveStyles = cloneDirectiveStyles(defaultDirectiveStyles);
    for (const [key, value] of Object.entries(currentTheme.directives ?? {})) {
      mergedDirectiveStyles[key] = {
        ...(mergedDirectiveStyles[key] ?? {}),
        ...value,
      };
    }

    // Keep custom styles visually aligned with UI font-size changes at runtime.
    this.applyRootFontScale(this.displayProps, mergedDirectiveStyles);

    this.directiveStyles = mergedDirectiveStyles;
  }

  refreshDisplayProps() {
    this.applyStylesForCurrentTheme();
    this.chordsSizeCache = new VersionedMap<string, number, number>(-1);
    for (const lo of this.chordPro?.lines || []) lo.invalidateCache();
    this.invalidateStyleSemantics();
    this.draw();
  }

  isDiff() {
    return this.differentialDisplay;
  }

  hasDoc() {
    return this.chordPro?.hasDocument;
  }

  genDoc() {
    return this.chordPro?.generateDocument() ?? "";
  }

  get parentDiv() {
    return this.parent_div;
  }

  getLayoutSnapshot(): LayoutSnapshot {
    if (this.domRenderer) return this.domRenderer.getLayoutSnapshot();
    return this.canvasLayout.getSnapshot();
  }

  setViewportAlignedTitleGeometry(width: number, rootOffset: number) {
    this.domRenderer?.setViewportAlignedTitleGeometry(width, rootOffset);
  }

  subscribeLayout(listener: LayoutListener) {
    if (this.domRenderer) return this.domRenderer.subscribeLayout(listener);
    return this.canvasLayout.subscribe(listener);
  }

  whenLayoutSettled(afterRevision?: number): Promise<LayoutSnapshot> {
    if (this.domRenderer) return this.domRenderer.whenLayoutSettled(afterRevision);
    return this.canvasLayout.whenSettled(afterRevision);
  }

  private completeDocumentMutation() {
    this.documentRevision += 1;
    this.semanticDocumentText = this.chordProCode;
    this.invalidateDisplaySequence();
  }

  /**
   * Records that this host fits the song to a pane (see `fitsToPane`). It is a
   * display-semantics change, so it must advance the display revision — the
   * renderer's commit key is built from those revisions, and without the bump a
   * layout committed before the first `fitToPane` would never be recomputed.
   */
  markFitsToPane() {
    if (this.fitsToPane) return;
    this.fitsToPane = true;
    this.invalidateDisplaySemantics();
  }

  private invalidateDisplaySemantics() {
    this.displayRevision += 1;
    // The projection is a pure function of the document, read-only mode, the
    // instruction list and the projection mode. Every change to those bumps one
    // of these revisions, so dropping the cache here keeps the previously
    // recomputed-every-draw raw synthesis correct now that it is cached.
    this.invalidateDisplaySequence();
  }

  /**
   * Drops the cached raw/instructed projection. Every site that replaces the
   * document, the instruction list, or the projection mode must call this so
   * the display plan re-projects.
   */
  private invalidateDisplaySequence() {
    this.displaySequence = undefined;
    this.displayLines = undefined;
    this.instructedSectionGroups = undefined;
    this.instructedSectionLabels = undefined;
  }

  private invalidateStyleSemantics() {
    this.styleRevision += 1;
  }

  private acceptDisplayOnlyDocumentProjection() {
    this.semanticDocumentText = this.chordProCode;
  }

  /**
   * Chord-diagram integration for the DOM backend. The renderer owns the
   * region, the placement policy and the diagram elements' lifecycle, while
   * chord identification/drawing stay here because they depend on the chord
   * selector and drawer.
   */
  private createDiagramInput(): DomDiagramInput | null {
    // Gated on `chordBoxType` alone: diagrams are NOT readonly-only.
    if (!this.chordPro || !this.chordBoxType || this.printSurface) return null;
    const chordBoxType = this.chordBoxType;
    const chordSet = new Map<string, string>();
    let displayNormalizedChord = this.displayNormalizedChord;
    this.chordPro.forAllChords((chord) => {
      const details = this.getChordDetails(chord);
      if (!details) return;
      const suffix = details.bassNote ? "/" + details.bassNote : "";
      const key = details.baseNote + details.normalized + suffix;
      const value = details.baseNote + details.modifier + suffix;
      if (!displayNormalizedChord) {
        const prev = chordSet.get(key);
        if (prev) displayNormalizedChord = prev !== value;
      }
      chordSet.set(key, value);
    });

    const chords: string[] = [];
    chordSet.forEach((value, key) => chords.push(displayNormalizedChord ? key : value));
    return {
      chords,
      size: chordBoxType === "PIANO" ? this.displayProps.pianoChordSize : this.displayProps.guitarChordSize,
      targetRatio: this.targetRatio,
      canRender: (chord) =>
        chordBoxType === "PIANO" ? !!this.system.identifyChord(chord) : !!(this.getActualChordLayout(chord) && this.chordSelector),
      draw: (chord, svg) => this.drawDomChordDiagram(chordBoxType, chord, svg),
    };
  }

  private drawDomChordDiagram(chordBoxType: ChordBoxType, chord: string, svg: SVGSVGElement) {
    const size = chordBoxType === "PIANO" ? this.displayProps.pianoChordSize : this.displayProps.guitarChordSize;
    if (!svg.dataset.ppDiagramBound) {
      svg.dataset.ppDiagramBound = "1";
      svg.style.cursor = "pointer";
      // Variant cycling (drag) / play (tap). These listeners live on
      // renderer-owned svg nodes and are removed with them. Mouse and touch
      // share one gesture resolution so both pointer types behave identically:
      // a >10px move cycles the fingering variant, a tap plays the chord.
      const applyGesture = (dx: number, dy: number) => {
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
          const offset = dx < 0 || dy < 0 ? -1 : 1;
          this.chordVariantCache.set(chord, (this.chordVariantCache.get(chord) || 0) + offset);
          this.draw();
        } else {
          const BoxType = chordBoxType === "PIANO" ? PianoChordHitBox : GuitarChordHitBox;
          this.playChord(new BoxType(0, 0, size.width, size.height, chord));
        }
      };
      let mouseDownPos: { x: number; y: number } | null = null;
      svg.addEventListener("mousedown", (e: MouseEvent) => {
        e.stopPropagation();
        mouseDownPos = { x: e.offsetX, y: e.offsetY };
      });
      svg.addEventListener("mouseup", (e: MouseEvent) => {
        e.stopPropagation();
        if (!mouseDownPos) return;
        const dx = e.offsetX - mouseDownPos.x;
        const dy = e.offsetY - mouseDownPos.y;
        mouseDownPos = null;
        applyGesture(dx, dy);
      });
      // Touch: synthetic mouse events don't carry usable offsetX/offsetY, so the
      // parent touch pipeline can't tell a drag from a tap on the diagram. Own
      // the gesture directly from touch coordinates and suppress both the parent
      // pipeline (stopPropagation) and the browser's compatibility mouse events
      // (preventDefault) so the diagram is never handled twice.
      let touchStartPos: { x: number; y: number } | null = null;
      svg.addEventListener(
        "touchstart",
        (e: TouchEvent) => {
          if (e.changedTouches.length !== 1) return;
          e.stopPropagation();
          e.preventDefault();
          const t = e.changedTouches[0];
          touchStartPos = { x: t.clientX, y: t.clientY };
        },
        { passive: false }
      );
      svg.addEventListener("touchend", (e: TouchEvent) => {
        if (!touchStartPos || e.changedTouches.length !== 1) return;
        e.stopPropagation();
        const t = e.changedTouches[0];
        const dx = t.clientX - touchStartPos.x;
        const dy = t.clientY - touchStartPos.y;
        touchStartPos = null;
        applyGesture(dx, dy);
      });
    }
    // Resolution-independent: the svg carries a viewBox at the diagram's nominal
    // size and scales with the fit-to-screen transform WITHOUT rasterizing, so a
    // large scale factor no longer blurs the diagram (the old fixed-size canvas
    // backing store did).
    this.chordBoxDrawSvg(chordBoxType, chord, svg, size);
  }

  private createDomRendererInput(): DomSongRendererInput | null {
    if (!this.chordPro) return null;
    return {
      document: this.chordPro,
      system: this.system,
      display: this.displayProps,
      directives: this.directiveStyles,
      chordFormat: this.chordFormat,
      showTitle: this.showTitle,
      showMeta: this.showMeta,
      showTags: this.showTag,
      abbreviateTags: this.abbrevTag,
      readOnly: this.readOnly,
      differential: this.differentialDisplay,
      instructionsMode: this.instructionsRenderMode,
      widthPolicy: this.printSurface ? "PRINT" : this.autoSplitLines ? "FIT_WIDTH" : "FIT_PAGE",
      clipMetaToSongWidth: this.fitsToPane,
      viewportAlignedTitle: this.viewportAlignedTitle,
      sequence: this.getDisplaySequence(),
      isDark: this.isDark,
      highlight: this.highlighted,
      highlightOpacity: this.highlightOpacity,
      diagrams: this.createDiagramInput(),
      editing: this.createDomEditingInput(),
      metaInputs: this.readOnly ? null : this.getDomMetaInputHost(),
      chordStrip: this.createDomChordStripInput(),
      keyIsAuto: this.keyIsAuto,
      localize: (key) => this.localize(key),
      overlayRevMoveCost: Settings.current.chordRevMoveCost,
      overlayFwdMoveCost: Settings.current.chordFwdMoveCost,
      moveChordsOnly: Settings.current.moveChordsOnly,
      documentRevision: this.documentRevision,
      displayRevision: this.displayRevision,
      styleRevision: this.styleRevision,
    };
  }

  /**
   * Editing decorations for the DOM backend. Lines and chords are passed by
   * OBJECT identity — never index — and columns stay the editor's UTF-16
   * offsets; the renderer clamps display to valid visual boundaries via its
   * caret stops. Covers the lyric caret/selection, chord and tag raw-text
   * caret/selection, the drag ghost and drop marker, and marking state.
   */
  private createDomEditingInput(): DomEditingInput | null {
    if (this.readOnly || !this.chordPro) return null;
    const caret = this.actionTarget instanceof ChordProLine && this.cursorPos != null ? { line: this.actionTarget, column: this.cursorPos } : null;
    let selection: DomEditingInput["selection"] = null;
    if (
      this.selectionStart instanceof ChordProSelection &&
      this.selectionEnd instanceof ChordProSelection &&
      this.comparePositions(this.selectionStart, this.selectionEnd) !== 0
    ) {
      const lines = this.chordPro.lines;
      if (lines.length > 0) {
        const clampLine = (index: number) => Math.max(0, Math.min(index, lines.length - 1));
        const startIndex = clampLine(this.selectionStart.line);
        const endIndex = clampLine(this.selectionEnd.line);
        // `selectAll` deliberately points one PAST the last line (a legacy
        // quirk its canvas paint loop tolerates); clamp it to the last line's
        // trailing boundary for the renderer.
        const endColumn = this.selectionEnd.line >= lines.length ? lines[endIndex].lyrics.length : this.selectionEnd.col;
        selection = { startLine: lines[startIndex], startColumn: this.selectionStart.col, endLine: lines[endIndex], endColumn };
      }
    }

    // Chord and tag editing share the editor's NUMBER-valued selection state
    // (lyric selection uses `ChordProSelection`), so the action target decides
    // which raw text those offsets belong to.
    const textRange = {
      caret: typeof this.cursorPos === "number" ? this.cursorPos : null,
      selectionStart: typeof this.selectionStart === "number" ? this.selectionStart : null,
      selectionEnd: typeof this.selectionEnd === "number" ? this.selectionEnd : null,
    };
    const chordText = this.actionTarget instanceof ChordProChord ? { chord: this.actionTarget, ...textRange } : null;
    const tagText = this.actionTarget instanceof ChordProTagHitBox ? { line: this.actionTarget.target, ...textRange } : null;

    let drag: DomEditingInput["drag"] = null;
    if (this.actionTarget instanceof ChordProChordHitBox && this.dragData) {
      drag = {
        chord: this.actionTarget.chord,
        text: this.actionTarget.chord.text,
        left: this.actionTarget.left,
        top: this.actionTarget.top,
        marker: this.chordDropMarker,
        noDrop: false,
      };
    } else if (this.actionTarget instanceof ChordTemplateHitBox) {
      // A template dragged out of the strip, before it becomes a real chord.
      drag = { chord: null, text: this.actionTarget.chord, left: this.actionTarget.left, top: this.actionTarget.top, marker: null, noDrop: true };
    }

    return { caret, selection, chordText, tagText, drag };
  }

  /**
   * Chord-template strip input. The controller resolves the safe
   * token model and owns the gestures; the renderer owns the nodes and the
   * gutter geometry.
   */
  private createDomChordStripInput(): DomChordStripInput | null {
    if (this.readOnly || !this.chordPro) return null;
    const chordSet = new Map<string, string>();
    let displayNormalizedChord = this.displayNormalizedChord;
    this.chordPro.forAllChords((chord) => {
      const details = this.getChordDetails(chord);
      if (!details) return;
      const suffix = details.bassNote ? "/" + details.bassNote : "";
      const key = details.baseNote + details.normalized + suffix;
      const value = details.baseNote + details.modifier + suffix;
      if (!displayNormalizedChord) {
        const prev = chordSet.get(key);
        if (prev) displayNormalizedChord = prev !== value;
      }
      chordSet.set(key, value);
    });
    const chords: string[] = [];
    chordSet.forEach((value) => chords.push(value));
    if (chords.length === 0) return null;
    return {
      chords: chords.sort(),
      gap: Math.max(0, 0.5 * getRootFontSizePx()),
      visual: (chord) =>
        buildChordVisualModel({
          chord,
          chordDetails: this.getChordDetails(chord),
          system: this.system,
          chordFormat: this.chordFormat,
          readOnly: this.readOnly,
        }),
      onPointerDown: (chord, event) => this.beginTemplateDrag(chord, event),
      onDoubleClick: (chord, event) => {
        event.stopPropagation();
        if (!this.chordSelector || !this.multiChordChangeEnabled) return;
        const box = new ChordTemplateHitBox(0, 0, 0, this.displayProps.chordLineHeight, chord);
        if (!this.readOnly) this.changeActionTarget(box);
        this.chordSelector.showDialog(chord, this.readOnly, this.isDark);
      },
    };
  }

  /**
   * Starts a chord-template drag from the strip. Shared by both backends: the
   * canvas strip items call it from their own listeners, the DOM strip through
   * the renderer's `DomChordStripInput` port.
   */
  private beginTemplateDrag(chord: string, e: MouseEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startPos = this.normalizeClientPos(e.clientX, e.clientY);
    const width = this.measureChordWidth(chord);
    this.changeActionTarget(new ChordTemplateHitBox(startPos.x, startPos.y, width, this.displayProps.chordLineHeight, chord));
    this.dragData = null;
    this.cursorPos = null;
    this.selectionStart = null;
    this.selectionEnd = null;
    this.lastMouseDown = { x: startPos.x, y: startPos.y };
    this.draw();
  }

  /**
   * Chord-template gutter width, owned by the DOM renderer and reported through
   * its geometry index.
   */
  private get activeChordStripWidth() {
    return this.domRenderer?.getGeometryIndex()?.stripWidth ?? 0;
  }

  /**
   * Right edge of the tag lane INCLUDING its separation gap — where a dragged
   * section label counts as being back in the tag column. The DOM renderer's
   * `contentLeft` is that boundary by construction.
   */
  private get activeTagsStripWidth() {
    return this.domRenderer?.getGeometryIndex()?.occurrences[0]?.contentLeft ?? 0;
  }

  /**
   * The section label's hit box for `line`, from the renderer's geometry index.
   * Returns null when the label is not currently displayed.
   */
  private findTagHitBox(line: ChordProLine): ChordProTagHitBox | null {
    const geometry = this.domRenderer?.getGeometryIndex();
    if (!geometry) return null;
    for (const entry of geometry.occurrences) {
      if (!entry.tag) continue;
      if (entry.occurrence.source !== line && entry.occurrence.origin !== line) continue;
      return new ChordProTagHitBox(entry.tag.left, entry.tag.top, entry.tag.width + this.tagHitExtension(), entry.tag.height, line, entry.tag.name);
    }
    return null;
  }

  /**
   * Drag cursor for the ACTIVE song surface. The canvas is detached while the
   * DOM backend is mounted, so styling it would silently do nothing.
   */
  private setSurfaceCursor(cursor: string) {
    const surface = this.domRenderer?.element;
    if (surface) surface.style.cursor = cursor;
  }

  /**
   * Chord-text width in the chord font, for drag-ghost box sizing. Measured
   * through the DOM renderer's batched `DomTextMeasurer`. A raw-text width is
   * an adequate ghost dimension; the visible chord is laid out by the renderer.
   */
  private measureChordWidth(chord: string) {
    return this.domRenderer?.measureTextWidth(chord, this.displayProps.chordFont) ?? this.displayProps.chordLineHeight;
  }

  /**
   * Metadata-input host for the DOM backend. The SAME `metaInputs` map
   * entries are mounted into the renderer's normal-flow
   * meta rows, so `createState`/`applyState` (undo action target), Tab/arrow
   * navigation via `selectMetaData`, and the input listeners all keep working.
   * The renderer re-mounts these elements by identity across commits, which is
   * what preserves focus and IME composition through a full keyed reconcile.
   */
  private getDomMetaInputHost(): DomMetaInputHost {
    if (this.domMetaInputHost) return this.domMetaInputHost;
    this.domMetaInputHost = {
      mount: (meta, container) => {
        let el = this.metaInputs.get(meta.name);
        if (!el) {
          el = this.createMetaRow(meta.name);
          this.metaInputs.set(meta.name, el);
        }
        // Normal-flow hosting: the renderer's wrapper row carries the
        // geometry (height/font/color/indent), so the controller row fills it.
        el.row.style.position = "relative";
        el.row.style.left = "";
        el.row.style.top = "";
        el.row.style.width = "100%";
        el.row.style.height = "100%";
        el.row.style.font = "inherit";
        el.row.style.color = "inherit";
        el.row.style.backgroundColor = "transparent";
        el.row.style.pointerEvents = this.readOnly ? "none" : "auto";
        const align = container.style.textAlign || meta.align;
        el.row.dataset.requestedAlign = meta.align;
        el.row.dataset.safeCenter = this.viewportAlignedTitle && meta.name === "title" ? "true" : "";
        el.row.style.textAlign = align;
        el.row.style.justifyContent = align === "right" ? "flex-end" : align === "center" ? "center" : "";
        el.prefix.style.font = "inherit";
        el.prefix.style.color = "inherit";
        const prefix = this.directiveStyles[meta.name]?.prefix ?? "";
        el.prefix.textContent = prefix ? prefix + ":\u00a0" : "";
        el.value.readOnly = this.readOnly;
        // The input edits the RAW metadata value; readonly key adornments
        // (signature/robot symbols) exist only in the readonly text path.
        const raw = this.chordPro?.getMeta(meta.name) ?? "";
        if (document.activeElement !== el.value && el.value.value !== raw) el.value.value = raw;
        this.updateMetaInputWidth(meta.name, raw);
        if (el.row.parentElement !== container) container.replaceChildren(el.row);
      },
      relayout: (name) => this.updateMetaInputWidth(name),
      prune: (live) => {
        for (const [name, el] of [...this.metaInputs]) {
          if (live.has(name)) continue;
          el.row.remove();
          this.metaInputs.delete(name);
        }
      },
    };
    return this.domMetaInputHost;
  }

  /**
   * Rightward extension of a section label's hit box past its text, into the
   * tag/lyrics separation gap. Roughly one character at the current size, so
   * "just after the label" still hits the label's trailing caret position.
   */
  private tagHitExtension() {
    return this.displayProps.lyricsLineHeight / 2;
  }

  /**
   * The instructions source pane temporarily replaces the DOM song surface this
   * editor instance would normally expose. Reconciliation must not make that
   * surface visible again while the instructions binding owns the host.
   */
  private syncPrimarySurfaceVisibility() {
    const available = !this.instructionEditorActive;
    if (this.domRenderer) this.domRenderer.element.style.display = available ? "" : "none";
  }

  /**
   * Mounts or updates the DOM song renderer — the only backend. It commits the
   * frame on a `requestAnimationFrame`, so this is the single render entry point
   * every controller mutation funnels through `draw()`.
   */
  private reconcileRenderBackend(category: InvalidationCategory = "structure") {
    const input = this.createDomRendererInput();
    if (!input) {
      // No document to project yet; nothing to mount. A bound instructions pane
      // still needs its hide state kept in sync.
      this.syncPrimarySurfaceVisibility();
      return;
    }

    if (this.domRenderer) this.domRenderer.update(input, category);
    else {
      this.domRenderer = new DomSongRenderer(this.parent_div, input);
      // Caret scroll-into-view: the DOM backend commits on a frame, so the hook
      // is its post-commit notification, firing once per commit.
      this.domCaretScrollUnsubscribe = this.domRenderer.subscribeLayout(() => this.scrollDomCaretIntoView());
    }
    this.syncPrimarySurfaceVisibility();
  }

  /**
   * Keeps the DOM caret visible: only a caret outside the viewport scrolls,
   * and it lands one chord+lyric line inside the edge.
   */
  private scrollDomCaretIntoView() {
    if (this.disposed || this.readOnly) return;
    if (!(this.actionTarget instanceof ChordProLine) || this.cursorPos == null) return;
    const geometry = this.domRenderer?.getGeometryIndex();
    const root = this.domRenderer?.element;
    if (!geometry || !root) return;
    const caret = resolveCaretGeometry(geometry, this.actionTarget, this.cursorPos);
    if (!caret) return;

    const parentDiv = this.parent_div;
    const scrollTop = parentDiv.scrollTop;
    const viewportHeight = parentDiv.clientHeight;
    const margin = this.displayProps.chordLineHeight + this.displayProps.lyricsLineHeight;
    // Root-local y is logical-pixel and the root commits that same logical size
    // as its CSS box, so the only conversion needed is the root's own offset
    // inside the scrolling host.
    const top = root.offsetTop + caret.top;

    let newScrollTop = 0;
    if (top < scrollTop) newScrollTop = top - margin;
    else if (top + caret.height > scrollTop + viewportHeight) newScrollTop = top + caret.height - viewportHeight + margin;
    if (newScrollTop) {
      newScrollTop = Math.max(0, Math.min(newScrollTop, parentDiv.scrollHeight - viewportHeight));
      parentDiv.scrollTo({ top: newScrollTop });
    }
  }

  getCapo() {
    return this.chordPro?.capo ?? 0;
  }

  getKey() {
    return this.chordPro?.key;
  }

  setDisplayMode(
    title: boolean,
    meta: boolean,
    tag: boolean,
    abbrevTag: boolean,
    autoSplitLines: boolean,
    chordFlags: number,
    chordBoxType?: ChordBoxType,
    keepDrawingSuppressed?: boolean
  ) {
    let updateRequired = false;
    let chordVisualFormatChanged = false;
    if (this.showTitle !== title) {
      this.showTitle = title;
      updateRequired = true;
    }
    if (this.showMeta !== meta) {
      this.showMeta = meta;
      updateRequired = true;
    }
    if (this.showTag !== tag) {
      this.showTag = tag;
      updateRequired = true;
    }
    if (this.abbrevTag !== abbrevTag) {
      this.abbrevTag = abbrevTag;
      updateRequired = true;
    }
    if (this.autoSplitLines !== autoSplitLines) {
      this.autoSplitLines = autoSplitLines;
      updateRequired = true;
    }
    if (this.chordFormat !== chordFlags) {
      this.chordFormat = chordFlags;
      updateRequired = true;
      chordVisualFormatChanged = true;
    }
    if (chordBoxType !== undefined && this.chordBoxType !== chordBoxType) {
      this.chordBoxType = chordBoxType;
      updateRequired = true;
    }
    if ((chordFlags & CHORDFORMAT_INKEY) === CHORDFORMAT_INKEY && this.chordPro && !this.chordPro.key) {
      const key = this.guessKey();
      if (key) {
        this.chordPro.setMeta("key", key);
        this.keyIsAuto = true;
        this.acceptDisplayOnlyDocumentProjection();
      }
      updateRequired = true;
    }
    if (updateRequired) {
      if (this.chordPro) for (const line_obj of this.chordPro.lines) line_obj.invalidateCache();
      this.invalidateDisplaySemantics();
      if (chordVisualFormatChanged) this.invalidateStyleSemantics();
      this.draw(keepDrawingSuppressed);
    }
  }

  enableInstructionRendering(mode: InstructionsRenderMode, draw = true) {
    if (this.instructionsRenderMode !== mode) {
      this.instructionsRenderMode = mode;
      this.invalidateDisplaySequence();
      this.invalidateDisplaySemantics();
    }
    if (draw) this.draw();
  }

  setReadOnly(readOnly: boolean, multiChordChangeEnabled?: boolean) {
    if (multiChordChangeEnabled !== undefined) this.multiChordChangeEnabled = multiChordChangeEnabled;

    if (this.chordPro && this.readOnly !== readOnly) {
      for (const line of this.chordPro.lines) line.invalidateCache();
      this.readOnly = readOnly;
      this.invalidateDisplaySequence();
      this.invalidateDisplaySemantics();

      // Toggle existing meta inputs between editable and inert
      for (const [, el] of this.metaInputs) {
        el.value.readOnly = readOnly;
        el.row.style.pointerEvents = readOnly ? "none" : "auto";
      }

      this.clearActionState();
      this.draw();
    }
  }

  clearActionState() {
    if (this.actionTarget instanceof ChordProChord) {
      this.actionTarget.text = this.actionTarget.text.trim();
      this.actionTarget.line.invalidateCache();
    }

    this.changeActionTarget(null);
    this.cursorPos = null;
    this.selectionStart = null;
    this.selectionEnd = null;
    this.dragData = null;
  }

  createState() {
    let target: number | string | ChordPosition | null = null;

    if (this.actionTarget) {
      if (this.actionTarget instanceof ChordProLine) target = this.actionTarget.getLineIndex();
      else if (this.actionTarget instanceof ChordProChordHitBox) {
        const line_obj = this.actionTarget.chord.line;
        target = { line: line_obj.getLineIndex(), chord: line_obj.chords.indexOf(this.actionTarget.chord) };
      }
    }

    // Check if a metadata HTML input is focused
    if (!target) {
      for (const [styleName, el] of this.metaInputs) {
        if (el.value === document.activeElement) {
          target = styleName;
          break;
        }
      }
    }

    return {
      data: this.chordProCode,
      cursorTarget: target || 0,
      cursorPos: this.cursorPos || 0,
    };
  }

  saveState() {
    if (this.inApplyState) return;
    this.redoBuffer = [];

    this.undoBuffer.push(this.createState());
    if (this.undoBuffer.length > this.maxUndoSize) this.undoBuffer.splice(0, this.undoBuffer.length - this.maxUndoSize);
  }

  applyState(state: ChordProEditorState) {
    this.inApplyState = true;

    try {
      const target = state.cursorTarget;

      this.clearActionState();
      this.invalidateDisplaySequence();
      this.chordPro = new ChordProDocument(this.system, state.data);
      this.cursorPos = state.cursorPos;

      if (typeof target === "string") {
        // Metadata target: focus the HTML input if available.
        const metaEl = this.metaInputs.get(target);
        if (metaEl && metaEl.value instanceof HTMLInputElement) metaEl.value.focus();
      } else if (typeof target !== "number") {
        // Chord target, resolved straight from the restored document by line
        // and chord ordinal — no paint has to happen first.
        const chord = this.chordPro.lines[target.line]?.chords[target.chord];
        if (chord) this.changeActionTarget(chord);
      } else this.changeActionTarget(this.chordPro.lines[target]);

      this.draw();
    } finally {
      this.inApplyState = false;
    }
  }

  undo() {
    if (this.undoBuffer.length > 0) {
      const state = this.undoBuffer.pop();
      this.redoBuffer.push(this.createState());
      if (state) this.applyState(state);
    }
  }

  redo() {
    if (this.redoBuffer.length > 0) {
      const state = this.redoBuffer.pop();
      this.undoBuffer.push(this.createState());
      if (state) this.applyState(state);
    }
  }

  changeActionTarget(target: ActionTarget) {
    if (this.actionTarget !== target) {
      if (this.actionTarget instanceof ChordProChord) {
        const chord = this.actionTarget;
        chord.text = chord.text.trim();
        if (!chord.text) chord.line.removeChord(chord);
        chord.line.genText();
        this.draw();
      }
      this.actionTarget = target;
    }
  }

  moveChord(chord: ChordProChord, offset: number) {
    const line_obj = chord.line;
    if (offset > 0) {
      let limit = line_obj.text.length,
        next = false;
      for (const ch of line_obj.chords) {
        if (next) {
          limit = ch.pos;
          break;
        }
        next = ch === chord;
      }
      chord.pos = Math.min(chord.pos + offset, limit);
    } else if (offset < 0) {
      let limit = 0;
      for (let i = 1, length = line_obj.chords.length; i < length; ++i)
        if (line_obj.chords[i] === chord) {
          limit = line_obj.chords[i - 1].pos + 1;
          break;
        }
      chord.pos = Math.max(chord.pos + offset, limit);
    } else return;
    chord.line.genText();
  }

  convertChordPrefixToPos(chord: ChordProChord) {
    let offset = 0;
    chord.text = chord.text.replace(/^\s+/g, (s) => {
      if (this.cursorPos) this.cursorPos -= Math.min(s.length, this.cursorPos);
      for (const c of s) offset += c === " " ? 1 : 4;
      return "";
    });
    this.moveChord(chord, offset);
  }

  eraseSelection(pos?: number | ChordProSelection) {
    if (!this.chordPro) return;

    if (
      this.selectionStart instanceof ChordProSelection &&
      this.selectionEnd instanceof ChordProSelection &&
      this.comparePositions(this.selectionStart, this.selectionEnd)
    ) {
      this.saveState();
      if (this.selectionStart.line + 1 < this.selectionEnd.line) {
        const start = this.selectionStart.line + 1,
          count = this.selectionEnd.line - start;
        this.chordPro.lines.splice(start, count);
        if (pos instanceof ChordProSelection) pos.line -= Math.max(0, this.selectionEnd.line - pos.line);
        this.selectionEnd.line -= count;
      }

      if (this.selectionStart.line < this.selectionEnd.line) {
        const l1 = this.chordPro.lines[this.selectionEnd.line];
        let i = 0;
        while (i < l1.chords.length && l1.chords[i].pos < this.selectionEnd.col) ++i;
        if (i > 0) l1.chords.splice(0, i);
        l1.deleteString(0, this.selectionEnd.col);

        if (pos instanceof ChordProSelection && pos.line === this.selectionEnd.line) pos.col -= Math.max(0, this.selectionEnd.col - pos.col);
        const l2 = this.chordPro.lines[this.selectionStart.line];
        i = l2.chords.length;
        while (--i >= 0 && l2.chords[i].pos >= this.selectionStart.col);
        if (l2.chords.length > i) l2.chords.splice(i, l2.chords.length - i);
        l2.deleteString(this.selectionStart.col, l2.lyrics.length - this.selectionStart.col);

        if (pos instanceof ChordProSelection && pos.line === this.selectionStart.line && pos.col > this.selectionStart.col)
          pos.col = this.selectionStart.col;
        l2.combineWithNext();
        this.changeActionTarget(l2);
      } else {
        const line_obj = this.chordPro.lines[this.selectionStart.line],
          count = this.selectionEnd.col - this.selectionStart.col;
        line_obj.deleteString(this.selectionStart.col, count);
        if (pos instanceof ChordProSelection && pos.line === this.selectionStart.line) pos.col -= Math.max(0, this.selectionEnd.col - pos.col);
        this.changeActionTarget(line_obj);
      }

      if (this.chordPro.lines.length === 0) this.chordPro.lines.push(new ChordProLine(this.chordPro));
      this.cursorPos = this.selectionStart.col;
      this.selectionStart = null;
      this.selectionEnd = null;

      for (const line_obj of this.chordPro.lines) line_obj.genText();

      return true;
    }

    if (typeof this.selectionStart === "number" && typeof this.selectionEnd === "number") {
      let text = "";

      if (this.actionTarget instanceof ChordProChord) text = this.actionTarget.text;
      else if (this.actionTarget instanceof ChordProLineHitBox) text = this.actionTarget.target.lyrics;
      else if (this.actionTarget instanceof ChordProTagHitBox) text = this.actionTarget.target.styles.get(this.actionTarget.parameter);
      else return false;

      this.saveState();
      text = text.substr(0, this.selectionStart) + text.substr(this.selectionEnd);

      if (this.actionTarget instanceof ChordProChord) {
        this.actionTarget.text = text;
        this.actionTarget.line.genText();
      } else if (this.actionTarget instanceof ChordProTagHitBox) this.setTagName(this.actionTarget.target, this.actionTarget.parameter, text);

      this.cursorPos = this.selectionStart;
      this.selectionStart = null;
      this.selectionEnd = null;
      return true;
    }

    return false;
  }

  private updateMouseDownPos(e: MouseEvent, skipTs?: boolean) {
    const suppressTs = !!skipTs || this.suppressNextClickTs;
    this.suppressNextClickTs = false;
    if (!suppressTs) {
      const now = Date.now();
      if (now < this.prevClickTime + 500) {
        this.prevClickTime = 0;
        setTimeout(() => this.onDoubleClick(e), 10);
      }
      this.prevClickTime = now;
    }
    return (this.lastMouseDown = this.normalizeMousePos(e));
  }

  private getActiveMetaInput() {
    if (!(document.activeElement instanceof HTMLInputElement)) return null;
    for (const [, el] of this.metaInputs) if (el.value === document.activeElement) return document.activeElement;
    return null;
  }

  /**
   * True when an event target belongs to a metadata input row in the renderer's
   * normal-flow meta root.
   */
  private isMetaInputTarget(target: EventTarget | null) {
    if (!(target instanceof Node)) return false;
    for (const [, el] of this.metaInputs) if (el.row.contains(target)) return true;
    return false;
  }

  onMouseDown(e: MouseEvent) {
    if (this.chordSelector && this.chordSelector.inModal) {
      // Don't close the dialog if the click is inside the chord selector
      if (e.target instanceof Node && this.chordSelector.parent.contains(e.target)) {
        return;
      }
      this.chordSelector.closeDialog(false, true);
      return;
    }

    // Block canvas interaction while ABC editor modal is open
    if (this.abcEditor?.isOpen) return;

    const targetInMeta = this.isMetaInputTarget(e.target);
    if (!targetInMeta) {
      const activeMetaInput = this.getActiveMetaInput();
      if (activeMetaInput) {
        // Leaving metadata editing: blur active meta input so canvas edit can proceed.
        activeMetaInput.blur();
        this.pendingCanvasFocusAfterMetaBlur = true;
      }
    } else {
      this.pendingCanvasFocusAfterMetaBlur = false;
    }

    // Let HTML metadata inputs handle their own events
    if (targetInMeta) {
      return;
    }

    // The DOM chord strip and diagram canvases carry their own listeners that
    // stop propagation, so their taps never reach this handler.

    const box = this.HitTest(e);
    this.lastMouseDownHadHit = !!box;
    if (this.currentlyMarked !== undefined) {
      this.currentlyMarked = new Set();
      if (box instanceof ChordProChordHitBox && box.chord.marked >= 0 && !this.currentlyMarked.has(box.chord)) {
        box.chord.marked = box.chord.marked ? 0 : 1;
        this.currentlyMarked.add(box.chord);
      } else if (box instanceof ChordProLineHitBox && box.target.marked >= 0 && !this.currentlyMarked.has(box.target)) {
        box.target.marked = box.target.marked ? 0 : 1;
        this.currentlyMarked.add(box.target);
      } else return;
      this.updateMouseDownPos(e);
      this.draw();
      return;
    }

    const skipTs = this.suppressNextClickTs;
    this.suppressNextClickTs = false;
    this.updateMouseDownPos(e, skipTs);
    if (this.readOnly) return true;

    // Don't call focus() here — it's called in onMouseUp.
    // Calling textarea.focus() during touchstart interrupts touch gesture
    // tracking on mobile, breaking text selection and chord drag-and-drop.
    if (box) {
      if (box instanceof ChordTemplateHitBox) {
        this.changeActionTarget(box);
        this.dragData = null;
        this.cursorPos = null;
      } else if (box instanceof ChordProChordHitBox) {
        this.changeActionTarget(box);
        this.dragData = null;
        this.cursorPos = null;
      } else if (box instanceof ChordProTagHitBox) {
        this.changeActionTarget(box);
        this.dragData = this.calcCursorPos(box, e);
        this.cursorPos = null;
      } else if (box instanceof ChordProLineHitBox) {
        this.dragData = new ChordProSelection(box.target.getLineIndex(), box.column);
        this.changeActionTarget(null);
        this.cursorPos = null;
      }
      // Preserve selection on right-click so the context menu sees it
      if (e.button !== 2) {
        this.selectionStart = null;
        this.selectionEnd = null;
      }
      this.draw();
    }
  }

  private checkChordBoxTouch(lp: Point) {
    if (!this.lastMouseDown) return false;
    const box = this.HitTestCoords(this.lastMouseDown);
    if (box instanceof ChordBoxHitBox) {
      let offset = 0;
      if (lp.x < box.left || lp.y < box.top) offset = -1;
      else if (lp.x > box.left + box.width || lp.y > box.top + box.height) offset = 1;
      if (offset) {
        const variant = (this.chordVariantCache.get(box.chord) || 0) + offset;
        this.chordVariantCache.set(box.chord, variant);
        this.draw();
        return true;
      }
      this.playChord(box);
      return true;
    }
    return false;
  }

  handleExternalChordBoxTouch(event: MouseEvent, down: boolean, showChordDialog?: boolean) {
    const pos = this.normalizeMousePos(event);
    if (down) {
      const box = this.HitTestCoords(pos);
      if (box && (box instanceof ChordBoxHitBox || box instanceof ChordProChordHitBox)) {
        this.updateMouseDownPos(event);
        return box instanceof ChordBoxHitBox;
      }
    } else if (this.checkChordBoxTouch(pos) || (showChordDialog && this.checkChordBoxOrTemplateHit(event))) {
      this.lastMouseDown = null;
      return true;
    }
    return false;
  }

  onMouseUp(e: MouseEvent, leave = false) {
    if (this.chordSelector && this.chordSelector.inModal) return;

    if (this.currentlyMarked !== undefined) this.currentlyMarked = new Set();

    if (this.readOnly) {
      let rv = true;
      if (this.lastMouseDown) {
        const pos = this.normalizeMousePos(e);
        if (this.checkChordBoxTouch(pos)) {
          e.preventDefault();
          rv = false;
        } else if (!leave && Math.abs(this.lastMouseDown.x - pos.x) <= 10 && Math.abs(this.lastMouseDown.y - pos.y) <= 10) {
          const line_obj = this.onLineSel || this.onLyricsHit ? this.HitTestLine(e) : null;
          if (this.onLineSel && line_obj && line_obj.sourceLineNumber >= 0) {
            this.onLineSel(line_obj.sourceLineNumber);
            e.preventDefault();
            rv = false;
          }

          if (this.onLyricsHit && line_obj && !line_obj.isInstrumental) {
            const mp = this.normalizeMousePos(e);
            if (this.isTagColumnHit(mp)) {
              let lineIndex = this.displayedLines.indexOf(line_obj);
              const tag = line_obj.getTagInfo().tag;
              let from = lineIndex;
              let to = lineIndex;
              while (from > 0 && this.displayedLines[from - 1].getTagInfo().tag === tag) --from;
              while (to < this.displayedLines.length - 1 && this.displayedLines[to + 1].getTagInfo().tag === tag) ++to;
              const lines: string[] = [];
              for (lineIndex = from; lineIndex <= to; ++lineIndex) lines.push(this.displayedLines[lineIndex].lyrics.trim());
              this.onLyricsHit({
                lyrics: lines.join("\n"),
                from: this.displayedLines[from].sourceLineNumber,
                to: this.displayedLines[to].sourceLineNumber + 1,
                section: line_obj.instructedSectionIndex,
              });
            } else
              this.onLyricsHit({
                lyrics: line_obj.lyrics.trim(),
                from: line_obj.sourceLineNumber,
                to: line_obj.sourceLineNumber + 1,
                section: line_obj.instructedSectionIndex,
              });
            e.preventDefault();
            rv = false;
          }
        }
        this.lastMouseDown = null;
      }
      return rv;
    }

    const fromMetaHandoff = this.pendingCanvasFocusAfterMetaBlur;

    // Let meta inputs keep native focus/interaction; the DOM chord strip and
    // diagram canvases stop propagation on their own listeners.
    if (!fromMetaHandoff && this.isMetaInputTarget(e.target)) return;

    this.pendingCanvasFocusAfterMetaBlur = false;

    this.focus();

    if (this.actionTarget instanceof ChordTemplateHitBox) {
      this.clearActionState();
      this.draw();
    } else if (this.actionTarget instanceof ChordProChordHitBox) {
      const box = this.actionTarget;
      const chord = this.actionTarget.chord;
      if (this.dragData) {
        const stripWidth = this.activeChordStripWidth;
        let noDrop = stripWidth > 0 && this.normalizeMousePos(e).x <= stripWidth;
        if (!noDrop) {
          const line_obj = this.HitTestLine(e);
          noDrop = !line_obj || line_obj.isInstrumental;
        }
        if (noDrop) {
          const line_obj = chord.line;
          this.saveState();
          line_obj.removeChord(chord);
          line_obj.genText();
          this.changeActionTarget(null);
        } else {
          chord.line.genText();
          this.changeActionTarget(chord.line);
          this.cursorPos = chord.pos;
        }
      } else {
        this.changeActionTarget(chord);
        this.cursorPos = this.calcCursorPos(box, e);
      }
      this.dragData = null;
      this.draw();
    } else if (this.dragData instanceof ChordProSelection) {
      let box = this.HitTest(e);
      if (!(box instanceof ChordProLineHitBox) && fromMetaHandoff && this.lastMouseDown) {
        const downBox = this.HitTestCoords(this.lastMouseDown);
        if (downBox instanceof ChordProLineHitBox) box = downBox;
      }
      if (box instanceof ChordProLineHitBox) {
        this.changeActionTarget(box.target);
        this.cursorPos = box.column;
      }
      this.dragData = null;
      this.draw();
    } else if (typeof this.dragData === "number") {
      const box = this.HitTest(e);
      if (box instanceof ChordProTagHitBox) {
        this.changeActionTarget(box);
        this.cursorPos = this.calcCursorPos(box, e);
      }
      this.dragData = null;
      this.draw();
    } else if (this.actionTarget instanceof ChordProTagHitBox || this.actionTarget instanceof ChordProLineHitBox) {
      this.clearActionState();
      this.draw();
    }
    this.lastMouseDown = null;
  }

  /**
   * Toggle ABC MIDI playback for a read-only ABC block (start if stopped or
   * finished, stop otherwise). Shared by the mouse double-click and the mobile
   * double-tap paths so both gestures behave identically.
   */
  private toggleAbcMidiPlayback(line_obj: ChordProAbc) {
    if (!this.midiPlayer?.playing || this.midiPlayer?.currentTime >= this.midiPlayer.endTime - 1) {
      const abcSource = line_obj.getAbc(true, false);
      this.midiPlayer = playAbcWithSynth(
        abcSource,
        parseInt(line_obj.doc.getMeta("tempo"), 10),
        (error) => {
          console.error("Midifile playing error: " + error);
          this.midiPlayer = undefined;
        },
        // The playback animation marks the SVG elements of whichever tune object
        // rendered them, so it must come from the backend that owns the VISIBLE
        // staff — otherwise playback re-renders the tune into a detached
        // container and highlights nothing on screen.
        this.domRenderer?.getAbcVisualObject(line_obj)
      );
    } else {
      this.midiPlayer.stop();
      this.midiPlayer = undefined;
    }
  }

  onDoubleClick(e: MouseEvent) {
    if (this.chordSelector && this.chordSelector.inModal) {
      // Don't close the dialog if the double-click is inside the chord selector
      if (e.target instanceof Node && this.chordSelector.parent.contains(e.target)) {
        return;
      }
      this.chordSelector.closeDialog(false, true);
      return;
    }

    if (this.readOnly) {
      const line_obj = this.HitTestLine(e);
      if (line_obj) {
        if (line_obj instanceof ChordProAbc) this.toggleAbcMidiPlayback(line_obj);
        else if (this.onLineDblclk && line_obj.sourceLineNumber >= 0) this.onLineDblclk(line_obj.sourceLineNumber);
      }
      return;
    }

    this.focus();
    // Check if double-click is on an ABC block
    if (this.checkAbcHit(e)) return;
    this.checkChordBoxOrTemplateHit(e);
    this.lastMouseDown = null;
  }

  private checkAbcHit(e: MouseEvent): boolean {
    return this.checkAbcHitAtPos(this.normalizeMousePos(e));
  }

  private checkAbcHitAtPos(mp: Point): boolean {
    const box = this.HitTestCoords(mp);
    if (box instanceof AbcHitBox) {
      void this.openAbcEditor(box.abc);
      return true;
    }
    return false;
  }

  private async openAbcEditor(abc: ChordProAbc) {
    // Lazily create the single reusable modal editor. The abc-gui package (which
    // statically imports abcjs, ~495 KB) is dynamically imported here so it stays
    // out of the initial bundle and only loads when the user edits an ABC block
    // (Phase C bundle diet).
    if (!this.abcEditor) {
      const { AbcWysiwygEditor } = await import("./abc_editor");
      if (this.disposed) return;
      // Guard against a concurrent open having constructed it during the await.
      this.abcEditor ??= new AbcWysiwygEditor(
        this.parent_div,
        {
          onAbcTextChanged: (newText) => {
            if (!this.activeAbcBlock) return;
            const newLines = newText.split("\n");
            (this.activeAbcBlock as unknown as { lines: string[] }).lines.splice(0, Infinity, ...newLines);
            if (this.onChange) {
              const currentText = this.chordProCode;
              if (this.prevText !== currentText) this.onChange((this.prevText = currentText));
            }
            this.draw();
          },
          onClose: () => {
            this.activeAbcBlock = null;
          },
          onOpenChordSelector: (currentChord, onSelected) => {
            if (!this.chordSelector) {
              onSelected(undefined);
              return;
            }
            // Raise the chord selector above the ABC editor backdrop while the
            // ABC editor is open (its backdrop sits at z-index 1060). Restore the
            // original z-index once the selector is dismissed.
            const selectorHost = document.getElementById("chordsel") as HTMLElement | null;
            const prevZ = selectorHost?.style.zIndex ?? "";
            if (selectorHost) selectorHost.style.zIndex = "1070";
            this.chordSelector.showDialog(currentChord || "C", this.readOnly, this.isDark, (chord) => {
              if (selectorHost) selectorHost.style.zIndex = prevZ;
              onSelected(chord);
            });
          },
        },
        this.isDark,
        (s) => this.localize(s, "ChpAbc"),
        (key) => this.tooltipHandler?.(key),
        this.abcLocale
      );
    } else {
      this.abcEditor.setDark(this.isDark);
    }
    this.activeAbcBlock = abc;
    this.abcEditor.open(abc.getAbc(), this.chordPro?.system.systemCode === "G");
  }

  private checkChordBoxOrTemplateHit(e: MouseEvent) {
    if (this.chordSelector) {
      const box = this.HitTest(e);
      if (box instanceof ChordProChordHitBox) {
        if (!this.readOnly) this.changeActionTarget(box.chord);
        this.chordSelector.showDialog(box.chord.text, this.readOnly, this.isDark);
        return true;
      }
      if (this.multiChordChangeEnabled && box instanceof ChordTemplateHitBox) {
        if (!this.readOnly) this.changeActionTarget(box);
        this.chordSelector.showDialog(box.chord, this.readOnly, this.isDark);
        return true;
      }
    }
    return false;
  }

  //  private pendingMouseMove: MouseEvent | null = null;

  onMouseMove(e: MouseEvent) {
    if (!this.chordPro) return;
    if (this.chordSelector && this.chordSelector.inModal) return;

    this.setSurfaceCursor(this.dragData ? "grabbing" : "");

    if (this.lastMouseDown && this.currentlyMarked !== undefined) {
      const box = this.HitTest(e);
      if (box instanceof ChordProChordHitBox && box.chord.marked >= 0 && !this.currentlyMarked.has(box.chord)) {
        box.chord.marked = box.chord.marked ? 0 : 1;
        this.currentlyMarked.add(box.chord);
      } else if (box instanceof ChordProLineHitBox && box.target.marked >= 0 && !this.currentlyMarked.has(box.target)) {
        box.target.marked = box.target.marked ? 0 : 1;
        this.currentlyMarked.add(box.target);
      } else return;
      this.draw(true);
      return;
    }

    if (this.readOnly) {
      if (!this.lastMouseDown && e.button) this.updateMouseDownPos(e, true);
      return false;
    }

    if (this.actionTarget instanceof ChordTemplateHitBox) {
      const mp = this.normalizeMousePos(e);
      this.actionTarget.left = mp.x;
      this.actionTarget.top = mp.y;
      if (mp.x <= this.activeChordStripWidth) {
        this.draw();
        return;
      }
      const line_obj = this.HitTestLine(e);

      if (!line_obj || line_obj.isInstrumental) {
        this.setSurfaceCursor("not-allowed");
        this.draw();
        return;
      }
      if (line_obj) {
        const chord = new ChordProChord(line_obj, this.actionTarget.chord, 0);
        line_obj.chords.splice(0, 0, chord);
        line_obj.invalidateCache();
        this.clearActionState();
        this.draw();
        // The template has become a real chord, so the drag continues as a CHORD
        // drag. The canvas looked the new box up in the array its synchronous
        // paint had just refilled; the DOM backend commits on a frame, so its
        // index is not updated yet. Building the box here works for both and is
        // equivalent either way: `dragData` anchors to the pointer, and the
        // chord-drag branch below immediately overwrites left/top with it.
        this.saveState();
        this.dragData = new ChordProDragStart(mp.x, mp.y, mp.x, mp.y);
        this.changeActionTarget(
          new ChordProChordHitBox(
            mp.x,
            mp.y,
            this.measureChordWidth(chord.text) + 2 * this.displayProps.chordBorder,
            this.displayProps.chordLineHeight + 2 * this.displayProps.chordBorder,
            chord
          )
        );
      }
    }

    if (this.actionTarget instanceof ChordProTagHitBox && this.dragData) {
      const mp = this.normalizeMousePos(e);
      this.actionTarget.left = mp.x;
      this.actionTarget.top = mp.y;
      if (mp.x <= this.activeTagsStripWidth) {
        this.draw();
        return;
      }

      const line_obj = this.HitTestLine(e);
      if (line_obj) {
        const tag = this.actionTarget.target.getTagInfo().tag;
        if (line_obj.getTagInfo().tag === tag) {
          this.draw();
          return;
        }
        const commentLine = new ChordProLine(this.chordPro);
        commentLine.setCommentDirectiveType("normal");
        commentLine.setLyrics(tag);
        commentLine.genText();
        this.chordPro.lines.splice(line_obj.getLineIndex(), 0, commentLine);
        this.clearActionState();
        this.draw();
        // The label has become a real comment line, so the drag continues as a
        // LINE drag. Built here rather than looked up, for the same reason as the
        // template handoff above; the line-drag branch repositions it at once.
        this.saveState();
        this.dragData = new ChordProDragStart(mp.x, mp.y, mp.x, mp.y);
        this.changeActionTarget(new ChordProLineHitBox(mp.x, mp.y, 0, this.displayProps.lyricsLineHeight, commentLine, 0));
      }
    }

    if (this.actionTarget instanceof ChordProChordHitBox) {
      const mp = this.normalizeMousePos(e),
        x = mp.x,
        y = mp.y,
        box = this.actionTarget;

      let noDrop = mp.x <= this.activeChordStripWidth;
      if (!noDrop) {
        const line_obj = this.HitTestLine(e);
        noDrop = !line_obj || line_obj.isInstrumental;
      }
      if (noDrop) {
        const line_obj = box.chord.line;
        this.saveState();
        line_obj.removeChord(box.chord);
        line_obj.genText();
        this.changeActionTarget(new ChordTemplateHitBox(box.left, box.top, box.width, box.height, box.chord.text));
        this.setSurfaceCursor("not-allowed");
        this.draw();
        return;
      }

      if (!(this.dragData instanceof ChordProDragStart)) {
        this.saveState();
        this.dragData = new ChordProDragStart(box.left, box.top, x, y);
      }

      box.left = this.dragData.startX + x - this.dragData.dragStartX;
      box.top = this.dragData.startY + y - this.dragData.dragStartY;

      // Explicit drop handling: the document moves HERE, not in the paint.
      this.applyChordDrag(box);
      this.draw();
    } else if (this.actionTarget instanceof ChordProLineHitBox) {
      const mp = this.normalizeMousePos(e),
        x = mp.x,
        y = mp.y;

      this.saveState();
      const line_obj = this.actionTarget.target;
      const tag = this.actionTarget.target.text;
      const current_line_index = line_obj.getLineIndex();

      if (mp.x <= this.activeTagsStripWidth) {
        if (current_line_index >= 0) this.chordPro.lines.splice(current_line_index, 1);
        // Deliberately resolved against the geometry from BEFORE the removal —
        // the line is gone now, so a fresh layout would have no label for it.
        // Both backends are equally stale here: neither has repainted yet.
        const tagBox = this.findTagHitBox(line_obj);
        if (tagBox) this.changeActionTarget(tagBox);
        this.draw();
        return;
      }

      if (!(this.dragData instanceof ChordProDragStart)) {
        this.saveState();
        this.dragData = new ChordProDragStart(this.actionTarget.left, this.actionTarget.top, x, y);
      }

      this.actionTarget.left = this.dragData.startX + x - this.dragData.dragStartX;
      this.actionTarget.top = this.dragData.startY + y - this.dragData.dragStartY;

      const ol = this.HitTestLine(e);
      const range = this.displayedLineRange(line_obj);
      if (ol && range && ol.getTagInfo().tag !== tag) {
        const i = ol.getLineIndex();
        const line_mid = (range.top + range.bottom) / 2;
        const line_height = range.bottom - range.top;
        if (i >= 0 && Math.abs(y - line_mid) >= line_height) {
          if (current_line_index >= 0) this.chordPro.lines.splice(current_line_index, 1);
          this.chordPro.lines.splice(i, 0, line_obj);
          this.draw();
        }
      }
    } else if (this.dragData instanceof ChordProSelection) {
      const box = this.HitTest(e);
      if (box instanceof ChordProLineHitBox) {
        this.changeActionTarget(box.target);
        this.cursorPos = box.column;
        this.selectionStart = this.dragData;
        this.selectionEnd = new ChordProSelection(box.target.getLineIndex(), box.column);
        this.normalizeSelection();
        this.draw();
      }
    } else if (typeof this.dragData === "number") {
      const box = this.HitTest(e);
      if (box instanceof ChordProTagHitBox) {
        this.changeActionTarget(box);
        this.cursorPos = this.calcCursorPos(box, e);
        this.selectionStart = this.dragData;
        this.selectionEnd = this.cursorPos;
        this.normalizeSelection();
        this.draw();
      }
    }
  }

  onMouseEnter(_e: MouseEvent) {
    if (this.readOnly) return false;
  }

  onMouseLeave(e: MouseEvent) {
    // Don't steal focus from active meta inputs when the mouse leaves the editor area.
    const activeMetaInput = this.getActiveMetaInput();
    if (activeMetaInput) return;
    // If no active drag/click sequence exists, ignore leave to avoid clearing cursor state.
    if (!this.lastMouseDown) return;
    return this.onMouseUp(e, true);
  }

  normalizeMousePos(e: MouseEvent) {
    return this.normalizeClientPos(e.clientX, e.clientY);
  }

  normalizeClientPos(clientX: number, clientY: number): Point {
    // Normalize through the renderer root's own transform. The host may be
    // CSS-scaled (the client view scales the whole host to fit its pane), so the
    // displayed box is divided out against the committed logical size.
    const domRenderer = this.domRenderer;
    if (domRenderer) {
      const snapshot = domRenderer.getLayoutSnapshot();
      return normalizeClientPoint(domRenderer.element, clientX, clientY, snapshot);
    }

    // No renderer yet (pre-first-commit): fall back to host-relative coordinates.
    const rect = this.parent_div.getBoundingClientRect();
    return { x: (clientX - rect.left) / this.scale, y: (clientY - rect.top) / this.scale };
  }

  initialChordValue(line_obj: ChordProLine, cursorPos: number) {
    if (!this.chordPro) return "";
    const key = line_obj.getTagInfo().key,
      parsed = line_obj.getSectionInfo();
    let ch = "";
    if (parsed.familyKey) {
      let enabled = true,
        j: number,
        i = line_obj.getLineIndex();
      const signatures = this.chordPro.sectionInfo,
        sign = signatures.get(key)?.signature ?? "";

      for (const chord of line_obj.chords)
        if (chord.pos >= cursorPos) {
          enabled = false;
          break;
        }

      if (enabled)
        for (j = i + 1; j < this.chordPro.lines.length; ++j) {
          const lo = this.chordPro.lines[j];
          if (lo.getTagInfo().key !== key) break;
          if (lo.chords.length > 0) {
            enabled = false;
            break;
          }
        }

      if (enabled)
        while (--i >= 0) {
          const k = this.chordPro.lines[i].getTagInfo().key;
          if (k !== key && this.chordPro.lines[i].getSectionInfo().familyKey === parsed.familyKey) {
            let s = signatures.get(k)?.signature ?? "";
            const slen = sign.length;
            if (s.startsWith(sign)) {
              s = s.substring(slen);
              if (s.startsWith("~")) s = s.substring(1);
              const l = s.indexOf("~");
              ch = l >= 0 ? s.substring(0, l) : s;
            }
            break;
          }
        }
    }
    if (!ch) ch = "chord";
    return ch;
  }

  handleLyricsKeyDown(e: KeyboardEvent) {
    if (!this.chordPro || !(this.actionTarget instanceof ChordProLine) || this.cursorPos === null) return false;

    const code_string = getKeyCodeString(e);
    let line_obj = this.actionTarget;
    let modify_selection = true,
      prevLine: ChordProLine | null,
      nextLine: ChordProLine | null;

    if (!line_obj.isComment && e.altKey && !e.ctrlKey && !e.metaKey) {
      let index = this.system.baseNoteList.indexOf(code_string);
      if (index >= 0) {
        this.saveState();
        if (e.shiftKey) ++index;
        const chord = new ChordProChord(line_obj, this.system.baseNoteList[index], this.cursorPos);
        line_obj.insertChord(chord);
        line_obj.genText();
        this.changeActionTarget(chord);
        this.cursorPos = chord.text.length;
        this.selectionStart = this.selectionEnd = null;
        this.draw();
      } else if (this.cursorPos !== null && code_string === "DELETE")
        for (const chord of line_obj.chords)
          if (chord.pos === this.cursorPos) {
            this.saveState();
            line_obj.removeChord(chord);
            line_obj.genText();
            this.draw();
            break;
          }
      return true;
    }

    if ((e.ctrlKey || e.metaKey) && ["LEFT", "RIGHT", "UP", "DOWN"].indexOf(code_string) < 0) return false;

    const startPos = new ChordProSelection(line_obj.getLineIndex(), this.cursorPos);

    switch (code_string) {
      case "[":
      case "INSERT":
        if (!line_obj.isComment) {
          const chord = new ChordProChord(line_obj, this.initialChordValue(line_obj, this.cursorPos), this.cursorPos);
          line_obj.insertChord(chord);
          line_obj.genText();
          this.changeActionTarget(chord);
          this.cursorPos = 0;
          this.selectionStart = 0;
          this.selectionEnd = chord.text.length;
          this.draw();
        }
        e.preventDefault();
        return false;
      case "ENTER":
        if (!this.eraseSelection(startPos)) this.saveState();
        this.changeActionTarget(line_obj.splitAt(this.cursorPos));
        this.cursorPos = 0;
        this.draw();
        modify_selection = false;
        break;
      case "BACKSPACE":
        if (this.eraseSelection(startPos)) this.draw();
        else if (this.cursorPos === 0) {
          prevLine = line_obj.getPrevLine();
          if (prevLine) {
            this.saveState();
            this.cursorPos = prevLine.lyrics.length;
            prevLine.combineWithNext();
            this.changeActionTarget(prevLine);
            this.draw();
          }
        } else {
          this.saveState();
          line_obj.deleteString(--this.cursorPos, 1);
          this.draw();
        }
        modify_selection = false;
        break;
      case "DELETE":
        if (this.eraseSelection(startPos)) this.draw();
        else if (this.cursorPos >= line_obj.lyrics.length) {
          nextLine = line_obj.getNextLine();
          if (nextLine) {
            this.saveState();
            line_obj.combineWithNext();
            this.draw();
          }
        } else {
          this.saveState();
          line_obj.deleteString(this.cursorPos, 1);
          this.draw();
        }
        modify_selection = false;
        break;
      case "UP":
        for (const ch of line_obj.chords)
          if (this.cursorPos === ch.pos) {
            this.changeActionTarget(ch);
            this.cursorPos = 0;
            this.draw();
            modify_selection = false;
            this.dragData = null;
            break;
          }
        if (this.actionTarget instanceof ChordProChord) break;
        prevLine = line_obj.getPrevLine();
        if (prevLine) {
          this.changeActionTarget(prevLine);
          this.cursorPos = Math.min(prevLine.lyrics.length, this.cursorPos);
          line_obj = prevLine;
        } else if (this.selectionStart === null && this.selectionEnd === null) {
          this.clearActionState();
          if (!this.selectMetaData("", -1)) {
            this.changeActionTarget(this.chordPro.lines[0]);
            this.cursorPos = 0;
          }
          this.draw();
          modify_selection = false;
        } else if (this.selectionStart instanceof ChordProSelection && this.cursorPos > 0) {
          this.cursorPos = 0;
          modify_selection = true;
        }
        break;
      case "DOWN":
        nextLine = line_obj.getNextLine();
        if (nextLine) {
          this.changeActionTarget(nextLine);
          this.cursorPos = Math.min(nextLine.lyrics.length, this.cursorPos);
          line_obj = nextLine;
        } else if (this.selectionStart instanceof ChordProSelection && this.cursorPos < line_obj.lyrics.length) {
          this.cursorPos = line_obj.lyrics.length;
          modify_selection = true;
        } else modify_selection = false;
        break;
      case "LEFT":
        if (this.cursorPos <= 0) {
          prevLine = line_obj.getPrevLine();
          if (prevLine) {
            this.changeActionTarget(prevLine);
            this.cursorPos = prevLine.lyrics.length;
          } else modify_selection = false;
        } else
          do --this.cursorPos;
          while ((e.ctrlKey || e.metaKey) && this.cursorPos > 0 && !is_word_boundary_char(line_obj.lyrics[this.cursorPos]));
        break;
      case "RIGHT":
        if (this.cursorPos < line_obj.lyrics.length)
          do ++this.cursorPos;
          while ((e.ctrlKey || e.metaKey) && this.cursorPos < line_obj.lyrics.length && !is_word_boundary_char(line_obj.lyrics[this.cursorPos]));
        else {
          nextLine = line_obj.getNextLine();
          if (nextLine) {
            this.changeActionTarget(nextLine);
            this.cursorPos = 0;
          } else modify_selection = false;
        }
        break;
      case "HOME":
        this.cursorPos = 0;
        break;
      case "END":
        this.cursorPos = line_obj.lyrics.length;
        break;
      default:
        return false;
    }
    if (modify_selection) {
      if (e.shiftKey) {
        const endPos = new ChordProSelection(line_obj.getLineIndex(), this.cursorPos);
        if (this.selectionStart === null || this.selectionEnd === null || !this.comparePositions(this.selectionStart, this.selectionEnd)) {
          this.selectionStart = startPos;
          this.selectionEnd = endPos;
        } else if (!this.comparePositions(startPos, this.selectionStart)) this.selectionStart = endPos;
        else this.selectionEnd = endPos;
        this.normalizeSelection();
      } else {
        this.selectionStart = null;
        this.selectionEnd = null;
      }
      this.draw();
    }

    e.preventDefault();
    return true;
  }

  handleChordKeyDown(e: KeyboardEvent) {
    if (!(this.actionTarget instanceof ChordProChord)) return false;
    const code_string = getKeyCodeString(e);
    const chord = this.actionTarget;
    let modify_selection = true;
    const startPos = this.cursorPos;

    if ((e.ctrlKey || e.metaKey) && code_string === "DELETE") {
      this.saveState();
      chord.line.removeChord(chord);
      chord.line.genText();
      this.draw();
      return true;
    }

    if ((e.ctrlKey || e.metaKey) && ["LEFT", "RIGHT", "UP", "DOWN"].indexOf(code_string) < 0) return false;

    switch (code_string) {
      case "]":
      case "ENTER":
        this.cursorPos = chord.pos;
        this.changeActionTarget(chord.line);
        break;
      case "BACKSPACE":
        if (this.cursorPos === 0 && this.selectionStart === null && this.selectionEnd === null) this.moveChord(chord, -1);
        else if ((startPos === null || !this.eraseSelection(startPos)) && this.cursorPos !== null && this.cursorPos > 0) {
          this.saveState();
          chord.deleteString(--this.cursorPos, 1);
        }
        break;
      case "DELETE":
        if ((startPos === null || !this.eraseSelection(startPos)) && this.cursorPos !== null && this.cursorPos < chord.text.length) {
          this.saveState();
          chord.deleteString(this.cursorPos, 1);
        }
        break;
      case "UP": {
        const l = chord.line.getPrevLine();
        this.clearActionState();
        if (l) {
          this.changeActionTarget(l);
          this.cursorPos = Math.min(chord.pos, l.lyrics.length);
        } else this.selectMetaData("", -1);
        this.draw();
        modify_selection = false;
        break;
      }
      case "DOWN":
        this.clearActionState();
        this.changeActionTarget(chord.line);
        this.cursorPos = chord.pos;
        this.draw();
        modify_selection = false;
        break;
      case "LEFT":
        if (this.cursorPos !== null && this.cursorPos > 0)
          do --this.cursorPos;
          while ((e.ctrlKey || e.metaKey) && this.cursorPos > 0 && !is_word_boundary_char(chord.text[this.cursorPos]));
        break;
      case "RIGHT":
        if (this.cursorPos !== null && this.cursorPos < chord.text.length)
          do ++this.cursorPos;
          while ((e.ctrlKey || e.metaKey) && this.cursorPos < chord.text.length && !is_word_boundary_char(chord.text[this.cursorPos]));
        break;
      case "HOME":
        this.cursorPos = 0;
        break;
      case "END":
        this.cursorPos = chord.text.length;
        break;
      default:
        modify_selection = false;
        return false;
    }

    if (modify_selection) {
      if (e.shiftKey) {
        const endPos = this.cursorPos;
        if (this.selectionStart === null || this.selectionEnd === null || !this.comparePositions(this.selectionStart, this.selectionEnd)) {
          this.selectionStart = startPos;
          this.selectionEnd = endPos;
        } else if (startPos === null || typeof this.selectionStart !== "number" || !this.comparePositions(startPos, this.selectionStart))
          this.selectionStart = endPos;
        else this.selectionEnd = endPos;
        this.normalizeSelection();
      } else {
        this.selectionStart = null;
        this.selectionEnd = null;
      }
      this.draw();
    }

    return true;
  }

  handleTagKeyDown(e: KeyboardEvent) {
    if (!(this.actionTarget instanceof ChordProTagHitBox)) return false;
    const code_string = getKeyCodeString(e);
    const name = this.actionTarget.parameter;
    const value = this.actionTarget.target.styles.get(name);
    let modify_selection = true;
    const startPos = this.cursorPos;

    if ((e.ctrlKey || e.metaKey) && ["LEFT", "RIGHT", "UP", "DOWN"].indexOf(code_string) < 0) return false;

    switch (code_string) {
      case "UP": {
        const prevLine = this.actionTarget.target.getPrevLine();
        this.clearActionState();
        if (prevLine) {
          this.changeActionTarget(prevLine);
          this.cursorPos = 0;
        } else this.selectMetaData("", -1);
        this.draw();
        modify_selection = false;
        break;
      }
      case "DOWN": {
        const nextLine = this.actionTarget.target.getNextLine();
        this.clearActionState();
        if (nextLine) {
          this.changeActionTarget(nextLine);
          this.cursorPos = 0;
          this.draw();
        }
        modify_selection = false;
        break;
      }
      case "ENTER": {
        const line_obj = this.actionTarget.target;
        this.clearActionState();
        this.changeActionTarget(line_obj);
        this.cursorPos = 0;
        this.draw();
        modify_selection = false;
        break;
      }
      case "BACKSPACE":
        if ((startPos === null || !this.eraseSelection(startPos)) && this.cursorPos !== null && this.cursorPos > 0) {
          this.saveState();
          --this.cursorPos;
          this.setTagName(this.actionTarget.target, name, value.substr(0, this.cursorPos) + value.substr(this.cursorPos + 1));
        }
        break;
      case "DELETE":
        if ((startPos === null || !this.eraseSelection(startPos)) && this.cursorPos !== null && this.cursorPos < value.length) {
          this.saveState();
          this.setTagName(this.actionTarget.target, name, value.substr(0, this.cursorPos) + value.substr(this.cursorPos + 1));
        }
        break;
      case "LEFT":
        if (this.cursorPos !== null && this.cursorPos > 0)
          do --this.cursorPos;
          while ((e.ctrlKey || e.metaKey) && this.cursorPos > 0 && !is_word_boundary_char(value[this.cursorPos]));
        break;
      case "RIGHT":
        if (this.cursorPos !== null && this.cursorPos < value.length)
          do ++this.cursorPos;
          while ((e.ctrlKey || e.metaKey) && this.cursorPos < value.length && !is_word_boundary_char(value[this.cursorPos]));
        else if (!e.shiftKey) {
          const lo = this.actionTarget.target;
          this.clearActionState();
          this.changeActionTarget(lo);
          this.cursorPos = 0;
          this.draw();
          modify_selection = false;
        }
        break;
      case "HOME":
        this.cursorPos = 0;
        break;
      case "END":
        this.cursorPos = value.length;
        break;
      default:
        return false;
    }

    if (modify_selection) {
      if (e.shiftKey) {
        const endPos = this.cursorPos;
        if (this.selectionStart === null || this.selectionEnd === null || !this.comparePositions(this.selectionStart, this.selectionEnd)) {
          this.selectionStart = startPos;
          this.selectionEnd = endPos;
        } else if (startPos === null || this.selectionStart === null || !this.comparePositions(startPos, this.selectionStart))
          this.selectionStart = endPos;
        else this.selectionEnd = endPos;
        this.normalizeSelection();
      } else {
        this.selectionStart = null;
        this.selectionEnd = null;
      }
      this.draw();
    }

    return true;
  }

  transpose(shift: number, draw = true) {
    if (this.chordPro && shift) {
      this.currentShift += shift;
      this.chordPro.transpose(shift);
      this.acceptDisplayOnlyDocumentProjection();
      this.invalidateDisplaySemantics();
      if (draw) this.draw();
    }
  }

  saveTranspose() {
    this.currentShift = 0;
  }

  restoreTranspose(draw = true) {
    if (!this.currentShift) return false;
    this.transpose(-this.currentShift, draw);
    return true;
  }

  onKeyDown(e: KeyboardEvent) {
    const code_string = getKeyCodeString(e);

    if (code_string === "SHIFT" || code_string === "CONTROL" || code_string === "ALT") return;

    if (
      this.multiChordChangeEnabled &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      (code_string === "ADD" || code_string === "SUBTRACT")
    ) {
      this.transpose(code_string === "ADD" ? 1 : -1);
      e.preventDefault();
      return true;
    }

    let cont = true;

    if (e.altKey && !e.shiftKey) {
      cont = false;
      switch (code_string) {
        case "T":
          this.makeSelectionTitle();
          break;
        case "B":
          this.tagSelection("start_of_bridge", this.getAutoTagValue("start_of_bridge"));
          break;
        case "C":
          this.tagSelection("start_of_chorus", this.getAutoTagValue("start_of_chorus"));
          break;
        case "V":
          this.tagSelection("start_of_verse", this.getAutoTagValue("start_of_verse"));
          break;
        case "G":
          this.tagSelection("start_of_grid", this.getAutoTagValue("start_of_grid"));
          break;
        case "X":
          this.tagSelection("", "");
          break;
        case "K":
          this.toggleCommentType();
          break;
        default:
          cont = true;
          break;
      }
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      cont = false;
      switch (code_string) {
        case "A":
          if (!e.shiftKey) {
            this.selectAll();
            this.draw();
          }
          break;
        case "Z":
          if (e.shiftKey) this.redo();
          else this.undo();
          break;
        case "Y":
          if (!e.shiftKey) this.redo();
          break;
        case "B":
          if (this.actionTarget instanceof ChordProLine) {
            this.saveState();
            this.draw();
          } else cont = true;
          break;
        case "INSERT":
          if (!e.shiftKey) this.copySelected();
          break;
        case "C":
          this.copySelected();
          break;
        case "V":
          this.paste(e.shiftKey);
          this.draw();
          break;
        case "X":
          this.saveState();
          this.copySelected();
          this.eraseSelection();
          this.draw();
          break;
        case "M":
          if (e.shiftKey) this.clearAllMarks();
          else if (this.actionTarget && !(this.actionTarget instanceof ChordProHitBox)) this.actionTarget.marked = this.actionTarget.marked ? 0 : 1;
          this.draw();
          break;
        default:
          cont = true;
          break;
      }
    }

    if (!cont) {
      e.preventDefault();
      return true;
    }

    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && code_string === "INSERT") {
      this.paste();
      this.draw();
      e.preventDefault();
      return true;
    }

    if (this.actionTarget && this.cursorPos !== null && (this.handleLyricsKeyDown(e) || this.handleChordKeyDown(e) || this.handleTagKeyDown(e))) {
      e.preventDefault();
      return true;
    }
    return;
  }

  onKeyPressed(e: KeyboardEvent) {
    if (!this.chordPro || this.readOnly) return false;

    let s = e.key || String.fromCharCode(e.charCode);
    if (s === "\t") s = " ";
    if (s !== " ") s = s.trim();
    if (s === "" || s.length !== 1) return;

    let draw = this.eraseSelection();
    if (!draw) this.saveState();

    if (this.actionTarget instanceof ChordProTagHitBox) {
      const line_obj = this.actionTarget.target;
      const name = this.actionTarget.parameter;
      const value = line_obj.styles.get(name);
      const cursorPos = this.cursorPos || 0;
      this.setTagName(line_obj, name, value.substr(0, cursorPos) + s + value.substr(cursorPos));
      this.cursorPos = cursorPos + 1;
      draw = true;
    } else if (this.actionTarget && !(this.actionTarget instanceof ChordProHitBox)) {
      const cursorPos = this.cursorPos || 0;
      this.actionTarget.insertString(cursorPos, s);
      this.cursorPos = cursorPos + 1;
      if (this.actionTarget instanceof ChordProChord) this.convertChordPrefixToPos(this.actionTarget);
      draw = true;
    }

    if (draw) {
      this.draw();
      e.preventDefault();
      return true;
    }
  }

  setTagName(line_obj: ChordProLine, name: string, value: string) {
    if (!this.chordPro) return;

    const prev_value = line_obj.styles.get(name);
    while (line_obj.styles.get(name) === prev_value) {
      line_obj.styles.set(name, value);
      line_obj.genText();
      const lo = line_obj.getNextLine();
      if (!lo || !lo.styles.has(name)) break;
      line_obj = lo;
    }
    for (const lo of this.chordPro.lines) lo.invalidateCache();
  }

  selectAll() {
    if (!this.chordPro) return;
    if (this.actionTarget instanceof ChordProLine) {
      this.selectionStart = new ChordProSelection(0, 0);
      this.selectionEnd = new ChordProSelection(this.chordPro.lines.length, this.chordPro.lines[this.chordPro.lines.length - 1].text.length);
    } else if (this.actionTarget instanceof ChordProChord) {
      this.selectionStart = 0;
      this.selectionEnd = this.actionTarget.text.length;
    }
  }

  async paste(textOnly = false) {
    if (!this.actionTarget || this.cursorPos == null) return;

    if (this.onPaste) this.onPaste();
    else {
      try {
        const { text, isChordPro } = await clipboard.readBestText();
        this._paste(text, isChordPro, textOnly ? "lyrics" : "metadata");
      } catch (err) {
        this.log("clipBoard.readBestText: " + err);
        try {
          const legacyClipboard = (window as unknown as { clipboardData?: { getData: (type: string) => string } }).clipboardData;
          let str = legacyClipboard ? legacyClipboard.getData("Text") : undefined;
          if (str === undefined && this.clipboardTextArea) {
            this.clipboardTextArea.select();
            document.execCommand("paste");
            str = this.systemPasteContent || this.clipboardTextArea.value;
          }
          if (str !== undefined) this._paste(str, false, textOnly ? "lyrics" : "metadata");
        } catch (e2) {
          this.log(String(e2));
        }
      }
    }
  }

  private _paste(str: string, isChordPro = false, mode: "lyrics" | "chords" | "directives" | "metadata" = "metadata") {
    // Normalize line endings
    str = str.replace(/\r\n/g, "\n");

    if (!this.chordPro) return;
    if (!this.eraseSelection()) this.saveState();

    if (this.actionTarget instanceof ChordProLine) {
      let line_obj = this.actionTarget;
      const cursorPos = this.cursorPos || 0;

      if (isChordPro) {
        // Parse pasted content as a full ChordPro document to preserve chords, styles, and metadata
        let tempChordPro: ChordProDocument | null = null;
        try {
          tempChordPro = new ChordProDocument(this.chordPro.system, str);
        } catch (e) {
          console.debug("Failed to parse pasted content as ChordPro document, using fallback mode", e);
        }

        if (tempChordPro) {
          const pastedLines = tempChordPro.lines;

          // Merge the first pasted line into the current cursor line
          const firstLine = pastedLines[0];
          if (firstLine && !(firstLine instanceof ChordProAbc) && !firstLine.isGrid) {
            if (mode === "lyrics") {
              line_obj.insertString(cursorPos, firstLine.lyrics);
            } else {
              if (mode === "directives") {
                line_obj.styles = firstLine.styles.clone();
                line_obj.setCommentDirectiveType(firstLine.getCommentType());
              }
              for (const chord of firstLine.chords) {
                chord.pos += cursorPos;
                chord.line = line_obj;
              }
              line_obj.insertString(cursorPos, firstLine.lyrics);
              line_obj.chords.push(...firstLine.chords);
            }
            this.cursorPos = cursorPos + firstLine.lyrics.length;
            line_obj.genText();
          }

          // Insert remaining lines as new document lines after the current one
          if (pastedLines.length > 1) {
            const insertIdx = this.chordPro.lines.indexOf(line_obj);
            if (insertIdx >= 0) {
              for (let i = 1; i < pastedLines.length; ++i) {
                const newLine = pastedLines[i].clone();
                newLine.doc = this.chordPro;
                if (mode === "lyrics") newLine.chords = [];
                if (mode !== "directives") newLine.styles = line_obj.styles.clone();
                this.chordPro.lines.splice(insertIdx + i, 0, newLine);
              }
              // Move cursor to end of last inserted line
              const lastLine = this.chordPro.lines[insertIdx + pastedLines.length - 1];
              if (lastLine instanceof ChordProLine) {
                this.changeActionTarget(lastLine);
                this.cursorPos = lastLine.lyrics.length;
              }
            }
          }

          // Copy metadata from pasted document into current
          if (mode === "metadata") {
            for (const key of ChordProDocument.metaDataDirectives) {
              const value = tempChordPro.getMeta(key);
              if (value) this.chordPro.setMeta(key, value);
            }
          }
        } else {
          // ChordPro parse failed: fall through to plain-text logic below
          isChordPro = false;
        }
      }

      if (!isChordPro) {
        // Plain-text: optionally extract inline [chord] markers unless text-only paste is requested
        const chords: { text: string; pos: number }[] = [];
        let plainText = "";
        let i = 0;
        while (i < str.length) {
          if (str[i] === "[") {
            const closeIdx = str.indexOf("]", i + 1);
            if (closeIdx >= 0) {
              const chordText = str.substring(i + 1, closeIdx);
              if (chordText && mode !== "lyrics") chords.push({ text: chordText, pos: cursorPos + plainText.length });
              i = closeIdx + 1;
              continue;
            }
          }
          plainText += str[i];
          ++i;
        }

        // Insert plain lyrics text (shifts existing chords accordingly)
        line_obj.insertString(cursorPos, plainText);
        this.cursorPos = cursorPos + plainText.length;

        // Insert parsed chords
        for (const c of chords) {
          const chord = new ChordProChord(line_obj, c.text, c.pos);
          line_obj.insertChord(chord);
        }
        line_obj.genText();

        // Split at embedded newlines
        let idx: number;
        while ((idx = line_obj.lyrics.indexOf("\n")) >= 0) {
          line_obj.deleteString(idx, 1);
          --this.cursorPos;
          const lo = line_obj.splitAt(idx);
          if (!lo) break;
          line_obj = lo;
          this.changeActionTarget(line_obj);
          this.cursorPos -= idx;
        }
      }
    } else if (this.actionTarget instanceof ChordProChord) {
      str = str.replace(/\[|\]/g, "");
      const chord = this.actionTarget;
      str = str.split("\n")[0];
      const cursorPos = this.cursorPos || 0;
      chord.insertString(cursorPos, str);
      this.cursorPos = cursorPos + str.length;
      this.convertChordPrefixToPos(chord);
    }

    this.draw();
  }

  getSelectedText(mode: "lyrics" | "chords" | "directives" = "directives"): string {
    let str = "";
    if (this.chordPro && this.selectionStart != null && this.selectionEnd != null && this.comparePositions(this.selectionStart, this.selectionEnd)) {
      if (this.selectionStart instanceof ChordProSelection && this.selectionEnd instanceof ChordProSelection) {
        if (mode === "directives") {
          const docText = this.getSelectedChordProTextWithDirectives();
          if (docText) return docText;
        }
        for (let l = this.selectionStart.line; l <= this.selectionEnd.line; ++l) {
          const line_obj = this.chordPro.lines[l];
          if (this.selectionStart.line < l && l < this.selectionEnd.line) {
            str += mode === "lyrics" ? line_obj.lyrics + "\n" : this.getLineChordProText(line_obj, 0, line_obj.lyrics.length) + "\n";
            continue;
          }
          const start = this.selectionStart.line === l ? this.selectionStart.col : 0,
            end = this.selectionEnd.line === l ? this.selectionEnd.col : line_obj.lyrics.length;
          str += mode === "lyrics" ? line_obj.lyrics.substring(start, end) : this.getLineChordProText(line_obj, start, end);
          if (this.selectionEnd.line !== l) str += "\n";
        }
      } else if (typeof this.selectionStart === "number" && typeof this.selectionEnd === "number") {
        if (this.actionTarget instanceof ChordProChordHitBox)
          str = this.actionTarget.chord.text.substr(this.selectionStart, this.selectionEnd - this.selectionStart);
      }
    }
    return str;
  }

  /** Returns selected range as ChordPro document text, preserving section/comment directives. */
  private getSelectedChordProTextWithDirectives(): string {
    if (!this.chordPro || !(this.selectionStart instanceof ChordProSelection) || !(this.selectionEnd instanceof ChordProSelection)) return "";

    const lineCount = this.chordPro.lines.length;
    if (!lineCount) return "";

    const startLine = Math.max(0, Math.min(this.selectionStart.line, lineCount - 1));
    let endLine = Math.max(0, Math.min(this.selectionEnd.line, lineCount - 1));
    if (this.selectionEnd.col === 0 && this.selectionEnd.line > this.selectionStart.line) {
      endLine = Math.max(startLine, endLine - 1);
    }

    const selectedDoc = new ChordProDocument(this.chordPro.system, "");
    selectedDoc.lines = [];

    for (let l = startLine; l <= endLine; ++l) {
      const src = this.chordPro.lines[l];
      const clone = src.clone(true);
      clone.doc = selectedDoc;

      // Keep partial selection behavior for first/last selected line while preserving directives.
      if (!(clone instanceof ChordProAbc)) {
        const len = clone.lyrics.length;
        const from = l === this.selectionStart.line ? Math.max(0, Math.min(this.selectionStart.col, len)) : 0;
        const to = l === this.selectionEnd.line ? Math.max(from, Math.min(this.selectionEnd.col, len)) : len;
        if (to < len) clone.deleteString(to, len - to);
        if (from > 0) clone.deleteString(0, from);
      }

      selectedDoc.lines.push(clone);
    }

    return selectedDoc.generateDocument();
  }

  /** Returns ChordPro formatted text for a portion of a line, embedding [chords] at correct positions. */
  private getLineChordProText(line_obj: ChordProLine, start: number, end: number): string {
    let result = "";
    let ci = 0;
    // Skip chords before selection start
    while (ci < line_obj.chords.length && line_obj.chords[ci].pos < start) ++ci;
    for (let i = start; i < end; ++i) {
      // Insert any chords positioned at this character index
      while (ci < line_obj.chords.length && line_obj.chords[ci].pos <= i) {
        result += "[" + line_obj.chords[ci].text + "]";
        ++ci;
      }
      result += line_obj.lyrics.charAt(i);
    }
    // Append any remaining chords positioned at or after end (at end-of-selection)
    while (ci < line_obj.chords.length && line_obj.chords[ci].pos <= end) {
      result += "[" + line_obj.chords[ci].text + "]";
      ++ci;
    }
    return result;
  }

  async copySelected() {
    const chordpro = this.getSelectedText("directives");
    if (!chordpro) return;
    const plain = this.getSelectedText("lyrics");

    if (this.onCopy) this.onCopy(plain, chordpro);
    else {
      try {
        await clipboard.writeItems(plain, chordpro);
      } catch (error) {
        this.log(String(error));
      }
    }
  }

  async copyAll() {
    const chordpro = this.genDoc();
    if (!chordpro) return;
    const plain = this.chordPro?.lines.map((l) => l.lyrics).join("\n") || "";

    if (this.onCopy) this.onCopy(plain, chordpro);
    else {
      try {
        await clipboard.writeItems(plain, chordpro);
      } catch (error) {
        this.log(String(error));
      }
    }
  }

  // ---- Context Menu ----

  private hideContextMenu() {
    if (this.contextMenuElement) {
      this.contextMenuElement.remove();
      this.contextMenuElement = null;
      document.removeEventListener("mousedown", this.dismissContextMenu);
      document.removeEventListener("keydown", this.dismissContextMenu);
      window.removeEventListener("blur", this.dismissContextMenu);
    }
  }

  private onContextMenu(e: MouseEvent) {
    e.preventDefault();

    this.hideContextMenu();
    if (!this.chordPro || this.instructionEditorActive) return;

    const hasText = !!this.getSelectedText();
    const isEditable = !this.readOnly;
    const hasLineSelection =
      this.selectionStart instanceof ChordProSelection &&
      this.selectionEnd instanceof ChordProSelection &&
      this.comparePositions(this.selectionStart, this.selectionEnd) !== 0;

    const dark = this.isDark;
    const bgColor = dark ? "#212529" : "#ffffff";
    const hoverBg = dark ? "#3e3e3e" : "#e8e8e8";
    const textColor = dark ? "#cccccc" : "#1e1e1e";
    const disabledColor = dark ? "#666666" : "#a0a0a0";
    const separatorColor = dark ? "#444444" : "#d4d4d4";
    const shortcutColor = dark ? "#888888" : "#888888";
    const ctrlCmd = "Ctrl/Cmd";
    const altOption = "Alt/Option";

    const menu = document.createElement("div");
    menu.style.cssText = `
      position: fixed;
      z-index: 100000;
      background: ${bgColor};
      border: 1px solid ${separatorColor};
      border-radius: 6px;
      padding: 4px 0;
      min-width: 220px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      color: ${textColor};
      user-select: none;
    `;

    const addItem = (label: string, shortcut: string, action: () => void, enabled = true, icon = "") => {
      const item = document.createElement("div");
      item.style.cssText = `
        display: flex;
        align-items: center;
        padding: 6px 24px 6px 12px;
        cursor: ${enabled ? "pointer" : "default"};
        color: ${enabled ? textColor : disabledColor};
        white-space: nowrap;
      `;
      const iconSpan = document.createElement("span");
      iconSpan.textContent = icon;
      iconSpan.style.cssText = `width: 20px; text-align: center; margin-right: 6px; font-size: 14px;`;
      const labelSpan = document.createElement("span");
      labelSpan.style.cssText = `flex: 1;`;
      labelSpan.textContent = label;
      const shortcutSpan = document.createElement("span");
      shortcutSpan.textContent = shortcut;
      shortcutSpan.style.cssText = `margin-left: 32px; color: ${enabled ? shortcutColor : disabledColor}; font-size: 12px;`;
      item.appendChild(iconSpan);
      item.appendChild(labelSpan);
      item.appendChild(shortcutSpan);
      if (enabled) {
        item.addEventListener("mouseenter", () => {
          item.style.background = hoverBg;
        });
        item.addEventListener("mouseleave", () => {
          item.style.background = "transparent";
        });
        item.addEventListener("click", (ev) => {
          ev.stopPropagation();
          this.hideContextMenu();
          action();
        });
      }
      menu.appendChild(item);
    };

    const addSeparator = () => {
      const sep = document.createElement("div");
      sep.style.cssText = `height: 1px; background: ${separatorColor}; margin: 4px 0;`;
      menu.appendChild(sep);
    };

    // Undo / Redo
    if (isEditable) {
      const canUndo = this.undoBuffer.length > 0;
      const canRedo = this.redoBuffer.length > 0;

      addItem(
        this.localize("Undo"),
        `${ctrlCmd}+Z`,
        () => {
          this.undo();
        },
        canUndo,
        "\u21B6"
      );

      addItem(
        this.localize("Redo"),
        "Ctrl+Y / Cmd+Shift+Z",
        () => {
          this.redo();
        },
        canRedo,
        "\u21B7"
      );

      addSeparator();
    }

    // Clipboard operations
    if (isEditable) {
      addItem(
        this.localize("Cut"),
        `${ctrlCmd}+X`,
        () => {
          this.saveState();
          this.copySelected();
          this.eraseSelection();
          this.draw();
        },
        hasText,
        "\u2702"
      );

      addItem(
        this.localize("Copy"),
        `${ctrlCmd}+C`,
        () => {
          this.copySelected();
        },
        hasText,
        "\u2398"
      );

      addItem(
        this.localize("Paste"),
        `${ctrlCmd}+V`,
        () => {
          this.paste();
          this.draw();
        },
        true,
        "\u2399"
      );

      addItem(
        this.localize("Paste As Plain Text"),
        `${ctrlCmd}+Shift+V`,
        () => {
          this.paste(true);
          this.draw();
        },
        true,
        "\u238C"
      );

      addItem(
        this.localize("Select All"),
        `${ctrlCmd}+A`,
        () => {
          this.selectAll();
          this.draw();
        },
        true,
        "\u2B1A"
      );

      addSeparator();

      // Insert chord — only when cursor is on a lyrics line, no selection, and not a comment
      const canInsertChord =
        this.actionTarget instanceof ChordProLine && this.cursorPos !== null && !hasLineSelection && !hasText && !this.actionTarget.isComment;

      addItem(
        this.localize("Insert Chord"),
        "[",
        () => {
          if (this.actionTarget instanceof ChordProLine && this.cursorPos !== null) {
            const chord = new ChordProChord(this.actionTarget, this.initialChordValue(this.actionTarget, this.cursorPos), this.cursorPos);
            this.actionTarget.insertChord(chord);
            this.actionTarget.genText();
            this.changeActionTarget(chord);
            this.cursorPos = 0;
            this.selectionStart = 0;
            this.selectionEnd = chord.text.length;
            this.draw();
          }
        },
        canInsertChord,
        "\u266B"
      );

      addSeparator();

      // Section tags
      addItem(
        this.localize("Title"),
        `${altOption}+T`,
        () => {
          this.makeSelectionTitle();
        },
        hasText,
        "\uD835\uDC13"
      );

      addItem(
        this.localize("Verse"),
        `${altOption}+V`,
        () => {
          this.tagSelection("start_of_verse", this.getAutoTagValue("start_of_verse"));
        },
        hasLineSelection,
        "\uD835\uDC15"
      );

      addItem(
        this.localize("Chorus"),
        `${altOption}+C`,
        () => {
          this.tagSelection("start_of_chorus", this.getAutoTagValue("start_of_chorus"));
        },
        hasLineSelection,
        "\uD835\uDC02"
      );

      addItem(
        this.localize("Bridge"),
        `${altOption}+B`,
        () => {
          this.tagSelection("start_of_bridge", this.getAutoTagValue("start_of_bridge"));
        },
        hasLineSelection,
        "\uD835\uDC01"
      );

      addItem(
        this.localize("Grid"),
        `${altOption}+G`,
        () => {
          this.tagSelection("start_of_grid", this.getAutoTagValue("start_of_grid"));
        },
        hasLineSelection,
        "\u25A6"
      );

      addItem(
        this.localize("Comment"),
        `${altOption}+K`,
        () => {
          this.toggleCommentType();
        },
        hasLineSelection,
        "\u2638"
      );

      addItem(
        this.localize("Clear Tag"),
        `${altOption}+X`,
        () => {
          this.tagSelection("", "");
        },
        hasLineSelection,
        "\u2715"
      );
    } else addItem(this.localize("Copy All"), `${ctrlCmd}+C`, () => this.copyAll(), true, "\u2398");

    // Position menu at mouse coordinates, clamping to viewport
    let left = e.clientX;
    let top = e.clientY;

    document.body.appendChild(menu);

    const menuRect = menu.getBoundingClientRect();
    if (left + menuRect.width > window.innerWidth) left = window.innerWidth - menuRect.width - 4;
    if (top + menuRect.height > window.innerHeight) top = window.innerHeight - menuRect.height - 4;
    if (left < 0) left = 0;
    if (top < 0) top = 0;

    menu.style.left = left + "px";
    menu.style.top = top + "px";

    this.contextMenuElement = menu;

    // Dismiss listeners (async to avoid immediate dismissal)
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", this.dismissContextMenu);
      document.addEventListener("keydown", this.dismissContextMenu);
      window.addEventListener("blur", this.dismissContextMenu);
    });
  }

  private toggleCommentType() {
    if (this.chordPro && this.selectionStart instanceof ChordProSelection && this.selectionEnd instanceof ChordProSelection) {
      for (let i = this.selectionStart.line; i <= this.selectionEnd.line; ++i) if (this.chordPro.lines[i].chords.length > 0) return; // Don't allow toggling comment type if any line in selection contains chords

      this.saveState();
      let lastLine = this.selectionEnd.line;
      if (!this.selectionEnd.col) --lastLine;
      for (let i = this.selectionStart.line; i <= lastLine; ++i) {
        const line_obj = this.chordPro.lines[i];
        if (line_obj.isComment) {
          // Remove comment — restore as normal lyrics line
          line_obj.setCommentDirectiveType(undefined);
        } else {
          // Set as comment (italic style)
          line_obj.styles = new ChordProProperties();
          line_obj.setCommentDirectiveType("italic");
        }
        line_obj.genText();
      }
      this.draw();
    }
  }

  focus() {
    const focusTarget: HTMLElement | null = this.textarea ?? this.parentDiv;
    if (focusTarget) {
      focusTarget.focus({ preventScroll: true });
      if (!this.readOnly) virtualKeyboard()?.show();
    }
  }

  selectMetaData(name: string, offset?: number) {
    if (!offset) offset = 0;

    const keys = Array.from(this.metaInputs.keys());
    let currentIndex = keys.indexOf(name);

    // If name not found but we have inputs, try to find any match
    if (currentIndex < 0 && !name && keys.length > 0) {
      currentIndex = offset < 0 ? keys.length : -1;
    }

    const targetIndex = currentIndex + (offset || 0);
    if (targetIndex >= 0 && targetIndex < keys.length) {
      const targetName = keys[targetIndex];
      const el = this.metaInputs.get(targetName);
      if (el && el.value instanceof HTMLInputElement) {
        el.value.focus();
        return true;
      }
      return false;
    }

    return false;
  }

  externalUpdate(text: string) {
    if (this.chordPro) this.saveState();
    this.invalidateDisplaySequence();
    this.chordPro = new ChordProDocument(this.system, text);
    this.completeDocumentMutation();
    this.prevText = this.chordProCode;
    this.draw();
  }

  makeSelectionTitle() {
    const str = this.getSelectedText("lyrics");
    if (this.chordPro && str) {
      this.saveState();
      this.chordPro.setMeta("title", str.replace(/\?r\n/gs, " ").replace(/ +/g, " ").trim());
      this.draw();
    }
  }

  tagSelection(tagName: string, tagValue?: string) {
    if (this.chordPro && this.selectionStart instanceof ChordProSelection && this.selectionEnd instanceof ChordProSelection) {
      tagValue = tagValue ?? this.getAutoTagValue(tagName);
      this.saveState();
      let lastLine = this.selectionEnd.line;
      if (!this.selectionEnd.col) --lastLine;
      for (let i = 0; i < this.chordPro.lines.length; ++i) {
        const line_obj = this.chordPro.lines[i];
        if (this.selectionStart.line <= i && i <= lastLine) {
          if (!tagName || (tagValue !== undefined && tagValue != null)) {
            if (!tagName || tagName.startsWith("start_of_"))
              for (const name of Array.from(line_obj.styles.keys())) if (name.startsWith("start_of_")) line_obj.styles.delete(name);
            if (tagName) line_obj.styles.set(tagName, tagValue);
          } else line_obj.styles.delete(tagName);
          line_obj.genText();
        }
        line_obj.invalidateCache();
      }
      this.draw();
    }
  }

  HitTestLine(e: MouseEvent) {
    const mp = this.normalizeMousePos(e);

    // Geometry is renderer-owned; resolve against its index. The gesture
    // pipeline, payloads and thresholds above this call are unchanged.
    const geometry = this.domRenderer?.getGeometryIndex();
    if (geometry) return hitTestOccurrence(geometry, mp)?.occurrence.source ?? null;

    return null;
  }

  /**
   * Whole-section tag-column test, resolved from the renderer's geometry index.
   */
  private isTagColumnHit(mp: Point) {
    const geometry = this.domRenderer?.getGeometryIndex();
    return geometry ? isTagColumnPoint(geometry, mp) : false;
  }

  HitTestCoords(mp: Point) {
    // Resolve against the renderer's owned geometry index and hand back the same
    // hitbox shapes the gesture pipeline understands. Diagrams first: they
    // overlay the song.
    const geometry = this.domRenderer?.getGeometryIndex();
    if (geometry) {
      const diagram = hitTestDiagram(geometry, mp);
      if (diagram) {
        const BoxType = this.chordBoxType === "PIANO" ? PianoChordHitBox : GuitarChordHitBox;
        return new BoxType(diagram.left, diagram.top, diagram.width, diagram.height, diagram.chord);
      }
      const chord = hitTestChord(geometry, mp);
      if (chord) return new ChordProChordHitBox(chord.left, chord.top, chord.width, chord.height, chord.chord);

      // Section labels. The box extends past the label into the separation
      // gap, so a click just after the last character still targets the label
      // and reaches its trailing boundary.
      const tag = hitTestTag(geometry, mp, this.tagHitExtension());
      if (tag) {
        const line = tag.occurrence.occurrence.origin ?? tag.occurrence.occurrence.source;
        return new ChordProTagHitBox(tag.left, tag.top, tag.width + this.tagHitExtension(), tag.height, line, tag.name);
      }

      // Lyric caret placement resolves from the renderer's row geometry/caret
      // stops and hands back the per-character hitbox shape the gesture
      // pipeline above this call (drag selection, mouse-up caret commit)
      // expects. Columns are valid UTF-16 visual boundaries by construction.
      if (!this.readOnly) {
        const hit = resolveLineCaretHit(geometry, mp);
        if (hit && hit.occurrence.occurrence.kind === "lyrics" && !isTagColumnPoint(geometry, mp))
          return new ChordProLineHitBox(
            hit.cellLeft,
            hit.row.lyricsTop,
            hit.cellWidth,
            hit.row.lyricsHeight,
            hit.occurrence.occurrence.source,
            hit.column
          );
        // ABC blocks accept a double-click to open their editor; the hit box
        // spans the block's full width in edit mode.
        const occurrence = hitTestOccurrence(geometry, mp);
        const abc = occurrence?.occurrence.origin ?? occurrence?.occurrence.source;
        if (abc instanceof ChordProAbc)
          return new AbcHitBox(
            occurrence!.contentLeft,
            occurrence!.top,
            geometry.width - occurrence!.contentLeft,
            occurrence!.bottom - occurrence!.top,
            abc
          );
      }
      return null;
    }

    return null;
  }

  HitTest(e: MouseEvent) {
    return this.HitTestCoords(this.normalizeMousePos(e));
  }

  /**
   * Drop candidates for a chord drag, read from the renderer's geometry index.
   */
  private chordDropLines(): ChordDropLine[] {
    const geometry = this.domRenderer?.getGeometryIndex();
    return geometry ? buildChordDropLines(geometry) : [];
  }

  /**
   * Applies a chord drag's document mutation. The drop target resolves here,
   * in explicit pointer handling, before any paint; rendering only draws the
   * ghost and the drop marker.
   */
  private applyChordDrag(box: ChordProChordHitBox) {
    const chord = box.chord;
    const surfaceWidth = this.domRenderer?.getLayoutSnapshot().width ?? 0;
    const target = resolveChordDropTarget(this.chordDropLines(), chord.line, { x: box.left, y: box.top }, 2 * surfaceWidth);
    if (!target) {
      this.chordDropMarker = null;
      return;
    }
    // Marker anchor: `chordPos + chordLineHeight`, where
    // `chordPos = lyricsPos - chordLineHeight - 2 * chordBorder - chordLyricSep`
    // and `lyricsPos` is the lyric band's vertical centre.
    this.chordDropMarker = {
      x: target.markerX,
      y: target.lyricsTop + this.displayProps.lyricsLineHeight / 2 - 2 * this.displayProps.chordBorder - this.displayProps.chordLyricSep,
    };
    if (target.line === chord.line && target.column === chord.pos) return;
    chord.pos = target.column;
    chord.line.removeChord(chord);
    chord.line.genText();
    chord.line = target.line;
    chord.line.insertChord(chord);
    chord.line.genText();
    this.completeDocumentMutation();
  }

  normalizeSelection() {
    if (this.selectionStart !== null && this.selectionEnd !== null && this.comparePositions(this.selectionStart, this.selectionEnd) > 0) {
      const tmp = this.selectionStart;
      this.selectionStart = this.selectionEnd;
      this.selectionEnd = tmp;
    }
  }

  comparePositions(p1: ChordProSelection | number, p2: ChordProSelection | number) {
    if (p1 instanceof ChordProSelection && p2 instanceof ChordProSelection) {
      const diff = p1.line - p2.line;
      return diff ? diff : p1.col - p2.col;
    }
    return (p1 as number) - (p2 as number);
  }

  calcCursorPos(box: ChordProHitBox, e: MouseEvent) {
    if (!this.chordPro) return 0;

    let font: string,
      text: string,
      x = this.normalizeMousePos(e).x - box.left;
    if (box instanceof ChordProChordHitBox) {
      font = this.displayProps.chordFont;
      text = box.chord.text;
      x -= this.displayProps.chordBorder;
    } else if (box instanceof ChordProTagHitBox) {
      font = this.displayProps.tagFont;
      text = box.target.styles.get(box.parameter);
    } else return 0;

    // Prefix widths measured through the DOM renderer's batched measurer.
    const renderer = this.domRenderer;
    if (renderer) {
      return caretColumnForClick(text, (end) => (end > 0 ? renderer.measureTextWidth(text.substr(0, end), font) : 0), x);
    }
    return 0;
  }

  getAutoTagValue(tagName: string) {
    if (!this.chordPro || !tagName) return "";

    const tagValueList: string[] = [],
      selectedValueList: string[] = [];
    for (let i = 0; i < this.chordPro.lines.length; ++i) {
      const line_obj = this.chordPro.lines[i];
      if (line_obj.styles.has(tagName)) {
        const value = line_obj.styles.get(tagName);
        if (
          this.selectionStart instanceof ChordProSelection &&
          this.selectionEnd instanceof ChordProSelection &&
          this.selectionStart.line <= i &&
          i <= this.selectionEnd.line &&
          (this.selectionEnd.line !== i || this.selectionEnd.col > 0)
        ) {
          if (selectedValueList.indexOf(value) < 0) selectedValueList.push(value);
        } else {
          const unified = value.toLowerCase();
          if (tagValueList.indexOf(unified) < 0) tagValueList.push(unified);
        }
      }
    }

    if (selectedValueList.length === 1) return selectedValueList[0];

    let cnt = tagValueList.length + 1,
      tagValue = tagName;
    if (tagValue.startsWith("start_of_")) tagValue = tagValue.substr(9);
    tagValue = tagValue.substr(0, 1).toUpperCase() + tagValue.substr(1);

    if (cnt === 1) return tagValue;

    while (tagValueList.indexOf(tagValue.toLowerCase() + " " + cnt) >= 0) ++cnt;

    return tagValue + " " + cnt;
  }

  setSectionRepeatCounts(sectionRepeatCounts: SectionRepeatCount[] | undefined, draw = true) {
    this.sectionRepeatCounts = sectionRepeatCounts;
    if (draw) this.draw();
  }

  private resolveRepeatCount(from: number, to: number, section: number | undefined) {
    if (!this.sectionRepeatCounts?.length || section == null) return undefined;
    let byRange: SectionRepeatCount | undefined;
    let bySection: SectionRepeatCount | undefined;
    for (const item of this.sectionRepeatCounts) {
      if (item.section !== section) continue;
      if (!bySection) bySection = item;
      if (item.from === from && item.to === to) {
        byRange = item;
        break;
      }
    }
    const match = byRange ?? bySection;
    if (!match || !Number.isFinite(match.multiplier) || match.multiplier <= 1) return undefined;
    return Math.max(2, Math.floor(match.multiplier));
  }

  highlight(from: number, to: number, draw?: boolean): void;
  highlight(from: number, to: number, section: number | undefined, draw?: boolean): void;
  highlight(from: number, to: number, section: number | undefined, repeatNonce: number | undefined, draw?: boolean): void;
  highlight(
    from: number,
    to: number,
    sectionOrDraw: number | boolean | undefined = true,
    repeatNonceOrDraw: number | boolean | undefined = true,
    draw = true
  ) {
    let section: number | undefined;
    let repeatNonce: number | undefined;
    if (typeof sectionOrDraw === "boolean") {
      draw = sectionOrDraw;
    } else {
      section = sectionOrDraw;
      if (typeof repeatNonceOrDraw === "boolean") {
        draw = repeatNonceOrDraw;
      } else {
        repeatNonce = repeatNonceOrDraw;
      }
    }
    if (!this.readOnly) {
      from = to = 0;
      section = undefined;
      repeatNonce = undefined;
    }
    const repeatTotal = this.resolveRepeatCount(from, to, section);
    const sameSelection = (this.highlighted?.from || 0) === from && (this.highlighted?.to || 0) === to && this.highlighted?.section === section;
    if (sameSelection && repeatTotal && repeatTotal > 1) {
      let repeatIndex: number;
      if (repeatNonce != null) {
        repeatIndex = (((repeatNonce % repeatTotal) + repeatTotal) % repeatTotal || 0) + 1;
      } else if ((this.highlighted?.repeatTotal || 0) > 1) {
        const prevRepeat = this.highlighted?.repeatIndex && this.highlighted.repeatIndex > 0 ? this.highlighted.repeatIndex : 1;
        repeatIndex = (prevRepeat % repeatTotal) + 1;
      } else {
        repeatIndex = 1;
      }
      this.highlighted = {
        from,
        to,
        section,
        repeatIndex,
        repeatTotal,
        repeatNonce,
      };
      if (draw) this.draw();
      this.requestHighlightScroll();
      return;
    }

    const repeatIndex =
      repeatTotal && repeatTotal > 1 ? (repeatNonce != null ? (((repeatNonce % repeatTotal) + repeatTotal) % repeatTotal || 0) + 1 : 1) : undefined;
    const prevSection = this.highlighted?.section;
    if (
      (this.highlighted?.from || 0) !== from ||
      (this.highlighted?.to || 0) !== to ||
      prevSection !== section ||
      (this.highlighted?.repeatTotal || 0) !== (repeatTotal || 0) ||
      (this.highlighted?.repeatNonce ?? -1) !== (repeatNonce ?? -1)
    ) {
      this.highlighted = { from, to, section, repeatIndex, repeatTotal, repeatNonce };
      if (draw) this.draw();
      this.requestHighlightScroll();
    }
  }

  /**
   * Schedules highlight scroll-follow. The canvas has painted by the time
   * `draw()` returns, but the DOM backend commits on a scheduled frame, so its
   * geometry only exists once the layout settles. Waiting on the layout instead
   * of a timer keeps the same-section and visibility guards operating on real
   * geometry. A superseded or disposed layout simply cancels the follow.
   */
  private requestHighlightScroll() {
    const domRenderer = this.domRenderer;
    if (!domRenderer) {
      this.scrollHighlightedIntoView();
      return;
    }
    void domRenderer.whenLayoutSettled().then(
      () => {
        if (!this.disposed && this.domRenderer === domRenderer) this.scrollHighlightedIntoView();
      },
      () => undefined
    );
  }

  /**
   * Returns true if the given displayed line is currently highlighted by the
   * stored projection range.
   *
   * - Lines that carry no `instructedSectionIndex` (raw rendering, instruction
   *   mode off) ignore the section filter and fall back to plain source-line
   *   range matching.
   * - Ellipsis-preview lines (`sourceLineNumber === -1`, emitted in FIRST_LINE
   *   mode for repeated sections) light up ONLY when the projection targets
   *   that exact preview's instruction item. They are not lit when the
   *   projection targets the original expanded block or a different repeat.
   * - Normal instructed lines light up when their repeat group matches the
   *   projected section's repeat group AND the source line falls in the
   *   projected `from`/`to` range. This means projecting any occurrence of a
   *   repeated section also lights up the original expanded block (and, via
   *   the exact-match rule above, the specific ellipsis preview being
   *   projected — but not other previews of the same section).
   */
  private isHighlightedLine(line: ChordProLine): boolean {
    if (!this.highlighted) return false;
    const hlSection = this.highlighted.section;
    if (line.sourceLineNumber === -1) {
      // Ellipsis-preview lines: exact instruction-item match only.
      return hlSection != null && line.instructedSectionIndex === hlSection;
    }
    if (hlSection != null && line.instructedSectionIndex != null) {
      const groups = this.instructedSectionGroups;
      const lineGroup = groups?.[line.instructedSectionIndex] ?? line.instructedSectionIndex;
      const hlGroup = groups?.[hlSection] ?? hlSection;
      if (lineGroup !== hlGroup) return false;
    }
    return line.sourceLineNumber >= this.highlighted.from && line.sourceLineNumber < this.highlighted.to;
  }

  /** State of the in-flight smooth-scroll animation, if any. */
  private highlightScrollAnim: {
    target: HTMLElement;
    fromTop: number;
    toTop: number;
    startTime: number;
    duration: number;
    rafId: number;
  } | null = null;

  /**
   * Last section identity for which highlight auto-scroll was evaluated.
   * `undefined` means "no prior section" (first call after reset).
   */
  private lastHighlightScrollSectionToken: string | null | undefined;

  /**
   * Resolve a stable section token for the currently highlighted range so
   * scroll behavior can react to section changes (verse/chorus/bridge), not
   * every line movement inside the same section.
   */
  private getHighlightSectionToken(firstHighlightedLine: ChordProLine): string | null {
    const highlightedSection = this.highlighted?.section;
    if (highlightedSection != null) {
      const group = this.instructedSectionGroups?.[highlightedSection] ?? highlightedSection;
      return `instruction-group:${group}`;
    }

    const instructedIndex = firstHighlightedLine.instructedSectionIndex;
    if (instructedIndex != null) {
      const group = this.instructedSectionGroups?.[instructedIndex] ?? instructedIndex;
      return `displayed-group:${group}`;
    }

    const lineIndex = this.displayedLines.indexOf(firstHighlightedLine);
    if (lineIndex < 0) return null;

    const lineToken = (line: ChordProLine) => {
      const info = line.getSectionInfo();
      const canonical = info.withoutModifiers()?.trim();
      if (canonical) return `section:${canonical.toLocaleLowerCase()}`;
      const tagInfo = line.getTagInfo();
      const key = tagInfo.key?.toString()?.trim();
      if (key) return `tag-key:${key.toLocaleLowerCase()}`;
      const tag = tagInfo.tag?.toString()?.trim();
      if (tag) return `tag:${tag.toLocaleLowerCase()}`;
      return null;
    };

    // Prefer current line, then walk backward to nearest tagged section line,
    // then forward as a final fallback.
    let token = lineToken(firstHighlightedLine);
    if (token) return token;
    for (let i = lineIndex - 1; i >= 0; --i) {
      token = lineToken(this.displayedLines[i]);
      if (token) return token;
    }
    for (let i = lineIndex + 1; i < this.displayedLines.length; ++i) {
      token = lineToken(this.displayedLines[i]);
      if (token) return token;
    }
    return null;
  }

  /**
   * Vertical extent of a displayed line in the renderer's logical coordinates,
   * read from its geometry index. The renderer never writes back onto the song
   * model.
   */
  private displayedLineRange(line: ChordProLine): { top: number; bottom: number } | null {
    const geometry = this.domRenderer?.getGeometryIndex();
    if (!geometry) return null;
    const entry = geometry.occurrences.find((candidate) => candidate.occurrence.source === line);
    return entry ? { top: entry.top, bottom: entry.bottom } : null;
  }

  /**
   * The scrolled song surface and the factor converting its logical Y units into
   * displayed pixels. The DOM root commits its logical size, so the ratio of the
   * displayed box to that logical height covers any host `transform: scale()`.
   */
  private highlightScrollSurface(): { rect: DOMRect; logicalToDisplay: number } | null {
    const domRenderer = this.domRenderer;
    if (!domRenderer) return null;
    const rect = domRenderer.element.getBoundingClientRect();
    const logicalHeight = domRenderer.getLayoutSnapshot().height || 0;
    if (!logicalHeight) return null;
    const ratio = rect.height / logicalHeight;
    return { rect, logicalToDisplay: Number.isFinite(ratio) && ratio > 0 ? ratio : 1 };
  }

  private scrollHighlightedIntoView() {
    if (!this.highlighted || !this.displayedLines.length) {
      this.lastHighlightScrollSectionToken = undefined;
      return;
    }

    // Find the first and last highlighted lines
    let firstHighlightedLine: ChordProLine | null = null;
    let lastHighlightedLine: ChordProLine | null = null;
    let firstHighlightedIndex = -1;
    let lastHighlightedIndex = -1;

    for (let i = 0; i < this.displayedLines.length; ++i) {
      const line = this.displayedLines[i];
      if (this.isHighlightedLine(line)) {
        if (!firstHighlightedLine) {
          firstHighlightedLine = line;
          firstHighlightedIndex = i;
        }
        lastHighlightedLine = line;
        lastHighlightedIndex = i;
      }
    }

    if (!firstHighlightedLine || !lastHighlightedLine) {
      this.lastHighlightScrollSectionToken = undefined;
      return;
    }

    const currentSectionToken = this.getHighlightSectionToken(firstHighlightedLine);
    const lastSectionToken = this.lastHighlightScrollSectionToken;
    const sameSectionAsLast = lastSectionToken !== undefined && lastSectionToken === currentSectionToken;
    this.lastHighlightScrollSectionToken = currentSectionToken;

    // Highlight range, in the active backend's logical Y coordinates.
    const highlightAnchorTop = this.displayedLineRange(firstHighlightedLine)?.top || 0;
    let highlightTop = highlightAnchorTop;
    let highlightBottom = this.displayedLineRange(lastHighlightedLine)?.bottom || 0;

    // Always extend visible highlight-follow range with adjacent special
    // blocks (grid/comment/abc) so surrounding context stays on screen.
    const isRangeExtensionLine = (line: ChordProLine) => line.isGrid || line.isComment || line instanceof ChordProAbc;
    const includeAdjacentSpecialBlock = (startIndex: number, step: -1 | 1) => {
      const line = this.displayedLines[startIndex];
      if (!line || !isRangeExtensionLine(line)) return;

      for (let i = startIndex; i >= 0 && i < this.displayedLines.length; i += step) {
        const candidate = this.displayedLines[i];
        if (!isRangeExtensionLine(candidate)) break;
        const yRange = this.displayedLineRange(candidate);
        if (!yRange) continue;
        highlightTop = Math.min(highlightTop, yRange.top);
        highlightBottom = Math.max(highlightBottom, yRange.bottom);
      }
    };

    if (firstHighlightedIndex > 0) includeAdjacentSpecialBlock(firstHighlightedIndex - 1, -1);
    if (lastHighlightedIndex >= 0 && lastHighlightedIndex + 1 < this.displayedLines.length) {
      includeAdjacentSpecialBlock(lastHighlightedIndex + 1, 1);
    }

    if (!Number.isFinite(highlightTop) || !Number.isFinite(highlightBottom) || highlightBottom <= highlightTop) return;

    // The canvas is rendered inside `parent_div` (the `.editor` element) which
    // is itself `overflow: hidden`. The element that actually scrolls is the
    // closest ancestor whose computed style allows vertical overflow (for
    // PraiseProjector this is `.editorContainer.editMode` or the new
    // `.editorContainer.scrollMode`). Walk up the tree to find it so the
    // scroll happens on the right element in every display mode.
    const parentDiv = this.parent_div;
    const scrollTarget = this.findScrollableAncestor(parentDiv);
    if (!scrollTarget) return;

    // Translate the surface-local highlight Y range into the scroll target's own
    // coordinate system: add the offset between the surface top and the scroll
    // target's content top, plus the scroll target's current scrollTop.
    const targetRect = scrollTarget.getBoundingClientRect();
    const surface = this.highlightScrollSurface();
    if (!surface) return;
    // Pixel offset on the page from the scroll target's content origin to the
    // top of the surface (already includes any current scroll offset).
    const surfaceOffsetWithinTarget = surface.rect.top - targetRect.top + scrollTarget.scrollTop;
    const highlightTopInTarget = surfaceOffsetWithinTarget + highlightTop * surface.logicalToDisplay;
    const highlightBottomInTarget = surfaceOffsetWithinTarget + highlightBottom * surface.logicalToDisplay;

    const viewportHeight = scrollTarget.clientHeight;

    if (!sameSectionAsLast) {
      this.runSectionAwareCentering(
        firstHighlightedLine,
        highlightAnchorTop,
        highlightTopInTarget,
        highlightBottomInTarget,
        surfaceOffsetWithinTarget,
        surface.logicalToDisplay,
        viewportHeight,
        scrollTarget
      );
    }

    // Visibility safety net: regardless of whatever the section-aware
    // centering above decided (including the no-op "same section as last"
    // case), make sure the highlighted range is actually inside the viewport.
    // If it isn't, scroll the minimum amount required to bring it in. This
    // covers the case where a section is taller than the viewport and the
    // highlight moved within it but is now off-screen.
    {
      const effectiveScrollTop =
        this.highlightScrollAnim?.target === scrollTarget && this.highlightScrollAnim ? this.highlightScrollAnim.toTop : scrollTarget.scrollTop;
      const viewTop = effectiveScrollTop;
      const viewBottom = effectiveScrollTop + viewportHeight;
      const hlAboveView = highlightTopInTarget < viewTop;
      const hlBelowView = highlightBottomInTarget > viewBottom;
      if (hlAboveView || hlBelowView) {
        let safetyTarget: number;
        if (highlightBottomInTarget - highlightTopInTarget > viewportHeight) {
          // Highlight is taller than the viewport — anchor its top.
          safetyTarget = highlightTopInTarget;
        } else if (hlAboveView) {
          // Highlight above current view — align its top to viewport top.
          safetyTarget = highlightTopInTarget;
        } else {
          // Highlight below current view — align its bottom to viewport bottom.
          safetyTarget = highlightBottomInTarget - viewportHeight;
        }
        const maxScrollSafety = Math.max(0, scrollTarget.scrollHeight - viewportHeight);
        safetyTarget = Math.max(0, Math.min(safetyTarget, maxScrollSafety));
        if (Math.abs(safetyTarget - effectiveScrollTop) >= 2) {
          this.animateScrollTo(scrollTarget, safetyTarget, viewportHeight);
        }
      }
    }
  }

  private runSectionAwareCentering(
    firstHighlightedLine: ChordProLine,
    highlightTop: number,
    highlightTopInTarget: number,
    highlightBottomInTarget: number,
    canvasOffsetWithinTarget: number,
    logicalToDisplay: number,
    viewportHeight: number,
    scrollTarget: HTMLElement
  ) {
    // Prefer scrolling with section context when instruction indices are
    // available: try to fit previous+current+next section, then
    // current+next, then current.
    const chooseSectionContextRange = (): { top: number; bottom: number } | null => {
      type SectionRange = {
        index: number;
        group: number;
        top: number;
        bottom: number;
        hasSourceLine: boolean;
        hasNonCommentLine: boolean;
      };
      type SectionBlock = {
        token: string;
        top: number;
        bottom: number;
        startLine: number;
        endLine: number;
      };

      if (!this.displayedLines.length) return null;

      // Section ranges are in logical canvas units while viewportHeight is in
      // displayed CSS pixels. Convert before checking whether a range can fit.
      const fits = (r: { top: number; bottom: number }) => (r.bottom - r.top) * logicalToDisplay <= viewportHeight + 1;

      const chooseFromTagBlocks = (): { top: number; bottom: number } | null => {
        const lineToken = (line: ChordProLine): string | null => {
          const info = line.getSectionInfo();
          const canonical = info.withoutModifiers()?.trim();
          if (canonical) return `section:${canonical.toLocaleLowerCase()}`;
          const tagInfo = line.getTagInfo();
          const key = tagInfo.key?.toString()?.trim();
          if (key) return `tag-key:${key.toLocaleLowerCase()}`;
          const tag = tagInfo.tag?.toString()?.trim();
          if (tag) return `tag:${tag.toLocaleLowerCase()}`;
          return null;
        };

        const blocks: SectionBlock[] = [];
        let currentToken: string | null = null;
        for (let i = 0; i < this.displayedLines.length; ++i) {
          const line = this.displayedLines[i];
          const yRange = this.displayedLineRange(line);
          if (!yRange) continue;
          const rawToken = lineToken(line);
          if (rawToken) currentToken = rawToken;
          const effectiveToken = currentToken ?? rawToken ?? `untagged:${i}`;
          const prevBlock = blocks.length ? blocks[blocks.length - 1] : null;
          if (prevBlock && prevBlock.token === effectiveToken) {
            prevBlock.bottom = Math.max(prevBlock.bottom, yRange.bottom);
            prevBlock.endLine = i;
          } else {
            blocks.push({
              token: effectiveToken,
              top: yRange.top,
              bottom: yRange.bottom,
              startLine: i,
              endLine: i,
            });
          }
        }

        if (!blocks.length) return null;

        const firstLineIndex = this.displayedLines.indexOf(firstHighlightedLine);
        if (firstLineIndex < 0) return null;
        let currentBlockIndex = blocks.findIndex((b) => b.startLine <= firstLineIndex && firstLineIndex <= b.endLine);
        if (currentBlockIndex < 0) {
          // Fallback to nearest block by top position.
          currentBlockIndex = blocks.findIndex((b) => b.top <= highlightTop && highlightTop <= b.bottom);
        }
        if (currentBlockIndex < 0) return null;

        const current = blocks[currentBlockIndex];
        let prev: SectionBlock | undefined;
        for (let i = currentBlockIndex - 1; i >= 0; --i)
          if (blocks[i].token !== current.token) {
            prev = blocks[i];
            break;
          }

        let next: SectionBlock | undefined;
        for (let i = currentBlockIndex + 1; i < blocks.length; ++i)
          if (blocks[i].token !== current.token) {
            next = blocks[i];
            break;
          }

        if (prev && next) {
          const tri = {
            top: Math.min(prev.top, current.top, next.top),
            bottom: Math.max(prev.bottom, current.bottom, next.bottom),
          };
          if (fits(tri)) return tri;
        }

        if (next) {
          const duo = {
            top: Math.min(current.top, next.top),
            bottom: Math.max(current.bottom, next.bottom),
          };
          if (fits(duo)) return duo;
        }

        if (prev) {
          const duo = {
            top: Math.min(prev.top, current.top),
            bottom: Math.max(prev.bottom, current.bottom),
          };
          if (fits(duo)) return duo;
        }

        return { top: current.top, bottom: current.bottom };
      };

      const byIndex = new Map<number, SectionRange>();
      for (const line of this.displayedLines) {
        const idx = line.instructedSectionIndex;
        const yRange = this.displayedLineRange(line);
        if (idx == null || !yRange) continue;
        let section = byIndex.get(idx);
        if (!section) {
          section = {
            index: idx,
            group: this.instructedSectionGroups?.[idx] ?? idx,
            top: yRange.top,
            bottom: yRange.bottom,
            hasSourceLine: false,
            hasNonCommentLine: false,
          };
          byIndex.set(idx, section);
        } else {
          section.top = Math.min(section.top, yRange.top);
          section.bottom = Math.max(section.bottom, yRange.bottom);
        }
        if (line.sourceLineNumber >= 0) section.hasSourceLine = true;
        if (!line.isComment) section.hasNonCommentLine = true;
      }

      if (!byIndex.size) return chooseFromTagBlocks();

      const isRealSection = (s: SectionRange) => {
        const item = this.instructions?.items[s.index];
        if (item) return item.multiplier != null;
        // Fallback heuristic when rendered from implicit/default instructions.
        return s.hasSourceLine || s.hasNonCommentLine;
      };

      const sections = Array.from(byIndex.values())
        .filter(isRealSection)
        .sort((a, b) => a.index - b.index);
      if (!sections.length) return chooseFromTagBlocks();

      let current = this.highlighted?.section != null ? sections.find((s) => s.index === this.highlighted?.section) : undefined;

      // Fallback: derive from whichever highlighted displayed line carries an
      // instruction index.
      if (!current) {
        for (const line of this.displayedLines) {
          if (!this.isHighlightedLine(line)) continue;
          const idx = line.instructedSectionIndex;
          if (idx == null) continue;
          const candidate = sections.find((s) => s.index === idx);
          if (candidate) {
            current = candidate;
            break;
          }
        }
      }

      if (!current) return chooseFromTagBlocks();

      let prev: SectionRange | undefined;
      for (let i = sections.length - 1; i >= 0; --i) {
        const s = sections[i];
        if (s.index >= current.index) continue;
        if (s.group !== current.group) {
          prev = s;
          break;
        }
      }

      let next: SectionRange | undefined;
      for (const s of sections) {
        if (s.index <= current.index) continue;
        if (s.group !== current.group) {
          next = s;
          break;
        }
      }

      if (prev && next) {
        const tri = {
          top: Math.min(prev.top, current.top, next.top),
          bottom: Math.max(prev.bottom, current.bottom, next.bottom),
        };
        if (fits(tri)) return tri;
      }

      if (next) {
        const duo = {
          top: Math.min(current.top, next.top),
          bottom: Math.max(current.bottom, next.bottom),
        };
        if (fits(duo)) return duo;
      }

      if (prev) {
        const duo = {
          top: Math.min(prev.top, current.top),
          bottom: Math.max(prev.bottom, current.bottom),
        };
        if (fits(duo)) return duo;
      }

      return { top: current.top, bottom: current.bottom };
    };

    const contextRange = chooseSectionContextRange();
    const focusTopInTarget = contextRange ? canvasOffsetWithinTarget + contextRange.top * logicalToDisplay : highlightTopInTarget;
    const focusBottomInTarget = contextRange ? canvasOffsetWithinTarget + contextRange.bottom * logicalToDisplay : highlightBottomInTarget;

    // True vertical centering: aim to put the highlight's center at the
    // viewport's center. After clamping to [0, maxScroll] this naturally
    // produces the desired behavior:
    //   • Highlight near the top of the document  -> desired scrollTop is
    //     negative, clamped to 0, no scrolling happens. The highlight is
    //     allowed to travel from the document's top down to (and past) the
    //     viewport center before any scrolling begins.
    //   • Once the highlight's center passes the viewport center, scrollTop
    //     starts following so the highlight stays at the middle.
    //   • Near the document's bottom the clamp keeps the last lines visible.
    const highlightCenter = (focusTopInTarget + focusBottomInTarget) / 2;
    const desiredScrollTop = highlightCenter - viewportHeight / 2;
    const maxScroll = Math.max(0, scrollTarget.scrollHeight - viewportHeight);
    const targetScrollTop = Math.max(0, Math.min(desiredScrollTop, maxScroll));

    // Track the highlight as close to the viewport center as the document
    // allows. We always recompute the centered scrollTop and animate to it
    // unless the move would be sub-pixel jitter. The Math.max/min clamp
    // naturally produces the desired edge behavior:
    //   • Near the document top  → desiredScrollTop is negative, clamp to 0.
    //   • Near the document bottom → clamp to maxScroll.
    // Inside the document we follow every selection change so the highlight
    // stays centered (or as centered as possible at the edges).
    const currentTop =
      this.highlightScrollAnim?.target === scrollTarget && this.highlightScrollAnim
        ? this.highlightScrollAnim.toTop // already animating toward this value
        : scrollTarget.scrollTop;

    // 2 px tolerance absorbs sub-pixel layout rounding without affecting the
    // perceived behavior.
    const delta = Math.abs(targetScrollTop - currentTop);
    if (delta < 2) return;

    this.animateScrollTo(scrollTarget, targetScrollTop, viewportHeight);
  }

  /**
   * Smoothly scroll `target` to `toTop`. Animation duration is designed so
   * that NEAR moves feel slow & gentle (low velocity, easy on the eye) while
   * FAR jumps stay snappy (the user can't tolerate a multi-second crawl when
   * jumping across the whole song):
   *   • distance 0           → 600 ms
   *   • distance = 1 viewport → 1000 ms  (gentle, still readable)
   *   • distance ≥ 3 viewports → 400 ms  (fast jump)
   * If an animation is already in flight, it is cancelled and replaced so
   * rapid selection changes are honored immediately.
   */
  private animateScrollTo(target: HTMLElement, toTop: number, viewportHeight: number) {
    if (this.highlightScrollAnim) {
      cancelAnimationFrame(this.highlightScrollAnim.rafId);
      this.highlightScrollAnim = null;
    }

    const fromTop = target.scrollTop;
    const distance = Math.abs(toTop - fromTop);
    if (distance < 1) {
      target.scrollTop = toTop;
      return;
    }

    const vp = Math.max(1, viewportHeight);
    let duration: number;
    if (distance <= vp) {
      // Near range: 600 ms → 1000 ms. Velocity rises slowly so motion looks
      // gentle even when there are several lines to traverse.
      duration = 600 + (distance / vp) * 400;
    } else {
      // Far range: ramp from 1000 ms down to 400 ms as distance grows from 1
      // viewport up to 3 viewports, then stay at 400 ms. Big jumps feel
      // quick (high velocity) without being instant.
      const factor = Math.min(1, (distance - vp) / (2 * vp));
      duration = 1000 - factor * 600;
    }

    const startTime = performance.now();
    const tick = (now: number) => {
      const anim = this.highlightScrollAnim;
      if (!anim) return;
      const t = Math.min(1, (now - anim.startTime) / anim.duration);
      // easeInOutCubic — smooth start and end, no abrupt motion.
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      anim.target.scrollTop = anim.fromTop + (anim.toTop - anim.fromTop) * eased;
      if (t < 1) anim.rafId = requestAnimationFrame(tick);
      else this.highlightScrollAnim = null;
    };

    this.highlightScrollAnim = {
      target,
      fromTop,
      toTop,
      startTime,
      duration,
      rafId: requestAnimationFrame(tick),
    };
  }

  /**
   * Walk up the DOM from `start` and return the first ancestor whose computed
   * style allows vertical scrolling AND that actually has scrollable content.
   * Returns null if none is found (e.g. when the song is displayed in a fixed
   * aspect-ratio container that has no overflow).
   */
  private findScrollableAncestor(start: HTMLElement): HTMLElement | null {
    let el: HTMLElement | null = start;
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      const scrollable = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
      if (scrollable && el.scrollHeight > el.clientHeight + 1) return el;
      el = el.parentElement;
    }
    return null;
  }

  suppressDraw(suppress = true) {
    if (!suppress && this.drawingSuppressed) this.update();
    else this.drawingSuppressed = suppress;
  }

  update(keepDrawingSuppressed?: boolean) {
    try {
      this.drawingSuppressed = false;
      this.draw();
    } finally {
      this.drawingSuppressed = !!keepDrawingSuppressed;
    }
  }

  /**
   * Phase C bundle diet: abcjs is dynamically imported (see abcjs-lazy.ts). Returns
   * true when the chunk is ready; otherwise kicks the load off once and re-draws on
   * arrival, so ABC blocks render as a zero-height placeholder for the brief window
   * before the module lands. No-op cost once loaded.
   */
  private ensureAbcjsLoaded(): boolean {
    if (isAbcjsLoaded()) return true;
    if (!this.abcjsLoadPending) {
      this.abcjsLoadPending = true;
      void loadAbcjs().finally(() => {
        this.abcjsLoadPending = false;
        if (!this.disposed) this.update();
      });
    }
    return false;
  }

  /**
   * The single render entry point. It does the backend-neutral bookkeeping
   * (document-change detection, `onChange`) and then hands the frame to the DOM
   * renderer through `reconcileRenderBackend`, which coalesces the actual commit
   * on a `requestAnimationFrame`. The `_delayable` parameter is retained for
   * its ~90 call sites; nothing consumes it anymore.
   */
  draw(_delayable?: boolean) {
    if (this.disposed || this.drawingSuppressed) return;

    if (this.chordPro) {
      const currentText = this.chordProCode;
      if (this.semanticDocumentText !== currentText) this.completeDocumentMutation();
      if (this.onChange && this.prevText !== currentText) this.onChange((this.prevText = currentText));
    }

    // Ensure abcjs is loaded before laying out a song that contains ABC notation.
    // Covers the readonly-transpose path that converts ABC lines to grids.
    if (!isAbcjsLoaded() && this.chordPro && this.chordPro.lines.some((l) => l instanceof ChordProAbc)) {
      this.ensureAbcjsLoaded();
    }

    this.reconcileRenderBackend("structure");
  }

  private createMetaRow(styleName: string) {
    const row = document.createElement("div");
    row.style.position = "absolute";
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.whiteSpace = "nowrap";
    row.style.overflow = "hidden";
    row.style.boxSizing = "border-box";
    row.style.background = "transparent";
    row.style.pointerEvents = this.readOnly ? "none" : "auto";

    const prefix = document.createElement("span");
    prefix.style.flexShrink = "0";
    prefix.style.font = "inherit";
    prefix.style.color = "inherit";
    prefix.style.height = "100%";
    prefix.style.display = "flex";
    prefix.style.alignItems = "center";
    row.appendChild(prefix);

    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = this.readOnly;
    input.style.border = "none";
    input.style.outline = "none";
    input.style.background = "transparent";
    input.style.padding = "0";
    input.style.margin = "0";
    input.style.font = "inherit";
    input.style.color = "inherit";
    input.style.textAlign = "inherit";
    input.style.flex = "1";
    input.style.minWidth = "0";
    input.style.height = "100%";
    input.style.boxSizing = "border-box";
    input.style.pointerEvents = "auto";
    if (this.readOnly) {
      input.style.overflow = "hidden";
      input.style.textOverflow = "ellipsis";
    }
    input.addEventListener("input", () => this.onMetaInput(styleName, input.value));
    input.addEventListener("keydown", (e: KeyboardEvent) => this.onMetaKeyDown(styleName, e));
    input.addEventListener("focus", () => this.onMetaFocus(styleName));
    input.addEventListener("blur", () => this.onMetaBlur(styleName));
    row.appendChild(input);

    return { row, prefix, value: input };
  }

  private ensureMetaMeasureSpan() {
    if (!this.metaMeasureSpan) {
      const span = document.createElement("span");
      span.style.position = "absolute";
      span.style.left = "-100000px";
      span.style.top = "0";
      span.style.visibility = "hidden";
      span.style.whiteSpace = "pre";
      span.style.pointerEvents = "none";
      document.body.appendChild(span);
      this.metaMeasureSpan = span;
    }
    return this.metaMeasureSpan;
  }

  private measureMetaValueWidth(input: HTMLInputElement, text: string) {
    const style = getComputedStyle(input);
    const span = this.ensureMetaMeasureSpan();
    span.style.font = style.font;
    span.style.letterSpacing = style.letterSpacing;
    span.style.textTransform = style.textTransform;
    span.textContent = text && text.length > 0 ? text : " ";
    return span.offsetWidth;
  }

  /**
   * Metadata text width for a directive's own font, without a mounted input: the
   * shared row width has to be known before any row is styled.
   */
  private measureMetaText(font: string, text: string) {
    const span = this.ensureMetaMeasureSpan();
    span.style.font = font;
    span.style.letterSpacing = "normal";
    span.style.textTransform = "none";
    span.textContent = text && text.length > 0 ? text : " ";
    return span.offsetWidth;
  }

  private updateMetaInputWidth(styleName: string, valueOverride?: string) {
    const el = this.metaInputs.get(styleName);
    if (!el) return;

    const requestedAlign = el.row.dataset.requestedAlign || el.row.style.textAlign || "";
    const text = valueOverride ?? el.value.value;
    const measured = Math.ceil(this.measureMetaValueWidth(el.value, text) + 3);
    const prefixWidth = el.prefix.offsetWidth;
    const paddingLeft = Number.parseFloat(getComputedStyle(el.row).paddingLeft) || 0;
    const available = Math.max(1, el.row.clientWidth - prefixWidth - paddingLeft);
    const align = el.row.dataset.safeCenter === "true" ? safeMetaAlignment(requestedAlign, measured, available) : requestedAlign;
    el.row.style.textAlign = align || "left";
    el.row.style.justifyContent = align === "right" ? "flex-end" : align === "center" ? "center" : "";
    const tightAlign = align === "right" || align === "center";
    el.value.style.flex = tightAlign ? "0 0 auto" : "1";
    el.value.style.textAlign = align || "left";

    if (tightAlign) {
      el.value.style.width = Math.min(measured, available) + "px";
    } else {
      el.value.style.width = "";
    }

    if (el.row.dataset.safeCenter === "true" && align === "left" && document.activeElement !== el.value) el.value.scrollLeft = 0;

    // Remove intrinsic character-based sizing so width is driven by measured pixels.
    el.value.removeAttribute("size");
  }

  private onMetaInput(name: string, newValue: string) {
    this.updateMetaInputWidth(name, newValue);
    if (!this.chordPro) return;
    this.saveState();
    this.chordPro.setMeta(name, newValue);
    if (this.onChange) {
      const currentText = this.chordProCode;
      if (this.prevText !== currentText) this.onChange((this.prevText = currentText));
    }
    // Route this mutation through the centralized document-revision
    // invalidation like every other edit; the focused input survives the keyed
    // reconcile because the renderer reuses it by identity.
    this.draw();
  }

  private onMetaKeyDown(name: string, e: KeyboardEvent) {
    const code = getKeyCodeString(e);
    if (code === "UP") {
      e.preventDefault();
      if (!this.selectMetaData(name, -1)) this.selectMetaData(name);
    } else if (code === "DOWN" || code === "ENTER") {
      e.preventDefault();
      if (!this.selectMetaData(name, 1)) {
        // Navigate to first song line
        if (this.chordPro && this.chordPro.lines.length > 0) {
          this.changeActionTarget(this.chordPro.lines[0]);
          this.cursorPos = 0;
          this.draw();
          this.focus();
        }
      }
    } else if ((e.ctrlKey || e.metaKey) && code === "Z" && !e.shiftKey) {
      e.preventDefault();
      this.undo();
      this.syncMetaInputValues();
    } else if ((e.ctrlKey || e.metaKey) && (code === "Y" || (e.shiftKey && code === "Z"))) {
      e.preventDefault();
      this.redo();
      this.syncMetaInputValues();
    }
  }

  private onMetaFocus(_name: string) {
    // Clear song action state when a metadata input gets focus, then re-render.
    this.clearActionState();
    this.draw();
  }

  private onMetaBlur(name: string) {
    // Restore the beginning of an over-long viewport-aligned title after the
    // native input has scrolled to keep its editing caret visible.
    this.updateMetaInputWidth(name);
  }

  private syncMetaInputValues() {
    if (!this.chordPro) return;
    for (const [styleName, el] of this.metaInputs) {
      const currentValue = this.chordPro.getMeta(styleName);
      if (el.value.value !== currentValue) el.value.value = currentValue;
      this.updateMetaInputWidth(styleName, currentValue);
    }
  }

  // ---- Abc notation HTML methods ----

  private guessKey() {
    if (!this.chordPro) return "";

    const chordHist = new Map<string, number>(); // chord -> count
    const firstChords = new Map<string, number>(); // chord -> count
    const lastChords = new Map<string, number>(); // chord -> count

    const processChord = (chord: string | ChordProChordBase, first: boolean, last: boolean) => {
      const details = this.getChordDetails(chord);
      let ch = "";
      if (details) {
        ch = details.baseNote;
        if (details.normalized.match(/2|4|sus/g)) ch += "2";
        else if (details.minor) ch += "m";
      }
      if (ch) {
        chordHist.set(ch, (chordHist.get(ch) ?? 0) + 1);
        if (first) if (ch) firstChords.set(ch, (firstChords.get(ch) ?? 0) + 1);
        if (last) lastChords.set(ch, (lastChords.get(ch) ?? 0) + 1);
      }
    };

    if (this.chordPro.sectionInfo.size > 0)
      this.chordPro.sectionInfo.forEach((info, _tag) => {
        if (!info.duplicate) {
          //const baseName = tag.replace(/ [0-9]+$/, "");
          const chords = info.signature.split("~");
          for (let i = 0; i < chords.length; ++i) processChord(chords[i], i === 0, i === chords.length - 1);
        }
      });
    else {
      const chords: (string | ChordProChordBase)[] = [];
      this.chordPro.forAllChords((chord) => {
        chords.push(chord);
      });
      for (let i = 0; i < chords.length; ++i) processChord(chords[i], i === 0, i === chords.length - 1);
    }

    let keys = this.system.findKeysWithChords(firstChords.keys());
    if (keys.size > 0) keys = this.system.findKeysWithChords(lastChords.keys(), keys);

    const hist = Array.from(chordHist.entries());
    hist.sort((a, b) => b[1] - a[1]);
    for (const h of hist) {
      if (keys.size === 0) break;
      const filtered = this.system.findKeysWithChords([h[0]], keys);
      if (filtered.size === 0) break;
      keys = filtered;
    }

    const scores: { key: Key; score: number }[] = [];
    for (const key of keys) {
      let score = 0;
      if (key.scaleType === Mode.ionian || key.scaleType === Mode.aeolian) score += 1.5;
      firstChords.forEach((count, chord) => {
        if (this.system.compareChords(chord, key.baseChord, true)) score += 3 * count;
      });
      lastChords.forEach((count, chord) => {
        if (this.system.compareChords(chord, key.baseChord, true)) score += 2 * count;
      });
      scores.push({ key, score });
    }

    scores.sort((a, b) => {
      let diff = b.score - a.score;
      if (!diff) diff = diff = Math.abs(a.key.signature) - Math.abs(b.key.signature);
      return diff ? diff : a.key.name.localeCompare(b.key.name);
    });
    return scores.length > 0 ? scores[0].key.name : "";
  }

  playChord(box: ChordBoxHitBox) {
    const info = this.system.identifyChord(box.chord);
    if (info) {
      let notes = box.notes;
      let type: Instrument = "";
      if (box instanceof PianoChordHitBox) {
        if (notes === null) {
          const noteSet = new Set<number>();
          const rv = this.getActualChordLayout(box.chord);
          this.genPianoChordNotes(info, noteSet, rv?.variantIndex);
          notes = [];
          const tmpNotes = notes;
          noteSet.forEach((key) => tmpNotes.push(key));
        }
        type = "PIANO";
      } else if (box instanceof GuitarChordHitBox) {
        if (notes === null) {
          const noteSet = new Set<number>();
          const rv = this.getActualChordLayout(box.chord);
          if (rv && this.chordSelector) {
            const layout = rv.layouts[rv.variantIndex];
            const tuning = this.chordSelector.tuning;
            const capo = this.getCapo();
            for (let string = 0; string < tuning.length; ++string) {
              const pos = layout[string];
              if (pos !== null) noteSet.add(tuning[string] + capo + pos);
            }
          }
          notes = [];
          const tmpNotes = notes;
          noteSet.forEach((key) => tmpNotes.push(key));
        }
        type = "GUITAR";
      }
      if (notes !== null && notes.length > 0) {
        box.notes = notes;
        playChord(type, notes);
      }
    }
  }

  chordBoxDrawHelper(
    type: ChordBoxType,
    chord: string | ChordDetails,
    canvas: HTMLCanvasElement,
    forcedVariantIndex?: number,
    rect?: Rectangle,
    noteHitBoxes?: NoteHitBox[]
  ) {
    return this.chordBoxDraw(type, chord, canvas, forcedVariantIndex, rect, noteHitBoxes);
  }

  chordSelectorClosed(chord?: string) {
    if (chord) {
      if (this.multiChordChangeEnabled && this.actionTarget instanceof ChordTemplateHitBox) {
        const box = this.actionTarget;
        if (!this.system.compareChords(box.chord, chord)) {
          this.saveState();
          if (this.chordPro) this.chordPro.forAllChords((ch) => (this.system.compareChords(box.chord, ch) ? chord : ch));
        }
      } else if (this.actionTarget instanceof ChordProChord && !this.system.compareChords(this.actionTarget.text, chord)) {
        this.saveState();
        this.actionTarget.text = chord;
        this.actionTarget.line.genText();
      }
    }
    this.clearActionState();
    this.draw();
  }

  get hasMarks() {
    if (this.chordPro)
      for (const line of this.chordPro.lines) {
        if (line.marked) return true;
        for (const chord of line.chords) if (chord.marked) return true;
      }
    return false;
  }

  clearAllMarks() {
    if (this.chordPro)
      for (const line of this.chordPro.lines) {
        line.marked = 0;
        for (const chord of line.chords) chord.marked = 0;
      }
  }

  get chordProCode() {
    if (!this.chordPro) return "";
    let text = this.chordPro.generateDocument().trim();
    const marks = this.marks;
    if (marks) text += "\n# notes: " + marks;
    return text;
  }

  marking(enabled: boolean = true) {
    // No repaint: marking mode only decides whether a click TOGGLES a mark. The
    // wavy underlines themselves render from each line's/chord's `marked` flag
    // on both backends, so entering or leaving the mode changes nothing visible.
    this.currentlyMarked = enabled ? new Set() : undefined;
  }

  get marks() {
    const marks: string[] = [];
    if (this.chordPro)
      for (let i = 0; i < this.chordPro.lines.length; ++i) {
        const line = this.chordPro.lines[i];
        if (line.marked) marks.push(`M${i}`);
        for (let c = 0; c < line.chords.length; ++c) {
          if (line.chords[c].marked) marks.push(`M${i}/${c}`);
        }
      }
    return marks.length > 0 ? marks.join(" ") : "";
  }

  get inMarkingState() {
    return this.currentlyMarked !== undefined;
  }

  public hasChordSelectorOpen(): boolean {
    return !!this.chordSelector?.inModal;
  }

  getUnknownChords() {
    const list = new Set<string>();
    if (this.chordPro)
      this.chordPro.forAllChords((ch) => {
        ch = ch instanceof ChordProChordBase ? ch : new ChordProChordBase(this.system, ch);
        if (!ch.chordInfo) list.add(ch.chord);
      });
    const rv: string[] = [];
    list.forEach((key) => rv.push(key));
    return rv;
  }

  private findSection(_sectionName: string) {
    return null;
  }

  private createInstructionsRendererInput(
    pane: "source" | "preview",
    instructions: Instructions | null,
    revision: number
  ): DomSongRendererInput | null {
    if (!this.chordPro) return null;
    const instructionsMode: InstructionsRenderMode = pane === "preview" ? "FULL" : "";
    const sequence = projectDisplaySequence({
      document: this.chordPro,
      readOnly: true,
      instructionsMode,
      instructions: pane === "preview" ? instructions : null,
    });
    return {
      document: this.chordPro,
      system: this.system,
      display: this.displayProps,
      directives: this.directiveStyles,
      chordFormat: this.chordFormat,
      showTitle: this.showTitle,
      showMeta: this.showMeta,
      showTags: this.showTag,
      abbreviateTags: this.abbrevTag,
      readOnly: true,
      differential: false,
      instructionsMode,
      instructionsPane: pane,
      widthPolicy: "FIT_WIDTH",
      sequence,
      isDark: this.isDark,
      highlight: null,
      highlightOpacity: this.highlightOpacity,
      diagrams: null,
      keyIsAuto: this.keyIsAuto,
      localize: (key) => this.localize(key),
      overlayRevMoveCost: Settings.current.chordRevMoveCost,
      overlayFwdMoveCost: Settings.current.chordFwdMoveCost,
      moveChordsOnly: Settings.current.moveChordsOnly,
      documentRevision: this.documentRevision,
      displayRevision: this.displayRevision + revision,
      styleRevision: this.styleRevision,
    };
  }

  private buildInstructions(instructionsEditor: HTMLElement, onChange?: (current: Instructions) => void) {
    instructionsEditor.replaceChildren();

    if (!this.chordPro) return;

    if (!this.instructions) {
      const default_instructions = this.getInstructions("DEFAULT");
      this.instructions = new Instructions();
      this.applyInstructions(default_instructions);
    }
    const instructions = this.instructions;

    const normalizeExistingItemsKeeping = (protectedItem?: InstructionItem) => {
      const itemKey = (x: InstructionItem) => (x.info ? x.info.withoutModifiers() : x.value);
      if (!protectedItem) {
        instructions.normalize();
        return;
      }
      for (let i = 0; i < instructions.items.length; ++i) {
        const current = instructions.items[i];
        if (current.multiplier == null || current === protectedItem) continue;
        const key = itemKey(current);
        const transpose = current.transpose ?? 0;
        while (i + 1 < instructions.items.length) {
          const next = instructions.items[i + 1];
          if (next === protectedItem || next.multiplier == null) break;
          if (itemKey(next) !== key || (next.transpose ?? 0) !== transpose) break;
          current.multiplier += next.multiplier ?? 0;
          instructions.items.splice(i + 1, 1);
        }
      }
    };

    const getDivIndex = (div: HTMLElement) => {
      return parseInt(
        div.id.replace(/^.*-([0-9]+)$/g, (_, s) => s),
        10
      );
    };

    const addInsertDiv = (eventhandler: (e: MouseEvent) => void) => {
      const insert = createDivElement({ className: "instructions-insert", parent: instructionsEditor });
      const insert_button = createDivElement({ parent: insert });
      insert_button.innerText = "+";
      insert_button.onclick = eventhandler;
    };

    const createDiv = (item: InstructionItem) => {
      const itemIndex = instructions.items.indexOf(item);

      addInsertDiv((e) => addItem(e, false));

      const div = createDivElement({ className: "instructions-line", parent: instructionsEditor });
      div.id = instructionsEditor.id + ".ppi-" + itemIndex;

      const content = createDivElement({ className: "instructions-content", parent: div });
      content.id = instructionsEditor.id + ".ppc-" + itemIndex;
      content.innerText =
        item.value +
        ((item.multiplier ?? 0) > 1 ? " " + item.multiplier + "x" : "") +
        (item.transpose ? " " + (item.transpose > 0 ? "#" : "b") + Math.abs(item.transpose) : "");
      content.contentEditable = item.multiplier == null ? "true" : "false";
      content.tabIndex = itemIndex;

      const addItem = (e: MouseEvent, after: boolean, newItem: InstructionItem = { value: "" }) => {
        e.stopPropagation();
        e.preventDefault();
        const index = after ? instructions.insertAfter(newItem, item) : instructions.insertBefore(newItem, item);
        this.buildInstructions(instructionsEditor, onChange);
        const nc = instructionsEditor.querySelector(`[id='${instructionsEditor.id}.ppc-${index}']`) as HTMLElement;
        if (nc) nc.focus();
      };

      const deleteItem = (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        instructions.deleteItem(item);
        this.buildInstructions(instructionsEditor, onChange);
      };

      if (item.multiplier != null) {
        div.classList.add("instructions-section");

        const plus = createDivElement({ className: "plus", classList: ["button"], innerText: "+", parent: div });
        plus.onclick = (e) => {
          ++item.multiplier!;
          e.stopPropagation();
          e.preventDefault();
          this.buildInstructions(instructionsEditor, onChange);
        };

        const raise = createDivElement({ className: "raise", classList: ["button"], innerText: "♯", parent: div });
        raise.onclick = (e) => {
          e.stopPropagation();
          e.preventDefault();
          item.transpose = clampTranspose((item.transpose ?? 0) + 1);
          this.buildInstructions(instructionsEditor, onChange);
        };

        const lower = createDivElement({ className: "lower", classList: ["button"], innerText: "♭", parent: div });
        lower.onclick = (e) => {
          e.stopPropagation();
          e.preventDefault();
          item.transpose = clampTranspose((item.transpose ?? 0) - 1);
          this.buildInstructions(instructionsEditor, onChange);
        };

        if (item.multiplier > 1) {
          const expand = createDivElement({ className: "expand", classList: ["button"], innerText: "▶", parent: div });
          expand.onclick = (e) => {
            let count = item.multiplier ?? 0;
            while (count-- > 1) instructions.insertAfter({ ...item, multiplier: 1 }, item, false);
            item.multiplier = 1;
            e.stopPropagation();
            e.preventDefault();
            this.buildInstructions(instructionsEditor, onChange);
          };
        }
      }

      const minus = createDivElement({ className: "minus", classList: ["button"], innerText: item.multiplier != null ? "-" : "🗑", parent: div });
      if (item.multiplier == null) minus.style.background = "transparent";
      minus.onclick = (e) => {
        if ((item.multiplier ?? 0) <= 1) deleteItem(e);
        else {
          --item.multiplier!;
          e.stopPropagation();
          e.preventDefault();
          this.buildInstructions(instructionsEditor, onChange);
        }
      };

      content.onclick = (e) => {
        e.stopPropagation();
        if (item.multiplier == null) content.focus();
      };
      content.addEventListener("keydown", (e) => {
        e.stopPropagation();
        switch (getKeyCodeString(e)) {
          case "ENTER":
            e.preventDefault();
            if (item.multiplier == null) {
              item.value = content.innerText;
              this.buildInstructions(instructionsEditor, onChange);
            }
            break;
          case "ESCAPE":
            if (!content.innerText.trim()) {
              instructions.deleteItem(item);
              this.buildInstructions(instructionsEditor, onChange);
            }
            break;
        }
      });
      div.draggable = true;
      div.ondragstart = (e) => {
        if (e.dataTransfer) {
          e.dataTransfer.setData("text", JSON.stringify({ elementId: div.id }));
          e.dataTransfer.effectAllowed = "move";
        }
      };
      div.ondrop = (e) => {
        e.stopPropagation();
        e.preventDefault();
        let dndItem: { elementId?: string; tagName?: string };
        try {
          dndItem = JSON.parse(e.dataTransfer?.getData("text") ?? "");
        } catch {
          return;
        }
        if (dndItem.elementId) {
          const divToMove = instructionsEditor.querySelector(`[id='${dndItem.elementId}']`) as HTMLElement;
          if (divToMove && divToMove !== div) {
            const mi = getDivIndex(divToMove);
            const ti = getDivIndex(div);
            const i = instructions.items[mi];
            if (mi > ti) {
              instructions.items.splice(mi, 1);
              instructions.items.splice(ti, 0, i);
            } else if (div.nextSibling) {
              instructions.items.splice(ti + 1, 0, i);
              instructions.items.splice(mi, 1);
            } else {
              instructions.items.splice(mi, 1);
              instructions.items.push(i);
            }
            instructions.normalize();
            this.buildInstructions(instructionsEditor, onChange);
          }
        } else if (dndItem.tagName) {
          const inserted = this.chordPro
            ? Instructions.createSectionItem(this.chordPro, dndItem.tagName)
            : ({ value: dndItem.tagName, multiplier: 1 } as InstructionItem);
          instructions.insertBefore(inserted, item, false);
          normalizeExistingItemsKeeping(inserted);
          this.buildInstructions(instructionsEditor, onChange);
        }
      };

      div.ondragover = (event) => {
        event.stopPropagation();
        event.preventDefault();
      };
    };

    instructionsEditor.ondrop = (e) => {
      e.preventDefault();
      let dndItem: { elementId?: string; tagName?: string };
      try {
        dndItem = JSON.parse(e.dataTransfer?.getData("text") ?? "");
      } catch {
        return;
      }
      if (dndItem.elementId) {
        const divToMove = instructionsEditor.querySelector(`[id='${dndItem.elementId}']`) as HTMLElement;
        if (divToMove) {
          const mi = getDivIndex(divToMove);
          const i = instructions.items.splice(mi, 1);
          instructions.items.push(...i);
          instructions.normalize();
          this.buildInstructions(instructionsEditor, onChange);
        }
      } else if (dndItem.tagName) {
        const inserted = this.chordPro ? Instructions.createSectionItem(this.chordPro, dndItem.tagName) : { value: dndItem.tagName, multiplier: 1 };
        instructions.add(inserted, false);
        normalizeExistingItemsKeeping(inserted);
        this.buildInstructions(instructionsEditor, onChange);
      }
    };
    instructionsEditor.ondragover = (event) => {
      event.stopPropagation();
      event.preventDefault();
    };

    for (const item of instructions.items) createDiv(item);
    addInsertDiv((e) => {
      e.stopPropagation();
      e.preventDefault();
      instructions.add({ value: "" });
      this.buildInstructions(instructionsEditor, onChange);
      const nc = instructionsEditor.querySelector(`[id='${instructionsEditor.id}.ppc-${instructions.items.length - 1}']`) as HTMLElement;
      if (nc) nc.focus();
    });

    if (onChange) onChange(instructions);
  }

  private lockInstructionsInteractions(root: HTMLElement, delayMs = 350) {
    if (this.instructionsInteractionUnlockTimer != null) {
      window.clearTimeout(this.instructionsInteractionUnlockTimer);
      this.instructionsInteractionUnlockTimer = null;
    }
    const unlockAt = Date.now() + delayMs;
    this.instructionsInteractionUnlockAt = unlockAt;
    root.style.pointerEvents = "none";
    this.instructionsInteractionUnlockTimer = window.setTimeout(() => {
      if (this.instructionsInteractionUnlockAt === unlockAt) root.style.pointerEvents = "";
      this.instructionsInteractionUnlockTimer = null;
    }, delayMs);
  }

  /**
   * Replaces the browser's default drag image (the single grabbed line) with the
   * WHOLE section being dragged.
   *
   * A drag only ever carries `{ tagName }` — dropping it inserts the entire
   * section, never the one line under the cursor — so a one-line ghost tells the
   * user the wrong thing about what they are about to drop.
   *
   * A section is the run of CONSECUTIVE occurrences sharing its name, matching
   * how collapse groups them; a repeated section drags the instance grabbed, not
   * every occurrence of that name.
   */
  private setSectionDragImage(event: DragEvent, node: HTMLElement) {
    const occurrence = node.closest<HTMLElement>("[data-instructions-section]");
    const body = occurrence?.parentElement;
    const section = occurrence?.dataset.instructionsSection;
    if (!occurrence || !body || !section || typeof event.dataTransfer?.setDragImage !== "function") return;

    const siblings = Array.from(body.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    const index = siblings.indexOf(occurrence);
    if (index < 0) return;
    let first = index;
    let last = index;
    while (first > 0 && siblings[first - 1].dataset.instructionsSection === section) first -= 1;
    while (last < siblings.length - 1 && siblings[last + 1].dataset.instructionsSection === section) last += 1;
    const members = siblings.slice(first, last + 1);

    // Cloned shallowly from the body so the ghost keeps the tag-lane/gap custom
    // properties its grid columns resolve against; a bare wrapper would collapse
    // the tag column to zero.
    const ghost = body.cloneNode(false) as HTMLElement;
    ghost.style.margin = "0";
    ghost.style.width = `${body.clientWidth}px`;
    ghost.style.position = "fixed";
    ghost.style.top = "0";
    ghost.style.left = "-100000px";
    ghost.style.pointerEvents = "none";
    for (const member of members) ghost.appendChild(member.cloneNode(true));
    (this.parent_div.ownerDocument.body ?? this.parent_div).appendChild(ghost);

    const origin = members[0].getBoundingClientRect();
    event.dataTransfer.setDragImage(ghost, event.clientX - origin.left, event.clientY - origin.top);
    // The image is snapshotted from the live element, so it can only be removed
    // once this event has been dispatched.
    setTimeout(() => ghost.remove(), 0);
  }

  editInstructions(instructions: string, instructionsEditor: HTMLElement, onUpdate?: () => void, songDiv?: HTMLElement, previewDiv?: HTMLElement) {
    this.instructionsCoordinatorCleanup?.();
    this.instructionsPaneCleanup?.();
    this.instructionEditorActive = true;
    this.syncPrimarySurfaceVisibility();
    this.applyInstructions(instructions, false);

    let cleaned = false;
    let previewRevision = 0;
    let currentPreviewInstructions: Instructions | null = null;
    let sourceRenderer: DomSongRenderer | null = null;
    let previewRenderer: DomSongRenderer | null = null;
    const paneListenerCleanups: Array<() => void> = [];

    const adapterNode = (target: EventTarget | null, host: HTMLElement, dataKey: string) => {
      let node = target as HTMLElement | null;
      while (node) {
        if (node.dataset?.[dataKey]) return node;
        if (node === host) break;
        node = node.parentElement;
      }
      return null;
    };
    const bindPaneInteractions = (host: HTMLElement, renderer: DomSongRenderer) => {
      const click = (event: MouseEvent) => {
        const node = adapterNode(event.target, host, "instructionsCollapseId");
        const occurrenceId = node?.dataset.instructionsCollapseId;
        if (occurrenceId) renderer.toggleInstructionSection(occurrenceId);
      };
      const dragstart = (event: DragEvent) => {
        const node = adapterNode(event.target, host, "instructionsDragTag");
        const tagName = node?.dataset.instructionsDragTag;
        if (!tagName || !event.dataTransfer) return;
        event.dataTransfer.setData("text", JSON.stringify({ tagName }));
        event.dataTransfer.effectAllowed = "copy";
        this.setSectionDragImage(event, node);
      };
      host.addEventListener("click", click);
      host.addEventListener("dragstart", dragstart);
      paneListenerCleanups.push(() => {
        host.removeEventListener("click", click);
        host.removeEventListener("dragstart", dragstart);
      });
    };

    if (songDiv) {
      const input = this.createInstructionsRendererInput("source", null, 0);
      if (input) {
        sourceRenderer = new DomSongRenderer(songDiv as HTMLDivElement, input);
        bindPaneInteractions(songDiv, sourceRenderer);
      }
    }
    this.buildInstructions(instructionsEditor, (updated: Instructions) => {
      currentPreviewInstructions = updated;
      const input = this.createInstructionsRendererInput("preview", updated, ++previewRevision);
      if (previewDiv && input) {
        if (previewRenderer) previewRenderer.update(input, "structure");
        else {
          previewRenderer = new DomSongRenderer(previewDiv as HTMLDivElement, input);
          bindPaneInteractions(previewDiv, previewRenderer);
        }
      }
      onUpdate?.();
    });

    this.instructionsThemeUpdater = () => {
      const sourceInput = this.createInstructionsRendererInput("source", null, 0);
      if (sourceRenderer && sourceInput) sourceRenderer.updateTheme(sourceInput);
      const previewInput = this.createInstructionsRendererInput("preview", currentPreviewInstructions, previewRevision);
      if (previewRenderer && previewInput) previewRenderer.updateTheme(previewInput);
    };

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this.instructionEditorActive = false;
      for (const remove of paneListenerCleanups.splice(0)) remove();
      sourceRenderer?.dispose();
      previewRenderer?.dispose();
      sourceRenderer = null;
      previewRenderer = null;
      instructionsEditor.ondrop = null;
      instructionsEditor.ondragover = null;
      instructionsEditor.replaceChildren();
      if (this.instructionsThemeUpdater) this.instructionsThemeUpdater = null;
      if (this.instructionsPaneCleanup === cleanup) this.instructionsPaneCleanup = null;
      this.syncPrimarySurfaceVisibility();
    };
    this.instructionsPaneCleanup = cleanup;
    return cleanup;
  }

  applyInstructions(instructions: string, draw = true) {
    if (this.chordPro) {
      if (instructions) {
        if (!this.instructions) this.instructions = new Instructions();
        this.instructions.parse(instructions, this.chordPro);
      } else this.instructions = undefined;
      this.invalidateDisplaySequence();
      if (draw) this.draw();
    }
  }

  getInstructions(mode: "PRESET" | "DEFAULT" | "CURRENT" | "SETTING") {
    if (!this.chordPro) return "";
    const doc = this.chordPro;

    const genDefault = () => doc.getDefaultInstructions();

    switch (mode) {
      case "PRESET":
        return this.instructions?.format() ?? "";
      case "DEFAULT":
        return genDefault();
      case "SETTING":
        if (this.instructions) {
          const current = this.instructions.format();
          // Compare semantically by round-tripping the defaults through the
          // same parse+normalize+format pipeline. This collapses adjacent
          // same-section blocks (e.g. "Chorus\nChorus") into the canonical
          // "Chorus 2x" form, so an unchanged editor still saves as "".
          const dflt = new Instructions();
          dflt.parse(genDefault(), doc);
          return dflt.format() === current ? "" : current;
        }
        return "";
      default:
        return this.instructions?.format() || genDefault();
    }
  }

  setupInstructionsEditor(panes: HTMLElement, instructions: string, displayUpdateCallback?: () => void) {
    this.instructionsCoordinatorCleanup?.();
    this.instructionsPaneCleanup?.();
    const leftSeparator = panes.querySelector("#ies-left") as HTMLElement;
    const rightSeparator = panes.querySelector("#ies-right") as HTMLElement;
    const colSong = panes.querySelector("#ies-song") as HTMLElement;
    const colList = panes.querySelector("#ies-list") as HTMLElement;
    const colPreview = panes.querySelector("#ies-preview") as HTMLElement;

    if (leftSeparator == null || rightSeparator == null || colSong == null || colList == null || colPreview == null) return;

    const third = 100 / 3;
    colSong.style.width = third + "%";
    colList.style.width = third + "%";
    colPreview.style.width = third + "%";

    let draggedSeparator = leftSeparator;
    let startX = 0;
    let startWidth = 0;
    const doc = panes.ownerDocument;

    const mousemove = (e: MouseEvent) => {
      const diff = e.clientX - startX;
      const total = panes.offsetWidth;
      if (total <= 0) return;
      if (draggedSeparator === leftSeparator) {
        const two = colSong.offsetWidth + colList.offsetWidth;
        if (two <= 0) return;
        const div = (100 * two) / total;
        const req = startWidth + diff;
        const left = div * (req / two);
        colSong.style.width = left + "%";
        colList.style.width = div - left + "%";
      } else {
        const two = colPreview.offsetWidth + colList.offsetWidth;
        if (two <= 0) return;
        const div = (100 * two) / total;
        const req = startWidth + diff;
        const left = div * (req / two);
        colList.style.width = left + "%";
        colPreview.style.width = div - left + "%";
      }
    };

    const mouseup = () => {
      doc.removeEventListener("mousemove", mousemove);
      doc.removeEventListener("mouseup", mouseup);
    };

    const leftMousedown = (e: MouseEvent) => {
      e.preventDefault();
      draggedSeparator = leftSeparator;
      startX = e.clientX;
      startWidth = colSong.offsetWidth;
      doc.addEventListener("mousemove", mousemove);
      doc.addEventListener("mouseup", mouseup);
    };

    const rightMousedown = (e: MouseEvent) => {
      e.preventDefault();
      draggedSeparator = rightSeparator;
      startX = e.clientX;
      startWidth = colList.offsetWidth;
      doc.addEventListener("mousemove", mousemove);
      doc.addEventListener("mouseup", mouseup);
    };

    leftSeparator.addEventListener("mousedown", leftMousedown);
    rightSeparator.addEventListener("mousedown", rightMousedown);

    const paneCleanup = this.editInstructions(instructions, colList, displayUpdateCallback, colSong, colPreview);
    this.lockInstructionsInteractions(panes);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      mouseup();
      leftSeparator.removeEventListener("mousedown", leftMousedown);
      rightSeparator.removeEventListener("mousedown", rightMousedown);
      paneCleanup();
      if (this.instructionsInteractionUnlockTimer != null) {
        window.clearTimeout(this.instructionsInteractionUnlockTimer);
        this.instructionsInteractionUnlockTimer = null;
      }
      panes.style.pointerEvents = "";
      if (this.instructionsCoordinatorCleanup === cleanup) this.instructionsCoordinatorCleanup = null;
    };
    this.instructionsCoordinatorCleanup = cleanup;
    return cleanup;
  }

  /**
   * Resolved display sequence for the current mode. `projectDisplaySequence` is
   * the single owner of the raw-versus-instructed decision, shared with the DOM
   * display plan so the two backends cannot drift. Cached because the projection
   * clones lines; every site that invalidates `displaySequence` must also clear
   * `displayLines`.
   */
  private getDisplaySequence(): DisplaySequence | null {
    if (!this.chordPro) return null;
    if (!this.displaySequence)
      this.displaySequence = projectDisplaySequence({
        document: this.chordPro,
        readOnly: this.readOnly,
        instructionsMode: this.instructionsRenderMode,
        instructions: this.instructions ?? null,
      });
    return this.displaySequence;
  }

  private getDisplayLines(): ChordProLine[] | null {
    const sequence = this.getDisplaySequence();
    if (!sequence) return null;
    if (!this.displayLines) {
      this.displayLines = sequence.lines.map((entry) => entry.line);
      this.instructedSectionGroups = sequence.groups;
      this.instructedSectionLabels = sequence.labels;
    }
    return this.displayLines;
  }
}
