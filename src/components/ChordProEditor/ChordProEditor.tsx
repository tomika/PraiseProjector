import React from "react";
import { Song } from "../../classes/Song";
import { Icon, IconType } from "../../services/IconService";
import { ensureChordProAssets } from "../../utils/loadChordProAssets";
import { Settings } from "../../types";
import { useLocalization, StringKey } from "../../localization/LocalizationContext";
import { Database } from "../../classes/Database";
import "./ChordProEditor.css";

interface ChordProEditorProps {
  song: Song | null;
  onLineSelect?: (lineNumber: number) => void;
  onEditModeChange?: (isEditing: boolean) => void;
  settings?: Settings | null;
  setProjectedSongText?: (newLyrics: string) => void;
  onTextChange?: (newText: string) => void; // For import wizard
  initialEditMode?: boolean; // Start in edit mode
  compareBase?: string; // For diff view - pass the base song text to compare against
  previewOnly?: boolean; // Hide tabs and toolbar, like C# PreviewOnly()
  // Called before entering edit mode - return Promise<boolean> to allow/cancel, or just await for sync confirmation
  onBeforeEnterEditMode?: () => Promise<boolean>;
  // Called after leaving edit mode with the current text - parent can decide to prompt save.
  // Return false to cancel exit and stay in edit mode (e.g. title is missing).
  onAfterLeaveEditMode?: (currentText: string, originalText: string) => Promise<boolean | void>;
  // Original song text for comparison (to detect changes)
  originalText?: string;
  t?: (key: StringKey) => string; // Localization function injected by HOC
}

interface ChordProEditorState {
  activeTab: "wysiwyg" | "meta" | "chordpro";
  chordProText: string;
  metaData: Map<string, string>;
}

type ChordProExternalCallbacks = {
  OnLineSel: (lineNumber: number) => void;
  UpdateChordProData: (newText: string) => void;
  LogFromWebEditor: (message: string) => void;
  OnLineDblclk: (lineNumber: number) => void;
  OnCopy: (chordpro: string) => boolean;
  OnPaste: () => string;
};

const CHORD_PRO_MARKUP = `
    <div style="outline: none; position: relative;"></div>
    <div id="chordsel" class="chordSelector" style="display: none;">
        <table style="width: 100%">
            <tr>
                <td colspan="4">
                    <div id="closeSelector" style="float:right; width:auto; cursor: pointer;">X</div>
                </td>
            </tr>
            <tr>
                <td>Base&nbsp;note</td>
                <td>
                    <select id="baseNoteSel"></select>
                </td>
                <td>&nbsp;&nbsp;Bass&nbsp;note</td>
                <td>
                    <select id="bassNoteSel"></select>
                </td>
            </tr>
            <tr>
                <td>Chord</td>
                <td colspan="3">
                    <div>
                        <label id="customSpan" for="modifier"></label>
                        <select id="modifier"></select>
                    </div>
                </td>
            </tr>
            <tr>
                <td>Symbol</td>
                <td colspan="3">
                    <input id="subscript" type="text" />
                </td>
            </tr>
            <tr>
                <td>Steps</td>
                <td colspan="3">
                    <div>
                        <label for="steps">1-</label>
                        <input id="steps" type="text" />
                    </div>
                </td>
            </tr>
            <tr>
                <td>Notes</td>
                <td colspan="3">
                    <div>
                        <label id="baseNoteSpan"></label>
                        <input id="notes" type="text" />
                    </div>
                </td>
            </tr>
        </table>
        <table style="width: 100%;">
            <tr>
                <td style="height: 100px; width: 30%;">
                    <div id="musicChordBox" style="max-width:100px; display: block;"></div>
                    <input type="button" id="applySelector" value="OK">
                </td>
                <td style="height: 100px; width: 42%;">
                    <canvas id="pianoChordBox"></canvas>
                </td>
                <td style="height: 100px; width: 28%;">
                    <canvas id="guitarChordBox"></canvas>
                </td>
            </tr>
        </table>
    </div>
    <div id="instructionsEditor" class="instructions-editor-panes hidden" style="height: calc(100vh - 26px);">
        <div class="song-editor" id="ies-song"></div>
        <div class="instructions-editor-separator" id="ies-left">&nbsp;</div>
        <div class="instructions-editor" id="ies-list"></div>
        <div class="instructions-editor-separator" id="ies-right">&nbsp;</div>
        <div class="song-editor" id="ies-preview"></div>
    </div>
`;

