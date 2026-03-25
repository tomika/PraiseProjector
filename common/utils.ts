import { diffChars, diffWords } from "diff";
import { removeDiacretics } from "./stringTools";
import { Settings } from "./settings";

export const snooze = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function touchToMouseEvent(event: TouchEvent, options: { preventDefault: boolean; stopPropagation: boolean }) {
  if (event.changedTouches.length !== 1) return;

  // Skip touch-to-mouse conversion for form elements that need native touch handling
  // (select dropdowns, inputs, buttons need native touch to work properly on mobile)
  const target = event.target as HTMLElement;
  const tagName = target.tagName.toUpperCase();
  if (tagName === "SELECT" || tagName === "OPTION" || tagName === "INPUT" || tagName === "BUTTON") {
    return;
  }

  // Also check composed path for nested elements
  const path = event.composedPath?.() || [];
  for (const el of path) {
    if (el instanceof HTMLElement) {
      const elTagName = el.tagName.toUpperCase();
      if (elTagName === "SELECT" || elTagName === "INPUT" || elTagName === "BUTTON") {
        return;
      }
    }
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

  if (options.stopPropagation) event.stopPropagation();
  if (options.preventDefault) event.preventDefault();
  first.target.dispatchEvent(simulatedEvent);
}

export function routeTouchEventsToMouse(
  element: HTMLElement,
  options: { preventDefault: boolean; stopPropagation: boolean } = { preventDefault: true, stopPropagation: true }
) {
  const eventHandler = (e: TouchEvent) => touchToMouseEvent(e, options);
  // Must use { passive: false } so preventDefault() actually prevents
  // the browser's native scroll/pan on mobile (passive listeners ignore it).
  const listenerOpts: AddEventListenerOptions = { capture: true, passive: false };
  element.addEventListener("touchstart", eventHandler, listenerOpts);
  element.addEventListener("touchmove", eventHandler, listenerOpts);
  element.addEventListener("touchend", eventHandler, listenerOpts);
  element.addEventListener("touchcancel", eventHandler, listenerOpts);
  return () => {
    element.removeEventListener("touchstart", eventHandler, listenerOpts);
    element.removeEventListener("touchmove", eventHandler, listenerOpts);
    element.removeEventListener("touchend", eventHandler, listenerOpts);
    element.removeEventListener("touchcancel", eventHandler, listenerOpts);
  };
}

export function createDivElement(options?: {
  innerText?: string;
  innerHTML?: string;
  routeTouchToMouse?: { preventDefault: boolean; stopPropagation: boolean } | boolean;
  className?: string;
  classList?: string[];
  parent?: HTMLElement;
}) {
  const div = document.createElement("div");
  if (options?.className) div.className = options.className;
  if (options?.classList) for (const name of options.classList) div.classList.add(name);
  if (options?.innerText) div.innerText = options.innerText;
  if (options?.innerHTML) div.innerHTML = options.innerHTML;
  if (options?.routeTouchToMouse) routeTouchEventsToMouse(div, options.routeTouchToMouse !== true ? options.routeTouchToMouse : undefined);
  if (options?.parent) options.parent.appendChild(div);
  return div;
}

export class DiffTextPreProcessor {
  private static readonly placeholder = String.fromCodePoint(0xe000);
  private static readonly tokenPattern = /\[.*?\]|^[ \t]*{[^\r\n{}]+}[ \t]*$/gm;
  private codepoint = 0xe001;
  private readonly map = new Map<string, string>();
  private readonly table: string[] = [];

  private static normalizeChordToken(token: string) {
    const inner = token
      .substring(1, token.length - 1)
      .trim()
      .replace(/[ \t]+/g, " ");
    return `[${inner}]`;
  }

  private static normalizeDirectiveToken(token: string) {
    const trimmed = token.trim();
    const match = /^\{\s*([^\s:}]+)\s*(?::\s*(.*?))?\s*\}$/.exec(trimmed);
    if (!match) return trimmed;
    const name = match[1];
    const value = match[2]?.trim();
    return value ? `{${name}:${value}}` : `{${name}}`;
  }

  private static normalizeToken(token: string) {
    if (token.startsWith("[")) return this.normalizeChordToken(token);
    return this.normalizeDirectiveToken(token);
  }

  subst(str: string) {
    return str
      .replace(DiffTextPreProcessor.tokenPattern, (s) => {
        const normalized = DiffTextPreProcessor.normalizeToken(s);
        const code = this.map.get(normalized);
        if (code) return code;
        this.table.push(normalized);
        const r = String.fromCodePoint(this.codepoint++);
        this.map.set(normalized, r);
        return r;
      })
      .replace(/[\ue001-\uf8ff]/g, (s) => s + DiffTextPreProcessor.placeholder);
  }
  restore(str: string) {
    return str.replace(/[\ue000-\uf8ff]/g, (s) => (s === DiffTextPreProcessor.placeholder ? "" : this.table[s.charCodeAt(0) - 0xe001]));
  }
}

