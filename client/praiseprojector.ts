import "core-js/es";
import { allChordInfo, all_modifiers, chordMap } from "../chordpro/allchords";
import { ChordProDocument, ChordSystem, ChordSystemCode, getChordSystem } from "../chordpro/chordpro_base";
import {
  CHORDFORMAT_BB,
  CHORDFORMAT_INKEY,
  CHORDFORMAT_NOCHORDS,
  CHORDFORMAT_NOSECTIONDUP,
  CHORDFORMAT_SIMPLIFIED,
  CHORDFORMAT_SUBSCRIPT,
  ChordProEditor,
  HighlightingParams,
} from "../chordpro/chordpro_editor";
import { ChordSelector } from "../chordpro/chord_selector";
import { getKeyCodeString, isNumLockEnabled } from "../chordpro/keycodes";
import { ChordDetails } from "../chordpro/note_system";
import { cloudApi } from "../common/cloudApi";
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  createDivElement,
  doModal,
  doubleClickHelper,
  endModal,
  inModal,
  installPinchZoomHandler,
  isDisabled,
  isVisible,
  makeDark,
  makeDisabled,
  makeReadonly,
  makeVisible,
  routeTouchEventsToMouse,
  snooze,
  virtualKeyboard,
  weekStartLocale,
} from "../common/utils";
import {
  Display,
  PlayList,
  PlaylistEntry,
  SongEntry,
  SongPreferenceEntry,
  AppConfig,
  SongData,
  LeaderDBProfile,
  SongFound,
  OnlineSessionEntry,
  SessionResponse,
  PpdMessage,
  PpdMessageInternal,
  PendingSongState,
  PendingSongOperation,
} from "../common/pp-types";
import { notPhraseFoundAdditionalCost, isErrorResponse } from "../common/pp-utils";
import { setLogFunction } from "../common/pp-log";
import Calendar from "color-calendar";
import { Database, FormatFoundReason } from "../db-common/Database";
import { UnicodeSymbol } from "./symbols";
import { preventDisplayFromSleep } from "./awake";
import { getAboutBoxHtml } from "./about";
import { DeviceMessage, PpdPacket, HostDevice, Nearby, NearbyMessageParam, HostDeviceInfoType } from "./host-device";
import { Settings } from "../common/settings";
import { formatLocalDateLabel } from "../common/date-only";
import { entryIsFound, getEmptyDisplay, verifyPlaylist } from "../common/pp-utils";
import { ChordBoxType } from "../chordpro/chord_drawer";
import { NoteHitBox } from "../chordpro/ui_base";

export const praiseProjectorOrigin = "https://praiseprojector.com";

type ResultCallback = (result: string, ppHeaders: { [key: string]: string }) => void;
type ErrorCallback = (error: Error) => void;

const debugLog = false;

type LeaderPlaylist = PlayList & { leaderId: string; leaderName: string };
type LeaderPlaylistWithVersion = LeaderPlaylist & { version: number };
type SongRequest = { songId: string; transpose?: number; capo?: number; instructions?: string };
type FullSongRequest = SongRequest & { songdata: { text: string; system: ChordSystemCode } };
type DiffSongRequest = FullSongRequest & {
  version: number;
  current: string;
  uploader: string;
  state: PendingSongState;
};
type DisplaySettings = {
  capo?: number;
  transpose?: number;
  chordBoxType?: ChordBoxType | "NO_CHORDS";
  chordMode?: string;
  noSecChordDup?: boolean;
  subscript?: boolean;
  useCapo?: boolean;
  simplify?: boolean;
  bbMode?: boolean;
  maxText?: boolean;
  darkMode?: boolean;
  autoTone?: boolean;
  highlight?: boolean;
  leaderMode?: boolean;
  fontSize?: string;
  useInstructions?: boolean;
};

function isFullSongRequest(req: SongRequest): req is FullSongRequest {
  const maybe = req as FullSongRequest;
  return !!maybe.songdata?.text && !!maybe.songdata?.system;
}

function isDiffSongRequest(req: SongRequest): req is DiffSongRequest {
  const maybe = req as DiffSongRequest;
  return typeof maybe.uploader === "string" && typeof maybe.state === "string";
}

class AppBase {
  baseEditor: ChordProEditor | undefined;
  chordSelector?: ChordSelector;

  constructor(
    divChordSel?: HTMLDivElement,
    editorDiv?: HTMLDivElement,
    chordProSource?: string,
    system?: ChordSystem | ChordSystemCode,
    editable?: boolean,
    originalSource?: string
  ) {
    if (system) {
      if (!(system instanceof ChordSystem)) system = getChordSystem(system);
      if (divChordSel) this.initChordSelector(system, divChordSel);
      if (editorDiv) {
        this.baseEditor = new ChordProEditor(
          system,
          editorDiv,
          chordProSource || "",
          !!editable,
          undefined,
          this.chordSelector,
          false,
          originalSource
        );
      }
    } else if (divChordSel) this.initChordSelector(getChordSystem("S"), divChordSel);
  }

  initChordSelector(system: ChordSystem, chordSelElement: HTMLElement) {
    this.chordSelector = new ChordSelector(
      system,
      chordSelElement,
      {
        onClose: (chord?: string) => {
          if (this.baseEditor) this.baseEditor.chordSelectorClosed(chord);
        },
        baseNoteSelector: "baseNoteSel",
        bassNoteSelector: "bassNoteSel",
        modifierSelector: "modifier",
        customSpan: "customSpan",
        subscript: "subscript",
        baseNoteSpan: "baseNoteSpan",
        steps: "steps",
        notes: "notes",
        guitarChordBox: "guitarChordBox",
        pianoChordBox: "pianoChordBox",
        musicChordBox: "musicChordBox",
        closeSelector: "closeSelector",
        applySelector: "applySelector",
      },
      (type: ChordBoxType, chord: string | ChordDetails, canvas: HTMLCanvasElement, variant: number) => {
        const noteHitBoxes: NoteHitBox[] = [];
        if (this.editor) this.editor.chordBoxDrawHelper(type, chord, canvas, variant, undefined, noteHitBoxes);
        return noteHitBoxes;
      }
    );
  }

  protected get editor() {
    return this.baseEditor;
  }
}

export function createChordProEditor(
  editorDiv: HTMLDivElement,
  chordProSource: string,
  systemCode: ChordSystemCode,
  editable?: boolean,
  selectorDiv?: HTMLDivElement,
  compareBaseSource?: string
) {
  const app = new AppBase(selectorDiv, editorDiv, chordProSource, systemCode, editable, compareBaseSource);
  return app.baseEditor;
}

export function getJoinedMetaDataDirectives(sep: string) {
  return ChordProDocument.metaDataDirectives.join(sep);
}

export function getAllKnownChordTypeName(sep: string) {
  return all_modifiers.join(sep);
}

export function getAllKnownChordModifier(sep: string) {
  const list: string[] = [];
  chordMap.forEach((value, key) => {
    list.push(key);
    list.push(value.symbols[0]);
  });
  return list.join(sep);
}

export function getChordFindAndSplitPattern(systemCode: ChordSystemCode) {
  return getChordSystem(systemCode).chordFindAndSplitPattern;
}

class EditorPage {
  editor: ChordProEditor | null = null;
  loaded: SongData = { text: "", system: "S" };
  preferredCapo = 0;
  static loadSong(
    system: ChordSystem,
    chp: string,
    parentDiv: HTMLDivElement,
    scale: number,
    chordSelector?: ChordSelector,
    editable?: boolean,
    useCapo?: boolean,
    preferredCapo?: number,
    routeTouch = true,
    diffbasetext?: string
  ) {
    if (!parentDiv) return null;

    let default_capo = 0;
    chp = chp.replace(/(^|\n)\{[ \t]*capo[ \t]*:[ \t]*([0-9]+)[ \t]*\}[ \t]*\r?(\n|$)/, (full, start, match, end) => {
      default_capo = parseInt(match);
      return (start || "") + (end || "");
    });

    const editor = new ChordProEditor(system, parentDiv, chp, !!editable, scale, chordSelector, true, diffbasetext, routeTouch);
    if (preferredCapo === undefined || preferredCapo < 0) preferredCapo = default_capo;

    if (useCapo) {
      if (default_capo !== preferredCapo) editor.transpose(default_capo - preferredCapo, false);
    } else if (default_capo >= 0) editor.transpose(default_capo, false);

    return { editor, preferredCapo };
  }

  constructor(
    private readonly app: App,
    readonly editorDiv: HTMLDivElement | null,
    private readonly routeTouch = true
  ) {}
  load(
    chp: string,
    system?: ChordSystem | ChordSystemCode,
    options?: {
      preferredCapo?: number;
      editable?: boolean;
      forceUpdate?: boolean;
      diffbasetext?: string;
      drawingSuppressed?: boolean;
    }
  ) {
    let loaded = false;
    if (system && this.editorDiv && (options?.forceUpdate || this.loaded.text !== chp || this.preferredCapo !== options?.preferredCapo)) {
      loaded = true;
      if (!(system instanceof ChordSystem)) system = getChordSystem(system);
      this.loaded.system = system.systemCode;
      const retval = EditorPage.loadSong(
        system,
        (this.loaded.text = chp),
        this.editorDiv,
        this.app.calcRes(),
        this.app.chordSelector,
        options?.editable,
        this.app.chkUseCapo?.checked,
        options?.preferredCapo,
        this.routeTouch,
        options?.diffbasetext
      );
      if (retval) {
        const { editor, preferredCapo } = retval;
        (this.editor = editor).saveTranspose();
        this.preferredCapo = preferredCapo;
        this.editor.darkMode(this.app.isCurrentlyDark);
      }
    } else if (this.editor) {
      let update = false;
      if (options?.editable === this.editor.readOnly) {
        this.editor.readOnly = !options?.editable;
        update = true;
      }
      this.editor.marking(false);
      if ((update || this.editor.restoreTranspose(false)) && !options?.drawingSuppressed) this.editor.update();
    }
    return { editor: this.editor, loaded };
  }

  get div() {
    return this.editorDiv && this.editorDiv.parentElement instanceof HTMLDivElement ? this.editorDiv.parentElement : this.editorDiv;
  }
}

function hasTouchScreen() {
  return !!(navigator.maxTouchPoints || "ontouchstart" in document.documentElement);
}

export class App extends AppBase {
  private capoVal = -1;
  private preferredCapo = 0;
  private offlineTimeout: number | null = null;
  private highLightClickDownTime: number | null = null;
  private playlist: PlaylistEntry[] = [];
  private lastImageId = "startup";
  private highlightChangedRecently = 0;
  private chordBoxType: ChordBoxType | "NO_CHORDS" = "";
  private nextSongReq: SongRequest | null = null;
  private handleKeyboardNavigationEvents = hasTouchScreen();
  private draggedRow: HTMLTableRowElement | null = null;
  private displayChangedInOptions = false;

  private currentDisplay: Display = {
    song: "",
    system: "S",
    songId: "",
    from: 0,
    to: 0,
    transpose: 0,
  };

  private hasNeighbours = false;
  private swipeState: { dragX: number; dragY: number; direction: number; totalScroll: number; lastScroll?: number; startTime: number } | null = null;
  private pages!: { prev?: EditorPage; current: EditorPage; next?: EditorPage };
  private chkAdmin: HTMLInputElement | null = null;
  private selShift: HTMLSelectElement | null = null;
  private selCapo: HTMLSelectElement | null = null;
  private spanShift: HTMLElement | null = null;
  private iconTranspose: HTMLElement | null = null;
  private spanCapo: HTMLElement | null = null;
  private grpAdmin: HTMLElement | null = null;
  private searchRow: HTMLDivElement | null = null;
  private codeTextArea: HTMLTextAreaElement | null = null;
  chkUseCapo: HTMLInputElement | null = null;
  private filterRow: HTMLElement | null = null;
  private songListTable: HTMLTableElement | null = null;
  private chkHighlight: HTMLInputElement | null = null;
  private btnNetDisplay: HTMLInputElement | null = null;
  private divTranspose: HTMLDivElement | null = null;
  private btnHome: HTMLElement | null = null;
  private btnPrev: HTMLInputElement | null = null;
  private btnNext: HTMLInputElement | null = null;
  private btnOptions: HTMLElement | null = null;
  private labOptions: HTMLElement | null = null;
  private iconNoChordMode: HTMLElement | null = null;
  private selChordMode: HTMLSelectElement | null = null;
  private chkSubscript: HTMLInputElement | null = null;
  private chkBBMode: HTMLInputElement | null = null;
  private chkAutoTone: HTMLInputElement | null = null;
  private chkSimplified: HTMLInputElement | null = null;
  private chkNoSecChordDup: HTMLInputElement | null = null;
  private chkMaxText: HTMLInputElement | null = null;
  private chkUseInstructions: HTMLInputElement | null = null;
  private btnEditInstructions: HTMLElement | null = null;
  private highlightIconHolderDiv: HTMLElement | null = null;
  private iconHighlighter: HTMLElement | null = null;
  private iconHighlighted: HTMLElement | null = null;
  private iconHighLightLoader: HTMLElement | null = null;
  private divNetStatus: HTMLElement | null = null;
  private divOptions: HTMLElement | null = null;
  private mainView: HTMLElement | null = null;
  private divFullScreen: HTMLElement | null = null;
  private btnFullScreen: HTMLElement | null = null;
  private btnRestore: HTMLElement | null = null;
  private chordBoxSelector: HTMLElement | null = null;
  private iconNoChordBox: HTMLElement | null = null;
  private iconGuitarChordBox: HTMLElement | null = null;
  private iconPianoChordBox: HTMLElement | null = null;
  private actualOption: HTMLElement | null = null;
  private iconCreateMarks: HTMLElement | null = null;
  private iconApplyMarks: HTMLElement | null = null;
  private divCancelEdit: HTMLElement | null = null;
  private edFilter: HTMLInputElement | null = null;
  private selPlaylists: HTMLSelectElement | null = null;
  private iconLoadingList: HTMLElement | null = null;
  private unhighlight: HTMLElement | null = null;
  private logDiv: HTMLDivElement | null = null;
  private divStartEdit: HTMLDivElement | null = null;
  private trashCan: HTMLElement | null = null;
  private swipeHandler: HTMLElement | null = null;
  private preview: EditorPage | null = null;
  private iconClearList: HTMLElement | null = null;
  private darkMode: HTMLElement | null = null;
  private imgAutoLight: HTMLElement | null = null;
  private imgDay: HTMLElement | null = null;
  private imgNight: HTMLElement | null = null;
  private btnShare: HTMLElement | null = null;
  private iconLogin: HTMLElement | null = null;
  private iconLogout: HTMLElement | null = null;
  private iconStartSession: HTMLElement | null = null;
  private iconStartOnlineSession: HTMLElement | null = null;
  private iconStopSession: HTMLElement | null = null;
  private iconWiFiOn: HTMLElement | null = null;
  private iconWiFiOff: HTMLElement | null = null;
  private iconWeb: HTMLElement | null = null;
  private playlists = new Map<string, LeaderPlaylist>();
  private fontSizeDialog: HTMLDivElement | null = null;
  private baseFontSizeSlider: HTMLInputElement | null = null;
  private scanDlg: HTMLElement | null = null;
  private scanDlgIp: HTMLElement | null = null;
  private scanDlgBroadcast: HTMLElement | null = null;
  private loadingCircle: HTMLElement | null = null;
  private moreContent: HTMLElement | null = null;
  private iconCheck: HTMLElement | null = null;
  private btnAccept: HTMLElement | null = null;
  private btnReject: HTMLElement | null = null;
  private songsToCheckCountLabel: HTMLElement | null = null;
  private instructionsDialog: HTMLElement | null = null;
  private instructionsEditor: HTMLElement | null = null;
  private instructionsEditorColorSchemeUpdater?: () => void;
  private onSongDisplayed = {
    songId: "",
    cb: () => {
      return;
    },
  };
  private allSongModeState: "LOADING" | "LOADED" | "ERROR" | "READY" = "LOADING";
  private database?: Database;
  private switchToPlaylistView = () => {}; //TODO: make it nicer?
  private songToCheck?: DiffSongRequest;

  private virtualKeyboardRect?: { x: number; y: number; width: number; height: number };
  private orientation = 0;
  private darkModeEnabled: boolean | undefined;
  private readonly onlineMode: boolean;
  private mode: "App" | "Client" | "OnlineSession";
  private leaderModeAvailable: boolean;
  private leaderMode: boolean;
  private readonly leaderId: string;

  private isOnline = true;
  private login?: string;
  private token?: string;

  constructor(
    private readonly webRoot: string = "",
    options?: AppConfig
  ) {
    super();
    this.onlineMode = options?.online ?? false;
    this.mode = this.onlineMode ? "OnlineSession" : "Client";
    this.leaderModeAvailable = !!options?.leaderModeAvailable;
    this.leaderMode = !!options?.leaderModeEnabled;
    this.leaderId = options?.leaderId ?? "";
    if (this.webRoot) cloudApi.setBaseUrl(this.webRoot.replace(/\/$/, ""));
    cloudApi.setClientId(this.clientId ?? "");
    setLogFunction((message, level) => this.log(level + " - " + message));

    const vk = virtualKeyboard();
    if (vk) {
      vk.overlaysContent = true;
      vk.addEventListener("geometrychange", (event) => {
        this.virtualKeyboardRect = event.target.boundingRect;
        this.onResize();
      });
    }
  }

  private udpEnabled = false;
  private nearbyEnabled = false;
  private ppdScanId = "";
  private ppdServices?: Map<string, { name: string; url: string; deviceId?: string }>;
  private ppdWatch?: { host: string; port?: number; device: string; lastRequestSent: number; lastResponseArrived: number };
  private ppdWatchers?: Map<
    string,
    { host: string; port?: number; lastRequestArrived: number; lastDisplaySent: number; lastDisplayAcked: boolean; lastDisplay?: string }
  >;
  private readonly ppdPackets = new Map<string, { from: string; port?: number; message: PpdMessage }>();

  handleDeviceMessage(raw: string) {
    const message = JSON.parse(raw) as DeviceMessage;
    switch (message.op) {
      case "udp":
        if (this.udpEnabled) {
          this.enqueueIncomingPpdMessage(message.param as PpdPacket);
        } else this.ppdPackets.clear();
        break;
      case "nearby":
        Nearby.processMessage(message.param as NearbyMessageParam);
        break;
      default:
        this.hostDevice?._setRetval(message.op, message.param);
        break;
    }
  }

  private handlePpdRequests() {
    const now = Date.now();
    const processed: string[] = [];
    const name = (() => {
      let s = this.hostDevice?.getName();
      if (!s) s = this.hostDevice?.getModel();
      return s ? s : this.ppdDeviceId;
    })();
    for (const [packetKey, packet] of this.ppdPackets) {
      const sendResponse = (msg: PpdMessageInternal) => {
        this.sendPpdMessage(msg, packet.from, packet.message.port);
      };
      try {
        const message = packet.message;
        if (debugLog) this.log(`DBG_handleUdpRequest: ${JSON.stringify(packet)}`);
        switch (message.op) {
          case "scan":
            if (this.ppdWatchers) sendResponse({ op: "offer", name, id: message.id });
            break;
          case "ack":
            if (this.ppdWatchers && message.id === this.ppdDeviceId && message.device) {
              const watcher = this.ppdWatchers.get(message.device);
              if (watcher) watcher.lastDisplayAcked = true;
            }
            break;
          case "view":
            if (message.id !== this.ppdDeviceId || !message.device) break;
            if (this.ppdWatchers) {
              let watcher = this.ppdWatchers.get(message.device);
              if (watcher) {
                watcher.lastRequestArrived = now;
                watcher.host = packet.from;
                watcher.port = message.port;
              } else
                this.ppdWatchers.set(
                  message.device,
                  (watcher = {
                    host: packet.from,
                    port: message.port,
                    lastRequestArrived: now,
                    lastDisplaySent: 0,
                    lastDisplayAcked: false,
                  })
                );
            } else {
              sendResponse({ op: "off" });
              if (packet.port == null) Nearby.instance?.close(packet.from);
            }
            break;
          case "display":
            if (message.device == this.ppdWatch?.device) {
              if (message.display) {
                const display = message.display;
                if (display) this.applyDisplay(display);
                else this.log("Invalid display arrived: " + message.display);
              } else this.log("No display in 'display' packet");
              sendResponse({ op: "ack", id: message.device });
            }
            break;
          case "off":
            if (message.device == this.ppdWatch?.device) {
              this.hostDevice?.showToast(`${message.name ? message.name + ": " : ""}👋`);
              this.disconnectUdpSession();
            }
            break;
          case "offer":
            if (this.ppdServices && (message.id === this.ppdScanId || message.port == null)) {
              try {
                let ustr = "";
                if (message.url) {
                  const url = new URL(message.url);
                  if (packet.from) url.hostname = packet.from;
                  ustr = url.toString();
                } else if (message.port == null) ustr = "nrb://" + packet.from + "/" + message.device;
                else if (message.device) ustr = "udp://" + packet.from + ":" + message.port + "/" + message.device;
                if (ustr) this.ppdServices.set(ustr, { name: message.name ?? "Local server", url: ustr, deviceId: message.device });
              } catch {
                this.log("Invalid url in UDP packet: " + message);
              }
            }
            break;
          default:
            this.log("Uknown ppd op: " + message.op);
            break;
        }
      } catch (error) {
        this.log("Error processing ppd packet: " + error);
      }
      processed.push(packetKey);
      if (processed.length > 100) break;
    }
    for (const key of processed) this.ppdPackets.delete(key);

    if (this.ppdWatchers) {
      const droplimit = now - 120000;
      const notWatching: string[] = [];
      for (const [key, watcher] of this.ppdWatchers.entries()) {
        if (watcher.lastRequestArrived < droplimit) notWatching.push(key);
        else if (watcher.lastDisplaySent < now - 200) {
          const display = this.currentDisplay ?? getEmptyDisplay();
          let disp: string | undefined;
          if (!watcher.lastDisplayAcked || (disp = JSON.stringify(display)) !== watcher.lastDisplay) {
            watcher.lastDisplaySent = now;
            watcher.lastDisplay = disp ?? JSON.stringify(display);
            this.sendPpdMessage(
              {
                op: "display",
                name,
                display,
              },
              watcher.host,
              watcher.port
            );
          }
        }
      }
      for (const key of notWatching) this.ppdWatchers.delete(key);
    }

    if (this.ppdWatch) {
      if (this.ppdWatch.lastRequestSent < now - 10000) {
        this.ppdWatch.lastRequestSent = this.sendPpdMessage({ op: "view", id: this.ppdWatch.device }, this.ppdWatch.host, this.ppdWatch.port)
          ? now
          : now - 9000;
      }
    }
  }

  private startPpdSession() {
    if (this.udpEnabled || this.nearbyEnabled) {
      this.ppdWatchers = new Map();
      if (this.iconStartSession) makeVisible(this.iconStartSession, false);
      if (this.iconStartOnlineSession) makeVisible(this.iconStartOnlineSession, false);
      if (this.iconStopSession) makeVisible(this.iconStopSession, true);
      if (this.nearbyEnabled) Nearby.instance?.advertise(true);
    }
    this.setNetworkState("nearby");
    if (this.divNetStatus) {
      makeVisible(this.divNetStatus, this.ppdWatchers != null);
      if (this.btnShare) makeVisible(this.btnShare, false);
    }
  }