class ChordProEditor extends React.Component<ChordProEditorProps, ChordProEditorState> {
  private chordProHost: HTMLDivElement | null = null;
  private hasLoadedDocument = false;
  private wysiwygLoaded = false;
  private wysiwygInitialized = false;
  private isEditable = false;
  private externalPreviousValues: Map<keyof ChordProExternalCallbacks, unknown> | null = null;
  private externalObjectCreated = false;
  private initializingChordPro = false;
  private skipNextWysiwygSync = false;
  private pendingHighlight: { from: number; to: number } | null = null;
  private themeObserver: MutationObserver | null = null;
  private fontSizeObserver: MutationObserver | null = null;
  private lastObservedFontSize: string | null = null;
  private titleInputRef: HTMLInputElement | null = null;

  constructor(props: ChordProEditorProps) {
    super(props);
    this.state = {
      activeTab: "wysiwyg",
      chordProText: "",
      metaData: new Map(),
    };
    this.isEditable = props.initialEditMode ?? false;
  }

  componentDidMount() {
    this.loadSong();
    this.prepareWysiwygHost();
    this.setupThemeObserver();
    this.setupFontSizeObserver();
  }

  componentDidUpdate(prevProps: ChordProEditorProps) {
    this.prepareWysiwygHost();

    // Check if song changed (different object or different text content)
    const songChanged = prevProps.song !== this.props.song || prevProps.song?.Text !== this.props.song?.Text;

    if (songChanged) {
      // Only leave edit mode if we're not in initialEditMode (wizard scenario)
      if (this.isEditable && !this.props.initialEditMode) {
        this.leaveEditMode();
      }
      this.hasLoadedDocument = false; // Reset for new song
      this.wysiwygInitialized = false; // Reset initialization flag
      const chordProText = this.loadSong();
      // Only try to load to WYSIWYG if it's loaded and we have a host element
      if (this.wysiwygLoaded && this.chordProHost) {
        this.loadSongToWysiwyg(chordProText);
      }
      // Re-enable edit mode if needed after loading
      if (this.props.initialEditMode && !this.isEditable) {
        this.enterEditMode();
      }
    }

    // Check if hideChordsInReadonlyEditor setting changed
    const hideChordsSetting = prevProps.settings?.hideChordsInReadonlyEditor !== this.props.settings?.hideChordsInReadonlyEditor;
    if (hideChordsSetting && !this.isEditable) {
      // Only update if we're in readonly mode (edit mode always shows chords)
      this.updateDisplay();
    }
  }

  componentWillUnmount() {
    this.restoreExternalCallbacks();
    this.cleanupThemeObserver();
    this.cleanupFontSizeObserver();
    const api = this.getChordProAPI();
    api?.dispose?.();
  }

