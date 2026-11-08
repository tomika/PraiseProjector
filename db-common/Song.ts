import { v4 as uuidv4 } from "uuid";
import { KnownChordModifiers } from "./KnownChordModifiers";
import { StringExtensions } from "./StringExtensions";
import { ChordSystemCode, SongDBEntryWithData, SongUpdate } from "../common/pp-types";
import { decode } from "../common/io-utils";
import * as t from "io-ts";
import { chordSystemCodec, songDataCodec, uniType } from "../common/pp-codecs";
import { ChordProAbc, ChordProDocument, getChordSystem, rxAbcEndDirective } from "../chordpro/chordpro_base";
import { projectDisplaySequence } from "../chordpro/render/display-plan";
import type { AbcRange } from "../common/pp-types";
import { Instructions } from "../chordpro/chordpro_instructions";
import { normalizeSongLanguage, DEFAULT_SONG_LANGUAGE } from "../common/song-language";

export const songStoreCodec = uniType(
  {
    songId: t.string,
    songdata: songDataCodec,
    version: t.number,
  },
  {
    groupId: t.string,
  }
);

const legacySongStoreCodec = t.type({
  _id: t.string,
  _group_id: t.string,
  version: t.number,
  _system: chordSystemCodec,
  _text: t.string,
});

export type SongStoreRecord = t.TypeOf<typeof songStoreCodec>;

export type SongChange = {
  uploader: string;
  created: Date;
};

/**
 * Song-tree content class; every song belongs to exactly one, so the tree's
 * content filters partition the songs:
 * - `text`: neither bracketed chords nor ABC notation.
 * - `music`: bracketed chords, or ABC notation alongside lyrics/other content lines.
 * - `score`: ABC notation only, apart from metadata, directives and comments.
 */
export type SongContentKind = "text" | "music" | "score";

export class Song {
  public static readonly SectionType = {
    unknown: 0,
    verse: 1,
    chorus: 2,
    bridge: 3,
  } as const;

  public static Section = class {
    /**
     * For sections produced by `InstructedSections()`, the 0-based index of
     * the originating `Instructions.items[]` entry. Lets the projector tag
     * each generated SectionItem with the same canonical section number that
     * the editor's instructed line rendering uses, so highlights line up
     * regardless of how the projector paginates a section across screens or
     * how many times a multiplier expands it.
     */
    public instructedIndex?: number;
    public instructedMultiplier?: number;
    /** Zero-based pass through a repeat already expanded into projection rows. */
    public projectionRepeat?: { index: number; total: number };
    public sourceSignature?: string;
    public abcRange?: AbcRange;
    public sourceRows?: { from: number; to: number; abcRange?: AbcRange }[];
    constructor(
      public text: string,
      public from: number,
      public to: number,
      public block: number,
      public type: number,
      public tag: string
    ) {}
  };

  private _id: string;
  private _group_id: string = "";
  public version: number = 0;
  private _system: ChordSystemCode;
  private _language: string = DEFAULT_SONG_LANGUAGE;
  private _text: string;
  private _title: string = "";
  private _lyrics: string = "";
  private _sections: InstanceType<typeof Song.Section>[] = [];
  private _simplified: string | null = null;
  private _words: string[] | null = null;
  private _metadata: Map<string, string> = new Map();
  private _contentKind: SongContentKind = "text";
  private _headerWordCount: number = -1;
  private _change?: SongChange;
  private _notes: string = "";
  private _capo: number = 0;
  private _sectionsMap: Map<string, InstanceType<typeof Song.Section>[]> = new Map();
  public _sectionSignatures: number[][] | null = null; // cached MinHash signatures per section (computed by Database)

