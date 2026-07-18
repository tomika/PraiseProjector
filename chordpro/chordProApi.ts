import {
  CHORDFORMAT_BB,
  CHORDFORMAT_LCMOLL,
  CHORDFORMAT_NOMMOL,
  CHORDFORMAT_NOCHORDS,
  CHORDFORMAT_SUBSCRIPT,
  ChordProEditorEventHandlers,
  ChordProEditor,
  ChordProEditorOptions,
  HighlightingParams,
  InstructionsRenderMode,
} from "./chordpro_editor";
import type { SectionRepeatCount } from "./chordpro_editor";
import { getChordSystem, ChordSystem, ChordProDocument } from "./chordpro_base";
import { ChordSelector } from "./chord_selector";
import { getAllKnownChordModifier as collectKnownChordModifiers, getChordFindAndSplitPattern as collectChordPattern } from "./praiseprojector";
import { ChordDetails, NoteSystemCode } from "./note_system";
import * as clipboard from "./clipboard";
import { ChordBoxType } from "./chord_drawer";
import { NoteHitBox } from "./ui_base";
import type { ChordProStylesSettings } from "./chordpro_styles";

const NOTE_SYSTEM_CODE: NoteSystemCode = "G";

let activeEditor: ChordProEditor | null = null;
let activeEditorDiv: HTMLDivElement | null = null;
const editors = new Map<HTMLDivElement, ChordProEditor>();
// A page flip temporarily reparents the visible client-view page under <body>.
// Remember its scoped selector host so a song loaded while lifted cannot fall
// through to an unrelated document-wide #chordsel (the embedded full app has
// one too).
const editorChordSelectorHosts = new WeakMap<HTMLDivElement, HTMLDivElement>();
const editorChordSelectorDiscardHandlers = new WeakMap<HTMLDivElement, (discard: () => void) => void>();
let chordSelector: ChordSelector | null = null;
let chordSelectorHost: HTMLDivElement | null = null;
let currentLocaleHandler: ((s: string) => string) | null = null;
let currentTooltipHandler: ((key: string) => string | undefined) | null = null;
let currentAbcLocale: "en" | "hu" = "en";

function setActiveEditor(editorDiv: HTMLDivElement | null) {
  activeEditorDiv = editorDiv;
  activeEditor = editorDiv ? (editors.get(editorDiv) ?? null) : null;
  return activeEditor;
}

function getEditorInstance(editorDiv?: HTMLDivElement | null, activate = true) {
  if (editorDiv) {
    const instance = editors.get(editorDiv) ?? null;
    if (instance && activate) setActiveEditor(editorDiv);
    return instance;
  }
  if (activeEditorDiv) {
    const instance = editors.get(activeEditorDiv) ?? null;
    if (instance) {
      activeEditor = instance;
      return instance;
    }
  }
  for (const [host, instance] of editors) {
    setActiveEditor(host);
    return instance;
  }
  return null;
}

function disposeEditor(editorDiv?: HTMLDivElement | null) {
  const targetDiv = editorDiv ?? activeEditorDiv;
  if (!targetDiv) return;

  const instance = editors.get(targetDiv);
  if (!instance) return;

  instance.dispose();
  editors.delete(targetDiv);

  if (activeEditorDiv === targetDiv) {
    const next = editors.keys().next();
    setActiveEditor(next.done ? null : next.value);
  }
}

function findChordSelectorHost(editorDiv?: HTMLDivElement | null): HTMLDivElement | null {
  const localHost = editorDiv?.querySelector("#chordsel");
  if (localHost instanceof HTMLDivElement) {
    if (editorDiv) editorChordSelectorHosts.set(editorDiv, localHost);
    return localHost;
  }

  const scopedHost = editorDiv?.closest("#swipe-handler, .editor-iframe-container")?.querySelector("#chordsel");
  if (scopedHost instanceof HTMLDivElement) {
    if (editorDiv) editorChordSelectorHosts.set(editorDiv, scopedHost);
    return scopedHost;
  }

  const rememberedHost = editorDiv ? editorChordSelectorHosts.get(editorDiv) : undefined;
  if (rememberedHost?.isConnected) return rememberedHost;

  return document.getElementById("chordsel") as HTMLDivElement | null;
}

