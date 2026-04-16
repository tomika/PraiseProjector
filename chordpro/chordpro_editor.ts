import {
  ChordProDocument,
  ChordProChord,
  ChordProChordBase,
  ChordProLine,
  ChordProLineRange,
  ChordProMovableItemInfo,
  LyricsCharInfo,
  ChordSystem,
  ChordProWordInfo,
  ChordProLineWords,
  ChordProProperties,
  ChordProCommentType,
  ChordProAbc,
  fixChordProText,
} from "./chordpro_base";
import {
  ChordProDirectiveStyle,
  ChordProDirectiveStyles,
  ChordProDisplayProperties,
  ChordProStylesSettings,
  cloneDirectiveStyles,
  cloneDisplayProperties,
  defaultDisplayProperties,
  defaultStyles,
} from "./chordpro_styles";
import { getKeyCodeString } from "./keycodes";
import { calcBestPositions, ItemToPosition } from "./placer";
import { ChordSelector } from "./chord_selector";
import { Instrument, playChord, playMidiFile } from "./midi";
import { isVowel, knownVowelChars, removeDiacretics, simplifyString, splitTextToWords } from "../common/stringTools";
import {
  arrayBufferToBase64,
  createDivElement,
  DifferentialText,
  DiffTextPreProcessor,
  makeDark,
  VersionedMap,
  virtualKeyboard,
} from "../common/utils";
import * as clipboard from "./clipboard";
import { ChordDetails, Key, Mode } from "./note_system";
import { UnicodeSymbol } from "../common/symbols";
import { Settings } from "../common/settings";
import { NoteHitBox, Point, Rectangle, Size } from "./ui_base";
import {
  ChordBoxType,
  ChordDrawer,
  CHORDFORMAT_INKEY,
  CHORDFORMAT_NOCHORDS,
  CHORDFORMAT_NOMMOL,
  CHORDFORMAT_NOSECTIONDUP,
  CHORDFORMAT_SIMPLIFIED,
  CHORDFORMAT_SUBSCRIPT,
} from "./chord_drawer";

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

type WrapChunkBase = { text: string; breakCost?: number; overlay?: Rectangle };
type WrapChunk = WrapChunkBase & { x: number; width: number; line: ChordProLine };
type WrapChunkLine = Rectangle & { chunks: WrapChunk[] };

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

