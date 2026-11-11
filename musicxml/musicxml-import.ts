import { DOMParser } from "@xmldom/xmldom";
import { unzipSync } from "fflate";
import abcjs from "abcjs";
import { translate } from "./vendor/xml2abc.js";
import { adaptAbc } from "./abc-adapter";

export const MUSICXML_EXTENSIONS = [".musicxml", ".xml", ".mxl"];
const MAX_BYTES = 32 * 1024 * 1024;

export interface MusicXmlResult {
  abc: string;
  /** Conversion limitations and abcjs parser warnings, for review before saving. */
  warnings: string[];
}

/** MusicXML voice and verse identifiers are strings. Reserve existing numeric
 * identifiers first, then allocate distinct numbers for upstream's parseInt. */
function numericIdentifiers(values: string[]): Map<string, string> {
  const reserved = new Set(values.filter((v) => /^[1-9]\d*$/.test(v) && Number.isSafeInteger(Number(v))));
  const mapped = new Map<string, string>();
  let next = 1;
  for (const value of values)
    if (!mapped.has(value)) {
      if (reserved.has(value)) mapped.set(value, value);
      else {
        while (reserved.has(String(next))) next++;
        const id = String(next++);
        reserved.add(id);
        mapped.set(value, id);
      }
    }
  return mapped;
}

function parseXml(text: string): Document {
  if (/<!ENTITY\s/i.test(text)) throw new Error("MusicXML entity declarations are not supported.");
  const errors: string[] = [];
  const doc = new DOMParser({
    errorHandler: { warning: (e) => errors.push(e), error: (e) => errors.push(e), fatalError: (e) => errors.push(e) },
  }).parseFromString(text, "application/xml");
  if (errors.length || !doc.documentElement) throw new Error("Invalid MusicXML: " + (errors[0] ?? "missing document element"));
  return doc as unknown as Document;
}

/** Copy only XML elements, attributes and text, removing namespace prefixes.
 * xml2abc uses unqualified element names; prefixed MusicXML is equivalent. */
function normalizeDocument(source: Document): Document {
  const doc = parseXml("<score-partwise/>");
  const copy = (node: Element): Element => {
    const result = doc.createElement(node.localName || node.tagName);
    for (const attr of Array.from(node.attributes)) if (!attr.name.startsWith("xmlns")) result.setAttribute(attr.localName || attr.name, attr.value);
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 1) result.appendChild(copy(child as Element));
      else if (child.nodeType === 3 || child.nodeType === 4) result.appendChild(doc.createTextNode(child.nodeValue ?? ""));
    }
    return result;
  };
  const root = copy(source.documentElement);
  doc.replaceChild(root, doc.documentElement);
  if (root.tagName === "score-timewise") {
    const target = doc.createElement("score-partwise");
    for (const attr of Array.from(root.attributes)) target.setAttribute(attr.name, attr.value);
    const children = Array.from(root.childNodes).filter((n): n is Element => n.nodeType === 1);
    const measures = children.filter((n) => n.tagName === "measure");
    const declared = new Set(Array.from(root.getElementsByTagName("score-part")).map((p) => p.getAttribute("id")));
    for (const measure of measures)
      for (const part of Array.from(measure.getElementsByTagName("part"))) {
        if (!declared.has(part.getAttribute("id"))) throw new Error("A timewise MusicXML part is absent from the part list.");
      }
    for (const n of children.filter((n) => n.tagName !== "measure")) target.appendChild(n.cloneNode(true));
    for (const definition of Array.from(root.getElementsByTagName("score-part"))) {
      const part = doc.createElement("part");
      part.setAttribute("id", definition.getAttribute("id") ?? "");
      for (const measure of measures) {
        const content = Array.from(measure.getElementsByTagName("part")).find((n) => n.getAttribute("id") === part.getAttribute("id"));
        if (!content) throw new Error("A timewise MusicXML measure is missing a part.");
        const m = doc.createElement("measure");
        for (const attr of Array.from(measure.attributes)) m.setAttribute(attr.name, attr.value);
        for (const node of Array.from(content.childNodes)) m.appendChild(node.cloneNode(true));
        part.appendChild(m);
      }
      target.appendChild(part);
    }
    doc.replaceChild(target, root);
  }
  return doc;
}

