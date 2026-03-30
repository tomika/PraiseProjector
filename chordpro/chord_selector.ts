import { allChordInfo, all_modifiers, ChordLayoutGenerator, createChordInfo, stepsToModifier } from "./allchords";
import { ChordProChordBase, ChordSystem, getChordSystem } from "./chordpro_base";
import { ChordDetails, NoteSystemCode } from "./note_system";
import { makeDark, makeReadonly, makeVisible } from "../common/utils";
import { renderAbc } from "abcjs";
import { NoteHitBox } from "./ui_base";
import { ChordBoxType } from "./chord_drawer";

const universalNoteCodes = ["a", "a#", "b", "c", "c#", "d", "d#", "e", "f", "f#", "g", "g#"];

export type ChordSelectorOptions = {
  tuning?: string;
  mode?: "SELECT" | "CREATE" | "SHOW";
  chord?: string;
  onClose?: (chord?: string) => void;
  bassNoteSelector?: string;
  baseNoteSelector?: string;
  modifierSelector?: string;
  subscript?: string;
  steps?: string;
  notes?: string;
  variationSelector?: string;
  table?: string;
  allowBassSeparation?: boolean;
  customSpan?: string;
  baseNoteSpan?: string;
  guitarChordBox?: string;
  pianoChordBox?: string;
  musicChordBox?: string;
  applySelector?: string;
  closeSelector?: string;
};

export class ChordSelector {
  private selBaseNote: HTMLSelectElement;
  private selBassNote: HTMLSelectElement;
  private selModifier: HTMLSelectElement;
  private subscript: HTMLInputElement | null = null;
  private steps: HTMLInputElement | null = null;
  private notes: HTMLInputElement | null = null;
  // private selVariation: HTMLSelectElement;
  // private tblNeck: HTMLTableElement;
  // private chordsCache: ChordVariations;
  private baseNoteSpan: HTMLElement | null = null;
  private customSpan: HTMLElement | null = null;
  private guitarChordBox: HTMLCanvasElement | null = null;
  private pianoChordBox: HTMLCanvasElement | null = null;
  private musicChordBox: HTMLCanvasElement | null = null;
  private selectedChordHitBox: HTMLCanvasElement | null = null;
  private swipeStartPos = 0;
  private guitarVariant = 0;
  private pianoVariant = 0;
  private guitarHitBoxes: NoteHitBox[] = [];
  private pianoHitBoxes: NoteHitBox[] = [];
  private readonly headerWidth = 12;
  private readonly zeroWidth = 10;
  private readonly fretWidth = 40;
  private readonly fretHeight = 22;
  private chordLayoutGenerator: ChordLayoutGenerator;
  private inModalState = false;
  private readOnly = false;
  private onCloseCallback?: (chord?: string) => void;
  private applyButton: HTMLInputElement | null = null;
  private musicChordBoxDivName = "musicChordBox";
  private darkMode = false;
  private themeRefreshHandle: number | null = null;

  public setDarkMode(dark: boolean) {
    if (this.darkMode !== dark) this.darkMode = dark;
    if (this.inModalState) {
      this.applyTheme();
      this.drawChord(this.updateFrom());
      if (this.themeRefreshHandle != null) window.clearTimeout(this.themeRefreshHandle);
      this.themeRefreshHandle = window.setTimeout(() => {
        this.themeRefreshHandle = null;
        if (!this.inModalState) return;
        this.applyTheme();
        this.drawChord(this.updateFrom());
      }, 0);
    }
  }

  private static findOrCreateElement(name: string | null | undefined, type: string, parent: HTMLElement) {
    let element = name ? document.getElementById(name) : null;
    if (!element) {
      element = document.createElement(type);
      parent.appendChild(element);
      if (name === null) {
        element.className = parent.className;
        element.style.display = "none";
      }
    }
    return element;
  }

  private static findOrCreateSelectElement(name: string | null | undefined, parent: HTMLElement, readonly?: boolean) {
    const element = ChordSelector.findOrCreateElement(name, "select", parent) as HTMLSelectElement;
    if (element && readonly) element.disabled = true;
    return element;
  }

