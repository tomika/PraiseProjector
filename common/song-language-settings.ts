import { readPersistedSettingsText } from "./persisted-settings";
import { DEFAULT_SONG_LANGUAGE, normalizeSongLanguage, normalizeSongLanguageFilter } from "./song-language";

export function readSongLanguageSettings(): { defaultSongLanguage: string; songLanguageFilter: string[] | null } {
  try {
    const raw = readPersistedSettingsText();
    const settings = raw ? JSON.parse(raw) : {};
    return {
      defaultSongLanguage: normalizeSongLanguage(settings?.defaultSongLanguage),
      songLanguageFilter: normalizeSongLanguageFilter(settings?.songLanguageFilter),
    };
  } catch {
    return { defaultSongLanguage: DEFAULT_SONG_LANGUAGE, songLanguageFilter: [DEFAULT_SONG_LANGUAGE] };
  }
}
