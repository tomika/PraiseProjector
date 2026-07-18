import "./chordpro-dom.css";

import type { TuneObject } from "abcjs";
import { isAbcjsLoaded, loadAbcjs } from "../abcjs-lazy";
import { ChordProAbc, type ChordProChord, type ChordProDocument, type ChordProLine, type ChordSystem } from "../chordpro_base";
import type { ChordProDirectiveStyles, ChordProDisplayProperties } from "../chordpro_styles";
import { safeMetaAlignment } from "../layout/meta-alignment";
import { layoutSong, type LayoutLyricRun, type SongLayoutResult, type SongWidthPolicy } from "../layout/song-layout";
import type { ChordVisualModel } from "./chord-visual";
import { createChordNode, createDifferentialTextNode, createLyricRunNode, createTagNode } from "./dom-nodes";
import {
  buildDisplayPlan,
  DisplayIdentityRegistry,
  type DisplayHighlight,
  type DisplayInstructionsMode,
  type DisplayMeta,
  type DisplayPlan,
  type DisplaySequence,
  type InstructionsPane,
} from "./display-plan";
import {
  buildGeometryIndex,
  computeHighlightDecoration,
  computeRowSelectionBands,
  computeSelectionSpans,
  resolveCaretGeometry,
  resolveChordTextBox,
  resolveTagTextBox,
  type EditingSelectionRange,
  type SelectionSpan,
  type SongGeometryIndex,
} from "./dom-interaction";
import { DomTextMeasurer } from "./dom-text-measurer";

export type InvalidationCategory = "structure" | "metrics" | "layout" | "decoration" | "interaction";

export interface DiagramPlacement {
  readonly chord: string;
  readonly x: number;
  readonly y: number;
}

export interface DiagramLayoutResult {
  readonly placements: readonly DiagramPlacement[];
  /** Composite extents including the diagram region. */
  readonly width: number;
  readonly height: number;
}

export interface DiagramLayoutOptions {
  readonly horizontalMargin: number;
  readonly verticalMargin: number;
}

/**
 * Chord-diagram placement policy.
 *
 * After unrenderable chords are filtered out by `canRender`, a resolved target
 * ratio WIDER than the song ratio places fixed-size diagrams to the RIGHT in
 * top-to-bottom columns; otherwise they go BELOW in left-to-right rows.
 *
 * The `width + verticalMargin` term in the side branch (a vertical margin added
 * to a width) is a long-standing quirk, preserved deliberately.
 */
export function placeChordDiagrams(
  chords: readonly string[],
  songSize: { readonly width: number; readonly height: number },
  chordSize: { readonly width: number; readonly height: number },
  targetRatio: number,
  options: DiagramLayoutOptions,
  canRender: (chord: string) => boolean
): DiagramLayoutResult {
  const chordGap = 4;
  const chordStepX = chordSize.width + chordGap;
  const chordStepY = chordSize.height + chordGap;
  const placements: DiagramPlacement[] = [];

  if (targetRatio > songSize.width / songSize.height) {
    let x = songSize.width + options.horizontalMargin;
    let y = options.verticalMargin;
    let width = songSize.width;
    for (const chord of chords) {
      if (!canRender(chord)) continue;
      placements.push({ chord, x, y });
      width = x + chordSize.width + options.horizontalMargin;
      y += chordStepY;
      if (y + chordSize.height > songSize.height) {
        y = options.verticalMargin;
        x += chordStepX;
      }
    }
    return { placements, width: width + options.verticalMargin, height: songSize.height };
  }

  let x = options.horizontalMargin;
  let y = songSize.height + options.verticalMargin;
  let height = songSize.height;
  for (const chord of chords) {
    if (!canRender(chord)) continue;
    placements.push({ chord, x, y });
    height = y + chordSize.height;
    x += chordStepX;
    if (x + chordSize.width > songSize.width) {
      x = options.horizontalMargin;
      y += chordStepY;
    }
  }
  return { placements, width: songSize.width, height: height + options.verticalMargin };
}

export interface LayoutSnapshot {
  readonly width: number;
  readonly height: number;
  readonly revision: number;
  readonly settled: boolean;
}

export type LayoutListener = (snapshot: LayoutSnapshot) => void;

export class LayoutDisposedError extends Error {
  constructor() {
    super("Layout owner was disposed before the requested layout settled");
    this.name = "LayoutDisposedError";
  }
}

type LayoutWaiter = {
  readonly afterRevision?: number;
  readonly capturedRevision: number;
  readonly resolve: (snapshot: LayoutSnapshot) => void;
  readonly reject: (error: Error) => void;
};

/** Backend-neutral snapshot/subscription/settlement state machine. */
export class LayoutSnapshotCoordinator {
  private snapshot: LayoutSnapshot = { width: 0, height: 0, revision: 0, settled: false };
  private readonly listeners = new Set<LayoutListener>();
  private readonly waiters = new Set<LayoutWaiter>();
  private disposed = false;
  private notificationQueued = false;

  getSnapshot() {
    return this.snapshot;
  }

  markPending() {
    if (this.snapshot.settled) this.snapshot = { ...this.snapshot, settled: false };
  }

  commit(width: number, height: number, settled: boolean) {
    if (this.disposed) return this.snapshot;
    this.snapshot = {
      width,
      height,
      revision: this.snapshot.revision + 1,
      settled,
    };
    this.queueNotification();
    if (settled) this.resolveWaiters();
    return this.snapshot;
  }