  private static chordLayoutGenerators = new Map<string, ChordLayoutGenerator>();

  constructor(
    public system: ChordSystem,
    readonly parent: HTMLElement,
    options: ChordSelectorOptions = {},
    private readonly chordBoxDrawer?: (type: ChordBoxType, chord: string | ChordDetails, canvas: HTMLCanvasElement, variant: number) => NoteHitBox[]
  ) {
    let guitarTuning = [24 + 7, 24 + 2, 12 + 10, 12 + 5, 12, 7];
    if (options.musicChordBox) {
      this.musicChordBoxDivName = options.musicChordBox;
    }
    if (options.tuning) {
      const rxFindNote = new RegExp(system.noteRegexPattern, "g");
      let m: RegExpExecArray | null,
        t: number[] | null = [];
      while ((m = rxFindNote.exec(options.tuning))) {
        const note = system.stringToNote(m.toString());
        if (note === null) {
          t = null;
          break;
        }
      }
      if (t) guitarTuning = t;
    }

    const chordLayoutGeneratorKey = guitarTuning.join("~") + "~" + options.allowBassSeparation;
    let chordLayoutGenerator = ChordSelector.chordLayoutGenerators.get(chordLayoutGeneratorKey);
    if (!chordLayoutGenerator) {
      chordLayoutGenerator = new ChordLayoutGenerator(guitarTuning, { allowBassSeparation: options.allowBassSeparation });
      ChordSelector.chordLayoutGenerators.set(chordLayoutGeneratorKey, chordLayoutGenerator);
    }
    this.chordLayoutGenerator = chordLayoutGenerator;

    this.selBassNote = ChordSelector.findOrCreateSelectElement(options.bassNoteSelector, parent, options.mode === "SHOW");
    for (const key of ["", ...this.system.baseNoteList]) {
      const o = document.createElement("option") as HTMLOptionElement;
      o.value = key;
      o.innerText = key;
      this.selBassNote.appendChild(o);
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (this.readOnly) e.preventDefault();
    };
    this.selBassNote.onkeydown = handleKeyDown;
    this.selBassNote.onchange = () => {
      if (this.selBassNote) this.updateFrom(this.selBassNote);
    };

    this.selBaseNote = ChordSelector.findOrCreateSelectElement(options.baseNoteSelector, parent, options.mode === "SHOW");
    this.selBaseNote.innerHTML = "";
    for (const key of this.system.baseNoteList) {
      const o = document.createElement("option") as HTMLOptionElement;
      o.value = key;
      o.innerText = key;
      this.selBaseNote.appendChild(o);
    }
    this.selBaseNote.onkeydown = handleKeyDown;
    this.selBaseNote.onchange = () => {
      if (this.selBaseNote) this.updateFrom(this.selBaseNote);
    };

    this.selModifier = ChordSelector.findOrCreateSelectElement(options.modifierSelector, parent, options.mode === "SHOW");
    this.selModifier.innerHTML = "";
    for (const modif of all_modifiers) {
      const o = document.createElement("option") as HTMLOptionElement;
      o.value = modif;
      o.innerText = modif;
      this.selModifier.appendChild(o);
    }
    this.selModifier.onkeydown = handleKeyDown;
    this.selModifier.onchange = () => {
      if (this.selModifier) this.updateFrom(this.selModifier);
    };

    if (options.subscript) {
      const e = document.getElementById(options.subscript);
      if (e && e instanceof HTMLInputElement)
        (this.subscript = e).onchange = () => {
          if (this.subscript) this.updateFrom(this.subscript);
        };
      if (this.subscript) this.subscript.onkeydown = handleKeyDown;
    }
    if (options.steps) {
      const e = document.getElementById(options.steps);
      if (e && e instanceof HTMLInputElement)
        (this.steps = e).onchange = () => {
          if (this.steps) this.updateFrom(this.steps);
        };
      if (this.steps) this.steps.onkeydown = handleKeyDown;
    }
    if (options.notes) {
      const e = document.getElementById(options.notes);
      if (e && e instanceof HTMLInputElement)
        (this.notes = e).onchange = () => {
          if (this.notes) this.updateFrom(this.notes);
        };
      if (this.notes) this.notes.onkeydown = handleKeyDown;
    }
    if (options.guitarChordBox) {
      this.guitarChordBox = document.getElementById(options.guitarChordBox) as HTMLCanvasElement;
      //if (this.guitarChordBox) this.guitarChordBox.onclick = (e) => this.clickHandler(this.guitarHitBoxes, e);
    }
    if (options.pianoChordBox) {
      this.pianoChordBox = document.getElementById(options.pianoChordBox) as HTMLCanvasElement;
      //if (this.pianoChordBox) this.pianoChordBox.onclick = (e) => this.clickHandler(this.pianoHitBoxes, e);
    }
    if (options.musicChordBox) this.musicChordBox = document.getElementById(options.musicChordBox) as HTMLCanvasElement;

    /*
        this.selVariation = ChordSelector.findOrCreateSelectElement(options.variationSelector, parent_div, options.mode === "SHOW");
        this.selVariation.className = parent_div.className;
        this.selVariation.onchange = () => this.updateNeck(false);

        this.tblNeck = ChordSelector.findOrCreateElement(options.table, "table", parent_div) as HTMLTableElement;
        this.tblNeck.className = parent_div.className;
        parent_div.appendChild(this.tblNeck);
        */

    if (options.baseNoteSpan) this.baseNoteSpan = document.getElementById(options.baseNoteSpan);

    if (options.customSpan) this.customSpan = document.getElementById(options.customSpan);

    if (this.chordBoxDrawer && (this.guitarChordBox || this.pianoChordBox)) {
      const onresize = () => this.drawChord(this.updateFrom(), true);
      if (window.addEventListener) window.addEventListener("resize", onresize);
    }

    if (options.onClose) this.onCloseCallback = options.onClose;

    if (options.closeSelector) {
      const elem = document.getElementById(options.closeSelector);
      if (elem) elem.onclick = () => this.closeDialog();
    }

    if (options.applySelector) {
      this.applyButton = document.getElementById(options.applySelector) as HTMLInputElement;
      if (this.applyButton) this.applyButton.onclick = () => this.closeDialog(true);
    } else this.applyButton = null;

    setTimeout(() => {
      if (options.chord) this.updateForm(options.chord);
      else this.updateFrom(this.selBaseNote);
    }, 20);

    parent.onmouseup = (e) => this.onMouseUp(e);
    parent.onmousedown = (e) => this.onMouseDown(e);
    parent.onmouseleave = (e) => this.onMouseLeave(e);

    const touchHandler = (e: TouchEvent) => this.touchHandler(e);
    if (parent.addEventListener) {
      // Use capture phase but don't prevent default for form elements
      // The touchHandler will check for form elements and skip processing
      parent.addEventListener("touchstart", touchHandler, { capture: true, passive: false });
      parent.addEventListener("touchmove", touchHandler, { capture: true, passive: false });
      parent.addEventListener("touchend", touchHandler, { capture: true, passive: false });
      parent.addEventListener("touchcancel", touchHandler, { capture: true, passive: false });
    }
  }

