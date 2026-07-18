import type { ChordVisualModel, ChordVisualToken, ChordVisualTokenRole } from "./chord-visual";
import type { DifferentialTextUnit } from "./differential";

export interface TextNodeStyle {
  readonly font: string;
  readonly color?: string;
}

const roleClasses: Record<ChordVisualTokenRole, string> = {
  prefix: "chp-dom-token-prefix",
  "base-note": "chp-dom-token-base-note",
  modifier: "chp-dom-token-modifier",
  "bass-separator": "chp-dom-token-bass-separator",
  "bass-note": "chp-dom-token-bass-note",
  "bass-modifier": "chp-dom-token-bass-modifier",
  suffix: "chp-dom-token-suffix",
  "unknown-text": "chp-dom-token-unknown",
};

export function getSubscriptFont(font: string) {
  const match = /^([^0-9]*)([0-9]+(?:\.[0-9]+)?)(em|px|pt)(.*)$/.exec(font);
  if (!match) return { font, offset: 0 };
  const size = parseFloat(match[2]);
  return {
    font: `${match[1]}${Math.round((size * 9) / 14)}${match[3]}${match[4]}`,
    offset: Math.round((size * 4) / 14),
  };
}

export function createLyricRunNode(doc: Document, text: string, style: TextNodeStyle) {
  const node = doc.createElement("span");
  node.className = "chp-dom-run";
  node.style.font = style.font;
  if (style.color) node.style.color = style.color;
  node.textContent = text;
  return node;
}

/** Inline differential text for metadata, tags and non-row blocks. */
export function createDifferentialTextNode(doc: Document, unit: DifferentialTextUnit, style: TextNodeStyle) {
  const node = doc.createElement("span");
  node.className = `chp-dom-diff-run chp-dom-diff-${unit.change}`;
  node.style.font = style.font;
  if (style.color) node.style.color = style.color;
  if (unit.beforeStart != null) {
    node.dataset.beforeStart = String(unit.beforeStart);
    node.dataset.beforeEnd = String(unit.beforeEnd);
  }
  if (unit.afterStart != null) {
    node.dataset.afterStart = String(unit.afterStart);
    node.dataset.afterEnd = String(unit.afterEnd);
  }
  node.textContent = unit.text;
  return node;
}

export function createChordTokenNode(doc: Document, token: ChordVisualToken, style: TextNodeStyle) {
  const node = doc.createElement("span");
  node.className = `chp-dom-chord-token ${roleClasses[token.role]}`;
  const subscript = token.subscript ? getSubscriptFont(style.font) : null;
  node.style.font = subscript?.font ?? style.font;
  if (subscript?.offset) node.style.transform = `translateY(-${subscript.offset}px)`;
  if (token.gapBefore) node.style.marginLeft = `${token.gapBefore}px`;
  if (style.color) node.style.color = style.color;
  node.textContent = token.text;
  return node;
}

export interface ChordNodeStyle extends TextNodeStyle {
  readonly unknownColor?: string;
}

export function createChordNode(doc: Document, id: string, visual: ChordVisualModel, style: ChordNodeStyle) {
  const node = doc.createElement("span");
  node.className = "chp-dom-chord";
  node.dataset.chordId = id;
  node.style.font = style.font;
  node.style.color = visual.unknown && style.unknownColor ? style.unknownColor : style.color || "";
  for (const token of visual.tokens) node.appendChild(createChordTokenNode(doc, token, style));
  if (visual.underline) node.classList.add("chp-dom-chord-actual");
  return node;
}

export function createTagNode(doc: Document, text: string, style: TextNodeStyle) {
  const node = doc.createElement("span");
  node.className = "chp-dom-tag-text";
  node.style.font = style.font;
  if (style.color) node.style.color = style.color;
  node.textContent = text;
  return node;
}

export function createMeasurementTextNode(
  doc: Document,
  text: string,
  role: ChordVisualTokenRole | "lyric",
  style: TextNodeStyle,
  subscript = false
) {
  if (role === "lyric") return createLyricRunNode(doc, text, style);
  return createChordTokenNode(doc, { role, text, subscript, gapBefore: 0 }, style);
}