export function convertMusicXml(text: string, fallbackTitle = "MusicXML"): MusicXmlResult {
  if (text.length > MAX_BYTES) throw new Error("The MusicXML score exceeds the 32 MB import limit.");
  const source = parseXml(text);
  if (!["score-partwise", "score-timewise"].includes(source.documentElement.localName)) throw new Error("This XML document is not a MusicXML score.");
  const doc = normalizeDocument(source);
  if (!doc.getElementsByTagName("part").length || !doc.getElementsByTagName("measure").length)
    throw new Error("The MusicXML score has no parts or measures.");
  if (doc.getElementsByTagName("note").length > 100000) throw new Error("The MusicXML score exceeds the 100,000 note import limit.");
  for (const key of Array.from(doc.getElementsByTagName("fifths"))) {
    const fifths = Number(key.textContent);
    if (!Number.isInteger(fifths) || Math.abs(fifths) > 7)
      throw new Error("MusicXML key signatures with more than seven sharps or flats are not supported.");
  }
  const warnings = new Set<string>();
  const partList = doc.getElementsByTagName("part-list")[0];
  if (!partList) throw new Error("The MusicXML score has no part list.");
  const knownParts = new Set(Array.from(partList.getElementsByTagName("score-part")).map((p) => p.getAttribute("id")));
  for (const part of Array.from(doc.getElementsByTagName("part"))) {
    const id = part.getAttribute("id");
    if (!id) throw new Error("A MusicXML part has no ID.");
    if (!knownParts.has(id)) {
      const definition = doc.createElement("score-part"),
        name = doc.createElement("part-name");
      definition.setAttribute("id", id);
      name.appendChild(doc.createTextNode(id));
      definition.appendChild(name);
      partList.appendChild(definition);
      knownParts.add(id);
      warnings.add(`Part ${id} was missing from the part list and has been retained.`);
    }
  }
  // xml2abc associates part metadata by position. MusicXML identifies parts by
  // ID, so arrange the bodies in the declared order before calling upstream.
  const parts = Array.from(doc.getElementsByTagName("part"));
  const partIds = new Set(parts.map((p) => p.getAttribute("id")));
  if (partIds.size !== parts.length) throw new Error("The MusicXML score has duplicate part IDs.");
  const definitions = Array.from(partList.getElementsByTagName("score-part"));
  if (new Set(definitions.map((p) => p.getAttribute("id"))).size !== definitions.length) throw new Error("The MusicXML part list has duplicate IDs.");
  for (const definition of definitions) {
    const part = parts.find((p) => p.getAttribute("id") === definition.getAttribute("id"));
    if (!part) throw new Error("The MusicXML part list references a missing part.");
    doc.documentElement.appendChild(part);
    // MusicXML voice is a string, while upstream uses parseInt. Allocate
    // distinct numeric IDs per part without colliding with existing numbers.
    const voices = Array.from(part.getElementsByTagName("voice"));
    const mapped = numericIdentifiers(["1", ...voices.map((v) => v.textContent?.trim() ?? "")]);
    for (const voice of voices) {
      const original = voice.textContent?.trim() ?? "";
      voice.textContent = mapped.get(original)!;
    }
    const lyricsByVoice = new Map<string, Element[]>();
    for (const note of Array.from(part.getElementsByTagName("note"))) {
      const voice = note.getElementsByTagName("voice")[0]?.textContent ?? "1";
      const lyrics = lyricsByVoice.get(voice) ?? [];
      lyrics.push(...Array.from(note.getElementsByTagName("lyric")));
      lyricsByVoice.set(voice, lyrics);
    }
    for (const lyrics of lyricsByVoice.values()) {
      const ids = numericIdentifiers(lyrics.map((l) => l.getAttribute("number") || "1"));
      for (const lyric of lyrics) lyric.setAttribute("number", ids.get(lyric.getAttribute("number") || "1")!);
    }
  }
  // Separate measures and fixed L: are essential for correct voice/lyric reflow.
  // wev retains rest-only voices; no percussion-specific abc2svg voice maps.
  const [raw, diagnostics] = translate(doc, { p: "", b: 1, n: 0, d: 8, m: 0, x: 0, wev: 1 });
  if (!raw?.trim() || diagnostics?.includes("** exception"))
    throw new Error("MusicXML conversion failed: " + (diagnostics || "no convertible music"));
  for (const message of (diagnostics || "").split("\n").filter(Boolean)) warnings.add(message.replace(/^-- /, ""));
  const hasAuthoredTitle = ["work-title", "movement-title", "credit-words"].some((tag) =>
    Array.from(doc.getElementsByTagName(tag)).some((n) => n.textContent?.trim())
  );
  const abc = adaptAbc(raw, hasAuthoredTitle ? null : fallbackTitle, warnings);
  if (/(?:^K:|\[K:)undefined/m.test(abc)) throw new Error("The MusicXML score contains notation that could not be translated.");
  const tunes = abcjs.parseOnly(abc);
  if (!tunes.some((t) => t.lines.some((l) => l.staff))) throw new Error("The MusicXML score contains no readable music.");
  for (const tune of tunes)
    for (const warning of tune.warnings ?? [])
      warnings.add(
        String(warning)
          .replace(/<[^>]*>/g, "")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&amp;/g, "&")
      );
  return { abc, warnings: [...warnings] };
}

