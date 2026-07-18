import { UnicodeSymbol } from "../../common/symbols";
import { DifferentialText } from "../../common/utils";
import {
  ChordProAbc,
  ChordProChord,
  ChordProChordBase,
  ChordProCommentType,
  ChordProDocument,
  ChordProLine,
  ChordSystem,
  fixChordProText,
} from "../chordpro_base";
import { Instructions, type InstructionItem } from "../chordpro_instructions";
import type { ChordProDirectiveStyles, ChordProDisplayProperties } from "../chordpro_styles";
import { buildChordVisualModel, CHORDFORMAT_NOCHORDS, CHORDFORMAT_NOSECTIONDUP, CHORDFORMAT_SIMPLIFIED, type ChordVisualModel } from "./chord-visual";
import {
  differentialCoordinateToSource,
  differentialTextUnits,
  flattenDifferentialUnits,
  prefixDifferentialTextUnits,
  type DifferentialTextUnit,
} from "./differential";

export type DisplayLineKind = "lyrics" | "comment" | "grid" | "abc";

/** Mirrors `InstructionsRenderMode` without importing the editor controller. */
export type DisplayInstructionsMode = "" | "COMMENT" | "FIRST_LINE" | "FULL";
export type InstructionsPane = "source" | "preview";

/**
 * Why a projected row exists. `document` is the raw (non-instructed) sequence;
 * `section` is an instructed section body line; `label` and `ellipsis` are the
 * synthetic rows a repeat collapses to and carry instruction identity plus this
 * role instead of a source-line identity.
 */
export type DisplayOccurrenceRole = "document" | "section" | "label" | "ellipsis";

export interface SourceSpan {
  readonly start: number;
  readonly end: number;
  readonly duplicateOrdinal: number;
}

export interface SourceLineIdentity {
  readonly id: string;
  readonly sourceLineIndex: number;
}

export interface SourceChordIdentity {
  readonly id: string;
  readonly lineId: string;
  readonly span: SourceSpan;
}

export interface ResolvedLineVisualStyle {
  readonly font: string;
  readonly color: string;
  readonly indent: number;
  readonly align: "left" | "center" | "right";
}

export interface DisplayMeta {
  readonly id: string;
  readonly name: string;
  readonly text: string;
  readonly textUnits: readonly DifferentialTextUnit[];
  readonly font: string;
  readonly color: string;
  readonly height: number;
  readonly indent: number;
  readonly align: "left" | "center" | "right";
}

export interface DisplayTag {
  readonly name: string;
  readonly text: string;
  readonly textUnits: readonly DifferentialTextUnit[];
  readonly identity: string;
  readonly visible: boolean;
}

export interface DisplayChord {
  readonly id: string;
  readonly origin: SourceChordIdentity;
  readonly source: ChordProChord;
  readonly anchor: number;
  readonly previousAnchor?: number;
  readonly beforeStart?: number;
  readonly beforeEnd?: number;
  readonly afterStart?: number;
  readonly afterEnd?: number;
  readonly change: "equal" | "added" | "removed" | "moved";
  readonly visual: ChordVisualModel;
}

/** Thin instructions-view metadata; lyric/chord DOM remains renderer-owned. */
export interface InstructionsOccurrenceAdapter {
  readonly pane: InstructionsPane;
  readonly section: string;
  readonly dragTagName: string;
}

export type DisplayGridRun =
  | { readonly kind: "text"; readonly id: string; readonly text: string; readonly sourceStart: number; readonly sourceEnd: number }
  | {
      readonly kind: "chord";
      readonly id: string;
      readonly text: string;
      readonly sourceStart: number;
      readonly sourceEnd: number;
      readonly duplicateOrdinal: number;
      readonly visual: ChordVisualModel;
    };

