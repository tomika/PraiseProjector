import React from "react";
import { Song } from "../../db-common/Song";
import "./EditorPanel.css";
import { subscribeEditedSong } from "../state/CurrentSongStore";
import { Settings } from "../types";
import ChordProEditorWithLocalization, { ChordProEditor } from "./ChordProEditor/ChordProEditor";

interface EditorPanelProps {
  song: Song | null;
  onLineSelect?: (lineNumber: number) => void;
  onEditModeChange?: (isEditing: boolean) => void;
  onTextChange?: (newText: string) => void;
  settings?: Settings | null;
  setProjectedSongText?: (newSongText: string) => void;
  // Called before entering edit mode - return Promise<boolean> to allow/cancel
  onBeforeEnterEditMode?: () => Promise<boolean>;
  // Called after leaving edit mode with the current text - parent can decide to prompt save.
  // Return false to cancel exit and stay in edit mode (e.g. title is missing).
  onAfterLeaveEditMode?: (currentText: string, originalText: string) => Promise<boolean | void>;
  // Original song text for comparison (to detect changes)
  originalText?: string;
}

interface EditorPanelState {
  song: Song | null;
}

/**
 * EditorPanel - Main editor container
 * Contains only the wrapper logic, all editing functionality is in ChordProEditor
 */
class EditorPanel extends React.Component<EditorPanelProps, EditorPanelState> {
  private chordProEditorRef: ChordProEditor | null = null;
  private unsubscribeCurrentSong: (() => void) | null = null;

  constructor(props: EditorPanelProps) {
    super(props);
    this.state = {
      song: props.song,
    };
  }

  componentDidMount() {
    this.unsubscribeCurrentSong = subscribeEditedSong(this.handleCurrentSongChange);
  }

  componentDidUpdate(prevProps: EditorPanelProps) {
    if (prevProps.song !== this.props.song) {
      this.setState({ song: this.props.song });
    }
  }

  componentWillUnmount() {
    this.unsubscribeCurrentSong?.();
  }

  private handleCurrentSongChange = (song: Song | null) => {
    // Update state when edited song changes in store
    if (song?.Id === this.props.song?.Id) {
      this.setState({ song });
    }
  };

  public highlightSectionInEditor(from: number, to: number) {
    this.chordProEditorRef?.highlightSectionInEditor(from, to);
  }

  public getCurrentLyrics() {
    return this.chordProEditorRef?.getCurrentLyrics() ?? "";
  }

  public leaveEditMode(skipPrompt = false) {
    this.chordProEditorRef?.leaveEditMode(skipPrompt);
  }

  public enterEditMode() {
    this.chordProEditorRef?.enterEditMode();
  }

  /**
   * Refresh the display when the editor becomes visible after being hidden.
   * Call this when switching to the editor tab in paging mode.
   */
  public refreshDisplay() {
    this.chordProEditorRef?.refreshDisplay();
  }

  public focusMetaTitle() {
    this.chordProEditorRef?.focusMetaTitle();
  }

  render() {
    const { song } = this.state;
    const {
      onLineSelect,
      onEditModeChange,
      settings,
      setProjectedSongText,
      onTextChange,
      onBeforeEnterEditMode,
      onAfterLeaveEditMode,
      originalText,
    } = this.props;

    return (
      <div className="editor-panel-wrapper">
        <ChordProEditorWithLocalization
          ref={(ref) => {
            this.chordProEditorRef = ref as unknown as ChordProEditor;
          }}
          song={song}
          onLineSelect={onLineSelect}
          onEditModeChange={onEditModeChange}
          settings={settings}
          setProjectedSongText={setProjectedSongText}
          onTextChange={onTextChange}
          onBeforeEnterEditMode={onBeforeEnterEditMode}
          onAfterLeaveEditMode={onAfterLeaveEditMode}
          originalText={originalText}
        />
      </div>
    );
  }
}

export default EditorPanel;