  setNoteSystem(system: NoteSystemCode | ChordSystem) {
    if (!(system instanceof ChordSystem)) system = getChordSystem(system);

    if (this.system !== system) {
      this.system = system;

      const notes = this.system.baseNoteList;
      if (this.selBassNote)
        for (let i = 1; i < this.selBassNote.options.length; ++i) {
          const o = this.selBassNote.options[i];
          o.innerText = o.value = notes[i - 1];
        }

      if (this.selBaseNote)
        for (let i = 0; i < this.selBaseNote.options.length; ++i) {
          const o = this.selBaseNote.options[i];
          o.innerText = o.value = notes[i];
        }
    }
  }

  private touchHandler(event: TouchEvent) {
    if (event.changedTouches.length !== 1) return;

    const shouldUseNativeTouch = (element: EventTarget | null) => {
      if (!(element instanceof HTMLElement)) return false;
      const tagName = element.tagName.toUpperCase();
      if (tagName === "SELECT" || tagName === "OPTION" || tagName === "INPUT" || tagName === "BUTTON") return true;
      return false;
    };

    // Skip touch-to-mouse conversion for form elements that need native touch handling
    // (select dropdowns, inputs, buttons need native touch to work properly on mobile)
    // Check both direct target and composed path for form elements
    if (shouldUseNativeTouch(event.target)) return;

    // Also check composed path for nested elements
    const path = event.composedPath?.() || [];
    for (const el of path) {
      if (shouldUseNativeTouch(el)) return;
    }

    const touches = event.changedTouches,
      first = touches[0];
    let type = "";
    switch (event.type) {
      case "touchstart":
        type = "mousedown";
        break;
      case "touchmove":
        type = "mousemove";
        break;
      case "touchend":
        type = "mouseup";
        break;
      default:
        return;
    }

    const simulatedEvent = document.createEvent("MouseEvent");
    simulatedEvent.initMouseEvent(
      type,
      true,
      true,
      window,
      1,
      first.screenX,
      first.screenY,
      first.clientX,
      first.clientY,
      false,
      false,
      false,
      false,
      0 /*left*/,
      null
    );

    event.stopPropagation();
    event.preventDefault();
    first.target.dispatchEvent(simulatedEvent);
  }

