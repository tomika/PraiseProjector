import type { AbcElem, TuneObjectArray, VoiceItem } from "abcjs";

// abcjs exposes aligned lyrics at runtime but omits them from VoiceItemNote.
type AbcEvent = VoiceItem & { lyric?: AbcElem["lyric"] };

export interface AbcChordProRow {
  readonly lyrics: string;
  readonly chords: readonly { name: string; pos: number }[];
  readonly continuesWord?: boolean;
}

export interface AbcChordProSection {
  readonly label: string;
  readonly grid: boolean;
  readonly rows: readonly AbcChordProRow[];
}

interface Part {
  start: number;
  label: string;
  verses: number;
  numbers: Record<number, string>;
}

/** Only lyric-field ownership is read here; abcjs owns note/syllable alignment.
 * Parsing each lyric lane separately avoids abcjs's sparse lyric arrays, where
 * the tail of verse two can otherwise look like the tail of verse one. */
function lyricLanes(source: string, label: string, fields: readonly { start: number; label: string }[]) {
  const parts: Part[] = [{ start: 0, label, verses: 0, numbers: {} }];
  const tunebook = (source.match(/^\s*X:/gm)?.length ?? 0) > 1;
  const lines = source.split("\n");
  const lanes: (number | undefined)[] = [];
  let offset = 0;
  let nextLane = 0;
  let previousLane: number | undefined;
  let continuation = false;
  let body = false;
  let tunes = 0;
  let title = false;
  let field = 0;
  for (const line of lines) {
    const text = line.trimStart();
    if (/^X:/.test(text)) {
      if (tunes++) parts.push({ start: offset, label, verses: 0, numbers: {} });
      body = false;
      title = false;
    }
    if (!body && !title && /^T:/.test(text) && (tunebook || !label)) {
      parts[parts.length - 1].label = text.slice(2).trim() || label;
      title = true;
    }
    if (/^K:/.test(text)) body = true;
    // abcjs distinguishes real body parts (P: and [P:]) from the header's
    // performance order and from text inside annotations/comments.
    while (field < fields.length && fields[field].start < offset + line.length + 1) {
      const part = fields[field++];
      parts.push({ start: part.start, label: part.label || label, verses: 0, numbers: {} });
    }
    if (/^w:/.test(text)) {
      previousLane = nextLane++;
      lanes.push(previousLane);
      parts[parts.length - 1].verses = Math.max(parts[parts.length - 1].verses, nextLane);
      const number = /^w:\s*(\d+)[.)]?(?:~|\s)/.exec(text)?.[1];
      if (number) parts[parts.length - 1].numbers[previousLane] ??= number;
      continuation = /\\\s*$/.test(line);
    } else if ((/^\+:/.test(text) || continuation) && previousLane != null) {
      lanes.push(previousLane);
      continuation = /\\\s*$/.test(line);
    } else {
      lanes.push(undefined);
      if (text && !text.startsWith("%")) {
        nextLane = 0;
        previousLane = undefined;
      }
    }
    offset += line.length + 1;
  }
  return { parts, lines, lanes };
}

function partFields(tunes: TuneObjectArray) {
  const fields = new Map<number, string>();
  for (const tune of tunes)
    for (const line of tune.lines)
      for (const staff of line.staff ?? [])
        for (const voice of staff.voices ?? [])
          for (const event of voice) if (event.el_type === "part" && event.startChar >= 0) fields.set(event.startChar, event.title);
  return [...fields].sort(([left], [right]) => left - right).map(([start, label]) => ({ start, label: label.trim() }));
}

/** Hungarian consonants written with two letters. Hyphenated lyrics repeat a long
 * one on both syllables (asz-szony), the spelling writes it once with a doubled
 * first letter (asszony). */
const HUNGARIAN_DIGRAPHS = ["cs", "gy", "ly", "ny", "sz", "ty", "zs"] as const;

/** First members of common compounds whose next member starts with the same
 * digraph. A compound boundary keeps both digraphs in full (díszszemle,
 * jegygyűrű, észszerű). Recognising every compound would need a dictionary of
 * several megabytes; compounds of this kind are rare in lyrics, while the
 * abbreviated forms (össze, vissza, hosszú, könnyű, mennyei, eggyé) are common. */
const HUNGARIAN_COMPOUND_STEMS = new Set(["agy", "dísz", "ész", "jegy", "kulcs", "nagy", "négy", "rész"]);

/** How many letters to drop from the end of `word` when `next` continues it
 * after a syllable break: 0 keeps both spellings, otherwise the long digraph is
 * abbreviated (ösz + sze = össze; an already abbreviated rossz + szal = rosszal). */
