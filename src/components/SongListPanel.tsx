import React from "react";
import { createPortal } from "react-dom";
import { Song } from "../classes/Song";
import { Database, FoundReason, SongFound } from "../classes/Database";
import { useDrag, useDrop } from "react-dnd";
import { useSettings } from "../hooks/useSettings";
import { Icon, IconType } from "../services/IconService";
import { useTooltips, TooltipKey } from "../localization/TooltipContext";
import { useLocalization, StringKey } from "../localization/LocalizationContext";
import { useAuth } from "../contexts/AuthContext";
import { useLeader } from "../contexts/LeaderContext";
import { useMessageBox, ConfirmOptions } from "../contexts/MessageBoxContext";
import { Settings } from "../types";
import { cloudApi } from "../../common/cloudApi";
import { SongPreference } from "../classes/SongPreference";
import { Leader } from "../classes/Leader";
import CompareDialog, { convertHistoryEntriesToSongsWithHistory } from "./CompareDialog";
import "./SongListPanel.css";

let addSongToPlaylistCallback: ((song: Song) => void) | null = null;

export const setAddSongToPlaylist = (callback: (song: Song) => void) => {
  addSongToPlaylistCallback = callback;
};

interface GroupFolder {
  groupId: string;
  songs: SongFound[];
  expanded: boolean;
}

// A category item is either a standalone song or a group folder containing multiple songs
type CategoryItem = { type: "song"; songFound: SongFound } | { type: "group"; folder: GroupFolder };

interface CategoryNode {
  reason: FoundReason;
  songs: SongFound[];
  items: CategoryItem[]; // flat songs + group folders for rendering
  expanded: boolean;
}

interface SongListPanelState {
  filter: string;
  categories: CategoryNode[];
  selectedSong: Song | null;
  showSongs: boolean; // Show items with chords (miShowSong)
  showTextOnly: boolean; // Show text-only items (miShowText)
  showMarked: boolean; // Show marked items (miShowMarked)
  showPreferredOnly: boolean; // Filter to show only preferred songs
  orderMode: "alphabetical" | "recent" | "cost"; // miAlphabeticalOrder, miRecentOrder, miCostOrder
  contextMenuVisible: boolean;
  contextMenuX: number;
  contextMenuY: number;
  isLoadingHistory: boolean;
  expandedGroups: Record<string, boolean>; // track which group folders are expanded
  // History dialog state
  historyOriginalSong: Song | null;
  historyVersions: Song[];
  showHistoryDialog: boolean;
  clipboardImportAvailable: boolean;
  showInlineSearchOptions: boolean;
}