  onMouseLeave(_e: MouseEvent) {
    this.selectedChordHitBox = null;
  }

  private getChordElementByPos(x: number, y: number) {
    for (const box of [this.guitarChordBox, this.pianoChordBox]) {
      const rect = box?.getBoundingClientRect();
      if (rect && rect.x <= x && x <= rect.x + rect.width && rect.y <= y && y <= rect.y + rect.height) return box;
    }
    return null;
  }

  private onMouseDown(e: MouseEvent) {
    this.selectedChordHitBox = this.getChordElementByPos(e.clientX, e.clientY);
    this.swipeStartPos = this.selectedChordHitBox ? e.clientX : 0;
  }

  private onMouseUp(e: MouseEvent) {
    if (this.selectedChordHitBox) {
      const hit = this.getChordElementByPos(e.clientX, e.clientY);
      const rect = this.selectedChordHitBox.getBoundingClientRect();
      let offset = e.clientX - this.swipeStartPos;
      if (hit !== this.selectedChordHitBox || Math.abs(offset) >= rect.width / 3) {
        offset = offset > 0 ? 1 : -1;
        if (this.selectedChordHitBox === this.guitarChordBox) this.guitarVariant += offset;
        else if (this.selectedChordHitBox === this.pianoChordBox) this.pianoVariant += offset;
        this.drawChord(this.updateFrom());
      } else if (!this.readOnly && hit === this.selectedChordHitBox) {
        if (hit === this.guitarChordBox) this.clickHandler(this.guitarHitBoxes, e);
        else if (hit === this.pianoChordBox) this.clickHandler(this.pianoHitBoxes, e);
      }
      this.selectedChordHitBox = hit;
      this.swipeStartPos = 0;
    }
  }

  get inModal() {
    return this.inModalState;
  }

  get tuning() {
    return this.chordLayoutGenerator.tuning;
  }

  genChordLayoutsFromChordString(chord: string | ChordDetails, capo: number = 0) {
    const info = this.system.chordDetails(chord);
    if (info) {
      this.chordLayoutGenerator.capo = capo;
      const layouts = this.chordLayoutGenerator.genChordLayouts(info.baseNote, info.bassNote, info.chordInfo);
      if (layouts.length) return layouts;
      return this.chordLayoutGenerator.genChordLayouts(info.baseNote, info.bassNote, info.chordInfo, new Set<string>());
    }
    return null;
  }

  private clickHandler(boxes: NoteHitBox[], event: MouseEvent) {
    const x = event.offsetX,
      y = event.offsetY;
    for (const box of boxes)
      if (box.x <= x && box.y <= y && x < box.x + box.width && y < box.y + box.height) {
        this.toggleNote(box.note, box.param);
        break;
      }
  }