  private stopPpdSession() {
    for (const watcher of this.ppdWatchers?.values() ?? []) this.sendPpdMessage({ op: "off" }, watcher.host, watcher.port);
    this.ppdWatchers = undefined;
    Nearby.closeAll();
    if (this.iconStartSession) makeVisible(this.iconStartSession, (this.udpEnabled || this.nearbyEnabled) && !cloudApi.isAuthed());
    if (this.iconStartOnlineSession) makeVisible(this.iconStartOnlineSession, cloudApi.isAuthed());
    if (this.iconStopSession) makeVisible(this.iconStopSession, false);
    if (this.divNetStatus) makeVisible(this.divNetStatus, this.ppdWatchers != null);
    if (this.btnShare) makeVisible(this.btnShare, true);
  }

  private _leaderToken?: string;
  private _ppdDeviceId?: string;
  private _ppdDeviceIdTs?: Date;
  private get ppdDeviceId() {
    const now = new Date();
    const expired = (ts: Date) => isNaN(ts.getTime()) || ts.getTime() + 86400000 < now.getTime();
    this._ppdDeviceId = this._ppdDeviceId ?? this.hostDevice?.retrievePreference("ppdDeviceId");
    this._ppdDeviceIdTs = this._ppdDeviceIdTs ?? new Date(this.hostDevice?.retrievePreference("ppdDeviceIdTs") ?? "");
    if (!this._ppdDeviceId || !this._ppdDeviceIdTs || expired(this._ppdDeviceIdTs)) {
      this._ppdDeviceId = this.genUniqueId() + this.genUniqueId();
      this._ppdDeviceIdTs = now;
      this.hostDevice?.storePreference("ppdDeviceId", this._ppdDeviceId);
      this.hostDevice?.storePreference("ppdDeviceIdTs", this._ppdDeviceIdTs.toISOString());
    }
    return this._ppdDeviceId;
  }

  private enqueueIncomingPpdMessage(packet: PpdPacket) {
    try {
      const utf8bytes = base64ToArrayBuffer(packet.message);
      const decoder = new TextDecoder("utf8");
      const decoded = decoder.decode(utf8bytes);
      const message: PpdMessage = JSON.parse(decoded);
      if (message.device !== this.ppdDeviceId) {
        if (packet.port == null) message.port = undefined;
        const key = packet.port + "~" + packet.from + "~" + decoded;
        this.ppdPackets.set(key, { ...packet, message });
        while (this.ppdPackets.size > 1000) {
          const value = this.ppdPackets.keys().next().value;
          if (value) this.ppdPackets.delete(value);
        }
      }
    } catch {
      this.log(`Invalid UDP message arrived from ${packet.from}: ${packet.message}`);
    }
  }

  protected get editor() {
    return this.baseEditor ?? this.pages.current.editor ?? undefined;
  }

  private goHome() {
    this.waitLoadingCircle(true);
    if (this.hostDevice) this.hostDevice.goHome();
    else if (history.length && !this.songToCheck) history.back();
    else location.reload();
  }