  private setupThemeObserver() {
    // Watch for theme changes on the document element
    this.themeObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes" && mutation.attributeName === "data-theme") {
          this.applyDarkModeToEditor();
        }
      }
    });
    this.themeObserver.observe(document.documentElement, { attributes: true });
    // Apply initial dark mode state
    this.applyDarkModeToEditor();
  }

  private cleanupThemeObserver() {
    if (this.themeObserver) {
      this.themeObserver.disconnect();
      this.themeObserver = null;
    }
  }

  private setupFontSizeObserver() {
    this.lastObservedFontSize = document.documentElement.style.fontSize;
    this.fontSizeObserver = new MutationObserver(() => {
      const current = document.documentElement.style.fontSize;
      if (current !== this.lastObservedFontSize) {
        this.lastObservedFontSize = current;
        const api = this.getChordProAPI();
        api?.refreshDisplayProps?.();
      }
    });
    this.fontSizeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  }

  private cleanupFontSizeObserver() {
    if (this.fontSizeObserver) {
      this.fontSizeObserver.disconnect();
      this.fontSizeObserver = null;
    }
  }

  private applyDarkModeToEditor() {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const api = this.getChordProAPI();
    if (api && api.darkMode) {
      api.darkMode(isDark);
      // On mobile, the editor may need an additional call after a microtask
      // to ensure the dark mode is applied after all pending DOM updates
      queueMicrotask(() => {
        const stillDark = document.documentElement.getAttribute("data-theme") === "dark";
        if (stillDark !== isDark && api.darkMode) {
          // Theme changed during microtask, reapply
          api.darkMode(stillDark);
        }
      });
    }
  }

  private async prepareWysiwygHost() {
    if (this.initializingChordPro || !this.chordProHost) {
      return;
    }

    this.initializingChordPro = true;
    try {
      this.initializeChordProMarkup(this.chordProHost);
      await ensureChordProAssets();
      if (!this.getChordProAPI()) {
        console.error("Editor", "ChordPro API did not initialise as expected.");
        return;
      }
      await this.handleWysiwygLoad();
    } catch (error) {
      console.error("Editor", "Failed to prepare ChordPro editor host", error);
    } finally {
      this.initializingChordPro = false;
    }
  }

  private initializeChordProMarkup(container: HTMLDivElement) {
    if (container.dataset.initialised === "true") {
      return;
    }

    container.innerHTML = CHORD_PRO_MARKUP;
    container.dataset.initialised = "true";
  }

  private restoreExternalCallbacks() {
    if (!this.externalPreviousValues) {
      return;
    }

    const win = window as unknown as { external?: Record<string, unknown> };
    const external = win.external;
    if (external && typeof external === "object") {
      this.externalPreviousValues.forEach((value, key) => {
        if (value === undefined) {
          delete external[key as string];
        } else {
          external[key as string] = value;
        }
      });
    }

    if (this.externalObjectCreated) {
      try {
        win.external = undefined;
      } catch {
        /* ignore */
      }
    }

    this.externalPreviousValues = null;
    this.externalObjectCreated = false;
  }

  private setChordProHostRef = (element: HTMLDivElement | null) => {
    this.chordProHost = element;
    if (element) {
      this.prepareWysiwygHost();
    }
  };

  private getChordProAPI(): ChordProAPI | undefined {
    return typeof window !== "undefined" ? window.chordProAPI : undefined;
  }

  loadSong() {
    const { song } = this.props;

    // If we have a song prop, use it directly (e.g., for import wizard)
    const chordProText = song?.Text ?? "";
    const metaData = this.extractMetaData(chordProText);

    this.skipNextWysiwygSync = false;
    this.setState({
      chordProText,
      metaData,
    });
    return chordProText;
  }

  extractMetaData(text: string): Map<string, string> {
    const metaData = new Map<string, string>();
    const rxMetaData = /^[ \t]*{([^\n:]+)[:]([^\n}]*)}[ \t\r]*$/gm;

    let match;
    while ((match = rxMetaData.exec(text)) !== null) {
      const key = match[1].trim();
      const value = match[2].trim();
      metaData.set(key, value);
    }

    return metaData;
  }

  handleWysiwygLoad = async () => {
    if (this.wysiwygLoaded) {
      if (this.skipNextWysiwygSync) {
        this.skipNextWysiwygSync = false;
        return;
      }
      this.loadSongToWysiwyg();
      this.skipNextWysiwygSync = false;
      return;
    }

    this.wysiwygLoaded = true;

    // Initialize database with known chord modifiers from editor
    try {
      const chordApi = this.getChordProAPI();
      if (chordApi) {
        const chordPattern = chordApi.getChordFindAndSplitPattern?.();
        const modifiersList = chordApi.getAllKnownChordModifier?.();

        console.debug("Editor", "Chord pattern:", chordPattern);
        console.debug("Editor", "Known modifiers count:", modifiersList ? modifiersList.split("\n").length : 0);

        // Database initialization would happen here
        // For now just log that we have the data
        const _db = Database.getInstance();
        // _db.loadKnownChordModifiers(chordPattern, modifiersList.split('\n'));
        console.debug("Editor", "Database ready with editor chord data");

        // Setup callback handlers for editor events
        this.setupEditorCallbacks();

        // Install locale handler for context menu strings — reads this.props.t
        // on each call so it picks up language changes without reinstalling.
        chordApi.installLocaleHandler?.((s: string) => {
          const key = ("ChpMenu" + s.replace(/ /g, "")) as StringKey;
          return this.props.t?.(key) ?? s;
        });
      }
    } catch (error) {
      console.error("Editor", "Error initializing database with editor data", error);
    }

    this.loadSongToWysiwyg();
    this.skipNextWysiwygSync = false;
  };

  setupEditorCallbacks() {
    if (this.externalPreviousValues) {
      return;
    }

    const assignments: ChordProExternalCallbacks = {
      OnLineSel: async (lineNumber: number) => {
        console.debug("Editor", "OnLineSel called with line:", lineNumber);
        const { settings } = this.props;
        if (settings?.sectionSelByEditorLineSel && this.props.onLineSelect) {
          this.props.onLineSelect(lineNumber);
        }
      },
      UpdateChordProData: (newText: string) => {
        console.debug("Editor", "UpdateChordProData called, text length:", newText?.length);
        this.skipNextWysiwygSync = true;
        const updatedText = newText ?? "";
        this.applyChordProText(updatedText, { syncEditor: false });
      },
      LogFromWebEditor: (message: string) => {
        console.debug("Editor", "WYSIWYG Editor:", message);
      },
      OnLineDblclk: async (lineNumber: number) => {
        console.debug("Editor", "OnLineDblclk called with line:", lineNumber);
        const { settings } = this.props;
        if (settings?.sectionSelByEditorDblclk && this.props.onLineSelect) {
          this.props.onLineSelect(lineNumber);
        }
      },
      OnCopy: () => {
        console.debug("Editor", "OnCopy called");
        return true;
      },
      OnPaste: () => {
        console.debug("Editor", "OnPaste called");
        return "";
      },
    };

    const win = window as unknown as { external?: Record<string, unknown> };
    let external: Record<string, unknown>;
    if (!win.external || typeof win.external !== "object") {
      external = {};
      try {
        win.external = external;
        this.externalObjectCreated = true;
      } catch {
        external = {};
      }
    } else {
      external = win.external;
    }

    this.externalPreviousValues = new Map();
    (Object.keys(assignments) as (keyof ChordProExternalCallbacks)[]).forEach((key) => {
      this.externalPreviousValues?.set(key, external[key as string]);
      external[key as string] = assignments[key];
    });
  }

  loadSongToWysiwyg(chordProText?: string) {
    if (!this.wysiwygLoaded || !this.chordProHost) return;

    const textToLoad = chordProText ?? this.state.chordProText ?? this.props.song?.Text ?? "";
    const { compareBase } = this.props;

    try {
      const chordApi = this.getChordProAPI();
      if (chordApi) {
        if (!this.hasLoadedDocument) {
          // When compareBase is provided, show diff view (non-editable)
          chordApi.load(this.chordProHost, textToLoad, compareBase ? false : this.isEditable, compareBase);
          this.hasLoadedDocument = true;
          // Mark as initialized after load completes
          this.wysiwygInitialized = true;

          // Apply any pending highlight
          if (this.pendingHighlight && !this.isEditable) {
            const { from, to } = this.pendingHighlight;
            this.pendingHighlight = null;
            this.callWysiwygAPI("highlight", from, to);
          }

          // Apply dark mode after loading
          this.applyDarkModeToEditor();
        } else if (chordApi.updateDocument) {
          // The document is already loaded, so just update it
          chordApi.updateDocument(textToLoad);
        }

        this.updateDisplay();
      }
    } catch (error) {
      console.error("Editor", "Error loading song to WYSIWYG editor", error);
    }
  }

  callWysiwygAPI(method: string, ...args: unknown[]) {
    if (!this.wysiwygLoaded) return;

    try {
      const api = this.getChordProAPI();
      if (!api) {
        console.warn("Editor", `WYSIWYG API not available for method ${method}`);
        return;
      }
      const fn = api[method as keyof ChordProAPI];
      if (typeof fn === "function") {
        (fn as (...fnArgs: unknown[]) => void)(...args);
      } else {
        console.warn("Editor", `WYSIWYG API method ${method} not found`);
      }
    } catch (error) {
      console.error("Editor", `Error calling WYSIWYG API method ${method}`, error);
    }
  }

  // Update display settings based on current state and settings
  private updateDisplay() {
    if (!this.wysiwygLoaded) return;

    const api = this.getChordProAPI();
    if (!api) return;

    // Hide chords in readonly mode if setting is enabled
    // Always show chords in edit mode (you need to see them to edit them)
    const shouldHideChords = !this.isEditable && (this.props.settings?.hideChordsInReadonlyEditor ?? false);

    api.setDisplay(true, true, false, false, "Am", "Full", 1.0, shouldHideChords);
  }

  private applyChordProText(newText: string, options: { syncEditor?: boolean } = {}) {
    const { syncEditor = true } = options;
    const metaData = this.extractMetaData(newText);
    this.setState({
      chordProText: newText,
      metaData,
    });

    if (syncEditor && this.wysiwygLoaded) {
      const api = this.getChordProAPI();
      if (api?.updateDocument) {
        this.skipNextWysiwygSync = true;
        api.updateDocument(newText);
      }
    }

    this.props.setProjectedSongText?.(newText);
    this.props.onTextChange?.(newText); // Notify parent of text changes
  }

  private updateChordProMeta(text: string, tag: string, value: string) {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const trimmedValue = value.trim();
    const tagRegex = new RegExp(`^\\s*{${tag}\\s*:[^}]*}\\s*$`, "i");
    let replaced = false;
    const result: string[] = [];

    for (const line of lines) {
      if (tagRegex.test(line)) {
        if (trimmedValue) {
          result.push(`{${tag}: ${trimmedValue}}`);
          replaced = true;
        }
      } else {
        result.push(line);
      }
    }

    if (!replaced && trimmedValue) {
      const metaLineRegex = /^[ \t]*{[^:]+:[^}]*}[ \t]*$/;
      let insertIndex = 0;
      while (insertIndex < result.length && (result[insertIndex].trim() === "" || metaLineRegex.test(result[insertIndex]))) {
        insertIndex++;
      }
      result.splice(insertIndex, 0, `{${tag}: ${trimmedValue}}`);
    }

    return result.join(newline);
  }

  private handleChordProTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!this.isEditable) return;
    this.applyChordProText(event.target.value);
  };

  private handleMetaChange = (tag: string, value: string) => {
    if (!this.isEditable) return;
    const updatedText = this.updateChordProMeta(this.state.chordProText, tag, value);
    this.applyChordProText(updatedText);
  };

  public async enterEditMode() {
    if (this.isEditable) return;

    console.debug("Editor", "enterEditMode called:", {
      hasOnBeforeEnterEditMode: !!this.props.onBeforeEnterEditMode,
    });

    // Call onBeforeEnterEditMode if provided - allows parent to do sync check, etc.
    if (this.props.onBeforeEnterEditMode) {
      console.debug("Editor", "Calling onBeforeEnterEditMode");
      const canProceed = await this.props.onBeforeEnterEditMode();
      console.debug("Editor", "onBeforeEnterEditMode returned:", canProceed);
      if (!canProceed) return;
    }

    this.isEditable = true;
    // Clear any pending highlight when entering edit mode
    this.pendingHighlight = null;
    // Clear existing highlight in the editor (0, 0 clears the selection)
    this.callWysiwygAPI("highlight", 0, 0);
    this.callWysiwygAPI("enableEdit", true, true);
    // Update display to show chords in edit mode
    this.updateDisplay();
    this.props.onEditModeChange?.(true);
    this.forceUpdate();
  }

  public async leaveEditMode(skipPrompt = false) {
    if (!this.isEditable) return;

    const currentText = this.state.chordProText.trim();
    const originalText = (this.props.originalText ?? this.props.song?.Text ?? "").trim();

    console.debug("Editor", "leaveEditMode called:", {
      skipPrompt,
      currentTextLength: currentText.length,
      originalTextLength: originalText.length,
      hasOnAfterLeaveEditMode: !!this.props.onAfterLeaveEditMode,
      textsMatch: currentText === originalText,
      propsOriginalText: this.props.originalText?.substring(0, 50),
      songText: this.props.song?.Text?.substring(0, 50),
    });

    // Ask the parent (e.g. save prompt / title check) BEFORE visually leaving edit mode.
    // If the callback returns false the exit is cancelled and we stay editable.
    // skipPrompt bypasses this (e.g. when reloading a song after user already confirmed discard).
    if (!skipPrompt && this.props.onAfterLeaveEditMode && currentText !== "" && currentText !== originalText) {
      console.debug("Editor", "Calling onAfterLeaveEditMode");
      const result = await this.props.onAfterLeaveEditMode(this.state.chordProText, this.props.originalText ?? this.props.song?.Text ?? "");
      if (result === false) {
        console.debug("Editor", "onAfterLeaveEditMode returned false — staying in edit mode");
        return;
      }
    }

    this.isEditable = false;
    this.callWysiwygAPI("enableEdit", false, true);
    // Update display to hide/show chords based on settings
    this.updateDisplay();

    // Re-apply dark mode after leaving edit mode to ensure correct colors on mobile
    // Use setTimeout to allow the editor to complete its internal state update
    setTimeout(() => {
      this.applyDarkModeToEditor();
    }, 0);

    // Tell the parent that edit mode is done.
    this.props.onEditModeChange?.(false);

    // Force re-render and reapply dark mode after render completes
    this.forceUpdate(() => {
      // Additional dark mode application after React's render cycle completes
      requestAnimationFrame(() => {
        this.applyDarkModeToEditor();
      });
    });
  }

  public highlightSectionInEditor(from: number, to: number) {
    // Only highlight if the WYSIWYG editor is loaded and initialized
    if (!this.wysiwygLoaded || !this.wysiwygInitialized) {
      // Store the highlight request to apply after initialization
      this.pendingHighlight = { from, to };
      return;
    }
    // Call the highlight method exposed by the ChordPro editor bridge if not in edit mode
    this.callWysiwygAPI("highlight", from, to);
  }

  public getCurrentLyrics() {
    return this.state.chordProText;
  }

  /**
   * Switch to the Meta tab and focus the title input field.
   */
  public focusMetaTitle() {
    this.setState({ activeTab: "meta" }, () => {
      // Allow React to render the meta tab, then focus the title input
      requestAnimationFrame(() => {
        this.titleInputRef?.focus();
      });
    });
  }

  /**
   * Refresh the display when the editor becomes visible after being hidden.
   * Forces a full document reload to ensure dark mode colors are correctly applied.
   */
  public refreshDisplay() {
    if (this.wysiwygLoaded && this.chordProHost) {
      // Force a full reload - this is what fixes dark mode when switching tabs
      this.hasLoadedDocument = false;
      this.loadSongToWysiwyg();
    }
  }

  handleEditToggle = () => {
    if (this.isEditable) {
      this.leaveEditMode();
    } else {
      this.enterEditMode();
    }
  };

  handleMakeTitleClick = () => {
    this.callWysiwygAPI("makeSelectionTitle");
  };

  handleVerseClick = () => {
    this.callWysiwygAPI("tagSelection", "start_of_verse");
  };

  handleChorusClick = () => {
    this.callWysiwygAPI("tagSelection", "start_of_chorus");
  };

  handleBridgeClick = () => {
    this.callWysiwygAPI("tagSelection", "start_of_bridge");
  };

  handleGridClick = () => {
    this.callWysiwygAPI("tagSelection", "start_of_grid");
  };

  handleShiftDown = () => {
    this.callWysiwygAPI("transpose", -1);
  };

  handleShiftUp = () => {
    this.callWysiwygAPI("transpose", 1);
  };

  private handleTabChange = (tab: ChordProEditorState["activeTab"]) => {
    if (this.state.activeTab === tab) {
      if (tab === "wysiwyg" && this.wysiwygLoaded) {
        this.hasLoadedDocument = false; // Force full reload
        this.loadSongToWysiwyg();
      }
      return;
    }

    this.setState({ activeTab: tab }, () => {
      if (tab === "wysiwyg" && this.wysiwygLoaded) {
        this.hasLoadedDocument = false; // Force full reload when switching back to WYSIWYG
        this.loadSongToWysiwyg();
      }
    });
  };

  renderWysiwygTab = () => {
    const { song, compareBase, previewOnly } = this.props;
    const hasContent = !!song;
    const isCompareMode = !!compareBase;
    const hideToolbar = isCompareMode || previewOnly;

    return (
      <div className="wysiwyg-tab-content">
        {/* Hide toolbar in compare/diff mode or previewOnly like C# EnableEditMode(false) collapses Panel1 */}
        {!hideToolbar && (
          <div className="editor-toolbar">
            <button
              type="button"
              className="btn btn-light btn-wide ms-1"
              title="Title"
              disabled={!this.isEditable}
              onClick={this.handleMakeTitleClick}
            >
              <Icon type={IconType.TITLE} />
            </button>
            <button type="button" className="btn btn-light ms-1" title="Verse" disabled={!this.isEditable} onClick={this.handleVerseClick}>
              <Icon type={IconType.VERSE} />
            </button>
            <button type="button" className="btn btn-light ms-1" title="Chorus" disabled={!this.isEditable} onClick={this.handleChorusClick}>
              <Icon type={IconType.CHORUS} />
            </button>
            <button type="button" className="btn btn-light ms-1" title="Bridge" disabled={!this.isEditable} onClick={this.handleBridgeClick}>
              <Icon type={IconType.BRIDGE} />
            </button>
            <button type="button" className="btn btn-light ms-1" title="Grid" disabled={!this.isEditable} onClick={this.handleGridClick}>
              <Icon type={IconType.GRID} />
            </button>
            <button type="button" className="btn btn-light" title="Shift Down" disabled={!this.isEditable} onClick={this.handleShiftDown}>
              <Icon type={IconType.SHIFT_DOWN} />
            </button>
            <button type="button" className="btn btn-light ms-1" title="Shift Up" disabled={!this.isEditable} onClick={this.handleShiftUp}>
              <Icon type={IconType.SHIFT_UP} />
            </button>
          </div>
        )}
        <div className="editor-iframe-container">
          <div className="wysiwyg-host" ref={this.setChordProHostRef} role="presentation" />
        </div>
      </div>
    );
  };

  renderChordProTab = () => {
    const { chordProText } = this.state;
    return (
      <textarea
        className="editor-textarea"
        value={chordProText}
        onChange={this.handleChordProTextareaChange}
        aria-label="ChordPro Code Editor"
        readOnly={!this.isEditable}
      />
    );
  };

  renderMetaTab = () => {
    const { metaData } = this.state;
    const t = this.props.t || ((key: string) => key);

    // Common ChordPro metadata tags in order with their localization keys
    const metaTags: Array<{ tag: string; labelKey: StringKey }> = [
      { tag: "title", labelKey: "MetaTitle" },
      { tag: "subtitle", labelKey: "MetaSubtitle" },
      { tag: "artist", labelKey: "MetaArtist" },
      { tag: "composer", labelKey: "MetaComposer" },
      { tag: "lyricist", labelKey: "MetaLyricist" },
      { tag: "copyright", labelKey: "MetaCopyright" },
      { tag: "album", labelKey: "MetaAlbum" },
      { tag: "year", labelKey: "MetaYear" },
      { tag: "key", labelKey: "MetaKey" },
      { tag: "time", labelKey: "MetaTime" },
      { tag: "tempo", labelKey: "MetaTempo" },
      { tag: "duration", labelKey: "MetaDuration" },
      { tag: "capo", labelKey: "MetaCapo" },
    ];

    return (
      <div className="meta-table-container">
        <table className="table table-striped table-bordered table-sm">
          <thead>
            <tr>
              <th>{t("MetaDataName")}</th>
              <th>{t("MetaDataValue")}</th>
            </tr>
          </thead>
          <tbody>
            {metaTags.map(({ tag, labelKey }) => {
              const value = metaData.get(tag) || "";
              return (
                <tr key={tag}>
                  <td>{t(labelKey)}</td>
                  <td>
                    <input
                      type="text"
                      className="form-control form-control-sm"
                      value={value}
                      onChange={(e) => this.handleMetaChange(tag, e.target.value)}
                      readOnly={!this.isEditable}
                      aria-label={`${t(labelKey)} value`}
                      ref={
                        tag === "title"
                          ? (el) => {
                              this.titleInputRef = el;
                            }
                          : undefined
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  render() {
    const { activeTab } = this.state;
    const { song, compareBase, previewOnly } = this.props;
    const t = this.props.t || ((key: string) => key);
    const isCompareMode = !!compareBase;
    const hideTabs = isCompareMode || previewOnly;
    const editButtonTitle = this.isEditable ? "Exit edit mode" : "Edit";
    const editButtonClass = this.isEditable ? "btn btn-light btn-active" : "btn btn-light";
    const hasContent = !!song;

    return (
      <div className="chordpro-editor-container">
        {/* Hide tabs in compare/diff mode or previewOnly like C# hides editorTab with Size(0,1) */}
        {!hideTabs && (
          <div className="editor-tabs-header">
            <button
              type="button"
              className={`${editButtonClass} edit-toggle-button`}
              title={editButtonTitle}
              disabled={!hasContent && !this.isEditable}
              onClick={this.handleEditToggle}
            >
              <Icon type={IconType.EDIT} />
            </button>
            <ul className="nav nav-tabs">
              <li className="nav-item">
                <a
                  className={`nav-link ${activeTab === "wysiwyg" ? "active" : ""}`}
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    this.handleTabChange("wysiwyg");
                  }}
                >
                  {t("WYSWYGEditor")}
                </a>
              </li>
              <li className="nav-item">
                <a
                  className={`nav-link ${activeTab === "meta" ? "active" : ""}`}
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    this.handleTabChange("meta");
                  }}
                >
                  {t("MetaDataTab")}
                </a>
              </li>
              <li className="nav-item">
                <a
                  className={`nav-link ${activeTab === "chordpro" ? "active" : ""}`}
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    this.handleTabChange("chordpro");
                  }}
                >
                  {t("ChordProCodeEditor")}
                </a>
              </li>
            </ul>
          </div>
        )}
        <div className="tab-content flex-grow-1">
          {!song && !hideTabs && (
            <div className="empty-state">
              <p className="text-muted">{t("NoSongSelected")}</p>
            </div>
          )}
          {song && activeTab === "wysiwyg" && this.renderWysiwygTab()}
          {song && !hideTabs && activeTab === "meta" && this.renderMetaTab()}
          {song && !hideTabs && activeTab === "chordpro" && this.renderChordProTab()}
        </div>
      </div>
    );
  }
}

// HOC to inject localization into class component
const ChordProEditorWithLocalization = React.forwardRef<ChordProEditor, Omit<ChordProEditorProps, "t">>((props, ref) => {
  const { t } = useLocalization();
  return <ChordProEditor {...props} t={t} ref={ref as React.Ref<ChordProEditor>} />;
});

ChordProEditorWithLocalization.displayName = "ChordProEditorWithLocalization";

export default ChordProEditorWithLocalization;
export { ChordProEditor };