  private toggleNote(note: number, param?: number) {
    note = ((note % 12) + 12) % 12;
    if (param) param = ((param % 12) + 12) % 12;
    if (note !== this.selBaseNote.selectedIndex) {
      let currentNotes: number[] | undefined;
      if (this.notes) {
        currentNotes = [this.system.baseNoteList.indexOf(this.currentBaseNote)];
        if (this.notes.value.trim())
          for (const n of this.notes.value.trim().split("-")) {
            const c = this.system.stringToNote(n);
            if (c === null) {
              currentNotes = undefined;
              break;
            }
            currentNotes.push(c);
          }
      }
      if (!currentNotes) {
        const chord = this.system.identifyChord(this.currentBaseNote + this.currentModifier);
        if (chord) currentNotes = this.system.chordNotes(chord);
      }
      if (currentNotes) {
        if (param === undefined) {
          const filtered = currentNotes.filter((n) => n % 12 !== note);
          if (filtered.length === currentNotes.length) currentNotes.push(note);
          else currentNotes = filtered;
        } else {
          currentNotes = currentNotes.filter((n) => n % 12 !== param);
          if (param !== note && currentNotes.indexOf(note) < 0) currentNotes.push(note);
        }
        const notes = currentNotes.map((n) => this.system.baseNoteList[n % 12]);
        const steps = this.system.convertNotesToSteps(notes.join("-"), true);
        if (steps) {
          const modifier = stepsToModifier(steps);
          if (modifier != null) {
            let s = this.currentBaseNote + modifier;
            if (this.selBassNote && this.selBassNote.selectedIndex > 0) s += "/" + this.system.baseNoteList[this.selBassNote.selectedIndex - 1];
            this.updateForm(s);
          }
        } else if (this.notes) {
          const baseNoteStr = this.currentBaseNote;
          this.notes.value = notes.filter((n) => n !== baseNoteStr).join("-");
          this.guitarVariant = this.pianoVariant = 0;
        }
      }
    }
  }

  private identifyChord(chord: string, createUnknown?: boolean) {
    let info = this.system.identifyChord(chord);
    if (!info && createUnknown) {
      let desc: string | null = null;
      const cpcb = new ChordProChordBase(this.system, chord);
      const baseNote = cpcb.baseNote || this.currentBaseNote;
      if (this.notes) desc = this.system.convertNotesToSteps([baseNote, ...this.notes.value.split("-")].join("-"));
      if (!desc && this.steps) desc = ["1", ...this.steps.value.split("-")].join("-");
      if (desc)
        info = {
          baseNote: this.system.baseNoteList.indexOf(baseNote),
          bassNote: cpcb.bassNote ? this.system.baseNoteList.indexOf(cpcb.bassNote) : null,
          subscript: cpcb.symbol,
          label: "",
          chordInfo: createChordInfo(desc, "?", ["?"]),
        };
    }
    return info;
  }

  private applyTheme() {
    makeDark(this.parent, this.darkMode);
    if (this.guitarChordBox) {
      this.guitarChordBox.style.filter = "";
    }
    if (this.pianoChordBox) {
      this.pianoChordBox.style.filter = "";
    }
    if (this.musicChordBox) {
      makeDark(this.musicChordBox, this.darkMode);
      for (const div of Array.from(this.musicChordBox.getElementsByTagName("div"))) makeDark(div, this.darkMode);
    }
  }

  drawChord(desc: string, resize_only = false) {
    const chord = this.identifyChord(desc, true);
    if (!chord) return;

    if (!resize_only && this.musicChordBox) {
      this.musicChordBox.width = this.musicChordBox.offsetWidth;
      this.musicChordBox.height = this.musicChordBox.offsetHeight;

      let hasLowRegNote = false;
      const universalNoteCode = (n: number) => {
        const m = n % 12;
        const u = universalNoteCodes[m];
        if (m >= 3) return u;
        hasLowRegNote = true;
        return u.toUpperCase();
      };
      const notes = this.system.chordNotes(chord, true);
      if (chord.bassNote != null) {
        const index = notes.indexOf(chord.bassNote);
        if (index >= 0) notes.splice(index, 1);
      }
      const abcformat = (code: string) => (code.endsWith("#") ? "^" + code.substring(0, code.length - 1) : code);
      const keys = notes.map((n) => abcformat(universalNoteCode(n)));
      if (chord.bassNote != null) {
        const suffix = hasLowRegNote ? "," : "";
        keys.push(abcformat(universalNoteCode(chord.bassNote)).toUpperCase() + suffix);
      }
      renderAbc(this.musicChordBoxDivName, "[" + keys.join("") + "]2");
      this.applyTheme();
    }
    if (this.guitarChordBox && this.chordBoxDrawer)
      this.guitarHitBoxes = this.chordBoxDrawer("GUITAR", chord, this.guitarChordBox, this.guitarVariant);
    if (this.pianoChordBox && this.chordBoxDrawer) this.pianoHitBoxes = this.chordBoxDrawer("PIANO", chord, this.pianoChordBox, this.pianoVariant);
  }

