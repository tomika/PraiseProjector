import { useState, useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { Panel, PanelGroup } from "react-resizable-panels";
import UserPanel from "./UserPanel";
import PlaylistPanel, { PlaylistPanelMethods } from "./PlaylistPanel";
import SongListPanel, { SongListPanelMethods } from "./SongListPanel";
import ResizeHandle from "./ResizeHandle";
import { Database } from "../classes/Database";
import { Song } from "../classes/Song";
import { PlaylistEntry } from "../classes/PlaylistEntry";
import { Playlist } from "../classes/Playlist";
import { Settings } from "../types";
import { useLeader } from "../contexts/LeaderContext";
import { useMessageBox } from "../contexts/MessageBoxContext";
import { useLocalization } from "../localization/LocalizationContext";
import { PlaylistEntry as PlaylistEntryData, SongPreference as SongPreferenceData } from "../../common/pp-types";
import { updateCurrentDisplay } from "../state/CurrentSongStore";

// Methods exposed via ref
export interface LeftPanelMethods {
  // Playlist methods
  selectPlaylistSongById: (songId: string) => PlaylistEntry | null;
  getPreferencesForSongId: (songId: string) => SongPreferenceData | null;
  updatePlaylist: (playlist: PlaylistEntryData[]) => void;
  updatePlaylistItemPreferences: (songId: string, transpose?: number, capo?: number, instructions?: string) => void;
  getScheduleDate: () => Date | null;
  getCurrentPlaylist: () => Playlist;
  // Song tree methods
  getSelectedSongId: () => string | null;
  setSelectedSongId: (songId: string | null) => void;
}

interface LeftPanelProps {
  onPlaylistItemSelected?: (item: PlaylistEntry | null) => void;
  onSongSelected?: (song: Song | null) => void;
  selectedSong?: Song | null;
  disabled?: boolean; // Disables playlist editing when in watch mode
  remotePlaylist?: Playlist | null; // Remote playlist when watching another session
  onOpenLeaderSettings?: (leaderId: string | null) => void;
  onSyncClick?: () => void;
  onSettingsClick?: () => void;
  onExportDatabase?: () => void;
  onImportDatabase?: () => void;
  onReplaceDatabase?: () => void;
  onExternalFilesDropped?: (files: File[]) => void;
  // Named panel size props for persistence
  playlistPanelSize?: number;
  songListPanelSize?: number;
  onPlaylistPanelSizeChange?: (size: number) => void;
  onSongListPanelSizeChange?: (size: number) => void;
  // Song filter props for persistence
  songFilter?: string;
  onSongFilterChange?: (filter: string) => void;
  // Playlist selection props for persistence
  playlistSelectedIndex?: number;
  onPlaylistSelectedIndexChange?: (index: number) => void;
  // Song tree selection props for persistence
  selectedSongId?: string | null;
  onSelectedSongIdChange?: (songId: string | null) => void;
  // Playlist loaded callback for state restoration
  onPlaylistLoaded?: (itemCount: number) => void;
  settings?: Settings | null; // Settings to check before updating leader profile
}

const LeftPanel = forwardRef<LeftPanelMethods, LeftPanelProps>(
  (
    {
      onPlaylistItemSelected,
      onSongSelected,
      selectedSong: externalSelectedSong,
      disabled = false,
      remotePlaylist,
      onOpenLeaderSettings,
      onSyncClick,
      onSettingsClick,
      onExportDatabase,
      onImportDatabase,
      onReplaceDatabase,
      onExternalFilesDropped,
      playlistPanelSize,
      songListPanelSize,
      onPlaylistPanelSizeChange,
      onSongListPanelSizeChange,
      songFilter,
      onSongFilterChange,
      playlistSelectedIndex,
      onPlaylistSelectedIndexChange,
      onPlaylistLoaded,
      settings,
    },
    ref
  ) => {
    const [songs, setSongs] = useState<Song[]>([]);
    const [internalSelectedSong, setInternalSelectedSong] = useState<Song | null>(null);
    const { selectedLeader } = useLeader();
    const { showMessage } = useMessageBox();
    const { t } = useLocalization();
    const dbRef = useRef(Database.getInstance()); // Track current database for cleanup
    const playlistPanelRef = useRef<PlaylistPanelMethods | null>(null);
    const songListPanelRef = useRef<SongListPanelMethods | null>(null);

    // Expose methods via ref
    useImperativeHandle(
      ref,
      () => ({
        // Playlist methods
        selectPlaylistSongById: (songId: string) => playlistPanelRef.current?.selectSongById(songId) ?? null,
        getPreferencesForSongId: (songId: string) => playlistPanelRef.current?.getPreferencesForSongId(songId) ?? null,
        updatePlaylist: (playlist: PlaylistEntryData[]) => playlistPanelRef.current?.updatePlaylist(playlist),
        updatePlaylistItemPreferences: (songId: string, transpose?: number, capo?: number, instructions?: string) =>
          playlistPanelRef.current?.updatePlaylistItemPreferences(songId, transpose, capo, instructions),
        getScheduleDate: () => playlistPanelRef.current?.getScheduleDate() ?? null,
        getCurrentPlaylist: () => playlistPanelRef.current?.getCurrentPlaylist() ?? new Playlist("CurrentPlaylist", []),
        // Song tree methods
        getSelectedSongId: () => songListPanelRef.current?.getSelectedSongId() ?? null,
        setSelectedSongId: (songId: string | null) => songListPanelRef.current?.setSelectedSongId(songId),
      }),
      []
    );

    // Use external selected song if provided, otherwise use internal state
    const selectedSong = externalSelectedSong ?? internalSelectedSong;

    useEffect(() => {
      let isMounted = true;
      let dbCleanup: (() => void) | undefined;

      // Wait for database to be ready before subscribing and loading
      const initializeAndLoad = async () => {
        const db = await Database.waitForReady();

        if (!isMounted) return;

        // Update dbRef to current database
        dbRef.current = db;

        // Initial load
        const allSongs = db.getSongs();
        setSongs(allSongs);

        // Listen for database updates to refresh song list
        const handleDbUpdated = () => {
          if (isMounted) {
            const songs = db.getSongs();
            setSongs(songs);
          }
        };
        db.emitter.on("db-updated", handleDbUpdated);

        // Return cleanup function
        dbCleanup = () => {
          db.emitter.off("db-updated", handleDbUpdated);
        };
      };

      // Handler for database switch events (user login/logout)
      const handleDatabaseSwitched = () => {
        if (!isMounted) return;
        // Clean up old database subscription
        dbCleanup?.();
        // Reinitialize with new database
        initializeAndLoad();
      };

      // Listen for database switch events
      window.addEventListener("pp-database-switched", handleDatabaseSwitched);

      // Initial setup
      initializeAndLoad();

      return () => {
        isMounted = false;
        dbCleanup?.();
        window.removeEventListener("pp-database-switched", handleDatabaseSwitched);
      };
    }, []); // Empty dependency - we handle database changes via pp-database-switched event

    const handleSongSelected = (song: Song) => {
      // Don't update internal state immediately - let the parent decide via selectedSong prop
      // This allows the parent to show a confirmation dialog and cancel the selection if needed
      if (onSongSelected) {
        onSongSelected(song);
      }
    };

    // Handle playlist item selection - also select the corresponding song in the song tree
    const handlePlaylistItemSelected = (item: PlaylistEntry | null) => {
      if (onPlaylistItemSelected) {
        onPlaylistItemSelected(item);
      }

      // Select the corresponding song in the song tree (matching C# behavior)
      if (item) {
        const db = Database.getInstance();
        const song = db.getSongById(item.songId);
        if (song) {
          setInternalSelectedSong(song);
          updateCurrentDisplay({
            songId: song.Id,
            song: song.Text,
            system: song.System,
            from: 0,
            to: 0,
          });
          // Don't call onSongSelected here - we only want to update the visual selection
          // The song editing is handled separately by App.tsx through onPlaylistItemSelected
        }
      }
    };

    const handlePlaylistError = (errorType: "SaveFailed" | "LoadFailed", errorDetails: string) => {
      const messageKey = errorType === "SaveFailed" ? "FailedToSavePlaylist" : "FailedToLoadPlaylist";
      showMessage(t(errorType), t(messageKey).replace("{0}", errorDetails));
    };

    return (
      <div className="d-flex flex-column h-100">
        <UserPanel
          onOpenLeaderSettings={onOpenLeaderSettings}
          onSyncClick={onSyncClick}
          onSettingsClick={onSettingsClick}
          onExportDatabase={onExportDatabase}
          onImportDatabase={onImportDatabase}
          onReplaceDatabase={onReplaceDatabase}
        />
        <div className="flex-grow-1 mt-2">
          <PanelGroup
            direction="vertical"
            onLayout={(sizes) => {
              onPlaylistPanelSizeChange?.(sizes[0]);
              onSongListPanelSizeChange?.(sizes[1]);
            }}
          >
            <Panel defaultSize={playlistPanelSize ?? 60} minSize={30}>
              <PlaylistPanel
                ref={playlistPanelRef}
                songs={songs}
                onSongSelected={handleSongSelected}
                selectedSongFromList={selectedSong}
                onPlaylistItemSelected={handlePlaylistItemSelected}
                selectedLeader={selectedLeader}
                showMessage={handlePlaylistError}
                disabled={disabled}
                remotePlaylist={remotePlaylist}
                selectedIndex={playlistSelectedIndex}
                onSelectedIndexChange={onPlaylistSelectedIndexChange}
                onPlaylistLoaded={onPlaylistLoaded}
                settings={settings}
              />
            </Panel>
            <ResizeHandle />
            <Panel defaultSize={songListPanelSize ?? 40} minSize={20}>
              <SongListPanel
                ref={songListPanelRef}
                songs={songs}
                onSongSelected={handleSongSelected}
                onExternalFilesDropped={onExternalFilesDropped}
                selectedSong={selectedSong}
                filter={songFilter}
                onFilterChange={onSongFilterChange}
              />
            </Panel>
          </PanelGroup>
        </div>
      </div>
    );
  }
);

LeftPanel.displayName = "LeftPanel";

export default LeftPanel;
