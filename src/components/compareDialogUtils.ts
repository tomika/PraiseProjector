import { Song } from "../../db-common/Song";
import type { SongHistoryEntry } from "../../common/pp-types";

export function convertHistoryEntryToSongWithHistory(historyEntry: SongHistoryEntry): Song {
  return new Song(
    historyEntry.songdata.text,
    historyEntry.songdata.system,
    {
      uploader: historyEntry.uploader,
      created: new Date(historyEntry.created),
    },
    historyEntry.songdata.language
  );
}

export function convertHistoryEntriesToSongsWithHistory(historyEntries: SongHistoryEntry[]): Song[] {
  return historyEntries.map(convertHistoryEntryToSongWithHistory);
}