  /*
    private chordVariantAvailability(name: string) {
        if (this.chordsCache.hasOwnProperty(name)) return "AVAILABLE";
        if (this.chordsCache.hasOwnProperty(name + "*")) return "SIMPLIFIED";
        return "UNAVAILABLE";
    }

    private updateOptionByAvailability(name: string, option: HTMLOptionElement, label: string) {
        switch (this.chordVariantAvailability(name)) {
            case "AVAILABLE":
                option.disabled = false;
                option.innerText = label;
                break;
            case "SIMPLIFIED":
                option.disabled = false;
                option.innerText = label + "*";
                break;
            case "UNAVAILABLE":
                option.disabled = true;
                option.innerText = label;
                break;
        }
    }
    private updateChordVariantSelectors() {
        for (let i = 0; i < this.selModifier.options.length; ++i) {
            const o = this.selModifier.options[i];
            this.updateOptionByAvailability(o.value, o, o.value);
        }
    }
    private updateChordsCache() {
        const bassNote = this.selBassNote.selectedIndex === 0 ? null : this.selBassNote.selectedIndex - 1;
        this.chordsCache = this.chordLayoutGenerator.genAllChordVariationForKey(this.selBaseNote.selectedIndex, bassNote);
        this.updateChordVariantSelectors();
    }

    private updateVariations() {
        const count = this.getCachedChordLayoutsByName(this.selModifier.value).length;
        if (count < this.selVariation.options.length)
            for (let i = this.selVariation.options.length - 1; i >= count; --i)
                this.selVariation.options.remove(i);
        else for (let i = this.selVariation.options.length; i < count;) {
            const o = document.createElement("option") as HTMLOptionElement;
            o.innerText = o.value = (++i).toString();
            this.selVariation.appendChild(o);
        }
        this.selVariation.selectedIndex = 0;
    }
    */
  private setBaseNote(note: number) {
    this.selBaseNote.selectedIndex = note;
    if (this.baseNoteSpan) this.baseNoteSpan.innerText = this.system.baseNoteList[this.selBaseNote.selectedIndex] + "-";
  }

  private updateForm(chord: string) {
    const info = this.identifyChord(chord, true);
    if (info) {
      this.setBaseNote(info.baseNote);
      if (this.selBassNote) this.selBassNote.selectedIndex = (info.bassNote ?? -1) + 1;
      this.selectChordByName(info.chordInfo.name);
      if (this.subscript) {
        if (info.chordInfo.symbols.indexOf(this.subscript.value) < 0) this.subscript.value = info.subscript;
        if (info.label) this.subscript.classList.remove("invalidInput");
        else this.subscript.classList.add("invalidInput");
      }
      if (this.steps) this.steps.value = info.chordInfo.desc.replace(/^1-/g, "");
      if (this.notes)
        this.notes.value = this.system
          .chordNotes(info)
          .slice(1)
          .map((n) => this.system.baseNoteList[n % 12])
          .join("-");
      this.drawChord(chord);
      if (this.steps) this.steps.classList.remove("invalidInput");
      if (this.notes) this.notes.classList.remove("invalidInput");
    }
    if (this.applyButton) this.applyButton.disabled = !this.identifyChord(chord)?.chordInfo;
    return info;
  }

  private get currentBaseNote() {
    return this.system.baseNoteList[this.selBaseNote.selectedIndex];
  }

  private get currentModifier() {
    return this.subscript?.value || "";
  }