  private initFields() {
    const about = document.getElementById("about");
    const aboutBox = document.getElementById("aboutBox");
    if (about && aboutBox) {
      const aboutBoxContent = document.getElementById("aboutBoxContent");
      const originalContent = aboutBoxContent?.innerHTML ?? "";
      about.onclick = () => {
        if (aboutBoxContent) aboutBoxContent.innerHTML = originalContent + getAboutBoxHtml({ login: this.login });
        makeVisible(aboutBox, true);
      };
    }

    this.logDiv = document.getElementById("log") as HTMLDivElement;
    this.installPinchZoomHandler(document.body, Math.max(1, Math.min(window.outerWidth, window.outerHeight) / 10));

    this.edFilter = document.getElementById("filter") as HTMLInputElement;
    if (this.edFilter) {
      if (this.mode !== "OnlineSession") this.mode = "App";
    } else this.edFilter = document.getElementById("searchText") as HTMLInputElement;

    const btnHome = document.getElementById("btnHome");
    if (btnHome) {
      this.btnHome = btnHome;
      const inOnlineSession = this.mode === "OnlineSession";
      makeVisible(btnHome, inOnlineSession);
      if (this.hostDevice) {
        if (!inOnlineSession) {
          try {
            makeVisible(btnHome, this.hostDevice.getHome() !== location.href);
          } catch (error) {
            this.log("Get Device Home error: " + error);
          }
        } else if (this.getSetDeviceData("udpEnabled") !== "false") {
          this.udpEnabled = this.getUdpListenPort() != 0;
          this.startPpdSession();
        }
      }
      btnHome.onclick = () => this.goHome();
    }

    this.btnNetDisplay = document.getElementById("netdisplay") as HTMLInputElement;
    if (this.btnNetDisplay) this.btnNetDisplay.onclick = () => (window.location.href = this.webRoot + "netdisplay?leader=" + this.leaderId);

    this.loadingCircle = document.getElementById("loading-circle");

    this.scanDlg = document.getElementById("scan-dialog");
    this.scanDlgIp = document.getElementById("scan-dialog-ip");
    this.scanDlgBroadcast = document.getElementById("scan-dialog-broadcast");

    let btnMore = document.getElementById("btnMore");
    if (btnMore) {
      if (this.mode !== "Client") {
        const content = (this.moreContent = document.getElementById("btnMore-content"));
        if (content) btnMore.onclick = () => makeVisible(content, !isVisible(content));
      } else {
        btnMore.remove();
        btnMore = null;
      }
    }

    this.iconCheck = document.getElementById("iconCheck") as HTMLInputElement;
    if (this.iconCheck) this.iconCheck.onclick = () => this.enterSongCheckMode();

    this.chkAdmin = document.getElementById("chkAdmin") as HTMLInputElement;
    if (this.chkAdmin)
      this.chkAdmin.onclick = () => {
        this.setLeader(!!this.chkAdmin?.checked);
        this.storeDisplaySettings();
      };
    this.setLeader(!!this.chkAdmin?.checked);

    this.spanShift = document.getElementById("shiftValue");
    this.iconTranspose = document.getElementById("iconTranspose");
    this.selShift = document.getElementById("selShift") as HTMLSelectElement;
    if (this.selShift) {
      const selShift = this.selShift;
      this.selShift.onchange = () => {
        if (this.mode === "App") {
          const transpose = parseInt(selShift.options[selShift.selectedIndex].value, 10);
          if (!isNaN(transpose)) this.transpose(transpose);
          this.storeDisplaySettings();
        } else this.transposeRequest(selShift.options[selShift.selectedIndex].value);
      };
    }

    this.spanCapo = document.getElementById("capoValue");
    this.selCapo = document.getElementById("selCapo") as HTMLSelectElement;
    if (this.selCapo) this.selCapo.onchange = () => this.capoChanged();

    const chordSelElement = document.getElementById("chordsel") as HTMLDivElement;
    this.initChordSelector(getChordSystem("S"), chordSelElement);

    const gb = 1024 * 1024 * 1024;
    const pagingEnabled =
      (this.hostDevice?.info(HostDeviceInfoType.Memory)?.totalMemory ??
        gb * ((navigator as unknown as Record<string, number>)["deviceMemory"] ?? 0)) >=
      2 * gb;

    this.pages = {
      prev: pagingEnabled ? new EditorPage(this, document.getElementById("prev-song") as HTMLDivElement) : undefined,
      current: new EditorPage(this, document.getElementById("editor") as HTMLDivElement),
      next: pagingEnabled ? new EditorPage(this, document.getElementById("next-song") as HTMLDivElement) : undefined,
    };

    if (this.pages.prev?.div) this.pages.prev.div.style.display = "none";
    if (this.pages.next?.div) this.pages.next.div.style.display = "none";

    this.grpAdmin = document.getElementById("adminGroup");

    this.codeTextArea = document.getElementById("raw") as HTMLTextAreaElement;
    if (this.codeTextArea)
      this.codeTextArea.oninput = () => {
        this.loadSong("", this.codeTextArea?.value ?? "", "S");
        this.updateEditor(this.pages.current);
      };
    this.searchRow = document.getElementById("searchRow") as HTMLDivElement;

    const btnSearch = document.getElementById("search");
    if (btnSearch) btnSearch.onclick = () => this.songSearchMode(true);

    this.chkUseCapo = document.getElementById("chkUseCapo") as HTMLInputElement;
    if (this.chkUseCapo) this.chkUseCapo.onclick = () => this.useCapoChanged();

    this.filterRow = document.getElementById("filterRow");

    this.songListTable = document.getElementById("list") as HTMLTableElement;
    if (this.songListTable) {
      this.songListTable.addEventListener("mousedown", (e) => this.songListTableReloadHandler("down", e));
      this.songListTable.addEventListener("mousemove", (e) => this.songListTableReloadHandler("move", e));
      this.songListTable.addEventListener("mouseup", (e) => this.songListTableReloadHandler("up", e));
      this.songListTable.addEventListener("mouseleave", (e) => this.songListTableReloadHandler("up", e));
      routeTouchEventsToMouse(this.songListTable, { preventDefault: false, stopPropagation: false });
    }

    this.chkHighlight = document.getElementById("chkHighlight") as HTMLInputElement;
    if (this.chkHighlight) this.chkHighlight.onclick = () => this.chkHighlightClicked();

    this.divTranspose = document.getElementById("transpose") as HTMLDivElement;
    this.btnPrev = document.getElementById("btnPrev") as HTMLInputElement;
    if (this.btnPrev)
      this.btnPrev.onclick = (e) => {
        this.onPrevSong();
        e.preventDefault();
      };

    this.btnNext = document.getElementById("btnNext") as HTMLInputElement;
    if (this.btnNext)
      this.btnNext.onclick = (e) => {
        this.onNextSong();
        e.preventDefault();
      };

    this.labOptions = document.getElementById("labOptions") as HTMLElement;

    this.chordBoxSelector = document.getElementById("chordBoxSelector");
    if (this.chordBoxSelector) {
      this.iconNoChordMode = document.getElementById("imgNoChordMode");
      this.iconNoChordBox = document.getElementById("imgNoChordBox");
      this.iconGuitarChordBox = document.getElementById("imgGuitarBox");
      this.iconPianoChordBox = document.getElementById("imgPianoBox");
      this.chordBoxSelector.onclick = () => this.onChordBoxSelectorChange();
    }

    this.selChordMode = document.getElementById("selChordMode") as HTMLSelectElement;
    if (this.selChordMode) this.selChordMode.onchange = () => this.displayChanged();

    this.chkSubscript = document.getElementById("chkSubscript") as HTMLInputElement;
    if (this.chkSubscript) this.chkSubscript.onclick = () => this.displayChanged();

    this.chkBBMode = document.getElementById("chkBbMode") as HTMLInputElement;
    if (this.chkBBMode) this.chkBBMode.onclick = () => this.displayChanged();

    this.chkAutoTone = document.getElementById("chkAutoTone") as HTMLInputElement;
    if (this.chkAutoTone) this.chkAutoTone.onclick = () => this.displayChanged();

    this.chkSimplified = document.getElementById("chkSimplified") as HTMLInputElement;
    if (this.chkSimplified) this.chkSimplified.onclick = () => this.displayChanged();

    this.chkNoSecChordDup = document.getElementById("chkNoSecChordDup") as HTMLInputElement;
    if (this.chkNoSecChordDup) this.chkNoSecChordDup.onclick = () => this.displayChanged();

    this.fontSizeDialog = document.getElementById("fontSizeDialog") as HTMLDivElement | null;
    this.baseFontSizeSlider = document.getElementById("baseFontSizeSlider") as HTMLInputElement | null;
    document.documentElement.style.fontSize = "15pt";
    if (this.baseFontSizeSlider) {
      this.baseFontSizeSlider.oninput = () => {
        if (this.baseFontSizeSlider) this.applyFontSize(this.baseFontSizeSlider.value);
      };
    }
    this.applySizeGuard();

    this.chkMaxText = document.getElementById("chkMaxText") as HTMLInputElement;
    if (this.chkMaxText) {
      doubleClickHelper(this.chkMaxText, this.fontSizeDialog ? () => this.setFontSizeDetails() : () => this.displayChanged(), () =>
        this.displayChanged()
      );
    }

    this.highlightIconHolderDiv = document.getElementById("highlight");
    if (this.highlightIconHolderDiv) {
      this.highlightIconHolderDiv.onmousedown = (e) => this.onHighlightIconClicked(e, true);
      this.highlightIconHolderDiv.onmouseup = (e) => this.onHighlightIconClicked(e, false);
      this.highlightIconHolderDiv.ontouchstart = (e) => this.onHighlightIconClicked(e, true);
      this.highlightIconHolderDiv.ontouchend = (e) => this.onHighlightIconClicked(e, false);
    }

    this.iconHighlighter = document.getElementById("highlighter");
    this.iconHighlighted = document.getElementById("highlighted");
    this.iconHighLightLoader = document.getElementById("highlight_loader");

    if (this.iconHighlighter) makeVisible(this.iconHighlighter, this.itIsMyOnlineSession);
    if (this.iconHighlighted) makeVisible(this.iconHighlighted, !this.itIsMyOnlineSession);

    this.divOptions = document.getElementById("options");

    this.mainView = document.getElementById("mainView");

    this.btnShare = document.getElementById("btnShare");
    if (this.btnShare) this.btnShare.onclick = () => this.sharePublicLink();

    this.btnOptions = document.getElementById("btnOptions");
    if (this.btnOptions) this.btnOptions.onclick = () => this.openOptions();

    const closeOptions = document.getElementById("closeOptions");
    if (closeOptions) closeOptions.onclick = () => this.closeOptions(true);

    this.divNetStatus = document.getElementById("netstatus");
    if (this.divNetStatus) this.divNetStatus.onclick = () => this.goOnline();

    this.divFullScreen = document.getElementById("fsdiv");
    if (this.divFullScreen) {
      this.divFullScreen.onclick = () => this.toggleFullScreen();
      makeVisible(this.divFullScreen, !window.matchMedia("(display-mode: fullscreen)").matches);
    }
    this.btnFullScreen = document.getElementById("fullscreen");
    this.btnRestore = document.getElementById("restore");

    this.divStartEdit = document.getElementById("startEdit") as HTMLDivElement;
    this.divCancelEdit = document.getElementById("cancelEdit") as HTMLDivElement;

    this.iconCreateMarks = document.getElementById("note-create");
    this.iconApplyMarks = document.getElementById("note-apply");

    this.btnAccept = document.getElementById("accept");
    if (this.btnAccept) this.btnAccept.onclick = () => this.songChecked(true);
    this.btnReject = document.getElementById("reject");
    if (this.btnReject) this.btnReject.onclick = () => this.songChecked(false);

    let inInstrucionEditor = false;

    this.instructionsDialog = document.getElementById("instructionsDialog");
    this.instructionsEditor = document.getElementById("instructionsEditor");
    if (this.instructionsEditor) {
      routeTouchEventsToMouse(this.instructionsEditor, { preventDefault: false, stopPropagation: false });
      this.btnEditInstructions = this.mode !== "App" ? document.getElementById("editInstructions") : null;
      if (this.btnEditInstructions) {
        this.btnEditInstructions.onclick = () => {
          inInstrucionEditor = true;
          void this.editInstructions();
        };
      }
    }

    this.chkUseInstructions = document.getElementById("chkInstructions") as HTMLInputElement;
    if (this.chkUseInstructions) {
      const chkInstructions = this.chkUseInstructions;
      chkInstructions.onclick = (e) => {
        const btnEditInstructions = this.btnEditInstructions;
        if (btnEditInstructions && this.chkAdmin?.checked) {
          makeVisible(chkInstructions, false);
          makeVisible(btnEditInstructions, true);
          inInstrucionEditor = false;
          const checked = chkInstructions.checked;
          setTimeout(() => {
            makeVisible(chkInstructions, true);
            makeVisible(btnEditInstructions, false);
            if (inInstrucionEditor) chkInstructions.checked = !checked;
            else this.displayChanged();
          }, 1000);
        } else this.displayChanged();
      };
    }

    let filterRequestCounter = 0;
    const filterRequestHandler = () => {
      const last = ++filterRequestCounter;
      setTimeout(
        () => {
          if (filterRequestCounter === last) {
            if (this.mode === "App") this.applyFilterOnLocalSongList();
            else this.onSearchTextChanged();
          }
        },
        this.mode === "App" ? 100 : 500
      );
    };

    let btnClr: HTMLElement | null = null;
    if (this.edFilter) {
      this.edFilter.onkeypress = filterRequestHandler;
      this.edFilter.onpaste = filterRequestHandler;
      this.edFilter.oninput = filterRequestHandler;
      this.edFilter.onkeyup = (ev) => {
        if (getKeyCodeString(ev) === "ENTER") this.onSearchTextChanged(true);
      };

      btnClr = document.getElementById("clearSearchText");
      if (btnClr) {
        btnClr.onclick = () => {
          if (this.edFilter) {
            this.edFilter.value = "";
            this.edFilter.focus();
          }
          filterRequestHandler();
        };
      }
    }

    const replacePlaylist = document.getElementById("replacePlaylist");
    if (replacePlaylist) {
      replacePlaylist.onclick = async () => {
        if (await this.confirm("overwrite")) this.replaceCurrentPlaylistWithSelected();
      };
    }
    const btnStore = document.getElementById("iconStore");
    if (btnStore) {
      makeVisible(btnStore.parentElement instanceof HTMLDivElement ? btnStore.parentElement : btnStore, this.onlineMode && this.leaderMode);
      const calendarContainer = this.onlineMode ? document.getElementById("date-picker-calendar") : null;
      if (calendarContainer) {
        const btnOK = document.getElementById("date-picker-ok") as HTMLElement;
        const btnCancel = document.getElementById("date-picker-close") as HTMLElement;
        const customWeekdayValues = new Array<string>(7);
        const startDay = new Date();
        for (let i = 0; i < 7; ++i) {
          const d = new Date(startDay);
          d.setDate(d.getDate() + i);
          customWeekdayValues[d.getDay()] = d.toLocaleDateString(undefined, { weekday: "short" });
        }
        const calendar = new Calendar({
          id: "#color-calendar",
          customWeekdayValues,
          startWeekday: weekStartLocale(navigator.language),
        });
        btnStore.onclick = async () => {
          makeVisible(calendarContainer, true);
          calendar.reset(startDay);
          if (this.playlists.size === 0) this.refreshPlaylists(await this.fetchAllPlaylistFromServer());
          if (this.playlists) {
            for (const e of this.playlists.values()) {
              if (e.scheduled && e.leaderId === this.leaderId) {
                calendar.addEventsData([
                  {
                    start: e.scheduled.toISOString(),
                    end: new Date(e.scheduled.getTime() + 86400000 - 1000).toISOString(),
                    label: e.label,
                    leader: e.leaderId,
                  },
                ]);
              }
            }
          }
          doModal(calendarContainer);
        };
        btnOK.onclick = async () => {
          if (await this.uploadList(calendar.getSelectedDate())) endModal(calendarContainer);
        };
        btnCancel.onclick = () => endModal(calendarContainer);
      } else if (this.onlineMode) btnStore.onclick = () => this.uploadList();
    }

    const btnApplyFilter = document.getElementById("apply-filter");
    if (btnApplyFilter) btnApplyFilter.onclick = () => this.applyFilterOnLocalSongList();

    this.iconClearList = document.getElementById("iconClearList");

    if (this.iconClearList) {
      makeVisible(
        this.iconClearList.parentElement instanceof HTMLDivElement ? this.iconClearList.parentElement : this.iconClearList,
        this.onlineMode && this.leaderMode
      );
      this.iconClearList.onclick = async () => {
        if (await this.confirm("erase")) {
          this.updateTableFromEntries((this.playlist = []));
          this.sendPlaylistUpdateRequest([], (error) => {
            if (error) this.log(error.toString());
          });
        }
      };
    }

    const iconDatabase = document.getElementById("iconDatabase");
    const iconPlaylist = document.getElementById("iconPlaylist");
    this.selPlaylists = document.getElementById("playlists") as HTMLSelectElement;
    if (this.selPlaylists) {
      this.selPlaylists.onchange =
        this.edFilter?.id === "searchText"
          ? () => {
              this.leaderPlaylistSelected();
              if (replacePlaylist) makeDisabled(replacePlaylist, (this.selPlaylists?.selectedIndex ?? -1) < 0);
            }
          : () => this.applyFilterOnLocalSongList();
    }

    if (iconPlaylist) {
      if (iconDatabase) {
        const switchSongsFilter = async (all: boolean) => {
          if (btnClr) makeVisible(btnClr, all);
          if (this.edFilter) makeVisible(this.edFilter, all);
          if (btnApplyFilter) makeVisible(btnApplyFilter, all);
          makeVisible(iconPlaylist, all);
          if (this.selPlaylists) makeVisible(this.selPlaylists, !all);
          if (replacePlaylist) makeVisible(replacePlaylist, !all);
          makeVisible(iconDatabase, !all);
          await this.applyFilterOnLocalSongList();
          if (all) {
            if (this.mode !== "App") {
              if (this.edFilter) this.edFilter.value = "";
              this.songSearchMode(false);
            } else this.onSearchTextChanged();
          } else this.leaderPlaylistSelected();
        };
        iconDatabase.onclick = () => switchSongsFilter(true);
        iconPlaylist.onclick = () => switchSongsFilter(false);
        if (this.mode !== "App") {
          const cont = () => {
            switchSongsFilter(true);
            this.songSearchMode(false);
          };
          this.updatePlaylistDroplist().then(cont).catch(cont);
        } else switchSongsFilter(true);
        this.switchToPlaylistView = () => switchSongsFilter(false);
      }
    }

    this.trashCan = document.getElementById("trashCan");
    if (this.trashCan) {
      this.trashCan.ondragenter = () => {
        this.trashCan?.classList.add("droptarget");
        this.draggedRow?.classList.remove("droptarget");
      };
      this.trashCan.ondragleave = () => {
        this.trashCan?.classList.remove("droptarget");
        this.draggedRow?.classList.add("droptarget");
      };
    }

    this.iconLoadingList = document.getElementById("loading-list");
    this.unhighlight = document.getElementById("unhighlight");
    if (this.unhighlight) {
      this.unhighlight.onclick = () => this.onLineSel(-1);
      makeVisible(this.unhighlight, false);
    }

    this.updateEditIconsByState();

    const iconPower = document.getElementById("iconPower");
    if (iconPower) {
      makeVisible(iconPower, this.hostDevice?.exit != null);
      iconPower.onclick = () => {
        if (this.hostDevice?.exit) this.hostDevice.exit();
      };
    }

    const iconWiFiOn = document.getElementById("iconWiFiOn");
    const iconWiFiOff = document.getElementById("iconWiFiOff");
    if (iconWiFiOn && iconWiFiOff) {
      const updateWiFiButtons = () => {
        const on = this.udpEnabled || this.nearbyEnabled;
        makeVisible(iconWiFiOn, on);
        makeVisible(iconWiFiOff, !on);
      };

      if (this.hostDevice) {
        const ppdEnabled = this.getSetDeviceData("ppdEnabled") !== "false";
        this.udpEnabled = ppdEnabled;
        this.nearbyEnabled = ppdEnabled;
        updateWiFiButtons();
        iconWiFiOn.onclick = () => {
          this.getSetDeviceData("ppdEnabled", "false");
          this.stopPpdSession();
          this.udpEnabled = false;
          this.nearbyEnabled = false;
          updateWiFiButtons();
          void this.updateFieldsForUser(false);
        };
        iconWiFiOff.onclick = () => {
          this.getSetDeviceData("ppdEnabled", "true");
          this.udpEnabled = true;
          this.nearbyEnabled = true;
          updateWiFiButtons();
          void this.updateFieldsForUser(false);
          this.searchExternalSessions("NEARBY").then(updateWiFiButtons).catch(updateWiFiButtons);
        };
      } else {
        this.udpEnabled = false;
        makeVisible(iconWiFiOn, false);
        makeVisible(iconWiFiOff, false);
      }
      this.iconWiFiOn = iconWiFiOn;
      this.iconWiFiOff = iconWiFiOff;
    }

    this.iconWeb = document.getElementById("iconWeb");
    if (this.iconWeb) {
      makeDisabled(this.iconWeb, false);
      this.iconWeb.onclick = () => void this.searchExternalSessions("WEB");
    }

    const iconReport = document.getElementById("iconReport");
    if (iconReport) {
      const externalOpen = this.hostDevice?.openLinkExternal;
      iconReport.onclick = () => {
        const url = praiseProjectorOrigin + "/#contact";
        if (externalOpen) externalOpen(url);
        else window.open(url, "_blank");
      };
    }

    this.iconStartSession = document.getElementById("iconStartSession");
    if (this.iconStartSession) {
      this.iconStartSession.onclick = () => this.startPpdSession();
      makeVisible(this.iconStartSession, !cloudApi.isAuthed());
    }
    this.iconStartOnlineSession = document.getElementById("iconStartOnlineSession");
    if (this.iconStartOnlineSession) {
      this.iconStartOnlineSession.onclick = () => this.switchToOnlineSession(true);
      makeVisible(this.iconStartOnlineSession, cloudApi.isAuthed());
    }
    this.iconStopSession = this.hostDevice ? document.getElementById("iconStopSession") : null;
    if (this.iconStopSession) {
      this.iconStopSession.onclick = () => {
        if (this.mode !== "App" && history.length > 1) {
          this.goHome();
          return;
        }
        this.stopPpdSession();
      };
    }

    this.iconLogin = document.getElementById("iconLogin");
    this.iconLogout = document.getElementById("iconLogout");
    const loginDialog = document.getElementById("loginDialog");
    if (this.iconLogin && loginDialog) {
      const login = document.getElementById("login") as HTMLInputElement | null;
      const key = document.getElementById("password") as HTMLInputElement | null;
      const handleKeyPress = (e: KeyboardEvent) => {
        if (getKeyCodeString(e) === "ENTER") {
          if (e.target === login) key?.focus();
          else void this.doLogin(loginDialog);
        }
      };
      if (login) login.onkeyup = handleKeyPress;
      if (key) key.onkeyup = handleKeyPress;
      this.iconLogin.onclick = () => {
        const store = document.getElementById("keepLoggedIn") as HTMLInputElement | null;
        if (store) store.checked = !!this.hostDevice;
        doModal(loginDialog);
        login?.focus();
      };
      const doLogin = document.getElementById("doLogin");
      if (doLogin) {
        doLogin.onclick = async () => {
          try {
            await this.doLogin(loginDialog);
          } finally {
            this.updateFieldsForUser();
          }
        };
      }
      const cancelLogin = document.getElementById("cancelLogin");
      if (cancelLogin) cancelLogin.onclick = () => endModal(loginDialog, "");
    }
    if (this.iconLogout) this.iconLogout.onclick = () => this.logout();

    if (this.mode === "App") {
      setTimeout(() => this.searchExternalSessions(), 100);
      const calcTimeout = () => (cloudApi.isAuthed() ? 15 : 60) * 60 * 1000;
      const autoupdate = async () => {
        await this.updateDatabase();
        this.searchExternalSessions();
        setTimeout(autoupdate, calcTimeout());
      };
      setTimeout(autoupdate, calcTimeout());
    }

    this.swipeHandler = document.getElementById("swipe-handler");
    if (this.swipeHandler) {
      this.swipeHandler.onmousedown = (e) => this.swipeHandlerEvent("down", e);
      this.swipeHandler.onmousemove = (e) => this.swipeHandlerEvent("move", e);
      this.swipeHandler.onmouseup = (e) => this.swipeHandlerEvent("up", e);
      this.swipeHandler.onmouseleave = (e) => this.swipeHandlerEvent("up", e);
      routeTouchEventsToMouse(this.swipeHandler);
    }

    this.songsToCheckCountLabel = document.getElementById("songsToCheckCount");
    if (this.songsToCheckCountLabel) {
      let lastCheck = 0;
      const todoCheck = async () => {
        if (cloudApi.isAuthed() && Date.now() - lastCheck >= 60 * 60 * 1000) {
          lastCheck = Date.now();
          this.updatePendingCheckCount();
        }
        setTimeout(todoCheck, 1000);
      };
      todoCheck();
    }

    const songPreview = document.getElementById("preview") as HTMLDivElement;
    if (songPreview) {
      this.preview = new EditorPage(this, songPreview, false);
      songPreview.onclick = () => endModal(songPreview);
    }

    this.imgAutoLight = document.getElementById("imgAutoLight");
    this.imgDay = document.getElementById("imgDay");
    this.imgNight = document.getElementById("imgNight");

    this.darkMode = document.getElementById("darkmode");
    if (this.darkMode) {
      this.darkMode.onclick = () => {
        const images = [this.imgAutoLight, this.imgDay, this.imgNight].filter((x) => x != null) as HTMLElement[];
        const current = images.findIndex((x) => isVisible(x));
        const next = (current + 1) % images.length;
        this.switchDarkMode(images[next] === this.imgAutoLight ? undefined : images[next] === this.imgNight);
        this.storeDisplaySettings();
      };
    }

    this.switchDarkMode(undefined);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      this.switchDarkMode(undefined);
    });
  }

  private async updatePendingCheckCount(count?: number) {
    const updateParentBadge = (badge: HTMLElement, children: HTMLElement[]) => {
      let cnt = 0;
      for (const child of children) {
        if (child) {
          const c = parseInt(child.innerText);
          if (!isNaN(c)) cnt += c;
        }
      }
      makeVisible(badge, cnt !== 0);
      badge.innerText = cnt >= 99 ? "99+" : cnt.toString();
    };

    if (!this.songsToCheckCountLabel) return;

    try {
      if (count === undefined) {
        const peek = await cloudApi.fetchPeek();
        count = peek?.pendingSongCount ?? 0;
      }
      makeVisible(this.songsToCheckCountLabel, !!count);
      this.songsToCheckCountLabel.innerText = count > 99 ? "99+" : count.toString();
    } catch (error) {
      this.log(String(error));
    }
    const moreNotifCount = document.getElementById("moreNotifCount");
    if (moreNotifCount) updateParentBadge(moreNotifCount, [this.songsToCheckCountLabel]);
    const optionsNotifCount = document.getElementById("optionsNotifCount");
    if (optionsNotifCount) updateParentBadge(optionsNotifCount, [this.songsToCheckCountLabel]);
  }

  private async updateDatabase(mode: "LOAD" | "RELOAD" | "UPDATE" = "UPDATE") {
    const db = this.database ?? (await Database.initialize());
    this.database = db;

    if (mode === "RELOAD") {
      // Full reload: re-fetch everything from server
      await db.updateFromServer(0, true, "overwrite");
    } else if (mode === "LOAD" || mode === "UPDATE") {
      // Incremental update from server
      try {
        await db.updateFromServer(undefined, true, "overwrite");
      } catch (error) {
        this.log("Database update failed, using cached: " + error);
      }
    }

    // Playlists: still fetched via cloudApi for legacy playlist UI
    try {
      const playlists = await this.fetchAllPlaylistFromServer();
      const backup = this.selPlaylists?.value;
      this.refreshPlaylists(playlists);
      if (backup && this.selPlaylists) this.selPlaylists.value = backup;
    } catch (error) {
      this.log("Playlists update failed: " + error);
    }

    await this.applyFilterOnLocalSongList();
  }

  private get itIsMyOnlineSession() {
    return this.mode === "OnlineSession" && !!this.leaderId && this.leaderMode;
  }

  private applyFontSize(fontSize: number | string) {
    document.documentElement.style.fontSize = fontSize + "pt";
    this.applySizeGuard();
    this.storeDisplaySettings();
  }

  private installPinchZoomHandler(pinchHandler: HTMLElement, step: number) {
    let lastDiff = 0;
    installPinchZoomHandler(
      pinchHandler,
      (diff) => {
        const minValue = parseInt(this.baseFontSizeSlider?.getAttribute("min") || "12", 10);
        const maxValue = parseInt(this.baseFontSizeSlider?.getAttribute("max") || "24", 10);
        if (this.fontSizeDialog && !isVisible(this.fontSizeDialog)) this.setFontSizeDetails();
        const stringValue = this.baseFontSizeSlider?.value ?? document.documentElement.style.fontSize.replace(/pt$/g, "");
        const value = Math.round(Math.min(maxValue, Math.max(minValue, parseFloat(stringValue) + diff - lastDiff)));
        if (this.baseFontSizeSlider) this.baseFontSizeSlider.value = value.toString();
        this.applyFontSize(value);
        lastDiff = diff;
      },
      step ?? Math.min(1, Math.min(pinchHandler.clientWidth, pinchHandler.clientHeight) / 10)
    );
  }

  private getSetDeviceData(key: string, value?: string) {
    if (this.hostDevice) {
      try {
        if (value == null) return this.hostDevice.retrievePreference(key);
        this.hostDevice.storePreference(key, value);
        return value;
      } catch (e) {
        this.log("Device Preference Access Error: " + e);
      }
    }
    return undefined;
  }

  public get isDarkModeEnabled() {
    return this.darkModeEnabled;
  }

  public get isCurrentlyDark() {
    return typeof this.darkModeEnabled === "boolean"
      ? this.darkModeEnabled
      : window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  private switchDarkMode(darkMode: boolean | undefined) {
    this.darkModeEnabled = darkMode;

    if (this.imgAutoLight) makeVisible(this.imgAutoLight, darkMode === undefined);
    if (this.imgDay) makeVisible(this.imgDay, darkMode === false);
    if (this.imgNight) makeVisible(this.imgNight, darkMode === true);

    this.updateColorScheme();
  }

  private updateColorScheme() {
    const dark = this.isCurrentlyDark;
    makeDark(document.body, dark);
    for (const mainTable of Array.from(document.getElementsByClassName("mainTable"))) {
      for (const img of Array.from(mainTable.getElementsByClassName("btnImg")))
        if (img instanceof HTMLImageElement) img.style.filter = "invert(" + (dark ? 1 : 0) + ")";
      for (const lab of Array.from(mainTable.getElementsByTagName("span"))) lab.style.filter = "invert(" + (dark ? 1 : 0) + ")";
      for (const page of [this.pages.current, this.pages.prev, this.pages.next])
        if (page) {
          if (page.div) makeDark(page.div, dark);
          if (page.editorDiv) makeDark(page.editorDiv, dark);
          if (page.editor) page.editor.darkMode(dark);
        }
    }
    this.editor?.darkMode(dark);
    if (this.instructionsDialog) {
      makeDark(this.instructionsDialog, dark);
      for (const div of Array.from(this.instructionsDialog.getElementsByTagName("div"))) makeDark(div, dark);
      if (this.instructionsEditor) this.instructionsEditorColorSchemeUpdater?.();
    } else if (this.instructionsEditor) {
      for (const div of Array.from(this.instructionsEditor.getElementsByTagName("div"))) makeDark(div, dark);
      this.instructionsEditorColorSchemeUpdater?.();
    }
  }

  private setPagePhase(offset: number, scale: number) {
    if (!this.pages.prev || !this.pages.next) return;
    if (this.chordSelector && this.chordSelector.inModal) this.chordSelector.closeDialog();
    const direction = offset / Math.abs(offset);
    const page = this.pages.current.div;
    const setPageVisibility = (p: EditorPage, display: string) => {
      const prevDisplay = p.div?.style.display;
      if (prevDisplay !== display) {
        if (p.div) p.div.style.display = display;
        /*      // Too slow, update on load        
        if (prevDisplay === "none") {
          this.updateEditor(p);
          this.displayChanged(p);
        }
*/
      }
    };
    if (page) {
      page.style.transformOrigin = (direction < 0 ? "left" : "right") + " center";
      const deg = (offset * 90) / scale;
      page.style.transform = `rotateY(${deg}deg)`;
      page.style.boxShadow = `${(-1 * direction * offset * offset) / scale}px 10px 5px rgba(100, 100, 100, 0.5)`;
      const hidden = Math.abs(deg) < 5;
      if (this.pages.prev?.div) {
        this.pages.prev.div.style.zIndex = offset >= 0 ? "-1" : "-2";
        setPageVisibility(this.pages.prev, hidden || offset < 0 ? "none" : "unset");
      }
      if (this.pages.next?.div) {
        this.pages.next.div.style.zIndex = offset >= 0 ? "-2" : "-1";
        setPageVisibility(this.pages.next, hidden || offset >= 0 ? "none" : "unset");
      }
    }
  }

  private pageTurn(from: number, scale: number, time: number, forced?: boolean) {
    if (this.chordSelector && this.chordSelector.inModal) this.chordSelector.closeDialog();
    const page = this.pages.current.div;
    if (!page) return;
    const direction = from / Math.abs(from);
    if (!this.pages.next || !this.pages.prev) {
      this.changeSong(direction < 0);
      return;
    }
    page.style.border = "solid black 1px";
    const start = Date.now();
    from *= direction;
    const turn = (forced || from > 0.7 * scale) && (direction > 0 ? this.pages.prev.editor : this.pages.next.editor)?.hasDoc();
    const total = turn ? scale - from : -from;
    const phase = async (last: number) => {
      const now = Date.now(),
        elapsed = now - start,
        fwd = elapsed / time;
      this.setPagePhase(direction * (from + total * fwd), scale);
      if (elapsed >= time) {
        if (turn) await this.changeSong(direction < 0);
        else {
          page.style.transform = "";
          page.style.border = "none";
          page.style.boxShadow = "none";
          page.style.zIndex = "0";
        }
      } else setTimeout(() => phase(now), Math.max(now - last, 20));
    };
    phase(start);
  }

  private loadingCircleLevel = 0;
  private loadingCircleMaxLevel = 2;
  private loadingCircleLevelChanged = 0;
  private loadingCircleLevelChangeTimeout = 2000;

  private updateLoadingCircle(frameElement: HTMLElement, maxReached = false) {
    this.loadingCircleLevel = 0;
    const loadingCircle = this.loadingCircle;
    if (!loadingCircle) return;
    if (maxReached) {
      if (this.loadingCircleLevel >= this.loadingCircleMaxLevel) return;
      this.loadingCircleLevelChanged = Date.now();
      this.loadingCircleLevel = 1;
      const updateLevels = () => {
        if (this.loadingCircleLevel < 0) return;
        if (
          Date.now() - this.loadingCircleLevelChanged > this.loadingCircleLevelChangeTimeout &&
          this.loadingCircleLevel < this.loadingCircleMaxLevel
        ) {
          ++this.loadingCircleLevel;
          this.loadingCircleLevelChanged = Date.now();
          loadingCircle.classList.add("level" + this.loadingCircleLevel);
        }
        loadingCircle.classList.forEach((name) => {
          if (name.startsWith("level") && name !== "level" + this.loadingCircleLevel) loadingCircle.classList.remove(name);
        });
        if (this.loadingCircleLevel > 0) setTimeout(updateLevels, 100);
      };
      updateLevels();
      return;
    }
    if (!frameElement) frameElement = document.body;
    const perc = Math.max(0, (5 * (loadingCircle.offsetTop - frameElement.offsetTop)) / frameElement.clientHeight);
    const circle = loadingCircle.getElementsByClassName("circle").item(0) as HTMLElement | null;
    if (circle) circle.style.strokeDashoffset = `${(0.9 - perc) * 2.669}em`;
    loadingCircle.style.opacity = (
      1 - Math.max(0, Math.min(1, (frameElement.offsetTop - loadingCircle.offsetTop) / loadingCircle.offsetHeight))
    ).toString();
  }

  private checkLoadingCircle(pFrameElement?: HTMLElement) {
    const loadingCircle = this.loadingCircle;
    if (loadingCircle && isVisible(loadingCircle)) {
      if (loadingCircle.classList.contains("animate"))
        return Math.max(Date.now() - this.loadingCircleLevelChanged >= 500 ? this.loadingCircleLevel : this.loadingCircleLevel - 1, 1);
      const frameElement = pFrameElement ?? document.body;
      const distance = frameElement.clientHeight / 3 + loadingCircle.offsetHeight;
      const start = Date.now();
      const from = loadingCircle.offsetTop;
      const shiftOut = () => {
        const pos = Math.floor(from - ((Date.now() - start) / 1000) * distance);
        loadingCircle.style.top = pos + "px";
        if (pos > frameElement.offsetTop - loadingCircle.offsetHeight) {
          setTimeout(shiftOut, 20);
          this.updateLoadingCircle(frameElement);
        } else this.hideLoadingCircle();
      };
      setTimeout(shiftOut, 0);
    }
    return null;
  }

  private moveLoadingCircle(offsetY: number, frameElement?: HTMLElement) {
    const loadingCircle = this.loadingCircle;
    if (!frameElement) frameElement = document.body;
    if (loadingCircle && frameElement.scrollTop === 0) {
      makeVisible(loadingCircle);
      const pos = offsetY - loadingCircle.clientHeight;
      loadingCircle.style.top = frameElement.offsetTop + Math.min(frameElement.clientHeight / 5, pos) + "px";
      if (pos <= frameElement.clientHeight / 5) {
        loadingCircle.classList.remove("animate");
        this.updateLoadingCircle(frameElement);
      } else if (!loadingCircle.classList.contains("animate")) {
        loadingCircle.classList.add("animate");
        this.updateLoadingCircle(frameElement, true);
      }
    }
  }

  private hideLoadingCircle() {
    const loadingCircle = this.loadingCircle;
    if (loadingCircle) {
      makeVisible(loadingCircle, false);
      loadingCircle.classList.forEach((name) => {
        if (name.startsWith("level")) loadingCircle.classList.remove(name);
      });
      loadingCircle.style.top = loadingCircle.offsetHeight + "px";
    }
  }

  private waitLoadingCircle(move = false) {
    const loadingCircle = this.loadingCircle;
    if (loadingCircle) {
      this.loadingCircleLevel = -1;
      if (move) this.moveLoadingCircle(Number.MIN_SAFE_INTEGER, this.pages.current.div ?? undefined);
      makeVisible(loadingCircle, true);
      loadingCircle.classList.add("animate");
    }
  }

  private wholeSongListDragStart?: number;

  private songListTableReloadHandler(type: "down" | "up" | "move", e: MouseEvent) {
    const loadingCircle = this.loadingCircle;
    if (loadingCircle && this.mode === "App" && this.songListTable) {
      switch (type) {
        case "up":
          if (this.wholeSongListDragStart != null) {
            this.wholeSongListDragStart = undefined;
            const level = this.checkLoadingCircle(this.songListTable);
            if (level) {
              if (level > 2) {
                this.hideLoadingCircle();
                void this.clearAppData();
              } else {
                this.waitLoadingCircle();
                this.updateDatabase(level > 1 ? "RELOAD" : "UPDATE")
                  .then(() => this.hideLoadingCircle())
                  .catch(() => this.hideLoadingCircle());
              }
            }
          }
          break;
        case "down":
          if (this.songListTable.scrollTop <= 2) this.wholeSongListDragStart = e.clientY;
          break;
        case "move":
          if (this.wholeSongListDragStart != null) {
            const diff = e.clientY - this.wholeSongListDragStart;
            this.moveLoadingCircle(diff, this.songListTable);
          }
          break;
      }
    }
  }

  private swipeHandlerEvent(type: "down" | "up" | "move", e: MouseEvent) {
    if (this.editor && !this.editor.readOnly && this.editor.getSelectedText()) {
      e.preventDefault();
      return;
    }

    const x = e.clientX,
      y = e.clientY;
    if (
      this.editor &&
      type !== "move" &&
      !this.editor.inMarkingState &&
      (!this.swipeState || this.swipeState.direction === 0) &&
      this.editor.handleExternalChordBoxTouch(e, type === "down", this.mode === "App")
    ) {
      this.swipeState = null;
      e.preventDefault();
      return false;
    }

    const pageFlipEnabled =
      this.hasNeighbours && !!this.editor?.readOnly && !this.editor?.inMarkingState && (this.mode === "App" || this.chkAdmin?.checked);
    const page = this.pages.current.div;
    if (page)
      switch (type) {
        case "down":
          this.swipeState = { dragX: x, dragY: y, direction: 0, totalScroll: 0, startTime: Date.now() };
          if (this.chordSelector && this.chordSelector.inModal) this.chordSelector.closeDialog();
          break;
        case "up":
          if (this.swipeState) {
            const offsetX = x - this.swipeState.dragX;
            const direction = offsetX / Math.abs(offsetX);
            const level = this.checkLoadingCircle(page);
            if (level) {
              if (level > 2) {
                this.hideLoadingCircle();
                void this.clearAppData();
              } else if (level > 1) {
                this.waitLoadingCircle();
                this.updateDatabase("RELOAD")
                  .then(() => location.reload())
                  .catch(() => location.reload());
              } else {
                this.waitLoadingCircle();
                location.reload();
              }
            }
            if (this.swipeState.direction && this.swipeState.direction * direction >= 0) {
              const left = page.offsetLeft,
                width = page.offsetWidth,
                right = left + width;
              const scale = x > this.swipeState.dragX ? right - this.swipeState.dragX : this.swipeState.dragX - left;
              this.pageTurn(
                x - this.swipeState.dragX,
                scale,
                200,
                Date.now() - this.swipeState.startTime < 200 && Math.abs(x - this.swipeState.dragX) > width * 0.1
              );
            } else {
              if (this.swipeState.lastScroll) {
                const editor = this.editor;
                const rollOut = (step: number) => {
                  if (!this.swipeState && editor === this.editor) {
                    const pos = page.scrollTop;
                    const start = Date.now();
                    page.scrollBy(0, step);
                    if (page.scrollTop !== pos) {
                      const stop = Date.now();
                      step = Math.sign(step) * Math.floor(0.9 * Math.abs(step));
                      if (step) setTimeout(() => rollOut(step), Math.max(stop - start, 20));
                    }
                  }
                };
                const step = this.swipeState.lastScroll;
                setTimeout(() => rollOut(step), 20);
              }
              page.style.border = "none";
              page.style.boxShadow = "none";
            }
            this.swipeState = null;
          }
          break;
        case "move":
          if (this.swipeState) {
            const offsetX = x - this.swipeState.dragX;
            const offsetY = y - this.swipeState.dragY;
            if (offsetX <= page.clientWidth / 10 && offsetY > Math.abs(offsetX)) this.moveLoadingCircle(offsetY, page);
            const direction = offsetX / Math.abs(offsetX);
            const left = page.offsetLeft,
              width = page.offsetWidth,
              right = left + width;
            let isScroll = page.scrollHeight > page.clientHeight && this.swipeState.direction === 0;
            if (pageFlipEnabled && isScroll && this.swipeState.totalScroll < page.clientHeight / 10 && Math.abs(offsetX) > 0.2 * (right - left))
              isScroll = false;
            if (isScroll) {
              page.style.transform = "";
              this.swipeState.lastScroll = this.swipeState.dragY - y;
              page.scrollBy(0, this.swipeState.lastScroll);
              this.swipeState.totalScroll += Math.abs(this.swipeState.lastScroll);
              this.swipeState.dragY = y;
            } else if (pageFlipEnabled && this.swipeState.direction * direction >= 0) {
              page.style.border = "solid black 1px";
              this.swipeState.direction = direction;
              const scale = direction > 0 ? right - this.swipeState.dragX : this.swipeState.dragX - left;
              this.setPagePhase(offsetX, scale);
            }
          }
          break;
      }
    e.preventDefault();
  }

  private changeActualOption(set: HTMLElement | null) {
    const actualize = (actual: boolean) => {
      if (!this.actualOption) return;
      let element = this.actualOption;
      if (!(element instanceof HTMLDivElement) && element.parentElement && element.parentElement instanceof HTMLDivElement)
        element = element.parentElement;
      element.style.backgroundColor = actual ? "darkorange" : "transparent";
    };

    actualize(false);
    this.actualOption = set;
    actualize(true);
  }

  private moveActualOption(down: boolean | undefined) {
    const optionList = this.inOptions
      ? [
          this.chordBoxSelector,
          this.selChordMode,
          this.chkNoSecChordDup,
          this.chkSubscript,
          this.chkAutoTone,
          this.chkUseCapo,
          this.chkBBMode,
          this.chkSimplified,
          this.chkMaxText,
          this.darkMode,
          this.chkHighlight,
        ]
      : [this.selCapo, this.selShift, this.divNetStatus];
    const index = this.actualOption ? optionList.indexOf(this.actualOption) : -1;
    const disabled = (elem: HTMLElement) => {
      for (let e: HTMLElement | null = elem; e; e = e.parentElement) if (isDisabled(e)) return true;
      return false;
    };
    const visible = (elem: HTMLElement) => {
      let e: HTMLElement | null = elem;
      while (e && isVisible(e)) e = e.parentElement;
      return e == null;
    };
    let next = index,
      nextOption: HTMLElement | null,
      loop = -1;
    do {
      if (down === undefined) {
        next = (next + 1) % optionList.length;
        if (next === 0) ++loop;
        if (next === index) break;
      } else {
        next = next + (down ? 1 : -1);
        if (next < 0 || next >= optionList.length) {
          next = index;
          break;
        }
      }
      nextOption = optionList[next];
    } while (loop < 1 && (!nextOption || !visible(nextOption) || disabled(nextOption)));
    if (loop >= 1 || next === index) {
      if (index === -1) {
        for (next = 0; next < optionList.length; ++next) if (optionList[next]) break;
        if (next === optionList.length) next = index;
      }
      if (next === index) return;
    }
    this.changeActualOption(optionList[next]);
  }

  private changeActualOptionValue(down: boolean | undefined) {
    if (!this.actualOption) return;
    let event = "click";
    if (this.actualOption instanceof HTMLInputElement) this.actualOption.checked = !this.actualOption.checked;
    else if (this.actualOption instanceof HTMLSelectElement) {
      let index = this.actualOption.selectedIndex;
      if (down === undefined) index = (index + 1) % this.actualOption.options.length;
      else index = Math.min(this.actualOption.options.length - 1, Math.max(0, index + (down ? 1 : -1)));
      this.actualOption.selectedIndex = index;
      event = "change";
    } else if (!(this.actualOption instanceof HTMLDivElement)) {
      void this.alert("Unhandled type " + this.actualOption.tagName);
      return;
    }

    const evt = document.createEvent("HTMLEvents");
    evt.initEvent(event, false, true);
    this.actualOption.dispatchEvent(evt);
  }

  private moveInSongList(down: boolean) {
    if (!this.nextSongReq) this.nextSongReq = { songId: this.currentDisplay.songId };
    const songId = this.nextSongReq.songId;
    let index = this.playlist.map((x) => x.songId).indexOf(songId);
    index = Math.max(0, Math.min(this.playlist.length - 1, index + (down ? 1 : -1)));
    this.nextSongReq = { ...this.playlist[index] };
    this.updateSelectedSongInList();
  }

  private get inOptions() {
    return this.divOptions?.classList.contains("opened") ?? false;
  }

  private onKeyDown(event: KeyboardEvent) {
    if ((!this.hostDevice && !this.handleKeyboardNavigationEvents) || !this.editor?.readOnly || inModal()) return;
    const code_string = getKeyCodeString(event);
    switch (code_string) {
      case "HOME":
        if (this.inOptions) this.closeOptions(true);
        else this.openOptions();
        break;
      case "PAGEUP":
      case "PAGEDOWN":
        if (this.inOptions) this.moveInSongList(code_string === "PAGEDOWN");
        else if (code_string === "PAGEDOWN") this.onNextSong();
        else this.onPrevSong();
        break;
      case "7":
        if (this.inOptions) this.changeActualOptionValue(undefined);
        else this.moveActualOption(undefined);
        break;
      case "9":
        if (this.inOptions) this.moveActualOption(false);
        else this.changeActualOptionValue(false);
        break;
      case "3":
        if (this.inOptions) this.moveActualOption(true);
        else this.changeActualOptionValue(true);
        break;
      case "NUMLOCK":
        this.changeActualOption(null);
        if (isNumLockEnabled(event)) this.moveActualOption(undefined);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  private orientationChanged() {
    const currentScreen = window.screen;
    let orientation = currentScreen.orientation.angle ?? window.orientation;
    if (orientation == null) {
      const type =
        (currentScreen.orientation || {}).type ||
        (currentScreen as unknown as Record<string, string>)["mozOrientation"] ||
        (currentScreen as unknown as Record<string, string>)["msOrientation"];
      orientation = type === "landscape-secondary" ? -90 : type.startsWith("landscape") ? 90 : 0;
    }
    this.handleOrientationChange(orientation);
  }

  private get landscape() {
    const a = Math.abs(this.orientation);
    if (45 < a && a < 135) return true;
    return this.mainView ? this.mainView.offsetWidth > this.mainView.offsetHeight : screen.width > screen.height;
  }

  public handleOrientationChange(orientation: number | string) {
    if (typeof orientation === "string") {
      orientation = parseInt(orientation);
      if (Number.isNaN(orientation)) orientation = 0;
    }
    if (this.orientation !== orientation) {
      this.orientation = orientation;
      const mainTables = document.getElementsByClassName("mainTable");
      const mainTable = mainTables && mainTables.length > 0 ? mainTables[0] : null;
      if (mainTable) {
        if (-45 > this.orientation && this.orientation > -135) {
          mainTable.classList.add("lefty");
        } else mainTable.classList.remove("lefty");
      }
    }
  }

  private sizeGuardInQueue = 0;
  private sizeGuarded: HTMLElement[] = [];
  private async applySizeGuard(element?: HTMLElement, secondLevel?: boolean) {
    if (!this.sizeGuarded)
      this.sizeGuarded = Array.from(document.getElementsByClassName("widthProtect")).filter((e) => e instanceof HTMLElement) as HTMLElement[];
    if (element !== undefined) {
      const fontSizeBackup = element.style.fontSize;
      element.style.fontSize = "unset";
      await snooze(0);
      const end = Date.now() + 100;
      let failed = false;
      while (element.offsetWidth > 0 && element.scrollWidth > 0 && element.offsetWidth < element.scrollWidth) {
        failed = true;
        try {
          const compStyles = window.getComputedStyle(element);
          if (!compStyles) break;
          const m = compStyles.getPropertyValue("font-size").match(/^([.0-9]+)(.*)$/);
          if (!m) break;
          const num = parseFloat(m[1]);
          if (isNaN(num) || num <= 0) break;
          const dim = m[2];
          let next = Math.floor(num);
          if (next === num) --next;
          if (next < 1) break;
          element.style.fontSize = next + dim;
          if (end < Date.now()) break;
        } catch (e) {
          this.log("SizeGuardError: " + e);
          break;
        }
        await snooze(0);
        failed = false;
      }
      if (failed) element.style.fontSize = this.baseFontSizeSlider ? this.baseFontSizeSlider.min + "pt" : fontSizeBackup;
    } else {
      ++this.sizeGuardInQueue;
      setTimeout(() => {
        if (--this.sizeGuardInQueue) {
          for (const e of this.sizeGuarded) this.applySizeGuard(e);
          if (!secondLevel) setTimeout(() => this.applySizeGuard(undefined, true), 500);
        }
      }, 100);
    }
  }

  private onResize() {
    if (this.virtualKeyboardRect) {
      const keyboardHeight = this.virtualKeyboardRect.height;
      const coll = document.getElementsByClassName("editorContainer");
      for (let i = 0; i < coll.length; ++i) {
        const item = coll.item(i) as HTMLElement | null;
        if (item && isVisible(item) && item.style.display !== "none") {
          const setEditorHeight = async () => {
            const top = item.getBoundingClientRect().top;
            const margin = Math.max(top, 16);
            item.style.height = Math.min(window.innerHeight, screen.availHeight) - top - keyboardHeight - margin + "px";
            for (let retries = 0; this.virtualKeyboardRect?.height === keyboardHeight && retries < 50; ++retries) {
              if (Math.ceil(screen.availHeight) + 1 >= Math.floor(window.innerHeight)) break;
              await snooze(100);
            }
            if (this.virtualKeyboardRect?.height) {
              item.style.height = Math.min(window.innerHeight, screen.availHeight) - top - this.virtualKeyboardRect.height - margin + "px";
            } else item.style.removeProperty("height");
          };
          if (!keyboardHeight) item.style.removeProperty("height");
          else if (!item.style.height) setEditorHeight();
        } else item?.style.removeProperty("height");
      }
    }
    if (this.swipeHandler) makeVisible(this.swipeHandler, this.landscape || !this.inOptions);
    this.updateFullScreenIcons(); // no use, but maybe one time
    this.updateEditor();
    this.applySizeGuard();
  }

  private initShiftAndCapo() {
    if (this.selShift)
      for (let i = -11; i < 12; ++i) {
        const o = document.createElement("option") as HTMLOptionElement;
        o.value = i.toString();
        o.innerText = Math.abs(i) + (i < 0 ? "b" : i > 0 ? UnicodeSymbol.sharp : "");
        this.selShift.appendChild(o);
      }
    if (this.selCapo)
      for (let i = -1; i < 12; ++i) {
        const o = document.createElement("option") as HTMLOptionElement;
        o.value = i.toString();
        o.innerText = i >= 0 ? o.value : "";
        this.selCapo.appendChild(o);
      }
  }

  private updateTransposeDisplay(value: number) {
    if (this.spanShift) {
      if (value) this.spanShift.innerText = this.currentDisplay.transpose > 0 ? value + UnicodeSymbol.sharp : Math.abs(value) + "b";
      else this.spanShift.innerText = "";
      if (this.iconTranspose) this.iconTranspose.style.opacity = value ? "0" : "1";
    }
  }

  private resetShift() {
    if (this.selShift) this.selShift.options[11].selected = true;
    this.updateTransposeDisplay(0);
  }

  private resetCapo(val: number = 0) {
    this.capoVal = val;
    if (this.selCapo) this.selCapo.selectedIndex = this.capoVal + 1;
    this.updateCapoLabel();
  }

  public calcRes(editorDiv?: HTMLElement) {
    const rect = (editorDiv ?? this.pages.current.editorDiv)?.getBoundingClientRect();
    if (!rect?.width && !rect?.height && this.editor?.scale) return this.editor.scale;
    const pixels = Math.max(rect?.width ?? screen.width, rect?.height ?? screen.height);
    return Math.max(1.00000001, Math.round(pixels / 500) + 1);
  }

  public loadDiff(chp: string, chordSystemCode: ChordSystemCode, original: string, editable: boolean = false) {
    if (this.pages.current.editorDiv) {
      const editor = new ChordProEditor(
        getChordSystem(chordSystemCode),
        this.pages.current.editorDiv,
        chp,
        editable,
        this.calcRes(),
        undefined,
        true,
        original
      );
      editor.onLog = (s: string) => this.log(s);
      this.pages.current.editor = editor;
      this.editor?.darkMode(this.isCurrentlyDark);
      this.editor?.setDisplayMode(true, true, true, false, false, 0);
      this.updateEditor();
    }
  }

  public start(greeting: string) {
    const start = Date.now();
    const loadTimeout = greeting ? 3000 : 0;

    if (greeting) this.loadSong("", greeting, "G", { editable: false, forceUpdate: true });

    (async () => {
      while (this.allSongModeState === "LOADING") await snooze(100);

      let listId = (document.getElementById("pp-initial-list")?.innerText ?? "").trim();
      const songId = (document.getElementById("pp-initial-song")?.innerText ?? "").trim();

      if (!listId && !songId) {
        await snooze(Math.max(0, loadTimeout - Date.now() + start));
        this.onNextSong();
        return;
      }

      if (greeting) await snooze(Math.max(0, loadTimeout - Date.now() + start));

      const dbSong = this.database?.getSong(songId);
      let entry: SongEntry | undefined = dbSong
        ? { songId: dbSong.Id, title: dbSong.Title, songdata: { text: dbSong.Text, system: dbSong.System } }
        : undefined;
      if (listId && this.selPlaylists) {
        const m = /^(.*)@([0-9]+)$/.exec(listId);
        if (m) listId = m[1];
        const songIndex = m ? parseInt(m[2], 10) : -1;
        let i = -1;
        while (++i < this.selPlaylists.options.length) {
          if (this.selPlaylists.options[i].value === listId) {
            this.switchToPlaylistView();
            this.selPlaylists.selectedIndex = i;
            this.leaderPlaylistSelected();
            const entries = await this.applyFilterOnLocalSongList();
            if (entries && entries.length > 0) {
              const selected = songIndex >= 0 && songIndex < entries.length ? entries[songIndex] : undefined;
              if (!entry) entry = selected ?? entries[0];
              else if (entry.songId === selected?.songId) entry = selected;
              else entry = this.playlist.find((x) => x.songId === entry?.songId) ?? entries[0];
            }
            break;
          }
        }
      }

      if (entry) this.selectFromAllSongs(entry);
      else {
        if (songId) await this.alert("Sorry, no song found with id: " + songId);
        this.onNextSong();
      }
      this.allSongModeState = "READY";
      this.restoreDisplaySettings(true);
    })();
  }

  public loadSong(
    id: string,
    chp: string,
    chordSystemCode: ChordSystemCode,
    options?: {
      preferredCapo?: number;
      editable?: boolean;
      forceUpdate?: boolean;
      diffbasetext?: string;
      drawingSuppressed?: boolean;
    }
  ) {
    const { editor } = this.pages.current.load(chp, chordSystemCode, options);
    if (!editor) return;

    editor.onLog = (s: string) => this.log(s);

    this.preferredCapo = Math.max(0, options?.preferredCapo ?? this.pages.current.preferredCapo);
    this.resetCapo(this.chkUseCapo?.checked ? this.preferredCapo : undefined);

    this.currentDisplay.songId = id;
    this.currentDisplay.song = chp;
    this.currentDisplay.system = chordSystemCode;

    if (this.codeTextArea) this.codeTextArea.value = editor.chordProCode ?? "";
    editor.onChange = (s) => {
      if (this.codeTextArea) this.codeTextArea.value = s;
    };

    this.resetShift();
    this.displayChanged(undefined, options?.drawingSuppressed);
    this.updateFieldsForUser();
    this.updateChordBoxTypeImage();
    this.updateEditIconsByState();

    if (this.pages.current.div?.scrollTo) this.pages.current.div?.scrollTo(0, 0);
    else document.documentElement.scrollTop = 0;

    if (options?.forceUpdate) this.updateEditor();

    return editor;
  }

  public setupChordBoxMode() {
    this.handleKeyboardNavigationEvents = false;
    if (this.editor) this.editor.displayProps.chordFont = "28px arial";
  }

  private updateAspectRatio(editor: ChordProEditor) {
    editor.parentDiv.style.aspectRatio = editor.canvas.width + "/" + editor.canvas.height;
  }

  private verifyChordSelectorSystem(system: ChordSystem) {
    if (this.chordSelector && this.chordSelector.system !== system) this.chordSelector.setNoteSystem(system);
  }

  private updateEditor(page?: EditorPage, keepDrawingSuppressed?: boolean) {
    if (!page) page = this.pages.current;
    const editor = page.editor;
    if (editor) {
      if (page !== this.preview) this.verifyChordSelectorSystem(editor.system);
      editor.targetRatio =
        page.div?.parentNode instanceof HTMLDivElement
          ? page.div.parentNode.clientWidth / page.div.parentNode.clientHeight
          : screen.width / screen.height;
      editor.scale = this.calcRes(editor.parentDiv);
      editor.update(keepDrawingSuppressed);
      this.updateAspectRatio(editor);
      editor.onLyricsHit = (s) => this.onLyricsHit(s);
    }
  }

  private async onLineSel(p: number) {
    if (!this.webRoot || (this.currentDisplay.from <= p && p < this.currentDisplay.to)) return;
    try {
      await cloudApi.sendHighlight({
        line: p,
        leader: this.leaderId,
        deviceId: this.ppdDeviceId,
      });
    } catch (error) {
      if (error) this.log("Error sending highlight line selection: " + p + " error: " + error);
    }
  }

  private async onLyricsHit(hit: HighlightingParams) {
    if (!this.webRoot || !this.itIsMyOnlineSession || !this.chkHighlight?.checked) return;
    try {
      await cloudApi.sendHighlight({
        from: hit.from,
        to: hit.to,
        section: hit.section,
        leader: this.leaderId,
        deviceId: this.ppdDeviceId,
        message: hit.lyrics,
      });
    } catch (error) {
      if (error) this.log("Error sending highlight message: " + hit.lyrics + " error: " + error);
    }
  }

  private requestSong(req: SongRequest) {
    if (this.webRoot)
      cloudApi
        .sendPost(
          "/display_update",
          {
            id: req.songId,
            transpose: req.transpose?.toString() ?? "",
            capo: req.capo?.toString() ?? "",
          },
          { "X-PP-Intent": this._leaderToken ?? "control-update" }
        )
        .then(() => {
          if (this.inOptions) void this.closeOptions(!this.landscape);
        })
        .catch((code) => {
          this.log("Cannot update song: " + req.songId + " error: " + code);
        });
  }

  private transpose(new_transpose: number, draw = true) {
    if (this.selShift)
      for (let i = 0; i < this.selShift.options.length; ++i)
        if (this.selShift.options[i].value === new_transpose.toString()) this.selShift.options[i].selected = true;
    if (this.editor) this.editor.transpose(new_transpose - this.currentDisplay.transpose, draw);
    this.currentDisplay.transpose = new_transpose;
    this.updateTransposeDisplay(new_transpose);
  }

  private applyInstructions(instructions: string | undefined, draw = true) {
    if (this.editor) this.editor.applyInstructions(instructions ?? "", draw);
    this.currentDisplay.instructions = instructions;
  }

  private setLeader(e: boolean) {
    for (const leaderField of [this.songListTable, this.divTranspose, this.btnPrev, this.btnNext]) {
      if (leaderField) makeVisible(leaderField, e);
    }
    if (this.labOptions) makeVisible(this.labOptions, !e);
    if (this.btnNetDisplay) makeVisible(this.btnNetDisplay, !e);
    if (this.searchRow) makeVisible(this.searchRow, e);
    if (e) this.verifyNeighbouringSongs();
  }

  private onNextSong() {
    if (!this.btnNext || !isDisabled(this.btnNext)) {
      if (this.btnPrev) makeDisabled(this.btnPrev);
      if (this.btnNext) makeDisabled(this.btnNext);
      if (this.pages.next?.editor?.hasDoc()) this.pageTurn(-1, 100, 200, true);
      else this.changeSong(true);
    }
  }

  private onPrevSong() {
    if (!this.btnPrev || !isDisabled(this.btnPrev)) {
      if (this.btnPrev) makeDisabled(this.btnPrev);
      if (this.btnNext) makeDisabled(this.btnNext);
      if (this.pages.prev?.editor?.hasDoc()) this.pageTurn(1, 100, 200, true);
      else this.changeSong(false);
    }
  }

  private async changeSong(next: boolean) {
    if (this.chordSelector && this.chordSelector.inModal) this.chordSelector.closeDialog();

    if (this.pages.prev?.div && this.pages.next?.div) {
      if (next && this.pages.next.loaded) {
        const last = this.pages.prev;
        this.pages.prev = this.pages.current;
        this.pages.current = this.pages.next;
        this.pages.next = last;
      }
      if (!next && this.pages.prev.loaded) {
        const first = this.pages.next;
        this.pages.next = this.pages.current;
        this.pages.current = this.pages.prev;
        this.pages.prev = first;
      }
    }
    for (const page of [this.pages.prev, this.pages.next, this.pages.current]) {
      const div = page?.div;
      if (div) {
        div.style.transform = "";
        div.style.border = "none";
        div.style.boxShadow = "none";
        div.style.zIndex = page === this.pages.current ? "0" : "-1";
        div.style.display = page === this.pages.current ? "unset" : "none";
      }
    }

    if (this.songToCheck) {
      const currentIsDiff = this.currentDisplay.songId === this.songToCheck.songId;
      if (this.songToCheck.current) {
        if (currentIsDiff)
          this.loadSong(
            this.songToCheck.songId + "+1",
            next ? this.songToCheck.songdata.text : this.songToCheck.current,
            this.songToCheck.songdata.system,
            { editable: false, forceUpdate: true }
          );
        else {
          this.loadSong(this.songToCheck.songId, this.songToCheck.songdata.text, this.songToCheck.songdata.system, {
            editable: false,
            forceUpdate: true,
            diffbasetext: this.songToCheck.current,
          });
        }
      } else this.loadSong(this.songToCheck.songId + "-1", this.songToCheck.songdata.text, this.songToCheck.songdata.system);
      if (this.btnPrev) makeDisabled(this.btnPrev, currentIsDiff && !next);
      if (this.btnNext) makeDisabled(this.btnNext, currentIsDiff && next);
      return;
    }

    const entry = this.getNeighbouringPlaylistEntry(next);
    if (entry) {
      if (this.mode === "App") {
        this.selectFromAllSongs(entry);
      } else {
        const promise = new Promise<void>((resolve) => {
          this.onSongDisplayed.songId = entry.songId;
          this.onSongDisplayed.cb = resolve;
        });
        this.requestSong(entry);
        return promise;
      }
    }
  }

  private getNeighbouringPlaylistEntry(next: boolean) {
    let nextIdx = this.currentDisplay.songId ? -1 : 0;
    for (let i = 0; i < this.playlist.length; ++i) {
      const song_id = this.playlist[i].songId;
      if (song_id === this.currentDisplay.songId) {
        i += next ? 1 : -1;
        nextIdx = i;
        break;
      }
    }
    return nextIdx >= 0 && nextIdx < this.playlist.length ? this.playlist[nextIdx] : null;
  }

  private updateCapoLabel() {
    if (this.spanCapo) this.spanCapo.innerText = this.capoVal > 0 ? this.capoVal.toString() : this.chkUseCapo?.checked ? "!" : "";
  }

  private capoChanged() {
    if (!this.selCapo) return;
    if (this.capoVal !== this.selCapo.selectedIndex) {
      if (this.editor) this.editor.transpose(this.capoVal - this.selCapo.selectedIndex);
      this.capoVal = this.selCapo.selectedIndex - 1;
      if (this.chkAdmin?.checked) {
        if (this.chkUseCapo) this.chkUseCapo.checked = true;
        if (this.capoVal >= 0) this.capoRequest(this.capoVal);
      }
      this.updateCapoLabel();
      this.storeDisplaySettings();
    }
  }

  private useCapoChanged() {
    if (this.chkUseCapo?.checked) {
      if (this.editor && this.capoVal !== this.preferredCapo) this.editor.transpose(this.capoVal - this.preferredCapo);
      this.resetCapo(this.preferredCapo);
    } else if (this.capoVal === this.preferredCapo) {
      if (this.editor) this.editor.transpose(this.preferredCapo);
      this.resetCapo(0);
    }
    this.verifyNeighbouringSongs(undefined, true);
    this.storeDisplaySettings();
  }

  private setFontSizeDetails() {
    if (this.fontSizeDialog && this.baseFontSizeSlider) {
      this.baseFontSizeSlider.value = document.documentElement.style.fontSize.replace(/pt$/g, "");
      doModal(this.fontSizeDialog, "");
    }
  }

  private displayChanged(pageToUpdate?: EditorPage, keepDrawingSuppressed?: boolean) {
    if (!pageToUpdate || pageToUpdate === this.pages.current) this.storeDisplaySettings();

    if (keepDrawingSuppressed && !(this.mainView?.classList.contains("split") && this.landscape) && !pageToUpdate && this.inOptions) {
      this.displayChangedInOptions = true;
      return;
    }

    let chordFormatFlags = this.selChordMode ? parseInt(this.selChordMode.options[this.selChordMode.selectedIndex].value) : 0;
    if (this.chkSubscript?.checked) chordFormatFlags += CHORDFORMAT_SUBSCRIPT;
    if (this.chkBBMode?.checked) chordFormatFlags += CHORDFORMAT_BB;
    if (this.chkSimplified?.checked) chordFormatFlags += CHORDFORMAT_SIMPLIFIED;
    if (this.chkNoSecChordDup?.checked) chordFormatFlags += CHORDFORMAT_NOSECTIONDUP;
    if (this.chkAutoTone?.checked) chordFormatFlags += CHORDFORMAT_INKEY;

    for (const page of pageToUpdate ? [pageToUpdate] : [this.pages.prev, this.pages.next, this.pages.current]) {
      const editor = page?.editor;
      if (editor) {
        this.verifyChordSelectorSystem(editor.system);
        editor.setDisplayMode(
          !this.chkMaxText?.checked,
          !this.chkMaxText?.checked,
          true,
          !!this.chkMaxText?.checked,
          !!this.chkMaxText?.checked && !this.chkHighlight?.checked,
          this.chordBoxType === "NO_CHORDS" ? CHORDFORMAT_NOCHORDS : chordFormatFlags,
          this.chordBoxType === "NO_CHORDS" ? "" : this.chordBoxType,
          keepDrawingSuppressed
        );
        editor.enableInstructionRendering(this.chkUseInstructions?.checked ? "FIRST_LINE" : "", !keepDrawingSuppressed);
        this.updateAspectRatio(editor);
        if (this.mainView?.classList.contains("split") && this.landscape && !keepDrawingSuppressed)
          this.updateEditor(undefined, keepDrawingSuppressed);
      }
    }
  }

  private async queryEditPermission() {
    let editable = false;
    try {
      editable = await cloudApi.checkEditable(this.currentDisplay.songId);
    } catch (error) {
      if (("" + error).trim() !== "0") this.log("Query edit permission error: " + error);
    }
    if (this.divStartEdit) {
      makeVisible(this.divStartEdit, editable);
      this.applySizeGuard();
    }
  }

  private async queryHighlightPermission(verifyOnly: boolean = false) {
    if (!this.webRoot || this.mode !== "Client") return;

    if (this.iconHighLightLoader) makeVisible(this.iconHighLightLoader);
    if (this.highlightIconHolderDiv) makeVisible(this.highlightIconHolderDiv, false);

    try {
      const highlighter = await cloudApi.fetchHighlightPermission(this.leaderId, this.ppdDeviceId, verifyOnly);
      if (highlighter === "NOPE" && this.divStartEdit) makeVisible(this.divStartEdit, false);
      const granted = highlighter === "GRANTED";
      if (this.editor) this.editor.onLineSel = granted ? (s) => this.onLineSel(s) : null;
      if (this.iconHighlighter && this.iconHighlighted) {
        makeVisible(this.iconHighlighter, granted);
        makeVisible(this.iconHighlighted, !granted);
      } else if (this.highlightIconHolderDiv) this.highlightIconHolderDiv.innerHTML = granted ? "&#128070;" : "&#128161;";
      if (granted && this.chkHighlight) this.chkHighlight.checked = true;
      if (this.iconHighLightLoader) makeVisible(this.iconHighLightLoader, false);
      if (this.highlightIconHolderDiv) makeVisible(this.highlightIconHolderDiv);
      if (this.unhighlight) makeVisible(this.unhighlight, granted);
      this.updateHighlight();
    } catch (error) {
      this.log("Query highlight permission failed: " + error);
      if (this.editor) this.editor.onLineSel = null;
      if (this.iconHighlighter && this.iconHighlighted) {
        makeVisible(this.iconHighlighter, false);
        makeVisible(this.iconHighlighted);
      } else if (this.highlightIconHolderDiv) this.highlightIconHolderDiv.innerHTML = "&#128161;";
      if (this.iconHighLightLoader) makeVisible(this.iconHighLightLoader, false);
      if (this.highlightIconHolderDiv) makeVisible(this.highlightIconHolderDiv);
      if (this.unhighlight) makeVisible(this.unhighlight, false);
      if (this.divStartEdit) makeVisible(this.divStartEdit, false);
      this.updateHighlight();
    }
  }

  private onHighlightIconClicked(event: Event, down: boolean) {
    const now = Date.now();
    if (down) this.highLightClickDownTime = now;
    else if (this.highLightClickDownTime && this.highLightClickDownTime + 2000 <= now && now < this.highLightClickDownTime + 10000)
      this.queryHighlightPermission();
    else this.highLightClickDownTime = null;
  }

  private updateHighlight(draw = true) {
    if (!this.editor) return;
    if (this.chkHighlight?.checked) this.editor.highlight(this.currentDisplay.from, this.currentDisplay.to, draw);
    else this.editor.highlight(0, 0, draw);
  }

  private chkHighlightClicked() {
    if (this.itIsMyOnlineSession) {
      if (this.unhighlight) makeVisible(this.unhighlight, this.chkHighlight?.checked);
    } else if (++this.highlightChangedRecently >= 5) {
      this.queryHighlightPermission();
      this.highlightChangedRecently = 0;
    } else setTimeout(() => (this.highlightChangedRecently = Math.max(this.highlightChangedRecently - 1, 0)), 2000);

    this.displayChanged();
    this.updateHighlight();
  }

  private setNetworkState(status: string, error?: Error) {
    status = status.toLowerCase();
    this.isOnline = status == "online";
    if (this.divNetStatus) {
      this.divNetStatus.classList.remove("loading");
      for (const s of ["startup", "online", "offline", "transfer", "nearby"]) this.divNetStatus.classList.remove("net-" + s);
      this.divNetStatus.classList.add("net-" + status);
    }
    if (this.iconLoadingList) makeVisible(this.iconLoadingList, ["startup", "transfer"].indexOf(status) >= 0);
    if (error) this.log("Network status error: " + error);
  }

  private openOptions() {
    if (this.swipeHandler) makeVisible(this.swipeHandler, this.landscape);
    if (this.chordSelector && this.chordSelector.inModal) this.chordSelector.closeDialog();
    this.changeActualOption(null);
    if (this.divOptions) {
      this.divOptions.classList.add("opened");
      this.updateSongListSelectionWhenOptionsOpened();
    }
    if (this.mainView) this.mainView.classList.add("split");
    this.displayChangedInOptions = false;
  }

  private async loadSongToCheck(req: DiffSongRequest) {
    this.songToCheck = req;
    this.loadSong(req.songId, req.songdata.text, req.songdata.system, {
      editable: false,
      forceUpdate: true,
      diffbasetext: req.current,
    });
    if (req.current) {
      for (const page of [this.pages.prev, this.pages.next])
        if (page) {
          const { loaded } = page.load(this.pages.prev === page ? req.current : req.songdata.text, req.songdata.system);
          if (loaded) {
            this.displayChanged(page, true);
            this.updateEditor(page);
          }
        }
    }
    if (this.btnPrev) makeDisabled(this.btnPrev, !req.current);
    if (this.btnNext) makeDisabled(this.btnNext, !req.current);
  }

  private async closeOptions(explicit?: boolean) {
    try {
      if (this.swipeHandler) makeVisible(this.swipeHandler, true);
      if (this.searchRow && isVisible(this.searchRow)) this.songSearchMode(false);
      this.changeActualOption(null);
      if (this.nextSongReq) {
        const req = this.nextSongReq;
        this.nextSongReq = null;
        if (this.iconLoadingList) makeVisible(this.iconLoadingList);
        this.updateSelectedSongInList(req);
        await snooze(0);
        if (isDiffSongRequest(req)) this.loadSongToCheck(req);
        else if (this.mode === "App") this.selectFromAllSongs(req);
        else this.requestSong(req);
      }
      for (let elem: HTMLElement | undefined; (elem = inModal()); ) endModal(elem);
      if (this.displayChangedInOptions) {
        this.displayChangedInOptions = true;
        if (this.iconLoadingList) makeVisible(this.iconLoadingList);
        await snooze(0);
        this.displayChanged(undefined, false);
      }
    } finally {
      if (this.iconLoadingList) makeVisible(this.iconLoadingList, false);
      if (explicit) {
        if (this.divOptions) this.divOptions.classList.remove("opened");
        if (this.mainView) {
          if (this.landscape) this.mainView.classList.remove("split");
          else this.mainView.classList.add("split");
        }
      }
    }
  }

  private updateSongListSelectionWhenOptionsOpened() {
    if (!this.divOptions) return;
    const prevHeight = this.divOptions.clientHeight;
    setTimeout(() => {
      if (this.divOptions) {
        const current = this.divOptions.clientHeight;
        if (current > 0 && prevHeight === current) this.updateSelectedSongInList();
        else this.updateSongListSelectionWhenOptionsOpened();
      }
    }, 20);
  }

  private updateChordBoxTypeImage() {
    const type = this.chordBoxType || "";
    const noChords = type === "NO_CHORDS";
    if (this.iconNoChordMode) makeVisible(this.iconNoChordMode, noChords);
    if (this.iconNoChordBox) makeVisible(this.iconNoChordBox, type === "");
    if (this.iconGuitarChordBox) makeVisible(this.iconGuitarChordBox, type === "GUITAR");
    if (this.iconPianoChordBox) makeVisible(this.iconPianoChordBox, type === "PIANO");

    for (const input of [
      this.selChordMode,
      this.chkNoSecChordDup,
      this.chkSubscript,
      this.chkSimplified,
      this.chkBBMode,
      this.chkUseCapo,
      this.chkAutoTone,
    ]) {
      if (input) makeDisabled(input.parentElement instanceof HTMLDivElement ? input.parentElement : input, noChords);
    }
  }

  private onChordBoxSelectorChange() {
    const type = this.chordBoxType;
    const poss: ("" | "GUITAR" | "PIANO" | "NO_CHORDS")[] = ["", "GUITAR", "PIANO", "NO_CHORDS"];
    const next = poss[(poss.indexOf(type) + 1) % poss.length];
    this.chordBoxType = next;
    this.updateChordBoxTypeImage();
    this.displayChanged();
  }

  private updateTableFromEntries(entries: SongEntry[]) {
    let firstSong: SongEntry | null = null;
    if (this.songListTable) {
      this.songListTable.innerHTML = "";

      const endDnD = (event: DragEvent, to: number | null | undefined) => {
        event.preventDefault();
        if (!this.draggedRow) return;
        const fromString = event.dataTransfer?.getData("text");
        if (fromString != null) {
          if (to !== undefined) {
            const from = parseInt(fromString);
            const element = entries[from];
            entries.splice(from, 1);
            if (to != null) {
              if (to < entries.length) entries.splice(to, 0, element);
              else entries.push(element);
            }
          }
          this.updateTableFromEntries(entries);
          if (to !== undefined)
            this.sendPlaylistUpdateRequest(
              entries.map((x) => {
                return {
                  songId: x.songId,
                  transpose: x.transpose,
                  title: x.title,
                  capo: x.capo,
                  instructions: x.instructions,
                };
              })
            );
        }
        this.draggedRow = null;
        if (this.trashCan) {
          this.trashCan.classList.remove("droptarget");
          this.trashCan.classList.add("hidden");
        }
      };

      this.songListTable.ondragover = (event: DragEvent) => {
        if (this.draggedRow && this.songListTable) {
          event.preventDefault();
          this.songListTable.tBodies[0].appendChild(this.draggedRow);
        }
      };

      this.songListTable.ondrop = (event: DragEvent) => endDnD(event, entries.length);
      if (this.trashCan) {
        this.trashCan.ondragover = (event: DragEvent) => event.preventDefault();
        this.trashCan.ondrop = (event: DragEvent) => endDnD(event, null);
      }

      for (let i = 0; i < entries.length; ++i) {
        let cellCount = 0;
        const songEntry = entries[i];
        const row = this.songListTable.insertRow(this.songListTable.rows.length);

        const isFoundList = entryIsFound(songEntry);

        let checkBox: HTMLInputElement | undefined = undefined;
        if (isFoundList && this.mode !== "App") {
          const checkBoxCell = row.insertCell(cellCount++);
          checkBox = document.createElement("input") as HTMLInputElement;
          checkBox.type = "checkbox";
          const stopPropagation = (event: Event) => event.stopPropagation();
          checkBoxCell.onclick = stopPropagation;
          checkBoxCell.onmousedown = stopPropagation;
          checkBoxCell.ontouchstart = stopPropagation;
          checkBoxCell.ontouchend = stopPropagation;
          checkBox.onmousedown = stopPropagation;
          checkBox.ontouchstart = stopPropagation;
          checkBox.ontouchend = stopPropagation;
          checkBoxCell.appendChild(checkBox);
        }

        const strip = (): SongEntry => {
          const stripped: SongEntry & { found?: unknown } = { ...songEntry };
          delete stripped.found;
          return stripped;
        };

        const enableRow = () => {
          if (checkBox) {
            checkBox.checked = false;
            checkBox.onclick = (e) => {
              if (!this.currentDisplay.playlist) this.currentDisplay.playlist = [];
              this.currentDisplay.playlist.push(strip());
              cloudApi.abortAll();
              this.sendPlaylistUpdateRequest(this.currentDisplay.playlist, (error) => {
                if (!error) disableRow(songEntry);
              });
              e.preventDefault();
              e.stopPropagation();
            };
          }
        };
        const disableRow = (item: PlaylistEntry) => {
          if (checkBox) {
            checkBox.checked = true;
            checkBox.onclick = (e) => {
              if (item && this.currentDisplay.playlist) {
                this.currentDisplay.playlist = this.currentDisplay.playlist.filter((x) => x !== item);
                cloudApi.abortAll();
                this.sendPlaylistUpdateRequest(this.currentDisplay.playlist, (error) => {
                  if (!error) enableRow();
                });
              }
              e.preventDefault();
              e.stopPropagation();
            };
          }
        };

        const cell = row.insertCell(cellCount++);
        cell.className = "songItem";
        const p = document.createElement("p");
        cell.appendChild(p);
        p.innerText = songEntry.title;
        if (isFoundList) {
          if (songEntry.found.snippet) {
            if (songEntry.found.type === "TITLE") p.innerHTML = songEntry.found.snippet;
            else p.innerHTML += "&nbsp;(<small><i>" + songEntry.found.snippet + "</i></small>)";
          }
          const foundTypeCell = row.insertCell(cellCount++);
          foundTypeCell.className = "foundTypeImage";
          if (songEntry.found.cost >= 0)
            foundTypeCell.style.backgroundImage =
              "url(images/found_" +
              songEntry.found.type.toLocaleLowerCase() +
              (songEntry.found.cost >= notPhraseFoundAdditionalCost ? "_words" : "") +
              ".svg)";
          if (this.mode !== "App") {
            cell.onclick = async () => {
              const preview = this.preview;
              if (preview) {
                if (preview.editorDiv) makeDark(preview.editorDiv, this.isCurrentlyDark);
                try {
                  const songs = await this.requestSongs([songEntry.songId]);
                  if (songs.size > 0 && preview.editorDiv) doModal(preview.editorDiv, "");
                  songs.forEach((songInfo) => {
                    const { editor } = preview.load(songInfo.songdata?.text ?? "", songInfo.songdata?.system, { preferredCapo: songInfo.capo });
                    if (editor) {
                      if (songInfo.transpose) editor.transpose(songInfo.transpose);
                      editor.setDisplayMode(false, false, false, false, false, 0, "");
                      this.updateEditor(preview);
                    }
                  });
                } catch (error) {
                  this.log("Error during song download: " + error);
                }
              }
            };
            const addAndGoCell = row.insertCell(cellCount++);
            addAndGoCell.className = "quickLoadSong";
            addAndGoCell.innerText = "▶";
            addAndGoCell.onclick = (e) => {
              if (checkBox) {
                if (!checkBox.checked) {
                  if (!this.currentDisplay.playlist) this.currentDisplay.playlist = [];
                  this.currentDisplay.playlist.push(strip());
                  this.sendPlaylistUpdateRequest(this.currentDisplay.playlist, (error) => {
                    if (!error) {
                      disableRow(songEntry);
                      this.nextSongReq = songEntry;
                      this.closeOptions(!this.landscape);
                    }
                  });
                } else {
                  this.nextSongReq = songEntry;
                  this.closeOptions(!this.landscape);
                }
              }
              e.preventDefault();
            };
          }
          enableRow();
        }
        if (this.mode === "App" || !isFoundList) {
          let doubleclicked = 0;
          (this.mode === "App" ? row : cell).onclick = () => {
            if (this.mode === "App") {
              this.nextSongReq = songEntry;
              this.closeOptions(!this.landscape);
            } else
              setTimeout(() => {
                if (--doubleclicked < 0) {
                  this.updateSelectedSongInList(songEntry);
                  this.requestSong(songEntry);
                }
              }, 300);
          };
          if (isDiffSongRequest(songEntry)) {
            const typeCell = row.insertCell(0);
            ++cellCount;
            typeCell.className = "typeColumn";
            typeCell.innerText = songEntry.state === "KEPT" ? "🔒" : songEntry.state === "REJECTED" ? "🚫" : "?";
            if (this.login !== songEntry.uploader) {
              const authorCell = row.insertCell(cellCount++);
              authorCell.className = "authorColumn";
              authorCell.innerText = songEntry.uploader;
            } else cell.colSpan = 2;
          } else if (this.mode === "App" ? this.selPlaylists && isVisible(this.selPlaylists) : this.mode === "Client" || this.leaderMode) {
            const songId = songEntry.songId;
            if (this.mode !== "App")
              cell.ondblclick = () => {
                doubleclicked = 2;
                setTimeout(async () => {
                  if (this.inOptions || this.landscape) {
                    const str = await this.inputText(cell, songEntry.title);
                    if (str !== songEntry.title) {
                      await this.preferenceUpdate("title", str, songId);
                      songEntry.title = songId;
                    }
                  }
                }, 500);
              };

            const genSelector = (td: HTMLElement, transpose: boolean) => {
              const label = (value: number) =>
                !transpose
                  ? value < 0
                    ? ""
                    : value.toString()
                  : value < 0
                    ? Math.abs(value) + UnicodeSymbol.flat
                    : value > 0
                      ? value + UnicodeSymbol.sharp
                      : "0";
              const lab = document.createElement("span");
              if (transpose) {
                lab.innerText = songEntry.transpose
                  ? songEntry.transpose > 0
                    ? songEntry.transpose + UnicodeSymbol.sharp
                    : Math.abs(songEntry.transpose) + UnicodeSymbol.flat
                  : "";
              } else lab.innerText = songEntry.capo != null && songEntry.capo >= 0 ? songEntry.capo.toString() : "";
              td.appendChild(lab);
              if (this.mode !== "App") {
                const sel = document.createElement("select") as HTMLSelectElement;
                for (let optIndex = transpose ? -11 : -1; optIndex < 12; ++optIndex) {
                  const option = document.createElement("option") as HTMLOptionElement;
                  option.label = label(optIndex);
                  option.value = optIndex.toString();
                  option.selected = (transpose ? (songEntry.transpose ?? 0) : (songEntry.capo ?? 0)) === optIndex;
                  sel.add(option);
                }
                sel.onchange = transpose
                  ? () => this.transposeRequest(sel.options[sel.selectedIndex].value, songId)
                  : () => this.capoRequest(sel.selectedIndex - 1, songId);
                makeReadonly(sel, false);
                td.appendChild(sel);
                td.ontouchend = (e) => {
                  const path = e.composedPath?.() || [];
                  const usesNativeSelect =
                    e.target instanceof HTMLSelectElement ||
                    e.target instanceof HTMLOptionElement ||
                    path.some((el) => el instanceof HTMLElement && (el.tagName === "SELECT" || el.tagName === "OPTION"));
                  if (!usesNativeSelect) {
                    // Keep the old touch behavior for the cell itself, but never block native select opening on mobile.
                    e.preventDefault();
                    e.stopPropagation();
                  }
                };
              }
            };

            const transposeCell = row.insertCell(cellCount++);
            genSelector(transposeCell, true);
            transposeCell.className = "transposeColumn";
            if (songEntry.transpose) transposeCell.style.backgroundImage = "unset";
            const capoCell = row.insertCell(cellCount++);
            genSelector(capoCell, false);
            capoCell.className = "capoColumn";
          }
        }

        const item = this.currentDisplay.playlist?.find((x) => x.songId === songEntry.songId);
        if (item) disableRow(item);

        if (this.mode !== "App" && !isFoundList) {
          row.draggable = true;
          row.ondragstart = (event: DragEvent) => {
            this.draggedRow = row;
            event.dataTransfer?.setData("text", i.toString());
            if (this.trashCan) this.trashCan.classList.remove("hidden");
          };
          row.ondragend = (event: DragEvent) => endDnD(event, undefined);
          row.ondragover = (event: DragEvent) => {
            event.stopPropagation();
            if (this.draggedRow && this.songListTable) {
              event.preventDefault();
              if (this.draggedRow !== row) {
                this.draggedRow.classList.add("droptarget");
                this.songListTable.tBodies[0].insertBefore(this.draggedRow, row);
              }
            }
          };
          row.ondrop = (event: DragEvent) => endDnD(event, this.draggedRow?.rowIndex ?? row.rowIndex);
        }
        if (!firstSong) firstSong = songEntry;
      }
    }
    if (this.iconClearList) makeDisabled(this.iconClearList, this.playlist.length === 0);
    return firstSong;
  }

  private playListInitalUpdate = true;

  private processPlayListData(entries: SongEntry[] | SongFound[]) {
    if (debugLog) this.log(`DBG_processPlayListData`);
    const firstSong = this.updateTableFromEntries(entries);
    if (this.leaderMode && this.playListInitalUpdate) {
      this.playListInitalUpdate = false;
      if (firstSong)
        setTimeout(() => {
          if (!this.currentDisplay.songId) this.requestSong(firstSong);
        }, 1000);
    }
  }

  private findBestMatchIndexInPlaylist(songReq: SongRequest) {
    let idx = -1;
    let matchCount = -1;
    for (let i = 0; i < this.playlist.length; ++i) {
      const item = this.playlist[i];
      if (item.songId === songReq.songId) {
        let mc = 0;
        if ((item.transpose ?? 0) === (songReq.transpose ?? 0)) ++mc;
        if ((item.capo ?? 0) === (songReq.capo ?? 0)) ++mc;
        if (item.instructions || "" === songReq.instructions || "") ++mc;
        if (mc > matchCount) {
          matchCount = mc;
          idx = i;
        }
      }
    }
    return idx;
  }

  private updateSelectedSongInList(songReqParam?: SongRequest) {
    if (debugLog) this.log(`DBG_updateSelectedSongInList`);
    if (!this.songListTable || this.playlist.length === 0) return;
    const songReq = songReqParam ?? this.nextSongReq ?? this.currentDisplay;
    if (!songReq) return;

    if (debugLog) this.log(`DBG_updateSelectedSongInList_In`);
    const idx = this.findBestMatchIndexInPlaylist(songReq);
    const rows = this.songListTable.rows;
    for (let i = 0; i < rows.length; ++i) {
      const row = rows[i];
      if (i === idx) {
        row.classList.add("flexySelected");
        row.scrollIntoView({ block: "nearest" });
      } else row.classList.remove("flexySelected");
    }
  }

  private selectFromAllSongs(playlistEntry: SongRequest) {
    const full = isFullSongRequest(playlistEntry) ? playlistEntry : undefined;
    const s = !full ? this.database?.getSong(playlistEntry.songId) : undefined;
    this.applyDisplay({
      songId: playlistEntry.songId,
      song: full?.songdata?.text ?? s?.Text ?? "",
      system: full?.songdata?.system ?? s?.System ?? "S",
      from: 0,
      to: 0,
      transpose: playlistEntry.transpose ?? 0,
      capo: playlistEntry.capo ?? 0,
      instructions: playlistEntry.instructions,
    });
    this.storeSelectedSong();
  }

  private applyDisplay(display: Display, forced?: boolean) {
    if (debugLog) this.log(`DBG_applyDisplay: list:${display.playlist?.length ?? 0} song:${display.song?.length ?? 0}`);
    let changeDetected = false;

    this.editor?.suppressDraw();
    try {
      if ((forced || this.currentDisplay.playlist_id !== display.playlist_id) && display.playlist) {
        changeDetected = changeDetected || this.currentDisplay.playlist_id !== display.playlist_id;
        this.currentDisplay.playlist_id = display.playlist_id;
        this.processPlayListData((this.playlist = display.playlist));
        this.currentDisplay.playlist = display.playlist;
      }

      if (
        display.song &&
        (forced ||
          this.currentDisplay.songId !== display.songId ||
          this.currentDisplay.song !== display.song ||
          this.currentDisplay.capo !== display.capo)
      ) {
        changeDetected =
          changeDetected ||
          this.currentDisplay.songId !== display.songId ||
          this.currentDisplay.song !== display.song ||
          this.currentDisplay.capo !== display.capo;
        this.currentDisplay.songId = display.songId;
        if (display.song)
          this.loadSong(display.songId, display.song, display.system, { preferredCapo: display.capo, forceUpdate: forced, drawingSuppressed: true });
        this.currentDisplay.transpose = 0;
        this.currentDisplay.capo = display.capo;
        this.updateSelectedSongInList();
      }

      if (changeDetected && this.chkAdmin?.checked) this.verifyNeighbouringSongs();

      if (forced || this.currentDisplay.transpose !== display.transpose) {
        changeDetected = changeDetected || this.currentDisplay.transpose !== display.transpose;
        this.transpose(display.transpose ?? 0, false);
      }

      if (forced || this.currentDisplay.instructions !== display.instructions) {
        changeDetected = changeDetected || this.currentDisplay.instructions !== display.instructions;
        this.applyInstructions(display.instructions, false);
      }

      changeDetected = changeDetected || this.currentDisplay.from != display.from || this.currentDisplay.to != display.to;

      this.currentDisplay.from = display.from;
      this.currentDisplay.to = display.to;
      this.currentDisplay.section = display.section;
      this.currentDisplay.message = display.message;

      this.updateHighlight(false);
      this.updateEditIconsByState();

      if (forced || changeDetected) this.updateEditor();

      if (this.playlist) {
        const index = this.playlist.findIndex((x) => x.songId === this.currentDisplay.songId);
        if (this.btnPrev) makeDisabled(this.btnPrev, index === 0);
        if (this.btnNext) makeDisabled(this.btnNext, index >= this.playlist.length - 1);
      }
    } finally {
      this.editor?.suppressDraw(false);
      if (changeDetected) this.preventDisplayFromSleep();
    }
    return changeDetected;
  }

  private async requestSongs(songIds: string[]) {
    const songs = await cloudApi.fetchSongsById(songIds, !!this.chkUseCapo?.checked);
    const result = new Map<string, SongEntry>();
    for (const song of songs) {
      if (song.songdata) {
        if (typeof song.capo === "number" && song.capo < 0) song.capo = undefined;
        result.set(song.songId, song);
      }
    }
    return result;
  }

  private async verifyNeighbouringSongs(next?: boolean, useCapoChangedOnly?: boolean) {
    const loadAndTranspose = (page: EditorPage, playListItem: PlaylistEntry | null, songdata?: SongData) => {
      if (!songdata) {
        const dbSong = playListItem ? this.database?.getSong(playListItem.songId) : undefined;
        songdata = dbSong ? { text: dbSong.Text, system: dbSong.System } : { text: "", system: "S" };
      }
      const { loaded } = page.load(songdata.text, songdata.system, {
        preferredCapo: this.chkUseCapo?.checked ? playListItem?.capo : undefined,
      });
      if (playListItem?.transpose && page.editor) page.editor.transpose(playListItem.transpose, false);
      if (playListItem?.instructions && page.editor) page.editor.applyInstructions(playListItem.instructions, false);
      if (loaded) {
        this.displayChanged(page, true);
        this.updateEditor(page);
      }
    };
    const applySettings = (entry: SongEntry | null | undefined, playListItem: PlaylistEntry | null | undefined) => {
      if (entry && playListItem) {
        if (playListItem.transpose) entry.transpose = playListItem.transpose;
        if (playListItem.capo) entry.capo = playListItem.capo;
      }
    };
    if (this.mode === "App") {
      if (!next && this.pages.prev) loadAndTranspose(this.pages.prev, this.getNeighbouringPlaylistEntry(false));
      if ((next === undefined || next) && this.pages.next) loadAndTranspose(this.pages.next, this.getNeighbouringPlaylistEntry(true));
      this.hasNeighbours = true;
    } else if (this.chkAdmin?.checked && this.pages.prev?.div && this.pages.next?.div) {
      const prevReq = next ? null : this.getNeighbouringPlaylistEntry(false),
        nextReq = (next ?? true) ? this.getNeighbouringPlaylistEntry(true) : null;
      if (prevReq || nextReq) {
        if (useCapoChangedOnly) {
          if (prevReq) loadAndTranspose(this.pages.prev, prevReq, this.pages.prev.loaded);
          if (nextReq) loadAndTranspose(this.pages.next, nextReq, this.pages.next.loaded);
        } else {
          try {
            const songs = await this.requestSongs([prevReq, nextReq].map((x) => x?.songId).filter((x) => !!x) as string[]);
            const prevSongInfo = prevReq ? songs.get(prevReq.songId) : undefined;
            const nextSongInfo = nextReq ? songs.get(nextReq.songId) : undefined;
            applySettings(prevSongInfo, prevReq);
            applySettings(nextSongInfo, nextReq);
            loadAndTranspose(this.pages.prev, prevSongInfo ?? prevReq, prevSongInfo?.songdata);
            loadAndTranspose(this.pages.next, nextSongInfo ?? nextReq, nextSongInfo?.songdata);
            this.hasNeighbours = true;
          } catch (error) {
            this.log("Error during download of neighboring songs: " + error);
          }
        }
      } else {
        this.pages.prev.load("");
        this.pages.next.load("");
        this.hasNeighbours = true;
      }
    }
  }

  private refreshPlaylists(items: LeaderPlaylist[]) {
    this.playlists.clear();
    if (this.selPlaylists) {
      this.selPlaylists.innerHTML = "";
      for (const item of items.sort((a, b) => b.label.localeCompare(a.label))) {
        const key = item.leaderId + "/" + item.label;
        this.playlists.set(key, item);
        const o = document.createElement("option") as HTMLOptionElement;
        o.value = key;
        o.innerText = item.label.replace(/ 0:00:00/, "") + " (" + item.leaderName + ")";
        this.selPlaylists.appendChild(o);
      }
    }
  }

  private lastDisplayRequest: any = null;

  private async watchDisplay(forced: boolean = false) {
    if (this.mode === "App") {
      if (!this.songListTable) return;
      if (this.iconLoadingList) {
        makeVisible(this.iconLoadingList);
        if ((this.database?.getSongs().length ?? 0) === 0) makeVisible(this.songListTable, false);
      }
      try {
        await this.updateDatabase("LOAD");
        this.allSongModeState = "LOADED";
        if (this.iconLoadingList) makeVisible(this.iconLoadingList, false);
        if (this.songListTable) makeVisible(this.songListTable);
        if (this.editor && this.currentDisplay.songId) this.selectFromAllSongs({ songId: this.currentDisplay.songId });
      } catch (error) {
        if (this.iconLoadingList) makeVisible(this.iconLoadingList, false);
        if (this.songListTable) makeVisible(this.songListTable);
        if (error && ("" + error).trim() !== "0") await this.alert(String(error), "Display Load Error"); // Skip unusable error message of Firefox
        this.allSongModeState = "ERROR";
      }
    } else {
      if (this.lastDisplayRequest) {
        const r = this.lastDisplayRequest;
        this.lastDisplayRequest = null;
        r.abort();
      }
      const reqSent = Date.now();
      const req = (this.lastDisplayRequest = this.sendDisplayRequest(
        (display) => {
          if (this.lastDisplayRequest !== req) return;
          this.lastDisplayRequest = null;
          const elapsed = Date.now() - reqSent;
          const changed = this.applyDisplay(display, forced);
          this.setNetworkState("online");
          if (forced) this.queryHighlightPermission(true);
          if (!forced && !changed && elapsed < 2000) setTimeout(() => this.watchDisplay(), 1000);
          else this.watchDisplay();
        },
        (code) => {
          if (this.lastDisplayRequest !== req) return;
          this.lastDisplayRequest = null;
          if (("" + code).trim() !== "0") {
            this.log("Download error: " + code);
            this.setNetworkState("offline", code);
          }
          if (this.offlineTimeout) window.clearTimeout(this.offlineTimeout);
          this.offlineTimeout = window.setTimeout(() => this.watchDisplay(), 60000);
        },
        forced
      ));
    }
  }

  private goOnline() {
    if (this.mode === "App") return;
    if (this.offlineTimeout) {
      window.clearTimeout(this.offlineTimeout);
      this.offlineTimeout = null;
    }
    cloudApi.abortAll();
    this.watchDisplay(true);
    if (this.currentDisplay.songId) this.updateFieldsForUser();
  }

  private updateFullScreenIcons(f?: boolean) {
    const fstate = f ?? this.hostDevice?.fullScreen ?? !!document.fullscreenElement;
    if (this.btnFullScreen) makeVisible(this.btnFullScreen, !fstate);
    if (this.btnRestore) makeVisible(this.btnRestore, fstate);
  }

  private async toggleFullScreen() {
    if (this.hostDevice) {
      this.updateFullScreenIcons(this.hostDevice.setFullScreen());
      return;
    }
    const is_fullscreen = document.fullscreenElement;
    try {
      if (!is_fullscreen) await document.documentElement.requestFullscreen();
      else if (document.exitFullscreen) await document.exitFullscreen();
    } catch (error) {
      this.log(String(error));
    }
    this.updateFullScreenIcons(!is_fullscreen);
  }

  private async preferenceUpdate(key: string, value: string, songId?: string) {
    if (this.webRoot) {
      const command = songId ? "song_update" : "display_update";
      const id = songId ?? this.currentDisplay.songId ?? "";
      if (!id) return false;
      return cloudApi
        .sendPost(
          `/${command}`,
          {
            id,
            [key]: value,
          },
          { "X-PP-Intent": this._leaderToken ?? "control-update" }
        )
        .then((res) => {
          this.log(res);
        })
        .catch((code) => {
          this.log("Cannot update preference: " + code);
          throw code;
        });
    }
  }

  private async transposeRequest(new_transpose: string, songId?: string) {
    return this.mode !== "App" && (await this.preferenceUpdate("transpose", new_transpose, songId));
  }

  private async capoRequest(new_capo: number, songId?: string) {
    return this.mode !== "App" && (await this.preferenceUpdate("capo", new_capo.toString(), songId));
  }

  private sendPlaylistUpdateRequest(playlistItems: SongPreferenceEntry[], cb?: (error?: string | Error) => void) {
    cloudApi
      .sendPost("/display_update", { playlist: playlistItems }, { "X-PP-Intent": this._leaderToken ?? "control-update" })
      .then((result) => cb?.(result !== "DONE" ? result : undefined))
      .catch((code) => cb?.(code));
  }

  private leaderPlaylistSelected() {
    if (this.mode === "App") return;
    if (this.selPlaylists && this.selPlaylists.selectedIndex >= 0) {
      const id = this.selPlaylists.options[this.selPlaylists.selectedIndex].value;
      const playlist = this.playlists.get(id);
      if (playlist) this.processPlayListData((this.playlist = playlist.songs.map((x) => ({ ...x, found: { type: "", cost: 0 } }))));
    } else this.processPlayListData((this.playlist = []));
  }

  private replaceCurrentPlaylistWithSelected() {
    if (this.mode !== "App" && this.selPlaylists && this.selPlaylists.selectedIndex >= 0) {
      const id = this.selPlaylists.options[this.selPlaylists.selectedIndex].value;
      const playlist = this.playlists.get(id);
      if (playlist) {
        const cont = (error?: string | Error) => {
          if (error) this.log("Cannot update playlist. Error: " + error);
          this.watchDisplay();
          this.songSearchMode(false);
        };
        this.sendPlaylistUpdateRequest(playlist.songs, cont);
      }
    }
  }

  private updateLeaderPlaylist(profiles: LeaderDBProfile[], prevsel: string) {
    if (this.selPlaylists) {
      while (this.selPlaylists.firstChild) this.selPlaylists.removeChild(this.selPlaylists.firstChild);
      let allpl: { id: string; leaderName: string; label: string }[] = [];
      let firstLeaderId: string | undefined | null = undefined;
      for (const profile of profiles) {
        for (const playlist of profile.playlists) {
          this.playlists.set(playlist.label, { leaderId: profile.leaderId, leaderName: profile.leaderName, ...playlist });
          if (firstLeaderId === undefined) firstLeaderId = profile.leaderId;
          else if (firstLeaderId !== null && firstLeaderId !== profile.leaderId) firstLeaderId = null;
          allpl.push({ id: playlist.label, leaderName: profile.leaderName, label: playlist.label });
        }
      }
      allpl = allpl.sort((a, b) => -a.label.localeCompare(b.label));
      for (const ple of allpl) {
        const o = document.createElement("option") as HTMLOptionElement;
        o.value = ple.id;
        o.innerText = firstLeaderId === null ? ple.label + " (" + ple.leaderName + ")" : ple.label;
        this.selPlaylists.appendChild(o);
      }
      this.selPlaylists.value = prevsel;
    }
    this.onSearchTextChanged();
  }

  private async updatePlaylistDroplist() {
    if (this.selPlaylists) {
      const backup = this.selPlaylists.value;
      try {
        this.updateLeaderPlaylist(await cloudApi.fetchLeadersProfiles(), backup);
        return true;
      } catch (e) {
        this.log("leaders query failed: " + e);
      }
    }
    return false;
  }

  private songSearchMode(enabled?: boolean) {
    if (enabled) {
      cloudApi.abortAll();
      if (this.onlineMode && this.selPlaylists && isVisible(this.selPlaylists)) {
        this.leaderPlaylistSelected();
      } else {
        this.edFilter?.focus();
        if (this.selPlaylists && this.edFilter?.id === "searchText") this.updatePlaylistDroplist().catch(() => this.onSearchTextChanged());
        else this.onSearchTextChanged();
      }
    } else {
      if (this.preview?.editorDiv) makeVisible(this.preview.editorDiv, false);
      this.watchDisplay(true);
    }
  }

  private lastSearchText?: string;
  private lastSearchResult: SongEntry[] = [];

  private async querySearchOnline(text: string, limit?: number) {
    const duplicates = new Set<string>();
    const searchResult = (await cloudApi.searchSongs(text, limit)).filter((x) => {
      if (duplicates.has(x.songId)) return false;
      duplicates.add(x.songId);
      return true;
    });
    return searchResult;
  }

  private async onSearchTextChanged(allowSelectAll?: boolean) {
    if (this.mode === "App" || !this.edFilter || !isVisible(this.edFilter)) return;

    const text = this.edFilter?.value || "";
    if (this.chkAdmin?.checked && this.lastSearchText !== text) {
      let limit: number | undefined;
      if (allowSelectAll && text === "" && (await this.confirm("longlist"))) limit = 0;
      if (text || limit !== undefined) {
        try {
          const result = await this.querySearchOnline(text, limit);
          this.lastSearchText = text;
          this.processPlayListData((this.lastSearchResult = result));
        } catch (error) {
          this.log("Song search/add to list error: " + error);
          this.songSearchMode(false);
        }
      } else this.processPlayListData([]);
    } else this.processPlayListData(this.lastSearchResult);
  }

  private firstDisplayRequest = true;
  private sendDisplayRequest(resultCallback: (result: Display) => void, errorCallback: ErrorCallback, forced?: boolean) {
    if (!this.webRoot) return;
    if (this.firstDisplayRequest) {
      this.firstDisplayRequest = false;
      forced = true;
    }
    const display: Display = {
      playlist_id: this.currentDisplay.playlist_id || "",
      songId: this.currentDisplay.songId || "",
      from: this.currentDisplay.from || 0,
      to: this.currentDisplay.to || 0,
      transpose: this.currentDisplay.transpose || 0,
      capo: this.currentDisplay.capo,
      instructions: this.currentDisplay.instructions,
      song: "",
      system: "G", // bw comp
      playlist: [],
      section: this.currentDisplay.section,
      message: this.currentDisplay.message,
    };

    const controller = new AbortController();
    void cloudApi
      .fetchDisplayQuery(display, { signal: controller.signal, forced, leaderId: this.onlineMode ? this.leaderId : undefined })
      .then(({ display, ppHeaders }) => {
        if (this.mode === "Client") {
          const leaderModeAvailable = ppHeaders["leader-available"] === "true";
          if (this.leaderModeAvailable !== leaderModeAvailable) {
            this.leaderModeAvailable = leaderModeAvailable;
            this.leaderMode = this.leaderModeAvailable && ppHeaders["leader-enabled"] === "true";
            this.applyLeaderModeRestrictions();
          }
        }
        if (ppHeaders["token"]) this._leaderToken = ppHeaders["token"];
        resultCallback(display);
      })
      .catch((error) => errorCallback(error instanceof Error ? error : new Error(String(error))));

    return {
      abort: () => controller.abort(),
    };
  }

  private updateEditIconsByState() {
    const editing = (this.editor && !this.editor.readOnly) || !!this.editor?.inMarkingState;
    if (this.divNetStatus) makeVisible(this.divNetStatus, !editing && (this.mode !== "App" || this.ppdWatchers != null));
    if (this.iconCreateMarks) makeVisible(this.iconCreateMarks, !editing && this.editor != null);
    if (this.iconApplyMarks) makeVisible(this.iconApplyMarks, editing && this.editor != null);
    if (this.divCancelEdit) makeVisible(this.divCancelEdit, editing && this.editor != null);
  }

  private onNoteButtonClicked(createButtonClicked: boolean) {
    if (!this.editor || this.mode === "App") return;
    if (createButtonClicked) {
      if (this.editor.inMarkingState) {
        this.editor.marking(false);
        this.sendMarksUpdateRequest();
      } else {
        const id = this.currentDisplay.songId;
        cloudApi.abortAll();
        setTimeout(() => this.enterMarkingMode(id), 20);
      }
      this.updateEditor();
      this.updateEditIconsByState();
    } else {
      this.loadSong(this.currentDisplay.songId, this.currentDisplay.song, this.currentDisplay.system, {
        preferredCapo: this.chkUseCapo?.checked ? this.currentDisplay.capo : undefined,
        editable: false,
        forceUpdate: true,
      });
      this.goOnline();
    }
  }

  private enterMarkingMode(id: string) {
    if (this.editor && this.currentDisplay.songId === id) {
      this.currentDisplay.song = this.editor.chordProCode;
      this.currentDisplay.system = this.editor.system.systemCode;
      this.editor.marking(true);
      this.updateEditor();
      this.updateEditIconsByState();
    }
  }

  private sendMarksUpdateRequest() {
    if (this.webRoot && this.currentDisplay && this.currentDisplay.songId && this.editor) {
      let retryCount = 3;
      const songId = this.currentDisplay.songId;
      const text = this.editor.marks;
      const close = () => {
        this.updateEditIconsByState();
        this.goOnline();
      };
      const attemptSend = () => {
        cloudApi
          .updateNote(songId, text)
          .then(close)
          .catch(() => {
            if (--retryCount > 0) setTimeout(attemptSend, 1000);
            else close();
          });
      };
      attemptSend();
    }
  }

  private async onEditSong(enterEditMode: boolean) {
    if (!this.editor) return;

    const updateButtons = async () => {
      const inEditMode = !this.editor?.readOnly;
      // if (inEditMode) await this.closeOptions(true); //this line causes problems in online session mode
      if (this.btnOptions) makeDisabled(this.btnOptions, inEditMode);
      if (this.selCapo) makeDisabled(this.selCapo, inEditMode);
      if (this.selShift) makeDisabled(this.selShift, inEditMode);
      if (this.btnEditInstructions) makeDisabled(this.btnEditInstructions, inEditMode);
      if (this.btnPrev) makeDisabled(this.btnPrev, inEditMode);
      if (this.btnNext) makeDisabled(this.btnNext, inEditMode);
      if (this.editor) this.editor.onChange = inEditMode ? () => this.onResize() : null;
      if (inEditMode) virtualKeyboard()?.show();
      else virtualKeyboard()?.hide();
      const div = this.editor?.parentDiv;
      if (div) {
        if (inEditMode) div.classList.add("editMode");
        else div.classList.remove("editMode");
      }
      const coll = document.getElementsByClassName("editorContainer");
      for (let i = 0; i < coll.length; ++i) {
        const item = coll.item(i) as HTMLElement | null;
        if (item) {
          if (inEditMode) item.classList.add("editMode");
          else item.classList.remove("editMode");
        }
      }
    };
    try {
      if (enterEditMode) {
        if (this.editor.readOnly) {
          cloudApi.abortAll();
          const resp = await cloudApi.fetchEditSong(this.currentDisplay.songId);
          if (isErrorResponse(resp)) throw resp.error;
          if (resp.version == null) throw "Unknown version from server";
          this.currentDisplay.version = resp.version;
          this.currentDisplay.song = resp.song;
          this.currentDisplay.system = resp.system;
          this.loadSong(this.currentDisplay.songId, this.currentDisplay.song, this.currentDisplay.system, {
            preferredCapo: this.currentDisplay.capo,
            editable: true,
            forceUpdate: true,
          });
          await updateButtons();
          this.editor.setDisplayMode(true, true, true, false, false, 0);
          this.editor.highlight(0, 0);
          this.pages.current.editor?.focus();
          this.updateEditIconsByState();
          return;
        }
        const modified = this.editor.chordProCode;
        if (this.currentDisplay.song !== modified && this.currentDisplay.version != null) {
          if (!(await this.confirm("keep"))) return;
          const resp = await cloudApi.suggestSong(this.currentDisplay.songId, this.currentDisplay.version, modified);
          if (isErrorResponse(resp)) throw resp.error;
          this.currentDisplay.song = resp.songdata?.text ?? modified;
          this.currentDisplay.system = resp.songdata?.system ?? "S";
        }
      } else if (this.currentDisplay.song !== this.editor.chordProCode && !(await this.confirm("drop"))) return;
      this.editor.setReadOnly(true);
      this.updateEditIconsByState();
    } catch (error) {
      await this.alert(String(error), "Song Save Error");
    }
    await updateButtons();
    this.applyDisplay(this.currentDisplay, true);
    this.goOnline();
  }

  private async applyFilterOnLocalSongList() {
    if (this.mode !== "App") return;

    const processEntries = (entries: SongEntry[]) => {
      this.playlist = entries;
      this.updateTableFromEntries(entries);
      return entries;
    };

    if (this.selPlaylists && isVisible(this.selPlaylists)) {
      const entries: SongEntry[] = [];
      const id = this.selPlaylists.options[this.selPlaylists.selectedIndex]?.value;
      for (const item of this.playlists.get(id)?.songs ?? []) {
        const dbSong = this.database?.getSong(item.songId);
        if (dbSong) entries.push({ ...item, songdata: { text: dbSong.Text, system: dbSong.System } });
      }
      return processEntries(entries);
    }

    if (this.edFilter?.value && this.isOnline) {
      try {
        const db = this.database;
        return processEntries((await this.querySearchOnline(this.edFilter.value)).filter((item) => !!db?.getSong(item.songId)));
      } catch {
        this.isOnline = false;
      }
    }

    // Use Database.filter() for local search (replaces legacy songWords + inline search)
    if (this.database) {
      const filter = this.edFilter?.value || "";
      const results = await this.database.filter(filter);
      const entries: SongFound[] = results.map((sf) => ({
        songId: sf.song.Id,
        title: sf.song.Title,
        songdata: { text: sf.song.Text, system: sf.song.System },
        found: { type: FormatFoundReason(sf.reason), cost: sf.cost, snippet: sf.snippet },
      }));
      return processEntries(entries);
    }

    // Final fallback: return empty list (database not yet initialized)
    return processEntries([]);
  }
  /*
  private parseSongsReponse(resp: string): SongEntry[] {
    try {
      return JSON.parse(resp).filter((x) => x.title);
    } catch (error) {
      this.log("JSON resp error, fallback to bwcomp: " + error);
    }
    const songs: SongEntry[] = [];
    const rx = /# id:(.*)\n/g;
    const addBwCompEntry = (song: string) => {
      const m = /{title:(.*)}/g.exec(song);
      if (m) songs.push({ songId: prevId, title: m[1], songdata: { text: song, system: "G" } });
    };
    let prevId = "",
      match: RegExpMatchArray | null,
      l = 0,
      song = "";
    while ((match = rx.exec(resp))) {
      song = resp.substr(l, rx.lastIndex - match[0].length - l);
      l = rx.lastIndex;
      addBwCompEntry(song);
      prevId = match[1];
    }
    song = resp.substr(l);
    addBwCompEntry(song);
    return songs;
  }
  */

  private getDisplaySettings(includeCapoAndTranspose: boolean): DisplaySettings {
    const s = {
      chordBoxType: this.chordBoxType,
      chordMode: this.selChordMode?.value,
      noSecChordDup: this.chkNoSecChordDup?.checked,
      subscript: this.chkSubscript?.checked,
      useCapo: this.chkUseCapo?.checked,
      simplify: this.chkSimplified?.checked,
      bbMode: this.chkBBMode?.checked,
      maxText: this.chkMaxText?.checked,
      darkMode: this.darkModeEnabled,
      autoTone: this.chkAutoTone?.checked,
      highlight: this.chkHighlight?.checked,
      leaderMode: this.chkAdmin?.checked,
      fontSize: document.documentElement.style.fontSize,
      useInstructions: this.chkUseInstructions?.checked,
    };
    return includeCapoAndTranspose ? { ...s, capo: this.selCapo?.selectedIndex, transpose: this.currentDisplay.transpose } : s;
  }

  private setDisplaySettings(settings: DisplaySettings) {
    this.switchDarkMode(settings.darkMode);
    let changed = false;
    if (settings.chordBoxType !== undefined && this.chordBoxType !== settings.chordBoxType) {
      this.chordBoxType = settings.chordBoxType;
      this.updateChordBoxTypeImage();
      changed = true;
    }
    if (settings.chordMode !== undefined && this.selChordMode && this.selChordMode.value !== settings.chordMode) {
      this.selChordMode.value = settings.chordMode;
      changed = true;
    }
    if (settings.noSecChordDup !== undefined && this.chkNoSecChordDup && this.chkNoSecChordDup.checked !== settings.noSecChordDup) {
      this.chkNoSecChordDup.checked = settings.noSecChordDup;
      changed = true;
    }
    if (settings.subscript !== undefined && this.chkSubscript && this.chkSubscript.checked !== settings.subscript) {
      this.chkSubscript.checked = settings.subscript;
      changed = true;
    }
    if (settings.useCapo !== undefined && this.chkUseCapo && this.chkUseCapo.checked !== settings.useCapo) {
      this.chkUseCapo.checked = settings.useCapo;
      changed = true;
    }
    if (settings.simplify !== undefined && this.chkSimplified && this.chkSimplified.checked !== settings.simplify) {
      this.chkSimplified.checked = settings.simplify;
      changed = true;
    }
    if (settings.bbMode !== undefined && this.chkBBMode && this.chkBBMode.checked !== settings.bbMode) {
      this.chkBBMode.checked = settings.bbMode;
      changed = true;
    }
    if (settings.autoTone !== undefined && this.chkAutoTone && this.chkAutoTone.checked !== settings.autoTone) {
      this.chkAutoTone.checked = settings.autoTone;
      changed = true;
    }
    if (settings.maxText !== undefined && this.chkMaxText && this.chkMaxText.checked !== settings.maxText) {
      this.chkMaxText.checked = settings.maxText;
      changed = true;
    }
    if (settings.highlight !== undefined && this.chkHighlight && this.chkHighlight.checked !== settings.highlight) {
      this.chkHighlight.checked = settings.highlight;
      changed = true;
    }
    if (settings.useInstructions !== undefined && this.chkUseInstructions && this.chkUseInstructions.checked !== settings.useInstructions) {
      this.chkUseInstructions.checked = settings.useInstructions;
      changed = true;
    }

    if (changed) this.displayChanged();

    if (
      !this.onlineMode &&
      this.mode !== "App" &&
      settings.leaderMode !== undefined &&
      this.chkAdmin &&
      isVisible(this.chkAdmin) &&
      this.chkAdmin.checked !== settings.leaderMode
    ) {
      this.chkAdmin.checked = settings.leaderMode;
      this.setLeader(this.chkAdmin.checked);
    }

    if (settings.capo !== undefined && this.selCapo && settings.capo !== this.selCapo.selectedIndex) {
      this.selCapo.selectedIndex = settings.capo + 1;
      this.capoChanged();
    }
    if (settings.transpose !== undefined && settings.transpose !== this.currentDisplay.transpose) {
      this.transpose(settings.transpose);
    }
    if (settings.fontSize != undefined && document.documentElement.style.fontSize !== settings.fontSize) {
      document.documentElement.style.fontSize = settings.fontSize;
      this.onResize();
    }
  }

  private async clearAppData() {
    if (await this.confirm("clear-app")) {
      try {
        await this.clearStorage();
      } catch (error) {
        this.log("Error clearing storage: " + error);
      }
    }
  }

  private switchToOnlineSession(create: boolean, leaderId?: string) {
    if (this.mode !== "App") return;
    const form = document.createElement("form");
    form.method = "POST";
    if (create) {
      const input = document.createElement("input");
      input.type = "text";
      input.name = "pp_mode";
      input.value = "start";
      form.append(input);
    }
    if (leaderId) {
      const input = document.createElement("input");
      input.type = "text";
      input.name = "pp_leader_id";
      input.value = leaderId;
      form.append(input);
    }
    if (cloudApi.isAuthed()) {
      const input = document.createElement("input");
      input.type = "text";
      input.name = "pp_auth";
      input.value = cloudApi.getAuthorizationHeader();
      form.append(input);
    }
    document.body.append(form);
    form.submit();
  }

  private makeMoreContentVisible(visible: boolean) {
    if (!this.moreContent) return;

    for (const d of Array.from(this.moreContent.children)) {
      if (d.tagName.toLowerCase() === "div" && d.id !== "about" && d.id !== "power") {
        makeVisible(d as HTMLDivElement, visible);
      }
    }
  }

  private ppdWatchMode(enabled: boolean) {
    if (this.btnHome) makeVisible(this.btnHome, enabled);
    if (this.btnPrev) makeVisible(this.btnPrev, !enabled);
    if (this.btnNext) makeVisible(this.btnNext, !enabled);
    if (this.filterRow) makeVisible(this.filterRow, !enabled);
    if (this.songListTable) makeVisible(this.songListTable, !enabled);

    this.makeMoreContentVisible(!enabled);
  }

  private watchPpdSession(url: string) {
    const m = /^(nrb|udp):\/\/([^:/]+)(?::([0-9]+))?\/(.*)$/.exec(url);
    if (!m) {
      this.log("Invalid ppd url: " + url);
      return false;
    }
    this.ppdWatch = {
      host: m[2],
      port: m[1] === "udp" ? parseInt(m[3], 10) : undefined,
      device: m[4],
      lastRequestSent: 0,
      lastResponseArrived: 0,
    };
    this.ppdWatchMode(true);
    return true;
  }

  private disconnectUdpSession() {
    if (this.hostDevice) this.hostDevice.goHome();
    else if (this.ppdWatch) {
      this.ppdWatchMode(false);
      this.ppdWatch = undefined;
    }
  }

  private get hostDevice(): HostDevice | null {
    return HostDevice.hostDevice;
  }

  private readonly possibleUdpPorts = (() => {
    const ports: number[] = [];
    for (let i = 1974; i < 1984; ++i) ports.push(i);
    return ports;
  })();

  private ppdMessageProcessorIsRunning = false;
  private sendPpdMessage(object: PpdMessageInternal, target: string, port?: number | number[]) {
    if (this.hostDevice) {
      try {
        const inputString = JSON.stringify({
          ...object,
          port: this.udpEnabled ? this.getUdpListenPort() : undefined,
          device: this.ppdDeviceId,
          name: this.hostDevice.getName() ?? this.hostDevice.getModel(),
        });
        const encoder = new TextEncoder();
        const utf8Encoded = encoder.encode(inputString);
        const base64Encoded = btoa(String.fromCharCode.apply(null, Array.from(utf8Encoded)));
        const address =
          port != null
            ? this.hostDevice.sendUdpMessage(base64Encoded, target, port)
            : Nearby.instance?.sendMessage(target, base64Encoded)
              ? target
              : "";
        if (debugLog) this.log(`DBG_sendPpdMessage(${address}):${inputString}`);
        if (address && address != "-") {
          if (target === "*") {
            if (this.scanDlgBroadcast) this.scanDlgBroadcast.innerText = address;
            if (this.scanDlg) makeVisible(this.scanDlg, true);
          }
          return true;
        }
      } catch (error) {
        this.log("UDP message send error: " + error);
      }
    }
    return false;
  }

  private sendUdpScanRequest() {
    return this.sendPpdMessage({ op: "scan", id: this.ppdScanId }, "*", this.possibleUdpPorts);
  }

  private genUniqueId() {
    return Math.random().toString(36).slice(2);
  }

  private getUdpListenPort() {
    const port = this.hostDevice?.listenOnUdpPort(this.possibleUdpPorts) ?? 0;
    if (port) this.verifyPpdMessageHandler();
    return port;
  }

  private verifyPpdMessageHandler() {
    if (!this.ppdMessageProcessorIsRunning) {
      const handle = () => {
        try {
          this.handlePpdRequests();
        } catch (error) {
          this.log("Error during ppd request handling: " + error);
        }
        if (this.ppdMessageProcessorIsRunning) setTimeout(handle, 100);
      };
      this.ppdMessageProcessorIsRunning = true;
      handle();
    }
  }

  private async verifyNearby() {
    const nearby = Nearby.instance;
    if (nearby && (await nearby.checkPermissions(true))) {
      nearby.register(
        "ppApp",
        (event, from) => {
          if (debugLog) this.log(`DBG_NearbyEvent:${event}@${from}`);
          switch (event) {
            case "discovered":
              if (this.ppdScanId) nearby.connect(from);
              break;
            case "disappeared":
              break;
            case "connected":
              if (this.ppdScanId) this.sendPpdMessage({ op: "scan", id: this.ppdScanId }, from);
              break;
            case "disconnected":
              break;
          }
        },
        (message, from) => this.enqueueIncomingPpdMessage({ message, from })
      );
      if (debugLog) this.log(`DBG_NearbyRegistered`);
      return true;
    } else if (debugLog) this.log(`DBG_NearbyInterfaceNotFoundOrAllowedToUse`);
    return false;
  }

  private async scanForLocalServers(): Promise<OnlineSessionEntry[] | undefined> {
    if (this.hostDevice && (this.udpEnabled || this.nearbyEnabled)) {
      try {
        this.ppdPackets.clear();
        const udpListenPort = this.getUdpListenPort();
        if (!udpListenPort) this.udpEnabled = false;
        if (!(await this.verifyNearby())) this.nearbyEnabled = false;
        if (debugLog) this.log(`DBG_LocalScan:udpEnabled:${this.udpEnabled},nearByEnabled:${this.nearbyEnabled}`);
        if (!this.udpEnabled && !this.nearbyEnabled) {
          if (this.iconWiFiOn) makeVisible(this.iconWiFiOn, false);
          if (this.iconWiFiOff) makeVisible(this.iconWiFiOff, udpListenPort !== 0 || Nearby.instance != null);
          this.hostDevice.showToast("NearBy error:\n" + this.hostDevice.getErrors());
          return undefined;
        }
        try {
          this.ppdServices = new Map();
          this.ppdScanId = this.genUniqueId();
          if (this.nearbyEnabled) Nearby.instance?.discover(true);
          let nextSend = 0;
          let now: number;
          let end = Date.now() + 10000;
          for (let send = 20; (now = Date.now()) < end; ) {
            if (this.udpEnabled) {
              if (send > 0 && nextSend < now) {
                if (!this.sendUdpScanRequest()) throw new Error("Host device not sending udp requests");
                nextSend = now + (--send >= 10 ? 100 : 1000);
              }
            }
            const cnt = this.ppdServices.size;
            await snooze(100);
            if (this.ppdServices.size > cnt) {
              end = Math.min(end, now + 1000);
              send = 0;
            }
          }

          const udpDevices = new Set<string>();
          let ppdIdx = 0;
          const lastUpdate = new Date().toISOString();
          const result = Array.from(this.ppdServices.values()).map((x) => {
            if (x.deviceId && x.url.startsWith("udp:")) udpDevices.add(x.deviceId);
            return {
              id: "ppd:" + ppdIdx++,
              lastUpdate,
              name: x.name,
              deviceId: x.deviceId,
              localUrl: x.url,
            };
          });
          return result.filter((x) => !x.localUrl.startsWith("nrb:") || (x.deviceId && !udpDevices.has(x.deviceId)));
        } catch (error) {
          this.log("Error while scanning local network: " + error);
        }
        this.ppdServices = undefined;
      } finally {
        this.ppdScanId = "";
        if (this.nearbyEnabled) Nearby.instance?.discover(false);
        if (this.scanDlg) makeVisible(this.scanDlg, false);
      }
    }
    return [];
  }

  private async searchExternalSessions(mode: "NEARBY" | "WEB" | "BOTH" = "BOTH") {
    const sessionList = document.getElementById("sessionList") as HTMLUListElement;
    if (sessionList) {
      sessionList.innerHTML = "";
      try {
        const localPromise = mode === "WEB" ? undefined : this.scanForLocalServers();
        let webResult: OnlineSessionEntry[] = [];
        if (mode !== "NEARBY") {
          const webPromise = cloudApi.fetchOnlineSessions();
          await Promise.all([localPromise, webPromise]);
          webResult = await webPromise;
          if (this.leaderId && cloudApi.isAuthed()) webResult = webResult.filter((x) => x.id !== this.leaderId);
        }
        const local = localPromise != null ? await localPromise : null;
        const availableSessions = (local ?? []).concat(webResult.filter((x) => local == null || !x.localUrl));
        if (availableSessions.length > 0) {
          let lanCount = 0;
          let ppdCount = 0;
          availableSessions.sort((a, b) => {
            if (a.localUrl) {
              if (!b.localUrl) return -1;
            } else if (b.localUrl) return 1;
            return (a.lastUpdate ?? "").localeCompare(b.lastUpdate ?? "");
          });
          for (const webEntry of availableSessions) {
            const li = document.createElement("li") as HTMLLIElement;
            const url = webEntry.localUrl;
            const sessionType = !url ? "wanSession" : url.startsWith("nrb://") || url.startsWith("udp://") ? "ppdSession" : "lanSession";
            if (sessionType === "lanSession") ++lanCount;
            else if (sessionType === "ppdSession") ++ppdCount;
            li.classList.add(sessionType);
            li.appendChild(document.createTextNode(webEntry.name));
            if (url && sessionType !== "ppdSession") {
              const link = document.createElement("a");
              link.href = "#";
              const label = url.replace(/^(?:https?|nrb|udp):\/\/([^:/]+)(?::[0-9]+)?\/.*$/, (full, host) => host);
              link.appendChild(document.createTextNode(label));
              li.appendChild(link);
              const imgConn = createDivElement({
                classList: ["gradient-circle-loader", "hidden"],
                parent: li,
              });
              li.onclick = (e) => {
                this.hostDevice?.startNavigationTimeout(Settings.current.hostConnectTimeoutSeconds * 1000, `Failed to connect to ${label}: ${url}`);
                makeVisible(imgConn);
                window.open(url, "_blank");
                e.stopPropagation();
              };
            } else li.onclick = () => endModal(sessionList, sessionType === "ppdSession" ? url : webEntry.id);
            sessionList.appendChild(li);
          }
          const btnWebSession = document.getElementById("btnWebSession");
          const btnUdpSession = document.getElementById("btnUdpSession");
          const showSessionSelector = async (btn?: HTMLElement) => {
            if (this.btnShare) makeVisible(this.btnShare, true);
            if (btn) makeVisible(btn, false);
            const linkOrLeaderId = await doModal(sessionList, "");
            if (linkOrLeaderId && !this.watchPpdSession(linkOrLeaderId)) this.switchToOnlineSession(false, linkOrLeaderId);
          };
          const showSessionButton = (btn: HTMLElement) => {
            if (this.btnShare) makeVisible(this.btnShare, false);
            for (const btnSession of [btnWebSession, btnUdpSession]) if (btnSession) makeVisible(btnSession, btnSession === btn);
            btn.onclick = () => showSessionSelector(btn);
            setTimeout(() => {
              if (this.btnShare) makeVisible(this.btnShare, true);
              makeVisible(btn, false);
            }, 15000);
          };
          if (lanCount > 0) showSessionSelector();
          else if (btnUdpSession && ppdCount > 0) showSessionButton(btnUdpSession);
          else if (btnWebSession) showSessionButton(btnWebSession);
        }
      } catch (error) {
        this.log("Hosts check failed: " + error);
      }
    }
  }

  private storeSelectedSong() {
    const ls = localStorage || window.localStorage;
    if (ls) {
      const groupId = ls.getItem("groupId") ?? "";
      const { songId, listId } = this.getActualSongListPair();
      ls.setItem("songId_" + groupId, songId);
      ls.setItem("listId_" + groupId, listId);
    }
    this.storeDisplaySettings();
  }

  private restoreDisplaySettings(applyCapoAndTranspose: boolean) {
    const value =
      this.hostDevice?.retrievePreference("displaySettings") ??
      (localStorage || window.localStorage)?.getItem("displaySettings") ??
      (localStorage || window.localStorage)?.getItem("settings");
    if (value) {
      const settings: DisplaySettings = JSON.parse(value);
      if (!applyCapoAndTranspose) {
        settings.capo = undefined;
        settings.transpose = undefined;
      }
      this.setDisplaySettings(settings);
    }
  }

  private storeDisplaySettings() {
    if (this.mode !== "App" || this.allSongModeState === "READY") {
      const serialized = JSON.stringify(this.getDisplaySettings(this.mode === "App"));
      if (this.hostDevice) {
        this.hostDevice.storePreference("displaySettings", serialized);
        return;
      }
      const ls = localStorage || window.localStorage;
      if (ls) ls.setItem("displaySettings", serialized);
    }
  }

  private restoreAppSettings() {
    const value = this.hostDevice?.retrievePreference("appSettings") ?? (localStorage || window.localStorage)?.getItem("appSettings");
    if (value) Settings.parse(value);
  }

  private storeAppSettings() {
    const serialized = Settings.format();
    if (this.hostDevice) {
      this.hostDevice.storePreference("appSettings", serialized);
      return;
    }
    const ls = localStorage || window.localStorage;
    if (ls) ls.setItem("appSettings", serialized);
  }

  private async fetchAllPlaylistFromServer(version?: number) {
    const profiles = await cloudApi.fetchLeadersProfiles(version);
    const playlists: LeaderPlaylistWithVersion[] = [];
    for (const profile of profiles) {
      for (const playlist of profile.playlists) {
        playlists.push({ version: profile.version, leaderId: profile.leaderId, leaderName: profile.leaderName, ...playlist });
      }
    }
    return playlists;
  }

  private async sharePublicLink() {
    const { url, title } = this.genActualSongUrl(window.location.protocol + "//" + window.location.host + "/public.html");
    if (this.hostDevice) {
      try {
        if (this.hostDevice.share(url, title)) {
          //await clipboard.writeText(url); // just to be sure
          return;
        }
      } catch (error) {
        this.log("Unable to share link through android api: " + error);
      }
    }
    try {
      await navigator.share({ url, title });
      return;
    } catch (error) {
      this.log("Unable to share link: " + error);
    }
    try {
      await navigator.clipboard.writeText(url);
      const message = UnicodeSymbol.clipboard + UnicodeSymbol.thumb;
      if (this.hostDevice) this.hostDevice.showToast(message);
      else this.alert(message);
    } catch (error) {
      this.log(String(error));
    }
  }

  private async uploadList(scheduled?: Date, forced = false) {
    if (!this.currentDisplay.playlist) return true;
    try {
      const listLabel = formatLocalDateLabel(scheduled ?? new Date());
      const res = await cloudApi.storeList(forced, {
        label: listLabel,
        scheduled: scheduled?.getTime() ?? 0,
        songs: this.currentDisplay.playlist,
      });
      if (res === "OVERWRITE") {
        if (await this.confirm("overwrite")) {
          this.uploadList(scheduled, true);
          return true;
        }
        return false;
      }
      if (res === "OK") {
        this.refreshPlaylists(await this.fetchAllPlaylistFromServer());
        return true;
      }
      await this.alert(res?.toString() ?? "Empty Response", "Error uploading list");
    } catch (error) {
      await this.alert(String(error), "Error uploading list");
    }
    return false;
  }

  log(s: string) {
    this.hostDevice?.debugLog(HostDevice.debugLogTag, s);
    console.log(s);
    if (this.logDiv) {
      this.logDiv.innerText += Date.now() + ": " + s + "\n";
      this.logDiv.scrollTop = this.logDiv.scrollHeight;
    }
  }

  private async confirm(
    anim: string,
    options?: {
      animOnly?: boolean | number;
      parent?: HTMLElement;
      style?: { [key: string]: string };
    }
  ) {
    return new Promise<boolean>((resolve) => {
      const confirmDialog = document.getElementById("confirm-dialog");
      const content = document.getElementById("confirm-dialog-content");
      const ok = document.getElementById("confirm-dialog-ok");
      const cancel = document.getElementById("confirm-dialog-close");
      if (confirmDialog && content && (options?.animOnly || (ok && cancel))) {
        const applyStyle = (style: { [key: string]: string }) => {
          const prevStyle: { [key: string]: string } = {};
          const dlgStyle = confirmDialog.style as unknown as Record<string, string>;
          for (const property of Object.getOwnPropertyNames(style)) {
            prevStyle[property] = dlgStyle[property];
            dlgStyle[property] = style[property];
          }
          return prevStyle;
        };
        if (options?.parent) {
          options.style = options?.style ?? {};
          options.style.minWidth =
            options.style.maxWidth =
            options.style.width =
              0.6 * Math.min(options.parent.offsetWidth, options.parent.offsetHeight) + "px";
          options.style.top = options.parent.offsetTop + "px";
        }
        const styleBackup = options?.style ? applyStyle(options?.style) : undefined;
        content.innerHTML = `<object type="image/svg+xml" data="images/${anim}.svg"></object>`;
        if (options?.animOnly) {
          content.addEventListener("endEvent", () => endModal(confirmDialog));
          if (typeof options?.animOnly === "number") {
            setTimeout(async () => {
              confirmDialog.classList.add("fade-out");
              await snooze(200);
              endModal(confirmDialog);
              confirmDialog.classList.remove("fade-out");
              resolve(true);
            }, options?.animOnly);
          }
        }
        if (ok) {
          makeVisible(ok, !options?.animOnly);
          ok.onclick = () => {
            if (styleBackup) applyStyle(styleBackup);
            endModal(confirmDialog);
            resolve(true);
          };
        }
        if (cancel) {
          makeVisible(cancel, !options?.animOnly);
          cancel.onclick = () => {
            if (styleBackup) applyStyle(styleBackup);
            endModal(confirmDialog);
            resolve(false);
          };
        }
        doModal(confirmDialog);
      } else resolve(false);
    });
  }

  private async inputText(frameElement: HTMLElement, initialValue: string) {
    return new Promise<string>((resolve) => {
      const textInputDialog = document.getElementById("text-input-dialog");
      const input = document.getElementById("text-input-dialog-content") as HTMLInputElement;
      const ok = document.getElementById("text-input-dialog-ok");
      const cancel = document.getElementById("text-input-dialog-close");
      if (textInputDialog && input) {
        const rect = frameElement.getBoundingClientRect();
        textInputDialog.style.left = rect.left + "px";
        textInputDialog.style.top = rect.top + "px";
        textInputDialog.style.width = rect.width + "px";
        textInputDialog.style.height = rect.height + "px";
        input.value = initialValue;
        const onOK = () => {
          endModal(textInputDialog);
          resolve(input.value);
        };
        const onCancel = () => {
          endModal(textInputDialog);
          resolve(initialValue);
        };
        input.onkeydown = (e) => {
          switch (e.key) {
            case "Enter":
              onOK();
              break;
            case "Escape":
              onCancel();
              break;
          }
        };
        if (ok) ok.onclick = onOK;
        if (cancel) cancel.onclick = onCancel;
        doModal(textInputDialog, input.value);
        input.setSelectionRange(0, input.value.length);
        input.focus();
      } else resolve(initialValue);
    });
  }

  private getActualSongListPair() {
    let listId = "",
      listName = "";
    if (this.selPlaylists && isVisible(this.selPlaylists) && (this.selPlaylists.selectedIndex ?? -1) >= 0) {
      const listEntry = this.selPlaylists.options[this.selPlaylists.selectedIndex];
      listId = listEntry.value ?? "";
      listName = listEntry.label ?? "";
    }
    return { songId: this.currentDisplay.songId, listId, listName };
  }

  private genActualSongUrl(prefix?: string) {
    let head = prefix ?? document.URL;
    head += head.includes("?") ? "&" : "?";
    let list = "";
    const { songId, listId, listName } = this.getActualSongListPair();
    if (listId) {
      list = "&l=" + encodeURIComponent(listId);
      const rows = this.songListTable?.rows;
      let idx = -1;
      if (rows) for (let i = 0; idx < 0 && i < rows.length; ++i) if (rows[i].classList.contains("flexySelected")) idx = i;
      if (idx < 0) idx = this.findBestMatchIndexInPlaylist(this.currentDisplay);
      if (idx >= 0) list += "@" + idx;
    }
    return { url: head + "s=" + songId + list, title: listName };
  }

  public onLoad() {
    try {
      this._onLoad();
    } catch (error) {
      void this.alert(String(error), "PraiseProjector Initialization Error");
    }
  }

  async alert(message: string, title = "") {
    if (this.hostDevice) await this.hostDevice.alert(message, title);
    else alert((title ? title + "\n" : "") + message);
  }

  private keepScreenOnUntil = 0;
  private checkDeviceKeepScreenOn() {
    if (Date.now() > this.keepScreenOnUntil) this.hostDevice?.keepScreenOn(false);
  }

  private preventDisplayFromSleep(enabled = true) {
    try {
      const timeout = Settings.current.keepScreenAwakeMinutes * 60 * 1000;
      preventDisplayFromSleep(enabled, timeout);
      this.hostDevice?.keepScreenOn(enabled);
      if (enabled && timeout) {
        this.keepScreenOnUntil = Date.now() + timeout;
        setTimeout(() => this.checkDeviceKeepScreenOn(), timeout);
      }
    } catch (error) {
      this.log("Error preventing display from sleep: " + error);
    }
  }

  async clearStorage(clearAbove = 0) {
    const ls = localStorage || window.localStorage;
    try {
      if (ls && !clearAbove) ls.clear();
    } catch (error) {
      this.log("Error clearing local storage: " + error);
    }
    if (!this.hostDevice) return;
    const size = clearAbove > 0 ? await this.hostDevice.getCacheSize() : Number.MAX_VALUE;
    if (size != null && size > clearAbove) {
      try {
        this.hostDevice.clearCache(true);
      } catch (error) {
        this.log("Error clearing browser cache: " + error);
      }
      this.storeDisplaySettings();
      this.storeSelectedSong();
      this.storeSessionInfo(this.token ?? "");
      this.goHome();
    }
  }

  private applyLeaderModeRestrictions() {
    const grp = this.grpAdmin || this.chkAdmin;
    if (grp) makeVisible(grp, this.onlineMode ? this.leaderModeAvailable && !this.leaderMode : this.leaderModeAvailable || this.leaderMode);
    this.setLeader(!!this.chkAdmin && (this.chkAdmin.checked = this.leaderMode));
  }

  private _onLoad() {
    this.initFields();

    document.onvisibilitychange = () => this.preventDisplayFromSleep(document.visibilityState === "visible");
    this.preventDisplayFromSleep();

    this.applyLeaderModeRestrictions();

    this.initShiftAndCapo();
    this.resetCapo();
    this.resetShift();

    const onResize = () => this.onResize();
    const updateFullScreenIcons = () => this.updateFullScreenIcons();
    const orientationChange = () => this.orientationChanged();

    if (window.addEventListener) {
      window.addEventListener("fullscreenchange", updateFullScreenIcons);
      window.addEventListener("resize", onResize);
      window.addEventListener("orientationchange", orientationChange);
    } else window.onresize = this.onResize;
    this.onResize();
    this.updateFullScreenIcons(false);

    if (screen && screen.orientation) {
      if (screen.orientation.addEventListener) screen.orientation.addEventListener("change", orientationChange);
      else screen.orientation.onchange = orientationChange;
    }

    if (document.addEventListener) {
      document.addEventListener("fullscreenchange", updateFullScreenIcons);
      document.addEventListener("resize", onResize);
      document.addEventListener("keydown", (e) => this.onKeyDown(e));
    } else document.onkeydown = (e) => this.onKeyDown(e);

    this.restoreAppSettings();
    if (this.mode !== "App") this.restoreDisplaySettings(false);
    const startup = () => {
      this.updateFieldsForUser(false);
      this.watchDisplay();
    };
    this.restoreSessionInfo().then(startup).catch(startup);
    this.onResize();

    if (this.hostDevice) {
      this.hostDevice.pageLoadedSuccessfully();
      if (this.mode === "Client") {
        const name = this.hostDevice.getName() ?? this.hostDevice.getModel();
        if (name) cloudApi.setFixedHeader("X-PP-Device-Name", name);
      } else if (this.mode === "App") setTimeout(() => this.hostDeviceCheck(), 2000);
      this.loadingCircleMaxLevel = 3;
    }
  }

  private async hostDeviceCheck() {
    if (!this.hostDevice) return;
    try {
      const curr = this.hostDevice.retrievePreference("initPageVersion");
      const info = await cloudApi.fetchDeviceData("initPage");
      if (info.error) throw info.error;
      if (curr !== info.version) {
        const resp = await fetch(info.url);
        const buff = await resp.arrayBuffer();
        this.hostDevice.storePreference("initPageArchive", arrayBufferToBase64(buff));
        this.hostDevice.storePreference("initPageVersion", info.version);
      }
    } catch (error) {
      this.log("Device update error: " + error);
    }
  }

  public async requestImage(forcedImageId?: string) {
    const response = await cloudApi.fetchImage(forcedImageId ?? this.lastImageId);
    this.lastImageId = response.id;
    return response;
  }

  public genChordSheets(
    parent: HTMLElement,
    type: ChordBoxType,
    baseNote?: string,
    modifiers?: string[],
    options?: {
      baseNoteSuffix?: string;
      modifierSuffix?: string;
    }
  ) {
    if (!this.pages.current.editorDiv) this.onLoad();
    if (!this.editor) this.loadSong("", "", "S");
    if (this.editor) {
      this.editor.setDisplayMode(false, false, true, true, false, CHORDFORMAT_SUBSCRIPT);
      this.editor.displayProps.chordFont = "28px arial";
      const addLabel = (t: string, l: string) => {
        const label = document.createElement(t);
        label.className = "chordSheet" + t.toUpperCase();
        label.innerHTML = l;
        parent.appendChild(label);
      };
      for (const bn of this.editor.system.baseNoteList)
        if (!baseNote || bn === baseNote?.toUpperCase()) {
          addLabel("h1", bn + (options?.baseNoteSuffix || ""));
          for (const m of modifiers || allChordInfo.map((x) => x.symbols[0])) {
            const chord = this.editor.system.identifyChord(bn + m);
            if (chord) {
              if (type === "GUITAR") addLabel("h2", `${bn}<sup>${m}</sup>${options?.modifierSuffix || ""}`);
              for (let variantIndex = 0; variantIndex < 100; ++variantIndex) {
                const canvas = document.createElement("canvas");
                canvas.className = "chordSheet" + type;
                parent.appendChild(canvas);
                if (!this.editor.chordBoxDrawHelper(type, chord, canvas, variantIndex)) {
                  parent.removeChild(canvas);
                  break;
                }
                if (type !== "GUITAR") break;
              }
            }
          }
        }
    }
  }

  private storeSessionInfo(token: string) {
    if (this.hostDevice) {
      this.hostDevice.storePreference("sessionId", token || "");
      if (!token) this.login = this.token = undefined;
      return;
    }

    const ss = window.sessionStorage;
    const ls = localStorage || window.localStorage;
    if (token) {
      ss?.setItem("sessionId", token);
      // Remove long-lived JS-readable token storage.
      ls?.removeItem("sessionId");
    } else {
      ss?.removeItem("sessionId");
      ls?.removeItem("sessionId");
    }
    if (!token) this.login = this.token = undefined;
  }

  private async restoreSessionInfo() {
    const clientId = this.clientId ?? "";
    let token = this.hostDevice?.retrievePreference("sessionId")?.trim() || "";
    if (!token) {
      const ss = window.sessionStorage;
      const ls = localStorage || window.localStorage;
      token = ss?.getItem("sessionId") || ls?.getItem("sessionId") || "";
    }

    if (token) {
      // Normalize storage location to the currently active host/storage backend.
      this.storeSessionInfo(token);
      cloudApi.setToken("Bearer " + token);
    } else {
      cloudApi.setToken(null);
    }
    try {
      const res = await cloudApi.fetchSession(clientId, { skipRefresh: true });
      if (!res) throw "Invalid response";
      if (isErrorResponse(res)) throw res.error;
      this.login = res.login;
      this.token = res.token;
      if (res.token) {
        cloudApi.setToken("Bearer " + res.token);
      }
      this.verifyNotifications(res.token, false);
    } catch (error) {
      if (!cloudApi.isAuthed()) this.storeSessionInfo("");
      this.log("Token error: " + error);
      this.login = this.token = undefined;
      cloudApi.setToken(null);
    }
  }

  private async logout() {
    if (this.token) {
      const clientId = this.clientId ?? "";
      try {
        cloudApi.setToken("Bearer " + this.token);
        const res = await cloudApi.logoutSession(clientId);
        if (!res) throw "Invalid response";
        if (isErrorResponse(res)) throw res.error;
        this.login = res.login;
        this.token = res.token;
      } catch (error) {
        this.log("Token error: " + error);
        this.login = this.token = undefined;
      } finally {
        this.storeSessionInfo("");
        cloudApi.setToken(null);
        this.updateFieldsForUser();
        this.updateDatabase("UPDATE");
      }
    }
  }

  private async doLogin(loginDialog: HTMLElement) {
    const login = document.getElementById("login") as HTMLInputElement;
    const key = document.getElementById("password") as HTMLInputElement;
    const store = document.getElementById("keepLoggedIn") as HTMLInputElement | null;
    if (login && key) {
      const username = login.value;
      const password = key.value;
      if (username && password) {
        cloudApi.setToken("Basic " + btoa(username + ":" + password));
        let has_net = true;
        try {
          if (store?.checked) this.verifyClientId();
          const clientId = this.clientId ?? "";
          cloudApi.setFixedHeader("X-PP-Expected-User", "");
          const res = (await cloudApi.fetchSession(clientId, { skipRefresh: true })) as SessionResponse;
          if (res && isErrorResponse(res)) throw res.error;
          this.login = res.login;
          this.token = res.token;
          this.storeSessionInfo(res.token);
          cloudApi.setToken("Bearer " + res.token);
          this.verifyNotifications(res.token, true);
          this.updateDatabase("UPDATE");
        } catch (error) {
          has_net = error === 401;
          if (!cloudApi.isAuthed()) this.storeSessionInfo("");
          cloudApi.setToken(null);
          if (store) store.checked = false;
          this.log("Auth error: " + error);
          this.login = this.token = undefined;
        }
        if (store?.checked) await this.restoreSessionInfo(); // switch to token auth
        const success = cloudApi.isAuthed();
        await this.confirm(success ? "access-granted" : has_net ? "access-denied" : "no-signal", {
          animOnly: success ? 1000 : 1500,
          parent: loginDialog,
          style: { backgroundColor: "#3333" },
        });
        if (success) {
          endModal(loginDialog);
          this.updateFieldsForUser();
        }
        login.value = key.value = "";
      }
    }
  }

  private async enterSongCheckMode() {
    if (await this.updateSongCheckList()) {
      if (this.btnShare) makeVisible(this.btnShare, false);
      if (this.filterRow) makeVisible(this.filterRow, false);
      if (this.divStartEdit) makeVisible(this.divStartEdit, false);
      if (this.btnHome) makeVisible(this.btnHome, true);
      if (this.btnAccept) makeVisible(this.btnAccept, true);
      if (this.btnReject) makeVisible(this.btnReject, true);
      this.makeMoreContentVisible(false);
    } else {
      const message = "List is empty";
      if (this.hostDevice) this.hostDevice.showToast(message);
      else this.alert(message);
    }
  }

  private async updateSongCheckList() {
    try {
      const prev = this.songToCheck;
      const privateList = await cloudApi.fetchPendingSongs();
      this.updatePendingCheckCount(privateList.length);
      if (privateList.length > 0) {
        privateList.sort((a, b) => {
          const amine = a.uploader === this.login ? 1 : 0,
            bmine = b.uploader === this.login ? 1 : 0;
          if (amine + bmine === 1) return bmine - amine;
          const ddiff = a.created.localeCompare(b.created);
          if (ddiff) return -ddiff;
          return a.title.localeCompare(b.title);
        });
        this.updateTableFromEntries(privateList);
        const idx = !prev
          ? 0
          : Math.max(
              0,
              privateList.findIndex((x) => x.songId === prev.songId && x.version === prev.version)
            );
        this.loadSongToCheck(privateList[idx]);
        return true;
      }
    } catch (error) {
      this.log(String(error));
    }
    return false;
  }

  private async songChecked(accepted: boolean) {
    if (!this.songToCheck || !(await this.confirm(accepted ? "approve" : "reject"))) return;
    try {
      const new_state: PendingSongOperation =
        this.login === this.songToCheck.uploader && !accepted
          ? "REVOKE"
          : this.songToCheck.state === "REJECTED"
            ? accepted
              ? "KEEP"
              : "REVOKE"
            : accepted
              ? "APPROVE"
              : "REJECT";
      const error = await cloudApi.updatePendingSongState(this.songToCheck.songId, this.songToCheck.version, new_state);
      if (error) this.alert("⚠:" + error);
      else if (!(await this.updateSongCheckList())) this.goHome();
    } catch (error) {
      this.log(String(error));
    }
  }

  private async updateFieldsForUser(performQuery = true) {
    const enableEdit = (this.onlineMode || cloudApi.isAuthed()) && virtualKeyboard();
    if (this.iconLogin) makeVisible(this.iconLogin, !cloudApi.isAuthed());
    if (this.iconLogout) makeVisible(this.iconLogout, cloudApi.isAuthed());
    if (this.iconStartOnlineSession) makeVisible(this.iconStartOnlineSession, cloudApi.isAuthed());
    if (this.iconStartSession) {
      makeVisible(this.iconStartSession, !this.ppdWatchers && (!this.iconStartOnlineSession || !isVisible(this.iconStartOnlineSession)));
      makeDisabled(this.iconStartSession, !this.udpEnabled && !this.nearbyEnabled);
    }
    if (this.iconStopSession) makeVisible(this.iconStopSession, this.ppdWatchers != null);
    if (this.divStartEdit) this.divStartEdit.onclick = enableEdit ? () => this.onEditSong(true) : () => this.onNoteButtonClicked(true);
    if (this.divCancelEdit) this.divCancelEdit.onclick = enableEdit ? () => this.onEditSong(false) : () => this.onNoteButtonClicked(false);
    if (this.iconCheck) makeVisible(this.iconCheck, cloudApi.isAuthed() && this.mode === "App");
    if (performQuery) {
      if (this.divStartEdit) {
        makeVisible(this.divStartEdit, false);
        this.applySizeGuard();
      }
      if (!this.songToCheck) {
        if (enableEdit) this.queryEditPermission();
        else this.queryHighlightPermission(true);
      }
    }
  }

  private get clientId() {
    return this.hostDevice?.retrievePreference("clientId") ?? (localStorage || window.localStorage)?.getItem("clientId");
  }

  private verifyClientId() {
    if (!this.clientId) {
      const clientId = this.genUniqueId();
      if (this.hostDevice) {
        this.hostDevice.storePreference("clientId", this.hostDevice.getName() + ":" + clientId);
        cloudApi.setClientId(this.hostDevice.getName() + ":" + clientId);
      } else {
        const ls = localStorage || window.localStorage;
        if (ls) ls.setItem("clientId", clientId);
        cloudApi.setClientId(clientId);
      }
    }
  }

  private verifyNotifications(token: string, enableNotification: boolean) {
    if (this.login && this.hostDevice)
      try {
        const enabled = this.hostDevice.enableNotification(
          token,
          "PraiseProjector",
          "PraiseProjector Notifications",
          60,
          enableNotification || this.hostDevice.retrievePreference("notifsEnabled") !== "false"
        );
        if (!enabled) this.hostDevice.storePreference("notifsEnabled", "false");
      } catch (error) {
        this.log("Notif error: " + error);
      }
  }

  async editInstructions(instructions?: string) {
    if (this.instructionsEditor) {
      const instructionsEditor = this.instructionsEditor;
      const startupInstructions = instructions ?? this.currentDisplay.instructions ?? "";
      const setup = (ins: string) => {
        this.instructionsEditorColorSchemeUpdater = this.editor?.setupInstructionsEditor(instructionsEditor, ins, () => this.updateColorScheme());
        this.updateColorScheme();
      };
      setup(startupInstructions);
      if (this.instructionsDialog) {
        const dialog = this.instructionsDialog;
        const applyMethod = (id: string, f: () => void) => {
          const btn = document.getElementById(id);
          if (btn) btn.onclick = f;
        };
        applyMethod("ie-dialog-save", () => endModal(dialog, this.editor?.getInstructions("SETTING")));
        applyMethod("ie-dialog-revert", () => setup(startupInstructions));
        applyMethod("ie-dialog-reset", () => setup(""));
        applyMethod("ie-dialog-close", () => endModal(dialog));
        const result = await doModal(this.instructionsDialog);
        console.log("IE dialog result: " + result);
        if (result != null && result !== instructions) {
          await this.preferenceUpdate("instructions", result);
        }
      }
    }
  }
}
