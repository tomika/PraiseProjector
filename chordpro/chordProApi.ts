import {
  CHORDFORMAT_BB,
  CHORDFORMAT_LCMOLL,
  CHORDFORMAT_NOMMOL,
  CHORDFORMAT_NOCHORDS,
  CHORDFORMAT_SUBSCRIPT,
  ChordProEditor,
} from "./chordpro_editor";
import { getChordSystem, ChordSystem, ChordProDocument } from "./chordpro_base";
import { ChordSelector } from "./chord_selector";
import { getAllKnownChordModifier as collectKnownChordModifiers, getChordFindAndSplitPattern as collectChordPattern } from "./praiseprojector";
import { ChordDetails, NoteSystemCode } from "./note_system";
import * as clipboard from "./clipboard";
import { ChordBoxType } from "./chord_drawer";
import { NoteHitBox } from "./ui_base";

const NOTE_SYSTEM_CODE: NoteSystemCode = "G";

let activeEditor: ChordProEditor | null = null;
let activeEditorDiv: HTMLDivElement | null = null;
const editors = new Map<HTMLDivElement, ChordProEditor>();
let chordSelector: ChordSelector | null = null;
let chordSelectorHost: HTMLDivElement | null = null;
let currentLocaleHandler: ((s: string) => string) | null = null;

function setActiveEditor(editorDiv: HTMLDivElement | null) {
  activeEditorDiv = editorDiv;
  activeEditor = editorDiv ? (editors.get(editorDiv) ?? null) : null;
  return activeEditor;
}

function getEditorInstance(editorDiv?: HTMLDivElement | null) {
  if (editorDiv) {
    const instance = editors.get(editorDiv) ?? null;
    if (instance) setActiveEditor(editorDiv);
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
        closeSelector: "closeSelector",
        applySelector: "applySelector",
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

function createEditor(editorDiv: HTMLDivElement, chp: string, editable?: boolean, compareBase?: string) {
  const system = getChordSystem(NOTE_SYSTEM_CODE);
  const selector = ensureChordSelector(system);

  disposeEditor(editorDiv);

  const editor = new ChordProEditor(system, editorDiv, chp, !!editable, undefined, selector, false, compareBase, true, false);
  editors.set(editorDiv, editor);
  setActiveEditor(editorDiv);
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
  if (!activeEditor) {
    return;
  }

  activeEditor.onChange = (text) => {
    forwardToExternal("UpdateChordProData", text);
  };

  activeEditor.onLog = (message) => {
    forwardToExternal("LogFromWebEditor", message);
  };

  activeEditor.onLineSel = (line) => {
    forwardToExternal("OnLineSel", line);
  };

  activeEditor.onLineDblclk = (line) => {
    forwardToExternal("OnLineDblclk", line);
  };

  activeEditor.onCopy = (plain, chordpro) => {
    // Write both MIME types to system clipboard (editor skips this when onCopy is set)
    clipboard.writeItems(plain, chordpro).catch(() => {});
    // Also forward chordpro text to external C# host if present
    forwardToExternal("OnCopy", chordpro ?? "");
  };

  // Don't set editor.onPaste — when onPaste is set the editor calls it and
  // returns without actually inserting anything (it was designed for the C#
  // host that would call externalPaste() in response).  Leaving it null lets
  // the editor use its built-in navigator.clipboard.readText() path.
}

function getRequiredEditor(editorDiv?: HTMLDivElement | null) {
  const editor = getEditorInstance(editorDiv);
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
  const getBoundEditor = () => getEditorInstance(editorDiv);

  return {
    load: (chp: string, editable?: boolean, compareBase?: string) => chordProAPI.load(editorDiv, chp, editable, compareBase),
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
    transpose: (shift: number) => {
      const instance = getBoundEditor();
      if (!instance) return;
      instance.transpose(shift);
    },
    enableEdit: (enable: boolean, multiChordChangeEnabled = true) => {
      const instance = getBoundEditor();
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
    highlight: (from: number, to: number) => {
      const instance = getBoundEditor();
      if (!instance) return;
      instance.highlight(from, to);
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
    darkMode: (dark: boolean) => {
      const instance = getBoundEditor();
      if (instance) instance.darkMode(dark);
    },
    refreshDisplayProps: () => {
      const instance = getBoundEditor();
      if (instance) instance.refreshDisplayProps();
    },
  };
}

export const chordProAPI = {
  bind(editorDiv: HTMLDivElement) {
    return bindEditor(editorDiv);
  },
  load(editorDiv: HTMLDivElement, chp: string, editable?: boolean, compareBase?: string) {
    createEditor(editorDiv, chp, editable, compareBase);
    setupEditorCallbacks();
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
  darkMode(dark: boolean) {
    const instance = getEditorInstance();
    if (instance) instance.darkMode(dark);
  },
  refreshDisplayProps() {
    const instance = getEditorInstance();
    if (instance) instance.refreshDisplayProps();
  },
};

type ChordProAPI = typeof chordProAPI;

export function getChordProAPI(): ChordProAPI {
  return chordProAPI;
}

export function getMetadataList() {
  return ChordProDocument.metaDataDirectives.join(":");
}