export interface DisplayOccurrence {
  readonly id: string;
  readonly logicalLineId: string;
  /** Differential rows retain BOTH logical line identities in their occurrence key. */
  readonly beforeLogicalLineId?: string;
  readonly afterLogicalLineId?: string;
  readonly instructionItemId: string;
  readonly instructionGroupId: string;
  readonly repeatOrdinal: number;
  readonly role: DisplayOccurrenceRole;
  readonly displayOrdinal: number;
  readonly sourceLineIndex: number;
  /** The line actually rendered. For projections this is a clone, never a document object. */
  readonly source: ChordProLine;
  /** The persistent document line a projection came from, when one exists. */
  readonly origin: ChordProLine | null;
  /** Canvas-compatible instruction item index, used by highlight/section grouping. */
  readonly instructedSectionIndex?: number;
  readonly kind: DisplayLineKind;
  readonly style: ResolvedLineVisualStyle;
  readonly tag: DisplayTag | null;
  readonly text: string;
  readonly textUnits: readonly DifferentialTextUnit[];
  readonly commentType?: "normal" | "italic" | "box";
  readonly chords: readonly DisplayChord[];
  readonly gridRuns: readonly DisplayGridRun[];
  readonly suppressChords: boolean;
  readonly instructionsAdapter: InstructionsOccurrenceAdapter | null;
}

export interface DisplayPlan {
  readonly epoch: number;
  readonly documentId: string;
  readonly meta: readonly DisplayMeta[];
  readonly occurrences: readonly DisplayOccurrence[];
  readonly display: ChordProDisplayProperties;
  readonly chordFormat: number;
  readonly noteSystemCode: string;
  readonly key?: string;
  readonly showTags: boolean;
  readonly instructionsPane: InstructionsPane | null;
  /** Present only for an instructed projection. */
  readonly sectionGroups?: readonly number[];
  readonly sectionLabels?: readonly string[];
}

interface IndexedChord {
  readonly source: ChordProChord;
  readonly identity: SourceChordIdentity;
}

/**
 * Persistent identity is owned by one renderer instance. Array indices are
 * retained only as source data; they are never part of a line/chord key.
 */
export class DisplayIdentityRegistry {
  private epochValue = 0;
  private nextLine = 0;
  private nextChord = 0;
  private nextInstruction = 0;
  private readonly lines = new WeakMap<ChordProLine, SourceLineIdentity>();
  private readonly chords = new WeakMap<ChordProChord, SourceChordIdentity>();
  private readonly chordsBySpan = new Map<string, IndexedChord>();
  private instructionItems = new WeakMap<InstructionItem, string>();
  private documentRef: ChordProDocument | null = null;

  get epoch() {
    return this.epochValue;
  }

  get documentId() {
    return `e${this.epochValue}:document`;
  }

  /**
   * Stable identity for an instruction item object. Instruction items are keyed
   * by object identity rather than by their position in `Instructions.items`, so
   * inserting an earlier instruction does not rewrite the IDs of later ones.
   */
  instructionItem(item: InstructionItem): string {
    const existing = this.instructionItems.get(item);
    if (existing) return existing;
    const id = `e${this.epochValue}:i${this.nextInstruction++}`;
    this.instructionItems.set(item, id);
    return id;
  }

  /** Identity of a synthetic row that has instruction identity but no source line. */
  syntheticLineId(role: DisplayOccurrenceRole) {
    return `${this.documentId}:synthetic:${role}`;
  }

  startEpoch(document: ChordProDocument) {
    this.epochValue += 1;
    this.nextLine = 0;
    this.nextChord = 0;
    this.nextInstruction = 0;
    this.instructionItems = new WeakMap<InstructionItem, string>();
    this.indexDocument(document, true);
  }

  /**
   * Rebuilds the span index over the CURRENT state of the same document object.
   *
   * The editor mutates its `ChordProDocument` in place — inserting a chord,
   * moving one across lines, editing a label — so object identity alone cannot
   * tell the registry that `chordsBySpan` has gone stale. Lines and chords that
   * still exist keep their id, so the DOM reconciles rather than tearing down;
   * only genuinely new objects mint one.
   *
   * Without this, a chord created after the epoch began (template drop, `[`,
   * Alt+note, paste, the context menu) missed the WeakMap and then missed the
   * stale span index too, so `chord()` threw on the very next frame.
   */
  private indexDocument(document: ChordProDocument, fresh: boolean) {
    this.documentRef = document;
    this.chordsBySpan.clear();

    for (let sourceLineIndex = 0; sourceLineIndex < document.lines.length; sourceLineIndex += 1) {
      const line = document.lines[sourceLineIndex];
      const previousLine = fresh ? undefined : this.lines.get(line);
      const lineIdentity: SourceLineIdentity = { id: previousLine?.id ?? `e${this.epochValue}:l${this.nextLine++}`, sourceLineIndex };
      this.lines.set(line, lineIdentity);
      const duplicates = new Map<string, number>();
      for (const chord of line.chords) {
        const spanKey = `${chord.pos}:${chord.pos}`;
        const duplicateOrdinal = duplicates.get(spanKey) ?? 0;
        duplicates.set(spanKey, duplicateOrdinal + 1);
        const previousChord = fresh ? undefined : this.chords.get(chord);
        const identity: SourceChordIdentity = {
          id: previousChord?.id ?? `e${this.epochValue}:c${this.nextChord++}`,
          lineId: lineIdentity.id,
          span: { start: chord.pos, end: chord.pos, duplicateOrdinal },
        };
        this.chords.set(chord, identity);
        this.chordsBySpan.set(this.spanKey(identity.lineId, identity.span), { source: chord, identity });
      }
    }
  }