export type DifferentialTextChunk = { text: string; added?: boolean };

/**
 * Post-process diff chunks from a word-level (or char-level) pass by grouping
 * consecutive changed (added/removed) chunks and running a char-level re-diff
 * on each group.
 *
 * This fixes the case where word-level diff marks an entire "[chord]word" token
 * as changed even though only the chord part changed.  The char-level re-diff
 * over the substituted text then emits separate removed/added chunks for the
 * chord token and an unchanged chunk for the lyrics characters – so the parser
 * sees only the chord as changed, not the lyrics.
 *
 * As a special case, if the accumulated added and removed text are identical
 * the group is collapsed to a single unchanged chunk.
 */
function refineDiffChunks(chunks: DifferentialTextChunk[]): DifferentialTextChunk[] {
  const result: DifferentialTextChunk[] = [];
  let i = 0;
  while (i < chunks.length) {
    if (chunks[i].added === undefined) {
      result.push(chunks[i]);
      i++;
      continue;
    }
    // Collect ALL consecutive changed chunks regardless of their direction.
    let addedText = "";
    let removedText = "";
    while (i < chunks.length && chunks[i].added !== undefined) {
      if (chunks[i].added === true) addedText += chunks[i].text;
      else removedText += chunks[i].text;
      i++;
    }
    if (!addedText) {
      result.push({ text: removedText, added: false });
    } else if (!removedText) {
      result.push({ text: addedText, added: true });
    } else if (addedText === removedText) {
      // Perfect symmetric cancel → emit as unchanged
      result.push({ text: addedText, added: undefined });
    } else {
      // Char-level re-diff of the two groups for finer granularity.
      // Works on the substituted form so chord tokens (single private-use
      // chars) are never split across chunk boundaries.
      for (const change of diffChars(removedText, addedText))
        result.push({ text: change.value, added: change.added ? true : change.removed ? false : undefined });
    }
  }
  return result;
}

export class DifferentialText {
  private readonly chunks: DifferentialTextChunk[] = [];
  private breakCosts?: Map<number, number>;

  static create(
    prev: string,
    actual: string,
    options?: {
      preprocessor?: DiffTextPreProcessor;
      wordLevel?: boolean;
    }
  ) {
    const wordLevel = options?.wordLevel ?? Settings.current.wordLevelDiff;
    const substitutor = options?.preprocessor;
    const old = substitutor ? substitutor.subst(prev) : prev;
    const act = substitutor ? substitutor.subst(actual) : actual;
    // Build raw chunks in substituted form so refineDiffChunks can operate on
    // atomic chord tokens (single private-use chars) before restoration.
    let rawChunks: DifferentialTextChunk[] = [];
    for (const change of wordLevel ? diffWords(old, act) : diffChars(old, act))
      rawChunks.push({ text: change.value, added: change.added ? true : change.removed ? false : undefined });
    // Re-group and char-level re-diff adjacent changed groups.  Only applied
    // when a substitutor is active (ChordPro context) so that non-ChordPro
    // call-sites (metadata diffs, etc.) are unaffected.
    if (substitutor) rawChunks = refineDiffChunks(rawChunks);
    // Restore tokens and drop empty chunks produced by placeholder stripping.
    const diff = rawChunks
      .map((c) => ({ text: substitutor ? substitutor.restore(c.text) : c.text, added: c.added }))
      .filter((c) => c.text.length > 0);
    return new DifferentialText(diff);
  }

  static equals(s1: string | DifferentialText, s2: string | DifferentialText) {
    if (typeof s1 === "string") {
      if (typeof s2 === "string") return s1 === s2;
      s1 = new DifferentialText(s1);
    } else if (typeof s2 === "string") s2 = new DifferentialText(s2);
    if (s1.count !== s2.count) return false;
    for (let i = 0; i < s1.count; ++i) {
      const c1 = s1.chunks[i],
        c2 = s2.chunks[i];
      if (c1.text !== c2.text || c1.added !== c2.added) return false;
    }
    return true;
  }