  subscribe(listener: LayoutListener) {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  whenSettled(afterRevision?: number) {
    if (this.disposed) return Promise.reject(new LayoutDisposedError());
    if (this.matches(this.snapshot, afterRevision, this.snapshot.revision)) return Promise.resolve(this.snapshot);
    const capturedRevision = this.snapshot.revision;
    return new Promise<LayoutSnapshot>((resolve, reject) => {
      this.waiters.add({ afterRevision, capturedRevision, resolve, reject });
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const error = new LayoutDisposedError();
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
    this.listeners.clear();
  }

  private matches(snapshot: LayoutSnapshot, afterRevision: number | undefined, capturedRevision: number) {
    if (!snapshot.settled) return false;
    return afterRevision === undefined ? snapshot.revision >= capturedRevision : snapshot.revision > afterRevision;
  }

  private resolveWaiters() {
    for (const waiter of [...this.waiters]) {
      if (!this.matches(this.snapshot, waiter.afterRevision, waiter.capturedRevision)) continue;
      this.waiters.delete(waiter);
      waiter.resolve(this.snapshot);
    }
  }

  private queueNotification() {
    if (this.notificationQueued) return;
    this.notificationQueued = true;
    queueMicrotask(() => {
      this.notificationQueued = false;
      if (this.disposed) return;
      for (const listener of [...this.listeners]) listener(this.snapshot);
    });
  }
}

export interface SemanticRevisions {
  readonly documentRevision: number;
  readonly displayRevision: number;
  readonly styleRevision: number;
}

/**
 * Chord-diagram integration. The renderer owns the region, the placement policy
 * and the diagram elements' lifecycle; the controller keeps ownership of chord
 * identification and drawing, which depend on the chord selector/drawer.
 */
export interface DomDiagramInput {
  readonly chords: readonly string[];
  readonly size: { readonly width: number; readonly height: number };
  /** Changes when the selected fingering/voicing changes without altering layout. */
  readonly revision: number;
  /**
   * Resolved target ratio for the side/below diagram policy. A positive value is
   * used as-is. A non-positive value means "below" for a pane-fitted host (the
   * deliberate FIT_WIDTH/scroll signal), and "use the live host box" for a
   * natural-size host — see `buildDiagrams`.
   */
  readonly targetRatio: number;
  readonly canRender: (chord: string) => boolean;
  readonly draw: (chord: string, svg: SVGSVGElement) => void;
}

/**
 * Controller-owned editing state, resolved by line OBJECT identity.
 * Columns are UTF-16 offsets into the line's lyric text; the renderer
 * clamps display to valid visual boundaries via the layout's caret stops.
 */
export interface DomEditingCaret {
  readonly line: ChordProLine;
  readonly column: number;
}

/**
 * Raw-text caret/selection inside one chord or one section label.
 *
 * Offsets are the controller's UTF-16 offsets into the RAW text — `chord.text`
 * or the label.
 */
export interface DomEditingTextTarget {
  readonly caret: number | null;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
}

export interface DomEditingChordText extends DomEditingTextTarget {
  readonly chord: ChordProChord;
}

export interface DomEditingTagText extends DomEditingTextTarget {
  readonly line: ChordProLine;
}

/**
 * An in-flight chord/template drag. The ghost follows the pointer
 * and the marker points at the resolved drop column — the controller has
 * ALREADY applied the document move, so this is pure decoration.
 */
export interface DomEditingDrag {
  /** The dragged chord, hidden in the body while its ghost renders. */
  readonly chord: ChordProChord | null;
  /** Ghost label text (a template drag has no chord object yet). */
  readonly text: string;
  readonly left: number;
  readonly top: number;
  /** Root-local drop marker, or null when the pointer is over a no-drop area. */
  readonly marker: { readonly x: number; readonly y: number } | null;
  readonly noDrop: boolean;
}

export interface DomEditingInput {
  readonly caret: DomEditingCaret | null;
  /** Normalized to document order by the controller. */
  readonly selection: EditingSelectionRange | null;
  /** Raw-text editing inside a chord. */
  readonly chordText?: DomEditingChordText | null;
  /** Raw-text editing inside a section label. */
  readonly tagText?: DomEditingTagText | null;
  /** Chord/template drag decoration. */
  readonly drag?: DomEditingDrag | null;
}

/**
 * Chord-template strip integration.
 *
 * The strip is a normal-flow `.chp-dom-chord-strip` section built from the
 * safe chord token model; the controller keeps ownership of the
 * drag/double-click gestures through this port, since they mutate the document.
 */
export interface DomChordStripInput {
  readonly chords: readonly string[];
  /** Safe token model for one template, resolved by the controller's chord drawer. */
  readonly visual: (chord: string) => ChordVisualModel;
  /** Vertical gap between templates, resolved from the root font size by the controller. */
  readonly gap: number;
  /** Controller gesture hooks. The renderer owns the nodes; the controller owns the actions. */
  readonly onPointerDown?: (chord: string, event: MouseEvent) => void;
  readonly onDoubleClick?: (chord: string, event: MouseEvent) => void;
}

/**
 * Metadata-input integration. The controller owns
 * the input elements and their listeners (focus, undo/action-target and tab
 * navigation live there); the renderer owns the normal-flow meta rows and
 * re-mounts the SAME controller elements across commits so focus and IME
 * composition survive a full keyed reconcile.
 */
export interface DomMetaInputHost {
  /** Mounts (or re-mounts by identity) the input row for `meta` into `container`. */
  mount(meta: DisplayMeta, container: HTMLElement): void;
  /** Recomputes input overflow after the renderer has committed row geometry. */
  relayout?(name: string): void;
  /** Drops controller rows whose meta name is no longer displayed. */
  prune(live: ReadonlySet<string>): void;
}

export interface DomSongRendererInput extends SemanticRevisions {
  readonly document: ChordProDocument;
  readonly system: ChordSystem;
  readonly display: ChordProDisplayProperties;
  readonly directives: ChordProDirectiveStyles;
  readonly chordFormat: number;
  readonly showTitle: boolean;
  readonly showMeta: boolean;
  readonly showTags: boolean;
  readonly abbreviateTags: boolean;
  readonly readOnly: boolean;
  readonly differential: boolean;
  readonly instructionsMode: DisplayInstructionsMode;
  readonly instructionsPane?: InstructionsPane;
  readonly widthPolicy: SongWidthPolicy;
  /**
   * The host scales the song to fit a pane (`ChordProEditor.fitsToPane`), so
   * metadata must be clipped to the song's width rather than inflate it. Off for
   * hosts that render at natural size, where a long title just overflows.
   */
  readonly clipMetaToSongWidth?: boolean;
  /** Full-editor policy: title uses the host viewport without widening the song body. */
  readonly viewportAlignedTitle?: boolean;
  /** Controller-cached projection, so the sequence is resolved exactly once. */
  readonly sequence?: DisplaySequence | null;
  readonly isDark: boolean;
  readonly highlight: DisplayHighlight | null;
  readonly highlightOpacity: number;
  readonly diagrams?: DomDiagramInput | null;
  /** Editing decorations; null/absent for readonly instances. */
  readonly editing?: DomEditingInput | null;
  /** Metadata-input host; null/absent outside editable instances. */
  readonly metaInputs?: DomMetaInputHost | null;
  /** Chord-template strip; null/absent when the strip is not shown. */
  readonly chordStrip?: DomChordStripInput | null;
  readonly keyIsAuto?: boolean;
  readonly localize?: (key: string) => string;
  readonly overlayRevMoveCost: number;
  readonly overlayFwdMoveCost: number;
  readonly moveChordsOnly?: boolean;
}

const ABC_SCALE = 2 / 3;

/**
 * The impure ABC geometry source, injected for the same reason measurement is:
 * abcjs needs a real DOM, so a directly imported chunk makes the
 * rendered ABC path unreachable from the test runner and leaves the pending path
 * racing a real dynamic import. The default port is the production one.
 */
export interface AbcRenderPort {
  isLoaded(): boolean;
  load(): Promise<unknown>;
  /**
   * Populates `node` through abcjs's container-based API and returns the tune
   * object abcjs produced FOR THAT NODE. Generated markup is never read back.
   *
   * The returned tune object is the MIDI playback animation's only correct
   * source: its timing callbacks mark the very SVG elements abcjs created here,
   * so a tune re-rendered into a throwaway container would highlight detached
   * elements and animate nothing visible.
   */
  render(node: HTMLElement, abc: ChordProAbc, options: NonNullable<Parameters<ChordProAbc["render"]>[1]>): TuneObject | undefined;
}

export const defaultAbcRenderPort: AbcRenderPort = {
  isLoaded: () => isAbcjsLoaded(),
  load: () => loadAbcjs(),
  render: (node, abc, options) => {
    const rendered = abc.render(node, options);
    return Array.isArray(rendered) && rendered.length > 0 ? (rendered[0] as TuneObject) : undefined;
  },
};

/**
 * The width abcjs committed onto its generated `<svg>`, as a CSS length for the
 * owning container.
 */
function abcIntrinsicWidth(node: HTMLElement) {
  // Duck-typed rather than `instanceof SVGSVGElement`: that global does not
  // exist off-browser, and this module must stay loadable in the test runner.
  const svg = node.querySelector?.("svg");
  if (!svg) return "";
  const attributeWidth = Number.parseFloat(svg.getAttribute("width") ?? "");
  if (Number.isFinite(attributeWidth) && attributeWidth > 0) return `${attributeWidth}px`;
  const baseWidth = (svg as SVGSVGElement).width?.baseVal?.value;
  return typeof baseWidth === "number" && baseWidth > 0 ? `${baseWidth}px` : "";
}

function revisionsKey(input: DomSongRendererInput) {
  return `${input.documentRevision}:${input.displayRevision}:${input.styleRevision}`;
}

/** A run of contiguous same-styled glyphs emitted as ONE `.chp-dom-run` span. */
export interface LyricRunGroup {
  text: string;
  x: number;
  y: number;
  width: number;
  change: LayoutLyricRun["change"];
  selected: boolean;
  sourceStart: number;
  sourceEnd: number;
  beforeStart?: number;
  beforeEnd?: number;
  afterStart?: number;
  afterEnd?: number;
}

/**
 * Coalesces the per-glyph `lyricRuns` into the fewest DOM spans that render
 * identically. `.chp-dom-run` disables kerning and ligatures, so glyphs laid out
 * at additive positions render the same whether they sit in one span or many;
 * the layout keeps its per-glyph runs (selection bands and caret stops still
 * consume them), only the DOM emission is grouped. This is the fix for the P10A
 * task-2 finding that the renderer emitted one permanent element per character.
 *
 * A group extends only while every attribute that reaches the DOM stays constant
 * AND the next glyph is contiguous. It breaks at: an LP gap (`x` discontinuity —
 * word spacing or vowel stretch), a source-column gap, a selection edge (so the
 * selected foreground colour still covers exactly the selected glyphs), a
 * diff-change transition, and any before/after coordinate-space change. Marking
 * and font/colour are per-line constants and never split a group.
 */
export function coalesceLyricRuns(
  runs: readonly LayoutLyricRun[],
  selection: { readonly start: number; readonly end: number } | null
): LyricRunGroup[] {
  const groups: LyricRunGroup[] = [];
  for (const run of runs) {
    const selected = !!selection && run.sourceStart < selection.end && run.sourceEnd > selection.start;
    const prev = groups[groups.length - 1];
    const mergeable =
      prev != null &&
      prev.change === run.change &&
      prev.selected === selected &&
      prev.sourceEnd === run.sourceStart &&
      Math.abs(prev.x + prev.width - run.x) < 0.5 &&
      (prev.beforeStart == null) === (run.beforeStart == null) &&
      (prev.beforeStart == null || prev.beforeEnd === run.beforeStart) &&
      (prev.afterStart == null) === (run.afterStart == null) &&
      (prev.afterStart == null || prev.afterEnd === run.afterStart);
    if (mergeable && prev) {
      prev.text += run.text;
      prev.width = run.x + run.width - prev.x;
      prev.sourceEnd = run.sourceEnd;
      if (run.beforeEnd != null) prev.beforeEnd = run.beforeEnd;
      if (run.afterEnd != null) prev.afterEnd = run.afterEnd;
    } else {
      groups.push({
        text: run.text,
        x: run.x,
        y: run.y,
        width: run.width,
        change: run.change,
        selected,
        sourceStart: run.sourceStart,
        sourceEnd: run.sourceEnd,
        beforeStart: run.beforeStart,
        beforeEnd: run.beforeEnd,
        afterStart: run.afterStart,
        afterEnd: run.afterEnd,
      });
    }
  }
  return groups;
}

/**
 * Decoration state is deliberately NOT part of any semantic revision: highlight
 * changes must not pretend the document, display options or styles changed. It
 * gets its own commit-key term instead, so a highlight-only change still
 * produces a visible commit.
 */
function decorationKey(input: DomSongRendererInput) {
  const highlight = input.highlight;
  const range = highlight
    ? `${highlight.from}:${highlight.to}:${highlight.section ?? ""}:${highlight.repeatIndex ?? ""}:${highlight.repeatTotal ?? ""}`
    : "none";
  return `${range}:${input.highlightOpacity}:${input.isDark ? "dark" : "light"}:${editingKey(input)}`;
}

/**
 * Caret/selection state is a decoration: it must produce a fresh visible
 * commit without pretending the document changed. The indices below are key
 * material only — resolution stays by object identity — and any
 * document replacement already changes the semantic key alongside this one.
 *
 * EVERY editing decoration must appear here. This key gates both `invalidate`
 * and the `commitKey` early-out, so a decoration missing from it cannot repaint
 * at all: the chord/tag raw-text caret never appeared, and a chord drag only
 * redrew on the frames where the drop happened to mutate the document — leaving
 * the ghost stranded whenever the pointer resolved no drop target.
 */
function editingKey(input: DomSongRendererInput) {
  const editing = input.editing;
  if (!editing) return "edit:none";
  const lineIndex = (line: ChordProLine) => input.document.lines.indexOf(line);
  const caret = editing.caret ? `${lineIndex(editing.caret.line)}.${editing.caret.column}` : "-";
  const selection = editing.selection
    ? `${lineIndex(editing.selection.startLine)}.${editing.selection.startColumn}-${lineIndex(editing.selection.endLine)}.${editing.selection.endColumn}`
    : "-";
  const range = (target: DomEditingTextTarget) => `${target.caret ?? "-"}.${target.selectionStart ?? "-"}.${target.selectionEnd ?? "-"}`;
  const chordText = editing.chordText
    ? `${lineIndex(editing.chordText.chord.line)}.${editing.chordText.chord.line.chords.indexOf(editing.chordText.chord)}.${range(editing.chordText)}`
    : "-";
  const tagText = editing.tagText ? `${lineIndex(editing.tagText.line)}.${range(editing.tagText)}` : "-";
  // The ghost tracks the pointer, so its position is the term that makes a drag
  // repaint every frame rather than only on drop-column changes.
  const drag = editing.drag
    ? `${editing.drag.text}.${editing.drag.left}.${editing.drag.top}.${
        editing.drag.marker ? `${editing.drag.marker.x}x${editing.drag.marker.y}` : "-"
      }.${editing.drag.noDrop ? 1 : 0}`
    : "-";
  return `edit:${caret}:${selection}:${chordText}:${tagText}:${drag}`;
}

/** Diagram geometry depends on the target ratio, which no semantic revision covers. */
function diagramKey(input: DomSongRendererInput) {
  const diagrams = input.diagrams;
  if (!diagrams) return "none";
  return `${diagrams.revision}:${diagrams.targetRatio}:${diagrams.size.width}x${diagrams.size.height}:${diagrams.chords.join(",")}`;
}

function collapseKey(collapsed: ReadonlySet<string>) {
  return [...collapsed].sort().join(",");
}

export class DomSongRenderer {
  private readonly doc: Document;
  private readonly root: HTMLDivElement;
  private readonly identities = new DisplayIdentityRegistry();
  private readonly measurer: DomTextMeasurer;
  private readonly snapshots = new LayoutSnapshotCoordinator();
  private readonly resizeObserver: ResizeObserver | null;
  private input: DomSongRendererInput;
  private scheduledFrame: number | null = null;
  private invalidationGeneration = 0;
  private lastViewportWidth = -1;
  private viewportTitleGeometry: { width: number; rootOffset: number } | null = null;
  private viewportTitleState: { margin: number; measuredWidth: number; requestedAlign: string; compositeWidth: number } | null = null;
  private lastCommitKey = "";
  private disposed = false;
  private geometry: SongGeometryIndex | null = null;
  /** Owned ABC containers, keyed by occurrence id. Never rebuilt from markup strings. */
  private readonly abcNodes = new Map<
    string,
    { node: HTMLDivElement; key: string; height: number; width: number; source: ChordProAbc; visual?: TuneObject }
  >();
  /** Owned diagram canvases, keyed by chord label. These are retained canvases. */
  private readonly diagramNodes = new Map<string, SVGSVGElement>();
  /**
   * Persistent commit sections. The meta root and the single caret survive
   * every keyed reconcile by identity, so a focused metadata input, an active
   * IME composition, and the caret's animation state are never destroyed by a
   * rebuild; only the strip/body/diagram sections are swapped.
   */
  private readonly metaRoot: HTMLDivElement;
  private readonly caretNode: HTMLDivElement;
  /**
   * Persistent overlay for editing decorations that are not row-scoped: the
   * chord/tag raw-text caret and selection, the drag ghost and the drop marker.
   * Like the caret it survives every reconcile, so a drag never loses its ghost
   * to a rebuild mid-gesture.
   */
  private readonly decorationRoot: HTMLDivElement;
  /** Keyed meta rows, by meta NAME — stable across document replacement. */
  private readonly metaRowNodes = new Map<string, HTMLDivElement>();
  private chordStripNode: HTMLDivElement | null = null;
  private bodyNode: HTMLDivElement | null = null;
  private diagramsNode: HTMLDivElement | null = null;
  /** Renderer-owned geometry revision, bumped ONCE when async ABC work completes. */
  private abcGeometryRevision = 0;
  private abcLoadState: "idle" | "loading" | "done" = "idle";
  private readonly collapsedInstructionStarts = new Set<string>();

  constructor(
    private readonly host: HTMLDivElement,
    input: DomSongRendererInput,
    private readonly abcPort: AbcRenderPort = defaultAbcRenderPort
  ) {
    this.doc = host.ownerDocument;
    this.input = input;
    this.identities.startEpoch(input.document);
    this.root = this.doc.createElement("div");
    this.root.className = "chp-dom-root";
    this.root.style.visibility = "hidden";
    this.metaRoot = this.doc.createElement("div");
    this.metaRoot.className = "chp-dom-meta";
    this.caretNode = this.doc.createElement("div");
    this.caretNode.className = "chp-dom-caret";
    this.decorationRoot = this.doc.createElement("div");
    this.decorationRoot.className = "chp-dom-decorations";
    this.root.appendChild(this.metaRoot);
    this.root.appendChild(this.caretNode);
    this.root.appendChild(this.decorationRoot);
    this.host.appendChild(this.root);
    this.measurer = new DomTextMeasurer(this.doc, () => this.invalidate("metrics"));
    this.resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.handleResize());
    this.resizeObserver?.observe(this.host);
    this.applyThemeVariables();
    this.invalidate("structure");
  }

  get element() {
    return this.root;
  }

  /** Committed geometry index, or null before the first commit. */
  getGeometryIndex() {
    return this.geometry;
  }

  /**
   * Width of a raw text prefix in a given font, batched through the renderer's
   * own measurer. The controller uses it for chord/tag caret placement and
   * drag-ghost sizing.
   */
  measureTextWidth(text: string, font: string) {
    return this.measureRawText(text, font);
  }

  getLayoutSnapshot() {
    return this.snapshots.getSnapshot();
  }

  subscribeLayout(listener: LayoutListener) {
    return this.snapshots.subscribe(listener);
  }

  whenLayoutSettled(afterRevision?: number) {
    return this.snapshots.whenSettled(afterRevision);
  }

  toggleInstructionSection(occurrenceId: string) {
    if (this.disposed || !this.input.instructionsPane) return false;
    const collapsed = !this.collapsedInstructionStarts.has(occurrenceId);
    if (collapsed) this.collapsedInstructionStarts.add(occurrenceId);
    else this.collapsedInstructionStarts.delete(occurrenceId);
    this.invalidate("layout");
    return collapsed;
  }

  update(input: DomSongRendererInput, category: InvalidationCategory = "structure") {
    if (this.disposed) return;
    const replaced = input.document !== this.input.document;
    const semanticChanged = revisionsKey(input) !== revisionsKey(this.input);
    const decorationChanged = decorationKey(input) !== decorationKey(this.input);
    const diagramsChanged = diagramKey(input) !== diagramKey(this.input);
    this.input = input;
    if (replaced) this.identities.startEpoch(input.document);
    if (replaced || semanticChanged) this.collapsedInstructionStarts.clear();
    if (replaced || semanticChanged || decorationChanged || diagramsChanged || category === "decoration" || category === "interaction")
      this.invalidate(category);
  }

  /**
   * Theme/style/root-font update. Separate from `dispose()` by contract.
   *
   * Theme changes only repaint CSS variables and decorations; they invalidate
   * measurement only when the text metrics actually change, which the measurer
   * detects itself through its root-font and font-loading observations.
   */
  updateTheme(input: DomSongRendererInput) {
    if (this.disposed) return;
    const metricsChanged = input.styleRevision !== this.input.styleRevision;
    this.input = input;
    this.applyThemeVariables();
    this.invalidate(metricsChanged ? "metrics" : "decoration");
  }

  invalidate(category: InvalidationCategory) {
    if (this.disposed) return;
    this.invalidationGeneration += 1;
    if (category === "structure" || category === "metrics" || category === "layout") this.snapshots.markPending();
    if (this.scheduledFrame != null) return;
    this.scheduledFrame =
      this.doc.defaultView?.requestAnimationFrame(() => this.renderFrame()) ?? window.requestAnimationFrame(() => this.renderFrame());
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.scheduledFrame != null) {
      (this.doc.defaultView ?? window).cancelAnimationFrame(this.scheduledFrame);
      this.scheduledFrame = null;
    }
    this.resizeObserver?.disconnect();
    this.measurer.dispose();
    this.snapshots.dispose();
    for (const entry of this.abcNodes.values()) entry.node.remove();
    this.abcNodes.clear();
    for (const canvas of this.diagramNodes.values()) canvas.remove();
    this.diagramNodes.clear();
    this.metaRowNodes.clear();
    this.chordStripNode = null;
    this.bodyNode = null;
    this.diagramsNode = null;
    this.geometry = null;
    this.root.remove();
  }

  /** Widen/offset only the title after an owning surface transform-fits the
   * natural-width song. This deliberately does not change the layout snapshot. */
  setViewportAlignedTitleGeometry(width: number, rootOffset: number) {
    if (!this.input.viewportAlignedTitle || !Number.isFinite(width) || width <= 0) return;
    this.viewportTitleGeometry = { width, rootOffset: Number.isFinite(rootOffset) ? Math.max(0, rootOffset) : 0 };
    this.applyViewportTitleGeometry();
  }

  private applyThemeVariables() {
    const display = this.input.display;
    this.root.style.setProperty("--chp-highlight-color", display.highlightColor);
    this.root.style.setProperty("--chp-comment-border", display.commentBorder);
    this.root.style.setProperty("--chp-caret-color", display.cursorColor);
    this.root.style.setProperty("--chp-selected-bg", display.selectedTextBg);
    this.root.style.setProperty("--chp-selected-fg", display.selectedTextFg);
    this.root.style.setProperty("--chp-mark-color", display.markUnderscoreColor);
    this.root.style.setProperty("--chp-chord-color", display.chordTextColor);
    this.root.classList.toggle("chp-dom-dark", !!this.input.isDark);
  }

  private handleResize() {
    if (this.disposed) return;
    const width = this.viewportWidth();
    if (width === this.lastViewportWidth) return;
    const previousWidth = this.lastViewportWidth;
    this.lastViewportWidth = width;
    if (width <= 0) {
      this.lastCommitKey = "";
      this.snapshots.markPending();
    } else if (previousWidth <= 0 || ((this.input.widthPolicy !== "FIT_PAGE" || this.input.viewportAlignedTitle) && width !== previousWidth))
      this.invalidate("layout");
  }

  private viewportWidth() {
    // Client-view deliberately gives its editor an intrinsic width so it can
    // transform-fit the whole song. Before the first DOM commit that host has
    // no width, so its owning pane is a bootstrap-only viewport fallback.
    // FIT_PAGE remains natural-width.
    const owner = this.host.parentElement;
    const width = this.host.clientWidth || this.host.offsetWidth || owner?.clientWidth || owner?.offsetWidth || 0;
    const style = this.doc.defaultView?.getComputedStyle(this.host);
    const paddingLeft = Number.parseFloat(style?.paddingLeft ?? "") || 0;
    const paddingRight = Number.parseFloat(style?.paddingRight ?? "") || 0;
    return Math.max(0, width - paddingLeft - paddingRight);
  }

  private renderFrame() {
    this.scheduledFrame = null;
    if (this.disposed) return;
    const viewportWidth = this.viewportWidth();
    this.lastViewportWidth = viewportWidth;
    if (viewportWidth <= 0) return;

    const generation = this.invalidationGeneration;
    const input = this.input;
    const semanticKey = revisionsKey(input);
    this.measurer.setStyleRevision(input.styleRevision);
    // FIT_PAGE is natural-width: a positive viewport merely permits layout;
    // changing one positive width to another cannot change geometry. ABC staff
    // width is derived from the song's own natural width, never the viewport, so
    // that invariant still holds once ABC blocks render.
    const fullPlan = buildDisplayPlan({
      document: input.document,
      identities: this.identities,
      system: input.system,
      display: input.display,
      directives: input.directives,
      chordFormat: input.chordFormat,
      showTitle: input.showTitle,
      showMeta: input.showMeta,
      showTags: input.showTags,
      abbreviateTags: input.abbreviateTags,
      readOnly: input.readOnly,
      differential: input.differential,
      instructionsMode: input.instructionsMode,
      instructionsPane: input.instructionsPane,
      sequence: input.sequence ?? undefined,
      keyIsAuto: input.keyIsAuto,
      localize: input.localize,
    });
    const plan = this.applyInstructionCollapse(fullPlan);

    // Pass one: canonical hidden tag nodes establish the lane for the whole plan.
    const tagResults = this.measurer.measureTags(
      plan.occurrences
        .filter((occurrence) => plan.showTags && occurrence.tag?.visible)
        .map((occurrence) => ({
          id: occurrence.id,
          text: occurrence.tag!.text,
          font: plan.display.tagFont,
          color: plan.display.tagColor,
        }))
    );
    const tagWidths = new Map(tagResults.map((result) => [result.id, result.size.width] as const));
    const layoutOptions = {
      tagWidths,
      overlayRevMoveCost: input.overlayRevMoveCost,
      overlayFwdMoveCost: input.overlayFwdMoveCost,
      moveChordsOnly: input.moveChordsOnly,
      widthPolicy: input.widthPolicy,
      contentWidth: viewportWidth,
      clipMetaToSongWidth: input.clipMetaToSongWidth,
      viewportAlignedTitle: input.viewportAlignedTitle,
    };
    let layout = layoutSong(plan, this.measurer, layoutOptions);
    if (layout.pending) return;

    // Pass two: ABC blocks size against the song's own natural width, so the
    // placeholder layout above establishes that width first. Only songs that
    // actually contain ABC pay for the second pass.
    const abcPending = this.renderAbcBlocks(plan, layout, input);
    if (plan.occurrences.some((occurrence) => occurrence.kind === "abc"))
      layout = layoutSong(plan, this.measurer, { ...layoutOptions, abcHeights: this.abcHeights() });

    if (this.disposed || generation !== this.invalidationGeneration || semanticKey !== revisionsKey(this.input)) return;
    const commitKey = [
      semanticKey,
      this.measurer.styleRevision,
      // Decorations and completed async ABC geometry can each require a fresh
      // visible commit with no semantic/style revision change at all.
      decorationKey(input),
      diagramKey(input),
      this.abcGeometryRevision,
      input.widthPolicy === "FIT_PAGE" && !input.viewportAlignedTitle ? "natural" : viewportWidth,
      collapseKey(this.collapsedInstructionStarts),
    ].join("|");
    if (commitKey === this.lastCommitKey) return;
    this.commit(plan, layout, !this.measurer.fontsPending && !abcPending);
    this.lastCommitKey = commitKey;
  }

  private applyInstructionCollapse(plan: DisplayPlan): DisplayPlan {
    if (!plan.instructionsPane || this.collapsedInstructionStarts.size === 0) return plan;
    const occurrences: DisplayPlan["occurrences"][number][] = [];
    let hiddenSection: string | null = null;
    for (const occurrence of plan.occurrences) {
      const section = occurrence.instructionsAdapter?.section ?? null;
      if (hiddenSection) {
        if (section === hiddenSection) continue;
        hiddenSection = null;
      }
      occurrences.push(occurrence);
      if (section && this.collapsedInstructionStarts.has(occurrence.id)) hiddenSection = section;
    }
    return { ...plan, occurrences };
  }

  private abcHeights() {
    const heights = new Map<string, number>();
    for (const [id, entry] of this.abcNodes) heights.set(id, entry.height);
    return heights;
  }

  /**
   * Renders every ABC occurrence into a renderer-owned container and records its
   * measured height. Returns true while ABC geometry is still pending, which
   * keeps the layout unsettled.
   *
   * The container is populated through abcjs's container-based `renderAbc` API
   * and is then reused by identity. Its generated markup is never read back or
   * copied anywhere.
   */
  private renderAbcBlocks(plan: DisplayPlan, layout: SongLayoutResult, input: DomSongRendererInput) {
    const abcOccurrences = plan.occurrences.filter((occurrence) => occurrence.kind === "abc");
    const live = new Set(abcOccurrences.map((occurrence) => occurrence.id));
    for (const [id, entry] of [...this.abcNodes]) {
      if (live.has(id)) continue;
      entry.node.remove();
      this.abcNodes.delete(id);
    }
    if (abcOccurrences.length === 0) return false;

    if (!this.abcPort.isLoaded()) {
      this.beginAbcLoad();
      // Geometry is genuinely pending only while the chunk is in flight. Once the
      // load has settled and abcjs is still unavailable, the sized placeholder is
      // the final geometry: staying unsettled forever would orphan every waiter,
      // and retrying each frame would spin.
      return this.abcLoadState !== "done";
    }

    const leftMargin = plan.display.horizontalMargin;
    const horizontalSeparation = 2 * plan.display.lyricsLineHeight;
    const visibleWidth = Math.max(1, layout.width - leftMargin);
    const maxWidth = visibleWidth / ABC_SCALE + leftMargin + horizontalSeparation;
    const options = {
      germanAlphabet: input.system.systemCode === "G",
      jazzchords: true,
      paddingleft: 0,
      paddingright: 0,
      staffwidth: maxWidth - leftMargin - horizontalSeparation,
      dragging: false,
      currentColor: input.isDark ? "white" : "black",
    };

    for (const occurrence of abcOccurrences) {
      const abc = occurrence.source;
      if (!(abc instanceof ChordProAbc)) continue;
      const key = [occurrence.text, options.staffwidth, options.currentColor, options.germanAlphabet, this.measurer.styleRevision].join("|");
      const existing = this.abcNodes.get(occurrence.id);
      if (existing?.key === key) continue;

      const node = existing?.node ?? this.doc.createElement("div");
      node.className = "chp-dom-abc-content";
      node.replaceChildren();
      // Double-click target metadata: the controller resolves the ABC block for
      // MIDI playback from the owning occurrence, which survives re-render.
      node.dataset.occurrenceId = occurrence.id;
      const visual = this.abcPort.render(node, abc, options);
      // The visible commit scales this container, and a reused node still
      // carries that transform. `getBoundingClientRect` includes transforms, so
      // measuring it as-is would return an ALREADY-scaled height and scale it
      // again — the block would shrink on every re-render and the rows below it
      // would overlap the staff. Measure the untransformed box; `renderBlock`
      // re-applies the scale on commit.
      node.style.removeProperty("transform");
      // Pin the container to the generated SVG's intrinsic width
      // so the scaled box matches the notation instead of shrink-to-fitting
      // against whatever containing block it is measured or committed in.
      node.style.width = abcIntrinsicWidth(node);
      const measured = this.measurer.measureOwnedElement(node);
      // The visible width matters as much as the height: abcjs's SVG often runs
      // WIDER than the `staffwidth` target (chord symbols, volta brackets), so
      // the scaled block can extend past the song's lyric width. `buildDiagrams`
      // uses this to keep the side diagram column clear of the ABC (they
      // overlapped otherwise).
      this.abcNodes.set(occurrence.id, { node, key, height: ABC_SCALE * measured.height, width: ABC_SCALE * measured.width, source: abc, visual });
    }
    return false;
  }

  /**
   * The tune object abcjs produced for the VISIBLE container of `abc`, used to
   * drive MIDI playback's note-highlight animation. Playback re-renders the tune
   * into a throwaway container when this is absent, which then animates elements
   * that are not in the document — the notation just sits still.
   */
  getAbcVisualObject(abc: ChordProAbc): TuneObject | undefined {
    for (const entry of this.abcNodes.values()) if (entry.source === abc) return entry.visual;
    return undefined;
  }

  /**
   * Starts the lazy abcjs load exactly once. Completion re-renders the CURRENT
   * song unconditionally (unless disposed).
   *
   * It deliberately does NOT gate on the document/epoch/semantic revisions
   * captured at load-start. abcjs availability is a GLOBAL fact, independent of
   * this song's document/display/style revisions — and on initial app load the
   * parse, theme, styles and highlight routinely settle DURING the async chunk
   * load, so those revisions almost always change before it resolves. The old
   * captured-revision guard then silently bailed, and the ABC SOURCE placeholder
   * stayed painted over the lyrics forever. Re-rendering
   * unconditionally is safe: `renderAbcBlocks` replaces the placeholder from the
   * CURRENT input, and the fresh frame captures and settles the current
   * revisions — it never resolves a stale one, because nothing captured here is
   * applied to a newer revision; only a re-render is triggered.
   */
  private beginAbcLoad() {
    if (this.abcLoadState !== "idle") return;
    this.abcLoadState = "loading";
    void this.abcPort
      .load()
      .catch(() => undefined)
      .finally(() => {
        // The chunk load is global, so a failure is not retried per frame.
        this.abcLoadState = "done";
        if (this.disposed) return;
        this.abcGeometryRevision += 1;
        this.invalidate("metrics");
      });
  }

  private commit(plan: DisplayPlan, layout: SongLayoutResult, settled: boolean) {
    this.renderMeta(plan, layout);
    const editing = this.input.readOnly ? null : (this.input.editing ?? null);
    const selectionSpans = editing?.selection ? computeSelectionSpans(plan.occurrences, editing.selection) : null;

    // The strip is a renderer-owned left gutter that shifts the song right.
    // Its width must be known before the geometry index is built.
    const chordStrip = this.doc.createElement("div");
    chordStrip.className = "chp-dom-chord-strip";
    const stripWidth = this.renderChordStrip(chordStrip, plan, layout);
    const bodyLeft = stripWidth + plan.display.horizontalMargin;

    const body = this.doc.createElement("div");
    body.className = "chp-dom-body";
    body.style.marginLeft = `${bodyLeft}px`;
    body.style.marginRight = `${plan.display.horizontalMargin}px`;
    body.style.setProperty("--chp-tag-lane", `${layout.tagLaneWidth}px`);
    body.style.setProperty("--chp-tag-gap", `${layout.tagGap}px`);
    body.style.setProperty("--chp-comment-border", plan.display.commentBorder);

    const geometry = buildGeometryIndex(plan, layout, stripWidth);
    body.appendChild(this.buildHighlightRoot(plan, geometry, layout, bodyLeft));

    for (const occurrenceLayout of layout.occurrences) {
      const occurrence = occurrenceLayout.source;
      const occurrenceNode = this.doc.createElement("div");
      occurrenceNode.className = "chp-dom-occurrence";
      occurrenceNode.dataset.occurrenceId = occurrence.id;
      const instructionsAdapter = occurrence.instructionsAdapter;
      if (instructionsAdapter) occurrenceNode.dataset.instructionsSection = instructionsAdapter.section;
      occurrenceNode.style.height = `${occurrenceLayout.height}px`;

      const tagNode = this.doc.createElement("div");
      tagNode.className = "chp-dom-tag";
      const firstLyricsY = occurrenceLayout.rows?.[0]?.lyricsY ?? 0;
      const firstLyricsTop = occurrenceLayout.tagSeparation + firstLyricsY;
      // Section separation belongs before the first row. The tag then shares
      // the exact top and line-height of that row's lyrics, so different tag
      // and lyric fonts cannot acquire unrelated CSS line boxes.
      tagNode.style.paddingTop = `${firstLyricsTop}px`;
      tagNode.style.lineHeight = `${plan.display.lyricsLineHeight}px`;
      if (instructionsAdapter && occurrence.tag?.visible) {
        tagNode.dataset.instructionsCollapseId = occurrence.id;
        tagNode.dataset.instructionsDragTag = instructionsAdapter.dragTagName;
        tagNode.draggable = true;
      }
      if (plan.showTags && occurrence.tag?.visible) {
        if (occurrence.tag.textUnits.some((unit) => unit.change !== "equal"))
          this.appendDifferentialText(tagNode, occurrence.tag.textUnits, { font: plan.display.tagFont, color: plan.display.tagColor });
        else tagNode.appendChild(createTagNode(this.doc, occurrence.tag.text, { font: plan.display.tagFont, color: plan.display.tagColor }));
      }
      for (const child of Array.from(tagNode.children)) {
        (child as HTMLElement).style.lineHeight = `${plan.display.lyricsLineHeight}px`;
      }
      occurrenceNode.appendChild(tagNode);

      const lineNode = this.doc.createElement("div");
      lineNode.className = "chp-dom-line";
      lineNode.style.marginTop = `${occurrenceLayout.tagSeparation}px`;
      lineNode.style.height = `${occurrenceLayout.height - occurrenceLayout.tagSeparation}px`;
      // An ABC block starts at the song's LEFT MARGIN — level with
      // the section labels — not in the content column. It never carries a label
      // of its own (`tagForLine` returns null for ABC, which has its own header),
      // and its staff width is already derived from the song's full width, so it
      // spans the tag lane too.
      if (occurrence.kind === "abc") lineNode.style.gridColumn = "1 / -1";
      if (instructionsAdapter) {
        lineNode.dataset.instructionsDragTag = instructionsAdapter.dragTagName;
        lineNode.draggable = true;
      }
      occurrenceNode.appendChild(lineNode);

      if (occurrenceLayout.rows)
        for (const row of occurrenceLayout.rows)
          this.renderRow(plan, row, occurrence, lineNode, layout.bodyWidth, selectionSpans?.get(occurrence.id) ?? null, editing);
      else this.renderBlock(plan, occurrenceLayout, lineNode);
      body.appendChild(occurrenceNode);
    }

    const diagrams = this.doc.createElement("div");
    diagrams.className = "chp-dom-chord-diagrams";
    const composite = this.buildDiagrams(diagrams, layout, stripWidth);

    // Swap ONLY the rebuilt sections. The persistent meta root and caret stay
    // attached by identity, so replacing them (as a whole-root replaceChildren
    // would) cannot blur a focused metadata input or drop an IME composition.
    this.chordStripNode?.remove();
    this.bodyNode?.remove();
    this.diagramsNode?.remove();
    this.root.appendChild(chordStrip);
    this.root.appendChild(body);
    this.root.appendChild(diagrams);
    this.chordStripNode = chordStrip;
    this.bodyNode = body;
    this.diagramsNode = diagrams;
    this.root.classList.toggle("chp-dom-editing", !!editing);
    this.root.style.width = `${composite.width}px`;
    this.root.style.height = `${composite.height}px`;
    this.root.style.paddingTop = `${plan.display.verticalMargin}px`;
    this.root.style.paddingBottom = `${plan.display.verticalMargin}px`;
    // Instruction and differential panes belong to a surrounding application
    // surface. Painting the authored song backdrop here produces a separate
    // opaque rectangle in those panes instead of letting them inherit it.
    const inheritsOwningSurface = !!plan.instructionsPane || this.input.differential;
    this.root.style.backgroundColor = inheritsOwningSurface ? "transparent" : plan.display.backgroundColor;
    this.root.classList.toggle("chp-dom-differential", this.input.differential);
    this.root.style.visibility = "visible";
    this.positionViewportTitle(plan, composite.width);
    // Diagram boxes are only known once placed, and they overlay the song, so
    // the index carries them for hit resolution ahead of the chords.
    const diagramSize = this.input.diagrams?.size;
    this.geometry = diagramSize
      ? {
          ...geometry,
          diagrams: composite.placements.map((entry) => ({
            left: entry.x,
            top: entry.y,
            width: diagramSize.width,
            height: diagramSize.height,
            chord: entry.chord,
          })),
        }
      : geometry;
    this.positionCaret(editing);
    this.positionEditingDecorations(plan, editing);
    const snapshot = this.snapshots.commit(composite.width, composite.height, settled);
    // Commit the same logical dimensions onto the owned root; callers never
    // observe canvas backing-store/device-pixel-ratio dimensions in DOM mode.
    this.root.dataset.layoutRevision = String(snapshot.revision);
  }

  /**
   * Updates the persistent meta root in place with rows keyed by meta NAME.
   *
   * The controller's metadata input elements are
   * mounted into these rows and reused by identity across commits, which is
   * what keeps focus, the undo action target, and tab navigation working
   * through a full keyed reconcile. Readonly instances keep the existing
   * text-run rendering, only reusing the row wrappers.
   */
  private renderMeta(plan: DisplayPlan, layout: SongLayoutResult) {
    const metaRoot = this.metaRoot;
    metaRoot.style.marginLeft = `${plan.display.horizontalMargin}px`;
    metaRoot.style.marginRight = `${plan.display.horizontalMargin}px`;
    // A pane-fitted host clips metadata to the SONG's content width — never the
    // composite width, which can include a right-hand diagram region — so an
    // over-long title ellipsises instead of scaling the lyrics down. `layoutSong`
    // keeps meta out of that width for the same instances. Everywhere else the
    // metadata sizes the box as before and is not clipped.
    const metaBox = layout.width - 2 * plan.display.horizontalMargin;
    const clipped = !!this.input.clipMetaToSongWidth && metaBox > 0;
    metaRoot.classList.toggle("chp-dom-meta-clipped", clipped);
    if (clipped) metaRoot.style.width = `${metaBox}px`;
    else metaRoot.style.removeProperty("width");

    const host = this.input.readOnly ? null : (this.input.metaInputs ?? null);
    const measuredMeta = new Map(layout.meta.map((entry) => [entry.id, entry.width] as const));
    const viewportTitleWidth = Math.max(1, this.lastViewportWidth - 2 * plan.display.horizontalMargin);
    const live = new Set<string>();
    const desired: HTMLDivElement[] = [];
    for (const entry of plan.meta) {
      live.add(entry.name);
      let row = this.metaRowNodes.get(entry.name);
      if (!row) {
        row = this.doc.createElement("div");
        row.className = "chp-dom-meta-row";
        this.metaRowNodes.set(entry.name, row);
      }
      row.dataset.metaId = entry.id;
      row.style.height = `${entry.height}px`;
      row.style.lineHeight = `${entry.height}px`;
      row.style.font = entry.font;
      row.style.color = entry.color;
      row.style.paddingLeft = `${entry.indent}px`;
      const viewportTitle = !!this.input.viewportAlignedTitle && entry.name === "title";
      if (viewportTitle) {
        row.style.position = "relative";
        row.style.left = "0px";
        row.style.width = `${viewportTitleWidth}px`;
        row.style.overflow = "hidden";
        row.style.textAlign = safeMetaAlignment(entry.align, measuredMeta.get(entry.id) ?? 0, viewportTitleWidth);
        this.viewportTitleState = {
          margin: plan.display.horizontalMargin,
          measuredWidth: measuredMeta.get(entry.id) ?? 0,
          requestedAlign: entry.align,
          compositeWidth: layout.width,
        };
      } else {
        row.style.removeProperty("position");
        row.style.removeProperty("left");
        row.style.removeProperty("width");
        row.style.removeProperty("overflow");
        row.style.textAlign = entry.align;
      }
      if (host) host.mount(entry, row);
      else {
        row.replaceChildren();
        this.appendDifferentialText(row, entry.textUnits, { font: entry.font, color: entry.color });
      }
      desired.push(row);
    }
    for (const [name, row] of [...this.metaRowNodes]) {
      if (live.has(name)) continue;
      row.remove();
      this.metaRowNodes.delete(name);
    }
    host?.prune(live);
    // Enforce document order WITHOUT re-appending rows already in place: moving
    // a node re-inserts it, which would blur a focused metadata input. Only a
    // changed meta set (a rare structural edit) pays the reordering move.
    let ordered = metaRoot.children.length === desired.length;
    if (ordered) for (let index = 0; index < desired.length; index += 1) if (metaRoot.children[index] !== desired[index]) ordered = false;
    if (!ordered) for (const row of desired) metaRoot.appendChild(row);
  }

  /**
   * The full editor centres the natural-width song root with auto margins. Move
   * only the title row back across that margin so its alignment box is the host
   * viewport; the body and every other metadata row keep their song geometry.
   */
  private positionViewportTitle(plan: DisplayPlan, compositeWidth: number) {
    if (!this.input.viewportAlignedTitle) return;
    if (this.viewportTitleState) this.viewportTitleState = { ...this.viewportTitleState, margin: plan.display.horizontalMargin, compositeWidth };
    this.applyViewportTitleGeometry();
    this.input.metaInputs?.relayout?.("title");
  }

  private applyViewportTitleGeometry() {
    const row = this.metaRowNodes.get("title");
    const state = this.viewportTitleState;
    if (!row || !state) return;
    const viewportWidth = this.viewportTitleGeometry?.width ?? this.lastViewportWidth;
    const rootOffset = this.viewportTitleGeometry?.rootOffset ?? Math.max(0, (viewportWidth - state.compositeWidth) / 2);
    const availableWidth = Math.max(1, viewportWidth - 2 * state.margin);
    row.style.position = "relative";
    row.style.left = `${-rootOffset}px`;
    row.style.width = `${availableWidth}px`;
    row.style.overflow = "hidden";
    row.style.textAlign = safeMetaAlignment(state.requestedAlign, state.measuredWidth, availableWidth);
  }

  /**
   * Positions the single persistent caret element. The caret resolves by
   * line object identity against the committed geometry; while hidden it keeps
   * its identity so its CSS blink animation never restarts on a rebuild.
   */
  private positionCaret(editing: DomEditingInput | null) {
    const caret = editing?.caret ?? null;
    const placed = caret && this.geometry ? resolveCaretGeometry(this.geometry, caret.line, caret.column) : null;
    if (!placed) {
      this.caretNode.classList.remove("chp-dom-caret-visible");
      return;
    }
    this.caretNode.classList.add("chp-dom-caret-visible");
    this.caretNode.style.left = `${placed.x}px`;
    this.caretNode.style.top = `${placed.top}px`;
    this.caretNode.style.height = `${placed.height}px`;
  }

  /** Width of one chord's token run in the chord font, measured exactly the way
   *  `song-layout` measures the song's own chords, so a template and its
   *  in-song twin can never disagree. */
  private measureChordVisualWidth(visual: ChordVisualModel, plan: DisplayPlan) {
    const requests = visual.tokens.map((token, index) => ({
      id: `strip:${index}`,
      text: token.text,
      role: token.role,
      font: plan.display.chordFont,
      chordFormat: plan.chordFormat,
      noteSystemCode: plan.noteSystemCode,
      key: plan.key,
    }));
    const measured = this.measurer.measure(requests);
    return visual.tokens.reduce((total, token, index) => total + token.gapBefore + (measured[index]?.size.width ?? 0), 0);
  }

  /** Width of a RAW text prefix in a given font, for chord/tag caret
   *  placement, batched through the renderer's own measurer. */
  private measureRawText(text: string, font: string) {
    if (!text) return 0;
    return this.measurer.measure([{ id: "raw", text, role: "lyric", font }])[0]?.size.width ?? 0;
  }

  /**
   * The chord-template strip, in the renderer's own tree. Items are safe token
   * nodes, and because the strip lives inside the scaled root there is no
   * transform to synchronize. Returns the gutter width the song is shifted by
   * (0 when no strip is shown).
   */
  private renderChordStrip(strip: HTMLDivElement, plan: DisplayPlan, layout: SongLayoutResult) {
    const input = this.input.chordStrip;
    if (!input || input.chords.length === 0 || this.input.readOnly) return 0;

    // The strip starts below the metadata block, at the left
    // margin. An absolutely positioned child is placed from the root's padding
    // box, so these are root-local coordinates — the same space the geometry
    // index uses, hence the vertical margin is included explicitly.
    const metaHeight = layout.meta.reduce((total, entry) => total + entry.height, 0);
    const gap = input.gap;
    strip.style.left = `${plan.display.horizontalMargin}px`;
    strip.style.top = `${plan.display.verticalMargin + metaHeight}px`;

    let top = 0;
    let maxWidth = 0;
    for (const chord of input.chords) {
      const visual = input.visual(chord);
      const node = createChordNode(this.doc, `strip:${chord}`, visual, {
        font: plan.display.chordFont,
        color: plan.display.chordTextColor,
        unknownColor: plan.display.unknownChordTextColor,
      });
      node.classList.add("chp-dom-chord-template");
      node.dataset.template = chord;
      node.style.top = `${top}px`;
      node.style.height = `${plan.display.chordLineHeight}px`;
      node.style.lineHeight = `${plan.display.chordLineHeight}px`;
      // The controller owns these gestures: they mutate the document, which a
      // renderer never may.
      node.addEventListener("mousedown", (event: MouseEvent) => input.onPointerDown?.(chord, event));
      node.addEventListener("dblclick", (event: MouseEvent) => input.onDoubleClick?.(chord, event));
      // Mobile browsers don't reliably emit dblclick; detect a local double-tap
      // on this template and forward it as the same double-click gesture (open
      // the chord dialog) so touch matches mouse. A single tap still reaches the
      // controller's touch pipeline as a template drag.
      let lastTemplateTap = 0;
      node.addEventListener(
        "touchend",
        (event: TouchEvent) => {
          if (event.changedTouches.length !== 1) return;
          const now = Date.now();
          if (now - lastTemplateTap <= 500) {
            lastTemplateTap = 0;
            event.preventDefault();
            event.stopPropagation();
            const t = event.changedTouches[0];
            const synthetic = new MouseEvent("dblclick", {
              bubbles: true,
              cancelable: true,
              view: this.doc.defaultView,
              button: 0,
              clientX: t.clientX,
              clientY: t.clientY,
              screenX: t.screenX,
              screenY: t.screenY,
            });
            input.onDoubleClick?.(chord, synthetic);
          } else {
            lastTemplateTap = now;
          }
        },
        { passive: false }
      );
      strip.appendChild(node);
      maxWidth = Math.max(maxWidth, this.measureChordVisualWidth(visual, plan));
      top += plan.display.chordLineHeight + gap;
    }
    return plan.display.horizontalMargin + maxWidth;
  }

  /**
   * Chord/tag raw-text caret and selection, plus the drag ghost and drop
   * marker. These are rebuilt per commit into the persistent decoration root.
   */
  private positionEditingDecorations(plan: DisplayPlan, editing: DomEditingInput | null) {
    this.decorationRoot.replaceChildren();
    const geometry = this.geometry;
    if (!editing || !geometry) return;

    const addBox = (className: string, box: { x: number; top: number; width: number; height: number }) => {
      const node = this.doc.createElement("div");
      node.className = className;
      node.style.left = `${box.x}px`;
      node.style.top = `${box.top}px`;
      node.style.width = `${box.width}px`;
      node.style.height = `${box.height}px`;
      this.decorationRoot.appendChild(node);
      return node;
    };

    const chordText = editing.chordText;
    if (chordText) {
      const raw = chordText.chord.text;
      const measure = (text: string) => this.measureRawText(text, plan.display.chordFont);
      if (chordText.selectionStart != null && chordText.selectionEnd != null && chordText.selectionStart !== chordText.selectionEnd) {
        const start = measure(raw.substring(0, chordText.selectionStart));
        const span = measure(raw.substring(chordText.selectionStart, chordText.selectionEnd));
        const box = resolveChordTextBox(geometry, chordText.chord, start, span, plan.display.chordBorder);
        if (box) addBox("chp-dom-text-selection", box);
      }
      if (chordText.caret != null) {
        const box = resolveChordTextBox(geometry, chordText.chord, measure(raw.substring(0, chordText.caret)), 1, plan.display.chordBorder);
        if (box) addBox("chp-dom-text-caret", box);
      }
    }

    const tagText = editing.tagText;
    if (tagText) {
      const entry = geometry.occurrences.find(
        (candidate) => candidate.tag && (candidate.occurrence.source === tagText.line || candidate.occurrence.origin === tagText.line)
      );
      const raw = entry?.tag?.text ?? "";
      const measure = (text: string) => this.measureRawText(text, plan.display.tagFont);
      if (tagText.selectionStart != null && tagText.selectionEnd != null && tagText.selectionStart !== tagText.selectionEnd) {
        const start = measure(raw.substring(0, tagText.selectionStart));
        const span = measure(raw.substring(tagText.selectionStart, tagText.selectionEnd));
        const box = resolveTagTextBox(geometry, tagText.line, start, span);
        if (box) addBox("chp-dom-text-selection", box);
      }
      if (tagText.caret != null) {
        const box = resolveTagTextBox(geometry, tagText.line, measure(raw.substring(0, tagText.caret)), 1);
        if (box) addBox("chp-dom-text-caret", box);
      }
    }

    const drag = editing.drag;
    if (drag) {
      if (drag.marker) {
        // With `w = 2 * chordBorder` the
        // triangle spans `hPos - w`..`hPos + w` and drops from `vPos` to
        // `vPos + 2w` — apex DOWN, at the boundary. A 1px rule then runs along
        // `vPos - 1` out to whichever is further, the ghost or the triangle.
        const half = 2 * plan.display.chordBorder;
        const marker = this.doc.createElement("div");
        marker.className = "chp-dom-drop-marker";
        marker.style.borderLeftWidth = `${half}px`;
        marker.style.borderRightWidth = `${half}px`;
        marker.style.borderTopWidth = `${2 * half}px`;
        marker.style.left = `${drag.marker.x - half}px`;
        marker.style.top = `${drag.marker.y}px`;
        this.decorationRoot.appendChild(marker);

        const barLeft = drag.marker.x - half;
        const barRight = Math.max(drag.left + this.measureRawText(drag.text, plan.display.chordFont), drag.marker.x + half);
        const bar = this.doc.createElement("div");
        bar.className = "chp-dom-drop-marker-bar";
        bar.style.left = `${barLeft}px`;
        bar.style.top = `${drag.marker.y - 1}px`;
        bar.style.width = `${Math.max(0, barRight - barLeft)}px`;
        this.decorationRoot.appendChild(bar);
      }
      const ghost = this.doc.createElement("div");
      ghost.className = "chp-dom-drag-ghost";
      ghost.classList.toggle("chp-dom-drag-nodrop", drag.noDrop);
      ghost.style.left = `${drag.left}px`;
      ghost.style.top = `${drag.top}px`;
      ghost.style.height = `${plan.display.chordLineHeight}px`;
      ghost.style.lineHeight = `${plan.display.chordLineHeight}px`;
      ghost.style.font = plan.display.chordFont;
      ghost.style.color = plan.display.chordTextColor;
      ghost.textContent = drag.text;
      this.decorationRoot.appendChild(ghost);
    }
  }

  /**
   * Song-level highlight bands. The canvas fills these behind the text with
   * `destination-over` from the tag column to the song's widest content edge, so
   * they cannot live inside a single row's box.
   */
  private buildHighlightRoot(plan: DisplayPlan, geometry: SongGeometryIndex, layout: SongLayoutResult, bodyLeft: number) {
    const root = this.doc.createElement("div");
    root.className = "chp-dom-highlight-root";
    const decoration = computeHighlightDecoration(geometry, this.input.highlight, plan.sectionGroups, this.input.highlightOpacity);
    if (!decoration) return root;

    const metaHeight = layout.meta.reduce((total, entry) => total + entry.height, 0);
    const bodyOrigin = plan.display.verticalMargin + metaHeight;
    for (const band of decoration.bands) {
      const height = band.bottom - band.top;
      const addBand = (left: number, width: number, opacity: number, radius: string) => {
        const node = this.doc.createElement("div");
        node.className = "chp-dom-highlight-band";
        node.style.left = `${left - bodyLeft}px`;
        node.style.top = `${band.top - bodyOrigin}px`;
        node.style.width = `${width}px`;
        node.style.height = `${height}px`;
        node.style.opacity = String(opacity);
        node.style.borderRadius = radius;
        root.appendChild(node);
      };

      const full = `${band.radius}px`;
      if (!decoration.segment) {
        addBand(decoration.left, decoration.width, decoration.opacity, full);
        continue;
      }
      addBand(decoration.left, decoration.width, decoration.opacity * 0.5, full);
      const segmentWidth = decoration.width / decoration.segment.total;
      const segmentLeft = decoration.left + (decoration.segment.index - 1) * segmentWidth;
      const leftMost = decoration.segment.index <= 1;
      const rightMost = decoration.segment.index >= decoration.segment.total;
      const radius = [leftMost ? full : "0", rightMost ? full : "0", rightMost ? full : "0", leftMost ? full : "0"].join(" ");
      addBand(segmentLeft, segmentWidth, decoration.opacity, radius);
    }
    return root;
  }

  /**
   * Places the retained guitar/piano diagram canvases in the normal-flow diagram
   * region and returns the composite extents including that region.
   *
   * These canvases are explicitly NOT the song surface: they are never removed by
   * broad canvas cleanup and are reused by chord identity across commits.
   */
  /**
   * Right edge of the widest scaled ABC block in song coordinates, or 0 if there
   * is none. `layoutSong` folds no width for an ABC occurrence (its `:block` is
   * never text-measured — only its height flows back via `abcHeights`), so an
   * ABC that renders wider than the lyric content is invisible to `layout.width`.
   * A block starts at the left margin (transform-origin `0 0`), so its right edge
   * is `horizontalMargin + scaledWidth`.
   */
  private abcContentRightEdge() {
    let maxWidth = 0;
    for (const entry of this.abcNodes.values()) maxWidth = Math.max(maxWidth, entry.width);
    return maxWidth > 0 ? this.input.display.horizontalMargin + maxWidth : 0;
  }

  private buildDiagrams(region: HTMLDivElement, layout: SongLayoutResult, leftOffset = 0) {
    const diagrams = this.input.diagrams;
    // Offset the diagram column past the true content right edge, not just the
    // lyric width, so a wide ABC block cannot sit under the side diagrams.
    const songWidth = Math.max(layout.width, this.abcContentRightEdge()) + leftOffset;
    if (!diagrams || diagrams.chords.length === 0) {
      for (const canvas of this.diagramNodes.values()) canvas.remove();
      this.diagramNodes.clear();
      return { width: songWidth, height: layout.height, placements: [] as readonly DiagramPlacement[] };
    }

    // Resolve the side/below target ratio. A positive value is an explicit
    // policy — use it. A non-positive value is interpreted by host type:
    //   • a pane-fitted host (fitsToPane → clipMetaToSongWidth) sets 0
    //     DELIBERATELY in FIT_WIDTH/scroll mode to mean "always stack diagrams
    //     BELOW" — the song is width-fit and scrolls vertically, so there is no
    //     side room. Honour that 0 (0 is never > a positive song ratio → below);
    //   • a natural-size host (the desktop editor, which never calls fitToPane
    //     and leaves targetRatio at its 0 default) means "unset" → the live host
    //     aspect decides.
    // Reading hostRatio() for the pane-fitted case measured the host's momentary
    // box, which for a cold-rendered neighbour (prev/next) page is wide, so the
    // diagrams landed to the SIDE and only corrected once that page became current.
    const fallbackRatio = this.input.clipMetaToSongWidth ? 0 : this.hostRatio();
    const targetRatio = diagrams.targetRatio > 0 ? diagrams.targetRatio : fallbackRatio;
    const placement = placeChordDiagrams(
      diagrams.chords,
      { width: songWidth, height: layout.height },
      diagrams.size,
      targetRatio,
      { horizontalMargin: this.input.display.horizontalMargin, verticalMargin: this.input.display.verticalMargin },
      diagrams.canRender
    );

    const live = new Set(placement.placements.map((entry) => entry.chord));
    for (const [chord, canvas] of [...this.diagramNodes]) {
      if (live.has(chord)) continue;
      canvas.remove();
      this.diagramNodes.delete(chord);
    }

    for (const entry of placement.placements) {
      let svg = this.diagramNodes.get(entry.chord);
      if (!svg) {
        svg = this.doc.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
        svg.setAttribute("class", "chp-dom-chord-diagram");
        this.diagramNodes.set(entry.chord, svg);
      }
      svg.dataset.chord = entry.chord;
      svg.style.left = `${entry.x}px`;
      svg.style.top = `${entry.y}px`;
      svg.style.width = `${diagrams.size.width}px`;
      svg.style.height = `${diagrams.size.height}px`;
      region.appendChild(svg);
      diagrams.draw(entry.chord, svg);
    }
    return { width: placement.width, height: placement.height, placements: placement.placements };
  }

  private hostRatio() {
    const rect = this.host.getBoundingClientRect?.();
    if (!rect || !rect.height) return 1;
    return rect.width / rect.height;
  }

  private renderRow(
    plan: DisplayPlan,
    rowLayout: NonNullable<SongLayoutResult["occurrences"][number]["rows"]>[number],
    occurrence: DisplayPlan["occurrences"][number],
    parent: HTMLElement,
    availableWidth: number,
    selection: SelectionSpan | null = null,
    editing: DomEditingInput | null = null
  ) {
    const row = this.doc.createElement("div");
    row.className = "chp-dom-row";
    row.dataset.rowId = rowLayout.id;
    row.style.height = `${rowLayout.height}px`;
    row.style.width = `${rowLayout.width}px`;
    const remaining = Math.max(0, availableWidth - rowLayout.width);
    row.style.marginLeft = `${occurrence.style.align === "right" ? remaining : occurrence.style.align === "center" ? remaining / 2 : 0}px`;

    const highlight = this.doc.createElement("div");
    highlight.className = "chp-dom-highlight-layer";
    row.appendChild(highlight);

    // Noninteractive selection decorations, BELOW the text layers: the selected
    // background paints first with the glyphs over it. Bands cover exactly the
    // selected glyph cells; the selected foreground is applied on the run nodes
    // themselves.
    const selectionLayer = this.doc.createElement("div");
    selectionLayer.className = "chp-dom-selection-layer";
    if (selection) {
      for (const band of computeRowSelectionBands(rowLayout.lyricRuns, selection)) {
        const node = this.doc.createElement("div");
        node.className = "chp-dom-selection-band";
        node.style.left = `${band.left}px`;
        node.style.top = `${rowLayout.lyricsY}px`;
        node.style.width = `${band.width}px`;
        node.style.height = `${plan.display.lyricsLineHeight}px`;
        selectionLayer.appendChild(node);
      }
    }
    row.appendChild(selectionLayer);
    const chordLayer = this.doc.createElement("div");
    chordLayer.className = "chp-dom-chord-layer";
    for (const positioned of rowLayout.chords) {
      const chord = occurrence.chords.find((candidate) => candidate.id === positioned.id);
      if (!chord) continue;
      const node = createChordNode(this.doc, chord.id, chord.visual, {
        font: plan.display.chordFont,
        color: plan.display.chordTextColor,
        unknownColor: plan.display.unknownChordTextColor,
      });
      // The dragged chord keeps its layout slot (only its drawing is hidden,
      // its layout influence stays intact) while the ghost renders under the
      // pointer instead.
      if (editing?.drag?.chord === chord.source) node.classList.add("chp-dom-chord-dragging");
      // A marked chord carries a wavy underline. This is NOT gated on marking
      // mode — the wave shows whenever `marked` is truthy, read-only included
      // (a `# notes:` comment loads marks as -1), and marking mode only decides
      // whether a click TOGGLES them.
      if (chord.source.marked) node.classList.add("chp-dom-marked");
      node.style.left = `${positioned.x + plan.display.chordBorder}px`;
      node.style.top = `${positioned.y + plan.display.chordBorder}px`;
      node.style.height = `${plan.display.chordLineHeight}px`;
      node.style.lineHeight = `${plan.display.chordLineHeight}px`;
      if (this.input.differential) {
        node.classList.add(`chp-dom-diff-${positioned.change}`);
        if (positioned.change === "moved") node.classList.add("chp-dom-diff-moved");
      }
      if (positioned.beforeStart != null) {
        node.dataset.beforeStart = String(positioned.beforeStart);
        node.dataset.beforeEnd = String(positioned.beforeEnd);
      }
      if (positioned.afterStart != null) {
        node.dataset.afterStart = String(positioned.afterStart);
        node.dataset.afterEnd = String(positioned.afterEnd);
      }
      chordLayer.appendChild(node);
      if (positioned.change === "moved") {
        const addMarker = (sourceOffset: number, markerClass: string) => {
          const x = this.rowSourceX(rowLayout, sourceOffset);
          if (x == null) return;
          const marker = this.doc.createElement("span");
          marker.className = `chp-dom-chord-marker ${markerClass}`;
          marker.style.left = `${x}px`;
          marker.style.top = `${plan.display.chordLineHeight}px`;
          chordLayer.appendChild(marker);
        };
        if (positioned.previousSourceOffset != null) addMarker(positioned.previousSourceOffset, "chp-dom-chord-marker-before");
        addMarker(positioned.sourceOffset, "chp-dom-chord-marker-after");
      }
    }
    row.appendChild(chordLayer);

    const lyricsLayer = this.doc.createElement("div");
    lyricsLayer.className = "chp-dom-lyrics-layer";
    // Marking underlines every character cell of a marked line
    // (its trailing end-of-line box is excluded, and a run carries no trailing
    // cell), so the decoration applies to the line's runs as a whole. Like the
    // chord case above, it is independent of marking mode.
    const markedLine = !!(occurrence.origin ?? occurrence.source).marked;
    // Coalesce contiguous same-styled glyphs into one span each. The per-glyph
    // `lyricRuns` above still feed the selection bands and the caret stops; only
    // the emitted DOM node count drops.
    for (const run of coalesceLyricRuns(rowLayout.lyricRuns, selection)) {
      const node = createLyricRunNode(this.doc, run.text, { font: occurrence.style.font, color: occurrence.style.color });
      if (this.input.differential) node.classList.add(`chp-dom-diff-${run.change}`);
      if (markedLine) node.classList.add("chp-dom-marked");
      if (run.selected) node.classList.add("chp-dom-selected");
      if (run.beforeStart != null) {
        node.dataset.beforeStart = String(run.beforeStart);
        node.dataset.beforeEnd = String(run.beforeEnd);
      }
      // Only current/equal text exposes the legacy editable source attributes.
      // A removed unit deliberately has no current offset.
      if (run.afterStart != null) {
        node.dataset.sourceStart = String(run.afterStart);
        node.dataset.sourceEnd = String(run.afterEnd);
        node.dataset.afterStart = String(run.afterStart);
        node.dataset.afterEnd = String(run.afterEnd);
      }
      node.style.left = `${run.x}px`;
      node.style.top = `${run.y}px`;
      node.style.height = `${plan.display.lyricsLineHeight}px`;
      node.style.lineHeight = `${plan.display.lyricsLineHeight}px`;
      lyricsLayer.appendChild(node);
    }
    row.appendChild(lyricsLayer);
    parent.appendChild(row);
  }

  private renderBlock(plan: DisplayPlan, occurrenceLayout: SongLayoutResult["occurrences"][number], parent: HTMLElement) {
    const occurrence = occurrenceLayout.source;
    const block = this.doc.createElement("div");
    block.className = `chp-dom-${occurrence.kind}`;
    block.style.height = `${occurrenceLayout.blockHeight ?? plan.display.lyricsLineHeight}px`;
    block.style.lineHeight = `${plan.display.lyricsLineHeight}px`;
    block.style.marginLeft = `${occurrence.style.indent}px`;
    block.style.font = occurrence.style.font;
    block.style.color = occurrence.style.color;
    block.style.textAlign = occurrence.style.align;
    if (occurrence.kind === "comment") {
      block.style.backgroundColor = plan.display.commentBg;
      if (occurrence.commentType === "box") block.classList.add("chp-dom-comment-box");
    }
    if (occurrence.kind === "abc") {
      const abc = this.abcNodes.get(occurrence.id);
      if (abc) {
        // Re-attach the owned container. The ABC library renders into it; its
        // generated markup is never read back or copied.
        abc.node.style.transform = `scale(${ABC_SCALE})`;
        abc.node.style.transformOrigin = "0 0";
        block.appendChild(abc.node);
      } else {
        // abcjs is still loading: keep the sized source placeholder, which is
        // what holds the layout unsettled until the real geometry exists.
        block.dataset.pending = "true";
        block.textContent = occurrence.text;
      }
      parent.appendChild(block);
      return;
    }
    if (occurrence.kind === "grid") {
      for (const run of occurrence.gridRuns) {
        if (run.kind === "text") {
          const text = this.doc.createElement("span");
          text.className = "chp-dom-grid-text";
          text.dataset.sourceStart = String(run.sourceStart);
          text.dataset.sourceEnd = String(run.sourceEnd);
          text.textContent = run.text;
          block.appendChild(text);
        } else {
          const chord = createChordNode(this.doc, run.id, run.visual, {
            font: plan.display.chordFont,
            color: plan.display.chordTextColor,
            unknownColor: plan.display.unknownChordTextColor,
          });
          chord.classList.add("chp-dom-grid-chord");
          chord.dataset.sourceStart = String(run.sourceStart);
          chord.dataset.sourceEnd = String(run.sourceEnd);
          chord.style.height = `${plan.display.chordLineHeight}px`;
          chord.style.lineHeight = `${plan.display.chordLineHeight}px`;
          block.appendChild(chord);
        }
      }
    } else this.appendDifferentialText(block, occurrence.textUnits, { font: occurrence.style.font, color: occurrence.style.color });
    parent.appendChild(block);
  }

  private appendDifferentialText(
    parent: HTMLElement,
    units: DisplayPlan["occurrences"][number]["textUnits"],
    style: { font: string; color?: string }
  ) {
    for (const unit of units) parent.appendChild(createDifferentialTextNode(this.doc, unit, style));
  }

  /** Returns a row-local x coordinate only when the source belongs to that row. */
  private rowSourceX(row: NonNullable<SongLayoutResult["occurrences"][number]["rows"]>[number], sourceOffset: number) {
    for (const run of row.lyricRuns) {
      if (sourceOffset < run.sourceStart || sourceOffset > run.sourceEnd) continue;
      const span = Math.max(1, run.sourceEnd - run.sourceStart);
      return run.x + ((sourceOffset - run.sourceStart) / span) * run.width;
    }
    return null;
  }
}
