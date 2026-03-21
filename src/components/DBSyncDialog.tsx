import React, { useState, useEffect, useCallback, useRef } from "react";
import { Song } from "../classes/Song";
import { Leader } from "../classes/Leader";
import { Database } from "../classes/Database";
import { useAuth } from "../contexts/AuthContext";
import { useMessageBox } from "../contexts/MessageBoxContext";
import { useLocalization } from "../localization/LocalizationContext";
import { cloudApi } from "../../common/cloudApi";
import CompareDialog, { convertHistoryEntryToSongWithHistory } from "./CompareDialog";
import LeaderDataMergeDialog from "./LeaderDataMergeDialog";
import "./DBSyncDialog.css";
import { ChordSystemCode } from "../../chordpro/chordpro_base";
import { SyncRequest, SyncResponse } from "../../common/pp-types";
import { useTooltips } from "../localization/TooltipContext";

enum SyncItemType {
  Song = "song",
  Leader = "leader",
}

enum SyncItemGroup {
  Pushed = "pushed",
  Pulled = "pulled",
  Conflict = "conflict",
  Denied = "denied",
  Checking = "checking",
}

interface SyncListItem {
  id: string;
  title: string;
  type: SyncItemType;
  group: SyncItemGroup;
  data: unknown; // Song, Leader, or conflict pair
}

// Feature flag: disable leader fetching in guest mode for now
const guestFetchingLeaders = false;

interface DBSyncDialogProps {
  database: Database;
  updateableLeaders?: Set<string>;
  onClose: () => void;
  onComplete?: () => void;
  autoStart?: boolean;
  cloudHostBasePath: string;
  clientId: string;
}

enum SyncState {
  Idle = "idle",
  Authenticating = "authenticating",
  Syncing = "syncing",
  Processing = "processing",
  Complete = "complete",
}