  constructor();
  constructor(text: DifferentialTextChunk[]);
  constructor(text: string, added?: boolean);
  constructor(text?: string | DifferentialTextChunk[], added?: boolean) {
    if (typeof text === "string") this.append(text, added);
    else if (text) this.append(text);
  }

  clone() {
    const c = new DifferentialText(this.chunks);
    c.breakCosts = this.breakCosts;
    return c;
  }

  toString(current = true) {
    return this.chunks.map((x) => (x.added !== !current ? x.text : "")).join("");
  }

  flatten() {
    return this.chunks.map((x) => x.text).join("");
  }

  get count() {
    return this.chunks.length;
  }
  /*
  splice(start: number, length: number, ...inserts: string[]) {

  }
*/
  append(text: DifferentialText): this;
  append(text: DifferentialTextChunk[]): this;
  append(text: string, added?: boolean): this;
  append(text: string | DifferentialTextChunk[] | DifferentialText, added?: boolean) {
    if (text) {
      const chunks = typeof text === "string" ? [{ text, added }] : text instanceof DifferentialText ? text.chunks : text;
      for (const chunk of chunks) {
        const last = this.chunks.length > 0 ? this.chunks[this.chunks.length - 1] : undefined;
        if (last && last.added === chunk.added) last.text += chunk.text;
        else this.chunks.push(chunk);
      }
    }
    this.breakCosts = undefined;
    return this;
  }

  forEachChunk(cb: (chunk: DifferentialTextChunk) => boolean | void) {
    for (const chunk of this.chunks) if (cb(chunk)) break;
  }

  forEachChar(cb: (ch: string) => boolean | void, current: boolean): void;
  forEachChar(cb: (ch: string, added: boolean | undefined) => boolean | void): void;
  forEachChar(cb: (ch: string, added: boolean | undefined) => boolean | void, current?: boolean) {
    for (const chunk of this.chunks)
      if (current === undefined || (chunk.added ?? current) === current) for (const ch of chunk.text) if (cb(ch, chunk.added)) break;
  }

  get lineBreakCosts() {
    if (!this.breakCosts) {
      this.breakCosts = new Map();
      if (this.chunks.length === 1) {
        const current = removeDiacretics(this.toString(true));
        const simplified = current.replace(/[^-a-zA-Z]/, " ");
        let prevC = "",
          prevS = "";
        for (let i = 0; i < current.length; ++i) {
          const c = current[i],
            s = simplified[i];
          if (c !== " " && c !== "\t") {
            if (prevC && s && prevS === " ") {
              const cost = ".:;?!".includes(prevC) ? 0 : prevC === "," ? 1 : c.toUpperCase() === c ? 5 : 10;
              this.breakCosts.set(i, cost);
            }
            prevC = c;
          }
          prevS = s;
        }
      }
    }
    return this.breakCosts;
  }
}

function weekStart(region: string | undefined, language: string | undefined) {
  const info: { [key: number]: string[] } = {
    /*mon*/ 1: "001 AD AI AL AM AN AT AX AZ BA BE BG BM BN BY CH CL CM CR CY CZ DE DK EC EE ES FI FJ FO FR GB GE GF GP GR HR HU IS IT KG KZ LB LI LK LT LU LV MC MD ME MK MN MQ MY NL NO PL PT RE RO RS RU SE SI SK SM TJ TM TR UA UY UZ VA VN XK".split(
      " "
    ),
    /*fri*/ 4: "BD MV".split(" "),
    /*sat*/ 5: "AE AF BH DJ DZ EG IQ IR JO KW LY MA OM QA SD SY".split(" "),
    /*sun*/ 0: "AG AR AS AU BR BS BT BW BZ CA CN CO DM DO ET GB GT GU HK HN ID IE IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP NZ PA PE PH PK PR PY SA SG SV TH TN TT TW UM US VE VI WS YE ZA ZW".split(
      " "
    ),
  };
  for (const key of [region, language].map((x) => x?.toUpperCase() ?? "").filter((x) => !!x))
    for (const d of [1, 4, 5]) if (info[d].indexOf(key) >= 0) return d;
  return 0;
}