  ensureDocument(document: ChordProDocument) {
    if (this.documentRef !== document) this.startEpoch(document);
    else this.indexDocument(document, false);
  }

  line(line: ChordProLine): SourceLineIdentity {
    const identity = this.lines.get(line);
    if (!identity) throw new Error("Display identity requested for a line outside the current document epoch");
    return identity;
  }

  chord(chord: ChordProChord): SourceChordIdentity {
    const identity = this.chords.get(chord);
    if (identity) return identity;

    // A parser/controller refresh may replace a chord object while retaining
    // its logical source location. Remap only by the explicit UTF-16 span and
    // duplicate ordinal within that span — never by label or anchor alone.
    const lineIdentity = this.line(chord.line);
    let duplicateOrdinal = 0;
    for (const candidate of chord.line.chords) {
      if (candidate === chord) break;
      if (candidate.pos === chord.pos) duplicateOrdinal += 1;
    }
    const span = { start: chord.pos, end: chord.pos, duplicateOrdinal };
    const indexed = this.chordsBySpan.get(this.spanKey(lineIdentity.id, span));
    if (!indexed) throw new Error("Display identity requested for a chord outside the current document epoch");
    this.chords.set(chord, indexed.identity);
    this.chordsBySpan.set(this.spanKey(lineIdentity.id, span), { source: chord, identity: indexed.identity });
    return indexed.identity;
  }

  remapChord(lineId: string, span: SourceSpan): ChordProChord | null {
    return this.chordsBySpan.get(this.spanKey(lineId, span))?.source ?? null;
  }

  private spanKey(lineId: string, span: SourceSpan) {
    return `${lineId}:${span.start}:${span.end}:${span.duplicateOrdinal}`;
  }
}

/** Projection range currently highlighted by the controller. */
export interface DisplayHighlight {
  readonly from: number;
  readonly to: number;
  readonly section?: number;
  readonly repeatIndex?: number;
  readonly repeatTotal?: number;
}

/**
 * Returns true if a displayed occurrence is covered by the stored projection
 * range:
 *
 * - Occurrences with no `instructedSectionIndex` (raw rendering) ignore the
 *   section filter and match on the source-line range alone.
 * - Ellipsis-preview rows (`sourceLineNumber === -1`) light up ONLY when the
 *   projection targets that exact preview's instruction item, never when it
 *   targets the original expanded block or another repeat.
 * - Normal instructed rows light up when their repeat group matches the
 *   projected section's group AND the source line falls in `[from, to)`.
 */
export function isHighlightedOccurrence(
  occurrence: DisplayOccurrence,
  highlight: DisplayHighlight | null,
  groups: readonly number[] | undefined
): boolean {
  if (!highlight) return false;
  const line = occurrence.source;
  const hlSection = highlight.section;
  if (line.sourceLineNumber === -1) {
    // Ellipsis-preview rows: exact instruction-item match only.
    return hlSection != null && line.instructedSectionIndex === hlSection;
  }
  if (hlSection != null && line.instructedSectionIndex != null) {
    const lineGroup = groups?.[line.instructedSectionIndex] ?? line.instructedSectionIndex;
    const hlGroup = groups?.[hlSection] ?? hlSection;
    if (lineGroup !== hlGroup) return false;
  }
  return line.sourceLineNumber >= highlight.from && line.sourceLineNumber < highlight.to;
}

/** One row of the resolved display sequence, before any measurement exists. */
export interface ProjectedLine {
  /** The line to render. For an instructed/transposed projection this is a clone. */
  readonly line: ChordProLine;
  /** The persistent document line this row was projected from, if any. */
  readonly origin: ChordProLine | null;
  readonly item: InstructionItem | null;
  readonly instructionIndex?: number;
  readonly role: DisplayOccurrenceRole;
}