function ensureChordSelector(system: ChordSystem, editorDiv?: HTMLDivElement | null): ChordSelector | undefined {
  const host = findChordSelectorHost(editorDiv);
  if (!host) {
    chordSelector = null;
    chordSelectorHost = null;
    return undefined;
  }

  if (!chordSelector || chordSelectorHost !== host) {
    chordSelector = new ChordSelector(
      system,
      host,
      {
        onClose: (chord?: string) => {
          activeEditor?.chordSelectorClosed(chord);
        },
        baseNoteSelector: "baseNoteSel",
        bassNoteSelector: "bassNoteSel",
        modifierSelector: "modifier",
        customSpan: "customSpan",
        subscript: "subscript",
        baseNoteSpan: "baseNoteSpan",
        steps: "steps",
        notes: "notes",
        guitarChordBox: "guitarChordBox",
        pianoChordBox: "pianoChordBox",
        musicChordBox: "musicChordBox",
        applySelector: "applySelector",
        onConfirmDiscard: editorChordSelectorDiscardHandlers.get(editorDiv ?? host),
      },
      (type: ChordBoxType, chord: string | ChordDetails, canvas: HTMLCanvasElement, variant: number) => {
        if (!activeEditor) return [];
        const hits: NoteHitBox[] = [];
        activeEditor.chordBoxDrawHelper(type, chord, canvas, variant, undefined, hits);
        return hits;
      }
    );
    chordSelectorHost = host;
  } else {
    chordSelector.setNoteSystem(system);
  }

  return chordSelector;
}

function createEditor(
  editorDiv: HTMLDivElement,
  chp: string,
  editable?: boolean,
  compareBase?: string,
  eventHandlers?: ChordProEditorEventHandlers,
  suppressDraw?: boolean,
  activate = true,
  internalOptions?: ChordProEditorOptions
) {
  const system = getChordSystem(NOTE_SYSTEM_CODE);
  const selector = ensureChordSelector(system, editorDiv);

  disposeEditor(editorDiv);

  // suppressDraw constructs the editor without an initial paint so the caller can
  // apply transpose/capo + display settings first and draw exactly once (via
  // fitToPane → update). This avoids a one-frame flash of the untransposed song
  // when switching songs in the client view.
  const editor = new ChordProEditor(
    system,
    editorDiv,
    chp,
    !!editable,
    undefined,
    selector,
    !!suppressDraw,
    compareBase,
    true,
    false,
    eventHandlers,
    internalOptions
  );
  if (eventHandlers?.OnCopy) {
    editor.onCopy = (plain, chordpro) => {
      // Write both MIME types to system clipboard (editor skips this when onCopy is set)
      clipboard.writeItems(plain, chordpro).catch(() => {});
      eventHandlers.OnCopy?.(chordpro ?? "");
    };
  }
  editors.set(editorDiv, editor);
  if (activate || !activeEditorDiv || activeEditorDiv === editorDiv) setActiveEditor(editorDiv);
  editor.darkMode(document.documentElement.getAttribute("data-theme") === "dark");
  if (currentLocaleHandler) {
    editor.installLocaleHandler(currentLocaleHandler);
  }
  if (currentTooltipHandler) {
    editor.installTooltipHandler(currentTooltipHandler);
  }
  editor.setAbcLocale(currentAbcLocale);
  return editor;
}

function getRequiredEditor(editorDiv?: HTMLDivElement | null, activate = true) {
  const editor = getEditorInstance(editorDiv, activate);
  if (!editor) {
    throw new Error("ChordPro editor is not initialised");
  }
  return editor;
}