export function weekStartLocale(locale: string) {
  const parts = locale.match(/^([a-z]{2,3})(?:-([a-z]{3})(?=$|-))?(?:-([a-z]{4})(?=$|-))?(?:-([a-z]{2}|\d{3})(?=$|-))?/i);
  return parts ? weekStart(parts[4], parts[1]) : 0;
}

export function isVisible(elem: HTMLElement) {
  return !elem.classList.contains("hidden");
}

export function makeVisible(elem: HTMLElement, visible = true) {
  if (visible) elem.classList.remove("hidden");
  else elem.classList.add("hidden");
}

export function isDisabled(elem: HTMLElement) {
  return elem.classList.contains("disabled");
}

export function makeDisabled(elem: HTMLElement, disabled = true) {
  if (disabled) elem.classList.add("disabled");
  else elem.classList.remove("disabled");
}

export function makeReadonly(elem: HTMLElement, disabled = true) {
  if (disabled) elem.classList.add("readonly");
  else elem.classList.remove("readonly");
}

export function makeDark(elem: HTMLElement, dark = true) {
  if (dark) elem.classList.add("dark");
  else elem.classList.remove("dark");
}

const modalCallbacks = new Map<HTMLElement, (result?: string) => void>();

export async function doModal(elem: HTMLElement, outerClickResult?: string) {
  const modalPanel = document.createElement("div");
  modalPanel.style.position = "absolute";
  modalPanel.style.left = "0px";
  modalPanel.style.top = "0px";
  modalPanel.style.right = "0px";
  modalPanel.style.bottom = "0px";

  let zIndexValue = parseInt(getComputedStyle(elem).zIndex, 10);
  if (isNaN(zIndexValue)) zIndexValue = -1;
  else --zIndexValue;
  const zIndex = zIndexValue.toString();
  modalPanel.style.zIndex = zIndex;
  elem.parentNode?.insertBefore(modalPanel, elem);

  makeVisible(modalPanel);
  makeVisible(elem, true);

  return new Promise<string>((resolve) => {
    const finishModal = (result?: string) => {
      makeVisible(elem, false);
      modalPanel.remove();
      modalCallbacks.delete(elem);
      resolve(result ?? "");
    };
    if (outerClickResult !== undefined) modalPanel.onclick = () => finishModal(outerClickResult);
    modalCallbacks.set(elem, finishModal);
  });
}

export function endModal(elem: HTMLElement, result?: string) {
  modalCallbacks.get(elem)?.(result);
}

export function inModal(elem?: HTMLElement) {
  if (!elem) elem = Array.from(modalCallbacks.keys())[0];
  return elem && modalCallbacks.has(elem) ? elem : undefined;
}

export function doubleClickHelper(
  element: HTMLElement,
  ondblclick: (e: MouseEvent) => void,
  onclick?: (e: MouseEvent) => void,
  setup?: (e: MouseEvent) => void
) {
  let doubleclicked = false;
  let clicked = false;
  element.onclick = (e) => {
    if (!clicked) {
      setTimeout(() => {
        if (doubleclicked) doubleclicked = false;
        else onclick?.(e);
        clicked = false;
      }, 500);
      setup?.(e);
    } else ondblclick(e);
    clicked = !clicked;
  };
  element.ondblclick = (e) => {
    doubleclicked = true;
    clicked = false;
    ondblclick(e);
  };
}

function generateRomanUnicodeList(lowercase = false) {
  const res = [""];
  const start = lowercase ? 2170 : 2160;
  for (let i = 0; i < 12; ++i) res.push(String.fromCodePoint(start + i));
  return res;
}

export const romanUpper = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
export const romanLower = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];
export const romanUpperUnicode = generateRomanUnicodeList(false);
export const romanLowerUnicode = generateRomanUnicodeList(true);

const allRomans = [romanUpper, romanLower, romanUpperUnicode, romanLowerUnicode];

export function decodeRoman(str: string) {
  for (const romans of allRomans) {
    const i = romans.indexOf(str);
    if (i >= 0) return i;
  }
  return undefined;
}