function decodeXml(bytes: Uint8Array): string {
  // XML may use UTF-8, UTF-16 or an explicit legacy encoding. Honor its prolog.
  let encoding =
    (bytes[0] === 255 && bytes[1] === 254) || (bytes[0] === 60 && bytes[1] === 0)
      ? "utf-16le"
      : (bytes[0] === 254 && bytes[1] === 255) || (bytes[0] === 0 && bytes[1] === 60)
        ? "utf-16be"
        : "utf-8";
  if (encoding === "utf-8")
    encoding = /^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']+)/i.exec(new TextDecoder().decode(bytes.subarray(0, 256)))?.[1] ?? encoding;
  return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

export function convertMusicXmlData(bytes: Uint8Array, filename: string): MusicXmlResult {
  if (bytes.byteLength > MAX_BYTES) throw new Error("The MusicXML file exceeds the 32 MB import limit.");
  if (filename.toLowerCase().endsWith(".mxl")) {
    // fflate checks the central directory before inflation. Only inflate the
    // container manifest and chosen score, with declared size limits on both.
    const manifest = unzipSync(bytes, { filter: (f) => f.name === "META-INF/container.xml" && f.originalSize <= 1024 * 1024 })[
      "META-INF/container.xml"
    ];
    if (!manifest) throw new Error("The MXL archive has no valid META-INF/container.xml.");
    const container = parseXml(decodeXml(manifest));
    const rootfiles = Array.from(container.getElementsByTagNameNS("*", "rootfile"));
    const rootfile = rootfiles.find((n) => n.getAttribute("media-type") === "application/vnd.recordare.musicxml+xml") ?? rootfiles[0];
    const path = rootfile?.getAttribute("full-path");
    if (!path || path.startsWith("/") || path.split("/").includes("..")) throw new Error("The MXL archive has an invalid score path.");
    const score = unzipSync(bytes, { filter: (f) => f.name === path && f.originalSize <= MAX_BYTES })[path];
    if (!score) throw new Error("The MXL score is missing or exceeds the 32 MB import limit.");
    bytes = score;
  }
  return convertMusicXml(decodeXml(bytes), filename.replace(/\.[^.]*$/, ""));
}
