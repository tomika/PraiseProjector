import { v4 as uuidv4 } from "uuid";
import { KnownChordModifiers } from "./KnownChordModifiers";
import { StringExtensions } from "./StringExtensions";
import { ChordSystemCode, SongDBEntryWithData, SongUpdate } from "../common/pp-types";
import { decode } from "../common/io-utils";
import * as t from "io-ts";
import { chordSystemCodec, songDataCodec, uniType } from "../common/pp-codecs";

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

export class Song {
  public static readonly SectionType = {
    unknown: 0,
    verse: 1,
    chorus: 2,
    bridge: 3,
  } as const;

  public static Section = class {
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
  private _text: string;
  private _title: string = "";
  private _lyrics: string = "";
  private _sections: InstanceType<typeof Song.Section>[] = [];
  private _simplified: string | null = null;
  private _words: string[] | null = null;
  private _metadata: Map<string, string> = new Map();
  private _textOnly: boolean = false;
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
  private static rxInstructionMultiplier = /^(.*)[ \t]*[-:]?[ \t]*[(]?[ \t]*([0-9]+)[xX*][ \t]*[)]?[ \t]*$/;

  constructor(t: string, s: ChordSystemCode = "G", change?: SongChange) {
    this._text = t.replace(Song.rxEmptyLines, "\n");
    this._system = s;
    this._id = uuidv4();
    this._change = change;
    this.parse();
  }

  public static fromServer(data: SongDBEntryWithData): Song {
    const song = new Song(data.songdata.text, data.songdata.system);
    song.Id = data.songId;
    song.version = data.version;
    if (data.groupId) song.GroupId = data.groupId;
    return song;
  }

  public static fromJSON(_json: unknown): Song {
    let song: Song;
    try {
      const json = decode(songStoreCodec, _json);
      song = new Song(json.songdata.text, json.songdata.system);
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
  public get TextOnly(): boolean {
    return this._textOnly;
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

    this._text = normalized;
    this._simplified = null;
    this._words = null;
    this._sections = [];
    this._lyrics = "";
    this._metadata = new Map();
    this._sectionsMap = new Map();
    this.version = 0;
    this.parse();
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
    this._textOnly = !Song.rxTagged.test(this._text);

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
    this._sectionSignatures = null;

    this._sectionsMap = new Map<string, InstanceType<typeof Song.Section>[]>();
    for (const section of this._sections) {
      if (section.tag) {
        if (!this._sectionsMap.has(section.tag)) {
          this._sectionsMap.set(section.tag, []);
        }
        this._sectionsMap.get(section.tag)!.push(section);
      }
    }
  }

  public GroupWith(s: Song): string {
    if (!s._group_id) {
      s._group_id = uuidv4();
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
    return { songId: this.Id, songdata: { text: this._text, system: this._system }, groupId: this._group_id };
  }

  public toJSON(): t.TypeOf<typeof songStoreCodec> {
    return { ...this.ToUpdate(), version: this.version };
  }

  public InstructedSections(instructions: string): InstanceType<typeof Song.Section>[] {
    const sections: InstanceType<typeof Song.Section>[] = [];
    if (this._sectionsMap) {
      for (const line of instructions.split("\n")) {
        let id = line.trim();
        let multiplier = 1;
        const match = id.match(Song.rxInstructionMultiplier);
        if (match && match[1] && match[2]) {
          id = match[1].trim();
          const parsedMultiplier = parseInt(match[2], 10);
          if (!isNaN(parsedMultiplier)) {
            multiplier = parsedMultiplier;
          }
        }
        if (this._sectionsMap.has(id)) {
          const ss = this._sectionsMap.get(id)!;
          while (multiplier-- > 0) {
            sections.push(...ss);
          }
        }
      }
    }
    return sections;
  }
}
