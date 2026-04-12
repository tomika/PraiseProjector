import React from "react";
import { useDrop, useDrag } from "react-dnd";
import { Song } from "../../db-common/Song";
import { Playlist } from "../../db-common/Playlist";
import { PlaylistEntry } from "../../db-common/PlaylistEntry";
import {
  PlaylistEntry as PlaylistEntryData,
  SongPreference as SongPreferenceData,
  SongPreferenceEntry as SongPreferenceEntryData,
} from "../../common/pp-types";
import InstructionsEditorForm from "./InstructionsEditorForm";
import { Database } from "../../db-common/Database";
import "./PlaylistPanel.css";
import { setAddSongToPlaylist } from "./SongListPanel";
import { Icon, IconType } from "../services/IconService";
import { SectionGenerator, DisplaySettings } from "../utils/SectionGenerator";
import { SectionRenderer } from "../utils/SectionRenderer";
import { useTooltips, TooltipKey } from "../localization/TooltipContext";
import { useLocalization, StringKey } from "../localization/LocalizationContext";
import { useMessageBox, ConfirmOptions } from "../contexts/MessageBoxContext";
import { ScheduleDialog } from "./ScheduleDialog";
import { Leader } from "../../db-common/Leader";
import { Settings } from "../types";
import { updateCurrentDisplay } from "../state/CurrentSongStore";
import { ContextMenu, ContextMenuItem } from "./ContextMenu/ContextMenu";

// DisplayMode enum matching C# SectionListBox.Item.Mode
enum DisplayMode {
  Normal = 0,
  Shrink = 1,
  Crops = 2,
}

// Calculate contrasting text color (black or white) based on background luminance
function getContrastTextColor(bgColor: string): string {
  // Parse color - supports hex (#RGB, #RRGGBB) and rgb/rgba formats
  let r = 0,
    g = 0,
    b = 0;

  if (bgColor.startsWith("#")) {
    const hex = bgColor.slice(1);
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length >= 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }
  } else if (bgColor.startsWith("rgb")) {
    const match = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      r = parseInt(match[1], 10);
      g = parseInt(match[2], 10);
      b = parseInt(match[3], 10);
    }
  }

  // Calculate relative luminance using sRGB formula
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

  // Return black for light backgrounds, white for dark backgrounds
  return luminance > 0.5 ? "#000000" : "#ffffff";
}

// Methods exposed for external access
export interface PlaylistPanelMethods {
  selectSongById: (songId: string) => { index: number; item: PlaylistEntry } | null;
  setSelectedIndex: (index: number) => void;
  getSelectedIndex: () => number;
  getPreferencesForSongId: (songId: string) => SongPreferenceData | null;
  updatePlaylist: (playlist: PlaylistEntryData[]) => void;
  updatePlaylistItemPreferences: (songId: string, transpose?: number, capo?: number, instructions?: string) => Playlist | null;
  getScheduleDate: () => Date | null;
  getCurrentPlaylist: () => Playlist;
}

export interface PlaylistSelectionEvent {
  index: number;
  item: PlaylistEntry | null;
  song: Song | null;
  source: "keyboard" | "mouse" | "programmatic";
  settled: boolean;
}

interface PlaylistPanelProps {
  songs: Song[];
  selectedSongFromList?: Song | null;
  onPlaylistSelectionChange?: (event: PlaylistSelectionEvent) => void;
  tt: (key: TooltipKey) => string | undefined; // Tooltip function injected by HOC
  t: (key: StringKey) => string; // Localization function injected by HOC
  showConfirm?: (title: string, message: string, onConfirm: () => void, onCancel?: () => void, options?: ConfirmOptions) => void;
  onError?: (errorType: "SaveFailed" | "LoadFailed", errorDetails: string) => void;
  disabled?: boolean; // When true, disables all playlist editing (used in watch mode)
  remotePlaylist?: Playlist | null; // Remote playlist when watching another session
  // Callback when playlist is loaded from localStorage - for state restoration
  onPlaylistLoaded?: (itemCount: number) => void;
  onPlaylistPreferenceUpdate?: (songIdOrPreference: SongPreferenceEntryData | string) => void;
  settings?: Settings | null; // Settings to check before updating leader profile
  selectedLeader?: Leader | null; // Current leader context
}

interface PlaylistPanelState {
  currentPlaylist: Playlist;
  selectedItems: Set<number>; // Set of selected item indices
  focusedIndex: number; // Currently focused item (for keyboard navigation)
  selectionAnchor: number; // Anchor point for Shift+click range selection
  editingIndex: number;
  showInstructionsEditor: boolean;
  editingInstructions: { item: PlaylistEntry; index: number } | null;
  itemColors: Map<number, string>; // index -> background color
  showScheduleDialog: boolean;
  scheduleDialogMode: "save" | "load" | null;
  scheduleDate: Date | null; // Remembered date when playlist was loaded from or saved to a leader profile
  contextMenu: { position: { x: number; y: number }; targetIndex: number } | null;
}

class PlaylistPanel extends React.Component<PlaylistPanelProps, PlaylistPanelState> {
  private pendingSelectedIndex: number = -1;
  constructor(props: PlaylistPanelProps) {
    super(props);

    const initialIndex = -1;
    this.state = {
      currentPlaylist: new Playlist("CurrentPlaylist", []),
      selectedItems: initialIndex >= 0 ? new Set([initialIndex]) : new Set<number>(),
      focusedIndex: initialIndex,
      selectionAnchor: initialIndex,
      editingIndex: -1,
      showInstructionsEditor: false,
      editingInstructions: null,
      itemColors: new Map(),
      showScheduleDialog: false,
      scheduleDialogMode: null,
      scheduleDate: this.loadScheduleDate(),
      contextMenu: null,
    };

    this.addSongToPlaylist = this.addSongToPlaylist.bind(this);
    this.movePlaylistItem = this.movePlaylistItem.bind(this);
    this.removePlaylistItem = this.removePlaylistItem.bind(this);
    this.updatePlaylistItem = this.updatePlaylistItem.bind(this);
    this.handleItemClick = this.handleItemClick.bind(this);
    this.handleMoveUp = this.handleMoveUp.bind(this);
    this.handleMoveDown = this.handleMoveDown.bind(this);
    this.handleTransposeUp = this.handleTransposeUp.bind(this);
    this.handleTransposeDown = this.handleTransposeDown.bind(this);
    this.handleCapoUp = this.handleCapoUp.bind(this);
    this.handleCapoDown = this.handleCapoDown.bind(this);
    this.handleSetTranspose = this.handleSetTranspose.bind(this);
    this.handleSetCapo = this.handleSetCapo.bind(this);
    this.handleRemove = this.handleRemove.bind(this);
    this.handleAddFromList = this.handleAddFromList.bind(this);
    this.handleEdit = this.handleEdit.bind(this);
    this.handleTitleChange = this.handleTitleChange.bind(this);
    this.handleTitleBlur = this.handleTitleBlur.bind(this);
    this.handleInstructionsClick = this.handleInstructionsClick.bind(this);
    this.handleInstructionsSave = this.handleInstructionsSave.bind(this);
    this.handleInstructionsClose = this.handleInstructionsClose.bind(this);
    this.handleItemContextMenu = this.handleItemContextMenu.bind(this);
    this.hideContextMenu = this.hideContextMenu.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleLoadPlaylist = this.handleLoadPlaylist.bind(this);
    this.handleSavePlaylist = this.handleSavePlaylist.bind(this);
    this.handleScheduleDateSelected = this.handleScheduleDateSelected.bind(this);
    this.handleScheduleDialogCancel = this.handleScheduleDialogCancel.bind(this);
  }

  componentDidMount() {
    this.loadPlaylist();
    setAddSongToPlaylist(this.addSongToPlaylist);

    // Listen for settings changes to trigger color update
    window.addEventListener("pp-settings-changed", this.handleSettingsChange);
  }

  componentDidUpdate(prevProps: PlaylistPanelProps) {
    // Trigger color update when songs change (e.g., database updated)
    if (prevProps.songs !== this.props.songs) {
      this.updatePlaylistItemStates();
    }

    // Handle selectedLeader prop changes
    if (prevProps.selectedLeader !== this.props.selectedLeader) {
      if (prevProps.selectedLeader && prevProps.selectedLeader !== this.props.selectedLeader) {
        this.setState({ scheduleDate: null });
        this.persistScheduleDate(null);
      }
    }

    // Replace local playlist with remote playlist when watching another session
    if (this.props.remotePlaylist && prevProps.remotePlaylist !== this.props.remotePlaylist) {
      this.setState(
        {
          currentPlaylist: this.props.remotePlaylist,
          selectedItems: new Set<number>(),
          focusedIndex: -1,
          selectionAnchor: -1,
        },
        () => {
          this.updatePlaylistItemStates();
        }
      );
    }

    // Restore local playlist when exiting watch mode (remotePlaylist becomes null)
    if (!this.props.remotePlaylist && prevProps.remotePlaylist) {
      this.loadPlaylist();
    }
  }

  componentWillUnmount() {
    // Clean up keyboard frame timer
    if (this.keyboardNavRafId !== null) {
      window.cancelAnimationFrame(this.keyboardNavRafId);
      this.keyboardNavRafId = null;
    }
    // Clean up color timer
    if (this.colorUpdateTimer) {
      clearInterval(this.colorUpdateTimer);
      this.colorUpdateTimer = null;
    }
    window.removeEventListener("pp-settings-changed", this.handleSettingsChange);
  }