export interface DisplaySequence {
  readonly lines: readonly ProjectedLine[];
  /** True when an instruction list produced the sequence, false for raw document order. */
  readonly instructed: boolean;
  /** Canvas-compatible highlight grouping, present only for an instructed sequence. */
  readonly groups?: number[];
  readonly labels?: string[];
}

export interface ProjectDisplaySequenceOptions {
  readonly document: ChordProDocument;
  readonly readOnly: boolean;
  readonly instructionsMode: DisplayInstructionsMode;
  readonly instructions?: Instructions | null;
}

function genInstructionComment(document: ChordProDocument, text: string, type: ChordProCommentType = "") {
  const line = new ChordProLine(document);
  line.setCommentDirectiveType(type);
  line.setLyrics(fixChordProText(text));
  line.genText();
  return line;
}

function projectInstructedSequence(options: ProjectDisplaySequenceOptions, instructions: Instructions): DisplaySequence {
  const document = options.document;
  const firstLines = new Map<string, ProjectedLine | null>();
  const groupFirstIndex = new Map<string, number>();
  const groups: number[] = new Array(instructions.items.length);
  const labels: string[] = new Array(instructions.items.length);
  const lines: ProjectedLine[] = [];

  for (let i = 0; i < instructions.items.length; ++i) {
    const item = instructions.items[i];
    groups[i] = i;
    labels[i] = (item.value ?? "").trim();
    if (item.multiplier == null) {
      const line = genInstructionComment(document, item.value, "italic");
      line.instructedSectionIndex = i;
      lines.push({ line, origin: null, item, instructionIndex: i, role: "label" });
      continue;
    }

    // Key by section value AND effective transpose so a same-section repeat with a
    // different transpose still emits the full transposed block, while a repeat
    // with the same transpose collapses to the first-line preview / label comment.
    const repeatKey = item.value + "@" + (item.transpose ?? 0);
    const groupFirst = groupFirstIndex.get(repeatKey);
    // FULL renders each repeat as its own full section, so every occurrence keeps
    // its own highlight group; other modes share the first occurrence's group so
    // the highlight covers the original block and its preview/label together.
    if (groupFirst != null && options.instructionsMode !== "FULL") groups[i] = groupFirst;
    else if (groupFirst == null) groupFirstIndex.set(repeatKey, i);

    if (!firstLines.has(repeatKey) || options.instructionsMode === "FULL") {
      let firstLine: ProjectedLine | null = null;
      for (const origin of document.lines) {
        if (!Instructions.matchesSection(origin, item)) continue;
        const line = origin instanceof ChordProAbc ? origin.toGrid(true) : origin.clone(true);
        line.multiplierOverride = item.multiplier;
        if (item.transpose) {
          line.transposeOverride = item.transpose;
          line.transpose(item.transpose);
        }
        line.instructedSectionIndex = i;
        const projected: ProjectedLine = { line, origin, item, instructionIndex: i, role: "section" };
        if (!firstLine) firstLine = projected;
        lines.push(projected);
      }
      if (!firstLines.has(repeatKey)) firstLines.set(repeatKey, firstLine);
      continue;
    }

    if (options.instructionsMode === "FIRST_LINE") {
      const first = firstLines.get(repeatKey);
      if (first) {
        const line = first.line.clone();
        line.insertString(line.text.length, " ...");
        line.multiplierOverride = item.multiplier;
        line.sourceLineNumber = -1; // to prevent from highlight via from/to
        line.instructedSectionIndex = i;
        lines.push({ line, origin: first.origin, item, instructionIndex: i, role: "ellipsis" });
        continue;
      }
    }
    const line = genInstructionComment(document, item.value + (item.multiplier > 1 ? ` ${item.multiplier}x` : ""));
    line.instructedSectionIndex = i;
    lines.push({ line, origin: null, item, instructionIndex: i, role: "label" });
  }

  return { lines, instructed: true, groups, labels };
}

/**
 * Resolves the readonly display sequence: the instructed projection when one
 * applies, otherwise raw document order with authored section-tag transpose
 * modifiers (e.g. `{soc: Chorus +2}`) applied so displayed chords reflect the
 * transpose without requiring the instructions feature.
 *
 * This is the single owner of that decision.
 */