function hungarianContraction(word: string, next: string): number {
  const left = word
    .normalize("NFC")
    .toLocaleLowerCase("hu")
    .replace(/^[^\p{L}]+/u, "");
  // Trailing punctuation (naggyá!, dísszel,) is not part of the suffix test.
  const syllable = next
    .normalize("NFC")
    .toLocaleLowerCase("hu")
    .split(/\s/u, 1)[0]
    .replace(/[^\p{L}]+$/u, "");
  const digraph = HUNGARIAN_DIGRAPHS.find(
    (candidate) => left.length > candidate.length && left.endsWith(candidate) && syllable.startsWith(candidate)
  );
  if (!digraph) return 0;
  const contraction = left.endsWith(digraph[0] + digraph) ? digraph.length : 1;
  const rest = syllable.slice(digraph.length);
  // -val/-vel and -vá/-vé assimilate to the stem: always abbreviated (dísszel, eggyé).
  if (/^(?:al|el|á|é)$/u.test(rest)) return contraction;
  // The -szor/-szer/-ször suffix and compound boundaries keep both (húszszor, díszszemle).
  if (digraph === "sz" && /^(?:or|er|ör)/u.test(rest)) return 0;
  return HUNGARIAN_COMPOUND_STEMS.has(left) ? 0 : contraction;
}

function gridToken(event: AbcEvent): string[] {
  if (event.el_type === "note") {
    const chords: AbcElem["chord"] = event.chord;
    return chords?.map((chord) => chord.name) ?? [];
  }
  if (event.el_type !== "bar") return [];
  const bar = event;
  const tokens: string[] = [];
  if (bar.endEnding) tokens.push(")");
  const repeats: Record<string, string> = { bar_dbl_repeat: ":|:", bar_left_repeat: "|:", bar_right_repeat: ":|" };
  const repeat = repeats[bar.type];
  if (repeat) tokens.push(repeat);
  if (bar.startEnding) tokens.push(bar.startEnding + "(");
  return tokens;
}

function gridRow(events: readonly AbcEvent[]): AbcChordProRow {
  let lyrics = "";
  const chords: { name: string; pos: number }[] = [];
  for (const event of events)
    for (const token of gridToken(event)) {
      if (lyrics) lyrics += " ";
      if (event.el_type === "note") chords.push({ name: token, pos: lyrics.length });
      lyrics += token;
    }
  return { lyrics, chords };
}

function lyricRow(events: readonly AbcEvent[]): AbcChordProRow {
  let lyrics = "";
  let space = false;
  const chords: { name: string; pos: number }[] = [];
  for (const event of events) {
    if (event.el_type !== "note") continue;
    const lyric = event.lyric?.[0];
    let syllable = lyric?.syllable.replace(/\u00a0/g, " ").replace(/\\([\\\-_*|~])/g, "$1") ?? "";
    if (!lyrics) syllable = syllable.replace(/^\d+[.)]?\s+/, "");
    if (syllable && space && lyrics) lyrics += " ";
    for (const chord of event.chord ?? []) if (chord.position === "default") chords.push({ name: chord.name, pos: lyrics.length });
    if (syllable) {
      // Hungarian hyphenation repeats a long digraph on both syllables
      // (ösz-sze); the joined word spells it abbreviated (össze).
      const word = lyrics.slice(lyrics.lastIndexOf(" ") + 1);
      const contraction = space ? 0 : hungarianContraction(word, syllable);
      if (contraction) {
        lyrics = lyrics.slice(0, -contraction);
        for (const chord of chords) if (chord.pos > lyrics.length) chord.pos = Math.max(lyrics.length, chord.pos - contraction);
      }
      lyrics += syllable;
      space = lyric?.divider !== "-";
    }
  }
  return { lyrics, chords, continuesWord: !!lyrics && !space };
}

/** A music-system break is not a word boundary. Merge only explicitly continued
 * words, retaining UTF-16 chord anchors and the spelling contraction at the join. */
function appendLyricRow(rows: AbcChordProRow[], row: AbcChordProRow) {
  const previous = rows[rows.length - 1];
  if (!previous?.continuesWord) {
    rows.push(row);
    return;
  }
  const word = previous.lyrics.slice(previous.lyrics.lastIndexOf(" ") + 1);
  const contraction = hungarianContraction(word, row.lyrics);
  const offset = previous.lyrics.length - contraction;
  rows[rows.length - 1] = {
    lyrics: previous.lyrics.slice(0, offset) + row.lyrics,
    chords: [
      ...previous.chords.map((chord) => ({ ...chord, pos: chord.pos > offset ? Math.max(offset, chord.pos - contraction) : chord.pos })),
      ...row.chords.map((chord) => ({ ...chord, pos: chord.pos + offset })),
    ],
    continuesWord: row.lyrics ? row.continuesWord : previous.continuesWord,
  };
}