  private static rxMeta = /^[ \t]*{([^:]+):([^}]*)}[ \t\r]*$/gm;
  private static rxLyricsPart = /(?:\[[^]]*\])*([^[]*)/g;
  private static rxChord = /^([^A-H]*)([A-H][b#]?)((?:\/[0-9]|[^ /)])*)(?:(\/)([A-H][b#]?))?(.*)$/i;
  private static rxTagged = /\[([^\]]*)\]/g;
  private static rxEmptyLines = /(\r?\n)+/g;
  private static rxNotes = /^# notes:(.*)$/m;
  // Applied to trimmed lines. rxChordTag is non-global on purpose: a shared /g
  // regex keeps lastIndex between test() calls on different songs.
  private static rxChordTag = /\[[^\]]*\]/;
  private static rxDirectiveLine = /^\{.*\}$/;
  private static rxAbcStart = /^\{[ \t]*start_of_abc(?=[ \t:}]).*\}$/;

  /** Classify ChordPro lines for the song tree (see SongContentKind). Outside ABC
   *  blocks any bracket tag counts as a chord, as it always has; inside them
   *  brackets are ABC chords and inline fields (`[CEG]`, `[K:G]`). Metadata,
   *  other directives and `#` comments are not content. An unterminated ABC
   *  block runs to the end of the song, as in the ChordPro parser. */
  private static classifyContent(lines: readonly string[]): SongContentKind {
    let inAbc = false;
    let hasAbc = false;
    let hasChords = false;
    let hasOtherContent = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (inAbc) {
        if (rxAbcEndDirective.test(trimmed)) inAbc = false;
        continue;
      }
      if (Song.rxAbcStart.test(trimmed)) {
        inAbc = hasAbc = true;
        continue;
      }
      if (!trimmed) continue;
      if (!hasChords && Song.rxChordTag.test(trimmed)) hasChords = true;
      if (!trimmed.startsWith("#") && !Song.rxDirectiveLine.test(trimmed)) hasOtherContent = true;
    }
    if (hasAbc && !hasOtherContent) return "score";
    return hasAbc || hasChords ? "music" : "text";
  }

  // Lazily built ChordPro AST for this song. Invalidated whenever `_text` changes.
  private _doc?: ChordProDocument;
  private get doc(): ChordProDocument {
    if (!this._doc) this._doc = new ChordProDocument(getChordSystem(this._system), this._text);
    return this._doc;
  }

  constructor(t: string, s: ChordSystemCode = "G", change?: SongChange, language: string = DEFAULT_SONG_LANGUAGE) {
    this._text = t.replace(Song.rxEmptyLines, "\n");
    this._system = s;
    this._language = normalizeSongLanguage(language);
    this._id = uuidv4();
    this._change = change;
    this.parse();
  }

  public static fromServer(data: SongDBEntryWithData): Song {
    const song = new Song(data.songdata.text, data.songdata.system, undefined, data.songdata.language);
    song.Id = data.songId;
    song.version = data.version;
    if (data.groupId) song.GroupId = data.groupId;
    return song;
  }

  public static fromJSON(_json: unknown): Song {
    let song: Song;
    try {
      const json = decode(songStoreCodec, _json);
      song = new Song(json.songdata.text, json.songdata.system, undefined, json.songdata.language);
      song._id = json.songId;
      song.version = json.version;
      if (json.groupId) song._group_id = json.groupId;
    } catch (error) {
      try {
        const json = decode(legacySongStoreCodec, _json);
        song = new Song(json._text, json._system || "G");
        song._id = json._id;
        song._group_id = json._group_id || "";
        song.version = json.version || 0;
      } catch (e2) {
        console.error("Failed to decode song JSON with both legacy and current codecs", e2);
        throw error;
      }
    }
    // All other properties are recalculated by parse() in the constructor
    return song;
  }

  public get Id(): string {
    return this._id;
  }
  public set Id(value: string) {
    if (value) this._id = value;
  }

  public get GroupId(): string {
    return this._group_id;
  }
  public set GroupId(value: string) {
    this._group_id = value || "";
  }

  public get System() {
    return this._system;
  }
  public get Language(): string {
    return this._language;
  }
  public set Language(value: string) {
    const language = normalizeSongLanguage(value);
    if (this._language !== language) {
      this._language = language;
      this.version = 0;
    }
  }

  public hasSameContent(other: Song): boolean {
    return this.Text === other.Text && this.System === other.System && this.Language === other.Language && this.GroupId === other.GroupId;
  }
  public get Title(): string {
    return this._title;
  }
  public get Lyrics(): string {
    return this._lyrics;
  }
  public get Text(): string {
    return this._text;
  }
  public get Sections(): InstanceType<typeof Song.Section>[] {
    return this._sections;
  }
  public get Change(): SongChange | undefined {
    return this._change;
  }
  public get MetaData(): Map<string, string> {
    return this._metadata;
  }

  public get Simplified(): string {
    if (this._simplified === null) {
      this._simplified = StringExtensions.simplify(this.Lyrics);
    }
    return this._simplified;
  }

  public get Words(): string[] {
    if (this._words === null) {
      this._words = this.Simplified.split(" ").filter((w) => w);
    }
    return this._words;
  }

  public get HeaderWordCount(): number {
    if (this._headerWordCount < 0) {
      const i = this.Lyrics.indexOf("\n");
      const header = i >= 0 ? this.Lyrics.substring(0, i) : this.Lyrics;
      this._headerWordCount = StringExtensions.getWords(header).length;
    }
    return this._headerWordCount;
  }

  public get Capo(): number {
    return this._capo;
  }
  public get ContentKind(): SongContentKind {
    return this._contentKind;
  }

  public get InvalidChords(): string[] {
    const chords = new Set<string>();
    const matches = this.Text.match(Song.rxTagged);
    if (matches) {
      for (const m of matches) {
        const chord = m.substring(1, m.length - 1);
        if (!chords.has(chord) && (chord.trim() === "" || !Song.rxChord.test(chord))) {
          chords.add(chord);
        }
      }
    }
    return Array.from(chords);
  }

  public UnknownChords(known_chord_modifiers: KnownChordModifiers): string[] {
    const chords = new Set<string>();
    if (known_chord_modifiers) {
      const matches = this.Text.match(Song.rxTagged);
      if (matches) {
        for (const m of matches) {
          const chord = m.substring(1, m.length - 1);
          if (!chords.has(chord) && !known_chord_modifiers.validate(chord)) {
            chords.add(chord);
          }
        }
      }
    }
    return Array.from(chords);
  }

  public updateChordProText(text: string) {
    const normalized = text.replace(Song.rxEmptyLines, "\n");
    if (normalized === this._text) {
      return;
    }

    // Group membership is stored separately from the editable ChordPro text.
    // parse() clears and optionally imports legacy # group_id metadata, so keep
    // the current database relationship across ordinary editor reparses.
    const groupId = this._group_id;
    this._text = normalized;
    this._simplified = null;
    this._words = null;
    this._sections = [];
    this._lyrics = "";
    this._metadata = new Map();
    this._sectionsMap = new Map();
    this._doc = undefined;
    this.version = 0;
    this.parse();
    this._group_id = groupId;
  }

  public clone(): Song {
    return Song.fromJSON(this.toJSON());
  }

  private static extractWords(s: string): Set<string> {
    const set = new Set<string>();
    s.trim()
      .split(" ")
      .forEach((n) => {
        if (n.trim() !== "") {
          set.add(n);
        }
      });
    return set;
  }

  public ClearNotes() {
    this._notes = "";
    this._text = this._text.replace(Song.rxNotes, "").trim();
    this.version = 0;
  }

  public get Notes(): string {
    return this._notes;
  }

  public set Notes(value: string) {
    const normalized = value ? value.trim() : "";
    if (normalized !== this._notes) {
      if (this._notes !== "") {
        const currentMarks = Song.extractWords(this._notes);
        const newMarks = Song.extractWords(normalized);
        newMarks.forEach((s) => currentMarks.add(s));
        this._notes = Array.from(currentMarks).join(" ");
      } else {
        this._notes = normalized;
      }

      if (this._notes !== "") {
        let s = this._text.replace(Song.rxNotes, "# notes: " + this._notes);
        if (this._text === s) s += "\n# notes: " + this._notes;
        this._text = s;
      } else {
        this._text = this._text.replace(Song.rxNotes, "").trim();
      }
      this.version = 0;
    }
  }

  private getMeta(name: string): string {
    return this._metadata.get(name) || "";
  }

  public get note(): string {
    return this.getMeta("note");
  }

  private parse() {
    this._group_id = "";

    const m = this._text.match(Song.rxNotes);
    this._notes = m && m[1] ? m[1].trim() : "";

    this._title = "";
    this._metadata.clear();
    const valueSet = new Set<string>();
    let metaMatch = Song.rxMeta.exec(this._text);
    while (metaMatch) {
      const metaName = metaMatch[1].trim();
      const metaValue = metaMatch[2].trim();
      if (metaName === "title") {
        this._title = metaValue;
      } else {
        if (metaName === "capo" && metaValue) {
          const capoVal = parseInt(metaValue, 10);
          if (!isNaN(capoVal)) {
            this._capo = capoVal;
          }
        }
        valueSet.add(metaValue);
      }
      metaMatch = Song.rxMeta.exec(this._text);
    }
    this._metadata = new Map(Array.from(valueSet).map((v) => [v, v]));
    this._lyrics = "";

    const slist: InstanceType<typeof Song.Section>[] = [];
    let bInGrid = false;
    let block = 0;
    const lines = this._text.split("\n");
    this._contentKind = Song.classifyContent(lines);
    let currentType: number = Song.SectionType.unknown;
    let currentTag = "";

    const linesToRemove = new Set<number>();
    for (let i = 0; i < lines.length; ++i) {
      const line = lines[i];
      if (line == null) {
        linesToRemove.add(i);
        continue;
      }

      if (line.startsWith("# group_id:")) {
        this._group_id = line.substring(11).trim();
        linesToRemove.add(i);
        continue;
      }

      const trimmed = line.trimStart();
      let lyrics_line = "";

      if (trimmed.startsWith("{")) {
        ++block;
        const sa = trimmed.substring(1).split(":");
        let type = (sa[0] || "").trim();
        const tag = sa.length > 1 && sa[1] ? sa[1].replace("}", "").trim() : "";
        if (type.endsWith("}")) type = type.substring(0, type.length - 1).trim();

        if (type === "start_of_grid" || type === "start_of_tab" || type === "sot" || type === "sog" || type === "start_of_abc") bInGrid = true;
        else if (type === "end_of_grid" || type === "end_of_tab" || type === "eot" || type === "eog" || type === "end_of_abc") bInGrid = false;

        if (type.startsWith("end_of_") || type.startsWith("eo")) {
          currentType = Song.SectionType.unknown;
          currentTag = "";
        } else if (type === "start_of_verse" || type === "sov") {
          currentType = Song.SectionType.verse;
          currentTag = !tag ? "Verse" : tag;
        } else if (type === "start_of_chorus" || type === "soc") {
          currentType = Song.SectionType.chorus;
          currentTag = !tag ? "Chorus" : tag;
        } else if (type === "start_of_bridge" || type === "sob") {
          currentType = Song.SectionType.bridge;
          currentTag = !tag ? "Bridge" : tag;
        } else {
          currentType = Song.SectionType.unknown;
          currentTag = "";
        }

        const lastSection = slist[slist.length - 1];
        if (slist.length > 0 && lastSection && lastSection.text !== "") {
          if (
            type.startsWith("start_of_") ||
            type.startsWith("end_of_") ||
            type.startsWith("so") ||
            type.startsWith("eo") ||
            type === "x_section_break"
          )
            slist.push(new Song.Section("", 0, 0, block, currentType, currentTag));
        }
      } else if (!bInGrid && !trimmed.startsWith("#")) {
        lyrics_line = line.replace(Song.rxTagged, "");
      }

      if (lyrics_line) {
        lyrics_line = StringExtensions.minimizeSpaces(lyrics_line);
        this._lyrics += lyrics_line + "\n";

        if (slist.length > 0) {
          const section = slist[slist.length - 1]!;
          if (section.type !== currentType && section.type === Song.SectionType.unknown && currentType !== Song.SectionType.unknown)
            section.type = currentType;
          if (section.tag !== currentTag && !section.tag && currentTag) section.tag = currentTag;
          section.text += lyrics_line + "\r\n";
          if (section.from === 0) section.from = i;
          section.to = i + 1;
        } else {
          slist.push(new Song.Section(lyrics_line + "\r\n", i, i + 1, block, currentType, currentTag));
        }
      }
    }

    if (linesToRemove.size > 0) {
      this._text = lines.filter((_, i) => !linesToRemove.has(i)).join("\n");
    }

    this._sections = slist.filter((s) => s.text.trim() !== "");
    for (const section of this._sections) {
      section.sourceSignature = lines.slice(section.from, section.to).join("\n");
    }
    this._sectionSignatures = null;

    // Key sections by their canonical (multiplier-stripped) form so that an
    // instruction line like "Chorus 3x" matches an authored section tagged
    // "Chorus (2x)". Canonicalization is delegated to ChordProSectionInfo via
    // a fresh per-parse ChordProDocument lookup.
    this._sectionsMap = new Map<string, InstanceType<typeof Song.Section>[]>();
    if (linesToRemove.size > 0) this._doc = undefined; // _text was mutated above
    for (const section of this._sections) {
      if (!section.tag) continue;
      const info = Instructions.findSection(this.doc, section.tag);
      const key = info ? info.instructionName().toLocaleLowerCase() : section.tag.trim().toLocaleLowerCase();
      if (!key) continue;
      if (!this._sectionsMap.has(key)) this._sectionsMap.set(key, []);
      this._sectionsMap.get(key)!.push(section);
    }
  }

  public GroupWith(s: Song): string {
    if (!s._group_id) {
      // The target song is the group's anchor. Using its UUID as the group UUID
      // lets the tree retain the target song's title as the folder label.
      s._group_id = s.Id;
      s.version = 0;
    }
    this._group_id = s._group_id;
    this.version = 0;
    return this._group_id;
  }

  public IsInSameGroupWith(s: Song): boolean {
    return !!this._group_id && !!s._group_id && this._group_id === s._group_id;
  }

  public ToUpdate(): SongUpdate {
    return { songId: this.Id, songdata: { text: this._text, system: this._system, language: this._language }, groupId: this._group_id };
  }

  public toJSON(): t.TypeOf<typeof songStoreCodec> {
    return { ...this.ToUpdate(), version: this.version };
  }

  public InstructedSections(instructions: string, filterGrid = true): InstanceType<typeof Song.Section>[] {
    const sections: InstanceType<typeof Song.Section>[] = [];
    if (!this._sectionsMap) return sections;

    // When no explicit instructions are supplied, derive the song's built-in
    // defaults from the ChordPro document (one entry per comment line plus
    // one normalized entry per distinct section block, in source order).
    const source = instructions && instructions.trim() ? instructions : this.doc.getDefaultInstructions();
    if (!source.trim()) return sections;

    const list = new Instructions();
    list.parse(source, this.doc);
    for (let i = 0; i < list.items.length; ++i) {
      const item = list.items[i];
      // Free-form comment lines (no resolved section info) do not appear in
      // the section list — they are display-only annotations.
      if (item.multiplier == null || !item.info) continue;
      // Grid directives can appear in defaults/instructions but are not
      // projectable lyric sections and must stay out of section lists.
      if (filterGrid && item.info.name === "start_of_grid") continue;
      const key = item.info.instructionName().toLocaleLowerCase();
      const ss = this._sectionsMap.get(key);
      if (!ss) continue;
      for (const s of ss) {
        // Clone the cached Section so we can stamp instruction metadata
        // without mutating the shared canonical instance.
        const clone = new Song.Section(s.text, s.from, s.to, s.block, s.type, s.tag);
        clone.instructedIndex = i;
        clone.instructedMultiplier = item.multiplier;
        clone.sourceSignature = s.sourceSignature;
        sections.push(clone);
      }
    }
    return sections;
  }

  /** Project the same readonly ABC expansion and instruction indices as clients.
   * Stored lyrics/search sections and the saved ABC text stay source based. */
  public ProjectionSections(instructions?: string): InstanceType<typeof Song.Section>[] {
    if (!this.doc.lines.some((line) => line instanceof ChordProAbc))
      return instructions === undefined ? this.Sections : this.InstructedSections(instructions);
    const list = instructions?.trim() ? new Instructions() : null;
    if (list) list.parse(instructions!, this.doc);
    const sequence = projectDisplaySequence({
      document: this.doc,
      readOnly: true,
      abcMode: "CHORDS",
      instructionsMode: instructions === undefined ? "" : "FULL",
      instructions: list,
    });
    const sections: InstanceType<typeof Song.Section>[] = [];
    const aggregateRepeats = new Map<number, number>();
    let previousKey: string | undefined;
    let block = 0;
    for (const { line, instructionIndex, item } of sequence.lines) {
      if (instructionIndex != null && item?.info?.name === "start_of_abc" && item.multiplier != null && item.multiplier > 1)
        aggregateRepeats.set(instructionIndex, item.multiplier);
      const info = line.getSectionInfo();
      const authoredSection = line.abcSource
        ? undefined
        : this._sections.find((s) => s.from <= line.sourceLineNumber && line.sourceLineNumber < s.to);
      const key = line.abcSource
        ? `${info.key}|${instructionIndex ?? ""}|abc:${line.abcSource.sourceLineNumber}`
        : `authored:${authoredSection?.block ?? info.key}|${instructionIndex ?? ""}`;
      // Grid/ABC blocks have explicit section boundaries. Comments, blank rows
      // and chord-only rows inside a verse do not split its projected lyrics.
      if (line.isInstrumental) {
        previousKey = undefined;
        continue;
      }
      if (line.isComment || !line.lyrics.trim()) continue;
      const abcRange =
        line.abcSource && line.abcRow != null ? { source: line.abcSource.sourceLineNumber, from: line.abcRow, to: line.abcRow + 1 } : undefined;
      const from = line.sourceLineNumber;
      const to = from + 1;
      let section = sections[sections.length - 1];
      if (!section || previousKey !== key) {
        const type =
          authoredSection?.type ??
          (info.name === "start_of_chorus"
            ? Song.SectionType.chorus
            : info.name === "start_of_bridge"
              ? Song.SectionType.bridge
              : info.name === "start_of_verse"
                ? Song.SectionType.verse
                : Song.SectionType.unknown);
        section = new Song.Section("", from, to, block++, type, authoredSection?.tag ?? info.instructionName());
        section.instructedIndex = instructionIndex;
        section.instructedMultiplier = item?.multiplier;
        section.abcRange = abcRange && { ...abcRange };
        section.sourceRows = [];
        sections.push(section);
      }
      section.text += line.lyrics.trim() + "\r\n";
      section.from = Math.min(section.from, from);
      section.to = Math.max(section.to, to);
      section.sourceRows!.push({ from, to, abcRange });
      if (section.abcRange && abcRange) section.abcRange.to = abcRange.to;
      previousKey = key;
    }
    for (const section of sections) {
      section.sourceSignature = JSON.stringify([section.tag, section.text, section.abcRange]);
    }
    const result: InstanceType<typeof Song.Section>[] = [];
    for (let i = 0; i < sections.length; ++i) {
      const section = sections[i];
      const multiplier = section.instructedIndex == null ? 1 : (aggregateRepeats.get(section.instructedIndex) ?? 1);
      let end = i + 1;
      while (end < sections.length && sections[end].instructedIndex === section.instructedIndex) ++end;
      if (multiplier > 1 && end - i > 1 && multiplier * (end - i) <= 1000) {
        for (let repeat = 0; repeat < multiplier; ++repeat)
          for (const part of sections.slice(i, end))
            result.push({ ...part, instructedMultiplier: 1, projectionRepeat: { index: repeat, total: multiplier } });
        i = end - 1;
      } else result.push(section);
    }
    return result;
  }
}