export function projectDisplaySequence(options: ProjectDisplaySequenceOptions): DisplaySequence {
  const document = options.document;
  const rawSequence = (): DisplaySequence => ({
    lines: document.lines.map((origin) => ({ line: origin, origin, item: null, role: "document" as const })),
    instructed: false,
  });

  if (!options.readOnly) return rawSequence();

  if (options.instructionsMode) {
    let instructions = options.instructions ?? null;
    if (!instructions) {
      // With no explicit instructions bound, fall back to the song's built-in
      // defaults (comments + section list) so `{c: …}` directive comments are
      // still honored without the playlist carrying an instructions string.
      const defaultStr = document.getDefaultInstructions();
      if (defaultStr) {
        instructions = new Instructions();
        instructions.parse(defaultStr, document);
      }
    }
    if (instructions) return projectInstructedSequence(options, instructions);
  }

  let mutated = false;
  const lines: ProjectedLine[] = document.lines.map((origin) => {
    const transpose = origin.getSectionInfo().transpose;
    if (!transpose) return { line: origin, origin, item: null, role: "document" as const };
    const line = origin instanceof ChordProAbc ? origin.toGrid(true) : origin.clone(true);
    line.transpose(transpose);
    mutated = true;
    return { line, origin, item: null, role: "document" as const };
  });
  return mutated ? { lines, instructed: false } : rawSequence();
}

export interface BuildDisplayPlanOptions {
  readonly document: ChordProDocument;
  readonly identities: DisplayIdentityRegistry;
  readonly system: ChordSystem;
  readonly display: ChordProDisplayProperties;
  readonly directives: ChordProDirectiveStyles;
  readonly chordFormat: number;
  readonly showTitle: boolean;
  readonly showMeta: boolean;
  readonly showTags: boolean;
  readonly abbreviateTags: boolean;
  readonly readOnly: boolean;
  /** Enables explicit before/after coordinates for the Compare middle pane. */
  readonly differential?: boolean;
  readonly instructionsMode?: DisplayInstructionsMode;
  readonly instructions?: Instructions | null;
  readonly instructionsPane?: InstructionsPane;
  /** Pre-resolved sequence. Supplied by the controller so the projection is computed once. */
  readonly sequence?: DisplaySequence;
  readonly keyIsAuto?: boolean;
  readonly localize?: (key: string) => string;
}

function safeNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function alignment(value: string | undefined): "left" | "center" | "right" {
  return value === "center" || value === "right" ? value : "left";
}

function abbreviate(full: string) {
  let result = "";
  const multiplier = full.match(/(.*)[ \t]+([0-9]+)[xX*]$/);
  const parts = (multiplier ? multiplier[1] : full).split(" ");
  for (const part of parts) if (part.trim()) result += part.trim().slice(0, 1);
  if (multiplier) result += ` ${multiplier[2]}x`;
  return result;
}

function resolveLineStyle(line: ChordProLine, display: ChordProDisplayProperties, directives: ChordProDirectiveStyles): ResolvedLineVisualStyle {
  let font = display.lyricsFont;
  let color = display.lyricsTextColor;
  let indent = 0;
  let align: "left" | "center" | "right" = "left";
  line.styles.forEach((_value, name) => {
    const style = directives[name];
    if (!style) return;
    if (style.font) font = style.font;
    if (style.fg) color = style.fg;
    indent += safeNumber(style.indent);
    if (style.align) align = alignment(style.align);
  }, true);
  const commentType = line.getCommentType();
  if (commentType) {
    color = display.commentFg;
    if (commentType === "italic" && !/^italic\b/i.test(font)) font = `italic ${font}`;
  }
  return { font, color, indent, align };
}