function make_abbrev(full: string) {
  let a = "";
  const m = full.match(/(.*)[ \t]+([0-9]+)[xX*]$/);
  const sa = (m ? m[1] : full).split(" ");
  for (let i = 0; i < sa.length; ++i) {
    const s = sa[i].trim();
    if (s) a += s.substr(0, 1);
  }
  if (m) a += " " + m[2] + "x";
  return a;
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

class ChordProMetaHitBox extends ChordProHitBox {
  constructor(
    left: number,
    top: number,
    width: number,
    height: number,
    public readonly key: string
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

type ActionTarget =
  | ChordProChord
  | ChordProLine
  | ChordProChordHitBox
  | ChordProTagHitBox
  | ChordProLineHitBox
  | ChordProMetaHitBox
  | ChordTemplateHitBox
  | null;

const canvases = new Map<HTMLDivElement, HTMLCanvasElement>();

export type InstructionItem = { value: string; multiplier?: number };
export class Instructions {
  constructor(readonly items: InstructionItem[] = []) {}
  format() {
    this.normalize();
    return this.items.map((x) => x.value + ((x.multiplier ?? 0) > 1 ? " " + x.multiplier + "x" : "")).join("\n");
  }
  parse(data: string, sections: string[]) {
    try {
      data = JSON.parse('"' + data + '"');
    } catch {
      // ignore parse errors
    }
    this.items.splice(0, this.items.length);
    const sectionNames = new Map(sections.map((x) => [x.trim().toLocaleLowerCase(), x.trim()]));
    for (const line of data.split("\n")) {
      const trimmedLine = line.trim();
      const m = /^(.*)[ \t]+([0-9]+)[*xX]$/.exec(trimmedLine);
      const item: InstructionItem = { value: trimmedLine };
      let sectionName: string | undefined;
      if (m && (sectionName = sectionNames.get(m[1].toLowerCase()))) {
        item.multiplier = parseInt(m[2], 10);
        if (item.multiplier < 1) item.multiplier = undefined;
        item.value = sectionName;
      } else if ((sectionName = sectionNames.get(trimmedLine.toLowerCase()))) {
        item.multiplier = 1;
        item.value = sectionName;
      }
      this.items.push(item);
    }
    this.normalize();
  }
  normalize(index?: number) {
    let normalized_index = index ?? -1;
    for (let i = 0; i < this.items.length; ++i) {
      const item = this.items[i];
      if (item.multiplier != null) {
        let next: InstructionItem | undefined;
        while ((next = this.items[i + 1])?.multiplier != null && item.value === next.value) {
          item.multiplier += next.multiplier;
          this.items.splice(i + 1, 1);
          if (normalized_index >= i + 1) --normalized_index;
        }
      }
    }
    return normalized_index >= 0 ? normalized_index : undefined;
  }
  insertBefore(item: InstructionItem, before: InstructionItem, normalize = true) {
    const i = this.items.indexOf(before);
    this.items.splice(i, 0, item);
    return normalize ? this.normalize(i) : i;
  }
  insertAfter(item: InstructionItem, after: InstructionItem, normalize = true) {
    const i = this.items.indexOf(after);
    this.items.splice(i + 1, 0, item);
    return normalize ? this.normalize(i + 1) : i + 1;
  }
  deleteItem(item: InstructionItem, normalize = true) {
    const i = this.items.indexOf(item);
    if (i >= 0) this.items.splice(i, 1);
    if (normalize) this.normalize();
  }
  add(item: InstructionItem, normalize = true) {
    this.items.push(item);
    if (normalize) this.normalize();
    return this.items.length - 1;
  }
}

export type InstructionsRenderMode = "" | "COMMENT" | "FIRST_LINE";
export type HighlightingParams = { lyrics: string; from: number; to: number; section?: number };

export class ChordProEditor extends ChordDrawer {
  private chordPro: ChordProDocument | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private maxUndoSize = 1000;
  private undoBuffer: ChordProEditorState[] = [];
  private redoBuffer: ChordProEditorState[] = [];
  private currentShift = 0;
  private instructions?: Instructions;
  private instructedLines?: ChordProLine[];

  private systemPasteContent = "";
  private clipboardTextArea: HTMLTextAreaElement | null = null;
  private ownsClipboardTextArea = false;
  private removeTouchEvents: (() => void) | null = null;
  private lastMouseDownHadHit = false;
  private touchActive = false;
  private keyEventTarget: HTMLElement | null = null;
  private composing = false;
  private cursorBlinkHandle: number | null = null;
  private pendingDrawHandle: number | null = null;
  private pendingCanvasFocusAfterMetaBlur = false;
  private windowPasteListenerAttached = false;
  private disposed = false;
  private contextMenuElement: HTMLDivElement | null = null;
  private readonly handleContextMenu = (e: MouseEvent) => {
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
  private readonly handleCanvasFocus = () => {
    if (this.textarea) this.textarea.focus({ preventScroll: true });
    else this.parent_div.focus({ preventScroll: true });
  };
  onCopy: ((plain: string, chordpro: string) => void) | null = null;
  onPaste: (() => void) | null = null;

  onLog: ((s: string) => void) | null = null;
  onLineSel: ((line: number) => void) | null = null;
  onLineDblclk: ((line: number) => void) | null = null;
  onChange: ((chordProCode: string) => void) | null = null;
  onLyricsHit: ((hit: HighlightingParams) => void) | null = null;

  targetRatio = 0;
  displayProps: ChordProDisplayProperties;
  canvas: HTMLCanvasElement;
  scale: number;

  private showTitle = true;
  private showMeta = true;
  private showTag = true;
  private abbrevTag = false;
  private autoSplitLines = false;
  private displayNormalizedChord = false;
  private differentialDisplay = false;
  private instructionsRenderMode: InstructionsRenderMode = "";
  private instructionEditorActive = false;

  private directiveStyles: ChordProDirectiveStyles;
  private customStyles: ChordProStylesSettings | null = null;
  private keyIsAuto = false;

  private inApplyState = false;
  private multiChordChangeEnabled = true;
  private currentlyMarked?: Set<ChordProLine | ChordProChord>;
  private chordBoxType: ChordBoxType = "";
  private highlighted: { from: number; to: number } | null = null;
  private lastMouseDown: { x: number; y: number } | null = null;
  private prevClickTime = 0;

  private prevText = "";
  private metaMeasureSpan: HTMLSpanElement | null = null;
  private actionTarget: ActionTarget = null;

  private cursorPos: number | null = null;
  private selectionStart: number | ChordProSelection | null = null;
  private selectionEnd: number | ChordProSelection | null = null;
  private boxes: ChordProHitBox[] = [];
  private displayedLines: ChordProLine[] = [];
  private dragData: ChordProDragStart | ChordProSelection | number | null = null;
  private tagWidth = 0;

  private metaContainer: HTMLDivElement | null = null;
  private metaInputs = new Map<string, { row: HTMLDivElement; prefix: HTMLSpanElement; value: HTMLInputElement }>();

  private chordStripContainer: HTMLDivElement | null = null;
  private chordStripItems = new Map<string, HTMLDivElement>();
  private chordStripBaseTop = 0;
  private overlayCanvasLeft = 0;
  private overlayCanvasTop = 0;

  private chordBoxContainer: HTMLDivElement | null = null;
  private chordBoxElements = new Map<string, HTMLCanvasElement>();
  private abcContainer: HTMLDivElement | null = null;
  private abcDivElements = new Map<ChordProAbc, HTMLDivElement>();
  private canvasResizeObserver: ResizeObserver | null = null;
  private lastCanvasOffsetWidth = 0;

  private cursorBox: { left: number; top: number; width: number; height: number } | null = null;
  private chordStripWidth = 0;
  private tagsStripWidth = 0;
  private maxDrawTime = 0;
  private readonly rxStartsWithChord: RegExp;

  private midiPlayer?: ReturnType<typeof playMidiFile>;
  private localeHandler?: (s: string) => string;

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
    private readonly bCorrectParentScroll = true
  ) {
    super(system, chordSelector, !editable);
    this.rxStartsWithChord = new RegExp("^" + system.chordLikeRegexPattern);

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
    let canvas = canvases.get(this.parent_div);
    if (!canvas) {
      const existingCanvases = this.parent_div.getElementsByTagName("canvas");
      if (existingCanvases?.length !== 1) {
        canvas = document.createElement("canvas") as HTMLCanvasElement;
        canvas.className = "chordpro-editor-canvas";
        this.parent_div.appendChild(canvas);
      } else canvas = existingCanvases[0];
      canvases.set(this.parent_div, canvas);
    }
    canvas.removeEventListener("focus", this.handleCanvasFocus);
    canvas.onfocus = null;
    this.canvas = canvas;
    this.canvas.addEventListener("focus", this.handleCanvasFocus);

    // Auto-redraw overlays when canvas transitions from hidden to visible
    this.canvasResizeObserver?.disconnect();
    this.lastCanvasOffsetWidth = 0;
    this.canvasResizeObserver = new ResizeObserver(() => {
      const w = this.canvas.offsetWidth;
      const wasHidden = this.lastCanvasOffsetWidth === 0;
      this.lastCanvasOffsetWidth = w;
      if (w > 0) {
        if (wasHidden) this.draw();
        else this.syncOverlayTransforms();
      }
    });
    this.canvasResizeObserver.observe(this.canvas);

    // Create metadata container for HTML-based metadata display/editing
    const existingMetaContainer = this.parent_div.querySelector(".chordpro-meta-container") as HTMLDivElement | null;
    if (existingMetaContainer) {
      this.metaContainer = existingMetaContainer;
      this.metaContainer.innerHTML = "";
    } else {
      this.metaContainer = document.createElement("div");
      this.metaContainer.className = "chordpro-meta-container";
      this.parent_div.insertBefore(this.metaContainer, this.canvas);
    }
    this.metaContainer.style.position = "absolute";
    this.metaContainer.style.left = "0";
    this.metaContainer.style.top = "0";
    this.metaContainer.style.width = "0";
    this.metaContainer.style.height = "0";
    this.metaContainer.style.background = "transparent";
    this.metaContainer.style.overflow = "visible";
    this.metaContainer.style.pointerEvents = "none";
    this.metaContainer.style.zIndex = "1";
    this.metaInputs.clear();

    // Create chord strip container for HTML-based chord palette
    const existingChordStrip = this.parent_div.querySelector(".chordpro-chordstrip-container") as HTMLDivElement | null;
    if (existingChordStrip) {
      this.chordStripContainer = existingChordStrip;
      this.chordStripContainer.innerHTML = "";
    } else {
      this.chordStripContainer = document.createElement("div");
      this.chordStripContainer.className = "chordpro-chordstrip-container";
      this.parent_div.insertBefore(this.chordStripContainer, this.canvas);
    }
    this.chordStripContainer.style.position = "absolute";
    this.chordStripContainer.style.left = "0";
    this.chordStripContainer.style.top = "0";
    this.chordStripContainer.style.width = "0";
    this.chordStripContainer.style.height = "0";
    this.chordStripContainer.style.background = "transparent";
    this.chordStripContainer.style.overflow = "visible";
    this.chordStripContainer.style.zIndex = "2";
    this.chordStripContainer.style.pointerEvents = "none";
    this.chordStripItems.clear();

    // Create chord box container for HTML-based chord diagram display
    const existingChordBoxContainer = this.parent_div.querySelector(".chordpro-chordbox-container") as HTMLDivElement | null;
    if (existingChordBoxContainer) {
      this.chordBoxContainer = existingChordBoxContainer;
      this.chordBoxContainer.innerHTML = "";
    } else {
      this.chordBoxContainer = document.createElement("div");
      this.chordBoxContainer.className = "chordpro-chordbox-container";
      this.parent_div.insertBefore(this.chordBoxContainer, this.canvas);
    }
    this.chordBoxContainer.style.position = "absolute";
    this.chordBoxContainer.style.left = "0";
    this.chordBoxContainer.style.top = "0";
    this.chordBoxContainer.style.width = "0";
    this.chordBoxContainer.style.height = "0";
    this.chordBoxContainer.style.background = "transparent";
    this.chordBoxContainer.style.overflow = "visible";
    this.chordBoxContainer.style.zIndex = "1";
    this.chordBoxContainer.style.pointerEvents = "none";
    this.chordBoxElements.clear();

    // Create abc container for HTML-based abcjs notation display
    const existingAbcContainer = this.parent_div.querySelector(".chordpro-abc-container") as HTMLDivElement | null;
    if (existingAbcContainer) {
      this.abcContainer = existingAbcContainer;
      this.abcContainer.innerHTML = "";
    } else {
      this.abcContainer = document.createElement("div");
      this.abcContainer.className = "chordpro-abc-container";
      this.parent_div.insertBefore(this.abcContainer, this.canvas);
    }
    this.abcContainer.style.position = "absolute";
    this.abcContainer.style.left = "0";
    this.abcContainer.style.top = "0";
    this.abcContainer.style.width = "0";
    this.abcContainer.style.height = "0";
    this.abcContainer.style.background = "transparent";
    this.abcContainer.style.overflow = "visible";
    this.abcContainer.style.zIndex = "1";
    this.abcContainer.style.pointerEvents = "none";
    this.abcDivElements.clear();

    this.parent_div.addEventListener("scroll", this.updateChordStripPosition);

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
    this.canvas.addEventListener("keydown", this.handleKeyDown);
    this.canvas.addEventListener("keypress", this.handleKeyPress);
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

      this.instructedLines = undefined;

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
    }

    this.draw();
    this.blinkCursor();
  }

  installLocaleHandler(handler: (s: string) => string) {
    this.localeHandler = handler;
    this.applyStylesForCurrentTheme();
    this.draw();
  }

  private localize(s: string) {
    return this.localeHandler?.(s.replace(/_/g, " ")) ?? s;
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

    const onTouchStart = (e: TouchEvent) => {
      if (isFormElement(e)) return;
      dispatchMouse("mousedown", e.changedTouches[0]);
      // After onMouseDown ran, check if an interactive element was hit
      this.touchActive = this.lastMouseDownHadHit;
      if (this.touchActive) {
        e.preventDefault();
        e.stopPropagation();
      }
      // If not active, browser handles scrolling normally
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!this.touchActive || e.changedTouches.length !== 1) return;
      dispatchMouse("mousemove", e.changedTouches[0]);
      e.preventDefault();
      e.stopPropagation();
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.changedTouches.length !== 1) return;
      if (this.touchActive) {
        dispatchMouse("mouseup", e.changedTouches[0]);
        e.preventDefault();
        e.stopPropagation();
      }
      this.touchActive = false;
    };

    const onTouchCancel = () => {
      this.touchActive = false;
    };

    this.parent_div.addEventListener("touchstart", onTouchStart, listenerOpts);
    this.parent_div.addEventListener("touchmove", onTouchMove, listenerOpts);
    this.parent_div.addEventListener("touchend", onTouchEnd, listenerOpts);
    this.parent_div.addEventListener("touchcancel", onTouchCancel, listenerOpts);

    this.removeTouchEvents = () => {
      this.parent_div.removeEventListener("touchstart", onTouchStart, listenerOpts);
      this.parent_div.removeEventListener("touchmove", onTouchMove, listenerOpts);
      this.parent_div.removeEventListener("touchend", onTouchEnd, listenerOpts);
      this.parent_div.removeEventListener("touchcancel", onTouchCancel, listenerOpts);
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;

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

    // Clean up metadata container
    if (this.metaContainer) {
      this.metaContainer.remove();
      this.metaContainer = null;
    }
    this.metaInputs.clear();

    // Clean up chord strip container
    this.parent_div.removeEventListener("scroll", this.updateChordStripPosition);
    if (this.chordStripContainer) {
      this.chordStripContainer.remove();
      this.chordStripContainer = null;
    }
    this.chordStripItems.clear();

    // Clean up chord box container
    if (this.chordBoxContainer) {
      this.chordBoxContainer.remove();
      this.chordBoxContainer = null;
    }
    this.chordBoxElements.clear();

    // Clean up abc container
    if (this.abcContainer) {
      this.abcContainer.remove();
      this.abcContainer = null;
    }
    this.abcDivElements.clear();

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

    this.canvas.removeEventListener("keydown", this.handleKeyDown);
    this.canvas.removeEventListener("keypress", this.handleKeyPress);
    this.canvas.removeEventListener("focus", this.handleCanvasFocus);
    this.canvas.onfocus = null;

    if (this.canvasResizeObserver) {
      this.canvasResizeObserver.disconnect();
      this.canvasResizeObserver = null;
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

    if (this.pendingDrawHandle != null) {
      window.clearTimeout(this.pendingDrawHandle);
      this.pendingDrawHandle = null;
    }
    if (this.cursorBlinkHandle != null) {
      window.clearTimeout(this.cursorBlinkHandle);
      this.cursorBlinkHandle = null;
    }

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
      this.draw();
    }
  }

  setStyles(styles: ChordProStylesSettings | null) {
    this.customStyles = styles;
    this.applyStylesForCurrentTheme();
    this.chordsSizeCache = new VersionedMap<string, number, number>(-1);
    this.draw();
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
    this.directiveStyles = mergedDirectiveStyles;
  }

  refreshDisplayProps() {
    this.applyStylesForCurrentTheme();
    this.chordsSizeCache = new VersionedMap<string, number, number>(-1);
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
      }
      updateRequired = true;
    }
    if (updateRequired) {
      if (this.chordPro) for (const line_obj of this.chordPro.lines) line_obj.invalidateCache();
      this.draw(keepDrawingSuppressed);
    }
  }

  enableInstructionRendering(mode: InstructionsRenderMode, draw = true) {
    this.instructionsRenderMode = mode;
    if (draw) this.draw();
  }

  setReadOnly(readOnly: boolean, multiChordChangeEnabled?: boolean) {
    if (multiChordChangeEnabled !== undefined) this.multiChordChangeEnabled = multiChordChangeEnabled;

    if (this.chordPro && this.readOnly !== readOnly) {
      for (const line of this.chordPro.lines) line.invalidateCache();
      this.readOnly = readOnly;

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
    this.boxes = [];
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
      this.instructedLines = undefined;
      this.chordPro = new ChordProDocument(this.system, state.data);
      this.cursorPos = state.cursorPos;

      if (typeof target !== "number") {
        this.draw();
        for (const box of this.boxes) {
          if (box instanceof ChordProChordHitBox)
            if (target instanceof Object) {
              if (
                box.chord instanceof ChordProChord &&
                box.chord.line === this.chordPro.lines[target.line] &&
                box.chord === box.chord.line.chords[target.chord]
              )
                this.changeActionTarget(box.chord);
            } else if (typeof target === "string") {
              // Metadata target: focus the HTML input if available
              const metaEl = this.metaInputs.get(target);
              if (metaEl && metaEl.value instanceof HTMLInputElement) {
                metaEl.value.focus();
              }
              break;
            }
        }
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
    if (!skipTs) {
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
    if (!(document.activeElement instanceof HTMLInputElement) || !this.metaContainer) return null;
    return this.metaContainer.contains(document.activeElement) ? document.activeElement : null;
  }

  onMouseDown(e: MouseEvent) {
    if (this.chordSelector && this.chordSelector.inModal) {
      // Don't close the dialog if the click is inside the chord selector
      if (e.target instanceof Node && this.chordSelector.parent.contains(e.target)) {
        return;
      }
      this.chordSelector.closeDialog();
      return;
    }

    const targetInMeta = !!(this.metaContainer && e.target instanceof Node && this.metaContainer.contains(e.target));
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

    // Let HTML chord strip handle its own events
    if (this.chordStripContainer && e.target instanceof Node && this.chordStripContainer.contains(e.target)) return;

    // Let HTML chord box diagrams handle their own events
    if (this.chordBoxContainer && e.target instanceof Node && this.chordBoxContainer.contains(e.target)) return;

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

    this.updateMouseDownPos(e);
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
        return false;
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
            if (mp.x < this.tagWidth) {
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
              });
            } else this.onLyricsHit({ lyrics: line_obj.lyrics.trim(), from: line_obj.sourceLineNumber, to: line_obj.sourceLineNumber + 1 });
            e.preventDefault();
            rv = false;
          }
        }
        this.lastMouseDown = null;
      }
      return rv;
    }

    const fromMetaHandoff = this.pendingCanvasFocusAfterMetaBlur;

    // Let HTML overlay controls keep native focus/interaction.
    if (!fromMetaHandoff && this.metaContainer && e.target instanceof Node && this.metaContainer.contains(e.target)) return;
    if (this.chordStripContainer && e.target instanceof Node && this.chordStripContainer.contains(e.target)) return;
    if (this.chordBoxContainer && e.target instanceof Node && this.chordBoxContainer.contains(e.target)) return;

    this.pendingCanvasFocusAfterMetaBlur = false;

    this.focus();

    if (this.actionTarget instanceof ChordTemplateHitBox) {
      this.clearActionState();
      this.draw();
    } else if (this.actionTarget instanceof ChordProChordHitBox) {
      const box = this.actionTarget;
      const chord = this.actionTarget.chord;
      if (this.dragData) {
        let noDrop = this.chordStripWidth > 0 && this.normalizeMousePos(e).x <= this.chordStripWidth;
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

  onDoubleClick(e: MouseEvent) {
    if (this.chordSelector && this.chordSelector.inModal) {
      // Don't close the dialog if the double-click is inside the chord selector
      if (e.target instanceof Node && this.chordSelector.parent.contains(e.target)) {
        return;
      }
      this.chordSelector.closeDialog();
      return;
    }

    if (this.readOnly) {
      const line_obj = this.HitTestLine(e);
      if (line_obj) {
        if (line_obj instanceof ChordProAbc) {
          if (!this.midiPlayer?.playing || this.midiPlayer?.currentTime >= this.midiPlayer.endTime - 1) {
            const midiFile = "base64," + arrayBufferToBase64(line_obj.generateMidi());
            this.midiPlayer = playMidiFile(midiFile, parseInt(line_obj.doc.getMeta("tempo"), 10), (error) => {
              console.error("Midifile playing error: " + error);
              this.midiPlayer = undefined;
            });
          } else {
            this.midiPlayer.stop();
            this.midiPlayer = undefined;
          }
        } else if (this.onLineDblclk && line_obj.sourceLineNumber >= 0) this.onLineDblclk(line_obj.sourceLineNumber);
      }
      return;
    }

    this.focus();
    this.checkChordBoxOrTemplateHit(e);
    this.lastMouseDown = null;
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

    this.canvas.style.cursor = this.dragData ? "grabbing" : "";

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
      if (mp.x <= this.chordStripWidth) {
        this.draw();
        return;
      }
      const line_obj = this.HitTestLine(e);

      if (!line_obj || line_obj.isInstrumental) {
        this.canvas.style.cursor = "not-allowed";
        this.draw();
        return;
      }
      if (line_obj) {
        const chord = new ChordProChord(line_obj, this.actionTarget.chord, 0);
        line_obj.chords.splice(0, 0, chord);
        line_obj.invalidateCache();
        this.clearActionState();
        this.draw();
        for (const box of this.boxes)
          if (box instanceof ChordProChordHitBox && box.chord === chord) {
            this.saveState();
            this.dragData = new ChordProDragStart(mp.x, mp.y, mp.x, mp.y);
            this.changeActionTarget(box);
            break;
          }
      }
    }

    if (this.actionTarget instanceof ChordProTagHitBox && this.dragData) {
      const mp = this.normalizeMousePos(e);
      this.actionTarget.left = mp.x;
      this.actionTarget.top = mp.y;
      if (mp.x <= this.tagsStripWidth) {
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
        for (const box of this.boxes)
          if (box instanceof ChordProLineHitBox && box.target === commentLine) {
            this.saveState();
            this.dragData = new ChordProDragStart(mp.x, mp.y, mp.x, mp.y);
            this.changeActionTarget(box);
            break;
          }
      }
    }

    if (this.actionTarget instanceof ChordProChordHitBox) {
      const mp = this.normalizeMousePos(e),
        x = mp.x,
        y = mp.y,
        box = this.actionTarget;

      let noDrop = mp.x <= this.chordStripWidth;
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
        this.canvas.style.cursor = "not-allowed";
        this.draw();
        return;
      }

      if (!(this.dragData instanceof ChordProDragStart)) {
        this.saveState();
        this.dragData = new ChordProDragStart(box.left, box.top, x, y);
      }

      box.left = this.dragData.startX + x - this.dragData.dragStartX;
      box.top = this.dragData.startY + y - this.dragData.dragStartY;

      this.draw();
    } else if (this.actionTarget instanceof ChordProLineHitBox) {
      const mp = this.normalizeMousePos(e),
        x = mp.x,
        y = mp.y;

      this.saveState();
      const line_obj = this.actionTarget.target;
      const tag = this.actionTarget.target.text;
      const current_line_index = line_obj.getLineIndex();

      if (mp.x <= this.tagsStripWidth) {
        if (current_line_index >= 0) this.chordPro.lines.splice(current_line_index, 1);
        for (const box of this.boxes) {
          if (box instanceof ChordProTagHitBox && box.target === line_obj) {
            this.changeActionTarget(box);
            break;
          }
        }
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
      if (ol && ol.getTagInfo().tag !== tag) {
        const i = ol.getLineIndex();
        const line_mid = (line_obj.yRange.top + line_obj.yRange.bottom) / 2;
        const line_height = line_obj.yRange.bottom - line_obj.yRange.top;
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
    // Don't steal focus from active meta inputs when the mouse leaves the canvas area.
    const activeMetaInput = this.getActiveMetaInput();
    if (activeMetaInput) return;
    // If no active drag/click sequence exists, ignore leave to avoid clearing cursor state.
    if (!this.lastMouseDown) return;
    return this.onMouseUp(e, true);
  }

  normalizeSize(width: number, height: number): Size {
    let viewPortScale = this.canvas.offsetWidth / this.canvas.width;
    if (isNaN(viewPortScale)) viewPortScale = 1;
    viewPortScale *= this.scale;
    return { width: width / viewPortScale, height: height / viewPortScale };
  }

  normalizePos(x: number, y: number): Point {
    const parentScrollOffset = this.bCorrectParentScroll ? { x: this.parent_div.scrollLeft || 0, y: this.parent_div.scrollTop || 0 } : { x: 0, y: 0 };
    const size = this.normalizeSize(x - parentScrollOffset.x, y - parentScrollOffset.y);
    return { x: size.width, y: size.height };
  }

  normalizeMousePos(e: MouseEvent) {
    return this.normalizePos(e.offsetX, e.offsetY);
  }

  initialChordValue(line_obj: ChordProLine, cursorPos: number) {
    if (!this.chordPro) return "";
    const rx = /^(.*) [0-9]+$/g,
      key = line_obj.getTagInfo().key,
      m = rx.exec(key);
    let ch = "";
    if (m) {
      let enabled = true,
        j: number,
        i = line_obj.getLineIndex();
      const p = m[1],
        signatures = this.chordPro.sectionInfo,
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
          if (k !== key && rx.test(k) && k.startsWith(p)) {
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
          let box: ChordProMetaHitBox | null = null;
          if (this.boxes)
            for (const b of this.boxes)
              if (b instanceof ChordProMetaHitBox) {
                box = b;
                break;
              }

          if (box && line_obj.styles.has(box.key)) {
            this.clearActionState();
            this.changeActionTarget(box);
            this.cursorPos = line_obj.styles.get(box.key).length;
            this.draw();
            modify_selection = false;
            break;
          }

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

  handleMetaKeyDown(e: KeyboardEvent) {
    if (!this.chordPro || !(this.actionTarget instanceof ChordProMetaHitBox)) return false;

    const code_string = getKeyCodeString(e);
    const name = this.actionTarget.key;
    const value = this.chordPro.getMeta(name);
    let modify_selection = true;
    const startPos = this.cursorPos;

    if ((e.ctrlKey || e.metaKey) && ["LEFT", "RIGHT", "UP", "DOWN"].indexOf(code_string) < 0) return false;

    switch (code_string) {
      case "UP":
        this.clearActionState();
        if (!this.selectMetaData(name, -1)) this.selectMetaData(name);
        modify_selection = false;
        break;
      case "DOWN":
      case "ENTER":
        this.clearActionState();
        if (!this.selectMetaData(name, 1)) {
          this.changeActionTarget(this.chordPro.lines[0]);
          this.cursorPos = 0;
        }
        this.draw();
        modify_selection = false;
        break;
      case "BACKSPACE":
        if ((startPos === null || !this.eraseSelection(startPos)) && this.cursorPos !== null && this.cursorPos > 0) {
          this.saveState();
          --this.cursorPos;
          this.chordPro.setMeta(name, value.substr(0, this.cursorPos) + value.substr(this.cursorPos + 1));
        }
        break;
      case "DELETE":
        if ((startPos === null || !this.eraseSelection(startPos)) && this.cursorPos !== null && this.cursorPos < value.length) {
          this.saveState();
          this.chordPro.setMeta(name, value.substr(0, this.cursorPos) + value.substr(this.cursorPos + 1));
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
      return;
    }

    if (
      this.actionTarget &&
      this.cursorPos !== null &&
      (this.handleLyricsKeyDown(e) || this.handleChordKeyDown(e) || this.handleMetaKeyDown(e) || this.handleTagKeyDown(e))
    ) {
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
    const bgColor = dark ? "#2d2d2d" : "#ffffff";
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
    let focusTarget: HTMLElement | null = this.textarea;
    if (!this.textarea) {
      const func = (this.canvas as unknown as { setActive: unknown }).setActive;
      if (typeof func === "function") /* IE/Edge*/ func();
      /* All other browsers */ else focusTarget = this.parentDiv ?? this.canvas;
    }
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
    this.instructedLines = undefined;
    this.chordPro = new ChordProDocument(this.system, text);
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

    for (const line_obj of this.displayedLines) if (line_obj.yRange && line_obj.yRange.top <= mp.y && mp.y < line_obj.yRange.bottom) return line_obj;

    return null;
  }

  HitTestCoords(mp: Point) {
    for (const box of this.boxes) if (box.left <= mp.x && mp.x <= box.left + box.width && box.top <= mp.y && mp.y <= box.top + box.height) return box;
    return null;
  }

  HitTest(e: MouseEvent) {
    return this.HitTestCoords(this.normalizeMousePos(e));
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

    const ctx = this.canvas.getContext("2d");
    if (ctx) {
      ctx.font = font;
      for (let i = text.length; i > 0; --i) if (ctx.measureText(text.substr(0, i)).width < x) return i;
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

  highlight(from: number, to: number, draw = true) {
    if (!this.readOnly) from = to = 0;
    if ((this.highlighted?.from || 0) !== from || (this.highlighted?.to || 0) !== to) {
      this.highlighted = { from, to };
      if (draw) this.draw();
      this.scrollHighlightedIntoView();
    }
  }

  private scrollHighlightedIntoView() {
    if (!this.highlighted || !this.displayedLines.length) return;

    // Find the first and last highlighted lines
    let firstHighlightedLine: ChordProLine | null = null;
    let lastHighlightedLine: ChordProLine | null = null;

    for (const line of this.displayedLines) {
      if (line.sourceLineNumber >= this.highlighted.from && line.sourceLineNumber < this.highlighted.to) {
        if (!firstHighlightedLine) firstHighlightedLine = line;
        lastHighlightedLine = line;
      }
    }

    if (!firstHighlightedLine || !lastHighlightedLine) return;

    // Get the highlight range
    const highlightTop = firstHighlightedLine.yRange?.top || 0;
    const highlightBottom = lastHighlightedLine.yRange?.bottom || 0;

    if (!highlightTop || !highlightBottom) return;

    // Get parent div scroll position and viewport
    const parentDiv = this.parent_div;
    const scrollTop = parentDiv.scrollTop;
    const scrollBottom = scrollTop + parentDiv.clientHeight;

    // Check if highlight is visible
    if (highlightTop >= scrollTop && highlightBottom <= scrollBottom) {
      return; // Already visible
    }

    // Calculate new scroll position to center the highlight
    const highlightHeight = highlightBottom - highlightTop;
    const viewportHeight = parentDiv.clientHeight;
    let newScrollTop = highlightTop - (viewportHeight - highlightHeight) / 2;

    // Ensure we don't scroll past boundaries
    newScrollTop = Math.max(0, Math.min(newScrollTop, parentDiv.scrollHeight - viewportHeight));

    parentDiv.scrollTo({ top: newScrollTop, behavior: "smooth" });
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

  private lastDrawRequest = 0;

  draw(delayable?: boolean) {
    if (this.disposed || this.drawingSuppressed) return;

    const start = Date.now();
    if (delayable && this.maxDrawTime) {
      const delay = this.maxDrawTime * 2;
      if (!this.lastDrawRequest) {
        this.lastDrawRequest = start;
        this.pendingDrawHandle = window.setTimeout(() => {
          this.pendingDrawHandle = null;
          this.draw(false);
        }, delay);
      }
      return;
    }
    if (this.pendingDrawHandle != null) {
      window.clearTimeout(this.pendingDrawHandle);
      this.pendingDrawHandle = null;
    }
    this.lastDrawRequest = 0;

    if (this.chordPro && this.onChange) {
      const currentText = this.chordProCode;
      if (this.prevText !== currentText) this.onChange((this.prevText = currentText));
    }

    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;

    try {
      this.canvas.style.visibility = "hidden";
      ctx.save();
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (this.chordPro) {
        const size = this._draw(ctx);
        size.width *= this.scale;
        size.height *= this.scale;
        if (Math.abs(size.width - ctx.canvas.width) > 10 || Math.abs(size.height - ctx.canvas.height) > 10) {
          ctx.canvas.width = size.width;
          ctx.canvas.height = size.height;
          ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
          this._draw(ctx);
        }

        if (this.cursorBox) {
          const parentDiv = this.parent_div;
          const scrollTop = parentDiv.scrollTop;
          const viewportHeight = parentDiv.clientHeight;
          const margin = this.displayProps.chordLineHeight + this.displayProps.lyricsLineHeight;

          let newScrollTop = 0;
          if (this.cursorBox.top < scrollTop) {
            newScrollTop = this.cursorBox.top - margin;
          } else if (this.cursorBox.top + this.cursorBox.height > scrollTop + viewportHeight) {
            newScrollTop = this.cursorBox.top + this.cursorBox.height - viewportHeight + margin;
          }
          if (newScrollTop) {
            newScrollTop = Math.max(0, Math.min(newScrollTop, parentDiv.scrollHeight - viewportHeight));
            parentDiv.scrollTo({ top: newScrollTop });
          }
        }
      }
    } finally {
      ctx.restore();
      this.canvas.style.visibility = "visible";
      this.maxDrawTime = Math.max(Date.now() - start, this.maxDrawTime);
    }
  }

  private _drawChunk(ctx: CanvasRenderingContext2D, x: number, y: number, textHeight: number, str: string, added?: boolean) {
    const w = ctx.measureText(str).width;

    let oldFillStyle: string | CanvasGradient | CanvasPattern = "";
    if (added !== undefined) {
      oldFillStyle = ctx.fillStyle;
      ctx.strokeStyle = ctx.fillStyle = "yellow";
      ctx.fillRect(x, y, w, textHeight);
      ctx.strokeStyle = ctx.fillStyle = added ? "green" : "red";
    }

    y += textHeight / 2;
    ctx.fillText(str, x, y);

    if (added !== undefined) {
      if (!added) ctx.fillRect(x, y, w, 1);
      ctx.fillStyle = oldFillStyle;
    }
    return w;
  }

  private _drawText(
    ctx: CanvasRenderingContext2D,
    pos: Point,
    textHeight: number,
    text: string | DifferentialText,
    createBox: (rect: Rectangle) => ChordProHitBox,
    charByChar?: boolean
  ) {
    if (typeof text === "string") {
      const w = ctx.measureText(text).width;
      ctx.fillText(text, pos.x, pos.y + textHeight / 2);
      this.boxes.push(createBox({ ...pos, width: w, height: textHeight }));
      return w;
    }

    const start = pos.x;

    const drawChunk = (str: string, added?: boolean) => {
      const w = this._drawChunk(ctx, pos.x, pos.y, textHeight, str, added);
      if (createBox) this.boxes.push(createBox({ ...pos, width: w, height: textHeight }));
      pos.x += w;
    };

    if (charByChar) text.forEachChar(drawChunk);
    else text.forEachChunk((chunk) => drawChunk(chunk.text, chunk.added));

    return pos.x - start;
  }

  private _drawSongOnly(ctx: CanvasRenderingContext2D, leftMargin?: number) {
    this.cursorBox = null;

    const horizontalSeparation = 2 * this.displayProps.lyricsLineHeight;

    leftMargin = leftMargin ?? this.displayProps.horizontalMargin;
    let x = leftMargin,
      y = this.displayProps.verticalMargin;
    const totalSize = { width: 0, height: 0 },
      updateSize = (wp: number, hp: number) => {
        totalSize.width = Math.max(totalSize.width, wp);
        totalSize.height = Math.max(totalSize.height, hp);
      };

    if (!this.chordPro) return totalSize;

    const lines = this.getInstructedLines() ?? this.chordPro.lines;
    this.displayedLines = lines;

    ctx.textBaseline = "middle";

    // --- Phase 1: Reserve vertical space for metadata (don't draw yet) ---
    type MetaEntry = {
      styleName: string;
      directiveStyle: ChordProDirectiveStyle;
      text: string | DifferentialText;
      y: number;
      height: number;
    };
    const pendingMeta: MetaEntry[] = [];

    if (this.showMeta || this.showTitle) {
      for (const styleName in this.directiveStyles) {
        if (
          !styleName.startsWith("start_of_") &&
          (this.chordPro.hasMeta(styleName) || (this.differentialDisplay && this.chordPro.hasMeta(styleName, false)))
        ) {
          const directiveStyle = this.directiveStyles[styleName];
          if (directiveStyle && directiveStyle.height && !directiveStyle.hidden && (styleName === "title" ? this.showTitle : this.showMeta)) {
            let text: string | DifferentialText = this.differentialDisplay
              ? this.chordPro.differentialMeta(styleName)
              : this.chordPro.getMeta(styleName);
            if (styleName === "key" && typeof text === "string" && this.readOnly) {
              const key = this.system.getKey(text);
              text = text.replace(/[#b]/g, (r) => (r === "#" ? UnicodeSymbol.sharp : UnicodeSymbol.flat));
              if (key && key.signature) {
                const sign = key.signature > 0 ? UnicodeSymbol.sharp : UnicodeSymbol.flat;
                let count: string | number = Math.abs(key.signature);
                if (count < 2) count = "";
                text += " " + UnicodeSymbol.musicScore + count + sign;
              }
              if (this.keyIsAuto) text += " " + UnicodeSymbol.robot;
            }
            pendingMeta.push({ styleName, directiveStyle, text, y, height: directiveStyle.height });
            y += directiveStyle.height;
          }
        }
      }
    }

    let boxLineIndex = -1,
      boxHitLineIndex = -1,
      tagWidth = 0;
    const lineTops = [y],
      lineTags: { name: string; text: string | DifferentialText; width: number }[] = [];

    if (
      this.dragData &&
      this.actionTarget instanceof ChordProChordHitBox &&
      this.actionTarget.chord.line &&
      !this.actionTarget.chord.line.isInstrumental
    )
      boxHitLineIndex = boxLineIndex = this.actionTarget.chord.line.getLineIndex();

    ctx.font = this.displayProps.tagFont;

    let prevTag: string | DifferentialText = "",
      highlightbox: ChordProLineRange | null = null; // tslint:disable-next-line: no-bitwise
    const noSectionDup = this.readOnly && (this.chordFormat & CHORDFORMAT_NOSECTIONDUP) === CHORDFORMAT_NOSECTIONDUP;

    const abcScale = 2 / 3;
    const calcStaffWith = (maxWidth: number) => maxWidth - leftMargin - horizontalSeparation;
    const abcRender = (line_obj: ChordProAbc, maxWidth: number, abcDiv?: HTMLDivElement) => {
      const options = {
        germanAlphabet: this.chordPro?.system.systemCode === "G",
        jazzchords: true,
        paddingleft: 0,
        paddingright: 0,
        staffwidth: calcStaffWith(maxWidth),
        dragging: !this.readOnly,
        currentColor: this.isDark ? "white" : "black",
      };
      if (!abcDiv) return line_obj.generateImage(options);
      line_obj.render(abcDiv, options);
      return null;
    };

    type AbcEntry = { line_obj: ChordProAbc; abcDiv: HTMLDivElement; y: number };
    const pendingAbcEntries: AbcEntry[] = [];
    const abcElements = new Map<ChordProAbc, HTMLDivElement | null>();

    for (let i = 0; i < lines.length; ++i) {
      const line_obj = lines[i];

      let line_height = this.displayProps.lyricsLineHeight;

      // tslint:disable-next-line: no-bitwise
      if (this.readOnly && (this.chordFormat & CHORDFORMAT_NOCHORDS) === CHORDFORMAT_NOCHORDS) {
        line_obj.sectionChordDuplicate = null;
        lineTags.push({ name: "", text: "", width: 0 });
        if (!line_obj.isInstrumental) y += Math.max(2, this.displayProps.chordLineHeight / 2);
      } else {
        if (line_obj.isComment) line_height += this.displayProps.chordLineHeight / 2;
        else if (line_obj instanceof ChordProAbc) {
          const topOffset = this.displayProps.chordLineHeight;
          // Render abc content into a DOM div for measurement; will be positioned in abcContainer later.
          const abcDiv = document.createElement("div");
          abcDiv.className = "abc";
          abcRender(line_obj, this.parent_div.getBoundingClientRect().width, abcDiv);
          // Temporarily append to parent_div to measure rendered height
          this.parent_div.appendChild(abcDiv);
          const measuredHeight = abcDiv.getBoundingClientRect().height;
          abcDiv.remove();
          if (this.scale === 1) {
            line_height = abcScale * measuredHeight - topOffset;
          } else {
            line_height = abcScale * measuredHeight - topOffset;
          }
          pendingAbcEntries.push({ line_obj, abcDiv, y });
          abcElements.set(line_obj, abcDiv);
          y += topOffset;
        }

        const info = line_obj.getTagInfo(this.differentialDisplay),
          infoName = info.name;
        let tag = info.tag;

        // tslint:disable-next-line: no-bitwise
        if (!this.readOnly || (this.chordFormat & CHORDFORMAT_NOCHORDS) === 0) {
          line_obj.sectionChordDuplicate = noSectionDup && !!this.chordPro.sectionInfo.get(info.key)?.duplicate;
          if (line_obj.chords.length > 0 && !line_obj.sectionChordDuplicate)
            line_height += this.displayProps.chordLineHeight + 2 * this.displayProps.chordBorder;
        }

        let infoWidth = 0;
        if (tag) {
          if (!DifferentialText.equals(prevTag, tag)) {
            line_height += 10;
            prevTag = tag;
          }
          if (this.showTag) {
            if (this.abbrevTag && typeof tag === "string") tag = make_abbrev(tag);
            tagWidth = Math.max((infoWidth = ctx.measureText(typeof tag === "string" ? tag : tag.flatten()).width), tagWidth);
          }
        }
        lineTags.push({ name: infoName, text: tag, width: infoWidth });
      }

      line_obj.yRange = { top: y, bottom: y + line_height };
      y += line_height;

      if (this.highlighted && this.highlighted.from <= line_obj.sourceLineNumber && line_obj.sourceLineNumber < this.highlighted.to) {
        if (highlightbox) highlightbox.bottom = y;
        else highlightbox = { ...line_obj.yRange };
      }

      lineTops.push(y);
    }

    if (boxLineIndex >= 0) {
      const box = this.actionTarget as ChordProHitBox;
      if (
        (boxLineIndex > 0 && box.top < (lineTops[boxLineIndex - 1] + lineTops[boxLineIndex]) / 2) ||
        (boxLineIndex < lineTops.length - 1 && box.top > lineTops[boxLineIndex + 1])
      ) {
        for (let i = 0; i < lineTops.length - 1; ++i)
          if (i !== boxLineIndex && lineTops[i] < box.top && box.top <= lineTops[i + 1]) {
            boxHitLineIndex = i;
            const line_obj = lines[boxHitLineIndex];
            if (line_obj.chords.length === 0 && !line_obj.isInstrumental)
              while (i < lineTops.length) lineTops[i++] += this.displayProps.chordLineHeight + 2 * this.displayProps.chordBorder;
            break;
          }
      }
    }

    this.tagWidth = tagWidth + leftMargin;

    // draw highlighted background for currently highlighted range
    if (highlightbox) {
      const backup = ctx.fillStyle;
      ctx.fillStyle = this.displayProps.highlightColor;
      ctx.fillRect(leftMargin, highlightbox.top, this.canvas.width - 2 * leftMargin, highlightbox.bottom - highlightbox.top);
      ctx.fillStyle = backup;
    }

    const line_mult = 1000000;
    const sel_range =
      this.selectionStart instanceof ChordProSelection && this.selectionEnd instanceof ChordProSelection
        ? [line_mult * this.selectionStart.line + this.selectionStart.col, line_mult * this.selectionEnd.line + this.selectionEnd.col]
        : [-1, -1];

    let prevTagInfo: (typeof lineTags)[0] | null = null;
    for (let line = 0; line < lines.length; ++line) {
      const line_obj = lines[line];

      x = leftMargin;
      y = lineTops[line];

      // tslint:disable-next-line: no-bitwise
      if (this.readOnly && (this.chordFormat & CHORDFORMAT_NOCHORDS) === CHORDFORMAT_NOCHORDS && line_obj.isInstrumental) continue;

      const lyricsPos = lineTops[line + 1] - this.displayProps.lyricsLineHeight / 2;

      ctx.save();

      // draw tags
      if (tagWidth) {
        ctx.font = this.displayProps.tagFont;
        ctx.fillStyle = this.displayProps.tagColor;

        const tagInfo = lineTags[line];
        if (
          tagInfo.text &&
          (!prevTagInfo || (!DifferentialText.equals(tagInfo.text, prevTagInfo.text) && tagInfo.text.toString() !== prevTagInfo.text.toString()))
        ) {
          const startPos = x + tagWidth - tagInfo.width;
          this._drawText(
            ctx,
            { x: startPos, y: lyricsPos - this.displayProps.lyricsLineHeight / 2 },
            this.displayProps.lyricsLineHeight,
            tagInfo.text,
            (rect) => new ChordProTagHitBox(rect.x, rect.y, rect.width /*horizontalSeparation + tagWidth*/, rect.height, line_obj, tagInfo.name)
          );

          if (
            this.actionTarget instanceof ChordProTagHitBox &&
            this.actionTarget.target === line_obj &&
            this.actionTarget.parameter === tagInfo.name
          ) {
            if (this.cursorPos != null) {
              const text = typeof tagInfo.text === "string" ? tagInfo.text : tagInfo.text.flatten();
              const offset = ctx.measureText(text.substring(0, this.cursorPos)).width;
              this.drawCursor(ctx, startPos + offset, lyricsPos - this.displayProps.lyricsLineHeight / 2, this.displayProps.lyricsLineHeight);
            }
            if (
              typeof this.selectionStart === "number" &&
              typeof this.selectionEnd === "number" &&
              this.comparePositions(this.selectionStart, this.selectionEnd)
            ) {
              const text = typeof tagInfo.text === "string" ? tagInfo.text : tagInfo.text.flatten();
              const start = this.selectionStart > 0 ? ctx.measureText(text.substring(0, this.selectionStart)).width : 0,
                txt = text.substring(this.selectionStart, this.selectionEnd),
                measuredWidth = ctx.measureText(txt).width;
              ctx.save();
              ctx.strokeStyle = ctx.fillStyle = this.displayProps.selectedTextBg;
              ctx.strokeRect(startPos + start, lyricsPos - this.displayProps.lyricsLineHeight / 2, measuredWidth, this.displayProps.lyricsLineHeight);
              ctx.fillRect(startPos + start, lyricsPos - this.displayProps.lyricsLineHeight / 2, measuredWidth, this.displayProps.lyricsLineHeight);
              ctx.fillStyle = this.displayProps.selectedTextFg;
              ctx.fillText(txt, startPos + start, lyricsPos);
              ctx.restore();
            }
          }
        }
        x += tagWidth + horizontalSeparation;
        this.tagsStripWidth = x;
        prevTagInfo = tagInfo;
      }

      ctx.font = this.displayProps.lyricsFont;
      ctx.fillStyle = this.displayProps.lyricsTextColor;

      x += this.applyLineStyle(ctx, line_obj);

      const drawChords = !line_obj.sectionChordDuplicate && (!this.readOnly || (this.chordFormat & CHORDFORMAT_NOCHORDS) === 0);

      let ci = 0,
        defaultPos = x;

      if (!line_obj.posCache) {
        const posItems: ChordProMovableItemInfo[] = [];
        let pendingPosItem: ChordProMovableItemInfo | null = null;
        const addPosItem = (str: string, pos: number, width: number, expandCost?: number) => {
          if (!pendingPosItem || pendingPosItem.expandCost !== expandCost || (expandCost ?? 0) > 0) {
            pendingPosItem = { chunks: [], pos, width: 0, expandCost };
            posItems.push(pendingPosItem);
          }
          pendingPosItem.width += width;
          pendingPosItem.chunks.push({ str, width });
          if (pendingPosItem.expandCost === undefined && pendingPosItem.chunks.length > 1)
            pendingPosItem.inplaceSize = pendingPosItem.width - 0.75 * width;
        };
        let i = 0;
        line_obj.lyricsData.forEachChar((ch) => {
          if (drawChords) {
            while (ci < line_obj.chords.length) {
              if (line_obj.chords[ci].pos > i) break;
              addPosItem(line_obj.chords[ci].text, defaultPos, this.drawChordText(line_obj.chords[ci++], ctx).width + 4);
            }
          }
          const size = ctx.measureText(ch);
          const expandCost = !simplifyString(ch) ? 0 : isVowel(ch) ? 1 : -1;
          addPosItem(ch, defaultPos, size.width, expandCost);
          defaultPos += size.width;
          ++i;
        });

        if (drawChords) {
          while (ci < line_obj.chords.length)
            addPosItem(line_obj.chords[ci].text, defaultPos, this.drawChordText(line_obj.chords[ci++], ctx).width + 4);
        }
        calcBestPositions(x, posItems, {
          overlayRevMoveCost: Settings.current.chordRevMoveCost,
          overlayFwdMoveCost: Settings.current.chordFwdMoveCost,
          moveChordsOnly: Settings.current.moveChordsOnly,
          // moveChordsOnly: this.dragData != null && this.actionTarget instanceof ChordProChordHitBox && this.actionTarget.chord.line === line_obj,
        });

        const lyrics: LyricsCharInfo[] = [];
        const chords: number[] = [];
        line_obj.wordsWithBoxes = new ChordProLineWords();
        let pendingWord: ChordProWordInfo = { text: "", box: { x: 0, width: 0 } };
        const lineBreakCosts = line_obj.lyricsData.lineBreakCosts;
        for (const posItem of posItems) {
          let accumulatedWidth = 0;
          for (const chunk of posItem.chunks) {
            const width = chunk.width;
            const pos = posItem.pos + accumulatedWidth;
            if (pendingWord.text && lineBreakCosts.has(lyrics.length)) {
              line_obj.wordsWithBoxes.push(pendingWord);
              pendingWord = { text: "", box: { x: pos, width: 0 } };
            }
            if (posItem.expandCost === undefined) {
              chords.push(pos);
              const offset = pos - pendingWord.box.x;
              if (pendingWord.box.chordsStartOffset === undefined) pendingWord.box.chordsStartOffset = offset;
              pendingWord.box.chordsEndOffset = offset + width;
            } else {
              lyrics.push({ str: chunk.str, pos, width });
              pendingWord.text += chunk.str;
              pendingWord.box.width += width;
            }
            accumulatedWidth += width;
          }
        }
        if (pendingWord.text) line_obj.wordsWithBoxes.push(pendingWord);

        //        if (lyrics.length !== line_obj.lyrics.length || chords.length !== line_obj.chords.length)
        //          console.log("Line pos opt problem.", line_obj.lyrics.length, lyrics.length, line_obj.chords.length, chords.length);

        line_obj.posCache = { lyrics, chords };
      } else ci = line_obj.chords.length;

      const posCache = line_obj.posCache;

      let charBoxesStart = -1;
      let i = 0;
      let prevChar = "";
      let oldFillStyle: string | CanvasGradient | CanvasPattern = "";
      let unionRect: Rectangle | undefined;
      const drawChar = (char: string, added?: boolean) => {
        const info = posCache.lyrics[i];
        // eslint-disable-next-line no-debugger
        if (info === undefined) debugger;
        const ch = info.str,
          width = info.width,
          prevEnd = x;
        x = info.pos;

        const cp = line_mult * line + i;
        if (sel_range[0] <= cp && cp < sel_range[1]) {
          oldFillStyle = ctx.fillStyle;
          ctx.strokeStyle = ctx.fillStyle = this.displayProps.selectedTextBg;
          ctx.strokeRect(x, lyricsPos - this.displayProps.lyricsLineHeight / 2, width, this.displayProps.lyricsLineHeight);
          ctx.fillRect(x, lyricsPos - this.displayProps.lyricsLineHeight / 2, width, this.displayProps.lyricsLineHeight);
          ctx.fillStyle = this.displayProps.selectedTextFg;
          ctx.fillText(ch, x, lyricsPos);
          ctx.fillStyle = oldFillStyle;
        } else if (line_obj.isComment) {
          oldFillStyle = ctx.fillStyle;
          ctx.strokeStyle = ctx.fillStyle = this.displayProps.commentBg;
          ctx.strokeRect(x, lyricsPos - this.displayProps.lyricsLineHeight / 2, width, this.displayProps.lyricsLineHeight);
          ctx.fillRect(x, lyricsPos - this.displayProps.lyricsLineHeight / 2, width, this.displayProps.lyricsLineHeight);
          ctx.fillStyle = this.displayProps.commentFg;
          ctx.fillText(ch, x, lyricsPos);
          ctx.fillStyle = oldFillStyle;
        } else {
          if (i > 0 && prevEnd < x - 4 && simplifyString(prevChar)) ctx.fillRect(prevEnd + 2, lyricsPos, x - 4 - prevEnd, 1);
          this._drawChunk(ctx, x, lyricsPos - this.displayProps.lyricsLineHeight / 2, this.displayProps.lyricsLineHeight, ch, added);
        }

        updateSize(x + width, lyricsPos + this.displayProps.lyricsLineHeight / 2);

        if (unionRect) {
          const left = unionRect.x;
          const top = unionRect.y;
          const right = left + unionRect.width;
          const bottom = top + unionRect.height;
          unionRect.x = Math.min(left, x);
          unionRect.y = Math.min(top, lyricsPos - this.displayProps.lyricsLineHeight / 2);
          unionRect.width = Math.max(right, x + width) - unionRect.x;
          unionRect.height = Math.max(bottom, lyricsPos + this.displayProps.lyricsLineHeight / 2) - unionRect.y;
        }

        if (this.actionTarget === line_obj && this.cursorPos === i)
          this.drawCursor(ctx, x, lyricsPos - this.displayProps.lyricsLineHeight / 2, this.displayProps.lyricsLineHeight);

        if (charBoxesStart < 0) charBoxesStart = this.boxes.length;
        this.boxes.push(
          new ChordProLineHitBox(x, lyricsPos - this.displayProps.lyricsLineHeight / 2, width, this.displayProps.lyricsLineHeight, line_obj, i)
        );

        x += width;
        prevChar = char;
        ++i;
      };

      if (this.readOnly && line_obj.isGrid)
        line_obj.lyricsData.forEachChunk((chunk) => {
          for (let j = 0; j < chunk.text.length; ++j) {
            const m = this.rxStartsWithChord.exec(chunk.text.substr(j));
            if (m) {
              const chord = m[0],
                width = this.drawChordText(chord, ctx, x, lyricsPos).width;
              j += chord.length - 1;
              updateSize(x + width, lyricsPos + this.displayProps.lyricsLineHeight / 2);
              x += width;
              i += chord.length;
            } else drawChar(chunk.text.substr(j, 1), chunk.added);
          }
        });
      else {
        const oldFont = ctx.font;
        switch (line_obj.getCommentType()) {
          case "box":
            unionRect = { x, y: lyricsPos, width: 0, height: 0 };
            break;
          case "italic":
            ctx.font = "italic " + ctx.font;
            break;
        }
        line_obj.lyricsData.forEachChar(drawChar);
        ctx.font = oldFont;
        if (unionRect) {
          oldFillStyle = ctx.fillStyle;
          ctx.fillStyle = this.displayProps.commentBorder;
          ctx.strokeRect(unionRect.x - 1, unionRect.y, unionRect.width + 2, unionRect.height);
          ctx.fillStyle = oldFillStyle;
          unionRect = undefined;
        }
      }

      this.boxes.push(
        new ChordProLineHitBox(
          x,
          lyricsPos - this.displayProps.lyricsLineHeight / 2,
          this.canvas.width - x,
          this.displayProps.lyricsLineHeight,
          line_obj,
          line_obj.lyrics.length
        )
      );

      if (this.actionTarget === line_obj && this.cursorPos === line_obj.lyrics.length)
        this.drawCursor(ctx, x, lyricsPos - this.displayProps.lyricsLineHeight / 2, this.displayProps.lyricsLineHeight);

      const charBoxesEnd = this.boxes.length;
      const chordPos = lyricsPos - this.displayProps.chordLineHeight - 2 * this.displayProps.chordBorder - this.displayProps.chordLyricSep;

      const drawChordPosMarker = (hPos: number, vPos: number, chordLeft: number, chordRight: number) => {
        const w = 2 * this.displayProps.chordBorder;
        ctx.beginPath();
        ctx.moveTo(hPos, vPos + 2 * w);
        ctx.lineTo(hPos + w, vPos);
        ctx.lineTo(hPos - w, vPos);
        ctx.fill();

        const left = Math.min(hPos - w, chordLeft),
          right = Math.max(chordRight, hPos + w);
        ctx.fillRect(left, vPos - 1, right - left, 1);
      };

      // tslint:disable-next-line: no-bitwise
      if (line_obj.chords.length > 0 && drawChords) {
        ctx.font = this.displayProps.chordFont;
        if (ci < line_obj.chords.length) {
          if (ci > 0)
            x = Math.max(
              x,
              posCache.chords[ci - 1] + this.drawChordText(line_obj.chords[ci - 1].text, ctx).width + 2 * this.displayProps.chordBorder
            );
          while (ci < line_obj.chords.length) {
            const chord = line_obj.chords[ci];
            posCache.chords[ci++] = x;
            x += this.drawChordText(chord, ctx).width + 2 * this.displayProps.chordBorder;
          }
        }

        ctx.fillStyle = this.displayProps.chordTextColor;
        for (i = 0; i < line_obj.chords.length; ++i) {
          const chord = line_obj.chords[i];

          if (this.dragData && this.actionTarget instanceof ChordProChordHitBox && this.actionTarget.chord === chord) continue;

          const left = posCache.chords[i],
            w = this.drawChordText(chord, ctx).width;

          if (chord.added !== undefined) {
            ctx.fillStyle = chord.added ? this.displayProps.chordTextColor : this.displayProps.lineColor;
          }

          const vPos = chordPos + this.displayProps.chordBorder + this.displayProps.chordLineHeight / 2;
          if (chord.added !== undefined || chord.moved) {
            ctx.fillStyle = "yellow";
            ctx.fillRect(left, vPos - this.displayProps.chordLineHeight / 2, w, this.displayProps.chordLineHeight);
            ctx.fillStyle = this.displayProps.chordTextColor;
          }
          this.drawChordText(chord, ctx, left, vPos, this.actionTarget === chord.line && this.cursorPos === chord.pos);

          if (chord.added !== undefined) {
            let original = line_obj.posCache.lyrics[chord.pos]?.pos;
            if (original === undefined) {
              const last = line_obj.posCache.lyrics[line_obj.posCache.lyrics.length - 1];
              original = last.pos + last.width;
            }
            if (!chord.added) ctx.fillRect(left, vPos, w, 1);
            drawChordPosMarker(original, chordPos + this.displayProps.chordLineHeight, left, left + w);
            ctx.fillStyle = this.displayProps.chordTextColor;
          } else if (chord.moved) {
            const original = line_obj.posCache.lyrics[chord.prevPos]?.pos ?? line_obj.posCache.lyrics[line_obj.posCache.lyrics.length - 1]?.pos ?? 0;
            const current = line_obj.posCache.lyrics[chord.pos].pos;
            drawChordPosMarker(original, chordPos + this.displayProps.chordLineHeight - 1, left, left + w);
            ctx.fillStyle = "gray";
            drawChordPosMarker(current, chordPos + this.displayProps.chordLineHeight, left, left + w);
            ctx.fillStyle = this.displayProps.chordTextColor;
          }

          if (this.actionTarget && this.actionTarget === chord) {
            if (
              typeof this.selectionStart === "number" &&
              typeof this.selectionEnd === "number" &&
              this.comparePositions(this.selectionStart, this.selectionEnd)
            ) {
              const start = this.selectionStart > 0 ? ctx.measureText(chord.text.substr(0, this.selectionStart)).width : 0,
                txt = chord.text.substr(this.selectionStart, this.selectionEnd - this.selectionStart),
                width = ctx.measureText(txt).width;
              ctx.save();
              ctx.strokeStyle = ctx.fillStyle = this.displayProps.selectedTextBg;
              ctx.strokeRect(left + start, chordPos + this.displayProps.chordBorder, width, this.displayProps.chordLineHeight);
              ctx.fillRect(left + start, chordPos + this.displayProps.chordBorder, width, this.displayProps.chordLineHeight);
              ctx.fillStyle = this.displayProps.selectedTextFg;
              ctx.fillText(
                txt,
                left + start,
                chordPos + this.displayProps.chordBorder + this.displayProps.chordLineHeight / 2 + this.displayProps.chordBorder
              );
              ctx.restore();
            }
            if (this.cursorPos != null) {
              const p = ctx.measureText(chord.text.substr(0, this.cursorPos)).width;
              this.drawCursor(ctx, left + p, chordPos + this.displayProps.chordBorder, this.displayProps.chordLineHeight);
            }
          }

          this.boxes.push(
            new ChordProChordHitBox(
              left - this.displayProps.chordBorder,
              chordPos,
              w + 2 * this.displayProps.chordBorder,
              this.displayProps.chordLineHeight + 2 * this.displayProps.chordBorder,
              chord
            )
          );

          updateSize(left + w, chordPos + this.displayProps.chordLineHeight + 2 * this.displayProps.chordBorder);
        }
      }

      if (boxHitLineIndex === line && this.actionTarget instanceof ChordProChordHitBox && !line_obj.isInstrumental) {
        const box = this.actionTarget;
        //const check = box.top + box.height / 2 - this.displayProps.chordBorder;

        const chord = box.chord,
          b = chordPos + this.displayProps.chordLineHeight;
        let left = box.left;

        ctx.font = this.displayProps.chordFont;
        ctx.fillStyle = this.displayProps.chordTextColor;

        const w = this.drawChordText(chord, ctx, left, chordPos + this.displayProps.chordLineHeight / 2 + this.displayProps.chordBorder).width;
        const r = left + w;

        let minDiff = (2 * this.canvas.width) / this.scale,
          cb: ChordProLineHitBox | null = null,
          bestPos = -1;

        for (let j = Math.max(charBoxesStart, 0); j < charBoxesEnd; ++j) {
          cb = this.boxes[j] as ChordProLineHitBox;
          const diff = Math.abs(cb.left - box.left);
          if (diff < minDiff) {
            bestPos = cb.column;
            left = cb.left;
            minDiff = diff;
          }
        }

        if (cb && Math.abs(cb.left + cb.width - box.left) < minDiff) {
          bestPos = cb.column + 1;
          left = cb.left + cb.width;
        }

        if (bestPos >= 0 && chord.pos !== bestPos) {
          chord.pos = bestPos;
          chord.line.removeChord(chord);
          chord.line.genText();

          chord.line = line_obj;
          chord.line.insertChord(chord);
          chord.line.genText();
        }

        drawChordPosMarker(left, b, left, r);
      }

      ctx.restore();
    }

    const wavyLines: { from: number; to: number; y: number }[] = [];
    for (const box of this.boxes) {
      if (
        (box instanceof ChordProLineHitBox && box.target.marked && box.column < box.target.lyrics.length) ||
        (box instanceof ChordProChordHitBox && box.chord.marked)
      )
        wavyLines.push({ from: box.left, to: box.left + box.width, y: box.top + box.height - 2 });
    }
    if (wavyLines.length > 0) {
      ctx.strokeStyle = this.displayProps.markUnderscoreColor;
      let last: { from: number; to: number; y: number } | undefined;
      for (const rect of wavyLines.sort((a, b) => 100000 * (a.y - b.y) + a.from - b.from))
        if (last && last.y === rect.y && last.to + 1 >= rect.from) last.to = rect.to;
        else {
          if (last) this.drawWavyLine(ctx, { x: last.from, y: last.y, width: last.to - last.from, height: 2 });
          last = rect;
        }
      if (last) this.drawWavyLine(ctx, { x: last.from, y: last.y, width: last.to - last.from, height: 2 });
    }

    totalSize.width += this.displayProps.horizontalMargin;
    totalSize.height += this.displayProps.verticalMargin;

    if (this.scale !== 1 && this.readOnly) {
      for (const [line_obj] of abcElements.entries()) {
        this.boxes.push(new AbcHitBox(leftMargin, line_obj.yRange.top, totalSize.width - leftMargin, line_obj.yRange.bottom, line_obj));
      }
    }

    // --- Phase 2: Update abc HTML elements in dedicated container ---
    this.updateAbcHTML(pendingAbcEntries, abcScale, leftMargin, totalSize.width, abcRender);

    // --- Phase 3: Update metadata HTML elements ---
    this.updateMetaHTML(pendingMeta, leftMargin, totalSize.width);

    // Ensure totalSize.height accounts for metadata area
    if (pendingMeta.length > 0) {
      const lastMeta = pendingMeta[pendingMeta.length - 1];
      updateSize(totalSize.width, lastMeta.y + lastMeta.height);
    }

    return totalSize;
  }

  private getLineIndent(line_obj: ChordProLine) {
    let x = 0;
    line_obj.styles.forEach((_v, name) => {
      const style = this.directiveStyles[name];
      if (style && style.indent != null) x = Math.max(x, style.indent);
    });
    return x;
  }

  private applyLineStyle(ctx: CanvasRenderingContext2D, line_obj: ChordProLine) {
    let x = 0;
    line_obj.styles.forEach((_v, name) => {
      const style = this.directiveStyles[name];
      if (!style) return;
      if (style.font) ctx.font = style.font;
      if (style.fg) ctx.fillStyle = style.fg;
      if (style.indent != null) x += this.safeIndent(style.indent);
    }, true);
    return x;
  }

  private safeIndent(value: unknown) {
    const indent = Number(value);
    return Number.isFinite(indent) ? indent : 0;
  }

  private getOverlayScale() {
    const width = this.canvas.width;
    const viewWidth = this.canvas.offsetWidth;
    let viewportScale = 1;
    if (width > 0 && viewWidth > 0) {
      const s = viewWidth / width;
      if (Number.isFinite(s) && s > 0) viewportScale = s;
    }
    return this.scale * viewportScale;
  }

  syncOverlayTransforms() {
    this.syncOverlayRootLayout();
    const scale = this.getOverlayScale();
    const transform = scale !== 1 ? `scale(${scale})` : "";
    if (this.metaContainer) {
      this.metaContainer.style.transform = transform;
      this.metaContainer.style.transformOrigin = "0 0";
    }
    if (this.chordStripContainer) {
      this.chordStripContainer.style.transform = transform;
      this.chordStripContainer.style.transformOrigin = "0 0";
    }
    if (this.chordBoxContainer) {
      this.chordBoxContainer.style.transform = transform;
      this.chordBoxContainer.style.transformOrigin = "0 0";
    }
    if (this.abcContainer) {
      this.abcContainer.style.transform = transform;
      this.abcContainer.style.transformOrigin = "0 0";
    }
  }

  private syncOverlayRootLayout() {
    const left = this.canvas.offsetLeft || 0;
    const top = this.canvas.offsetTop || 0;
    this.overlayCanvasLeft = left;
    this.overlayCanvasTop = top;

    // Use 0x0 with overflow:visible so containers don't add to scroll dimensions.
    // Children are absolutely positioned inside and rendered via overflow.
    if (this.metaContainer) {
      this.metaContainer.style.left = left + "px";
      this.metaContainer.style.top = top + "px";
      this.metaContainer.style.width = "0";
      this.metaContainer.style.height = "0";
      this.metaContainer.style.overflow = "visible";
    }

    if (this.chordStripContainer) {
      this.chordStripContainer.style.left = left + "px";
      this.chordStripContainer.style.width = "0";
      this.chordStripContainer.style.height = "0";
      this.chordStripContainer.style.overflow = "visible";
    }

    if (this.chordBoxContainer) {
      this.chordBoxContainer.style.left = left + "px";
      this.chordBoxContainer.style.top = top + "px";
      this.chordBoxContainer.style.width = "0";
      this.chordBoxContainer.style.height = "0";
      this.chordBoxContainer.style.overflow = "visible";
    }

    if (this.abcContainer) {
      this.abcContainer.style.left = left + "px";
      this.abcContainer.style.top = top + "px";
      this.abcContainer.style.width = "0";
      this.abcContainer.style.height = "0";
      this.abcContainer.style.overflow = "visible";
    }
  }

  private updateMetaHTML(
    entries: { styleName: string; directiveStyle: ChordProDirectiveStyle; text: string | DifferentialText; y: number; height: number }[],
    leftMargin: number,
    contentWidth: number
  ) {
    if (!this.metaContainer) return;

    this.syncOverlayRootLayout();

    const scale = this.getOverlayScale();
    this.metaContainer.style.transform = scale !== 1 ? `scale(${scale})` : "";
    this.metaContainer.style.transformOrigin = "0 0";

    const metaRowWidth = contentWidth > leftMargin ? contentWidth : 0;
    const staleKeys = new Set(this.metaInputs.keys());

    for (const entry of entries) {
      const { styleName, directiveStyle, text, y, height } = entry;
      staleKeys.delete(styleName);

      let el = this.metaInputs.get(styleName);
      if (!el) {
        el = this.createMetaRow(styleName);
        this.metaInputs.set(styleName, el);
        this.metaContainer.appendChild(el.row);
      }

      const row = el.row;
      row.style.top = y + "px";
      row.style.height = height + "px";
      row.style.lineHeight = height + "px";
      row.style.font = directiveStyle.font || "";
      row.style.color = directiveStyle.fg || "";
      row.style.backgroundColor = "transparent";

      const indent = directiveStyle.indent != null ? this.safeIndent(directiveStyle.indent) : 0;
      row.style.left = leftMargin + "px";
      row.style.paddingLeft = indent ? indent + "px" : "";

      if (metaRowWidth > 0) {
        row.style.width = metaRowWidth - leftMargin + "px";
      } else {
        row.style.width = "";
      }
      row.style.textAlign = directiveStyle.align || "left";
      const align = directiveStyle.align || "";
      row.style.justifyContent = align === "right" ? "flex-end" : align === "center" ? "center" : "";
      const tightAlign = align === "right" || align === "center";
      el.value.style.flex = tightAlign ? "0 0 auto" : "1";
      // Apply current font styles to prefix so it matches input
      el.prefix.style.font = directiveStyle.font || "";
      el.prefix.style.color = directiveStyle.fg || "";

      // Update prefix
      const prefix = directiveStyle.prefix ?? "";
      el.prefix.textContent = prefix ? prefix + ":\u00a0" : "";

      // Update value — only update if input is not focused (to preserve cursor position)
      const flatText = text instanceof DifferentialText ? text.flatten() : text;
      if (document.activeElement !== el.value && el.value.value !== flatText) {
        el.value.value = flatText;
      }
      this.updateMetaInputWidth(styleName, flatText);
    }

    // Remove stale elements
    for (const key of staleKeys) {
      const el = this.metaInputs.get(key);
      if (el) {
        el.row.remove();
        this.metaInputs.delete(key);
      }
    }
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

  private measureMetaValueWidth(input: HTMLInputElement, text: string) {
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

    const style = getComputedStyle(input);
    const span = this.metaMeasureSpan;
    span.style.font = style.font;
    span.style.letterSpacing = style.letterSpacing;
    span.style.textTransform = style.textTransform;
    span.textContent = text && text.length > 0 ? text : " ";
    return span.offsetWidth;
  }

  private updateMetaInputWidth(styleName: string, valueOverride?: string) {
    const el = this.metaInputs.get(styleName);
    if (!el) return;

    const align = el.row.style.textAlign || "";
    const tightAlign = align === "right" || align === "center";
    el.value.style.flex = tightAlign ? "0 0 auto" : "1";

    if (tightAlign) {
      const text = valueOverride ?? el.value.value;
      const measured = Math.ceil(this.measureMetaValueWidth(el.value, text) + 3);
      const prefixWidth = el.prefix.offsetWidth;
      const available = Math.max(1, el.row.clientWidth - prefixWidth);
      el.value.style.width = Math.min(measured, available) + "px";
    } else {
      el.value.style.width = "";
    }

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
    // Clear canvas action state when metadata input gets focus.
    // draw() is required so this.boxes is repopulated for future hit-testing
    // (clearActionState empties it).
    this.clearActionState();
    this.draw();
  }

  private onMetaBlur(_name: string) {
    // Nothing special needed; canvas mousedown handles re-focus
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

  private updateAbcHTML(
    entries: { line_obj: ChordProAbc; abcDiv: HTMLDivElement; y: number }[],
    abcScale: number,
    leftMargin: number,
    contentWidth: number,
    abcRender: (line_obj: ChordProAbc, maxWidth: number, abcDiv?: HTMLDivElement) => HTMLImageElement | null
  ) {
    if (!this.abcContainer) return;

    this.syncOverlayRootLayout();

    const scale = this.getOverlayScale();
    this.abcContainer.style.transform = scale !== 1 ? `scale(${scale})` : "";
    this.abcContainer.style.transformOrigin = "0 0";

    const staleKeys = new Set(this.abcDivElements.keys());

    for (const entry of entries) {
      const { line_obj, abcDiv, y } = entry;
      staleKeys.delete(line_obj);

      // Reuse existing div if already in the container for this abc line, otherwise add the new one
      let existingDiv = this.abcDivElements.get(line_obj);
      if (existingDiv) {
        // Re-render at the final content width if needed (e.g. scale != 1)
        if (this.scale !== 1 && this.readOnly) {
          existingDiv.innerHTML = "";
          abcRender(line_obj, contentWidth, existingDiv);
        } else {
          existingDiv.innerHTML = abcDiv.innerHTML;
        }
      } else {
        existingDiv = abcDiv;
        // Re-render at the final content width for scaled views
        if (this.scale !== 1 && this.readOnly) {
          existingDiv.innerHTML = "";
          abcRender(line_obj, contentWidth, existingDiv);
        }
        this.abcContainer.appendChild(existingDiv);
        this.abcDivElements.set(line_obj, existingDiv);
      }

      existingDiv.style.position = "absolute";
      existingDiv.style.left = leftMargin + "px";
      existingDiv.style.top = y + "px";
      existingDiv.style.transform = `scale(${abcScale})`;
      existingDiv.style.transformOrigin = "0 0";
      existingDiv.style.pointerEvents = this.readOnly ? "none" : "auto";
      makeDark(existingDiv, this.isDark);
    }

    // Remove stale elements
    for (const key of staleKeys) {
      const el = this.abcDivElements.get(key);
      if (el) {
        el.remove();
        this.abcDivElements.delete(key);
      }
    }
  }

  // ---- Chord strip HTML methods ----

  private updateChordStripPosition = () => {
    if (this.chordStripContainer) {
      const top = Math.max(this.overlayCanvasTop + this.chordStripBaseTop * this.getOverlayScale(), this.parent_div.scrollTop);
      this.chordStripContainer.style.top = top + "px";
    }
  };

  private formatChordHTML(chord: string): string {
    const details = this.getChordDetails(chord);
    if (!details) return chord.replace(/</g, "&lt;").replace(/>/g, "&gt;");

    let html = "";
    if (details.prefix) html += this.escapeHTML(details.prefix);
    html += this.escapeHTML(details.baseNote);
    const modifier = details.modifier.replace(/b/g, "\u266D"); // ♭
    if (modifier) html += this.escapeHTML(modifier);
    if (details.bassNote) {
      html += "/" + this.escapeHTML(details.bassNote);
      const bassMod = ""; // bass modifier already included in bassNote from getChordDetails
      if (bassMod) html += this.escapeHTML(bassMod);
    }
    if (details.suffix) html += this.escapeHTML(details.suffix);
    return html;
  }

  private escapeHTML(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private updateChordStripHTML(chords: string[], ctx: CanvasRenderingContext2D, topOffset: number) {
    if (!this.chordStripContainer) return;

    this.syncOverlayRootLayout();

    const scale = this.getOverlayScale();
    this.chordStripContainer.style.transform = scale !== 1 ? `scale(${scale})` : "";
    this.chordStripContainer.style.transformOrigin = "0 0";
    this.chordStripContainer.style.pointerEvents = "none";

    this.chordStripBaseTop = topOffset;
    this.updateChordStripPosition();

    const staleKeys = new Set(this.chordStripItems.keys());
    let top = topOffset;
    let maxWidth = 0;

    for (const chord of chords) {
      staleKeys.delete(chord);

      let div = this.chordStripItems.get(chord);
      if (!div) {
        div = this.createChordStripItem(chord);
        this.chordStripItems.set(chord, div);
        this.chordStripContainer.appendChild(div);
      }

      div.innerHTML = this.formatChordHTML(chord);
      div.style.top = top - topOffset + "px";
      div.style.left = this.displayProps.horizontalMargin + "px";
      div.style.font = this.displayProps.chordFont;
      div.style.color = this.displayProps.chordTextColor;
      div.style.height = this.displayProps.chordLineHeight + "px";
      div.style.lineHeight = this.displayProps.chordLineHeight + "px";
      div.style.pointerEvents = this.readOnly || this.actionTarget instanceof ChordTemplateHitBox ? "none" : "auto";

      // Measure width using canvas for accuracy
      ctx.font = this.displayProps.chordFont;
      const width = this.drawChordText(chord, ctx).width;

      // Create ChordTemplateHitBox for HitTest (double-click, etc.)
      this.boxes.push(
        new ChordTemplateHitBox(
          this.displayProps.horizontalMargin,
          top - this.displayProps.chordLineHeight / 2,
          width,
          this.displayProps.chordLineHeight,
          chord
        )
      );

      maxWidth = Math.max(maxWidth, width);
      top += this.displayProps.chordLineHeight;
    }

    // Remove stale elements
    for (const key of staleKeys) {
      const div = this.chordStripItems.get(key);
      if (div) {
        div.remove();
        this.chordStripItems.delete(key);
      }
    }

    this.chordStripWidth = chords.length > 0 ? this.displayProps.horizontalMargin + maxWidth : 0;
  }

  private createChordStripItem(chord: string): HTMLDivElement {
    const div = document.createElement("div");
    div.style.position = "absolute";
    div.style.whiteSpace = "nowrap";
    div.style.background = "transparent";
    div.style.cursor = "grab";
    div.style.userSelect = "none";

    div.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();

      // Disable pointer events on the strip during drag so mouse events reach the canvas
      if (this.chordStripContainer) this.chordStripContainer.style.pointerEvents = "none";

      // Compute canvas-coordinate position from the HTML element's position
      const divRect = div.getBoundingClientRect();
      const parentRect = this.parent_div.getBoundingClientRect();
      const overlayScale = this.getOverlayScale();
      const x = (divRect.left - parentRect.left + this.parent_div.scrollLeft) / overlayScale;
      const y = (divRect.top - parentRect.top + this.parent_div.scrollTop) / overlayScale;

      const drawCtx = this.canvas.getContext("2d");
      let width = this.displayProps.chordLineHeight; // fallback
      if (drawCtx) {
        drawCtx.font = this.displayProps.chordFont;
        width = this.drawChordText(chord, drawCtx).width;
      }

      const box = new ChordTemplateHitBox(x, y, width, this.displayProps.chordLineHeight, chord);
      this.changeActionTarget(box);
      this.dragData = null;
      this.cursorPos = null;
      this.selectionStart = null;
      this.selectionEnd = null;
      this.lastMouseDown = { x, y };
      this.draw();
    });

    div.addEventListener("dblclick", (e: MouseEvent) => {
      e.stopPropagation();
      if (this.chordSelector && this.multiChordChangeEnabled) {
        // Find the matching template box from the boxes array
        for (const box of this.boxes) {
          if (box instanceof ChordTemplateHitBox && box.chord === chord) {
            if (!this.readOnly) this.changeActionTarget(box);
            this.chordSelector.showDialog(chord, this.readOnly, this.isDark);
            return;
          }
        }
      }
    });

    return div;
  }

  private updateChordBoxHTML(positions: { chord: string; x: number; y: number }[], chordSize: { width: number; height: number }) {
    if (!this.chordBoxContainer) return;

    this.syncOverlayRootLayout();

    const scale = this.getOverlayScale();
    this.chordBoxContainer.style.transform = scale !== 1 ? `scale(${scale})` : "";
    this.chordBoxContainer.style.transformOrigin = "0 0";

    if (positions.length === 0) {
      // No chord boxes to show — clear existing
      this.chordBoxContainer.style.pointerEvents = "none";
      for (const canvas of this.chordBoxElements.values()) canvas.remove();
      this.chordBoxElements.clear();
      return;
    }

    this.chordBoxContainer.style.pointerEvents = "none";
    const staleKeys = new Set(this.chordBoxElements.keys());

    for (const { chord, x, y } of positions) {
      const key = chord + ":" + x + ":" + y;
      staleKeys.delete(key);

      let miniCanvas = this.chordBoxElements.get(key);
      if (!miniCanvas) {
        miniCanvas = document.createElement("canvas");
        miniCanvas.style.width = chordSize.width + "px";
        miniCanvas.style.height = chordSize.height + "px";
        miniCanvas.width = Math.round(chordSize.width * Math.max(1, Math.ceil(scale)));
        miniCanvas.height = Math.round(chordSize.height * Math.max(1, Math.ceil(scale)));
        miniCanvas.style.position = "absolute";
        miniCanvas.style.cursor = "pointer";
        miniCanvas.style.pointerEvents = "auto";

        // Click handler for chord variant cycling / play
        let mouseDownPos: { x: number; y: number } | null = null;
        miniCanvas.addEventListener("mousedown", (e: MouseEvent) => {
          e.stopPropagation();
          mouseDownPos = { x: e.offsetX, y: e.offsetY };
        });
        miniCanvas.addEventListener("mouseup", (e: MouseEvent) => {
          e.stopPropagation();
          if (!mouseDownPos) return;
          const dx = e.offsetX - mouseDownPos.x;
          const dy = e.offsetY - mouseDownPos.y;
          mouseDownPos = null;

          // If significant movement, cycle variant
          if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
            const offset = dx < 0 || dy < 0 ? -1 : 1;
            const variant = (this.chordVariantCache.get(chord) || 0) + offset;
            this.chordVariantCache.set(chord, variant);
            this.draw();
          } else {
            // Simple click: play chord
            for (const box of this.boxes) {
              if (box instanceof ChordBoxHitBox && box.chord === chord) {
                this.playChord(box);
                break;
              }
            }
          }
        });

        this.chordBoxElements.set(key, miniCanvas);
        this.chordBoxContainer.appendChild(miniCanvas);
      }

      miniCanvas.style.left = x + "px";
      miniCanvas.style.top = y + "px";
      miniCanvas.style.width = chordSize.width + "px";
      miniCanvas.style.height = chordSize.height + "px";
      const renderScale = Math.max(1, Math.ceil(scale));
      miniCanvas.width = Math.round(chordSize.width * renderScale);
      miniCanvas.height = Math.round(chordSize.height * renderScale);

      // Render chord diagram to the mini canvas
      if (this.chordBoxType) {
        this.chordBoxDraw(this.chordBoxType, chord, miniCanvas);
      }
    }

    // Remove stale elements
    for (const key of staleKeys) {
      const canvas = this.chordBoxElements.get(key);
      if (canvas) {
        canvas.remove();
        this.chordBoxElements.delete(key);
      }
    }
  }

  private drawWavyLine(ctx: CanvasRenderingContext2D, rect: Rectangle) {
    const y = rect.y,
      o = rect.height / 2;
    ctx.beginPath();
    ctx.moveTo(rect.x, y);
    for (let i = rect.x, e = i + rect.width; i < e; i += 4) {
      ctx.quadraticCurveTo(i, y - o, i + 1, y);
      ctx.quadraticCurveTo(i + 2, y + o, i + 3, y);
    }
    ctx.stroke();
  }

  private _drawChordLayouts(
    chords: string[],
    totalSize: { width: number; height: number },
    chordSize: { width: number; height: number },
    draw: (chord: string, x: number, y: number) => boolean
  ) {
    let targetRatio = this.targetRatio;
    if (!targetRatio) {
      const parentRect = this.parent_div.getBoundingClientRect();
      targetRatio = parentRect.width / parentRect.height;
    }
    if (targetRatio > totalSize.width / totalSize.height) {
      let x = totalSize.width + this.displayProps.horizontalMargin,
        y = this.displayProps.verticalMargin,
        width = totalSize.width;
      for (const chord of chords) {
        if (draw(chord, x, y)) {
          width = x + chordSize.width + this.displayProps.horizontalMargin;
          y += chordSize.height;
          if (y + chordSize.height > totalSize.height) {
            y = this.displayProps.verticalMargin;
            x += chordSize.width;
          }
        }
      }
      totalSize.width = width + this.displayProps.verticalMargin;
    } else {
      let x = this.displayProps.horizontalMargin,
        y = totalSize.height + this.displayProps.verticalMargin,
        height = totalSize.height;
      for (const chord of chords) {
        if (draw(chord, x, y)) {
          height = y + chordSize.height;
          x += chordSize.width;
          if (x + chordSize.width > totalSize.width) {
            x = this.displayProps.horizontalMargin;
            y += chordSize.height;
          }
        }
      }
      totalSize.height = height + this.displayProps.verticalMargin;
    }
    return totalSize;
  }

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

  private _draw(ctx: CanvasRenderingContext2D) {
    this.boxes = [];
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);

    this.chordStripWidth = 0;

    const chordSet = new Map<string, string>();
    let displayNormalizedChord = this.displayNormalizedChord;
    if (this.chordPro && (!this.readOnly || this.chordBoxType))
      this.chordPro.forAllChords((chord) => {
        const details = this.getChordDetails(chord);
        if (details) {
          const suffix = details.bassNote ? "/" + details.bassNote : "";
          const key = details.baseNote + details.normalized + suffix;
          const value = details.baseNote + details.modifier + suffix;
          if (!displayNormalizedChord) {
            const prev = chordSet.get(key);
            if (prev) displayNormalizedChord = prev !== value;
          }
          chordSet.set(key, value);
        }
      });

    if (this.chordPro && !this.readOnly) {
      const all: string[] = [];
      chordSet.forEach((value) => all.push(value));
      let top = this.displayProps.verticalMargin;
      if (this.showTitle) top += this.directiveStyles.title?.height ?? 0;
      for (const styleName in this.directiveStyles)
        if (!styleName.startsWith("start_of_") && !this.directiveStyles[styleName].hidden && this.chordPro.getMeta(styleName))
          top += this.directiveStyles[styleName].height ?? 0;

      this.updateChordStripHTML(all.sort(), ctx, top);
    } else {
      this.chordStripWidth = 0;
      if (this.chordStripContainer) {
        this.chordStripContainer.style.pointerEvents = "none";
        for (const key of this.chordStripItems.keys()) {
          this.chordStripItems.get(key)?.remove();
        }
        this.chordStripItems.clear();
      }
    }

    let totalSize = { width: 0, height: 0 };
    let targetRatio: number | undefined = undefined;
    let latestChordBoxPositions: { chord: string; x: number; y: number }[] = [];
    let latestChordBoxSize = { width: 0, height: 0 };

    const boxCount = this.boxes.length;

    for (let i = 0; i < 2; ++i) {
      if (i) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      this.boxes.splice(boxCount, this.boxes.length - boxCount);
      const songSize = this._drawSongOnly(ctx, this.displayProps.horizontalMargin + this.chordStripWidth);
      totalSize = songSize;

      if (!this.readOnly) {
        if (this.actionTarget instanceof ChordTemplateHitBox) {
          ctx.fillStyle = this.displayProps.chordTextColor;
          this.drawChordText(this.actionTarget.chord, ctx, this.actionTarget.left - this.actionTarget.width / 2, this.actionTarget.top);
        }
        break;
      }

      if (this.chordBoxType) {
        const chords: string[] = [];
        chordSet.forEach((value, key) => chords.push(displayNormalizedChord ? key : value));
        const chordboxes: (PianoChordHitBox | GuitarChordHitBox)[] = [];
        const pendingChordBoxes: { chord: string; x: number; y: number }[] = [];
        const chordSize = this.chordBoxType === "PIANO" ? this.displayProps.pianoChordSize : this.displayProps.guitarChordSize;

        // Use layout algorithm to compute positions; defer actual rendering to HTML canvases
        totalSize = this._drawChordLayouts(chords, totalSize, chordSize, (chord, x, y) => {
          const canRender =
            this.chordBoxType === "PIANO" ? !!this.system.identifyChord(chord) : !!(this.getActualChordLayout(chord) && this.chordSelector);
          if (canRender) {
            pendingChordBoxes.push({ chord, x, y });
            const BoxType = this.chordBoxType === "PIANO" ? PianoChordHitBox : GuitarChordHitBox;
            chordboxes.push(new BoxType(x, y, chordSize.width, chordSize.height, chord));
            return true;
          }
          return false;
        });

        if (chordboxes.length > 0) this.boxes.splice(0, 0, ...chordboxes);
        latestChordBoxPositions = pendingChordBoxes;
        latestChordBoxSize = chordSize;
      }

      if (
        !this.autoSplitLines ||
        this.inMarkingState ||
        targetRatio !== undefined ||
        Math.abs(totalSize.width / totalSize.height - this.targetRatio) / this.targetRatio < 0.1
      )
        break;

      targetRatio = this.targetRatio;
      if (this.chordBoxType) {
        if (totalSize.width / totalSize.height > 1.1 * this.targetRatio && totalSize.height > songSize.height) {
          targetRatio /= songSize.height / totalSize.height;
        } else if ((1.1 * totalSize.width) / totalSize.height < this.targetRatio && totalSize.width > songSize.width) {
          targetRatio *= songSize.width / totalSize.width;
        }
      }
    }

    // Render chord box diagrams as HTML canvas elements
    this.updateChordBoxHTML(latestChordBoxPositions, latestChordBoxSize);

    return totalSize;
  }

  drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number, height: number, fillStyle?: string) {
    ctx.save();
    ctx.fillStyle = fillStyle ?? this.displayProps.cursorColor;
    ctx.fillRect(x, y, 1, height);
    ctx.restore();
    this.cursorBox = { left: x, top: y, width: 1, height };
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

  private blinkCursor(visible = true) {
    if (this.disposed) return;
    if (!this.readOnly && this.cursorPos != null && this.cursorBox != null) {
      const ctx = this.canvas.getContext("2d");
      if (ctx) {
        const colors = [this.displayProps.cursorColor, this.displayProps.backgroundColor];
        this.drawCursor(
          ctx,
          this.cursorBox.left,
          this.cursorBox.top,
          this.cursorBox.height,
          colors[this.isDark ? (visible ? 1 : 0) : visible ? 0 : 1]
        );
      }
    }
    this.cursorBlinkHandle = window.setTimeout(() => {
      this.cursorBlinkHandle = null;
      this.blinkCursor(!visible);
    }, 1000);
  }

  private createWrapChunks(ctx: CanvasRenderingContext2D, doc: ChordProDocument, wrapMode: "LINE" | "SECTION" | "FULL") {
    const emptyLine = () => ({ x: 0, y: 0, width: 0, height: 0, chunks: [] });

    const lines: WrapChunkLine[] = [];

    let cline: WrapChunkLine = emptyLine();
    lines.push(cline);

    let tag = "";
    for (const line of doc.lines) {
      if (wrapMode === "SECTION" && tag) {
        const tagInfo = line.getTagInfo();
        if (tag !== tagInfo.tag) {
          tag = tagInfo.tag.toString();
          lines.push((cline = emptyLine()));
        }
      }

      const chunk: WrapChunkBase = { text: "" };
      let chIndex = 0;

      const closeChunk = (breakCost: number | undefined) => {
        if (chunk.text) {
          cline.chunks.push({ ...chunk, line, x: 0, width: ctx.measureText(chunk.text).width });
          chunk.text = "";
        }
        chunk.breakCost = breakCost;
      };

      const isSpace = (ch: string) => ch === " " || ch === "\t";

      this.applyLineStyle(ctx, line);

      let breakCost = 100;
      for (let i = 0, len = line.lyrics.length; i < len; ++i) {
        if (chIndex < line.chords.length && line.chords[chIndex].pos === i) {
          if (chunk.overlay) closeChunk(undefined);
          chunk.overlay = { x: 0, y: 0, width: this.drawChordText(line.chords[chIndex], ctx).width, height: this.displayProps.chordLineHeight };
          ++chIndex;
        }
        const ch = line.lyrics[i];
        const unaccented = removeDiacretics(ch);

        if (!chunk.text && (chunk.breakCost ?? 0) > 40 && /^[A-Z]$/.test(unaccented)) chunk.breakCost = 40;
        chunk.text += ch;

        const space = isSpace(ch);
        if (!space) breakCost = /^[a-zA-Z0-9]$/.test(unaccented) ? 50 : 20;
        else if (isVowel(ch) && i + 1 < len && !isSpace(line.lyrics[i + 1])) closeChunk(space ? breakCost : undefined);
        if (i + 1 === len) closeChunk(0);
      }

      if (wrapMode === "LINE") lines.push((cline = emptyLine()));
    }

    return lines.filter((x) => x.chunks.length > 0);
  }

  private findSection(_sectionName: string) {
    return null;
  }

  private buildSongHtml(parent: HTMLElement, instructions?: Instructions) {
    parent.innerHTML = "";
    if (!this.chordPro) return;

    const elementLineMap = new Map<HTMLElement, ChordProLine>();
    //    const sections = this.chordPro.getSections();

    const applyLineStyle = (elem: HTMLElement, line_obj: ChordProLine) => {
      let indent = 0;
      line_obj.styles.forEach((_v, name) => {
        const style = this.directiveStyles[name];
        if (!style) return;
        if (style.font) elem.style.font = style.font;
        if (style.fg) elem.style.color = style.fg;
        if (style.indent != null) indent += this.safeIndent(style.indent);
        if (style.align) elem.style.textAlign = style.align;
      }, true);
      return indent;
    };

    const modifier = (text: string) => {
      // tslint:disable-next-line: no-bitwise
      const ssp = this.readOnly && (this.chordFormat & CHORDFORMAT_SUBSCRIPT) === CHORDFORMAT_SUBSCRIPT;
      let html = ssp ? "<sup>" : "";
      html += ssp ? text.replace(/[#b]/g, (r) => (r === "#" ? UnicodeSymbol.sharp : UnicodeSymbol.flat)) : text.replace(/b/g, UnicodeSymbol.flat);
      if (ssp) html += "</sup>";
      return html;
    };

    const generateChord = (targetElement: HTMLElement, chord: string | ChordProChordBase, _actual?: boolean) => {
      const chordDetails = this.getChordDetails(chord);

      let chordHtml = "";
      targetElement.className = "song-chord";

      if (chordDetails) {
        if (chordDetails.prefix) chordHtml += chordDetails.prefix;

        let baseNote = chordDetails.baseNote;
        if (this.readOnly && (this.chordFormat & CHORDFORMAT_INKEY) === CHORDFORMAT_INKEY && this.chordPro?.key) {
          const key = this.system.getKey(this.chordPro.key);
          if (key) {
            let b = this.chordsInKey.get(key.name, baseNote);
            if (!b) this.chordsInKey.set(key.name, baseNote, (b = key.noteName(baseNote)));
            baseNote = b;
          }
        }

        let note = this.formatNote(baseNote, chordDetails.minor);
        chordHtml += note.substring(0, 1);
        let s = note.substring(1);

        // tslint:disable-next-line: no-bitwise
        if (this.readOnly && chordDetails.minor && (this.chordFormat & CHORDFORMAT_NOMMOL) === CHORDFORMAT_NOMMOL)
          s += chordDetails.modifier.substring(1);
        else s += chordDetails.modifier;

        if (s) chordHtml += modifier(s);

        // tslint:disable-next-line: no-bitwise
        if (!this.readOnly || (this.chordFormat & CHORDFORMAT_SIMPLIFIED) === 0) {
          if (chordDetails.bassNote) {
            chordHtml += "/";
            note = this.formatNote(chordDetails.bassNote, false);
            chordHtml += note.substring(0, 1);
            chordHtml += modifier(note.substring(1));
          }
        }

        if (chordDetails.suffix) chordHtml += chordDetails.suffix;
      } else {
        targetElement.style.color = this.displayProps.unknownChordTextColor;
        chordHtml += typeof chord === "string" ? chord : chord.text;
      }

      targetElement.innerHTML = chordHtml;
    };
    //    const leftMargin = this.displayProps.horizontalMargin;
    const lines = this.chordPro.lines;
    if (this.showMeta || this.showTitle) {
      for (const styleName in this.directiveStyles) {
        if (
          !styleName.startsWith("start_of_") &&
          (this.chordPro.hasMeta(styleName) || (this.differentialDisplay && this.chordPro.hasMeta(styleName, false)))
        ) {
          const directiveStyle = this.directiveStyles[styleName];
          if (directiveStyle && directiveStyle.height && !directiveStyle.hidden && (styleName === "title" ? this.showTitle : this.showMeta)) {
            let text = (directiveStyle.prefix ?? "") + this.chordPro.getMeta(styleName);
            if (styleName === "key" && typeof text === "string" && this.readOnly) {
              const key = this.system.getKey(text);
              text = text.replace(/[#b]/g, (r) => (r === "#" ? UnicodeSymbol.sharp : UnicodeSymbol.flat));
              if (key && key.signature) {
                const sign = key.signature > 0 ? UnicodeSymbol.sharp : UnicodeSymbol.flat;
                let count: string | number = Math.abs(key.signature);
                if (count < 2) count = "";
                text += " " + UnicodeSymbol.musicScore + count + sign;
              }
              if (this.keyIsAuto) text += " " + UnicodeSymbol.robot;
            }

            const element = createDivElement({ innerText: text, parent });
            element.style.font = directiveStyle.font || "";
            element.style.color = directiveStyle.fg || "";
            if (directiveStyle.indent != null) element.style.marginLeft = this.safeIndent(directiveStyle.indent) + "px";
            if (directiveStyle.align) element.style.textAlign = directiveStyle.align;
          }
        }
      }
    }

    const songContent = createDivElement({ className: "song-content-grid", parent });

    const genCommentChunks = (line_obj: ChordProLine | string, songLine: HTMLElement, sectionIndent: number) => {
      const lyricsLine = createDivElement({ className: "song-chunks", parent: songLine });
      lyricsLine.style.marginLeft = sectionIndent + "px";
      const innerText = typeof line_obj === "string" ? line_obj : line_obj.lyrics.toString();
      const comment = createDivElement({ className: "song-chunk", parent: lyricsLine, innerText });
      comment.style.padding = "0.2em";
      comment.style.font = this.displayProps.lyricsFont;
      comment.style.color = this.displayProps.commentFg;
      comment.style.background = this.displayProps.commentBg;
      if (typeof line_obj === "string") comment.style.fontStyle = "italic";
      else if (line_obj.getCommentType() === "box") comment.style.border = this.displayProps.commentBorder;
    };

    const genCommentLine = (commentText: string | DifferentialText, textOnly = true) => {
      if (!textOnly) {
        const tagCell = createDivElement({ className: "song-tag", parent: songContent });
        tagCell.style.font = this.displayProps.tagFont;
        tagCell.style.color = this.displayProps.tagColor;
      }
      const songLine = createDivElement({ className: "song-line", parent: songContent });
      songLine.style.marginTop = this.displayProps.chordLineHeight / 2 + "px";
      genCommentChunks(commentText.toString(), songLine, 0);
    };

    for (const instruction of instructions?.items ?? [null])
      for (let mindex = 0, prevTag = ""; mindex < (instruction?.multiplier ?? 1); ++mindex, prevTag = "") {
        if (instruction != null) {
          if (instruction.multiplier == null) {
            genCommentLine(instruction.value, false);
            continue;
          }
          if (mindex > 0) continue;
        }
        for (const lo of lines) {
          if (instruction != null) {
            const matching4instruction =
              instruction.multiplier == null
                ? lo.isComment && lo.text === instruction.value
                : !lo.isComment && lo.getTagInfo().tag.toString().toLowerCase() === instruction.value.toLowerCase();
            if (!matching4instruction) continue;
          }

          // tslint:disable-next-line: no-bitwise
          if (this.readOnly && (this.chordFormat & CHORDFORMAT_NOCHORDS) === CHORDFORMAT_NOCHORDS && lo.isInstrumental) continue;

          const line_obj = lo instanceof ChordProAbc ? lo.toGrid(true) : lo;

          const tagCell = createDivElement({ className: "song-tag", parent: songContent });
          tagCell.style.font = this.displayProps.tagFont;
          tagCell.style.color = this.displayProps.tagColor;

          const info = line_obj.getTagInfo();
          const tag = info.tag.toString();
          let insertLineSeparator = false;
          if (tag) {
            tagCell.dataset.section = tag;
            if (prevTag !== tag) {
              prevTag = tag;
              const tagLabel = this.showTag && this.abbrevTag && typeof tag === "string" ? make_abbrev(tag) : tag;
              tagCell.innerText = tagLabel + ((instruction?.multiplier ?? 0) > 1 ? " " + instruction?.multiplier + "x" : "");
              insertLineSeparator = !!tagLabel;

              tagCell.onclick = () => {
                const tags = parent.getElementsByClassName("song-tag");
                const songLines = parent.getElementsByClassName("song-line");
                let enabled = false;
                for (let i = 0; i < tags.length; ++i) {
                  const t = tags[i] as HTMLElement;
                  if (enabled) {
                    if (t.dataset.section !== tag) break;
                    t.classList.toggle("collapsed");
                    songLines[i].classList.toggle("collapsed");
                  } else if (t === tagCell) enabled = true;
                }
              };
              tagCell.draggable = true;
              tagCell.ondragstart = (e) => e.dataTransfer?.setData("text", JSON.stringify({ tagName: tag }));
            }
          }

          let sectionIndent = 0;
          const songLine = createDivElement({ className: "song-line", parent: songContent });
          songLine.style.font = this.displayProps.lyricsFont;
          songLine.style.color = this.displayProps.lyricsTextColor;
          if (tag) {
            songLine.draggable = true;
            songLine.ondragstart = (e) => e.dataTransfer?.setData("text", JSON.stringify({ tagName: tag }));
          }
          if (insertLineSeparator) songLine.style.marginTop = this.displayProps.chordLineHeight / 2 + "px";
          elementLineMap.set(songLine, line_obj);

          sectionIndent += applyLineStyle(songLine, line_obj);
          if (sectionIndent > 0) songLine.style.paddingLeft = sectionIndent + "px";

          const drawChords = !line_obj.sectionChordDuplicate && (!this.readOnly || (this.chordFormat & CHORDFORMAT_NOCHORDS) === 0);

          if (line_obj.isComment) genCommentChunks(line_obj, songLine, 0);
          else if (line_obj.isGrid) {
            const lyricsLine = createDivElement({ className: "song-line", parent: songLine });
            const text = line_obj.lyrics;
            for (let j = 0; j < text.length; ) {
              const chCell = createDivElement({ className: "song-chunk", parent: lyricsLine });
              const m = this.rxStartsWithChord.exec(text.substring(j));
              const chunk = m?.[0] ?? text.substring(j, j + 1);
              if (chunk.trim()) chCell.innerText = chunk;
              else chCell.innerHTML = "&nbsp;";
              j += chunk.length;
            }
          } else {
            let songWord: HTMLElement | undefined;
            let chordsDiv: HTMLElement | undefined;
            let lyricsDiv: HTMLElement | undefined;
            const lyrics = line_obj.lyrics;
            const chords = line_obj.chords;
            let chordIndex = 0,
              wordStartCharIndex = 0;
            const chordPositions = chords.map((x) => x.pos);
            /*
            let prevPos = 0;
            const simplified = simplifyString(lyrics);
            const stopChars = knownVowelChars;
            for (let ci = 0; ci < chordPositions.length; ++ci) {
              if (chordPositions[ci] > prevPos && stopChars.includes(simplified[chordPositions[ci] - 1])) --chordPositions[ci];
              prevPos = chordPositions[ci] + 1;
            }
*/
            let posItems: ({ div: HTMLElement; orig: number } & ItemToPosition)[] = [];
            const addPosItem = (div: HTMLElement, pos: number, width: number, expandCost?: number) => {
              posItems.push({ div, pos, orig: pos, width, expandCost });
            };

            let actualChunkStartPos = 0;
            let charsDiv: HTMLElement | undefined;
            const closeCharsDiv = (chunkExpandCost = -1) => {
              if (charsDiv) {
                const chunkWidth = getDivWidth(charsDiv);
                addPosItem(charsDiv, actualChunkStartPos, chunkWidth, chunkExpandCost);
                actualChunkStartPos += chunkWidth;
                charsDiv = undefined;
              }
            };
            const positionItemsInWord = () => {
              closeCharsDiv();
              if (posItems.length >= 2) {
                calcBestPositions(0, posItems, {
                  overlayRevMoveCost: Settings.current.chordRevMoveCost,
                  overlayFwdMoveCost: Settings.current.chordFwdMoveCost,
                  moveChordsOnly: Settings.current.moveChordsOnly,
                });
                let globalOffset = Number.MAX_VALUE;
                for (const item of posItems) globalOffset = Math.min(globalOffset, item.pos);
                let chordsOffset = 0;
                let lyricsOffset = 0;
                for (const item of posItems) {
                  const pos = item.pos - globalOffset;
                  if (item.expandCost == null) {
                    const offset = pos - chordsOffset;
                    if (offset > 0) item.div.style.marginLeft = offset + "px";
                    chordsOffset = item.width + pos;
                  } else {
                    const offset = pos - lyricsOffset;
                    if (offset > 0) item.div.style.marginLeft = offset + "px";
                    lyricsOffset = item.width + pos;
                  }
                }
              }
              posItems = [];
            };
            const getDivWidth = (div: HTMLElement) => div.scrollWidth;
            const addPendingChords = (end = Number.MAX_SAFE_INTEGER, forBlank?: boolean) => {
              let hasChords = false;
              if (drawChords && charsDiv) {
                const prevText = charsDiv.innerText;
                while (chordIndex < chords.length && chordPositions[chordIndex] <= end) {
                  if (forBlank === true && chordPositions[chordIndex] === end && (chordPositions[chordIndex + 1] ?? Number.MAX_SAFE_INTEGER) > end)
                    break;
                  if (!chordsDiv) {
                    chordsDiv = createDivElement({ className: "song-chords", parent: songWord });
                    chordsDiv.style.font = this.displayProps.chordFont;
                    chordsDiv.style.height = this.displayProps.chordLineHeight + "px";
                  }
                  const chordDiv = createDivElement({ className: "song-chord", parent: chordsDiv });
                  chordDiv.style.color = this.displayProps.chordTextColor;
                  generateChord(chordDiv, chords[chordIndex]);
                  charsDiv.innerText = lyrics.substring(wordStartCharIndex, chordPositions[chordIndex]);
                  addPosItem(chordDiv, getDivWidth(charsDiv), getDivWidth(chordDiv));
                  ++chordIndex;
                  hasChords = true;
                  if (forBlank === false && chordPositions[chordIndex - 1] === end) break;
                }
                charsDiv.innerText = prevText;
              }
              return hasChords;
            };
            let chunkStartCharIndex = 0;
            const startNewWord = (createCharsDiv?: boolean) => {
              songWord = createDivElement({ className: "song-word", parent: songLine });
              lyricsDiv = createDivElement({ className: "song-lyrics", parent: songWord });
              lyricsDiv.style.height = this.displayProps.lyricsLineHeight + "px";
              charsDiv = createCharsDiv ? createDivElement({ className: "song-chunk", parent: lyricsDiv }) : undefined;
              chordsDiv = undefined;
              actualChunkStartPos = 0;
              wordStartCharIndex = chunkStartCharIndex;
            };
            for (const chunk of splitTextToWords(lyrics, { appendPunctuation: true, splitByVowels: true })) {
              let chunkText = chunk.text;
              if (!songWord || (chunk.word && !chunk.mid) || chunk.blank) {
                positionItemsInWord();
                startNewWord();
              }
              if (!charsDiv) charsDiv = createDivElement({ className: "song-chunk", parent: lyricsDiv });
              if (chunk.word && !chunk.end) {
                const lastChar = chunk.unaccented?.substring(chunk.unaccented.length - 1);
                if (lastChar && knownVowelChars.includes(lastChar)) {
                  charsDiv.innerText += chunkText.substring(0, chunkText.length - 1);
                  addPendingChords(chunkStartCharIndex + chunkText.length - 1, chunk.blank);
                  closeCharsDiv(Settings.current.vowelExpandCost);
                  chunkStartCharIndex += chunkText.length - 1;
                  chunkText = chunkText.substring(chunkText.length - 1);
                  charsDiv = createDivElement({ className: "song-chunk", parent: lyricsDiv });
                }
              }
              const chunkEndCharIndex = chunkStartCharIndex + chunkText.length;
              charsDiv.innerText += chunkText;
              if (addPendingChords(chunkEndCharIndex, chunk.blank) || chunk.end) {
                closeCharsDiv();
                chunkStartCharIndex = chunkEndCharIndex;
              }
            }
            positionItemsInWord();
            if (chordIndex < chords.length) {
              startNewWord(true);
              addPendingChords();
              positionItemsInWord();
            }
          }
        }
      }

    return () => {
      const colormap = [
        { className: "song-tag", color: this.displayProps.tagColor },
        { className: "song-line", color: this.displayProps.lyricsTextColor },
        { className: "song-chord", color: this.displayProps.chordTextColor },
      ];
      for (const entry of colormap) {
        const elements = parent.getElementsByClassName(entry.className);
        for (let i = 0; i < elements.length; ++i) {
          const elem = elements.item(i) as HTMLElement;
          elem.style.color = entry.color;
          const line_obj = elementLineMap.get(elem);
          if (line_obj) applyLineStyle(elem, line_obj);
        }
      }
    };
  }

  private buildInstructions(instructionsEditor: HTMLElement, onChange?: (current: Instructions) => void) {
    instructionsEditor.innerHTML = "";

    if (!this.chordPro) return;

    if (!this.instructions) {
      const default_instructions = this.getInstructions("DEFAULT");
      this.instructions = new Instructions();
      this.applyInstructions(default_instructions);
    }
    const instructions = this.instructions;

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
      content.innerText = item.value + ((item.multiplier ?? 0) > 1 ? " " + item.multiplier + "x" : "");
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
          instructions.insertBefore({ value: dndItem.tagName, multiplier: 1 }, item);
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
        instructions.add({ value: dndItem.tagName, multiplier: 1 });
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

  editInstructions(instructions: string, instructionsEditor: HTMLElement, onUpdate?: () => void, songDiv?: HTMLElement, previewDiv?: HTMLElement) {
    this.instructionEditorActive = true;
    let su: (() => void) | undefined;
    let pu: (() => void) | undefined;
    if (songDiv) su = this.buildSongHtml(songDiv);
    if (instructions) this.applyInstructions(instructions);
    else this.instructions = undefined;
    this.buildInstructions(instructionsEditor, (updated: Instructions) => {
      if (previewDiv) pu = this.buildSongHtml(previewDiv, updated);
      onUpdate?.();
    });
    return () => {
      this.instructionEditorActive = false;
      su?.();
      pu?.();
    };
  }

  applyInstructions(instructions: string, draw = true) {
    if (this.chordPro) {
      if (instructions) {
        if (!this.instructions) this.instructions = new Instructions();
        this.instructions.parse(instructions, Array.from(this.chordPro.getSections()));
      } else this.instructions = undefined;
      this.instructedLines = undefined;
      if (draw) this.draw();
    }
  }

  getInstructions(mode: "PRESET" | "DEFAULT" | "CURRENT" | "SETTING") {
    if (!this.chordPro) return "";
    const doc = this.chordPro;

    const genDefault = () => {
      const lines: string[] = [];
      for (let i = 0; i < doc.lines.length; ++i) {
        const line_obj = doc.lines[i];
        if (line_obj.isComment) lines.push(line_obj.text);
        else {
          const tag = line_obj.getTagInfo().tag;
          if (tag) {
            while (i + 1 < doc.lines.length && doc.lines[i + 1].getTagInfo().tag === tag) ++i;
            lines.push(tag.toString());
          }
        }
      }
      return lines.join("\n");
    };

    switch (mode) {
      case "PRESET":
        return this.instructions?.format() ?? "";
      case "DEFAULT":
        return genDefault();
      case "SETTING":
        if (this.instructions) {
          const current = this.instructions.format();
          return genDefault() === current ? "" : current;
        }
        return "";
      default:
        return this.instructions?.format() || genDefault();
    }
  }

  setupInstructionsEditor(panes: HTMLElement, instructions: string, displayUpdateCallback?: () => void) {
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

    const mousemove = (e: MouseEvent) => {
      const diff = e.clientX - startX;
      const total = panes.offsetWidth;
      if (draggedSeparator === leftSeparator) {
        const two = colSong.offsetWidth + colList.offsetWidth;
        const div = (100 * two) / total;
        const req = startWidth + diff;
        const left = div * (req / two);
        colSong.style.width = left + "%";
        colList.style.width = div - left + "%";
      } else {
        const two = colPreview.offsetWidth + colList.offsetWidth;
        const div = (100 * two) / total;
        const req = startWidth + diff;
        const left = div * (req / two);
        colList.style.width = left + "%";
        colPreview.style.width = div - left + "%";
      }
    };

    const mouseup = () => {
      document.removeEventListener("mousemove", mousemove);
      document.removeEventListener("mouseup", mouseup);
    };

    leftSeparator.addEventListener("mousedown", function (e) {
      e.preventDefault();
      draggedSeparator = leftSeparator;
      startX = e.clientX;
      startWidth = colSong.offsetWidth;
      document.addEventListener("mousemove", mousemove);
      document.addEventListener("mouseup", mouseup);
    });

    rightSeparator.addEventListener("mousedown", function (e) {
      e.preventDefault();
      draggedSeparator = rightSeparator;
      startX = e.clientX;
      startWidth = colList.offsetWidth;
      document.addEventListener("mousemove", mousemove);
      document.addEventListener("mouseup", mouseup);
    });

    return this.editInstructions(instructions, colList, displayUpdateCallback, colSong, colPreview);
  }

  private getInstructedLines() {
    if (!this.chordPro || !this.readOnly || !this.instructions || !this.instructionsRenderMode) return null;
    if (!this.instructedLines) {
      const doc = this.chordPro;
      const firstLines = new Map<string, ChordProLine | null>();
      const lines: ChordProLine[] = [];
      const genComment = (text: string, type: ChordProCommentType = "") => {
        const line_obj = new ChordProLine(doc);
        line_obj.setCommentDirectiveType(type);
        line_obj.setLyrics(fixChordProText(text));
        line_obj.genText();
        return line_obj;
      };
      for (const item of this.instructions.items) {
        if (item.multiplier == null) {
          lines.push(genComment(item.value, "italic"));
        } else if (!firstLines.has(item.value)) {
          let firstLine: ChordProLine | null = null;
          for (const line_obj of this.chordPro.lines) {
            if (!line_obj.isComment && line_obj.getTagInfo().tag === item.value) {
              if (!firstLine) firstLine = line_obj;
              const line = line_obj instanceof ChordProAbc ? line_obj.toGrid(true) : line_obj.clone(true);
              line.multiplierOverride = item.multiplier;
              lines.push(line);
            }
          }
          firstLines.set(item.value, firstLine);
        } else {
          if (this.instructionsRenderMode === "FIRST_LINE") {
            const first = firstLines.get(item.value);
            if (first) {
              const line = first instanceof ChordProAbc ? first.toGrid(false)[0] : first.clone();
              line.insertString(line.text.length, " ...");
              line.multiplierOverride = item.multiplier;
              line.sourceLineNumber = -1; // to prevent from highlight
              lines.push(line);
              continue;
            }
          }
          lines.push(genComment(item.value + (item.multiplier > 1 ? ` ${item.multiplier}x` : "")));
        }
      }
      this.instructedLines = lines;
    }
    return this.instructedLines;
  }
}