  // Public method: single input for driving selection from parent
  setSelectedIndex(index: number): void {
    this.pendingSelectedIndex = index;
    this.applySelectedIndex(index, false);
  }

  private applySelectedIndex(index: number, emitChange: boolean): PlaylistSelectionEvent | null {
    const { currentPlaylist } = this.state;

    if (index < 0) {
      this.setState({
        selectedItems: new Set<number>(),
        focusedIndex: -1,
        selectionAnchor: -1,
      });
      return emitChange
        ? this.emitPlaylistSelectionChange(null, -1, "programmatic", true)
        : this.createPlaylistSelectionEvent(null, -1, "programmatic", true);
    }

    if (index >= 0 && index < currentPlaylist.items.length) {
      const item = currentPlaylist.items[index];
      this.setState({
        selectedItems: new Set([index]),
        focusedIndex: index,
        selectionAnchor: index,
      });
      return emitChange
        ? this.emitPlaylistSelectionChange(item, index, "programmatic", true)
        : this.createPlaylistSelectionEvent(item, index, "programmatic", true);
    }

    return null;
  }

  getSelectedIndex(): number {
    return this.state.focusedIndex;
  }

  private loadScheduleDate(): Date | null {
    try {
      const stored = localStorage.getItem("pp-schedule-date");
      if (stored) {
        const parsed = new Date(stored);
        if (!isNaN(parsed.getTime())) return parsed;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  private persistScheduleDate(date: Date | null) {
    try {
      if (date) {
        localStorage.setItem("pp-schedule-date", date.toISOString());
      } else {
        localStorage.removeItem("pp-schedule-date");
      }
    } catch {
      /* ignore */
    }
  }

  getScheduleDate(): Date | null {
    return this.state.scheduleDate;
  }

  getCurrentPlaylist(): Playlist {
    return this.state.currentPlaylist;
  }

  selectSongById(songId: string): { index: number; item: PlaylistEntry } | null {
    const { currentPlaylist } = this.state;
    let index = currentPlaylist.items.findIndex((item) => item.songId === songId);
    if (index < 0) {
      const song = Database.getInstance().getSongById(songId);
      if (song) {
        this.addSongToPlaylist(song);
        index = currentPlaylist.items.findIndex((item) => item.songId === songId);
      }
    }
    if (index >= 0 && index < currentPlaylist.items.length) {
      const item = currentPlaylist.items[index];
      // Don't set selection state here — let the selectedIndex prop drive visual selection.
      // The caller should update the selectedIndex prop to apply the selection.
      return { index, item };
    }
    return null;
  }

  getPreferencesForSongId(songId: string): SongPreferenceEntryData | null {
    const { currentPlaylist } = this.state;
    const index = currentPlaylist.items.findIndex((item) => item.songId === songId);
    if (index >= 0) {
      const item = currentPlaylist.items[index];
      return {
        songId: item.songId,
        title: item.title,
        transpose: item.transpose,
        capo: item.capo,
        instructions: item.instructions,
      };
    }
    return null;
  }

  doUpdatePlaylistCallback(newPlaylist: Playlist) {
    const playlist = newPlaylist.items.map((item) => ({
      songId: item.songId,
      title: item.title,
      transpose: item.transpose,
      capo: item.capo,
      instructions: item.instructions,
    }));
    updateCurrentDisplay({ playlist, playlist_id: `${newPlaylist.id}:${newPlaylist.modified}` });
  }

  updatePlaylist(items: PlaylistEntryData[], name?: string, id?: string): void {
    // console.debug("Playlist", "updatePlaylist called", { itemsLength: items?.length, name, id, remoteProp: this.props.remotePlaylist != null });
    const playlist = new Playlist(
      name || "CurrentPlaylist",
      items.map((item: PlaylistEntryData) => PlaylistEntry.fromJSON(item)),
      id
    );
    this.setState({ currentPlaylist: playlist }, () => {
      // console.debug("Playlist", "setState callback ENTER for updatePlaylist");
      try {
        this.updatePlaylistItemStates();
        this.doUpdatePlaylistCallback(playlist); // Update Display state

        // Notify parent that playlist is loaded (for state restoration)
        this.props.onPlaylistLoaded?.(playlist.items.length);

        // Apply pending selected index after playlist loads
        const pendingIndex = this.pendingSelectedIndex;
        if (pendingIndex >= 0 && pendingIndex < playlist.items.length) {
          this.applySelectedIndex(pendingIndex, true);
        }
      } catch (err) {
        console.error("Playlist", "error in setState callback", err);
      } finally {
        // console.debug("Playlist", "setState callback EXIT for updatePlaylist");
      }
    });
  }

  updatePlaylistItemPreferences(songId: string, transpose?: number, capo?: number, instructions?: string): Playlist | null {
    // Implementation to update playlist item preferences
    const { currentPlaylist, focusedIndex } = this.state;
    const index =
      focusedIndex >= 0 && currentPlaylist.items[focusedIndex].songId === songId
        ? focusedIndex
        : currentPlaylist.items.findIndex((item) => item.songId === songId);
    if (index >= 0) {
      const item = currentPlaylist.items[index];
      if (transpose !== undefined) item.transpose = transpose;
      if (capo !== undefined) {
        const db = Database.getInstance();
        const song = db?.getSongById(songId);
        item.capo = song && song.Capo === capo ? -1 : capo >= 0 ? capo : -1;
      }
      if (instructions !== undefined) item.instructions = instructions;
      const newPlaylist = new Playlist(currentPlaylist.name, [...currentPlaylist.items], currentPlaylist.id);
      this.setState(
        {
          currentPlaylist: newPlaylist,
        },
        () => {
          this.doUpdatePlaylistCallback(this.state.currentPlaylist); // Update Display state
        }
      );
      return newPlaylist;
    }
    return null;
  }

  private keyboardNavRafId: number | null = null;
  private pendingKeyboardNavDelta: number = 0;
  private pendingKeyboardNavShift: boolean = false;

  private colorUpdateTimer: NodeJS.Timeout | null = null;
  private checkedPlayListItems: Set<number> = new Set();
  private headerRef = React.createRef<HTMLTableSectionElement>();
  private playlistContainerRef = React.createRef<HTMLDivElement>();

  private getPageNavigationStep(): number {
    const container = this.playlistContainerRef.current;
    if (!container) return 10;

    const firstRow = container.querySelector("tbody tr") as HTMLTableRowElement | null;
    const rowHeight = firstRow?.getBoundingClientRect().height ?? 24;
    const headerHeight = this.headerRef.current?.offsetHeight ?? 0;
    const viewportHeight = Math.max(0, container.clientHeight - headerHeight);
    return Math.max(1, Math.floor(viewportHeight / Math.max(1, rowHeight)));
  }

  handleSettingsChange = () => {
    // Settings changed, trigger color update (matching C# UpdatePlaylistItemStates after settings save)
    this.updatePlaylistItemStates();
  };

  loadPlaylist() {
    try {
      const savedPlaylistJson = localStorage.getItem("pp-playlist");
      if (savedPlaylistJson) {
        const savedPlaylist = Playlist.fromJSON(JSON.parse(savedPlaylistJson));
        this.updatePlaylist(savedPlaylist.items || [], savedPlaylist.name, savedPlaylist.id);
      } else {
        // No saved playlist - still notify parent that loading is complete
        this.props.onPlaylistLoaded?.(0);
      }
    } catch (error) {
      console.error("Playlist", "Error loading playlist from localStorage", error);
      this.props.onPlaylistLoaded?.(0);
    }
  }

  savePlaylist(playlist: Playlist) {
    try {
      const playlistJson = JSON.stringify(playlist.toJSON());
      localStorage.setItem("pp-playlist", playlistJson);
      this.doUpdatePlaylistCallback(playlist); // Update Display state whenever playlist is saved
    } catch (error) {
      console.error("Playlist", "Error saving playlist to localStorage", error);
    }
  }

  addSongToPlaylist(song: Song) {
    const { currentPlaylist } = this.state;
    const t = this.props.t || ((key: string) => key);

    // Check if song already exists in playlist
    const existingIndex = currentPlaylist.items.findIndex((item) => item.songId === song.Id);
    if (existingIndex !== -1) {
      // Song already exists - ask for confirmation
      const existingItem = currentPlaylist.items[existingIndex];

      if (this.props.showConfirm) {
        this.props.showConfirm(
          t("Confirm"),
          t("AskPlaylistAddAgain"),
          () => {
            // User confirmed - add the song anyway
            this.doAddSongToPlaylist(song);
          },
          () => {
            // User cancelled - select the existing item instead
            this.setState(
              {
                selectedItems: new Set<number>([existingIndex]),
                focusedIndex: existingIndex,
                selectionAnchor: existingIndex,
              },
              () => this.emitPlaylistSelectionChange(existingItem, existingIndex, "programmatic", true)
            );
          },
          { confirmText: this.props.t("AddAgainConfirm") }
        );
      } else {
        // Fallback if showConfirm not available - just select existing
        this.setState(
          {
            selectedItems: new Set<number>([existingIndex]),
            focusedIndex: existingIndex,
            selectionAnchor: existingIndex,
          },
          () => this.emitPlaylistSelectionChange(existingItem, existingIndex, "programmatic", true)
        );
      }
      return;
    }

    this.doAddSongToPlaylist(song);
  }

  doAddSongToPlaylist(song: Song) {
    const { currentPlaylist } = this.state;

    const newEntry = new PlaylistEntry(song.Id);
    newEntry.title = song.Title;
    const updatedPlaylist = new Playlist(currentPlaylist.name, [...currentPlaylist.items, newEntry], currentPlaylist.id);
    updatedPlaylist.modified = Date.now();

    // Select the newly added song and project it immediately
    const newIndex = updatedPlaylist.items.length - 1;
    const newSelectedItems = new Set<number>([newIndex]);

    this.setState(
      {
        currentPlaylist: updatedPlaylist,
        selectedItems: newSelectedItems,
        focusedIndex: newIndex,
        selectionAnchor: newIndex,
      },
      () => {
        this.savePlaylist(updatedPlaylist);
        this.updatePlaylistItemStates();

        // Notify parent component to project the newly added song
        this.emitPlaylistSelectionChange(newEntry, newIndex, "programmatic", true);
      }
    );
  }

  movePlaylistItem(dragIndex: number, hoverIndex: number) {
    const { currentPlaylist, selectedItems } = this.state;
    const updatedPlaylist = new Playlist(currentPlaylist.name, [...currentPlaylist.items], currentPlaylist.id);
    const [draggedItem] = updatedPlaylist.items.splice(dragIndex, 1);
    updatedPlaylist.items.splice(hoverIndex, 0, draggedItem);
    updatedPlaylist.modified = Date.now();

    // Update selected indices based on the move
    const newSelectedItems = new Set<number>();
    selectedItems.forEach((index) => {
      if (index === dragIndex) {
        newSelectedItems.add(hoverIndex);
      } else if (dragIndex < hoverIndex && index > dragIndex && index <= hoverIndex) {
        newSelectedItems.add(index - 1);
      } else if (dragIndex > hoverIndex && index >= hoverIndex && index < dragIndex) {
        newSelectedItems.add(index + 1);
      } else {
        newSelectedItems.add(index);
      }
    });

    // Update focused index and selection anchor based on the move
    let newFocusedIndex = this.state.focusedIndex;
    let newSelectionAnchor = this.state.selectionAnchor;

    if (this.state.focusedIndex === dragIndex) {
      newFocusedIndex = hoverIndex;
    } else if (dragIndex < hoverIndex && this.state.focusedIndex > dragIndex && this.state.focusedIndex <= hoverIndex) {
      newFocusedIndex = this.state.focusedIndex - 1;
    } else if (dragIndex > hoverIndex && this.state.focusedIndex >= hoverIndex && this.state.focusedIndex < dragIndex) {
      newFocusedIndex = this.state.focusedIndex + 1;
    }

    if (this.state.selectionAnchor === dragIndex) {
      newSelectionAnchor = hoverIndex;
    } else if (dragIndex < hoverIndex && this.state.selectionAnchor > dragIndex && this.state.selectionAnchor <= hoverIndex) {
      newSelectionAnchor = this.state.selectionAnchor - 1;
    } else if (dragIndex > hoverIndex && this.state.selectionAnchor >= hoverIndex && this.state.selectionAnchor < dragIndex) {
      newSelectionAnchor = this.state.selectionAnchor + 1;
    }

    this.setState(
      {
        currentPlaylist: updatedPlaylist,
        selectedItems: newSelectedItems,
        focusedIndex: newFocusedIndex,
        selectionAnchor: newSelectionAnchor,
      },
      () => {
        this.savePlaylist(updatedPlaylist);
      }
    );
  }

  removePlaylistItem(index: number) {
    const { currentPlaylist, selectedItems } = this.state;
    const newItems = [...currentPlaylist.items];
    newItems.splice(index, 1);
    const updatedPlaylist = new Playlist(currentPlaylist.name, newItems, currentPlaylist.id);
    updatedPlaylist.modified = Date.now();

    // Update selected indices after removal
    const newSelectedItems = new Set<number>();
    selectedItems.forEach((selectedIndex) => {
      if (selectedIndex < index) {
        // Item before removed item stays the same
        newSelectedItems.add(selectedIndex);
      } else if (selectedIndex > index) {
        // Items after removed item shift down by 1
        newSelectedItems.add(selectedIndex - 1);
      }
      // selectedIndex === index is removed, so we don't add it
    });

    // Update focused index and selection anchor
    const newFocusedIndex =
      this.state.focusedIndex > index ? this.state.focusedIndex - 1 : this.state.focusedIndex === index ? -1 : this.state.focusedIndex;
    const newSelectionAnchor =
      this.state.selectionAnchor > index ? this.state.selectionAnchor - 1 : this.state.selectionAnchor === index ? -1 : this.state.selectionAnchor;

    this.setState(
      {
        currentPlaylist: updatedPlaylist,
        selectedItems: newSelectedItems,
        focusedIndex: newFocusedIndex,
        selectionAnchor: newSelectionAnchor,
      },
      () => {
        this.savePlaylist(updatedPlaylist);
      }
    );
  }

  updatePlaylistItem(index: number, item: PlaylistEntry) {
    const { currentPlaylist, focusedIndex } = this.state;
    const newItems = [...currentPlaylist.items];
    newItems[index] = item;
    const updatedPlaylist = new Playlist(currentPlaylist.name, newItems, currentPlaylist.id);
    updatedPlaylist.modified = Date.now();

    this.setState({ currentPlaylist: updatedPlaylist }, () => {
      this.savePlaylist(updatedPlaylist);

      // Notify parent if the updated item is the currently focused/selected item
      // This ensures PreviewPanel gets updated instructions, capo, transpose, etc.
      if (index === focusedIndex) {
        this.emitPlaylistSelectionChange(item, index, "programmatic", true);
      }
    });
  }

  handleItemClick(index: number, event?: React.MouseEvent) {
    const { currentPlaylist, selectedItems, selectionAnchor } = this.state;
    const item = currentPlaylist.items[index];

    let newSelectedItems = new Set<number>();
    const newFocusedIndex = index;
    let newSelectionAnchor = index;
    let selectedItem: PlaylistEntry | null = item;

    if (event?.ctrlKey) {
      // Ctrl+click: Toggle selection, keep existing selections
      newSelectedItems = new Set(selectedItems);
      if (selectedItems.has(index)) {
        newSelectedItems.delete(index);
        // Keep the anchor unchanged for Ctrl+click
        newSelectionAnchor = selectionAnchor;
        // If we deselected all items, notify parent with null
        if (newSelectedItems.size === 0) {
          selectedItem = null;
        }
      } else {
        newSelectedItems.add(index);
        // Set new anchor when adding with Ctrl+click
        newSelectionAnchor = index;
      }
    } else if (event?.shiftKey && selectionAnchor >= 0) {
      // Shift+click: Range selection from anchor
      const start = Math.min(selectionAnchor, index);
      const end = Math.max(selectionAnchor, index);
      for (let i = start; i <= end; i++) {
        newSelectedItems.add(i);
      }
      newSelectionAnchor = selectionAnchor; // Keep the original anchor
    } else {
      // Regular click: Single selection
      newSelectedItems.add(index);
    }

    this.setState({
      selectedItems: newSelectedItems,
      focusedIndex: newFocusedIndex,
      selectionAnchor: newSelectionAnchor,
    });

    // Notify parent component about selected item (index is derived by parent)
    this.emitPlaylistSelectionChange(selectedItem, selectedItem ? newFocusedIndex : -1, "mouse", true);
  }

  handleItemContextMenu(index: number, event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    const { currentPlaylist, selectedItems, focusedIndex, selectionAnchor } = this.state;
    const item = currentPlaylist.items[index];

    // Calculate position that keeps menu within viewport
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const menuHeight = Math.min(320, Math.max(0, viewportHeight - 12)); // Approximate max height of context menu
    const menuWidth = 260; // Approximate width of context menu

    let x = event.clientX;
    let y = event.clientY;

    if (y + menuHeight > viewportHeight) {
      y = Math.max(0, viewportHeight - menuHeight);
    }

    if (x + menuWidth > viewportWidth) {
      x = Math.max(0, viewportWidth - menuWidth);
    }

    const shouldSelect = !selectedItems.has(index);
    const nextSelectedItems = shouldSelect ? new Set<number>([index]) : selectedItems;
    const nextFocusedIndex = shouldSelect ? index : focusedIndex;
    const nextSelectionAnchor = shouldSelect ? index : selectionAnchor;

    this.setState(
      {
        selectedItems: nextSelectedItems,
        focusedIndex: nextFocusedIndex,
        selectionAnchor: nextSelectionAnchor,
        contextMenu: { position: { x, y }, targetIndex: index },
      },
      () => {
        if (shouldSelect) {
          this.emitPlaylistSelectionChange(item, index, "mouse", true);
        }
      }
    );
  }

  hideContextMenu() {
    this.setState({ contextMenu: null });
  }

  getSelectedIndices(): number[] {
    return Array.from(this.state.selectedItems).sort((a, b) => a - b);
  }

  getFirstSelectedIndex(): number {
    const indices = this.getSelectedIndices();
    return indices.length > 0 ? indices[0] : -1;
  }

  getLastSelectedIndex(): number {
    const indices = this.getSelectedIndices();
    return indices.length > 0 ? indices[indices.length - 1] : -1;
  }

  private resolveSongForItem(item: PlaylistEntry | null): Song | null {
    if (!item) return null;
    const fromProps = this.props.songs.find((song) => song.Id === item.songId);
    if (fromProps) return fromProps;
    const db = Database.getInstance();
    return db.getSongById(item.songId) || null;
  }

  private emitPlaylistSelectionChange(item: PlaylistEntry | null, index: number, source: "keyboard" | "mouse" | "programmatic", settled: boolean) {
    const event = this.createPlaylistSelectionEvent(item, index, source, settled);
    this.props.onPlaylistSelectionChange?.(event);
    return event;
  }

  private createPlaylistSelectionEvent(
    item: PlaylistEntry | null,
    index: number,
    source: "keyboard" | "mouse" | "programmatic",
    settled: boolean
  ): PlaylistSelectionEvent {
    return {
      index,
      item,
      song: this.resolveSongForItem(item),
      source,
      settled,
    };
  }

  private scheduleKeyboardArrowNavigation(direction: number, shiftKey: boolean) {
    this.pendingKeyboardNavDelta += direction;
    this.pendingKeyboardNavShift = shiftKey;

    if (this.keyboardNavRafId !== null) {
      return;
    }

    this.keyboardNavRafId = window.requestAnimationFrame(() => {
      this.keyboardNavRafId = null;

      const navDelta = this.pendingKeyboardNavDelta;
      const shift = this.pendingKeyboardNavShift;
      this.pendingKeyboardNavDelta = 0;
      this.pendingKeyboardNavShift = false;

      if (navDelta === 0) return;

      this.handleArrowNavigation(navDelta, shift);
    });
  }

  handleArrowNavigation(direction: number, shiftKey: boolean) {
    const { currentPlaylist, focusedIndex, selectionAnchor } = this.state;

    if (currentPlaylist.items.length === 0) return;

    let targetIndex: number;

    if (focusedIndex === -1) {
      // No focus, start with first or last item
      targetIndex = direction > 0 ? 0 : currentPlaylist.items.length - 1;
    } else {
      // Move from current focus
      targetIndex = focusedIndex + direction;

      // Clamp to valid range
      targetIndex = Math.max(0, Math.min(currentPlaylist.items.length - 1, targetIndex));

      // If we're at the edge and trying to go further, don't change anything
      if (targetIndex === focusedIndex) {
        return;
      }
    }

    let newSelectedItems: Set<number>;
    let newSelectionAnchor: number;

    if (shiftKey && selectionAnchor >= 0) {
      // Shift+Arrow: Extend selection from anchor to new focus
      newSelectedItems = new Set<number>();
      const start = Math.min(selectionAnchor, targetIndex);
      const end = Math.max(selectionAnchor, targetIndex);
      for (let i = start; i <= end; i++) {
        newSelectedItems.add(i);
      }
      newSelectionAnchor = selectionAnchor; // Keep the anchor
    } else {
      // Regular arrow: Single selection, new anchor
      newSelectedItems = new Set<number>();
      newSelectedItems.add(targetIndex);
      newSelectionAnchor = targetIndex;
    }

    this.setState({
      selectedItems: newSelectedItems,
      focusedIndex: targetIndex,
      selectionAnchor: newSelectionAnchor,
    });

    // Notify parent component
    const item = currentPlaylist.items[targetIndex];
    this.emitPlaylistSelectionChange(item, targetIndex, "keyboard", true);
  }

  handleMoveUp() {
    const { currentPlaylist, selectedItems, focusedIndex, selectionAnchor } = this.state;
    const selectedIndices = this.getSelectedIndices();
    if (selectedIndices.length === 0) return;

    // Check if we can move all selected items up
    if (selectedIndices[0] <= 0) return;

    // Move all selected items up by 1 position in a single batch
    const newItems = [...currentPlaylist.items];
    const newSelected = new Set<number>();

    // Process in ascending order - each selected item swaps with item above
    for (const idx of selectedIndices) {
      [newItems[idx - 1], newItems[idx]] = [newItems[idx], newItems[idx - 1]];
      newSelected.add(idx - 1);
    }

    const newFocusedIndex = selectedItems.has(focusedIndex) ? focusedIndex - 1 : focusedIndex;
    const newSelectionAnchor = selectedItems.has(selectionAnchor) ? selectionAnchor - 1 : selectionAnchor;

    const updatedPlaylist = new Playlist(currentPlaylist.name, newItems, currentPlaylist.id);
    updatedPlaylist.modified = Date.now();

    this.setState(
      {
        currentPlaylist: updatedPlaylist,
        selectedItems: newSelected,
        focusedIndex: newFocusedIndex,
        selectionAnchor: newSelectionAnchor,
      },
      () => {
        this.savePlaylist(updatedPlaylist);
      }
    );
  }

  handleMoveDown() {
    const { currentPlaylist, selectedItems, focusedIndex, selectionAnchor } = this.state;
    const selectedIndices = this.getSelectedIndices();
    if (selectedIndices.length === 0) return;

    // Check if we can move all selected items down
    const lastIndex = selectedIndices[selectedIndices.length - 1];
    if (lastIndex >= currentPlaylist.items.length - 1) return;

    // Move all selected items down by 1 position in a single batch
    const newItems = [...currentPlaylist.items];
    const newSelected = new Set<number>();

    // Process in descending order - each selected item swaps with item below
    for (let i = selectedIndices.length - 1; i >= 0; i--) {
      const idx = selectedIndices[i];
      [newItems[idx], newItems[idx + 1]] = [newItems[idx + 1], newItems[idx]];
      newSelected.add(idx + 1);
    }

    const newFocusedIndex = selectedItems.has(focusedIndex) ? focusedIndex + 1 : focusedIndex;
    const newSelectionAnchor = selectedItems.has(selectionAnchor) ? selectionAnchor + 1 : selectionAnchor;

    const updatedPlaylist = new Playlist(currentPlaylist.name, newItems, currentPlaylist.id);
    updatedPlaylist.modified = Date.now();

    this.setState(
      {
        currentPlaylist: updatedPlaylist,
        selectedItems: newSelected,
        focusedIndex: newFocusedIndex,
        selectionAnchor: newSelectionAnchor,
      },
      () => {
        this.savePlaylist(updatedPlaylist);
      }
    );
  }

  // Helper method to update playlist and notify parent if focused item changed
  // Also updates leader preferences for changed items (matching C# behavior from ProjectorForm.PlayModeChangedByLeader)
  private updatePlaylistItems(newItems: PlaylistEntry[], modifiedIndices: Set<number> | number[], updateLeaderProfile: boolean = true) {
    const { currentPlaylist, focusedIndex } = this.state;
    const updatedPlaylist = new Playlist(currentPlaylist.name, newItems, currentPlaylist.id);
    updatedPlaylist.modified = Date.now();

    // Convert to Set for easy lookup
    const modifiedSet = modifiedIndices instanceof Set ? modifiedIndices : new Set(modifiedIndices);

    this.setState({ currentPlaylist: updatedPlaylist }, () => {
      this.savePlaylist(updatedPlaylist);

      // Update leader profile for modified items (matching C# database.UpdatePreference call)
      if (updateLeaderProfile && this.props.selectedLeader) {
        const db = Database.getInstance();
        const settings = this.props.settings;
        const updateMode = settings?.leaderProfileUpdateMode || "allSources";

        // Check if UI playlist changes should update the profile
        if (updateMode === "leaderPageOnly") {
          console.debug("PlaylistPanel", "Skipping profile update from UI changes (mode: leaderPageOnly)");
        } else {
          // Allow updates from UI (uiChangesAlso or allSources)
          modifiedSet.forEach((idx) => {
            const item = newItems[idx];
            // Only update title if it differs from the original song title
            const song = this.props.songs.find((s) => s.Id === item.songId);
            const titleToSave = song && item.title === song.Title ? "" : item.title || "";
            if (song) {
              this.props.onPlaylistPreferenceUpdate?.({
                songId: item.songId,
                title: titleToSave,
                transpose: item.transpose,
                capo: item.capo,
                instructions: item.instructions,
              });
            }

            this.props.selectedLeader!.updatePreference(
              item.songId,
              {
                title: titleToSave,
                transpose: item.transpose,
                capo: item.capo,
                instructions: item.instructions,
              },
              db
            );
          });

          // Commit the mutated leader back into the canonical DB leader collection.
          // This keeps Settings/Leader views consistent even if selectedLeader was a stale reference.
          db.updateLeader(this.props.selectedLeader!);
        }
      }

      // Notify parent if the focused item was one of the modified items
      if (focusedIndex >= 0 && modifiedSet.has(focusedIndex)) {
        this.emitPlaylistSelectionChange(newItems[focusedIndex], focusedIndex, "programmatic", true);
      }
    });
  }

  handleTransposeUp() {
    const selectedIndices = this.getSelectedIndices();
    if (selectedIndices.length === 0) return;

    const { currentPlaylist } = this.state;
    const newItems = [...currentPlaylist.items];

    // Update all selected items in one go
    selectedIndices.forEach((selectedIndex) => {
      const item = newItems[selectedIndex].clone();
      item.transpose++;
      newItems[selectedIndex] = item;
    });

    this.updatePlaylistItems(newItems, selectedIndices);
  }

  handleTransposeDown() {
    const selectedIndices = this.getSelectedIndices();
    if (selectedIndices.length === 0) return;

    const { currentPlaylist } = this.state;
    const newItems = [...currentPlaylist.items];

    // Update all selected items in one go
    selectedIndices.forEach((selectedIndex) => {
      const item = newItems[selectedIndex].clone();
      item.transpose--;
      newItems[selectedIndex] = item;
    });

    this.updatePlaylistItems(newItems, selectedIndices);
  }

  handleCapoUp() {
    const selectedIndices = this.getSelectedIndices();
    if (selectedIndices.length === 0) return;

    const { currentPlaylist } = this.state;
    const newItems = [...currentPlaylist.items];

    // Update all selected items in one go
    selectedIndices.forEach((selectedIndex) => {
      const item = newItems[selectedIndex].clone();
      if (item.capo < 11) {
        item.capo++;
        newItems[selectedIndex] = item;
      }
    });

    this.updatePlaylistItems(newItems, selectedIndices);
  }

  handleCapoDown() {
    const selectedIndices = this.getSelectedIndices();
    if (selectedIndices.length === 0) return;

    const { currentPlaylist } = this.state;
    const newItems = [...currentPlaylist.items];

    // Update all selected items in one go
    selectedIndices.forEach((selectedIndex) => {
      const item = newItems[selectedIndex].clone();
      if (item.capo > -1) {
        item.capo--;
        newItems[selectedIndex] = item;
      }
    });

    this.updatePlaylistItems(newItems, selectedIndices);
  }

  handleSetTranspose(value: number) {
    const selectedIndices = this.getSelectedIndices();
    if (selectedIndices.length === 0) return;

    const { currentPlaylist } = this.state;
    const newItems = [...currentPlaylist.items];

    selectedIndices.forEach((selectedIndex) => {
      const item = newItems[selectedIndex].clone();
      item.transpose = value;
      newItems[selectedIndex] = item;
    });

    this.updatePlaylistItems(newItems, selectedIndices);
  }

  handleSetCapo(value: number) {
    const selectedIndices = this.getSelectedIndices();
    if (selectedIndices.length === 0) return;

    const { currentPlaylist } = this.state;
    const newItems = [...currentPlaylist.items];

    selectedIndices.forEach((selectedIndex) => {
      const item = newItems[selectedIndex].clone();
      item.capo = value;
      newItems[selectedIndex] = item;
    });

    this.updatePlaylistItems(newItems, selectedIndices);
  }

  handleRemove() {
    const selectedIndices = this.getSelectedIndices();
    if (selectedIndices.length === 0) return;

    const { currentPlaylist } = this.state;
    const newItems = [...currentPlaylist.items];

    // Remove items in reverse order to maintain correct indices during deletion
    const sortedIndices = [...selectedIndices].sort((a, b) => b - a); // Sort in descending order
    sortedIndices.forEach((index) => {
      newItems.splice(index, 1);
    });

    // Select the nearest remaining item after deletion (matching C# behavior)
    const lowestRemoved = Math.min(...selectedIndices);
    const newFocusedIndex = newItems.length === 0 ? -1 : Math.min(lowestRemoved, newItems.length - 1);

    const updatedPlaylist = new Playlist(currentPlaylist.name, newItems, currentPlaylist.id);
    updatedPlaylist.modified = Date.now();

    this.setState(
      {
        currentPlaylist: updatedPlaylist,
        selectedItems: newFocusedIndex >= 0 ? new Set<number>([newFocusedIndex]) : new Set<number>(),
        focusedIndex: newFocusedIndex,
        selectionAnchor: newFocusedIndex,
        // Clear remembered schedule date when all items are removed
        scheduleDate: newItems.length === 0 ? null : this.state.scheduleDate,
      },
      () => {
        if (newItems.length === 0) this.persistScheduleDate(null);
        this.savePlaylist(updatedPlaylist);
        // Notify parent about new selection so display updates
        this.emitPlaylistSelectionChange(newFocusedIndex >= 0 ? newItems[newFocusedIndex] : null, newFocusedIndex, "programmatic", true);
      }
    );
  }

  handleAddFromList() {
    const { selectedSongFromList } = this.props;
    if (selectedSongFromList) {
      this.addSongToPlaylist(selectedSongFromList);
    }
  }

  handleEdit() {
    const selectedIndex = this.getFirstSelectedIndex();
    if (selectedIndex >= 0) {
      this.setState({ editingIndex: selectedIndex });
    }
  }

  handleTitleChange(index: number, newTitle: string) {
    const { currentPlaylist } = this.state;
    const newItems = [...currentPlaylist.items];
    const item = newItems[index].clone();

    // Ha üres stringet adunk meg, visszaállítjuk az eredeti song címet
    if (newTitle.trim() === "") {
      const song = this.props.songs.find((s) => s.Id === item.songId);
      item.title = song ? song.Title : "";
    } else {
      item.title = newTitle;
    }
    newItems[index] = item;

    // Use updatePlaylistItems to also update leader profile
    this.updatePlaylistItems(newItems, [index]);
  }

  handleTitleBlur() {
    this.setState({ editingIndex: -1 });
  }

  handleInstructionsClick(index: number) {
    const { currentPlaylist } = this.state;
    const item = currentPlaylist.items[index];

    this.setState({
      editingInstructions: { item, index },
      showInstructionsEditor: true,
    });
  }

  handleInstructionsSave(instructions: string, storeInProfile: boolean) {
    const { editingInstructions } = this.state;
    if (!editingInstructions) return;

    const { item, index } = editingInstructions;
    const updatedItem = item.clone();
    updatedItem.instructions = instructions;

    this.updatePlaylistItem(index, updatedItem);

    // Store in profile if requested
    if (storeInProfile) {
      const db = Database.getInstance();
      const song = this.props.songs.find((s) => s.Id === item.songId);
      if (song) {
        this.props.onPlaylistPreferenceUpdate?.({
          songId: song.Id,
          title: updatedItem.title,
          transpose: updatedItem.transpose,
          capo: updatedItem.capo,
          type: undefined,
          instructions: updatedItem.instructions,
        });

        if (this.props.selectedLeader) {
          // Use the selected leader from props (passed from LeaderContext)
          this.props.selectedLeader.updatePreference(
            song.Id,
            {
              instructions,
            },
            db
          );
          // Commit back to canonical DB collection so Settings sees the update immediately.
          db.updateLeader(this.props.selectedLeader);
        }
      }
    }

    this.setState({
      showInstructionsEditor: false,
      editingInstructions: null,
    });
  }

  handleInstructionsClose() {
    this.setState({
      showInstructionsEditor: false,
      editingInstructions: null,
    });
  }

  // Save playlist - matching C# OnPlayListSave
  async handleSavePlaylist() {
    const selectedLeader = this.props.selectedLeader;

    if (selectedLeader) {
      // Save to leader's schedule
      this.setState({
        showScheduleDialog: true,
        scheduleDialogMode: "save",
      });
    } else {
      // Save to file
      await this.savePlaylistToFile();
    }
  }

  // Load playlist - matching C# OnPlayListLoad
  async handleLoadPlaylist() {
    const selectedLeader = this.props.selectedLeader;

    if (selectedLeader) {
      // Load from leader's schedule
      this.setState({
        showScheduleDialog: true,
        scheduleDialogMode: "load",
      });
    } else {
      // Load from file
      await this.loadPlaylistFromFile();
    }
  }

  // Handle schedule dialog date selection
  async handleScheduleDateSelected(date: Date) {
    const selectedLeader = this.props.selectedLeader;
    const { scheduleDialogMode, currentPlaylist } = this.state;

    this.setState({
      showScheduleDialog: false,
      scheduleDialogMode: null,
    });

    if (!selectedLeader) return;

    const db = Database.getInstance();

    if (scheduleDialogMode === "save") {
      // Save playlist to leader's schedule
      db.schedule(selectedLeader, date, currentPlaylist);
      // Remember the date we saved to
      this.setState({ scheduleDate: date });
      this.persistScheduleDate(date);
    } else if (scheduleDialogMode === "load") {
      // Load playlist from leader's schedule
      const playlist = selectedLeader.getPlaylist(date, 24 * 60 * 60 * 1000); // 1 day timespan
      if (playlist) {
        const playlistStr = playlist.toString();
        this.loadPlaylistData(playlistStr);
        // Remember the date we loaded from
        this.setState({ scheduleDate: date });
        this.persistScheduleDate(date);
      }
    }
  }

  handleScheduleDialogCancel() {
    this.setState({
      showScheduleDialog: false,
      scheduleDialogMode: null,
    });
  }

  // Save playlist to file - matching C# SavePlayListToFile
  async savePlaylistToFile() {
    const { currentPlaylist } = this.state;
    const playlistStr = currentPlaylist.toString();

    // Check if we're in Electron mode
    if (window.electronAPI?.savePlaylistFile) {
      const result = await window.electronAPI.savePlaylistFile(playlistStr);
      if (result.success) {
        console.info("Playlist", "Playlist saved to:", result.filePath);
      } else {
        console.error("Playlist", "Failed to save playlist", result.error);
        if (this.props.onError) {
          this.props.onError("SaveFailed", result.error || "Unknown error");
        }
      }
    } else {
      // Web mode - download as file
      const blob = new Blob([playlistStr], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "playlist.ppl";
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  // Load playlist from file - matching C# LoadPlaylistFromFile
  async loadPlaylistFromFile() {
    // Check if we're in Electron mode
    if (window.electronAPI?.loadPlaylistFile) {
      const result = await window.electronAPI.loadPlaylistFile();
      if (result.success && result.content) {
        this.loadPlaylistData(result.content);
      } else if (result.error) {
        console.error("Playlist", "Failed to load playlist", result.error);
        if (this.props.onError) {
          this.props.onError("LoadFailed", result.error || "Unknown error");
        }
      }
    } else {
      // Web mode - use file input
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".ppl";
      input.onchange = (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) {
          const reader = new FileReader();
          reader.onload = (e) => {
            const content = e.target?.result as string;
            this.loadPlaylistData(content);
          };
          reader.readAsText(file);
        }
      };
      input.click();
    }
  }

  // Load playlist data - matching C# LoadPlaylistData
  loadPlaylistData(data: string) {
    const playlist = this.loadPlaylistFromString(data);
    this.savePlaylist(playlist);
  }

  // Load playlist from string - matching C# LoadPlaylist
  loadPlaylistFromString(pls: string): Playlist {
    const playlist = Playlist.parse(pls);
    this.setState({
      currentPlaylist: playlist,
      selectedItems: new Set<number>(),
      focusedIndex: -1,
      selectionAnchor: -1,
    });
    return playlist;
  }

  handleKeyDown(e: KeyboardEvent) {
    const { selectedItems, currentPlaylist, focusedIndex } = this.state;
    const isSpaceKey = e.key === " " || e.key === "Spacebar";
    const pageStep = this.getPageNavigationStep();

    // Navigation keys - ArrowUp/ArrowDown for selection
    if (e.key === "ArrowUp" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.scheduleKeyboardArrowNavigation(-1, e.shiftKey);
      return;
    } else if (e.key === "ArrowDown" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.scheduleKeyboardArrowNavigation(1, e.shiftKey);
      return;
    } else if (e.key === "PageUp" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.scheduleKeyboardArrowNavigation(-pageStep, e.shiftKey);
      return;
    } else if (e.key === "PageDown" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.scheduleKeyboardArrowNavigation(pageStep, e.shiftKey);
      return;
    } else if (isSpaceKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.scheduleKeyboardArrowNavigation(e.shiftKey ? -pageStep : pageStep, e.shiftKey);
      return;
    } else if (e.key === "Home" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (currentPlaylist.items.length === 0) return;
      const baseIndex = focusedIndex >= 0 ? focusedIndex : currentPlaylist.items.length - 1;
      this.scheduleKeyboardArrowNavigation(-baseIndex, e.shiftKey);
      return;
    } else if (e.key === "End" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (currentPlaylist.items.length === 0) return;
      const baseIndex = focusedIndex >= 0 ? focusedIndex : 0;
      this.scheduleKeyboardArrowNavigation(currentPlaylist.items.length - 1 - baseIndex, e.shiftKey);
      return;
    }

    // The rest requires at least one item selected
    if (selectedItems.size === 0) return;

    const selectedIndex = this.getFirstSelectedIndex();
    if (selectedIndex === -1) return;

    // Ctrl+Up: Move item up
    if (e.ctrlKey && e.key === "ArrowUp") {
      e.preventDefault();
      this.handleMoveUp();
    }
    // Ctrl+Down: Move item down
    else if (e.ctrlKey && e.key === "ArrowDown") {
      e.preventDefault();
      this.handleMoveDown();
    }
    // Alt+Up: Transpose up
    else if (e.altKey && e.key === "ArrowUp") {
      e.preventDefault();
      this.handleTransposeUp();
    }
    // Alt+Down: Transpose down
    else if (e.altKey && e.key === "ArrowDown") {
      e.preventDefault();
      this.handleTransposeDown();
    }
    // Delete: Remove item
    else if (e.key === "Delete") {
      e.preventDefault();
      this.handleRemove();
    }
    // Ctrl+A: Select all (future enhancement if needed)
    else if (e.ctrlKey && e.key === "a") {
      e.preventDefault();
      // TODO: Implement select all if multi-select is added
    }
  }

  getSongTitle(item: PlaylistEntry): string {
    const song = this.props.songs.find((s) => s.Id === item.songId);
    if (!song) return item.title || "Unknown";

    return item.title || song.Title;
  }

  formatTranspose(val: number): string {
    if (val < 0) return "b" + Math.abs(val).toString();
    if (val > 0) return "#" + val.toString();
    return "";
  }

  formatCapo(val: number): string {
    return val >= 0 ? val.toString() : "";
  }

  // Calculate display mode for a song by analyzing its sections (matching C# UpdateSectionList logic)
  calculateSongDisplayMode(song: Song | undefined, settings: Settings | null, mask: number): DisplayMode {
    if (!song) return DisplayMode.Normal;

    // Create section generator if not exists
    if (!this.sectionGenerator) {
      this.sectionGenerator = new SectionGenerator();
    }

    // Prepare display settings (matching PreviewPanel settings)
    const displayWidth = 1280;
    const displayHeight = 720;

    // Calculate render rectangle with margins applied - matching C# UpdateDisplayArea logic
    const marginLeft = settings?.displayBorderRect?.left || 0;
    const marginRight = settings?.displayBorderRect?.width || 0; // right is stored as width
    const marginTop = settings?.displayBorderRect?.top || 0;
    const marginBottom = settings?.displayBorderRect?.height || 0; // bottom is stored as height

    const renderWidth = displayWidth - Math.floor((displayWidth * (marginLeft + marginRight)) / 100);
    const renderHeight = displayHeight - Math.floor((displayHeight * (marginTop + marginBottom)) / 100);

    const actualFontSize = SectionRenderer.calculateActualFontSize(settings?.displayFontSize || 16, displayWidth, displayHeight);

    const displaySettings: DisplaySettings = {
      fontFamily: settings?.displayFontName || "Arial",
      fontSize: actualFontSize,
      bold: settings?.displayFontBold || false,
      italic: settings?.displayFontItalic || false,
      underline: settings?.displayFontUnderline || false,
      alignment: settings?.displayFontAlign || "center",
      renderRectWidth: renderWidth,
      renderRectHeight: renderHeight,
      contentBasedSections: settings?.contentBasedSections ?? false,
      checkSectionsProjectable: settings?.checkSectionsProjectable ?? true,
      allowFontSizeReduction: settings?.displayAllowFontSizeReduction ?? true,
      displayFaultThreshold: settings?.displayFaultThreshold ?? 10,
      nonSplittingWords: settings?.useNonSplittingWords ? (settings?.nonSplittingWordList ?? []) : [],
      displayMinimumFontSize: settings?.displayMinimumFontSize || 0,
      displayMinimumFontSizePercent: settings?.displayMinimumFontSizePercent || 70,
    };

    // Generate sections (don't apply instructions for playlist - matches C# logic)
    const sections = this.sectionGenerator.updateSectionList(song, displaySettings, false, "");

    // Find highest display mode (matching C# logic: if ((nModeMask & (int)mode) != 0 && songMode < mode) songMode = mode;)
    let maxMode = DisplayMode.Normal;
    for (const section of sections) {
      let sectionMode = DisplayMode.Normal;

      // Determine section mode based on label
      if (section.label === null) {
        sectionMode = DisplayMode.Crops;
      } else if (section.label === "") {
        sectionMode = DisplayMode.Shrink;
      }

      // Only consider this mode if it matches the mask
      if ((mask & sectionMode) !== 0 && maxMode < sectionMode) {
        maxMode = sectionMode;
        if (maxMode === DisplayMode.Crops) {
          break; // Crops is the highest mode, no need to continue
        }
      }
    }

    return maxMode;
  }

  private sectionGenerator: SectionGenerator | null = null;

  // Get background color for display mode (matching C# StateColor logic)
  getStateColor(mode: DisplayMode, settings: Settings | null): string {
    if (!settings) return "transparent";
    switch (mode) {
      case DisplayMode.Crops:
        return settings.checkSectionsProjectable ? settings.displayCroppedTextBgColor || "transparent" : "transparent";
      case DisplayMode.Shrink:
        // Check if font reduction should be shown in playlist
        return settings.displayShowFontSizeReduction === "BOTH" || settings.displayShowFontSizeReduction === "PLAYLIST"
          ? settings.displayShrinkedTextBgColor || "transparent"
          : "transparent";
      default:
      case DisplayMode.Normal:
        return "transparent";
    }
  }

  // Timer tick handler - processes ONE item per tick (matching C# OnPlaylistDisplayCheckTimerTick)
  onPlaylistDisplayCheckTimerTick = () => {
    const { currentPlaylist } = this.state;
    const items = currentPlaylist.items;

    // Get settings from localStorage
    const settingsJson = localStorage.getItem("pp-settings");
    const settings = settingsJson
      ? JSON.parse(settingsJson)
      : {
          checkSectionsProjectable: true,
          displayShowFontSizeReduction: "BOTH",
          displayCroppedTextBgColor: "#de9191",
          displayShrinkedTextBgColor: "#fffa9e",
          displayPlaylistUpdateInterval: 100,
        };

    // Calculate mask to determine what to check (matching C# logic)
    let mask = 0;
    if (settings.checkSectionsProjectable) {
      mask |= DisplayMode.Crops; // Add Crops bit to mask
    }
    const showFontReduction = settings.displayShowFontSizeReduction === "BOTH" || settings.displayShowFontSizeReduction === "PLAYLIST";
    if (showFontReduction) {
      mask |= DisplayMode.Shrink; // Add Shrink bit to mask
    }

    // Process unchecked items (matching C# foreach loop with checkedPlayListItems check)
    for (let index = 0; index < items.length; index++) {
      if (!this.checkedPlayListItems.has(index)) {
        const item = items[index];
        const song = this.props.songs.find((s) => s.Id === item.songId);

        const mode = this.calculateSongDisplayMode(song, settings, mask);
        const color = this.getStateColor(mode, settings);

        this.setState((prevState) => {
          const newColors = new Map(prevState.itemColors);
          newColors.set(index, color);
          return { itemColors: newColors };
        });

        this.checkedPlayListItems.add(index);

        // Process only ONE item per tick, then return (matching C# logic)
        if (mask !== 0) return;
      }
    }

    // All items processed, stop timer (matching C# logic)
    if (this.colorUpdateTimer) {
      clearInterval(this.colorUpdateTimer);
      this.colorUpdateTimer = null;
    }
  };

  // Start/restart playlist coloring update (matching C# UpdatePlaylistItemStates)
  updatePlaylistItemStates() {
    const { currentPlaylist } = this.state;

    if (currentPlaylist.items.length > 0) {
      // Clear checked items and restart timer
      this.checkedPlayListItems.clear();

      // Stop existing timer
      if (this.colorUpdateTimer) {
        clearInterval(this.colorUpdateTimer);
      }

      // Get update interval from settings
      const settingsJson = localStorage.getItem("pp-settings");
      const settings = settingsJson ? JSON.parse(settingsJson) : { displayPlaylistUpdateInterval: 100 };
      const interval = settings.displayPlaylistUpdateInterval || 100;

      // Start new timer
      this.colorUpdateTimer = setInterval(this.onPlaylistDisplayCheckTimerTick, interval);
    }
  }

  render() {
    const {
      currentPlaylist,
      selectedItems,
      focusedIndex,
      editingIndex,
      showInstructionsEditor,
      editingInstructions,
      showScheduleDialog,
      scheduleDialogMode,
      contextMenu,
    } = this.state;

    const isDisabled = this.props.disabled || false;
    const hasSelection = selectedItems.size > 0;
    const canMoveUp = hasSelection && this.getFirstSelectedIndex() > 0;
    const canMoveDown = hasSelection && this.getLastSelectedIndex() < currentPlaylist.items.length - 1;
    const t = this.props.t || ((key: string) => key);
    const contextTargetItem = contextMenu ? currentPlaylist.items[contextMenu.targetIndex] : null;

    const currentTranspose = contextTargetItem?.transpose ?? 0;
    const currentCapo = contextTargetItem?.capo ?? -1;

    const contextMenuItems: ContextMenuItem[] = contextMenu
      ? [
          { label: t("PlaylistMoveUp"), value: "move_up", disabled: isDisabled || !canMoveUp, iconClass: "fa fa-arrow-up" },
          { label: t("PlaylistMoveDown"), value: "move_down", disabled: isDisabled || !canMoveDown, iconClass: "fa fa-arrow-down" },
          {
            label: "",
            value: "_transpose",
            customContent: (
              <>
                <i className="context-menu-icon fa fa-music" aria-hidden="true"></i>
                {t("Transpose")}
                <select
                  className="context-menu-select"
                  title="Transpose"
                  value={currentTranspose}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    this.handleSetTranspose(val);
                    this.hideContextMenu();
                  }}
                >
                  {Array.from({ length: 23 }, (_, i) => {
                    const val = 11 - i;
                    const label = val > 0 ? `#${val}` : val < 0 ? `b${Math.abs(val)}` : "0";
                    return (
                      <option key={val} value={val}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </>
            ),
          },
          {
            label: "",
            value: "_capo",
            customContent: (
              <>
                <i className="context-menu-icon fa fa-caret-up" aria-hidden="true"></i>
                {t("Capo")}
                <select
                  className="context-menu-select"
                  title="Capo"
                  value={currentCapo}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    this.handleSetCapo(val);
                    this.hideContextMenu();
                  }}
                >
                  <option value={-1}>-</option>
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i} value={i}>
                      {i}
                    </option>
                  ))}
                </select>
              </>
            ),
          },
          { label: t("PlaylistEditTitle"), value: "edit", disabled: isDisabled || !hasSelection, iconClass: "fa fa-pencil" },
          { label: t("PlaylistEditInstructions"), value: "instructions", disabled: isDisabled || !hasSelection, iconClass: "fa fa-sticky-note-o" },
          { label: t("PlaylistRemove"), value: "remove", disabled: isDisabled || !hasSelection, iconClass: "fa fa-trash" },
        ]
      : [];

    return (
      <PlaylistDropTarget addSongToPlaylist={this.addSongToPlaylist}>
        <div className="playlist-panel-container h-100">
          <div className="playlist-body d-flex h-100">
            <div className="btn-group-vertical playlist-buttons mr-2">
              <button
                className="btn btn-light"
                aria-label="Load Playlist"
                title={this.props.tt("playlist_load")}
                onClick={this.handleLoadPlaylist}
                disabled={isDisabled}
              >
                <Icon type={IconType.LOAD} />
              </button>
              <button
                className="btn btn-light"
                aria-label="Save Playlist"
                title={this.props.tt("playlist_save")}
                onClick={this.handleSavePlaylist}
                disabled={isDisabled}
              >
                <Icon type={IconType.SAVE} />
              </button>
              <button
                className="btn btn-light"
                aria-label="Move Up"
                title={this.props.tt("playlist_move_up")}
                onClick={this.handleMoveUp}
                disabled={isDisabled || !canMoveUp}
              >
                <Icon type={IconType.MOVE_UP} />
              </button>
              <button
                className="btn btn-light"
                aria-label="Move Down"
                title={this.props.tt("playlist_move_down")}
                onClick={this.handleMoveDown}
                disabled={isDisabled || !canMoveDown}
              >
                <Icon type={IconType.MOVE_DOWN} />
              </button>
              <button
                className="btn btn-light"
                aria-label="Transpose Up"
                title={this.props.tt("playlist_transpose_up")}
                onClick={this.handleTransposeUp}
                disabled={isDisabled || !hasSelection}
              >
                <Icon type={IconType.TRANSPOSE_UP} />
              </button>
              <button
                className="btn btn-light"
                aria-label="Transpose Down"
                title={this.props.tt("playlist_transpose_down")}
                onClick={this.handleTransposeDown}
                disabled={isDisabled || !hasSelection}
              >
                <Icon type={IconType.TRANSPOSE_DOWN} />
              </button>
              <button
                className="btn btn-light"
                aria-label="Capo Up"
                title={this.props.tt("playlist_capo_up")}
                onClick={this.handleCapoUp}
                disabled={isDisabled || !hasSelection}
              >
                <Icon type={IconType.CAPO_UP} />
              </button>
              <button
                className="btn btn-light"
                aria-label="Capo Down"
                title={this.props.tt("playlist_capo_down")}
                onClick={this.handleCapoDown}
                disabled={isDisabled || !hasSelection}
              >
                <Icon type={IconType.CAPO_DOWN} />
              </button>
              <button
                className="btn btn-light"
                aria-label="Remove"
                title={this.props.tt("playlist_remove")}
                onClick={this.handleRemove}
                disabled={isDisabled || !hasSelection}
              >
                <Icon type={IconType.REMOVE} />
              </button>
              <button
                className="btn btn-light"
                aria-label="Edit"
                title={this.props.tt("playlist_edit")}
                onClick={this.handleEdit}
                disabled={isDisabled || !hasSelection}
              >
                <Icon type={IconType.EDIT} />
              </button>
              <button
                className="btn btn-light"
                aria-label="Add"
                title={this.props.tt("playlist_add")}
                onClick={this.handleAddFromList}
                disabled={isDisabled}
              >
                <Icon type={IconType.ADD} />
              </button>
            </div>
            <div
              ref={this.playlistContainerRef}
              className={`playlist-items-container flex-grow-1 overflow-auto${isDisabled ? " disabled" : ""}`}
              tabIndex={isDisabled ? -1 : 0}
              onKeyDown={(e) => !isDisabled && this.handleKeyDown(e.nativeEvent)}
              onFocus={() => {
                if (isDisabled) return;
                // Auto-focus and select first item if nothing is focused
                if (this.state.focusedIndex === -1 && this.state.currentPlaylist.items.length > 0) {
                  this.setState({
                    selectedItems: new Set<number>([0]),
                    focusedIndex: 0,
                    selectionAnchor: 0,
                  });
                  const firstItem = this.state.currentPlaylist.items[0];
                  this.emitPlaylistSelectionChange(firstItem, 0, "programmatic", true);
                }
              }}
            >
              <table className="table table-sm table-hover playlist-table">
                <thead ref={this.headerRef}>
                  <tr>
                    <th>{this.props.t("Title")}</th>
                    <th>{this.props.t("TransposeShort")}</th>
                    <th>{this.props.t("CapoShort")}</th>
                    <th>{this.props.t("InstructionsShort")}</th>
                  </tr>
                </thead>
                <tbody>
                  {currentPlaylist?.items.map((item: PlaylistEntry, index: number) => (
                    <PlaylistItemRow
                      key={item.songId + "-" + index}
                      index={index}
                      item={item}
                      title={this.getSongTitle(item)}
                      transpose={this.formatTranspose(item.transpose)}
                      capo={this.formatCapo(item.capo)}
                      hasInstructions={!!item.instructions}
                      isSelected={selectedItems.has(index)}
                      isFocused={index === focusedIndex}
                      isEditing={index === editingIndex}
                      backgroundColor={this.state.itemColors.get(index) || "transparent"}
                      onClick={(event) => this.handleItemClick(index, event)}
                      onContextMenu={(event) => this.handleItemContextMenu(index, event)}
                      moveItem={this.movePlaylistItem}
                      onTitleChange={(newTitle) => this.handleTitleChange(index, newTitle)}
                      onTitleBlur={this.handleTitleBlur}
                      onTitleEdit={() => this.setState({ editingIndex: index })}
                      onInstructionsClick={() => this.handleInstructionsClick(index)}
                      headerRef={this.headerRef}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {contextMenu && (
            <ContextMenu
              items={contextMenuItems}
              position={contextMenu.position}
              onSelect={(value) => {
                if (value.startsWith("transpose_set:")) {
                  const newVal = parseInt(value.split(":")[1], 10);
                  this.handleSetTranspose(newVal);
                } else if (value.startsWith("capo_set:")) {
                  const newVal = parseInt(value.split(":")[1], 10);
                  this.handleSetCapo(newVal);
                } else
                  switch (value) {
                    case "remove":
                      this.handleRemove();
                      break;
                    case "move_up":
                      this.handleMoveUp();
                      break;
                    case "move_down":
                      this.handleMoveDown();
                      break;
                    case "edit":
                      this.setState({ editingIndex: contextMenu.targetIndex });
                      break;
                    case "instructions":
                      this.handleInstructionsClick(contextMenu.targetIndex);
                      break;
                  }
              }}
              onClose={this.hideContextMenu}
            />
          )}
          {showInstructionsEditor && editingInstructions && (
            <InstructionsEditorForm
              song={this.props.songs.find((s) => s.Id === editingInstructions.item.songId)!}
              initialInstructions={editingInstructions.item.instructions}
              isInProfile={false}
              onSave={this.handleInstructionsSave}
              onClose={this.handleInstructionsClose}
            />
          )}
          {showScheduleDialog && scheduleDialogMode && this.props.selectedLeader && (
            <ScheduleDialog
              leader={this.props.selectedLeader}
              mode={scheduleDialogMode}
              onConfirm={this.handleScheduleDateSelected}
              onCancel={this.handleScheduleDialogCancel}
              initialDate={this.state.scheduleDate}
            />
          )}
        </div>
      </PlaylistDropTarget>
    );
  }
}

// Playlist Item Row with drag-drop support
const PlaylistItemRow: React.FC<{
  index: number;
  item: PlaylistEntry;
  title: string;
  transpose: string;
  capo: string;
  hasInstructions: boolean;
  isSelected: boolean;
  isFocused: boolean;
  isEditing: boolean;
  backgroundColor: string;
  onClick: (event: React.MouseEvent<HTMLTableRowElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLTableRowElement>) => void;
  moveItem: (dragIndex: number, hoverIndex: number) => void;
  onTitleChange: (newTitle: string) => void;
  onTitleBlur: () => void;
  onTitleEdit: () => void;
  onInstructionsClick: () => void;
  headerRef: React.RefObject<HTMLTableSectionElement>;
}> = ({
  index,
  item: _item,
  title,
  transpose,
  capo,
  hasInstructions,
  isSelected,
  isFocused,
  isEditing,
  backgroundColor,
  onClick,
  onContextMenu,
  moveItem,
  onTitleChange,
  onTitleBlur,
  onTitleEdit,
  onInstructionsClick,
  headerRef,
}) => {
  const ref = React.useRef<HTMLTableRowElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [editValue, setEditValue] = React.useState(title);
  const [isInstructionsHovered, setIsInstructionsHovered] = React.useState(false);
  const clickTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const confirmingRef = React.useRef(false);
  const { t } = useLocalization();
  const { tt } = useTooltips();

  React.useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  React.useEffect(() => {
    setEditValue(title);
  }, [title]);

  React.useEffect(() => {
    if (isFocused && ref.current) {
      const headerHeight = headerRef.current ? headerRef.current.offsetHeight : 0;
      ref.current.style.scrollMarginTop = `${headerHeight}px`;
      ref.current.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }, [isFocused]);

  const [{ isDragging }, drag] = useDrag(() => ({
    type: "playlist-item",
    item: { index },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  }));

  const [, drop] = useDrop(() => ({
    accept: "playlist-item",
    hover: (draggedItem: { index: number }) => {
      if (draggedItem.index !== index) {
        moveItem(draggedItem.index, index);
        draggedItem.index = index;
      }
    },
  }));

  // Combine drag and drop refs using a callback ref to avoid accessing ref.current during render
  const dragDropRef = React.useCallback(
    (node: HTMLTableRowElement | null) => {
      ref.current = node;
      drag(drop(node));
    },
    [drag, drop]
  );

  const cellStyle = backgroundColor !== "transparent" ? { backgroundColor, color: getContrastTextColor(backgroundColor) } : undefined;

  // Create combined class names for different states
  const rowClasses = ["playlist-row", isSelected ? "table-active" : "", isFocused ? "playlist-focused" : "", isDragging ? "dragging" : ""]
    .filter(Boolean)
    .join(" ");

  const handleConfirmEdit = () => {
    confirmingRef.current = true;
    onTitleChange(editValue);
    onTitleBlur();
  };

  const handleCancelEdit = () => {
    setEditValue(title);
    onTitleBlur();
  };

  const handleBlur = () => {
    // Use setTimeout to allow click events to fire first
    setTimeout(() => {
      if (!confirmingRef.current) {
        // Auto-cancel if not confirming
        handleCancelEdit();
      }
      confirmingRef.current = false;
    }, 100);
  };

  const headerHeight = headerRef.current ? headerRef.current.offsetHeight : 0;

  const cellStyleWithMargin = {
    ...cellStyle,
    scrollMarginTop: `${headerHeight}px`,
  };

  return (
    <tr
      ref={dragDropRef}
      className={rowClasses}
      style={cellStyleWithMargin}
      onClick={(e) => onClick(e)}
      onContextMenu={onContextMenu}
      title={tt("playlist")}
    >
      {isEditing ? (
        <td colSpan={4} style={cellStyle} className="playlist-edit-cell">
          <div className="playlist-edit-container">
            <input
              ref={inputRef}
              type="text"
              className="form-control form-control-sm playlist-edit-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleConfirmEdit();
                } else if (e.key === "Escape") {
                  handleCancelEdit();
                }
              }}
              onBlur={handleBlur}
              onClick={(e) => e.stopPropagation()}
              aria-label="Edit song title"
              placeholder={t("EnterSongTitlePlaceholder")}
            />
            <button type="button" className="btn btn-success btn-sm playlist-edit-confirm" onClick={handleConfirmEdit} title="Confirm changes">
              ✅
            </button>
          </div>
        </td>
      ) : (
        <>
          {}
          <td
            style={cellStyle}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onTitleEdit();
            }}
          >
            {title}
          </td>
          <td className="text-center" style={cellStyle}>
            {transpose}
          </td>
          <td className="text-center" style={cellStyle}>
            {capo}
          </td>
          <td
            className="text-center instructions-cell"
            style={cellStyle}
            onMouseEnter={() => setIsInstructionsHovered(true)}
            onMouseLeave={() => setIsInstructionsHovered(false)}
            onClick={(e) => {
              e.stopPropagation();

              // Detect if this is a touch device by checking for touch events
              const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;

              if (isTouchDevice) {
                // For touch devices: single tap opens editor immediately
                onInstructionsClick();
              } else {
                // For desktop: wait to see if this is a double-click
                if (clickTimeoutRef.current) {
                  // This is the second click - it's a double-click
                  clearTimeout(clickTimeoutRef.current);
                  clickTimeoutRef.current = null;
                } else {
                  // First click - wait to see if there's a second click
                  clickTimeoutRef.current = setTimeout(() => {
                    clickTimeoutRef.current = null;
                    // Single click - do nothing for desktop
                  }, 300);
                }
              }
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              // Double-click for desktop - opens editor
              if (clickTimeoutRef.current) {
                clearTimeout(clickTimeoutRef.current);
                clickTimeoutRef.current = null;
              }
              onInstructionsClick();
            }}
          >
            {(hasInstructions || isInstructionsHovered) && (
              <span className="instructions-icon">
                <Icon type={hasInstructions ? IconType.CHECKBOX_CHECKED : IconType.CHECKBOX_EMPTY} />
              </span>
            )}
          </td>
          {}
        </>
      )}
    </tr>
  );
};

const PlaylistDropTarget: React.FC<{
  children: React.ReactNode;
  addSongToPlaylist: (song: Song) => void;
}> = ({ children, addSongToPlaylist }) => {
  const [, drop] = useDrop(() => ({
    accept: "song",
    drop: (item: Song) => {
      addSongToPlaylist(item);
    },
  }));

  return (
    <div ref={drop} className="h-100 w-100">
      {children}
    </div>
  );
};

// HOC to inject tooltips into class component with ref forwarding
const PlaylistPanelWithTooltips = React.forwardRef<PlaylistPanelMethods, Omit<PlaylistPanelProps, "tt" | "t" | "showConfirm" | "updatePlaylist">>(
  (props, ref) => {
    const { tt } = useTooltips();
    const { t } = useLocalization();
    const { showConfirm } = useMessageBox();
    return <PlaylistPanel {...props} tt={tt} t={t} showConfirm={showConfirm} ref={ref as React.Ref<PlaylistPanel>} />;
  }
);

PlaylistPanelWithTooltips.displayName = "PlaylistPanelWithTooltips";

export default PlaylistPanelWithTooltips;