function applyDisplaySettings(
  instance: ChordProEditor,
  title: boolean,
  meta: boolean,
  superscript: boolean,
  bb: boolean,
  mollMode: string,
  tagMode: string,
  scale: number,
  noChords: boolean
) {
  const mode = (tagMode || "full").toLowerCase().substring(0, 1);
  let chordFormatFlags = 0;
  switch (mollMode) {
    case "am":
      chordFormatFlags = CHORDFORMAT_LCMOLL;
      break;
    case "a":
      chordFormatFlags = CHORDFORMAT_NOMMOL;
      break;
    default:
      chordFormatFlags = 0;
      break;
  }
  if (superscript) chordFormatFlags |= CHORDFORMAT_SUBSCRIPT;
  if (bb) chordFormatFlags |= CHORDFORMAT_BB;
  if (noChords) chordFormatFlags |= CHORDFORMAT_NOCHORDS;
  instance.scale = scale;
  instance.setDisplayMode(title, meta, mode !== "n", mode === "a", false, chordFormatFlags);
}

function bindEditor(editorDiv: HTMLDivElement) {
  const getBoundEditor = (activate = false) => getEditorInstance(editorDiv, activate);

  return {
    setChordSelectorDiscardHandler: (handler: ((discard: () => void) => void) | undefined) => {
      if (handler) editorChordSelectorDiscardHandlers.set(editorDiv, handler);
      else editorChordSelectorDiscardHandlers.delete(editorDiv);
      if (chordSelectorHost === findChordSelectorHost(editorDiv)) chordSelector?.setConfirmDiscardHandler(handler);
    },
    load: (
      chp: string,
      editable?: boolean,
      compareBase?: string,
      eventHandlers?: ChordProEditorEventHandlers,
      suppressDraw?: boolean,
      internalOptions?: ChordProEditorOptions
    ) =>
      createEditor(
        editorDiv,
        chp,
        editable,
        compareBase,
        eventHandlers,
        suppressDraw,
        !activeEditorDiv || activeEditorDiv === editorDiv,
        internalOptions
      ),
    getText: () => getBoundEditor()?.chordProCode ?? "",
    setDisplay: (
      title: boolean,
      meta: boolean,
      superscript: boolean,
      bb: boolean,
      mollMode: string,
      tagMode: string,
      scale: number,
      noChords: boolean
    ) => {
      const instance = getBoundEditor();
      if (!instance) return;
      applyDisplaySettings(instance, title, meta, superscript, bb, mollMode, tagMode, scale, noChords);
    },
    setDisplayMode: (
      title: boolean,
      meta: boolean,
      tag: boolean,
      abbrevTag: boolean,
      autoSplitLines: boolean,
      chordFlags: number,
      chordBoxType?: ChordBoxType
    ) => {
      const instance = getBoundEditor();
      if (!instance) return;
      instance.setDisplayMode(title, meta, tag, abbrevTag, autoSplitLines, chordFlags, chordBoxType);
    },
    transpose: (shift: number) => {
      const instance = getBoundEditor();
      if (!instance) return;
      instance.transpose(shift);
    },
    enableEdit: (enable: boolean, multiChordChangeEnabled = true) => {
      const instance = getBoundEditor(true);
      if (!instance) return;
      instance.setReadOnly(!enable, multiChordChangeEnabled);
      if (enable) instance.focus();
      instance.highlight(0, 0);
    },
    tagSelection: (tagName: string, tagValue?: string) => {
      const instance = getBoundEditor();
      if (!instance) return;
      instance.tagSelection(tagName, tagValue);
    },
    makeSelectionTitle: () => {
      const instance = getBoundEditor();
      if (!instance) return;
      instance.makeSelectionTitle();
    },
    setSectionRepeatCounts: (sectionRepeatCounts: SectionRepeatCount[] | undefined, draw = true) => {
      const instance = getBoundEditor();
      if (!instance) return;
      instance.setSectionRepeatCounts(sectionRepeatCounts, draw);
    },
    highlight: (from: number, to: number, section?: number, repeatNonce?: number, draw = true) => {
      const instance = getBoundEditor();
      if (!instance) return;
      instance.highlight(from, to, section, repeatNonce, draw);
    },
    /** Set the song's display-instructions TEXT on the editor (legacy
     *  applyInstructions). Whether/how it is drawn is controlled separately by
     *  enableInstructionRendering. */
    applyInstructions: (instructions: string, draw = true) => {
      const instance = getBoundEditor();
      if (instance) instance.applyInstructions(instructions, draw);
    },
    /** Toggle how the instructions overlay is rendered: "FULL" / "FIRST_LINE" /
     *  "" (off) — mirrors the legacy chkInstructions toggle (praiseprojector.ts
     *  enableInstructionRendering at the displayChanged call site). */
    enableInstructionRendering: (mode: InstructionsRenderMode, draw = true) => {
      const instance = getBoundEditor();
      if (instance) instance.enableInstructionRendering(mode, draw);
    },
    /** Install (or clear with null) a tap handler that fires {from,to,section}
     *  for the tapped lyrics line — drives leader highlight control. */
    setLyricsHitHandler: (handler: ((hit: HighlightingParams) => void) | null) => {
      const instance = getBoundEditor();
      if (instance) instance.onLyricsHit = handler;
    },
    updateDocument: (chp: string) => {
      const instance = getBoundEditor();
      if (!instance) return;
      instance.externalUpdate(chp);
    },
    getAllKnownChordModifier: () => chordProAPI.getAllKnownChordModifier(),
    getChordFindAndSplitPattern: () => chordProAPI.getChordFindAndSplitPattern(),
    getUnknownChords: () => getBoundEditor()?.getUnknownChords().join("\n") ?? "",
    dispose: () => disposeEditor(editorDiv),
    installLocaleHandler: (handler: (s: string) => string) => {
      currentLocaleHandler = handler;
      const instance = getBoundEditor();
      if (instance) instance.installLocaleHandler(handler);
    },
    installTooltipHandler: (handler: (key: string) => string | undefined) => {
      currentTooltipHandler = handler;
      const instance = getBoundEditor();
      if (instance) instance.installTooltipHandler(handler);
    },
    setAbcLocale: (locale: "en" | "hu") => {
      currentAbcLocale = locale;
      const instance = getBoundEditor();
      if (instance) instance.setAbcLocale(locale);
    },
    darkMode: (dark: boolean) => {
      const instance = getBoundEditor();
      if (instance) instance.darkMode(dark);
    },
    setHighlightOpacity: (opacity: number) => {
      const instance = getBoundEditor();
      if (instance) instance.highlightOpacity = Math.max(0, Math.min(1, opacity));
    },
    update: () => {
      const instance = getBoundEditor();
      if (instance) instance.update();
    },
    refreshDisplayProps: () => {
      const instance = getBoundEditor();
      if (instance) instance.refreshDisplayProps();
    },
    /**
     * Re-layout the song to its pane (mirrors praiseprojector.ts updateEditor).
     * scrollMode false = FULL PAGE: lay the song out to the pane's aspect ratio so
     * it fills the screen. scrollMode true = FULL WIDTH: natural layout so CSS can
     * fit the width and scroll vertically.
     */
    fitToPane: (scrollMode = false, viewport?: { readonly width: number; readonly height: number }) => {
      const instance = getBoundEditor();
      if (!instance) return;
      const container = editorDiv.parentElement;
      const w = viewport?.width || container?.clientWidth || editorDiv.clientWidth || 1;
      const h = viewport?.height || container?.clientHeight || editorDiv.clientHeight || 1;
      instance.targetRatio = scrollMode ? 0 : w / h;
      instance.scale = Math.max(1.00000001, Math.round(Math.max(w, h) / 500) + 1);
      // Calling this IS the declaration that the host scales the song to a pane.
      instance.markFitsToPane();
      instance.update();
    },
    setStyles: (styles: ChordProStylesSettings | null) => {
      const instance = getBoundEditor();
      if (instance) instance.setStyles(styles);
    },
    handleExternalChordBoxTouch: (event: MouseEvent, down: boolean, showChordDialog?: boolean) =>
      getBoundEditor(true)?.handleExternalChordBoxTouch(event, down, showChordDialog) ?? false,
    isReadOnly: () => getBoundEditor(true)?.readOnly ?? true,
    isInMarkingState: () => getBoundEditor(true)?.inMarkingState ?? false,
    hasChordSelectorOpen: () => getBoundEditor(true)?.hasChordSelectorOpen() ?? false,
    getSelectedText: () => getBoundEditor()?.getSelectedText() ?? "",
    getLayoutSnapshot: () => getBoundEditor()?.getLayoutSnapshot() ?? { width: 0, height: 0, revision: 0, settled: false },
    setViewportAlignedTitleGeometry: (width: number, rootOffset: number) => getBoundEditor()?.setViewportAlignedTitleGeometry(width, rootOffset),
    subscribeLayout: (listener: Parameters<ChordProEditor["subscribeLayout"]>[0]) => getBoundEditor()?.subscribeLayout(listener) ?? (() => {}),
    // Layout settlement is passive bookkeeping. In the three-page client view,
    // hidden neighbour editors settle asynchronously too; activating one here
    // steals the shared chord selector from the visible/current editor.
    whenLayoutSettled: (afterRevision?: number) => getRequiredEditor(editorDiv, false).whenLayoutSettled(afterRevision),
  };
}

