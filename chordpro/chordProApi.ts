import {
  CHORDFORMAT_BB,
  CHORDFORMAT_LCMOLL,
  CHORDFORMAT_NOMMOL,
  CHORDFORMAT_NOCHORDS,
  CHORDFORMAT_SUBSCRIPT,
  ChordProEditor,
  ChordBoxType,
  NoteHitBox,
} from "./chordpro_editor";
import { getChordSystem, ChordSystem, ChordProDocument } from "./chordpro_base";
import { ChordSelector } from "./chord_selector";
import { getAllKnownChordModifier as collectKnownChordModifiers, getChordFindAndSplitPattern as collectChordPattern } from "./praiseprojector";
import { ChordDetails, NoteSystemCode } from "./note_system";
import * as clipboard from "./clipboard";

const NOTE_SYSTEM_CODE: NoteSystemCode = "G";

let editor: ChordProEditor | null = null;
let chordSelector: ChordSelector | null = null;
let chordSelectorHost: HTMLDivElement | null = null;
let currentLocaleHandler: ((s: string) => string) | null = null;

function ensureChordSelector(system: ChordSystem): ChordSelector | undefined {
  const host = document.getElementById("chordsel") as HTMLDivElement | null;
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
          editor?.chordSelectorClosed(chord);
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
        closeSelector: "closeSelector",
        applySelector: "applySelector",
      },
      (type: ChordBoxType, chord: string | ChordDetails, canvas: HTMLCanvasElement, variant: number) => {
        if (!editor) return [];
        const hits: NoteHitBox[] = [];
        editor.chordBoxDrawHelper(type, chord, canvas, variant, undefined, hits);
        return hits;
      }
    );
    chordSelectorHost = host;
  } else {
    chordSelector.setNoteSystem(system);
  }

  return chordSelector;
}

function createEditor(editorDiv: HTMLDivElement, chp: string, editable?: boolean, compareBase?: string) {
  const system = getChordSystem(NOTE_SYSTEM_CODE);
  const selector = ensureChordSelector(system);

  if (editor) {
    editor.dispose();
    editor = null;
  }

  editor = new ChordProEditor(system, editorDiv, chp, !!editable, undefined, selector, false, compareBase, true, false);
  editor.darkMode(document.documentElement.getAttribute("data-theme") === "dark");
  if (currentLocaleHandler) {
    editor.installLocaleHandler(currentLocaleHandler);
  }
  return editor;
}

function forwardToExternal(eventName: string, payload?: unknown) {
  const webview = (window as unknown as { chrome?: { webview?: { postMessage: (message: string) => void } } }).chrome?.webview;
  const message = payload !== undefined ? `${eventName}\n${payload}` : `${eventName}\n`;
  if (webview) {
    webview.postMessage(message);
  } else {
    const external = (window as unknown as { external?: Record<string, (data?: unknown) => unknown> }).external;
    const handler = external?.[eventName];
    if (typeof handler === "function") {
      handler(payload);
    }
  }
}

function setupEditorCallbacks() {
  if (!editor) {
    return;
  }

  editor.onChange = (text) => {
    forwardToExternal("UpdateChordProData", text);
  };

  editor.onLog = (message) => {
    forwardToExternal("LogFromWebEditor", message);
  };

  editor.onLineSel = (line) => {
    forwardToExternal("OnLineSel", line);
  };

  editor.onLineDblclk = (line) => {
    forwardToExternal("OnLineDblclk", line);
  };

  editor.onCopy = (text) => {
    // Write to system clipboard (the editor skips this when onCopy is set)
    clipboard.writeText(text).catch(() => {});
    // Also forward to external C# host if present
    forwardToExternal("OnCopy", text ?? "");
  };

  // Don't set editor.onPaste — when onPaste is set the editor calls it and
  // returns without actually inserting anything (it was designed for the C#
  // host that would call externalPaste() in response).  Leaving it null lets
  // the editor use its built-in navigator.clipboard.readText() path.
}

function getEditor() {
  if (!editor) {
    throw new Error("ChordPro editor is not initialised");
  }
  return editor;
}

export const chordProAPI = {
  load(editorDiv: HTMLDivElement, chp: string, editable?: boolean, compareBase?: string) {
    createEditor(editorDiv, chp, editable, compareBase);
    setupEditorCallbacks();
  },
  getText() {
    return editor?.chordProCode ?? "";
  },
  setDisplay(title: boolean, meta: boolean, superscript: boolean, bb: boolean, mollMode: string, tagMode: string, scale: number, noChords: boolean) {
    const instance = getEditor();
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
  },
  transpose(shift: number) {
    getEditor().transpose(shift);
  },
  enableEdit(enable: boolean, multiChordChangeEnabled = true) {
    const instance = getEditor();
    instance.setReadOnly(!enable, multiChordChangeEnabled);
    if (enable) {
      instance.focus();
    }
    instance.highlight(0, 0);
  },
  tagSelection(tagName: string, tagValue?: string) {
    getEditor().tagSelection(tagName, tagValue);
  },
  makeSelectionTitle() {
    getEditor().makeSelectionTitle();
  },
  highlight(from: number, to: number) {
    getEditor().highlight(from, to);
  },
  updateDocument(chp: string) {
    getEditor().externalUpdate(chp);
  },
  getAllKnownChordModifier() {
    return collectKnownChordModifiers("\n");
  },
  getChordFindAndSplitPattern() {
    return collectChordPattern(NOTE_SYSTEM_CODE);
  },
  getUnknownChords() {
    return getEditor().getUnknownChords().join("\n");
  },
  dispose() {
    if (editor) {
      editor.dispose();
      editor = null;
    }
  },
  installLocaleHandler(handler: (s: string) => string) {
    currentLocaleHandler = handler;
    if (editor) {
      editor.installLocaleHandler(handler);
    }
  },
  darkMode(dark: boolean) {
    if (editor) {
      editor.darkMode(dark);
    }
  },
};

type ChordProAPI = typeof chordProAPI;

export function getChordProAPI(): ChordProAPI {
  return chordProAPI;
}

export function getMetadataList() {
  return ChordProDocument.metaDataDirectives.join(":");
}