/** A partial ChordPro model, independent of SVG, layout, the editor and storage.
 * Null means there are no aligned lyrics: the caller keeps its legacy grid path.
 * Repeats are retained in grids, not unfolded into an invented performance order. */
export function abcToChordPro(source: string, label: string, parse: (abc: string) => TuneObjectArray): readonly AbcChordProSection[] | null {
  if (!/^[\t ]*w:/m.test(source)) return null;
  const original = parse(source);
  if (original.some((tune) => tune.warnings?.length)) throw new Error("ABC lyrics could not be aligned without parser warnings");
  const { parts, lines, lanes } = lyricLanes(source, label, partFields(original));
  const count = Math.max(...parts.map((part) => part.verses));
  if (!count) return null;
  const sections: AbcChordProSection[] = [];
  const rows = parts.map(() => Array.from({ length: count }, () => [] as AbcEvent[][]));
  for (let lane = 0; lane < count; ++lane) {
    const masked = lines.map((line, i) => (lanes[i] == null || lanes[i] === lane ? line : line.replace(/[^\r]/g, " ").replace(/^ /, "%"))).join("\n");
    for (const tune of parse(masked)) {
      if (tune.warnings?.length) throw new Error("ABC lyrics could not be aligned without parser warnings");
      for (const line of tune.lines) {
        const allVoices = (line.staff ?? []).flatMap((staff) => (staff.voices ?? []) as AbcEvent[][]);
        const vocalVoices = allVoices.filter((voice) => voice.some((event) => event.lyric?.some((lyric) => lyric.syllable)));
        if (vocalVoices.length > 1) throw new Error("Simultaneous vocal voices require separate lyric parts");
        // A second staff is simultaneous too: appending its chords after the
        // vocal staff would change their musical position instead of aligning
        // them to the lyrics. Keep the score until time-based alignment exists.
        if (
          vocalVoices.length &&
          allVoices.some((voice) => voice !== vocalVoices[0] && voice.some((event) => event.el_type === "note" && event.chord?.length))
        )
          throw new Error("Accompaniment chord staves require musical-time alignment");
        for (const staff of line.staff ?? []) {
          // A vocal melody can share a staff with accompaniment. Never interleave
          // simultaneous lyric voices into one line of text.
          const voices = (staff.voices ?? []) as AbcEvent[][];
          const voice = voices.find((events) => events.some((event) => event.lyric?.some((lyric) => lyric.syllable))) ?? voices[0];
          if (!voice) continue;
          if (voices.some((other) => other !== voice && other.some((event) => event.el_type === "note" && event.chord?.length)))
            throw new Error("Accompaniment chord voices require musical-time alignment");
          const byPart = new Map<number, AbcEvent[]>();
          for (const event of voice) {
            if (event.el_type !== "note" && event.el_type !== "bar") continue;
            let part = parts.length - 1;
            while (part > 0 && parts[part].start > event.startChar) --part;
            const events = byPart.get(part) ?? [];
            events.push(event);
            byPart.set(part, events);
          }
          for (const [part, events] of byPart) {
            rows[part][lane].push(events);
          }
        }
      }
    }
  }
  for (let i = 0; i < parts.length; ++i) {
    const part = parts[i];
    const vocalLanes = rows[i].map((verse) => verse.some((events) => events.some((event) => event.lyric?.some((lyric) => lyric.syllable))));
    const vocal = vocalLanes.some(Boolean);
    const verses = vocal ? Math.max(part.verses, vocalLanes.lastIndexOf(true) + 1) : 1;
    for (let lane = 0; lane < verses; ++lane) {
      const converted: AbcChordProRow[] = [];
      for (const events of rows[i][lane]) {
        const number = events
          .flatMap((event) => event.lyric ?? [])
          .find((lyric) => lyric.syllable)
          ?.syllable.match(/^(\d+)[.)]?\s/)?.[1];
        if (number) part.numbers[lane] ??= number;
        const row = vocal ? lyricRow(events) : gridRow(events);
        if (!row.lyrics && !row.chords.length && (vocal || !events.some((event) => event.el_type === "note"))) continue;
        if (vocal) appendLyricRow(converted, row);
        else converted.push(row);
      }
      if (!converted.length) continue;
      sections.push({
        label: (part.label || "Verse") + (verses > 1 || part.numbers[lane] ? ` ${part.numbers[lane] ?? lane + 1}` : ""),
        grid: !vocal,
        rows: converted,
      });
    }
  }
  return sections.some((section) => !section.grid) ? sections : null;
}