export const chordProAPI = {
  bind(editorDiv: HTMLDivElement) {
    return bindEditor(editorDiv);
  },
  load(
    editorDiv: HTMLDivElement,
    chp: string,
    editable?: boolean,
    compareBase?: string,
    eventHandlers?: ChordProEditorEventHandlers,
    suppressDraw?: boolean,
    internalOptions?: ChordProEditorOptions
  ) {
    createEditor(editorDiv, chp, editable, compareBase, eventHandlers, suppressDraw, true, internalOptions);
  },
  getText() {
    return getEditorInstance()?.chordProCode ?? "";
  },
  setDisplay(title: boolean, meta: boolean, superscript: boolean, bb: boolean, mollMode: string, tagMode: string, scale: number, noChords: boolean) {
    applyDisplaySettings(getRequiredEditor(), title, meta, superscript, bb, mollMode, tagMode, scale, noChords);
  },
  transpose(shift: number) {
    getRequiredEditor().transpose(shift);
  },
  enableEdit(enable: boolean, multiChordChangeEnabled = true) {
    const instance = getRequiredEditor();
    instance.setReadOnly(!enable, multiChordChangeEnabled);
    if (enable) {
      instance.focus();
    }
    instance.highlight(0, 0);
  },
  tagSelection(tagName: string, tagValue?: string) {
    getRequiredEditor().tagSelection(tagName, tagValue);
  },
  makeSelectionTitle() {
    getRequiredEditor().makeSelectionTitle();
  },
  highlight(from: number, to: number) {
    getRequiredEditor().highlight(from, to);
  },
  updateDocument(chp: string) {
    getRequiredEditor().externalUpdate(chp);
  },
  getAllKnownChordModifier() {
    return collectKnownChordModifiers("\n");
  },
  getChordFindAndSplitPattern() {
    return collectChordPattern(NOTE_SYSTEM_CODE);
  },
  getUnknownChords() {
    return getRequiredEditor().getUnknownChords().join("\n");
  },
  dispose() {
    disposeEditor();
  },
  installLocaleHandler(handler: (s: string) => string) {
    currentLocaleHandler = handler;
    editors.forEach((editor) => editor.installLocaleHandler(handler));
  },
  installTooltipHandler(handler: (key: string) => string | undefined) {
    currentTooltipHandler = handler;
    editors.forEach((editor) => editor.installTooltipHandler(handler));
  },
  setAbcLocale(locale: "en" | "hu") {
    currentAbcLocale = locale;
    editors.forEach((editor) => editor.setAbcLocale(locale));
  },
  darkMode(dark: boolean) {
    const instance = getEditorInstance();
    if (instance) instance.darkMode(dark);
  },
  refreshDisplayProps() {
    const instance = getEditorInstance();
    if (instance) instance.refreshDisplayProps();
  },
  setStyles(styles: ChordProStylesSettings | null) {
    const instance = getEditorInstance();
    if (instance) instance.setStyles(styles);
  },
};

type ChordProAPI = typeof chordProAPI;

export function getChordProAPI(): ChordProAPI {
  return chordProAPI;
}

export function getMetadataList() {
  return ChordProDocument.metaDataDirectives.join(":");
}