  private selectChordByName(name: string) {
    if (name.startsWith("Custom ")) {
      if (this.customSpan) this.customSpan.innerText = "Custom";
      name = name.substr(7);
    } else if (this.customSpan) this.customSpan.innerText = "";
    if (this.selModifier)
      for (let i = 0; i < allChordInfo.length; ++i)
        if (allChordInfo[i].name === name) {
          this.selModifier.selectedIndex = i;
          break;
        }
  }

  private updateFrom(updated?: HTMLElement) {
    if (updated) this.guitarVariant = this.pianoVariant = 0;
    let chord = "";
    if (updated === this.selBaseNote) {
      chord = this.currentBaseNote + this.currentModifier;
    } else if (updated === this.selBassNote) {
      chord = this.currentBaseNote + this.currentModifier;
    } else if (updated === this.selModifier) {
      const modifier = allChordInfo[this.selModifier.selectedIndex].symbols[0];
      if (this.subscript) this.subscript.value = modifier;
      if (this.customSpan) this.customSpan.innerText = "";
      chord = this.currentBaseNote + modifier;
    } else if (updated === this.subscript) {
      chord = this.currentBaseNote + this.subscript.value;
      const info = this.identifyChord(chord);
      if (info) {
        if (this.customSpan && info.chordInfo.name.startsWith("Custom")) this.customSpan.innerText = "Custom";
        this.subscript.classList.remove("invalidInput");
      } else this.subscript.classList.add("invalidInput");
    } else if (updated === this.steps || updated === this.notes) {
      let steps = "";
      if (updated === this.notes) {
        const tmp = this.system.convertNotesToSteps(this.currentBaseNote + "-" + this.notes.value);
        if (!tmp) {
          this.notes.classList.add("invalidInput");
          this.drawChord("?");
          if (this.applyButton) this.applyButton.disabled = true;
          return chord;
        }
        steps = tmp;
      } else if (this.steps) steps = "1-" + this.steps.value;
      const modifier = stepsToModifier(steps);
      if (modifier !== null) {
        if (this.subscript) this.subscript.value = modifier;
        chord = this.currentBaseNote + modifier;
        const info = this.identifyChord(chord);
        if (info) this.selectChordByName(info.chordInfo.name);
        if (this.subscript) this.subscript.classList.remove("invalidInput");
        if (this.steps) this.steps.classList.remove("invalidInput");
      } else {
        updated.classList.add("invalidInput");
        this.drawChord("?");
      }
    } else chord = this.currentBaseNote + this.currentModifier;
    if (chord) {
      if (this.selBassNote.selectedIndex > 0) {
        const bassNote = this.system.baseNoteList[this.selBassNote.selectedIndex - 1];
        if (bassNote !== this.currentBaseNote) chord += "/" + bassNote;
      }
      this.updateForm(chord);
    }
    if (this.applyButton) this.applyButton.disabled = !this.identifyChord(chord)?.chordInfo;
    return chord;
  }

  showDialog(chord: string, readOnly: boolean, dark: boolean) {
    this.inModalState = true;
    this.darkMode = dark;

    this.readOnly = !!readOnly;
    makeReadonly(this.selBaseNote, this.readOnly);
    makeReadonly(this.selBassNote, this.readOnly);
    makeReadonly(this.selModifier, this.readOnly);
    if (this.subscript) makeReadonly(this.subscript, this.readOnly);
    if (this.steps) makeReadonly(this.steps, this.readOnly);
    if (this.notes) makeReadonly(this.notes, this.readOnly);
    if (this.applyButton) makeVisible(this.applyButton, !this.readOnly);

    this.parent.style.display = "block";
    this.parent.style.filter = "";
    this.applyTheme();

    if (chord) this.updateForm(chord);
  }

  closeDialog(apply?: boolean) {
    if (!this.inModalState) return;
    if (this.themeRefreshHandle != null) {
      window.clearTimeout(this.themeRefreshHandle);
      this.themeRefreshHandle = null;
    }
    const chord = this.updateFrom();
    const details = this.identifyChord(chord);
    if (this.onCloseCallback) this.onCloseCallback(apply && details ? chord : undefined);
    this.parent.style.display = "none";
    this.inModalState = false;
  }
}