function formatMetaKey(system: ChordSystem, value: string, keyIsAuto: boolean) {
  const key = system.getKey(value);
  let text = value.replace(/[#b]/g, (part) => (part === "#" ? UnicodeSymbol.sharp : UnicodeSymbol.flat));
  if (key?.signature) {
    const sign = key.signature > 0 ? UnicodeSymbol.sharp : UnicodeSymbol.flat;
    const count = Math.abs(key.signature) < 2 ? "" : String(Math.abs(key.signature));
    text += ` ${UnicodeSymbol.musicScore}${count}${sign}`;
  }
  if (keyIsAuto) text += ` ${UnicodeSymbol.robot}`;
  return text;
}

function buildMeta(options: BuildDisplayPlanOptions): DisplayMeta[] {
  const result: DisplayMeta[] = [];
  for (const [name, style] of Object.entries(options.directives)) {
    if (
      name.startsWith("start_of_") ||
      !style ||
      style.hidden ||
      !style.height ||
      (!options.document.hasMeta(name) && !(options.differential && options.document.hasMeta(name, false)))
    )
      continue;
    if (name === "title" ? !options.showTitle : !options.showMeta) continue;
    let value: string | DifferentialText = options.differential ? options.document.differentialMeta(name) : options.document.getMeta(name);
    if (name === "key" && typeof value === "string") value = formatMetaKey(options.system, value, !!options.keyIsAuto);
    const prefix = style.prefix ? `${style.prefix}:\u00a0` : "";
    const textUnits = prefixDifferentialTextUnits(prefix, differentialTextUnits(value));
    result.push({
      id: `${options.identities.documentId}:meta:${name}`,
      name,
      text: flattenDifferentialUnits(textUnits),
      textUnits,
      font: style.font || options.display.lyricsFont,
      color: style.fg || options.display.lyricsTextColor,
      height: style.height,
      indent: safeNumber(style.indent),
      align: alignment(style.align),
    });
  }
  return result;
}

function tagForLine(line: ChordProLine, options: BuildDisplayPlanOptions, sectionLabels: readonly string[] | undefined, previousIdentity: string) {
  // ABC blocks never show a section label; they carry their own R: header.
  if (line instanceof ChordProAbc) return null;
  const info = line.getTagInfo(!!options.differential);
  if (!info.name) return null;
  let sourceText: string | DifferentialText = info.tag;
  let text = typeof sourceText === "string" ? sourceText : sourceText.flatten();
  let identity = text;

  // Grid sections often use `{start_of_grid}` without an explicit label. Prefer
  // the instruction label for the section, then a localized fallback, so the
  // section still appears in the tag column.
  if (info.name === "start_of_grid" && !text.trim()) {
    const instructedLabel = line.instructedSectionIndex != null ? (sectionLabels?.[line.instructedSectionIndex] ?? "").trim() : "";
    text = instructedLabel || options.localize?.("Grid") || "Grid";
    sourceText = text;
    identity = text;
  }

  // In readonly rendering the transpose modifier is hidden from the label (the
  // transpose is already reflected in the displayed chords) while multiplier
  // overrides stay visible. The identity keeps the transpose so a same-section
  // repeat at a different transpose still emits a fresh header.
  if (options.readOnly) {
    const section = line.getSectionInfo();
    const effectiveTranspose = line.transposeOverride ?? section.transpose;
    if (effectiveTranspose != null) {
      let stripped = section.withoutModifiers();
      const effectiveMultiplier = line.multiplierOverride ?? section.multiplier;
      if (effectiveMultiplier != null && effectiveMultiplier > 1) stripped += ` ${effectiveMultiplier}x`;
      text = stripped;
      sourceText = text;
      identity = `${stripped}@${effectiveTranspose}`;
    }
  }

  if (options.abbreviateTags) {
    text = abbreviate(text);
    sourceText = text;
  }
  return {
    name: info.name,
    text,
    textUnits: differentialTextUnits(sourceText),
    identity,
    visible: !!text && identity !== previousIdentity,
  } satisfies DisplayTag;
}

function occurrenceId(
  logicalLineId: string,
  instructionItemId: string,
  instructionGroupId: string,
  repeatOrdinal: number,
  differential?: { readonly before?: string; readonly after?: string }
) {
  const differentialKey = differential ? `|before:${differential.before ?? "none"}|after:${differential.after ?? "none"}` : "";
  return `${logicalLineId}${differentialKey}|instruction:${instructionItemId}|group:${instructionGroupId}|repeat:${repeatOrdinal}`;
}

function instructionsAdapterForLine(line: ChordProLine, pane: InstructionsPane | undefined): InstructionsOccurrenceAdapter | null {
  if (!pane) return null;
  const info = line.getTagInfo();
  const section = typeof info.tag === "string" ? info.tag : info.tag.flatten();
  if (!section) return null;
  return { pane, section, dragTagName: section };
}

function buildGridRuns(id: string, line: ChordProLine, options: BuildDisplayPlanOptions): DisplayGridRun[] {
  const runs: DisplayGridRun[] = [];
  let sourceOffset = 0;
  const duplicates = new Map<string, number>();
  const pushText = (text: string) => {
    if (!text) return;
    const start = sourceOffset;
    sourceOffset += text.length;
    runs.push({ kind: "text", id: `${id}|grid:text:${start}-${sourceOffset}`, text, sourceStart: start, sourceEnd: sourceOffset });
  };
  options.system.findAllChords(line.lyrics, (chordText, prefix, suffix) => {
    pushText(prefix);
    const start = sourceOffset;
    sourceOffset += chordText.length;
    const spanKey = `${start}:${sourceOffset}`;
    const duplicateOrdinal = duplicates.get(spanKey) ?? 0;
    duplicates.set(spanKey, duplicateOrdinal + 1);
    const chord = new ChordProChordBase(options.system, chordText);
    runs.push({
      kind: "chord",
      id: `${id}|grid:chord:${start}-${sourceOffset}:${duplicateOrdinal}`,
      text: chordText,
      sourceStart: start,
      sourceEnd: sourceOffset,
      duplicateOrdinal,
      visual: buildChordVisualModel({
        chord,
        chordDetails: options.system.getChordDetails(chord, (options.chordFormat & CHORDFORMAT_SIMPLIFIED) === CHORDFORMAT_SIMPLIFIED),
        system: options.system,
        chordFormat: options.chordFormat,
        readOnly: true,
        actualKey: options.document.key,
      }),
    });
    pushText(suffix);
  });
  if (runs.length === 0) pushText(line.lyrics);
  return runs;
}

/**
 * Builds the readonly display plan for the raw or instructed sequence. No DOM is
 * read or written.
 *
 * Identity rule: projected rows render a clone, but every identity is resolved
 * from the persistent document object the clone came from, which the registry
 * indexed before any projection existed. Clone identity is never a key.
 */
export function buildDisplayPlan(options: BuildDisplayPlanOptions): DisplayPlan {
  options.identities.ensureDocument(options.document);
  const identities = options.identities;
  const sequence =
    options.sequence ??
    projectDisplaySequence({
      document: options.document,
      readOnly: options.readOnly,
      instructionsMode: options.instructionsMode ?? "",
      instructions: options.instructions,
    });
  const occurrences: DisplayOccurrence[] = [];
  let previousTagIdentity = "";
  const noChords = (options.chordFormat & CHORDFORMAT_NOCHORDS) === CHORDFORMAT_NOCHORDS;
  const noSectionDuplicates = (options.chordFormat & CHORDFORMAT_NOSECTIONDUP) === CHORDFORMAT_NOSECTIONDUP;
  const repeatOrdinals = new Map<string, number>();
  const itemByInstructionIndex = new Map<number, InstructionItem>();
  for (const entry of sequence.lines)
    if (entry.instructionIndex != null && entry.item) itemByInstructionIndex.set(entry.instructionIndex, entry.item);

  for (const projected of sequence.lines) {
    const line = projected.line;
    if (noChords && line.isInstrumental) continue;
    const displayOrdinal = occurrences.length;
    const kind: DisplayLineKind = line instanceof ChordProAbc ? "abc" : line.isComment ? "comment" : line.isGrid ? "grid" : "lyrics";
    const sourceText: string | DifferentialText =
      kind === "abc" ? (line as ChordProAbc).getAbc() : options.differential ? line.lyricsData : line.lyrics;
    const textUnits = differentialTextUnits(sourceText);
    const text = flattenDifferentialUnits(textUnits);

    // Synthetic instruction rows have no source-line identity, so they are keyed
    // by instruction identity plus their semantic role. An ellipsis preview is
    // still a clone of a real section line, so its CHORDS keep resolving through
    // that persistent origin — only the row identity is synthetic.
    const synthetic = projected.role === "label" || projected.role === "ellipsis";
    const originLine = synthetic ? null : projected.origin;
    const chordOriginLine = projected.origin;
    const originIdentity = originLine ? identities.line(originLine) : null;
    const logicalLineId = originIdentity?.id ?? identities.syntheticLineId(projected.role);
    const differentialLines = options.differential
      ? {
          before: textUnits.some((unit) => unit.beforeStart != null)
            ? `e${identities.epoch}:before:l${originIdentity?.sourceLineIndex ?? displayOrdinal}`
            : undefined,
          after: textUnits.some((unit) => unit.afterStart != null)
            ? `e${identities.epoch}:after:l${originIdentity?.sourceLineIndex ?? displayOrdinal}`
            : undefined,
        }
      : undefined;
    const instructionItemId = projected.item ? identities.instructionItem(projected.item) : "document";
    const groupIndex = projected.instructionIndex != null ? (sequence.groups?.[projected.instructionIndex] ?? projected.instructionIndex) : null;
    const groupItem = groupIndex != null ? itemByInstructionIndex.get(groupIndex) : null;
    const instructionGroupId = groupItem ? identities.instructionItem(groupItem) : instructionItemId;
    const repeatKey = `${logicalLineId}|${instructionItemId}`;
    const repeatOrdinal = repeatOrdinals.get(repeatKey) ?? 0;
    repeatOrdinals.set(repeatKey, repeatOrdinal + 1);
    const id = occurrenceId(logicalLineId, instructionItemId, instructionGroupId, repeatOrdinal, differentialLines);

    const tag = noChords ? null : tagForLine(line, options, sequence.labels, previousTagIdentity);
    if (tag?.text && tag.identity) previousTagIdentity = tag.identity;
    const duplicateSection = noSectionDuplicates && !!options.document.sectionInfo.get(line.getTagInfo().key)?.duplicate;
    const suppressChords = noChords || duplicateSection;
    const chords = suppressChords
      ? []
      : line.chords.map((chord, chordIndex) => {
          // `copyLineData` clones chords positionally, so index `chordIndex` in a
          // projection always corresponds to the same index on the origin line.
          // Identity therefore comes from the origin chord, never from the clone.
          const identitySource = chordOriginLine ? (chordOriginLine.chords[chordIndex] ?? chord) : chord;
          const origin = identities.chord(identitySource);
          const beforeStart = options.differential ? (chord.added === true ? undefined : chord.prevPos) : chord.pos;
          const afterStart = options.differential ? (chord.added === false ? undefined : chord.pos) : chord.pos;
          const anchorSide = afterStart != null ? "after" : "before";
          const anchorOffset = afterStart ?? beforeStart ?? chord.pos;
          const change = chord.moved ? "moved" : chord.added === true ? "added" : chord.added === false ? "removed" : "equal";
          return {
            id: `${id}|${origin.id}`,
            origin,
            source: chord,
            anchor: differentialCoordinateToSource(textUnits, anchorSide, anchorOffset),
            ...(chord.moved && beforeStart != null ? { previousAnchor: differentialCoordinateToSource(textUnits, "before", beforeStart) } : {}),
            ...(beforeStart != null ? { beforeStart, beforeEnd: beforeStart } : {}),
            ...(afterStart != null ? { afterStart, afterEnd: afterStart } : {}),
            change,
            visual: buildChordVisualModel({
              chord,
              chordDetails: options.system.getChordDetails(chord, (options.chordFormat & CHORDFORMAT_SIMPLIFIED) === CHORDFORMAT_SIMPLIFIED),
              system: options.system,
              chordFormat: options.chordFormat,
              readOnly: true,
              actualKey: options.document.key,
            }),
          } satisfies DisplayChord;
        });
    occurrences.push({
      id,
      logicalLineId,
      ...(differentialLines?.before ? { beforeLogicalLineId: differentialLines.before } : {}),
      ...(differentialLines?.after ? { afterLogicalLineId: differentialLines.after } : {}),
      instructionItemId,
      instructionGroupId,
      repeatOrdinal,
      role: projected.role,
      displayOrdinal,
      sourceLineIndex: originIdentity?.sourceLineIndex ?? -1,
      source: line,
      origin: projected.origin,
      instructedSectionIndex: line.instructedSectionIndex,
      kind,
      style: resolveLineStyle(line, options.display, options.directives),
      tag,
      text,
      textUnits,
      commentType: line.getCommentType(),
      chords,
      gridRuns: kind === "grid" ? buildGridRuns(id, line, options) : [],
      suppressChords,
      instructionsAdapter: instructionsAdapterForLine(line, options.instructionsPane),
    });
  }

  return {
    epoch: identities.epoch,
    documentId: identities.documentId,
    meta: buildMeta(options),
    occurrences,
    display: options.display,
    chordFormat: options.chordFormat,
    noteSystemCode: options.system.systemCode,
    key: options.document.key || undefined,
    showTags: options.showTags,
    instructionsPane: options.instructionsPane ?? null,
    sectionGroups: sequence.groups,
    sectionLabels: sequence.labels,
  };
}