// Draggable Song Item Component (also a drop target for grouping)
const DraggableSongItem: React.FC<{
  songFound: SongFound;
  onDoubleClick: () => void;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  isSelected: boolean;
  preferenceType: SongPreference["type"];
  hasLeader: boolean;
  onHeartClick: () => void;
  onRefChange?: (node: HTMLDivElement | null) => void;
  onDropSong?: (draggedSong: Song, targetSong: Song) => void;
  indented?: boolean;
}> = ({
  songFound,
  onDoubleClick,
  onClick,
  onContextMenu,
  isSelected,
  preferenceType,
  hasLeader,
  onHeartClick,
  onRefChange,
  onDropSong,
  indented,
}) => {
  const [{ isDragging }, drag] = useDrag(() => ({
    type: "song",
    item: songFound.song,
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  }));

  const [{ isOver, canDrop }, drop] = useDrop(
    () => ({
      accept: "song",
      canDrop: (item: Song) => {
        // Can't drop on self; can't drop if already in the same group
        if (item.Id === songFound.song.Id) return false;
        const targetGroup = songFound.song.GroupId;
        if (targetGroup && targetGroup === item.GroupId) return false;
        return true;
      },
      drop: (item: Song) => {
        if (onDropSong) {
          onDropSong(item, songFound.song);
        }
      },
      collect: (monitor) => ({
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
      }),
    }),
    [songFound.song, onDropSong]
  );

  const song = songFound.song;
  const { tt } = useTooltips();

  let iconType: IconType;
  if (song.Notes && song.Notes.trim() !== "") {
    iconType = IconType.ALERT;
  } else {
    const isStarred = song.version === 0;
    if (isStarred) {
      iconType = song.TextOnly ? IconType.STARRED_TEXT : IconType.STARRED_MUSIC;
    } else {
      iconType = song.TextOnly ? IconType.TEXT_ONLY : IconType.MUSIC;
    }
  }

  let costClass = "cost-low";
  if (songFound.cost > 2) {
    costClass = "cost-high";
  } else if (songFound.cost >= 1) {
    costClass = "cost-medium";
  }

  // Combine refs: drag + drop + callback for scrolling
  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      drag(drop(node));
      if (onRefChange) {
        onRefChange(node);
      }
    },
    [drag, drop, onRefChange]
  );

  const dropHighlight = isOver && canDrop;

  return (
    <div
      ref={setRefs}
      className={`song-item ${isDragging ? "dragging" : ""} ${isSelected ? "selected" : ""} ${costClass}${dropHighlight ? " drop-hover" : ""}${indented ? " song-item-indented" : ""}`}
      onDoubleClick={onDoubleClick}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={tt("songtree")}
    >
      {hasLeader ? (
        <span
          className={`song-heart${preferenceType === "Preferred" ? " preferred" : preferenceType === "Ignore" ? " ignored" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onHeartClick();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          title={preferenceType === "Preferred" ? "Preferred" : preferenceType === "Ignore" ? "Ignored" : "Not preferred"}
        >
          <Icon
            type={
              preferenceType === "Preferred" ? IconType.HEART_FILLED : preferenceType === "Ignore" ? IconType.HEART_IGNORED : IconType.HEART_EMPTY
            }
          />
        </span>
      ) : (
        <span className="song-heart-spacer" />
      )}
      <span className="song-icon">
        <Icon type={iconType} />
      </span>
      <span className="song-title-container">
        {songFound.snippet && songFound.reason === FoundReason.Title ? (
          <span className="song-title" dangerouslySetInnerHTML={{ __html: songFound.snippet }} />
        ) : (
          <>
            <span className="song-title">{song.Title}</span>
            {songFound.snippet && <span className="song-snippet" dangerouslySetInnerHTML={{ __html: songFound.snippet }} />}
          </>
        )}
      </span>
    </div>
  );
};

// Group Folder Node Component — collapsible folder for grouped songs
const GroupFolderNode: React.FC<{
  folder: GroupFolder;
  onToggle: () => void;
  onDropSongOnFolder: (draggedSong: Song, groupId: string) => void;
  onDropSongOnSong: (draggedSong: Song, targetSong: Song) => void;
  selectedSong: Song | null;
  hasLeader: boolean;
  selectedLeader: Leader | null;
  onSongClick: (song: Song) => void;
  onSongDoubleClick: (song: Song) => void;
  onSongContextMenu: (e: React.MouseEvent, song: Song) => void;
  onHeartClick: (song: Song) => void;
  onSelectedRefChange: (node: HTMLDivElement | null) => void;
}> = ({
  folder,
  onToggle,
  onDropSongOnFolder,
  onDropSongOnSong,
  selectedSong,
  hasLeader,
  onSongClick,
  onSongDoubleClick,
  onSongContextMenu,
  onHeartClick,
  onSelectedRefChange,
}) => {
  const [{ isOver, canDrop }, drop] = useDrop(
    () => ({
      accept: "song",
      canDrop: (item: Song) => {
        // Can't drop if already in this group
        return item.GroupId !== folder.groupId;
      },
      drop: (item: Song) => {
        onDropSongOnFolder(item, folder.groupId);
      },
      collect: (monitor) => ({
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
      }),
    }),
    [folder.groupId, onDropSongOnFolder]
  );

  const dropHighlight = isOver && canDrop;
  const folderLabel = folder.songs[0]?.song.Title || "Group";

  return (
    <div className="group-folder-container">
      <div ref={drop} className={`group-folder user-select-none${dropHighlight ? " drop-hover" : ""}`} onClick={onToggle}>
        <span className="group-folder-icon me-1">
          <Icon type={IconType.FOLDER} />
        </span>
        <i className={`fa fa-chevron-${folder.expanded ? "down" : "right"} me-1`}></i>
        <span className="group-folder-label">{folderLabel}</span>
        <span className="group-folder-count ms-1">({folder.songs.length})</span>
      </div>
      {folder.expanded && (
        <div className="group-folder-songs">
          {folder.songs.map((sf) => {
            const isSelected = selectedSong?.Id === sf.song.Id;
            return (
              <DraggableSongItem
                key={sf.song.Id}
                songFound={sf}
                isSelected={isSelected}
                preferenceType={sf.preference.type}
                hasLeader={hasLeader}
                onHeartClick={() => onHeartClick(sf.song)}
                onDoubleClick={() => onSongDoubleClick(sf.song)}
                onClick={() => onSongClick(sf.song)}
                onContextMenu={(e) => onSongContextMenu(e, sf.song)}
                onDropSong={onDropSongOnSong}
                indented
                onRefChange={isSelected ? onSelectedRefChange : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};

// Methods exposed for external access
export interface SongListPanelMethods {
  getSelectedSongId: () => string | null;
  setSelectedSongId: (songId: string | null) => void;
}

interface SongListPanelProps {
  songs: Song[];
  onSongSelected: (song: Song) => void;
  onExternalFilesDropped?: (files: File[]) => void;
  selectedSong?: Song | null;
  settings: Settings;
  updateSettingWithAutoSave?: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  authToken?: string | null;
  isGuest?: boolean;
  selectedLeader?: Leader | null;
  tt?: (key: TooltipKey) => string | undefined;
  t?: (key: StringKey) => string;
  showConfirm?: (title: string, message: string, onConfirm: () => void, onCancel?: () => void, options?: ConfirmOptions) => void;
  // Controlled filter props for state persistence
  filter?: string;
  onFilterChange?: (filter: string) => void;
}

class SongListPanel extends React.Component<SongListPanelProps, SongListPanelState> {
  // Store reference to the selected song item for scrolling
  private selectedItemElement: HTMLDivElement | null = null;
  // Store reference to the scrollable container for scroll-to-top
  private scrollContainerRef: HTMLDivElement | null = null;
  private filterBarRef: HTMLDivElement | null = null;
  // Store reference to current database for cleanup
  private currentDb: ReturnType<typeof Database.getInstance> | null = null;

  static addSongToPlaylist(song: Song) {
    if (addSongToPlaylistCallback) {
      addSongToPlaylistCallback(song);
    }
  }

  // Public methods for external access (SongListPanelMethods interface)
  public getSelectedSongId(): string | null {
    return this.state.selectedSong?.Id ?? null;
  }

  public setSelectedSongId(songId: string | null): void {
    if (!songId) {
      this.setState({ selectedSong: null });
      return;
    }
    // Try to find in props.songs first, then fall back to database
    let song = this.props.songs.find((s) => s.Id === songId) ?? null;
    if (!song) {
      // Songs might not be loaded yet, query database directly
      const db = Database.getInstance();
      song = db.getSongById(songId) ?? null;
    }
    if (song) {
      this.setState({ selectedSong: song }, () => {
        this.expandCategoryForSong(song!);
        setTimeout(() => {
          if (this.selectedItemElement) {
            this.selectedItemElement.scrollIntoView({ behavior: "instant", block: "nearest" });
          }
        }, 50);
      });
    }
  }

  constructor(props: SongListPanelProps) {
    super(props);
    this.state = {
      filter: props.filter ?? "",
      categories: [],
      selectedSong: null,
      showSongs: true, // Default checked (miShowSong)
      showTextOnly: true, // Default checked (miShowText)
      showMarked: true, // Default checked (miShowMarked)
      showPreferredOnly: props.settings.showPreferredOnly ?? false,
      orderMode: "cost", // Default to LessCostMatch
      contextMenuVisible: false,
      contextMenuX: 0,
      contextMenuY: 0,
      isLoadingHistory: false,
      expandedGroups: {},
      historyOriginalSong: null,
      historyVersions: [],
      showHistoryDialog: false,
      clipboardImportAvailable: false,
      showInlineSearchOptions: false,
    };

    this.handleFilterChange = this.handleFilterChange.bind(this);
    this.handleDoubleClick = this.handleDoubleClick.bind(this);
    this.handleSongClick = this.handleSongClick.bind(this);
    this.toggleCategory = this.toggleCategory.bind(this);
    this.updateCategories = this.updateCategories.bind(this);
    this.handleContextMenu = this.handleContextMenu.bind(this);
    this.handleSongContextMenu = this.handleSongContextMenu.bind(this);
    this.hideContextMenu = this.hideContextMenu.bind(this);
    this.handleShowHistory = this.handleShowHistory.bind(this);
    this.handleHistoryDialogClose = this.handleHistoryDialogClose.bind(this);
    this.handleDeleteSong = this.handleDeleteSong.bind(this);
    this.handleHeartClick = this.handleHeartClick.bind(this);
    this.togglePreferredFilter = this.togglePreferredFilter.bind(this);
    this.handleDropSongOnSong = this.handleDropSongOnSong.bind(this);
    this.handleDropSongOnFolder = this.handleDropSongOnFolder.bind(this);
    this.handleUngroupSong = this.handleUngroupSong.bind(this);
    this.toggleGroupFolder = this.toggleGroupFolder.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.updateInlineSearchOptionsVisibility = this.updateInlineSearchOptionsVisibility.bind(this);
    this.handleWindowResize = this.handleWindowResize.bind(this);
  }

  componentDidMount() {
    this.updateCategories();

    // Listen for database updates to refresh song list (matching C# behavior)
    this.currentDb = Database.getInstance();
    this.currentDb.emitter.on("db-updated", this.updateCategories);

    void this.checkClipboardForImportableData();
    window.addEventListener("focus", this.handleWindowFocus);
    window.addEventListener("resize", this.handleWindowResize);
    this.updateInlineSearchOptionsVisibility();
  }

  componentWillUnmount() {
    // Remove database update listener
    if (this.currentDb) {
      this.currentDb.emitter.off("db-updated", this.updateCategories);
    }
    window.removeEventListener("focus", this.handleWindowFocus);
    window.removeEventListener("resize", this.handleWindowResize);
  }

  componentDidUpdate(prevProps: SongListPanelProps, prevState: SongListPanelState) {
    // Sync filter from external prop if it changed (controlled mode)
    if (prevProps.filter !== this.props.filter && this.props.filter !== undefined && this.props.filter !== this.state.filter) {
      this.setState({ filter: this.props.filter }, () => {
        this.updateCategories();
      });
    }

    // Detect user change via authToken change - need to re-subscribe to new database emitter
    if (prevProps.authToken !== this.props.authToken) {
      // Unsubscribe from old database
      if (this.currentDb) {
        this.currentDb.emitter.off("db-updated", this.updateCategories);
      }
      // Subscribe to new database
      this.currentDb = Database.getInstance();
      this.currentDb.emitter.on("db-updated", this.updateCategories);
      // Reload songs from new database
      this.updateCategories();
    }

    // Re-run filter when leader changes so preferred states update in the song tree
    if (prevProps.selectedLeader?.id !== this.props.selectedLeader?.id) {
      this.updateCategories();
    }

    // Only update if songs prop changed, but filter/order settings didn't
    if (
      prevProps.songs !== this.props.songs &&
      prevState.filter === this.state.filter &&
      prevState.showSongs === this.state.showSongs &&
      prevState.showTextOnly === this.state.showTextOnly &&
      prevState.showMarked === this.state.showMarked &&
      prevState.orderMode === this.state.orderMode
    ) {
      this.updateCategories();
    }

    const prevSettings = prevProps.settings;
    const nextSettings = this.props.settings;
    if (
      prevSettings.searchMethod !== nextSettings.searchMethod ||
      prevSettings.useTextSimilarities !== nextSettings.useTextSimilarities ||
      prevSettings.traditionalSearchCaseSensitive !== nextSettings.traditionalSearchCaseSensitive ||
      prevSettings.traditionalSearchWholeWords !== nextSettings.traditionalSearchWholeWords
    ) {
      this.updateCategories();
    }

    // Sync with external selectedSong prop and scroll into view
    if (prevProps.selectedSong !== this.props.selectedSong && this.props.selectedSong) {
      const newSong = this.props.selectedSong;
      this.setState({ selectedSong: newSong }, () => {
        // Expand category containing the selected song and scroll into view
        this.expandCategoryForSong(newSong);
        // Scroll into view after a short delay to allow DOM update
        setTimeout(() => {
          if (this.selectedItemElement) {
            this.selectedItemElement.scrollIntoView({ behavior: "instant", block: "nearest" });
          }
        }, 50);
      });
    } else if (prevProps.selectedSong !== this.props.selectedSong) {
      this.setState({ selectedSong: this.props.selectedSong || null });
    }

    // Scroll into view when selection changes internally
    if (prevState.selectedSong?.Id !== this.state.selectedSong?.Id && this.state.selectedSong) {
      setTimeout(() => {
        if (this.selectedItemElement) {
          this.selectedItemElement.scrollIntoView({ behavior: "instant", block: "nearest" });
        }
      }, 50);
    }

    this.updateInlineSearchOptionsVisibility();
  }

  private handleWindowResize() {
    this.updateInlineSearchOptionsVisibility();
  }

  private updateInlineSearchOptionsVisibility() {
    const width = this.filterBarRef?.getBoundingClientRect().width ?? 0;
    const showInlineSearchOptions = width >= 32 * 16; // ~512px
    if (showInlineSearchOptions !== this.state.showInlineSearchOptions) {
      this.setState({ showInlineSearchOptions });
    }
  }

  private toggleTraditionalSimilarity = () => {
    const updater = this.props.updateSettingWithAutoSave;
    if (!updater) return;
    updater("useTextSimilarities", !(this.props.settings.useTextSimilarities ?? true));
  };

  private toggleTraditionalCaseSensitive = () => {
    const updater = this.props.updateSettingWithAutoSave;
    if (!updater) return;
    updater("traditionalSearchCaseSensitive", !(this.props.settings.traditionalSearchCaseSensitive ?? false));
  };

  private toggleTraditionalWholeWords = () => {
    const updater = this.props.updateSettingWithAutoSave;
    if (!updater) return;
    updater("traditionalSearchWholeWords", !(this.props.settings.traditionalSearchWholeWords ?? false));
  };

  // Expand the category containing the given song
  expandCategoryForSong(song: Song) {
    this.setState((prevState) => ({
      categories: prevState.categories.map((cat) => {
        const containsSong = cat.songs.some((sf) => sf.song.Id === song.Id);
        if (containsSong && !cat.expanded) {
          return { ...cat, expanded: true };
        }
        return cat;
      }),
    }));
  }

  handleFilterChange(event: React.ChangeEvent<HTMLInputElement>) {
    const oldFilter = this.state.filter.toLowerCase();
    const newFilter = event.target.value;
    // Use external handler if provided (controlled mode)
    if (this.props.onFilterChange) {
      this.props.onFilterChange(newFilter);
    }
    // Always update internal state for local rendering
    this.setState({ filter: newFilter }, () => {
      this.updateCategories();
      this.scrollAfterFilterChange(oldFilter, newFilter.toLowerCase());
    });
  }

  /**
   * Scroll the song tree after a filter change.
   * Narrowing (user typed more / completely new query) → scroll to top to show most relevant.
   * Expanding (user deleted chars) → keep selected item visible.
   */
  private scrollAfterFilterChange(oldFilter: string, newFilter: string) {
    const isExpanding = oldFilter.startsWith(newFilter) && oldFilter !== newFilter;

    if (isExpanding) {
      // Keep selected item visible after list expands
      setTimeout(() => {
        if (this.selectedItemElement) {
          this.selectedItemElement.scrollIntoView({ behavior: "instant", block: "nearest" });
        }
      }, 50);
    } else {
      // Narrowing or new search — scroll to top
      if (this.scrollContainerRef) {
        this.scrollContainerRef.scrollTop = 0;
      }
    }
  }

  handleSongClick(song: Song) {
    // Don't update local state immediately - let the parent decide via selectedSong prop
    // This allows the parent to show a confirmation dialog and cancel the selection if needed
    this.props.onSongSelected(song);
  }

  handleDoubleClick(song: Song) {
    SongListPanel.addSongToPlaylist(song);
  }

  async handleShowHistory() {
    const { selectedSong } = this.state;
    if (!selectedSong) return;

    this.setState({ isLoadingHistory: true });
    this.hideContextMenu();

    try {
      // Set auth token before making the API call (if available)
      if (this.props.authToken) {
        cloudApi.setToken(this.props.authToken);
      }
      const historyEntries = await cloudApi.fetchSongHistory(selectedSong.Id);

      // Match C# logic: show CompareDialog if there are history versions
      if (historyEntries && historyEntries.length > 0) {
        // Reconstruct Song objects from history entries
        const historySongs = convertHistoryEntriesToSongsWithHistory(historyEntries);
        // In History mode, pass all versions (including current) to the dialog
        // The dialog will handle building the version selectors
        this.setState({
          historyOriginalSong: selectedSong,
          historyVersions: historySongs,
          showHistoryDialog: true,
          isLoadingHistory: false,
        });
      } else {
        // No history available
        console.info("App", "This song has no history");
        this.setState({ isLoadingHistory: false });
      }
    } catch (error) {
      console.error("App", "Failed to fetch song history", error);
      this.setState({ isLoadingHistory: false });
    }
  }

  handleHistoryDialogClose() {
    this.setState({
      showHistoryDialog: false,
      historyOriginalSong: null,
      historyVersions: [],
    });
  }

  handleHeartClick(song: Song) {
    const leader = this.props.selectedLeader;
    if (!leader) return;

    const db = Database.getInstance();
    const pref = leader.getPreference(song.Id);
    const newMode: "Preferred" | "Ignore" | "" = pref?.type === "Preferred" ? "Ignore" : pref?.type === "Ignore" ? "" : "Preferred";

    leader.updatePreference(song.Id, { type: newMode }, db);
    db.forceSave();
    this.updateCategories();
  }

  togglePreferredFilter() {
    this.setState(
      (prevState) => {
        const newValue = !prevState.showPreferredOnly;
        this.props.updateSettingWithAutoSave?.("showPreferredOnly", newValue);
        return { showPreferredOnly: newValue };
      },
      () => this.updateCategories()
    );
  }

  toggleCategory(reason: FoundReason) {
    this.setState((prevState) => ({
      categories: prevState.categories.map((cat) => (cat.reason === reason ? { ...cat, expanded: !cat.expanded } : cat)),
    }));
  }

  getReasonName(reason: FoundReason): string {
    const { t } = this.props;
    switch (reason) {
      case FoundReason.None:
        return t?.("AllSongs") || "All Songs";
      case FoundReason.Title:
        return t?.("Title") || "Title";
      case FoundReason.Header:
        return t?.("Header") || "Header";
      case FoundReason.Lyrics:
        return t?.("Lyrics") || "Lyrics";
      case FoundReason.Words:
        return t?.("Words") || "Words";
      case FoundReason.Meta:
        return t?.("Meta") || "Meta";
      default:
        return t?.("Unknown") || "Unknown";
    }
  }

  handleContextMenu(event: React.MouseEvent) {
    event.preventDefault();

    // Calculate position that keeps menu within viewport
    const menuHeight = 300; // Approximate max height of context menu
    const menuWidth = 200; // Approximate width of context menu
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    let x = event.clientX;
    let y = event.clientY;

    // Adjust Y if menu would go below viewport
    if (y + menuHeight > viewportHeight) {
      y = Math.max(0, viewportHeight - menuHeight);
    }

    // Adjust X if menu would go outside right edge
    if (x + menuWidth > viewportWidth) {
      x = Math.max(0, viewportWidth - menuWidth);
    }

    this.setState({
      contextMenuVisible: true,
      contextMenuX: x,
      contextMenuY: y,
    });
  }

  // Handle right-click on a specific song item - selects the song and shows context menu
  handleSongContextMenu(event: React.MouseEvent, song: Song) {
    event.preventDefault();
    event.stopPropagation();

    // Calculate position that keeps menu within viewport
    const menuHeight = 300; // Approximate max height of context menu
    const menuWidth = 200; // Approximate width of context menu
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    let x = event.clientX;
    let y = event.clientY;

    // Adjust Y if menu would go below viewport
    if (y + menuHeight > viewportHeight) {
      y = Math.max(0, viewportHeight - menuHeight);
    }

    // Adjust X if menu would go outside right edge
    if (x + menuWidth > viewportWidth) {
      x = Math.max(0, viewportWidth - menuWidth);
    }

    // Select the song and show the context menu
    this.setState({
      selectedSong: song,
      contextMenuVisible: true,
      contextMenuX: x,
      contextMenuY: y,
    });
    // Also notify parent about the selection
    this.props.onSongSelected(song);
  }

  hideContextMenu() {
    this.setState({ contextMenuVisible: false });
  }

  handleDeleteSong() {
    const song = this.state.selectedSong;
    if (!song) return;

    this.hideContextMenu();

    const { showConfirm } = this.props;
    if (!showConfirm) {
      // showConfirm not available, skip deletion
      console.warn("showConfirm not available, cannot delete song");
      return;
    }

    showConfirm(
      this.props.t?.("DeleteSong") || "Delete Song",
      (this.props.t?.("AskConfirmDeleteSong") || 'Are you sure you want to delete "{0}"? This action cannot be undone.').replace("{0}", song.Title),
      () => {
        this.performDeleteSong(song);
      },
      undefined,
      { confirmText: this.props.t?.("DeleteSongConfirm") || "Delete Song", confirmDanger: true }
    );
  }

  performDeleteSong(song: Song) {
    const db = Database.getInstance();
    db.removeSong(song.Id);
    db.forceSave();

    // Clear selection if the deleted song was selected
    if (this.state.selectedSong?.Id === song.Id) {
      this.setState({ selectedSong: null });
    }

    // Update categories to reflect the deletion
    this.updateCategories();

    console.info("Database", `Deleted song: ${song.Title} (${song.Id})`);
  }

  async updateCategories() {
    const { filter, showSongs, showTextOnly, showMarked, showPreferredOnly, orderMode } = this.state;
    const db = Database.getInstance();

    // Map orderMode to SongOrder enum
    let order = 0; // SongOrder.Alphabetical
    if (orderMode === "recent")
      order = 1; // SongOrder.MoreRecent
    else if (orderMode === "cost") order = 2; // SongOrder.LessCostMatch

    // Call Database.filter with all parameters matching C# implementation
    // filter, leader, includeItemsWithChords, includeItemsWithoutChords, includeItemsWithNotes, order
    const filteredSongs = await db.filter(
      filter,
      this.props.selectedLeader ?? null, // Pass selected leader for filtering
      showSongs, // includeItemsWithChords
      showTextOnly, // includeItemsWithoutChords
      showMarked, // includeItemsWithNotes
      order,
      this.props.settings // Pass settings for search configuration
    );

    // Filter to preferred-only songs if toggle is active
    let songsToGroup: SongFound[] = filteredSongs;
    if (this.props.selectedLeader) {
      songsToGroup = filteredSongs.filter((sf) => (showPreferredOnly ? sf.preference.type === "Preferred" : sf.preference.type !== "Ignore"));
    }

    // Group by FoundReason
    const categoriesMap = new Map<FoundReason, SongFound[]>();

    songsToGroup.forEach((songFound) => {
      if (!categoriesMap.has(songFound.reason)) {
        categoriesMap.set(songFound.reason, []);
      }
      categoriesMap.get(songFound.reason)!.push(songFound);
    });

    // Sort reasons by priority
    const sortedReasons = Array.from(categoriesMap.keys()).sort((a, b) => a - b);

    const { expandedGroups } = this.state;

    const categories: CategoryNode[] = sortedReasons.map((reason) => {
      const songs = categoriesMap.get(reason)!;

      // Build items: group songs by GroupId only in the "All Songs" (None) category
      let items: CategoryItem[];
      if (reason === FoundReason.None) {
        items = this.buildGroupedItems(songs, expandedGroups);
      } else {
        items = songs.map((sf) => ({ type: "song" as const, songFound: sf }));
      }

      return { reason, songs, items, expanded: true };
    });

    this.setState({ categories });
  }

  // Build items with group folders for songs sharing a GroupId
  private buildGroupedItems(songs: SongFound[], expandedGroups: Record<string, boolean>): CategoryItem[] {
    const items: CategoryItem[] = [];
    const groupMap = new Map<string, SongFound[]>();
    const ungrouped: SongFound[] = [];

    for (const sf of songs) {
      const gid = sf.song.GroupId;
      if (gid) {
        if (!groupMap.has(gid)) groupMap.set(gid, []);
        groupMap.get(gid)!.push(sf);
      } else {
        ungrouped.push(sf);
      }
    }

    // Track which group IDs we've already emitted a folder for
    const emittedGroups = new Set<string>();

    // Walk original song order to preserve sort; emit folder at position of first song in each group
    for (const sf of songs) {
      const gid = sf.song.GroupId;
      if (!gid) {
        items.push({ type: "song", songFound: sf });
      } else if (!emittedGroups.has(gid)) {
        emittedGroups.add(gid);
        const groupSongs = groupMap.get(gid)!;
        if (groupSongs.length === 1) {
          // Only one song with this groupId visible — show as flat item
          items.push({ type: "song", songFound: groupSongs[0] });
        } else {
          items.push({
            type: "group",
            folder: {
              groupId: gid,
              songs: groupSongs,
              expanded: expandedGroups[gid] !== false, // default expanded
            },
          });
        }
      }
      // else: already emitted the folder for this group, skip
    }

    return items;
  }

  toggleGroupFolder(groupId: string) {
    this.setState((prev) => {
      const expandedGroups = { ...prev.expandedGroups };
      expandedGroups[groupId] = expandedGroups[groupId] === false; // toggle, default is expanded (true)
      return {
        expandedGroups,
        categories: prev.categories.map((cat) => ({
          ...cat,
          items: cat.items.map((item) =>
            item.type === "group" && item.folder.groupId === groupId
              ? { ...item, folder: { ...item.folder, expanded: expandedGroups[groupId] } }
              : item
          ),
        })),
      };
    });
  }

  handleDropSongOnSong(draggedSong: Song, targetSong: Song) {
    const { showConfirm, t } = this.props;
    if (!showConfirm) return;

    showConfirm(
      t?.("GroupSongs") || "Group Songs",
      (t?.("AskGroupSongsFormat") || 'Group "{0}" with "{1}"?').replace("{0}", draggedSong.Title).replace("{1}", targetSong.Title),
      () => {
        const db = Database.getInstance();
        db.MakeGroup(draggedSong, targetSong);
        this.updateCategories();
      },
      undefined,
      { confirmText: t?.("GroupSongsConfirm") || "Group Songs" }
    );
  }

  handleDropSongOnFolder(draggedSong: Song, groupId: string) {
    const { showConfirm, t } = this.props;
    if (!showConfirm) return;

    showConfirm(
      t?.("GroupSongs") || "Group Songs",
      (t?.("AskGroupSongWithFolder") || 'Add "{0}" to this group?').replace("{0}", draggedSong.Title),
      () => {
        const db = Database.getInstance();
        db.MakeGroup(draggedSong, groupId);
        this.updateCategories();
      },
      undefined,
      { confirmText: t?.("AddToGroupConfirm") || "Add to Group" }
    );
  }

  handleUngroupSong() {
    const { selectedSong } = this.state;
    if (!selectedSong || !selectedSong.GroupId) return;

    this.hideContextMenu();

    const { showConfirm, t } = this.props;
    if (!showConfirm) return;

    showConfirm(
      t?.("Ungroup") || "Ungroup",
      (t?.("AskUngroup") || 'Remove "{0}" from its group?').replace("{0}", selectedSong.Title),
      () => {
        const db = Database.getInstance();
        db.Ungroup(selectedSong);
        this.updateCategories();
      },
      undefined,
      { confirmText: t?.("RemoveFromGroupConfirm") || "Remove from Group" }
    );
  }

  private handleWindowFocus = () => {
    void this.checkClipboardForImportableData();
  };

  private async checkClipboardForImportableData(): Promise<void> {
    const CHORDPRO_TYPES = ["web text/chordpro", "text/chordpro", "text/html", "text/plain"];
    try {
      const items = await navigator.clipboard.read();
      const available = items.some((item) => CHORDPRO_TYPES.some((t) => item.types.includes(t)));
      this.setState({ clipboardImportAvailable: available });
    } catch {
      // Fallback: try readText for browsers that don't support read()
      try {
        const text = await navigator.clipboard.readText();
        this.setState({ clipboardImportAvailable: !!text?.trim() });
      } catch {
        this.setState({ clipboardImportAvailable: false });
      }
    }
  }

  private handleImportFromClipboard = async () => {
    this.hideContextMenu();
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        // Prefer ChordPro custom MIME — import directly as .chp
        for (const chpMime of ["web text/chordpro", "text/chordpro"]) {
          if (item.types.includes(chpMime)) {
            const blob = await item.getType(chpMime);
            const text = await blob.text();
            if (text?.trim()) {
              const file = new File([text], "clipboard-text.chp", { type: "text/plain" });
              this.props.onExternalFilesDropped?.([file]);
              return;
            }
          }
        }
        if (item.types.includes("text/html")) {
          const blob = await item.getType("text/html");
          const html = await blob.text();
          if (html?.trim()) {
            const file = new File([html], "clipboard-text.html", { type: "text/html" });
            this.props.onExternalFilesDropped?.([file]);
            return;
          }
        }
        if (item.types.includes("text/plain")) {
          const blob = await item.getType("text/plain");
          const text = await blob.text();
          if (text?.trim()) {
            const file = new File([text], "clipboard-text.txt", { type: "text/plain" });
            this.props.onExternalFilesDropped?.([file]);
            return;
          }
        }
      }
    } catch {
      // Fallback: try readText for browsers that don't support read()
      try {
        const text = await navigator.clipboard.readText();
        if (!text?.trim()) return;
        const file = new File([text], "clipboard-text.txt", { type: "text/plain" });
        this.props.onExternalFilesDropped?.([file]);
      } catch {
        // Clipboard read failed or permission denied — nothing to do
      }
    }
  };

  handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Delete") {
      const { selectedSong } = this.state;
      if (selectedSong && selectedSong.GroupId) {
        event.preventDefault();
        this.handleUngroupSong();
      }
    }
    // Ctrl+V or Shift+Insert → import from clipboard
    if ((event.ctrlKey && event.key === "v") || (event.shiftKey && event.key === "Insert")) {
      event.preventDefault();
      void this.handleImportFromClipboard();
    }
  }

  private handleExternalDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    const hasFiles = event.dataTransfer?.files && event.dataTransfer.files.length > 0;
    const hasText = event.dataTransfer?.types?.includes("text/plain");
    if (hasFiles || hasText) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    }
  };

  private handleExternalFileDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const hasFiles = event.dataTransfer?.files && event.dataTransfer.files.length > 0;
    if (hasFiles) {
      const files = Array.from(event.dataTransfer.files);
      this.props.onExternalFilesDropped?.(files);
      return;
    }
    const html = event.dataTransfer?.getData("text/html");
    let file: File | undefined;
    if (html?.trim()) file = new File([html], "dropped-text.html", { type: "text/html" });
    else {
      const text = event.dataTransfer?.getData("text/plain");
      if (text?.trim()) file = new File([text], "dropped-text.txt", { type: "text/plain" });
    }
    if (file) this.props.onExternalFilesDropped?.([file]);
  };

  renderContextMenu() {
    const { contextMenuVisible, contextMenuX, contextMenuY, showSongs, showTextOnly, showMarked, orderMode } = this.state;
    const { t } = this.props;

    if (!contextMenuVisible) return null;

    const menu = (
      <>
        <div className="songlist-context-menu-overlay" onClick={this.hideContextMenu} />
        <div className="songlist-context-menu" style={{ left: `${contextMenuX}px`, top: `${contextMenuY}px` }}>
          <div
            className="songlist-context-menu-item"
            onClick={() => {
              this.setState({ showMarked: !showMarked }, () => this.updateCategories());
              this.hideContextMenu();
            }}
          >
            <i className={`fa fa-${showMarked ? "check-" : ""}square-o me-2`}></i>
            {t?.("SongListShowMarkedItems") || "Show marked items"}
          </div>
          <div
            className="songlist-context-menu-item"
            onClick={() => {
              this.setState({ showSongs: !showSongs }, () => this.updateCategories());
              this.hideContextMenu();
            }}
          >
            <i className={`fa fa-${showSongs ? "check-" : ""}square-o me-2`}></i>
            {t?.("SongListShowSongItems") || "Show song items"}
          </div>
          <div
            className="songlist-context-menu-item"
            onClick={() => {
              this.setState({ showTextOnly: !showTextOnly }, () => this.updateCategories());
              this.hideContextMenu();
            }}
          >
            <i className={`fa fa-${showTextOnly ? "check-" : ""}square-o me-2`}></i>
            {t?.("SongListShowTextOnlyItems") || "Show text-only items"}
          </div>
          <div className="songlist-context-menu-divider"></div>
          <div className="songlist-context-menu-item songlist-context-menu-submenu">
            <i className="fa fa-sort me-2"></i>
            <span>{t?.("SongListOrdering") || "Ordering"}</span>
            <i className="fa fa-chevron-right ms-auto"></i>
            <div className="songlist-context-submenu">
              <div
                className="songlist-context-menu-item"
                onClick={() => {
                  this.setState({ orderMode: "alphabetical" }, () => this.updateCategories());
                  this.hideContextMenu();
                }}
              >
                <i className={`fa fa-${orderMode === "alphabetical" ? "check-" : ""}square-o me-2`}></i>
                <i className="fa fa-sort-alpha-asc me-2"></i>
                {t?.("SongListOrderAlphabetical") || "Alphabetical"}
              </div>
              <div
                className="songlist-context-menu-item"
                onClick={() => {
                  this.setState({ orderMode: "recent" }, () => this.updateCategories());
                  this.hideContextMenu();
                }}
              >
                <i className={`fa fa-${orderMode === "recent" ? "check-" : ""}square-o me-2`}></i>
                <i className="fa fa-clock-o me-2"></i>
                {t?.("SongListOrderMoreRecent") || "More recent"}
              </div>
              <div
                className="songlist-context-menu-item"
                onClick={() => {
                  this.setState({ orderMode: "cost" }, () => this.updateCategories());
                  this.hideContextMenu();
                }}
              >
                <i className={`fa fa-${orderMode === "cost" ? "check-" : ""}square-o me-2`}></i>
                <i className="fa fa-star-o me-2"></i>
                {t?.("SongListOrderMatchingValue") || "Matching value"}
              </div>
            </div>
          </div>
          <div className="songlist-context-menu-divider"></div>
          {!this.props.isGuest && (
            <div
              className={`songlist-context-menu-item ${!this.state.selectedSong || this.state.isLoadingHistory ? "disabled" : ""}`}
              onClick={this.state.selectedSong && !this.state.isLoadingHistory ? this.handleShowHistory : undefined}
            >
              <i className="fa fa-history me-2"></i>
              {this.state.isLoadingHistory ? this.props.t?.("LoadingEllipsis") : this.props.t?.("History")}
            </div>
          )}
          {/* Ungroup - visible when selected song is in a group */}
          {this.state.selectedSong && this.state.selectedSong.GroupId && (
            <>
              <div className="songlist-context-menu-divider"></div>
              <div className="songlist-context-menu-item" onClick={this.handleUngroupSong}>
                <i className="fa fa-chain-broken me-2"></i>
                {this.props.t?.("Ungroup") || "Ungroup"}
              </div>
            </>
          )}
          {/* Delete song - only visible in guest mode */}
          {this.props.isGuest && this.state.selectedSong && (
            <>
              <div className="songlist-context-menu-divider"></div>
              <div className="songlist-context-menu-item songlist-context-menu-item-danger" onClick={() => this.handleDeleteSong()}>
                <i className="fa fa-trash me-2"></i>
                {this.props.t?.("DeleteSong") || "Delete song"}
              </div>
            </>
          )}
          <div className="songlist-context-menu-divider"></div>
          <div
            className={`songlist-context-menu-item ${!this.state.clipboardImportAvailable ? "disabled" : ""}`}
            onClick={this.state.clipboardImportAvailable ? () => void this.handleImportFromClipboard() : undefined}
          >
            <i className="fa fa-clipboard me-2"></i>
            {this.props.t?.("SongListImportFromClipboard") || "Import from clipboard"}
          </div>
        </div>
      </>
    );

    return typeof document !== "undefined" ? createPortal(menu, document.body) : menu;
  }

  render() {
    const { filter, categories, selectedSong, showPreferredOnly, showInlineSearchOptions } = this.state;
    const hasLeader = !!this.props.selectedLeader;
    const searchMethod = this.props.settings.searchMethod;
    const isTraditionalSearch = searchMethod === "traditional";
    const settingsUpdaterAvailable = !!this.props.updateSettingWithAutoSave;

    return (
      <div className="song-list-panel d-flex flex-column h-100" onClick={this.hideContextMenu}>
        <div
          className="input-group mb-2"
          ref={(el) => {
            this.filterBarRef = el;
          }}
        >
          {hasLeader && (
            <div className="input-group-prepend">
              <button
                className={`btn btn-outline-secondary preferred-filter-btn ${showPreferredOnly ? "preferred-filter-active" : ""}`}
                type="button"
                aria-label="Show preferred only"
                title={showPreferredOnly ? "Showing preferred only" : "Show all songs"}
                onClick={this.togglePreferredFilter}
              >
                <Icon type={showPreferredOnly ? IconType.BIG_HEART_FILLED : IconType.BIG_HEART_EMPTY} />
              </button>
            </div>
          )}
          <input
            type="text"
            className="form-control song-filter-input"
            placeholder={this.props.t?.("FilterSongsPlaceholder") || "Filter songs..."}
            value={filter}
            title={this.props.tt?.("song_filter")}
            onChange={this.handleFilterChange}
          />
          <div className="input-group-append">
            {showInlineSearchOptions && isTraditionalSearch && (
              <>
                <button
                  className={`btn btn-outline-secondary song-search-toggle-btn ${this.props.settings.useTextSimilarities ? "active" : ""}`}
                  type="button"
                  aria-label="Toggle fuzzy search"
                  title={this.props.t?.("EnableSimilarTextSearch") || "Enable similar text search"}
                  onClick={this.toggleTraditionalSimilarity}
                  disabled={!settingsUpdaterAvailable}
                >
                  <Icon type={IconType.SEARCH_FUZZY} />
                </button>
                <button
                  className={`btn btn-outline-secondary song-search-toggle-btn ${this.props.settings.traditionalSearchCaseSensitive ? "active" : ""}`}
                  type="button"
                  aria-label="Toggle case sensitive"
                  title={this.props.t?.("CaseSensitiveSearch") || "Case sensitive search"}
                  onClick={this.toggleTraditionalCaseSensitive}
                  disabled={!settingsUpdaterAvailable}
                >
                  <Icon type={IconType.SEARCH_CASE} />
                </button>
                <button
                  className={`btn btn-outline-secondary song-search-toggle-btn ${this.props.settings.traditionalSearchWholeWords ? "active" : ""}`}
                  type="button"
                  aria-label="Toggle whole words"
                  title={this.props.t?.("MatchWholeWordsOnly") || "Match whole words only"}
                  onClick={this.toggleTraditionalWholeWords}
                  disabled={!settingsUpdaterAvailable}
                >
                  <Icon type={IconType.SEARCH_WHOLE_WORD} />
                </button>
              </>
            )}
            <button
              className="btn btn-outline-secondary"
              type="button"
              aria-label="Clear Filter"
              title={this.props.tt?.("song_filter_clear")}
              onClick={() => {
                const oldFilter = this.state.filter.toLowerCase();
                // Notify parent about filter change (controlled mode)
                if (this.props.onFilterChange) {
                  this.props.onFilterChange("");
                }
                this.setState({ filter: "" }, () => {
                  this.updateCategories();
                  this.scrollAfterFilterChange(oldFilter, "");
                });
                // Focus the input after clearing
                setTimeout(() => {
                  const input = document.querySelector(".song-filter-input") as HTMLInputElement | null;
                  if (input) input.focus();
                }, 50);
              }}
            >
              <Icon type={IconType.CLEAR} />
            </button>
          </div>
        </div>
        <div
          className="flex-grow-1 overflow-auto"
          ref={(el) => {
            this.scrollContainerRef = el;
          }}
          onContextMenu={this.handleContextMenu}
          onDragOver={this.handleExternalDragOver}
          onDrop={this.handleExternalFileDrop}
          onKeyDown={this.handleKeyDown}
          tabIndex={0}
        >
          {categories.map((categoryNode) => (
            <div key={categoryNode.reason} className="category-node">
              <div className="category-header user-select-none" onClick={() => this.toggleCategory(categoryNode.reason)}>
                <span className="category-icon me-1">
                  <Icon type={IconType.FOLDER} />
                </span>
                <i className={`fa fa-chevron-${categoryNode.expanded ? "down" : "right"} me-1`}></i>
                {this.getReasonName(categoryNode.reason)} ({categoryNode.songs.length})
              </div>
              {categoryNode.expanded && (
                <div className="category-songs">
                  {categoryNode.items.map((item) => {
                    if (item.type === "group") {
                      return (
                        <GroupFolderNode
                          key={`group-${item.folder.groupId}`}
                          folder={item.folder}
                          onToggle={() => this.toggleGroupFolder(item.folder.groupId)}
                          onDropSongOnFolder={this.handleDropSongOnFolder}
                          onDropSongOnSong={this.handleDropSongOnSong}
                          selectedSong={selectedSong}
                          hasLeader={hasLeader}
                          selectedLeader={this.props.selectedLeader ?? null}
                          onSongClick={this.handleSongClick}
                          onSongDoubleClick={this.handleDoubleClick}
                          onSongContextMenu={this.handleSongContextMenu}
                          onHeartClick={this.handleHeartClick}
                          onSelectedRefChange={(node) => {
                            this.selectedItemElement = node;
                          }}
                        />
                      );
                    }
                    const songFound = item.songFound;
                    const isSelected = selectedSong?.Id === songFound.song.Id;
                    return (
                      <DraggableSongItem
                        key={songFound.song.Id}
                        songFound={songFound}
                        isSelected={isSelected}
                        preferenceType={songFound.preference.type}
                        hasLeader={hasLeader}
                        onHeartClick={() => this.handleHeartClick(songFound.song)}
                        onDoubleClick={() => this.handleDoubleClick(songFound.song)}
                        onClick={() => this.handleSongClick(songFound.song)}
                        onContextMenu={(e) => this.handleSongContextMenu(e, songFound.song)}
                        onDropSong={this.handleDropSongOnSong}
                        onRefChange={
                          isSelected
                            ? (node) => {
                                this.selectedItemElement = node;
                              }
                            : undefined
                        }
                      />
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
        {this.renderContextMenu()}

        {/* History Dialog */}
        {this.state.showHistoryDialog && this.state.historyOriginalSong && this.state.historyVersions.length > 0 && (
          <CompareDialog
            originalSong={this.state.historyOriginalSong}
            songsToCompare={this.state.historyVersions}
            mode="History"
            onClose={this.handleHistoryDialogClose}
          />
        )}
      </div>
    );
  }
}

const SongListPanelWithSettings = React.forwardRef<
  SongListPanelMethods,
  Omit<SongListPanelProps, "tt" | "t" | "settings" | "updateSettingWithAutoSave" | "authToken" | "isGuest" | "selectedLeader" | "showConfirm">
>((props, ref) => {
  const { tt } = useTooltips();
  const { t } = useLocalization();
  const { settings, updateSettingWithAutoSave } = useSettings();
  const { token, isGuest } = useAuth();
  const { selectedLeader } = useLeader();
  const { showConfirm } = useMessageBox();
  const innerRef = React.useRef<SongListPanel>(null);

  // Forward the ref to expose the inner component's methods
  React.useImperativeHandle(ref, () => ({
    getSelectedSongId: () => innerRef.current?.getSelectedSongId() ?? null,
    setSelectedSongId: (songId: string | null) => innerRef.current?.setSelectedSongId(songId),
  }));

  if (!settings) {
    return <div>Loading settings...</div>;
  }

  return (
    <SongListPanel
      ref={innerRef}
      {...props}
      tt={tt}
      t={t}
      settings={settings}
      updateSettingWithAutoSave={updateSettingWithAutoSave}
      authToken={token}
      isGuest={isGuest}
      selectedLeader={selectedLeader}
      showConfirm={showConfirm}
    />
  );
});

export default SongListPanelWithSettings;
