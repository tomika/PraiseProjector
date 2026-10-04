/**
 * Hardware commands on the song preselected in the options panel's visible list
 * (the cursor the legacy PageUp/PageDown rows move). Pure: which row is the
 * target and what a command would do there; the store carries the plan out
 * through its own list and playlist methods.
 */
import { CAPO_RANGE, TRANSPOSE_RANGE, type NumberOp, type PreselectionCommand } from "../../../common/hardware-input";
import type { PlaylistEntry, SongEntry, SongFound } from "../../../common/pp-types";
import type { ClientViewState } from "./ClientViewStore";

export type ListRow = SongEntry | SongFound | PlaylistEntry;

/** The songs of the selected leader + dated playlist (the rows the picker shows). */
export function selectedLeaderEntriesOf(state: ClientViewState): PlaylistEntry[] {
  const profile = state.leaderProfiles.find((p) => p.leaderId === state.selectedLeaderId);
  const playlist = profile?.playlists.find((pl) => pl.label === state.selectedPlaylistLabel);
  return playlist?.songs ?? [];
}

/** The rows currently rendered by the active options-panel list mode. */
export function visibleListRows(state: ClientViewState): ListRow[] {
  if (state.listMode === "playlist") {
    const filter = state.playlistFilterText.trim();
    const showFilteredRows = !!filter && (!state.playlistSearching || state.playlistSearchResults.length > 0);
    if (!showFilteredRows) return state.playlist;
    const resultIds = new Set(state.playlistSearchResults.map((entry) => entry.songId));
    return state.playlist.filter((entry) => resultIds.has(entry.songId));
  }
  if (state.listMode === "leaderlists") return selectedLeaderEntriesOf(state);
  if (!state.searchText.trim()) return state.songs;
  return state.searching && state.searchResults.length === 0 ? state.songs : state.searchResults;
}

export type PreselectionPlan =
  | { kind: "show"; row: ListRow }
  | { kind: "add"; row: ListRow }
  /** `cursor`: where the preselection goes when the removed row leaves the visible list. */
  | { kind: "remove"; index: number; cursor: string | null }
  | { kind: "move"; from: number; to: number }
  | { kind: "update"; index: number; patch: { transpose: number } | { capo: number } };

function numberValue(current: number, command: NumberOp, range: { min: number; max: number; reset: number }): number {
  if (command.op === "set") return command.value;
  if (command.op === "reset") return range.reset;
  return Math.max(range.min, Math.min(range.max, current + command.step));
}

/**
 * What the command would do on the preselected row (before any preselection,
 * the shown song's row), or null when it has nothing to do: the options panel
 * is closed, the row is not in the visible list, the playlist cannot be edited
 * or the change would be empty. A follower view never gets here (its caller
 * checks), since it shows no lists.
 */
export function preselectionPlan(state: ClientViewState, command: PreselectionCommand): PreselectionPlan | null {
  if (!state.optionsOpen) return null;
  const rows = visibleListRows(state);
  const songId = state.hotkeySongId ?? state.display.songId;
  const position = rows.findIndex((entry) => entry.songId === songId);
  if (position < 0) return null;
  const row = rows[position];
  if (command.action === "preselected-song" && command.op === "show") return songId === state.display.songId ? null : { kind: "show", row };
  if (!state.capabilities.canEditWorkingPlaylist) return null;
  const index = state.playlist.findIndex((entry) => entry.songId === songId);
  if (command.action === "preselected-song" && command.op.startsWith("playlist-")) {
    const add = command.op === "playlist-toggle" ? index < 0 : command.op === "playlist-add";
    if (add) return index < 0 ? { kind: "add", row } : null;
    if (index < 0) return null;
    // In the playlist itself the removed row disappears: the cursor moves to its neighbour.
    const neighbour = state.listMode === "playlist" ? (rows[position + 1] ?? rows[position - 1] ?? null) : row;
    return { kind: "remove", index, cursor: neighbour?.songId ?? null };
  }
  // Moving, transposing and capo belong to the working playlist's own rows.
  if (state.listMode !== "playlist" || index < 0) return null;
  const entry = state.playlist[index];
  switch (command.action) {
    case "preselected-song": {
      const to = index + (command.op === "move-up" ? -1 : 1);
      return to >= 0 && to < state.playlist.length ? { kind: "move", from: index, to } : null;
    }
    case "preselected-transpose": {
      const transpose = numberValue(entry.transpose ?? 0, command, TRANSPOSE_RANGE);
      return transpose === (entry.transpose ?? 0) ? null : { kind: "update", index, patch: { transpose } };
    }
    case "preselected-capo": {
      const capo = numberValue(entry.capo ?? 0, command, CAPO_RANGE);
      return capo === (entry.capo ?? 0) ? null : { kind: "update", index, patch: { capo } };
    }
  }
}