export class VersionedMap<K, V, I> {
  private readonly map = new Map<K, V>();
  constructor(private version_: I) {}
  get version() {
    return this.version_;
  }
  has(version: I, key: K) {
    return version === this.version_ ? this.map.has(key) : undefined;
  }
  get(version: I, key: K) {
    return version === this.version_ ? this.map.get(key) : undefined;
  }
  set(version: I, key: K, value: V) {
    if (version !== this.version_) {
      this.version_ = version;
      this.map.clear();
    }
    this.map.set(key, value);
  }
}

export type VirtualKeyboard = {
  overlaysContent: boolean;
  show: () => void;
  hide: () => void;
  addEventListener: (
    type: "geometrychange",
    callback: (event: { target: { boundingRect: { x: number; y: number; width: number; height: number } } }) => void
  ) => void;
};

declare global {
  interface Navigator {
    virtualKeyboard?: VirtualKeyboard;
  }
}

export function virtualKeyboard() {
  return navigator["virtualKeyboard"] as VirtualKeyboard | undefined;
}

export function base64ToArrayBuffer(base64: string) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

interface TouchPoint {
  identifier: number;
  pageX: number;
  pageY: number;
}

type TouchCacheContext = {
  touchCache: Map<number, TouchPoint>;
  callback: (diff: number) => void;
  lastCallbackValue?: number;
};

const touchCacheForElements = new Map<HTMLElement, TouchCacheContext>();
function getTouchContext(ev: TouchEvent) {
  const context = touchCacheForElements.get(ev.target as HTMLElement);
  return context ?? touchCacheForElements.get(document.body);
}

function handleTouchStart(ev: TouchEvent) {
  const context = getTouchContext(ev);
  if (context) {
    for (let i = 0; i < ev.changedTouches.length; ++i) {
      const touch = ev.changedTouches[i];
      context.touchCache.set(touch.identifier, touch);
    }
  }
}

function handleTouchMove(ev: TouchEvent) {
  if (ev.touches.length === 2) {
    const context = getTouchContext(ev);
    if (context) {
      const touch1 = context.touchCache.get(ev.touches[0].identifier);
      const touch2 = context.touchCache.get(ev.touches[1].identifier);
      if (touch1 && touch2) {
        const dist = Math.hypot(touch1.pageX - touch2.pageX, touch1.pageY - touch2.pageY);
        context.callback(dist);
      }
    }
  }
}

function handleTouchEnd(ev: TouchEvent) {
  const context = getTouchContext(ev);
  if (context) {
    for (let i = 0; i < ev.changedTouches.length; ++i) {
      const touch = ev.changedTouches[i];
      context.touchCache.delete(touch.identifier);
    }
  }
}

export function installPinchZoomHandler(targetElement: HTMLElement, callback: (diff: number) => void, step?: number) {
  const context: TouchCacheContext = { touchCache: new Map(), callback };
  if (step != null) {
    context.callback = (diff) => {
      const calcedValue = Math.floor(diff / step);
      if (context.lastCallbackValue !== calcedValue) callback((context.lastCallbackValue = calcedValue));
    };
  }
  touchCacheForElements.set(targetElement, context);
  targetElement.addEventListener("touchstart", handleTouchStart, true);
  targetElement.addEventListener("touchmove", handleTouchMove, true);
  targetElement.addEventListener("touchend", handleTouchEnd, true);
}

export class MultiMap<K, V> {
  private readonly map = new Map<K, Set<V>>();
  add(key: K, value: V) {
    let set = this.map.get(key);
    if (set === undefined) this.map.set(key, (set = new Set<V>()));
    set.add(value);
  }

  remove(key: K, v: V) {
    const set = this.map.get(key);
    if (set) set.delete(v);
  }

  clear() {
    this.map.clear();
  }

  forAllItems(cb: (key: K, value: V) => void) {
    this.map.forEach((value, key) => {
      for (const elem of value) cb(key, elem);
    });
  }
}
/*
  export class SortedMap<K, V> {
    private readonly map = new Map<K, V>();
    private readonly order: { key: K; value: V }[] = [];
    add(key: K, value: V) {
      let set = this.map.get(key);
      if (set === undefined) this.map.set(key, (set = new Set<V>()));
      set.add(value);
    }
  
    remove(key: K, v: V) {
      const set = this.map.get(key);
      if (set) set.delete(v);
    }
  
    clear() {
      this.map.clear();
    }
  
    forAllItems(cb: (key: K, value: V) => void) {
      this.map.forEach((value, key) => {
        for (const elem of value) cb(key, elem);
      });
    }
  }
  */
