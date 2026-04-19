// Thin wrapper around the `abc-gui` package (github:tomika/abc-gui).
// Preserves the AbcWysiwygEditor public surface that chordpro_editor.ts uses:
//   - constructor(parentElement, callbacks, isDark, localize, tooltip, locale)
//   - open(abc: string)
//   - close(apply: boolean)
//   - setDark(isDark: boolean)
//   - setLocale(locale)
//   - dispose()
//   - isOpen

import { mount, type AbcEditor, type LocaleId } from "abc-gui";
import "abc-gui/style.css";
import { chordMap } from "./allchords";

const NOTE_BASE_MIDI: Record<string, number> = {
  C: 60,
  D: 62,
  E: 64,
  F: 65,
  G: 67,
  A: 69,
  B: 71,
};

function accidentalShift(a: string | undefined): number {
  if (!a) return 0;
  if (a === "#" || a === "\u266F") return 1;
  if (a === "b" || a === "\u266D") return -1;
  return 0;
}

function chordToMidi(chord: string): number[] {
  if (!chord) return [];
  const m = /^\s*([A-G])([#b\u266F\u266D]?)([^/\s]*)(?:\s*\/\s*([A-G])([#b\u266F\u266D]?))?\s*$/.exec(chord);
  if (!m) return [];
  const rootBase = NOTE_BASE_MIDI[m[1]];
  if (rootBase === undefined) return [];
  const root = rootBase + accidentalShift(m[2]);
  const quality = (m[3] ?? "").trim();
  const info = chordMap.get(quality);
  const steps = info && info.steps.length > 0 ? info.steps : [0, 4, 7];
  const notes = steps.map((s) => root + s);
  if (m[4]) {
    const bassBase = NOTE_BASE_MIDI[m[4]];
    if (bassBase !== undefined) {
      const bass = bassBase + accidentalShift(m[5]) - 12;
      notes.unshift(bass);
    }
  }
  return notes;
}

export interface AbcEditorCallbacks {
  onAbcTextChanged?: (newText: string) => void;
  onClose?: (newText: string | undefined) => void;
  onOpenChordSelector?: (currentChord: string, onSelected: (chord?: string) => void) => void;
}

export class AbcWysiwygEditor {
  private backdrop: HTMLDivElement;
  private container: HTMLDivElement;
  private host: HTMLDivElement;
  private splashOverlay: HTMLDivElement | null = null;

  private editor: AbcEditor | null = null;
  private originalAbc = "";
  private currentAbc = "";
  private isDark = false;
  private locale: LocaleId = "en";
  private disposed = false;
  private localizeFn?: (s: string) => string;

  get isOpen(): boolean {
    return this.backdrop.style.display !== "none";
  }

  constructor(
    private parentElement: HTMLElement,
    private callbacks: AbcEditorCallbacks = {},
    isDark = false,
    localize?: (s: string) => string,
    _tooltip?: (key: string) => string | undefined,
    locale: LocaleId = "en"
  ) {
    this.isDark = isDark;
    this.localizeFn = localize;
    this.locale = locale;

    this.backdrop = document.createElement("div");
    this.backdrop.className = "abc-editor-backdrop";
    this.backdrop.style.display = "none";
    this.backdrop.addEventListener("mousedown", (e) => {
      if (e.target === this.backdrop) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    this.container = document.createElement("div");
    this.container.className = "abc-wysiwyg-editor" + (this.isDark ? " dark" : "");
    this.backdrop.appendChild(this.container);

    const header = document.createElement("div");
    header.className = "abc-editor-header";

    const title = document.createElement("span");
    title.className = "abc-editor-title";
    title.textContent = this.L("ABC Notation Editor");
    header.appendChild(title);

    const btns = document.createElement("span");
    btns.className = "abc-editor-header-btns";

    const helpBtn = document.createElement("button");
    helpBtn.type = "button";
    helpBtn.className = "abc-toolbar-btn";
    helpBtn.textContent = "\u2753 " + this.L("Help");
    helpBtn.title = this.L("Show tutorial");
    helpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showSplash();
    });

    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "abc-toolbar-btn abc-apply-btn";
    applyBtn.textContent = "\u2713 " + this.L("Apply");
    applyBtn.title = this.L("Apply changes and close");
    applyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close(true);
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "abc-toolbar-btn abc-cancel-btn";
    cancelBtn.textContent = "\u2715 " + this.L("Cancel");
    cancelBtn.title = this.L("Discard changes and close");
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.close(false);
    });

    btns.appendChild(helpBtn);
    btns.appendChild(applyBtn);
    btns.appendChild(cancelBtn);
    header.appendChild(btns);
    this.container.appendChild(header);

    this.host = document.createElement("div");
    this.host.className = "abc-gui-host";
    this.host.style.flex = "1 1 auto";
    this.host.style.minHeight = "0";
    this.host.style.overflow = "hidden";
    this.container.appendChild(this.host);

    // Attach to document.body so the editor covers the full client area
    // (like CompareDialog) rather than just the chordpro parent element.
    document.body.appendChild(this.backdrop);
  }

  open(abcText: string, germanAlphabet?: boolean) {
    if (this.disposed) return;
    this.originalAbc = abcText;
    this.currentAbc = abcText;
    this.backdrop.style.display = "";

    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }
    this.host.innerHTML = "";

    this.editor = mount(this.host, {
      value: abcText,
      theme: this.isDark ? "dark" : "light",
      locale: this.locale,
      onChange: (abc) => {
        this.currentAbc = abc;
      },
      chordEditor: (seed) => this.invokeChordEditor(seed),
      abcjsOptions: {
        germanAlphabet,
        jazzchords: true,
      },
    });
  }

  close(apply: boolean) {
    if (!this.isOpen) return;
    const newText = this.currentAbc;
    this.backdrop.style.display = "none";
    this.closeSplash();

    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }
    this.host.innerHTML = "";

    if (apply && newText !== this.originalAbc) {
      this.callbacks.onAbcTextChanged?.(newText);
    }
    this.callbacks.onClose?.(apply ? newText : undefined);
  }

  setDark(isDark: boolean) {
    this.isDark = isDark;
    this.container.classList.toggle("dark", isDark);
    this.editor?.setTheme(isDark ? "dark" : "light");
  }

  setLocale(locale: LocaleId) {
    this.locale = locale;
    this.editor?.setLocale(locale);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.closeSplash();
    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }
    this.backdrop.remove();
  }

  private invokeChordEditor(seed: string): Promise<{ chordName: string; chordMidiValues: number[] }> {
    return new Promise((resolve) => {
      const cb = this.callbacks.onOpenChordSelector;
      if (!cb) {
        resolve({ chordName: seed, chordMidiValues: chordToMidi(seed) });
        return;
      }
      cb(seed, (chord) => {
        const chordName = chord ?? seed;
        resolve({ chordName, chordMidiValues: chordToMidi(chordName) });
      });
    });
  }

  private L(s: string): string {
    return this.localizeFn?.(s) ?? s;
  }

  private showSplash() {
    if (!this.editor) return;
    this.closeSplash();

    const overlay = document.createElement("div");
    overlay.className = "abc-splash-overlay";

    const card = document.createElement("div");
    card.className = "abc-splash-card";

    const title = document.createElement("h3");
    title.className = "abc-splash-title";
    title.textContent = this.L("Tutorial Title");
    card.appendChild(title);

    const tutorial = document.createElement("div");
    tutorial.className = "abc-splash-tutorial";
    tutorial.innerHTML = this.editor.getTutorialHtml();
    card.appendChild(tutorial);

    const btnRow = document.createElement("div");
    btnRow.className = "abc-splash-btns";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "abc-toolbar-btn abc-apply-btn";
    closeBtn.textContent = this.L("Tutorial Close");
    closeBtn.addEventListener("click", () => this.closeSplash());

    btnRow.appendChild(closeBtn);
    card.appendChild(btnRow);
    overlay.appendChild(card);

    this.container.appendChild(overlay);
    this.splashOverlay = overlay;
  }

  private closeSplash() {
    if (this.splashOverlay) {
      this.splashOverlay.remove();
      this.splashOverlay = null;
    }
  }
}
