/**
 * Reads the metadata of a ChordPro text for the MCP tools: `{name: value}` directives
 * outside score blocks. Dependency-free; the app's own song model keeps only the title
 * and the set of values, not which directive a value came from.
 */

const DIRECTIVE = /^[ \t]*\{[ \t]*([^:{}]+?)[ \t]*(?::[ \t]*([^}]*?))?[ \t]*\}[ \t\r]*$/;
const ALIASES: Record<string, string> = { t: "title", st: "subtitle", c: "comment", ci: "comment_italic", cb: "comment_box" };
/** Directives that structure or annotate the song instead of describing it. */
const NOT_METADATA =
  /^(start_of_|end_of_|so[cvbtg]$|eo[cvbtg]$|comment|new_song|ns$|chorus$|define|chord$|textfont|textsize|textcolou?r|chordfont|chordsize|chordcolou?r)/;
const KEY_LINE = /^[ \t]*\{[ \t]*key[ \t]*:[ \t]*([^}]*?)[ \t]*\}/im;

export interface SongDirective {
  name: string;
  value: string;
}

/** Every directive with a value, in source order, names lower-cased and aliases resolved. */
export function songDirectives(chordPro: string): SongDirective[] {
  const found: SongDirective[] = [];
  let inAbc = false;
  for (const line of chordPro.split(/\r?\n/)) {
    const match = DIRECTIVE.exec(line);
    if (!match) continue;
    const raw = match[1].toLowerCase();
    if (/^start_of_abc\b/.test(raw)) inAbc = true;
    else if (/^end_of_abc\b/.test(raw)) inAbc = false;
    if (inAbc) continue;
    const name = ALIASES[raw] ?? raw;
    const value = (match[2] ?? "").trim();
    if (value && !NOT_METADATA.test(name)) found.push({ name, value });
  }
  return found;
}

/** Metadata as name → value; a repeated name keeps every value, joined with "; ". */
export function songMetadata(chordPro: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const { name, value } of songDirectives(chordPro)) meta[name] = name in meta ? `${meta[name]}; ${value}` : value;
  return meta;
}

/** The first `{key: …}` of the song; empty when it states none. */
export function songKeyDirective(chordPro: string): string {
  return KEY_LINE.exec(chordPro)?.[1] ?? "";
}

/**
 * Which block a line belongs to, as the app's song model sees it: "abc" (score), "grid"
 * (chords without brackets, separated by spaces, |, /, . …), "tab" (tablature) or "text"
 * (lyrics with bracketed chords). Directive lines themselves are "directive".
 */
export type SongLineKind = "text" | "grid" | "tab" | "abc" | "directive";

const BLOCK_START: Record<string, Exclude<SongLineKind, "text" | "directive">> = {
  start_of_abc: "abc",
  start_of_grid: "grid",
  sog: "grid",
  start_of_tab: "tab",
  sot: "tab",
};
const BLOCK_END = /^(end_of_(abc|grid|tab)|eog|eot)$/;

export function songLines(chordPro: string): { kind: SongLineKind; line: string }[] {
  const result: { kind: SongLineKind; line: string }[] = [];
  let block: SongLineKind = "text";
  for (const line of chordPro.split(/\r?\n/)) {
    const directive = /^\s*\{\s*([a-z_]+)/i.exec(line);
    const name = directive?.[1].toLowerCase() ?? "";
    if (directive && /\}\s*$/.test(line)) {
      if (block === "text" && BLOCK_START[name]) block = BLOCK_START[name];
      else if (block !== "text" && BLOCK_END.test(name)) block = "text";
      // A score block hides everything up to its end, directives included.
      if (block !== "abc" || BLOCK_START[name]) {
        result.push({ kind: "directive", line });
        continue;
      }
    }
    result.push({ kind: block, line });
  }
  return result;
}

/** Chords written in square brackets in lyric lines, unique, in order of appearance. */
export function chordsOf(chordPro: string): string[] {
  const chords = new Set<string>();
  for (const { kind, line } of songLines(chordPro)) {
    if (kind === "text") for (const match of line.matchAll(/\[([^\]\r\n]*)\]/g)) chords.add(match[1].trim());
  }
  return [...chords];
}

/** The lines of grid blocks: chords without brackets. */
export function gridLinesOf(chordPro: string): string[] {
  return songLines(chordPro)
    .filter(({ kind, line }) => kind === "grid" && line.trim() && !line.trim().startsWith("#"))
    .map(({ line }) => line);
}