const DBSyncDialog: React.FC<DBSyncDialogProps> = ({
  database,
  updateableLeaders,
  onClose,
  onComplete,
  autoStart = false,
  cloudHostBasePath,
  clientId,
}) => {
  const { token, updateToken, markSessionExpired } = useAuth();
  const { showMessage, showConfirmAsync } = useMessageBox();
  const { t } = useLocalization();
  const { tt } = useTooltips();
  const [state, setState] = useState<SyncState>(SyncState.Idle);
  const [items, setItems] = useState<SyncListItem[]>([]);
  const [progress, setProgress] = useState({ current: 0, max: 100 });
  const [progressStyle, setProgressStyle] = useState<"marquee" | "blocks">("marquee");
  const loopCountRef = useRef(0);
  const [_uploadDenied, _setUploadDenied] = useState(false);

  // Store pending version - only apply when all conflicts resolved
  const [pendingVersion, setPendingVersion] = useState<number | null>(null);

  // Store initial database state for cancel/reload functionality
  const initialDatabaseStateRef = useRef<string | null>(null);

  // Flag to trigger conflict resolution completion side effects
  const [conflictsJustResolved, setConflictsJustResolved] = useState(false);

  // Track if we're in guest mode (unauthenticated public song fetch)
  // When guest mode conflicts are resolved, we should close the dialog instead of re-syncing
  const [isGuestMode, setIsGuestMode] = useState(false);

  // Dialog states for conflicts
  const [compareDialogItem, setCompareDialogItem] = useState<SyncListItem | null>(null);
  const [leaderMergeDialogItem, setLeaderMergeDialogItem] = useState<SyncListItem | null>(null);

  // State for locally updated songs decision dialog
  const [showUpdatedSongsDialog, setShowUpdatedSongsDialog] = useState(false);
  const [updatedSongsDecisions, setUpdatedSongsDecisions] = useState<Map<string, "upload" | "revert" | "skip">>(new Map());
  const [updatedSongsWithBackups, setUpdatedSongsWithBackups] = useState<Array<{ song: Song; backup: { version: number; song: Song } }>>([]);

  // State for locally updated leaders/profiles decision dialog
  const [updatedLeadersWithBackups, setUpdatedLeadersWithBackups] = useState<Array<{ leader: Leader; backup: { version: number; leader: Leader } }>>(
    []
  );
  const [updatedLeadersDecisions, setUpdatedLeadersDecisions] = useState<Map<string, "upload" | "revert" | "skip">>(new Map());

  // Compare dialog state for updated songs: supports backup and server comparisons
  const [updatedSongCompare, setUpdatedSongCompare] = useState<{
    localSong: Song;
    otherSong: Song;
    compareType: "backup" | "server";
  } | null>(null);

  // State for leader profile compare with backup or server
  const [updatedLeaderCompare, setUpdatedLeaderCompare] = useState<{
    leader: Leader;
    otherLeader: Leader;
    compareType: "backup" | "server";
  } | null>(null);

  // Cache fetched server versions to avoid re-downloading
  const serverSongCacheRef = useRef<Map<string, Song>>(new Map());

  // Cache fetched server leader versions to avoid re-downloading
  const serverLeaderCacheRef = useRef<Map<string, Leader>>(new Map());

  // In-memory merged leaders (not saved to DB until upload succeeds)
  const pendingMergedLeadersRef = useRef<Map<string, Leader>>(new Map());

  // Track songs to skip from upload (persist across sync calls)
  const skippedSongIdsRef = useRef<Set<string>>(new Set());

  // Track leaders to skip from upload (persist across sync calls)
  const skippedLeaderIdsRef = useRef<Set<string>>(new Set());

  // Track when decisions were confirmed to apply them on next syncDB call
  const decisionsReadyToApplyRef = useRef(false);

  // Track in-flight sync cancellation
  const syncAbortRef = useRef<AbortController | null>(null);
  const syncCancelledRef = useRef(false);
  const syncInProgressRef = useRef(false);

  // Collapsed groups state
  const [collapsedGroups, setCollapsedGroups] = useState<Set<SyncItemGroup>>(new Set());

  // Keep updateable leaders stable across renders
  const updateableLeadersRef = useRef<Set<string>>(updateableLeaders ?? new Set());
  const updateableLeadersSet = updateableLeadersRef.current;

  const toggleGroupCollapse = (group: SyncItemGroup) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };

  // Configure cloudApi with base URL and token
  useEffect(() => {
    cloudApi.setBaseUrl(cloudHostBasePath);
  }, [cloudHostBasePath]);

  useEffect(() => {
    cloudApi.setToken(token);
  }, [token]);

  const applyPendingVersion = useCallback((): boolean => {
    if (pendingVersion === null) return false;
    console.info("Sync", `All conflicts resolved. Applying pending version: ${pendingVersion}`);
    database.version = pendingVersion;
    database.forceSave();
    setPendingVersion(null);
    initialDatabaseStateRef.current = null;
    return true;
  }, [database, pendingVersion]);

  // Handle side effects when all conflicts are resolved
  useEffect(() => {
    if (!conflictsJustResolved) return;
    setConflictsJustResolved(false);

    // Apply pending version
    applyPendingVersion();

    // Continue based on mode
    if (isGuestMode) {
      // In guest mode (unauthenticated), just close the dialog
      setTimeout(() => {
        onComplete?.();
        onClose();
      }, 100);
    } else {
      // In authenticated mode, auto-start sync to upload changes
      setTimeout(() => handleSyncClick(true), 100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflictsJustResolved]);

  // Clear skipped songs/leaders and decisions on mount (fresh sync session)
  useEffect(() => {
    skippedSongIdsRef.current.clear();
    skippedLeaderIdsRef.current.clear();
    pendingMergedLeadersRef.current.clear();
    setUpdatedSongsDecisions(new Map());
    setUpdatedLeadersDecisions(new Map());
    decisionsReadyToApplyRef.current = false;
  }, []);

  // Fetch public songs without authentication (incremental update)
  // Now with conflict detection for local songs with version=0 (matching C# DBSyncForm)
  const fetchPublicSongs = async (): Promise<void> => {
    setState(SyncState.Syncing);
    setProgressStyle("marquee");
    setIsGuestMode(true); // Mark as guest mode for conflict resolution

    try {
      const result = await database.updateFromServer(undefined, guestFetchingLeaders, "select");
      const total = result.songsUpdated + result.leadersUpdated;
      const hasConflicts = result.songConflicts.length > 0 || result.leaderConflicts.length > 0;

      if (hasConflicts) {
        // Build conflict items list for UI
        const conflictItems: SyncListItem[] = [];

        for (const conflict of result.songConflicts) {
          conflictItems.push({
            id: conflict.serverSong.Id,
            title: conflict.serverSong.Title,
            type: SyncItemType.Song,
            group: SyncItemGroup.Conflict,
            data: { original: conflict.serverSong, current: conflict.localSong },
          });
        }

        for (const conflict of result.leaderConflicts) {
          conflictItems.push({
            id: conflict.serverLeader.id,
            title: conflict.serverLeader.name,
            type: SyncItemType.Leader,
            group: SyncItemGroup.Conflict,
            data: [conflict.localLeader, conflict.serverLeader],
          });
        }

        // Add pulled items info
        if (result.songsUpdated > 0) {
          conflictItems.unshift({
            id: "summary-songs",
            title: `${result.songsUpdated} song(s) downloaded`,
            type: SyncItemType.Song,
            group: SyncItemGroup.Pulled,
            data: null,
          });
        }
        if (result.leadersUpdated > 0) {
          conflictItems.unshift({
            id: "summary-leaders",
            title: `${result.leadersUpdated} leader(s) downloaded`,
            type: SyncItemType.Leader,
            group: SyncItemGroup.Pulled,
            data: null,
          });
        }

        setItems(conflictItems);
        setState(SyncState.Processing);
      } else if (total > 0) {
        const message = t("FetchedPublicSongs").replace("{songs}", String(result.songsUpdated)).replace("{leaders}", String(result.leadersUpdated));
        showMessage(t("SyncComplete"), message);
        onComplete?.();
        onClose();
      } else {
        showMessage(t("SyncComplete"), t("NoNewSongsAvailable"));
        onComplete?.();
        onClose();
      }
    } catch (error) {
      console.error("Sync", "Failed to fetch public songs", error);
      showMessage(t("SyncError"), t("FailedToFetchPublicSongs"));
      setState(SyncState.Idle);
    }
  };

  const syncDB = async (): Promise<boolean> => {
    if (loopCountRef.current >= 5) {
      showMessage(t("SyncLimitReached"), t("SyncCountLimitReached"));
      return false;
    }

    if (!token) {
      // Not logged in - guest sync was already confirmed before dialog opened
      // Start fetching public songs directly
      await fetchPublicSongs();
      return false;
    }

    // Check for locally updated songs with backups and let user decide
    const updatedSongs = database.getUpdatedSongs();
    const updatedLeadersLocal = database.getUpdatedLeaders();
    if ((updatedSongs.length > 0 || updatedLeadersLocal.length > 0) && !decisionsReadyToApplyRef.current) {
      const songsWithBackups = database.getUpdatedSongsWithBackups();
      const leadersWithBackups = database.getUpdatedLeadersWithBackups();

      // Filter out items that were already skipped in this sync session
      const songsToDecide = songsWithBackups.filter((item) => !skippedSongIdsRef.current.has(item.song.Id));
      const leadersToDecide = leadersWithBackups.filter((item) => !skippedLeaderIdsRef.current.has(item.leader.id));

      // Show dialog only if there are items to decide
      if (songsToDecide.length > 0 || leadersToDecide.length > 0) {
        // Show decision dialog for items with backups (excluding already skipped)
        setUpdatedSongsWithBackups(songsToDecide);
        setUpdatedLeadersWithBackups(leadersToDecide);
        // Default all decisions to 'upload'
        const defaultSongDecisions = new Map<string, "upload" | "revert" | "skip">();
        songsToDecide.forEach((item) => defaultSongDecisions.set(item.song.Id, "upload"));
        setUpdatedSongsDecisions(defaultSongDecisions);
        const defaultLeaderDecisions = new Map<string, "upload" | "revert" | "skip">();
        leadersToDecide.forEach((item) => defaultLeaderDecisions.set(item.leader.id, "upload"));
        setUpdatedLeadersDecisions(defaultLeaderDecisions);
        setShowUpdatedSongsDialog(true);
        setState(SyncState.Idle);
        return false;
      }
    }

    // Apply decisions if they were confirmed by user
    if (decisionsReadyToApplyRef.current) {
      decisionsReadyToApplyRef.current = false; // Reset flag

      // Apply song decisions
      if (updatedSongsDecisions.size > 0) {
        for (const [songId, decision] of updatedSongsDecisions.entries()) {
          if (decision === "revert") {
            database.revertSongFromBackup(songId);
          } else if (decision === "skip") {
            // Keep song marked as updated but don't upload - track it for filtering
            skippedSongIdsRef.current.add(songId);
          }
          // 'upload' decision means keep song as-is and upload it
        }
        // Clear decisions for next sync
        setUpdatedSongsDecisions(new Map());
      }

      // Apply leader decisions
      if (updatedLeadersDecisions.size > 0) {
        for (const [leaderId, decision] of updatedLeadersDecisions.entries()) {
          if (decision === "revert") {
            database.revertLeaderFromBackup(leaderId);
            pendingMergedLeadersRef.current.delete(leaderId);
          } else if (decision === "skip") {
            skippedLeaderIdsRef.current.add(leaderId);
            pendingMergedLeadersRef.current.delete(leaderId);
          } else if (decision === "upload") {
            // Apply pending merged leader to database if one exists
            const mergedLeader = pendingMergedLeadersRef.current.get(leaderId);
            if (mergedLeader) {
              database.updateLeader(mergedLeader);
              pendingMergedLeadersRef.current.delete(leaderId);
            }
          }
        }
        // Clear decisions for next sync
        setUpdatedLeadersDecisions(new Map());
      }
    }

    // Capture initial database state for potential rollback (only on first sync)
    if (initialDatabaseStateRef.current === null) {
      initialDatabaseStateRef.current = database.serializeForBackup();
    }

    loopCountRef.current += 1;
    setState(SyncState.Syncing);
    setProgressStyle("marquee");

    try {
      let uploadedSongs = database.getUpdatedSongs();
      let uploadedLeaders = database.getUpdatedLeaders();

      // Filter out songs that user chose to skip
      if (skippedSongIdsRef.current.size > 0) {
        uploadedSongs = uploadedSongs.filter((song) => !skippedSongIdsRef.current.has(song.Id));
      }

      // Filter out leaders that user chose to skip
      if (skippedLeaderIdsRef.current.size > 0) {
        uploadedLeaders = uploadedLeaders.filter((leader) => !skippedLeaderIdsRef.current.has(leader.id));
      }

      const request: SyncRequest = {
        version: database.version,
        clientId,
        songs: uploadedSongs.map((s) => s.ToUpdate()),
        profiles: uploadedLeaders.map((l) => l.toJSON()),
      };

      syncCancelledRef.current = false;
      syncAbortRef.current?.abort();
      const abortController = new AbortController();
      syncAbortRef.current = abortController;

      const response = await cloudApi.syncDatabase(request, { signal: abortController.signal });
      if (syncCancelledRef.current) {
        setState(SyncState.Idle);
        return false;
      }
      console.debug("Sync", "Got response", response);
      await processDBResponse(response, uploadedSongs, uploadedLeaders);
      return true;
    } catch (error: unknown) {
      console.error("Sync", "Sync error", error);
      const err = error as Error;
      if (err.message.includes("aborted")) {
        setState(SyncState.Idle);
        return false;
      }
      if (err.message.includes("401")) {
        markSessionExpired();
        showMessage(t("AuthenticationFailed"), t("PleaseLoginAgain"));
        onClose();
        return false;
      }

      // Don't recursively retry - let the user retry manually
      showMessage(t("SyncError"), `${t("Error")}: ${err.message}`);
      setState(SyncState.Idle);
      return false;
    }
  };

  const processDBResponse = async (response: SyncResponse, uploadedSongs?: Song[], uploadedLeaders?: Leader[]) => {
    console.debug(
      "Sync",
      `Processing response with version: ${response.version}, songs: ${response.songs.length}, leaders: ${response.leaders.length}`
    );
    setState(SyncState.Processing);
    setProgressStyle("blocks");

    const responseSongs = Array.isArray(response.songs) ? response.songs : [];
    const responseLeaders = Array.isArray(response.leaders) ? response.leaders : [];
    if (!Array.isArray(response.songs) || !Array.isArray(response.leaders)) {
      console.warn("Sync", "Unexpected sync payload shape", {
        songsType: typeof response.songs,
        leadersType: typeof response.leaders,
      });
    }

    // Disable auto-save during bulk processing (like C# does)
    database.autoSave = false;

    try {
      const newItems: SyncListItem[] = [];
      _setUploadDenied(!response.upload_enabled);

      // Process downloaded songs
      for (const s of responseSongs) {
        const songdata = "songdata" in s ? s.songdata : undefined;
        if (s.version == null) {
          if (!songdata) {
            // Deleted on server
            database.removeSong(s.songId);
          }
          continue;
        }

        if (s.version <= 0) {
          database.removeSong(s.songId);
          continue;
        }

        if (!songdata) {
          // Just version update (no song data provided)
          const song = database.getSong(s.songId);
          if (song) {
            song.version = s.version;
            database.setSong(song);
          }
          continue;
        }

        const song = new Song(songdata.text, songdata.system as ChordSystemCode);
        song.Id = s.songId;
        song.version = s.version;
        if ("groupId" in s && s.groupId != null) song.GroupId = s.groupId;

        const existing = database.getSong(s.songId);

        if (existing && existing.version === 0) {
          if (existing.Text === song.Text && existing.Title === song.Title) {
            // Exact match - safe to overwrite
            database.setSong(song);
          } else {
            // Conflict - clone local version BEFORE overwriting
            // Use clone() to preserve original local data for conflict resolution
            const localClone = existing.clone();
            newItems.push({
              id: s.songId,
              title: song.Title,
              type: SyncItemType.Song,
              group: SyncItemGroup.Conflict,
              data: { original: song, current: localClone },
            });
            // Do NOT save server version yet - wait for conflict resolution
          }
        } else {
          /*          
          const similar = database.findSimilarSongs(song, false).filter((x) => x.Id !== s.songId);
          if (similar.length > 0) {
            newItems.push({
              id: s.songId,
              title: song.Title,
              type: SyncItemType.Song,
              group: SyncItemGroup.Checking,
              data: { song, similar },
            });
            // Save song for checking group (no conflict)
            database.setSong(song);
          } else */ {
            newItems.push({
              id: s.songId,
              title: song.Title,
              type: SyncItemType.Song,
              group: SyncItemGroup.Pulled,
              data: song,
            });
            // Save pulled song
            database.setSong(song);
          }
        }
      }

      // Process downloaded leaders
      for (const l of responseLeaders) {
        if (l.updateable) {
          updateableLeadersSet.add(l.leaderId);
        } else {
          updateableLeadersSet.delete(l.leaderId);
        }

        if (l.version == null) {
          continue;
        }

        if (l.version <= 0) {
          // Remove or migrate leader (matching C# fallback logic)
          let leader = database.getLeaderById(l.leaderId);
          if (!leader) {
            // Fallback: find by name for name-based ID migration
            leader = database.getLeaderByName(l.leaderName);
          }
          if (leader && leader.id === leader.name) {
            const clone = leader.cloneWithId(l.leaderId);
            database.removeLeader(leader.id);
            database.updateLeader(clone);
          }
          continue;
        }

        if (l.preferences === null || l.playlists === null || !Array.isArray(l.preferences) || !Array.isArray(l.playlists)) {
          // Just version update - no full data was sent (C# requires BOTH to be non-null arrays)
          const leader = database.getLeaderById(l.leaderId);
          if (leader) {
            leader.version = l.version;
            database.updateLeader(leader);
          }
          continue;
        }

        // Create new leader with full data from sync (both playlists and preferences are non-null)
        const leader = new Leader(l.leaderId, l.leaderName, 0); // Start with version 0, set after loading data

        // Deserialize playlists
        for (const pl of l.playlists) {
          leader.addSyncedPlaylist(pl);
        }

        // Deserialize preferences
        for (const pref of l.preferences) {
          leader.storeSyncedPreference(pref, database);
        }

        // Restore version after updates (like C# does)
        leader.version = l.version;

        const existing = database.getLeaderById(l.leaderId);
        if (
          !existing ||
          (existing.version > 0 && existing.version <= leader.version) ||
          existing.equals(leader) ||
          !updateableLeadersSet.has(l.leaderId)
        ) {
          newItems.push({
            id: l.leaderId,
            title: l.leaderName,
            type: SyncItemType.Leader,
            group: SyncItemGroup.Pulled,
            data: leader,
          });
          // Save pulled leader (no conflict)
          database.updateLeader(leader);
        } else {
          // Conflict - clone local version BEFORE any changes
          const localClone = existing.clone();
          newItems.push({
            id: l.leaderId,
            title: l.leaderName,
            type: SyncItemType.Leader,
            group: SyncItemGroup.Conflict,
            data: { local: localClone, remote: leader },
          });
          // Do NOT save server version yet - wait for conflict resolution
        }
      }

      // Remove local leaders not present in server response (matching C# leadersToDrop logic)
      const leadersToKeep = new Set(responseLeaders.map((l) => l.leaderId));
      const leadersToDrop: string[] = [];
      for (const localLeader of database.getAllLeaders()) {
        if (!leadersToKeep.has(localLeader.id)) {
          leadersToDrop.push(localLeader.id);
        }
      }
      for (const leaderId of leadersToDrop) {
        database.removeLeader(leaderId);
      }

      // Build sets of version-updated and conflicting IDs for Pushed/Denied classification
      const updatedSongIds = new Set<string>();
      const updatedLeaderIds = new Set<string>();
      const conflictingIds = new Set(newItems.filter((i) => i.group === SyncItemGroup.Conflict).map((i) => i.id));

      for (const s of responseSongs) {
        if (s.version != null && s.version > 0) {
          const songdata = "songdata" in s ? s.songdata : undefined;
          if (!songdata) updatedSongIds.add(s.songId);
        }
      }
      for (const l of responseLeaders) {
        if (
          l.version != null &&
          l.version > 0 &&
          (l.preferences === null || l.playlists === null || !Array.isArray(l.preferences) || !Array.isArray(l.playlists))
        ) {
          updatedLeaderIds.add(l.leaderId);
        }
      }

      // Process uploaded songs: classify as Pushed or Denied (matching C# logic)
      if (uploadedSongs) {
        for (const song of uploadedSongs) {
          if (updatedSongIds.has(song.Id)) {
            // Server accepted and assigned a new version
            const serverEntry = responseSongs.find((s) => s.songId === song.Id);
            if (serverEntry?.version != null) {
              song.version = serverEntry.version;
              database.setSong(song);
            }
            // Clear backup since song was successfully uploaded
            database.clearSongBackup(song.Id);
            newItems.push({
              id: `pushed-${song.Id}`,
              title: song.Title,
              type: SyncItemType.Song,
              group: SyncItemGroup.Pushed,
              data: song,
            });
          } else if (!conflictingIds.has(song.Id)) {
            const s = database.getSong(song.Id);
            if (s && s.version === 0) {
              newItems.push({
                id: `denied-${song.Id}`,
                title: song.Title,
                type: SyncItemType.Song,
                group: SyncItemGroup.Denied,
                data: song,
              });
            }
          }
        }
      }

      // Process uploaded leaders: classify as Pushed or Denied (matching C# logic)
      if (uploadedLeaders) {
        for (const leader of uploadedLeaders) {
          if (updatedLeaderIds.has(leader.id)) {
            // Server accepted and assigned a new version
            const serverEntry = responseLeaders.find((l) => l.leaderId === leader.id);
            if (serverEntry?.version != null) {
              leader.version = serverEntry.version;
              database.updateLeader(leader);
            }
            // Clear profile backup since leader was successfully uploaded
            database.clearProfileBackup(leader.id);
            newItems.push({
              id: `pushed-${leader.id}`,
              title: leader.name,
              type: SyncItemType.Leader,
              group: SyncItemGroup.Pushed,
              data: leader,
            });
          } else if (!conflictingIds.has(leader.id)) {
            const l = database.getLeaderById(leader.id);
            if (l && l.version === 0) {
              newItems.push({
                id: `denied-${leader.id}`,
                title: leader.name,
                type: SyncItemType.Leader,
                group: SyncItemGroup.Denied,
                data: leader,
              });
            }
          }
        }
      }

      // Check if there are any conflicts - if so, delay version update
      const hasConflicts = newItems.some((item) => item.group === SyncItemGroup.Conflict);

      if (hasConflicts) {
        // Store pending version - will be applied when all conflicts are resolved
        console.info("Sync", `Conflicts found. Storing pending version: ${response.version} (current: ${database.version})`);
        setPendingVersion(response.version);
        database.forceSave(); // Save non-conflicting items
      } else {
        // No conflicts - safe to update version immediately
        console.info("Sync", `No conflicts. Updating database version from ${database.version} to ${response.version}`);
        database.version = response.version;
        database.forceSave();
        // Clear any pending version and initial state
        setPendingVersion(null);
        initialDatabaseStateRef.current = null;
      }

      // Save refreshed token from sync response (matching C# token persistence)
      if (response.token) {
        updateToken(response.token);
      }

      setItems(newItems);
      openDetails(newItems);
    } finally {
      // Re-enable auto-save
      database.autoSave = true;
    }
  };

  const openDetails = (newItems: SyncListItem[]) => {
    setProgressStyle("blocks");
    setProgress({ current: 100, max: 100 });

    // Check if there are any items to show (excluding denied items which are just informational)
    const hasTodo = newItems.some((item) => item.group !== SyncItemGroup.Denied);

    if (newItems.length === 0) {
      // No items at all - sync was successful with nothing to report
      console.debug("Sync", "No sync items to display, closing dialog");
      setState(SyncState.Complete);
      onComplete?.();
      onClose();
    } else if (!hasTodo) {
      // Only denied items - show them but allow closing
      console.debug("Sync", "Only denied items, showing close button");
      setState(SyncState.Complete);
    } else {
      // Has actionable items (conflicts, pushed, pulled)
      setState(SyncState.Complete);
    }
  };

  const handleSyncClick = async (skipConflictCheck = false) => {
    if (syncInProgressRef.current) {
      return;
    }
    syncInProgressRef.current = true;

    if (!skipConflictCheck) {
      const conflicts = items.filter((item) => item.group === SyncItemGroup.Conflict);
      if (conflicts.length > 0) {
        const choice = await showConfirmAsync(t("SyncConflicts"), t("AskKeepLocalOrResolve"), {
          confirmText: t("KeepLocalVersions"),
          confirmDanger: true,
        });
        if (choice) {
          applyPendingVersion();
          // Keep local versions
          setItems((prev) => prev.filter((item) => item.group !== SyncItemGroup.Conflict));
        } else {
          syncInProgressRef.current = false;
          return;
        }
      }
    }

    setItems([]);
    loopCountRef.current = 0;
    try {
      await syncDB();
    } finally {
      syncInProgressRef.current = false;
    }
  };

  // Stable ref so the auto-start effect doesn't re-fire on every render.
  const handleSyncClickRef = useRef(handleSyncClick);
  handleSyncClickRef.current = handleSyncClick;

  // Auto-start: use setTimeout so StrictMode cleanup can cancel the timer
  // before it fires, preventing the double-sync problem.
  useEffect(() => {
    if (!autoStart) return;
    const timer = setTimeout(() => {
      handleSyncClickRef.current();
    }, 0);
    return () => {
      clearTimeout(timer);
      syncAbortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStop = () => {
    syncCancelledRef.current = true;
    syncAbortRef.current?.abort();
    setState(SyncState.Idle);
  };

  const handleItemDoubleClick = (item: SyncListItem) => {
    if (item.type === SyncItemType.Song) {
      if (item.group === SyncItemGroup.Conflict) {
        // Song conflict - open CompareDialog in Conflict mode
        setCompareDialogItem(item);
      } else if (item.group === SyncItemGroup.Checking) {
        // Songs to check - open CompareDialog in ViewOnly mode
        setCompareDialogItem(item);
      }
    } else if (item.type === SyncItemType.Leader) {
      if (item.group === SyncItemGroup.Conflict) {
        // Leader conflict - open LeaderDataMergeDialog
        setLeaderMergeDialogItem(item);
      }
    }
  };

  // Remove an item from the list and check if we should auto-sync or close
  const removeItemAndCheckSync = useCallback((itemId: string) => {
    setItems((prevItems) => {
      const newItems = prevItems.filter((i) => i.id !== itemId);
      // Check if all conflicts are resolved
      const remainingConflicts = newItems.filter((i) => i.group === SyncItemGroup.Conflict || i.group === SyncItemGroup.Checking);
      if (remainingConflicts.length === 0) {
        // Signal that conflicts are resolved - side effects handled by useEffect
        setConflictsJustResolved(true);
      }
      return newItems;
    });
  }, []);

  // Resolve all conflicts by keeping local versions (discard server changes)
  const handleKeepAllLocal = useCallback(() => {
    // For conflicts, keeping local means we don't need to do anything - local version stays
    // Just remove the conflict items from the list
    const newItems = items.filter((item) => item.group !== SyncItemGroup.Conflict);
    setItems(newItems);

    // Check if we should close or continue
    const remainingConflicts = newItems.filter((i) => i.group === SyncItemGroup.Conflict || i.group === SyncItemGroup.Checking);
    if (remainingConflicts.length === 0) {
      // Signal that conflicts are resolved - side effects handled by useEffect
      setConflictsJustResolved(true);
    }
  }, [items]);

  // Resolve all conflicts by overwriting with server versions
  const handleOverwriteAllWithServer = useCallback(() => {
    const conflictItems = items.filter((item) => item.group === SyncItemGroup.Conflict);

    for (const item of conflictItems) {
      if (item.type === SyncItemType.Song) {
        const data = item.data as { original: Song; current: Song };
        // Use server version (original is server, current is local)
        database.setSong(data.original);
      } else if (item.type === SyncItemType.Leader) {
        const data = item.data as { local: Leader; remote: Leader };
        // Use server (remote) version
        database.updateLeader(data.remote);
      }
    }

    // Remove all conflict items from the list
    const newItems = items.filter((item) => item.group !== SyncItemGroup.Conflict);
    setItems(newItems);

    // Check if we should close or continue
    const remainingConflicts = newItems.filter((i) => i.group === SyncItemGroup.Conflict || i.group === SyncItemGroup.Checking);
    if (remainingConflicts.length === 0) {
      // Signal that conflicts are resolved - side effects handled by useEffect
      setConflictsJustResolved(true);
    }
  }, [items, database]);

  // Check if there are any conflicts that can be bulk-resolved
  const hasConflicts = items.some((item) => item.group === SyncItemGroup.Conflict);

  // Handle compare dialog result for song conflicts
  const handleCompareDialogClose = useCallback(
    (mergedSong?: Song) => {
      const item = compareDialogItem;
      setCompareDialogItem(null);

      if (!item || !mergedSong) return;

      if (item.group === SyncItemGroup.Conflict) {
        // User resolved the conflict
        const data = item.data as { original: Song; current: Song };
        mergedSong.Id = data.original.Id;
        if (data.current.Text !== mergedSong.Text) {
          database.setSong(mergedSong);
        }
        removeItemAndCheckSync(item.id);
      }
      // For Checking group, just close - no action needed
    },
    [compareDialogItem, database, removeItemAndCheckSync]
  );

  // Handle leader merge dialog result
  const handleLeaderMergeDialogSave = useCallback(
    (mergedLeader: Leader) => {
      const item = leaderMergeDialogItem;
      setLeaderMergeDialogItem(null);

      if (!item) return;

      database.updateLeader(mergedLeader);
      removeItemAndCheckSync(item.id);
    },
    [leaderMergeDialogItem, database, removeItemAndCheckSync]
  );

  const handleLeaderMergeDialogCancel = useCallback(() => {
    setLeaderMergeDialogItem(null);
  }, []);

  // Handle updated songs/leaders decision dialog
  const handleUpdatedSongDecision = useCallback((songId: string, decision: "upload" | "revert" | "skip") => {
    setUpdatedSongsDecisions((prev) => {
      const next = new Map(prev);
      next.set(songId, decision);
      return next;
    });
  }, []);

  const handleUpdatedLeaderDecision = useCallback((leaderId: string, decision: "upload" | "revert" | "skip") => {
    setUpdatedLeadersDecisions((prev) => {
      const next = new Map(prev);
      next.set(leaderId, decision);
      return next;
    });
    // Clear pending merge if user manually changes to revert/skip
    if (decision === "revert" || decision === "skip") {
      pendingMergedLeadersRef.current.delete(leaderId);
    }
  }, []);

  // Compare leader profile with backup: local (current) vs backup (original)
  const handleCompareLeaderWithBackup = useCallback((leader: Leader, backupLeader: Leader) => {
    // Use pending merged version as "local" if one exists from a previous merge
    const effectiveLocal = pendingMergedLeadersRef.current.get(leader.id) || leader;
    setUpdatedLeaderCompare({ leader: effectiveLocal, otherLeader: backupLeader, compareType: "backup" });
  }, []);

  // Compare leader profile with server version
  const handleCompareLeaderWithServer = useCallback(
    async (leader: Leader) => {
      // Check cache first
      const cached = serverLeaderCacheRef.current.get(leader.id);
      if (cached) {
        const effectiveLocal = pendingMergedLeadersRef.current.get(leader.id) || leader;
        setUpdatedLeaderCompare({ leader: effectiveLocal, otherLeader: cached, compareType: "server" });
        return;
      }

      try {
        const profiles = await cloudApi.fetchLeaders(0);
        const profile = profiles.find((p) => p.leaderId === leader.id);
        if (profile) {
          const serverLeader = database.createLeaderFromProfile(profile);
          serverLeaderCacheRef.current.set(leader.id, serverLeader);
          const effectiveLocal = pendingMergedLeadersRef.current.get(leader.id) || leader;
          setUpdatedLeaderCompare({ leader: effectiveLocal, otherLeader: serverLeader, compareType: "server" });
        } else {
          showMessage(t("Message"), t("NoServerVersionFound"));
        }
      } catch (error) {
        console.error("Sync", "Failed to fetch server leader version", error);
        showMessage(t("Error"), t("FailedToFetchServerVersion"));
      }
    },
    [database, showMessage, t]
  );

  // Handle leader compare dialog save: keep merged in-memory only, auto-select decision
  const handleUpdatedLeaderCompareClose = useCallback(
    (mergedLeader?: Leader) => {
      if (mergedLeader && updatedLeaderCompare) {
        const { leader, otherLeader, compareType } = updatedLeaderCompare;
        const leaderId = leader.id;
        const mergedClone = mergedLeader.clone();
        mergedClone.version = 0;

        if (compareType === "backup") {
          // Comparing with backup: if merged equals backup → revert
          const backupLeader = otherLeader;
          if (mergedClone.equals(backupLeader)) {
            handleUpdatedLeaderDecision(leaderId, "revert");
            pendingMergedLeadersRef.current.delete(leaderId);
          } else {
            // Merged differs from backup → upload the merged version
            pendingMergedLeadersRef.current.set(leaderId, mergedClone);
            handleUpdatedLeaderDecision(leaderId, "upload");
          }
        } else {
          // Comparing with server: if merged equals server → no need to upload
          // (server already has this version, higher version will be downloaded during sync)
          const serverLeader = otherLeader;
          if (mergedClone.equals(serverLeader)) {
            // User chose server version → revert local changes, server version will be downloaded
            handleUpdatedLeaderDecision(leaderId, "revert");
            pendingMergedLeadersRef.current.delete(leaderId);
          } else {
            // Merged differs from server → upload the merged version
            pendingMergedLeadersRef.current.set(leaderId, mergedClone);
            handleUpdatedLeaderDecision(leaderId, "upload");
          }
        }
      }
      setUpdatedLeaderCompare(null);
    },
    [updatedLeaderCompare, handleUpdatedLeaderDecision]
  );

  // Compare with backup: left=backup, right=local updated
  const handleCompareWithBackup = useCallback((song: Song, backupSong: Song) => {
    setUpdatedSongCompare({ localSong: song, otherSong: backupSong, compareType: "backup" });
  }, []);

  // Compare with server: fetch server version then show dialog
  const handleCompareWithServer = useCallback(
    async (song: Song) => {
      // Check cache first
      const cached = serverSongCacheRef.current.get(song.Id);
      if (cached) {
        setUpdatedSongCompare({ localSong: song, otherSong: cached, compareType: "server" });
        return;
      }

      try {
        const historyEntries = await cloudApi.fetchSongHistory(song.Id);
        if (historyEntries.length > 0) {
          const serverSong = convertHistoryEntryToSongWithHistory(historyEntries[0]);
          serverSongCacheRef.current.set(song.Id, serverSong);
          setUpdatedSongCompare({ localSong: song, otherSong: serverSong, compareType: "server" });
        } else {
          showMessage(t("Message"), t("NoServerVersionFound"));
        }
      } catch (error) {
        console.error("Sync", "Failed to fetch server song version", error);
        showMessage(t("Error"), t("FailedToFetchServerVersion"));
      }
    },
    [showMessage, t]
  );

  // Handle compare dialog close: if user selected a version, update decision
  const handleUpdatedSongCompareClose = useCallback(
    (songId: string, compareType: "backup" | "server", mergedSong?: Song) => {
      if (mergedSong && updatedSongCompare) {
        const localText = updatedSongCompare.localSong.Text;
        const otherText = updatedSongCompare.otherSong.Text;
        const selectedText = mergedSong.Text;

        if (compareType === "backup") {
          // Left=backup, Right=local. If user picked left (backup) → revert, if right (local) → upload
          if (selectedText === otherText) {
            // User selected backup version → revert
            handleUpdatedSongDecision(songId, "revert");
          } else if (selectedText === localText) {
            // User selected local version → upload
            handleUpdatedSongDecision(songId, "upload");
          }
        } else {
          // Left=local, Right=server. If user picked left (local) → upload, if right (server) → revert
          if (selectedText === localText) {
            // User selected local version → upload
            handleUpdatedSongDecision(songId, "upload");
          } else if (selectedText === otherText) {
            // User selected server version → revert
            handleUpdatedSongDecision(songId, "revert");
          }
        }
      }
      setUpdatedSongCompare(null);
    },
    [updatedSongCompare, handleUpdatedSongDecision]
  );

  const handleConfirmUpdatedSongsDecisions = useCallback(() => {
    setShowUpdatedSongsDialog(false);
    // Continue with sync - all default to 'upload' if not explicitly changed
    decisionsReadyToApplyRef.current = true;
    handleSyncClick();
  }, [handleSyncClick]);

  const handleCancelUpdatedSongsDialog = useCallback(() => {
    setShowUpdatedSongsDialog(false);
    setUpdatedSongsDecisions(new Map());
    setUpdatedLeadersDecisions(new Map());
    pendingMergedLeadersRef.current.clear();
    decisionsReadyToApplyRef.current = false;
    onClose();
  }, [onClose]);

  // Determine if an item is interactive (can be clicked to resolve)
  const isInteractiveItem = (item: SyncListItem): boolean => {
    return item.group === SyncItemGroup.Conflict || item.group === SyncItemGroup.Checking;
  };

  const renderGroups = () => {
    const groups = [
      { key: SyncItemGroup.Conflict, title: t("SyncConflictGroup"), isConflict: true },
      { key: SyncItemGroup.Checking, title: t("SyncCheckingGroup"), isConflict: false },
      { key: SyncItemGroup.Pushed, title: t("SyncPushedGroup"), isConflict: false },
      { key: SyncItemGroup.Pulled, title: t("SyncPulledGroup"), isConflict: false },
      { key: SyncItemGroup.Denied, title: t("SyncDeniedGroup"), isConflict: false },
    ];

    return groups.map((group) => {
      const groupItems = items.filter((item) => item.group === group.key);
      if (groupItems.length === 0) return null;

      const isCollapsed = collapsedGroups.has(group.key);

      return (
        <div key={group.key} className="sync-group">
          <h6 className={`sync-group-header ${group.isConflict ? "sync-group-conflict" : ""}`} onClick={() => toggleGroupCollapse(group.key)}>
            <span className="sync-group-collapse-icon">{isCollapsed ? "▶" : "▼"}</span>
            {group.title}
            <span className="sync-group-count">({groupItems.length})</span>
          </h6>
          {!isCollapsed && (
            <div className="sync-group-items">
              {groupItems.map((item) => {
                const interactive = isInteractiveItem(item);
                return (
                  <div
                    key={item.id}
                    className={`sync-item ${interactive ? "sync-item-interactive" : ""}`}
                    onDoubleClick={() => handleItemDoubleClick(item)}
                    title={interactive ? tt("dbsync_dblclk_resolve") : undefined}
                  >
                    <div className="sync-item-icon">{item.type === SyncItemType.Song ? "🎵" : "👤"}</div>
                    <div className="sync-item-title">{item.title}</div>
                    {interactive && (
                      <button
                        className="btn btn-sm btn-outline-primary sync-item-resolve-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleItemDoubleClick(item);
                        }}
                        title="Resolve"
                      >
                        ⋯
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    });
  };

  const showSync = state === SyncState.Idle && items.length === 0;
  const showStop = state === SyncState.Syncing;
  // Only show close when sync is complete AND no conflicts/checking items remain
  // This matches C# behavior: user must resolve all conflicts before closing
  const hasPendingItems = items.some((item) => item.group === SyncItemGroup.Conflict || item.group === SyncItemGroup.Checking);
  const showClose =
    (state === SyncState.Complete && !hasPendingItems) ||
    (state === SyncState.Idle && items.length > 0 && items.every((item) => item.group === SyncItemGroup.Denied));

  // Show cancel button when there are pending conflicts and we have a backup to restore
  const showCancelSync = hasPendingItems && initialDatabaseStateRef.current !== null && state === SyncState.Complete;

  // Handle cancel sync - restore original database state
  const handleCancelSync = async () => {
    const confirmed = await showConfirmAsync(t("CancelSync"), t("CancelSyncConfirm"), { confirmText: t("DiscardAndRestore"), confirmDanger: true });

    if (confirmed && initialDatabaseStateRef.current) {
      database.restoreFromBackup(initialDatabaseStateRef.current);
      database.forceSave();
      initialDatabaseStateRef.current = null;
      setPendingVersion(null);
      setItems([]);
      onClose();
    }
  };

  // Prepare props for CompareDialog
  const getCompareDialogProps = () => {
    if (!compareDialogItem) return null;

    if (compareDialogItem.group === SyncItemGroup.Conflict) {
      const data = compareDialogItem.data as { original: Song; current: Song };
      return {
        originalSong: data.current, // Local modified version
        songsToCompare: [data.original], // Server version
        mode: "Conflict" as const,
      };
    } else if (compareDialogItem.group === SyncItemGroup.Checking) {
      const data = compareDialogItem.data as { song: Song; similar: Song[] };
      return {
        originalSong: data.song, // Downloaded song
        songsToCompare: data.similar, // Similar songs in database
        mode: "ViewOnly" as const,
      };
    }
    return null;
  };

  // Prepare props for LeaderDataMergeDialog
  const getLeaderMergeDialogProps = () => {
    if (!leaderMergeDialogItem) return null;

    const data = leaderMergeDialogItem.data as { local: Leader; remote: Leader };
    return {
      localLeader: data.local,
      remoteLeader: data.remote,
    };
  };

  const compareDialogProps = getCompareDialogProps();
  const leaderMergeProps = getLeaderMergeDialogProps();

  return (
    <>
      <div className="modal-backdrop show dbsync-dialog-backdrop">
        <div className="modal d-block">
          <div className="modal-dialog modal-lg" onClick={(e) => e.stopPropagation()}>
            <div className="modal-content">
              <div className="modal-header">
                <h5 className="modal-title">{t("SyncFormTitle") || "Synchronize Database"}</h5>
              </div>
              <div className="modal-body">
                <div className="sync-controls">
                  {state === SyncState.Syncing && (
                    <div className="progress mb-3">
                      <div
                        className={`progress-bar progress-bar-dynamic ${progressStyle === "marquee" ? "progress-bar-striped progress-bar-animated progress-bar-width-full" : ""}`}
                        {...{
                          style: {
                            "--progress-width": progressStyle === "marquee" ? "100%" : `${(progress.current / progress.max) * 100}%`,
                          } as React.CSSProperties,
                        }}
                      />
                    </div>
                  )}
                  <div className="sync-buttons">
                    {showSync && (
                      <button className="btn btn-primary" onClick={() => handleSyncClick()}>
                        {t("Synchronize")}
                      </button>
                    )}
                    {showStop && (
                      <button className="btn btn-secondary" onClick={handleStop}>
                        {t("Cancel")}
                      </button>
                    )}
                    {showClose && (
                      <button
                        className="btn btn-secondary"
                        onClick={() => {
                          onComplete?.();
                          onClose();
                        }}
                      >
                        {t("Close")}
                      </button>
                    )}
                  </div>
                </div>
                {items.length > 0 && <div className="sync-list">{renderGroups()}</div>}
                {/* Bulk conflict resolution buttons at bottom */}
                {hasConflicts && state === SyncState.Complete && (
                  <div className="sync-bulk-buttons mt-3">
                    <button className="btn btn-outline-secondary" onClick={handleKeepAllLocal}>
                      {t("KeepAllLocal") || "Keep All Local"}
                    </button>
                    <button className="btn btn-outline-secondary" onClick={handleOverwriteAllWithServer}>
                      {t("OverwriteAllWithServer") || "Use All Server Versions"}
                    </button>
                    {showCancelSync && (
                      <button className="btn btn-outline-danger" onClick={handleCancelSync}>
                        {t("CancelSync") || "Cancel Sync"}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Compare Dialog for song conflicts/checking */}
      {compareDialogProps && (
        <CompareDialog
          originalSong={compareDialogProps.originalSong}
          songsToCompare={compareDialogProps.songsToCompare}
          mode={compareDialogProps.mode}
          onClose={handleCompareDialogClose}
        />
      )}

      {/* Leader Merge Dialog for profile conflicts */}
      {leaderMergeProps && (
        <LeaderDataMergeDialog
          localLeader={leaderMergeProps.localLeader}
          remoteLeader={leaderMergeProps.remoteLeader}
          onSave={handleLeaderMergeDialogSave}
          onCancel={handleLeaderMergeDialogCancel}
        />
      )}

      {/* Updated Songs & Profiles Decision Dialog */}
      {showUpdatedSongsDialog && (
        <div className="modal-backdrop show dbsync-dialog-backdrop">
          <div className="modal d-block">
            <div className="modal-dialog modal-xl" onClick={(e) => e.stopPropagation()}>
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">{t("LocallyUpdatedItems") || "Locally Updated Items"}</h5>
                  <button type="button" className="btn-close" aria-label="Close" onClick={handleCancelUpdatedSongsDialog}></button>
                </div>
                <div className="modal-body">
                  <p>{t("DecideUpdatedItemsMessage") || "You have locally modified items. Please decide what to do with each:"}</p>
                  {updatedSongsWithBackups.length > 0 && (
                    <>
                      <h6>{t("LocallyUpdatedSongs") || "Songs"}</h6>
                      <div className="updated-songs-list">
                        {updatedSongsWithBackups.map(({ song, backup }) => {
                          const decision = updatedSongsDecisions.get(song.Id) || "upload";
                          return (
                            <div key={song.Id} className="updated-song-item" data-decision={decision}>
                              <div className="updated-song-header">
                                <div className="updated-song-title">{song.Title}</div>
                                <div className="updated-song-version">
                                  {t("OriginalVersion") || "Original version"}: {backup.version}
                                </div>
                              </div>
                              <div className="updated-song-actions">
                                <select
                                  className="form-select form-select-sm updated-song-select"
                                  aria-label="Song action"
                                  value={decision}
                                  onChange={(e) => handleUpdatedSongDecision(song.Id, e.target.value as "upload" | "revert" | "skip")}
                                >
                                  <option value="upload">{t("UploadChanges") || "Upload Changes"}</option>
                                  <option value="revert">{t("RevertToOriginal") || "Revert to Original"}</option>
                                  <option value="skip">{t("SkipForNow") || "Skip for Now"}</option>
                                </select>
                                <button className="btn btn-sm btn-outline-info" onClick={() => handleCompareWithBackup(song, backup.song)}>
                                  {t("CompareWithBackup") || "Compare with Backup"}
                                </button>
                                <button className="btn btn-sm btn-outline-info" onClick={() => handleCompareWithServer(song)}>
                                  {t("CompareWithServer") || "Compare with Server"}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                  {updatedLeadersWithBackups.length > 0 && (
                    <>
                      <h6 className={updatedSongsWithBackups.length > 0 ? "mt-3" : ""}>{t("LocallyUpdatedProfiles") || "Profiles"}</h6>
                      <div className="updated-songs-list">
                        {updatedLeadersWithBackups.map(({ leader, backup }) => {
                          const decision = updatedLeadersDecisions.get(leader.id) || "upload";
                          const displayLeader = pendingMergedLeadersRef.current.get(leader.id) || leader;
                          return (
                            <div key={leader.id} className="updated-song-item" data-decision={decision}>
                              <div className="updated-song-header">
                                <div className="updated-song-title">👤 {displayLeader.name}</div>
                                <div className="updated-song-version">
                                  {t("OriginalVersion") || "Original version"}: {backup.version}
                                </div>
                              </div>
                              <div className="updated-song-actions">
                                <select
                                  className="form-select form-select-sm updated-song-select"
                                  aria-label="Profile action"
                                  value={decision}
                                  onChange={(e) => handleUpdatedLeaderDecision(leader.id, e.target.value as "upload" | "revert" | "skip")}
                                >
                                  <option value="upload">{t("UploadChanges") || "Upload Changes"}</option>
                                  <option value="revert">{t("RevertToOriginal") || "Revert to Original"}</option>
                                  <option value="skip">{t("SkipForNow") || "Skip for Now"}</option>
                                </select>
                                <button className="btn btn-sm btn-outline-info" onClick={() => handleCompareLeaderWithBackup(leader, backup.leader)}>
                                  {t("CompareWithBackup") || "Compare with Backup"}
                                </button>
                                <button className="btn btn-sm btn-outline-info" onClick={() => handleCompareLeaderWithServer(leader)}>
                                  {t("CompareWithServer") || "Compare with Server"}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
                <div className="modal-footer">
                  <button className="btn btn-secondary" onClick={handleCancelUpdatedSongsDialog}>
                    {t("Cancel")}
                  </button>
                  <button className="btn btn-primary" onClick={handleConfirmUpdatedSongsDecisions}>
                    {t("Continue") || "Continue"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Compare Dialog for updated song comparison */}
      {updatedSongCompare && (
        <CompareDialog
          originalSong={updatedSongCompare.compareType === "backup" ? updatedSongCompare.otherSong : updatedSongCompare.localSong}
          songsToCompare={[updatedSongCompare.compareType === "backup" ? updatedSongCompare.localSong : updatedSongCompare.otherSong]}
          mode="Conflict"
          leftLabel={updatedSongCompare.compareType === "backup" ? t("BackupVersion") : t("YourChanges")}
          rightLabel={updatedSongCompare.compareType === "backup" ? t("YourChanges") : t("ServerVersion")}
          leftButtonLabel={updatedSongCompare.compareType === "backup" ? t("UseBackupVersion") : t("KeepYourChanges")}
          rightButtonLabel={updatedSongCompare.compareType === "backup" ? t("KeepYourChanges") : t("UseServerVersion")}
          onClose={(mergedSong) => handleUpdatedSongCompareClose(updatedSongCompare.localSong.Id, updatedSongCompare.compareType, mergedSong)}
        />
      )}

      {/* Leader profile compare with backup or server */}
      {updatedLeaderCompare && (
        <LeaderDataMergeDialog
          localLeader={updatedLeaderCompare.leader}
          remoteLeader={updatedLeaderCompare.otherLeader}
          localLabel={updatedLeaderCompare.compareType === "backup" ? t("YourChanges") : t("YourChanges")}
          remoteLabel={updatedLeaderCompare.compareType === "backup" ? t("BackupVersion") : t("ServerVersion")}
          onSave={(mergedLeader) => handleUpdatedLeaderCompareClose(mergedLeader)}
          onCancel={() => handleUpdatedLeaderCompareClose()}
        />
      )}
    </>
  );
};

export default DBSyncDialog;
