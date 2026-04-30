import { PreferenceType, SongPreferenceEntry } from "../common/pp-types";

export class SongPreference {
  public title: string = "";
  public transpose: number = 0;
  public capo: number = -1;
  public instructions: string = "";
  public type?: PreferenceType;
  public songId: string = "";

  constructor(songId: string = "") {
    this.songId = songId;
  }

  public clone(): SongPreference {
    const pref = new SongPreference(this.songId);
    pref.title = this.title;
    pref.transpose = this.transpose;
    pref.capo = this.capo;
    pref.instructions = this.instructions;
    pref.type = this.type;
    return pref;
  }

  public equals(p: SongPreference): boolean {
    return (
      (this.title || "") === (p.title || "") &&
      (this.instructions || "") === (p.instructions || "") &&
      this.transpose === p.transpose &&
      this.capo === p.capo &&
      this.type === p.type
    );
  }

  public get isActive(): boolean {
    return !!this.title || this.transpose !== 0 || this.capo >= 0 || this.type != null || !!this.instructions;
  }

  public formatTranspose(): string {
    if (this.transpose === 0) return "";
    return this.transpose > 0 ? "#" + this.transpose.toString() : "b" + (0 - this.transpose).toString();
  }

  public formatCapo(): string {
    return this.capo >= 0 ? this.capo.toString() : "";
  }

  public toUpdate(): Record<string, unknown> {
    return {
      songId: this.songId,
      capo: this.capo,
      transpose: this.transpose,
      title: this.title,
      instructions: this.instructions,
      type: this.type,
    };
  }

  static fromJSON(data: SongPreferenceEntry): SongPreference {
    const pref = new SongPreference(data.songId);
    pref.title = data.title ?? "";
    pref.transpose = data.transpose ?? 0;
    pref.capo = data.capo ?? -1;
    pref.instructions = data.instructions ?? "";
    pref.type = data.type ?? undefined;
    return pref;
  }

  toJSON(): SongPreferenceEntry {
    return {
      songId: this.songId,
      title: this.title,
      transpose: this.transpose,
      capo: this.capo,
      instructions: this.instructions,
      type: this.type,
    };
  }
}
