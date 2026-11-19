/**
 * Connects the MCP tools to the running application: implements {@link McpHost} with
 * the real database, panels and settings, and answers the JSON-RPC messages the
 * Electron main process relays from its loopback endpoint (`electron/mcp-host.ts`).
 *
 * Only active where the Electron bridge exists; in the browser and on Android the hook
 * does nothing.
 */
import { useEffect, useRef } from "react";
import type { MutableRefObject, RefObject } from "react";
import { cloudApi } from "../../../common/cloudApi";
import { formatLocalDateKey, parseScheduleDate } from "../../../common/date-only";
import {
  allocateFavoriteDate,
  favoriteNameFromLabel,
  isFavoriteScheduleDate,
  sameFavoriteName,
  validateFavoriteName,
} from "../../../common/favorite-playlists";
import type { DisplayUpdateRequest } from "../../../common/pp-types";
import { getChordSystem } from "../../../chordpro/chordpro_base";
import { Database, FormatFoundReason, SongOrder } from "../../../db-common/Database";
import type { Leader } from "../../../db-common/Leader";
import { Playlist } from "../../../db-common/Playlist";
import { PlaylistEntry } from "../../../db-common/PlaylistEntry";
import { Song } from "../../../db-common/Song";
import { convertHistoryEntriesToSongsWithHistory } from "../../components/compareDialogUtils";
import type { LeftPanelMethods } from "../../components/LeftPanel";
import type { PreviewPanelMethods } from "../../components/PreviewPanel";
import type { SectionListCommand } from "../../components/preview/sectionControlCommands";
import { buildLocalUrl } from "../../hooks/useSessionUrl";
import enStrings from "../../localization/strings.en.json";
import huStrings from "../../localization/strings.hu.json";
import enTooltips from "../../localization/tooltips.en.json";
import huTooltips from "../../localization/tooltips.hu.json";
import { getCurrentDisplay } from "../../state/CurrentSongStore";
import { getTutorialDefinition } from "../../tutorial/tutorialDefinitions";
import type { Settings } from "../../types";
import { getLocalNetworkAddresses } from "../hostDevicePpd";
import { getWebServerInterface, isWebServerRuntimeAvailable } from "../webServerBridge";
import { chordStatus, gridChords, importerChord, importerConventions, knownChordTypes } from "./appChords";
import { findTutorialSteps } from "./help";
import { createMcpPrompts } from "./prompts";
import { createMcpDispatcher } from "./protocol";
import { songKeyDirective } from "./songMeta";
import { estimateSongKey } from "./songKey";
import { analyzeInstructions, songStructure } from "./songStructure";
import { McpContent, createMcpResources, createMcpTools } from "./tools";
import type { PlaylistOrigin } from "../playlistOrigin";
import type {
  McpHost,
  McpLeader,
  McpPlaylistItem,
  McpPlaylistSource,
  McpShowResult,
  McpSong,
  McpSongInfo,
  McpSongUsage,
  McpStoredPlaylistRef,
  McpViewTarget,
} from "./types";

/** What the App component lends to the MCP host. Read through a ref, so always current. */
export interface McpAppBindings {
  settings: Settings | null;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  language: "en" | "hu";
  account: { username: string | null; signedIn: boolean; guest: boolean };
  selectedLeader: Leader | null;
  selectLeader: (leaderId: string) => void;
  leftPanel: RefObject<LeftPanelMethods | null>;
  previewPanel: RefObject<PreviewPanelMethods | null>;
  /** True while this app follows another device's session. */
  following: boolean;
  /** The entry remote clients use to change song and playlist. */
  remoteDisplayUpdate: (update: DisplayUpdateRequest) => Promise<void>;
  importFiles: (files: File[]) => void;
  openView: (target: McpViewTarget, page?: string) => boolean;
  confirm: (title: string, message: string) => Promise<boolean>;
  ui: { activePanel: string; openDialogs: string[]; editingSong: boolean; updateAvailable: boolean };
}

const SPOTLIGHT_CLASS = "pp-mcp-spotlight";
const SPOTLIGHT_MS = 6000;

const currentView = (): "full" | "client" => {
  try {
    return window.localStorage.getItem("pp-show-client-view") === "1" ? "client" : "full";
  } catch {
    return "full";
  }
};

function ensureSpotlightStyle(): void {
  if (document.getElementById("pp-mcp-spotlight-style")) return;
  const style = document.createElement("style");
  style.id = "pp-mcp-spotlight-style";
  style.textContent = `
@keyframes pp-mcp-spotlight-pulse { 0%, 100% { box-shadow: 0 0 0 3px rgba(255, 152, 0, 0.9); } 50% { box-shadow: 0 0 0 10px rgba(255, 152, 0, 0.25); } }
.${SPOTLIGHT_CLASS} { outline: 3px solid #ff9800 !important; outline-offset: 2px; animation: pp-mcp-spotlight-pulse 1s ease-in-out infinite; position: relative; z-index: 5; }`;
  document.head.appendChild(style);
}

/** Runs the tutorial's own preparation for the target, then highlights it for a while. */
async function spotlight(targetId: string): Promise<McpShowResult> {
  const found = findTutorialSteps(content.help.tutorials, targetId);
  if (!found) return "unknown";
  if (found.view !== currentView()) return "other-view";
  const cleanups: (() => void)[] = [];
  for (const step of found.steps) {
    const cleanup = step.prepare?.();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  // The preparation switches panels through React state: wait for the render.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const target = found.steps[found.steps.length - 1].target;
  const element = (typeof target === "string" ? [target] : [...target])
    .flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)))
    .find((candidate) => candidate.getClientRects().length > 0);
  if (!element) {
    cleanups.forEach((cleanup) => cleanup());
    return "not-visible";
  }
  ensureSpotlightStyle();
  element.scrollIntoView({ block: "center", inline: "nearest" });
  element.classList.add(SPOTLIGHT_CLASS);
  window.setTimeout(() => {
    element.classList.remove(SPOTLIGHT_CLASS);
    cleanups.forEach((cleanup) => cleanup());
  }, SPOTLIGHT_MS);
  return "shown";
}

const content: McpContent = {
  strings: { en: enStrings as Record<string, string>, hu: huStrings as Record<string, string> },
  help: {
    tutorials: [getTutorialDefinition("full"), getTutorialDefinition("client")],
    tooltips: { en: enTooltips as Record<string, string>, hu: huTooltips as Record<string, string> },
  },
};

const database = (): Database | null => (Database.isReady() ? Database.getInstance() : null);

const dateOf = (key: string): Date => parseScheduleDate(key) ?? new Date(NaN);

function songKeyOf(song: Song, transpose: number): string {
  const key = songKeyDirective(song.Text);
  if (!key || !transpose) return key;
  return getChordSystem(song.System).getKey(key)?.transposedKey(transpose) || key;
}

const songInfo = (song: Song): McpSongInfo => ({
  id: song.Id,
  title: song.Title,
  language: song.Language,
  kind: song.ContentKind,
  key: songKeyOf(song, 0),
});

const toItem = (entry: PlaylistEntry, db: Database | null): McpPlaylistItem => ({
  songId: entry.songId,
  title: entry.title || db?.getSongById(entry.songId)?.Title || "",
  transpose: entry.transpose ?? 0,
  capo: entry.capo ?? -1,
  instructions: entry.instructions ?? "",
});

const toEntry = (item: McpPlaylistItem): PlaylistEntry => PlaylistEntry.fromJSON({ ...item });

function describeLeader(leader: Leader, access: "own" | "public"): McpLeader {
  const scheduledDates: string[] = [];
  const favorites: string[] = [];
  for (const date of leader.getSchedule()) {
    if (isFavoriteScheduleDate(date)) {
      const name = favoriteNameFromLabel(leader.getPlaylist(date)?.name);
      if (name) favorites.push(name);
    } else scheduledDates.push(formatLocalDateKey(date));
  }
  return { id: leader.id, name: leader.name, access, scheduledDates: scheduledDates.sort(), favorites };
}

function findLeader(db: Database, leaderId: string): { leader: Leader; own: boolean } | null {
  const own = db.getAllLeaders().find((leader) => leader.id === leaderId);
  if (own) return { leader: own, own: true };
  const mirrored = db.getPublicLeaders().find((leader) => leader.id === leaderId);
  return mirrored ? { leader: mirrored, own: false } : null;
}

/** The stored date of a calendar day's list or of a favorite, null when the leader has none. */
function findStoredDate(leader: Leader, ref: McpStoredPlaylistRef): Date | null {
  return (
    leader
      .getSchedule()
      .find((date) =>
        "favorite" in ref
          ? isFavoriteScheduleDate(date) && sameFavoriteName(favoriteNameFromLabel(leader.getPlaylist(date)?.name), ref.favorite)
          : !isFavoriteScheduleDate(date) && formatLocalDateKey(date) === ref.date
      ) ?? null
  );
}

/** The stored list the working list was loaded from or saved to, as the reminder before a sync sees it. */
function playlistSource(db: Database | null, origin: PlaylistOrigin | null): McpPlaylistSource | null {
  const found = db && origin ? findLeader(db, origin.leaderId) : null;
  if (!found || !origin) return null;
  const leader = { leaderId: found.leader.id, leader: found.leader.name };
  const date = new Date(origin.scheduledAt);
  if (!isFavoriteScheduleDate(date)) return { ...leader, date: formatLocalDateKey(date) };
  const favorite = favoriteNameFromLabel(found.leader.getPlaylist(date)?.name) || favoriteNameFromLabel(origin.label);
  return favorite ? { ...leader, favorite } : null;
}

/** Where a stored list goes: its existing date, else a new favorite slot or the given day. */
function storageDate(leader: Leader, ref: McpStoredPlaylistRef): Date {
  return findStoredDate(leader, ref) ?? ("favorite" in ref ? allocateFavoriteDate(leader.getSchedule()) : dateOf(ref.date));
}

export function createAppMcpHost(bindings: MutableRefObject<McpAppBindings>, appVersion: () => string): McpHost {
  const app = () => bindings.current;
  return {
    appVersion,
    platform: () => navigator.platform || "unknown",
    language: () => app().language,
    account: () => app().account,

    getSettings: () => app().settings,
    updateSettings: async (patch) => {
      for (const key of Object.keys(patch) as (keyof Settings)[]) app().updateSetting(key, patch[key] as never);
      // The save is asynchronous state work: let it settle before the tool reads back.
      await new Promise((resolve) => setTimeout(resolve, 50));
    },

    songCount: () => database()?.getSongs().length ?? 0,
    listSongs: () => (database()?.getSongs() ?? []).map(songInfo),
    getSong: (songId): McpSong | null => {
      const song = database()?.getSongById(songId);
      if (!song) return null;
      const related = song.GroupId
        ? (database()?.getSongs() ?? []).filter((other) => other.GroupId === song.GroupId && other.Id !== song.Id).map(songInfo)
        : [];
      return { ...songInfo(song), text: song.Text, system: song.System, capo: song.Capo, version: song.version, related };
    },
    getSongHistory: async (songId) => {
      try {
        // The same reading as the app's history dialog, so the texts compare with the stored songs.
        const versions = convertHistoryEntriesToSongsWithHistory(await cloudApi.fetchSongHistory(songId)).map((version) => ({
          uploaded: version.Change?.created.toISOString() ?? "",
          uploader: version.Change?.uploader ?? "",
          text: version.Text,
          system: version.System,
          language: version.Language,
        }));
        return { versions };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    searchSongs: async (query) => {
      const db = database();
      if (!db) return [];
      const results = await db.filter(query, app().selectedLeader, true, true, true, true, SongOrder.LessCostMatch, app().settings ?? undefined);
      return results.map((found) => ({ song: songInfo(found.song), reason: FormatFoundReason(found.reason), snippet: found.snippet || undefined }));
    },
    analyzeChordPro: (text, system) => {
      const song = new Song(text, system === "S" ? "S" : "G");
      return {
        title: song.Title,
        kind: song.ContentKind,
        sectionCount: song.Sections.length,
        repeatedSections: songStructure(text, system).repeatedSections,
        keyEstimate: estimateSongKey(text, system),
      };
    },
    songStructure: (songId) => {
      const song = database()?.getSongById(songId);
      return song ? songStructure(song.Text, song.System) : null;
    },
    songKeyEstimate: (songId) => {
      const song = database()?.getSongById(songId);
      return song ? estimateSongKey(song.Text, song.System) : null;
    },
    analyzeInstructions: (songId, instructions) => {
      const song = database()?.getSongById(songId);
      return song ? analyzeInstructions(song.Text, song.System, instructions) : null;
    },
    chordStatus,
    knownChordTypes,
    importerChord,
    importerConventions,
    gridChords,
    importSongText: (fileName, text) => {
      app().importFiles([new File([text], fileName, { type: "text/plain" })]);
      return true;
    },

    listLeaders: () => {
      const db = database();
      if (!db) return [];
      return [
        ...db.getAllLeaders().map((leader) => describeLeader(leader, "own")),
        ...db.getPublicLeaders().map((leader) => describeLeader(leader, "public")),
      ];
    },
    selectedLeader: () => {
      const leader = app().selectedLeader;
      return leader ? { id: leader.id, name: leader.name } : null;
    },
    selectLeader: (leaderId) => app().selectLeader(leaderId),
    getSongUsage: (leaderId, since) => {
      const db = database();
      const leader = db && findLeader(db, leaderId)?.leader;
      if (!db || !leader) return [];
      const counts = new Map<string, { count: number; lastUsed: string }>();
      for (const date of leader.getSchedule()) {
        if (isFavoriteScheduleDate(date)) continue;
        const day = formatLocalDateKey(date);
        if (since && day < since) continue;
        // A song repeated within one service still counts once for that day.
        for (const songId of new Set(leader.getPlaylist(date)?.items.map((entry) => entry.songId) ?? [])) {
          const entry = counts.get(songId) ?? { count: 0, lastUsed: "" };
          entry.count++;
          if (day > entry.lastUsed) entry.lastUsed = day;
          counts.set(songId, entry);
        }
      }
      const usage: McpSongUsage[] = [];
      for (const [songId, { count, lastUsed }] of counts) {
        const song = db.getSongById(songId);
        if (!song) continue;
        const transpose = leader.getPreference(songId)?.transpose ?? 0;
        usage.push({ song: songInfo(song), count, lastUsed, transpose, leaderKey: songKeyOf(song, transpose) });
      }
      return usage.sort((a, b) => b.count - a.count || b.lastUsed.localeCompare(a.lastUsed) || a.song.title.localeCompare(b.song.title));
    },
    songKey: (songId, transpose) => {
      const song = database()?.getSongById(songId);
      return song ? songKeyOf(song, transpose) : "";
    },
    newPlaylistItem: (leaderId, songId) => {
      const db = database();
      const song = db?.getSongById(songId);
      if (!db || !song) return null;
      const leader = leaderId ? findLeader(db, leaderId)?.leader : undefined;
      return toItem(PlaylistEntry.forSong(song, leader?.getPreference(songId)), db);
    },

    getStoredPlaylist: (leaderId, ref) => {
      const db = database();
      const leader = db && findLeader(db, leaderId)?.leader;
      const date = leader && findStoredDate(leader, ref);
      const playlist = date && leader.getPlaylist(date);
      if (!playlist) return null;
      return {
        name: "favorite" in ref ? favoriteNameFromLabel(playlist.name) : playlist.name,
        items: playlist.items.map((entry) => toItem(entry, db)),
      };
    },
    storePlaylist: (leaderId, ref, items, overwrite) => {
      const db = database();
      const found = db && findLeader(db, leaderId);
      if (!db || !found || !found.own) return "read-only";
      if ("favorite" in ref && validateFavoriteName(ref.favorite)) return "invalid-name";
      if (findStoredDate(found.leader, ref) && !overwrite) return "exists";
      // The list only: its items (with titles that may carry the key) must not become the
      // leader's song preferences, which an app save would make of them.
      db.schedule(
        found.leader,
        storageDate(found.leader, ref),
        new Playlist("", items.map(toEntry)),
        "favorite" in ref ? ref.favorite.trim() : undefined,
        {
          updatePreferences: false,
        }
      );
      return "saved";
    },

    getPlaylist: () => {
      const db = database();
      const panel = app().leftPanel.current;
      const items = (panel?.getCurrentPlaylist().items ?? []).map((entry) => toItem(entry, db));
      const current = getCurrentDisplay().songId;
      return {
        items,
        selectedIndex: current ? items.findIndex((item) => item.songId === current) : -1,
        source: playlistSource(db, panel?.getPlaylistOrigin() ?? null),
        readOnly: app().following,
      };
    },
    replacePlaylist: async (items) => {
      const panel = app().leftPanel.current;
      if (!panel) throw new Error("The playlist panel is not available");
      await panel.replacePlaylist(items.map((item) => toEntry(item).toJSON()));
    },
    editPlaylist: async (items, sources, storeInstructions) => {
      const panel = app().leftPanel.current;
      if (!panel) throw new Error("The playlist panel is not available");
      await panel.applyPlaylistEdit(
        items.map((item) => toEntry(item).toJSON()),
        sources,
        storeInstructions
      );
    },
    loadStoredPlaylist: async (leaderId, ref) => {
      const db = database();
      const panel = app().leftPanel.current;
      const leader = db && findLeader(db, leaderId)?.leader;
      const date = leader && findStoredDate(leader, ref);
      const playlist = date && leader.getPlaylist(date);
      if (!playlist || !panel) return false;
      await panel.loadScheduledPlaylist(leaderId, date, playlist);
      return true;
    },
    saveWorkingPlaylist: (leaderId, ref) => {
      const db = database();
      const panel = app().leftPanel.current;
      const found = db && findLeader(db, leaderId);
      if (!db || !found || !found.own) return "read-only";
      if ("favorite" in ref && validateFavoriteName(ref.favorite)) return "invalid-name";
      if (!panel) return "failed";
      return panel.saveToSchedule(found.leader, storageDate(found.leader, ref), "favorite" in ref ? ref.favorite.trim() : undefined)
        ? "saved"
        : "failed";
    },
    loadPlaylistFile: async () =>
      (await app().leftPanel.current?.loadPlaylistFromFile()) ?? { status: "failed", error: "The playlist panel is not available." },
    savePlaylistFile: async () =>
      (await app().leftPanel.current?.savePlaylistToFile()) ?? { status: "failed", error: "The playlist panel is not available." },

    getProjection: async () => {
      const display = getCurrentDisplay();
      const preview = app().previewPanel.current;
      const song = display.songId ? database()?.getSongById(display.songId) : undefined;
      let projectorOpen: boolean | null = null;
      try {
        projectorOpen = (await window.electronAPI?.isDisplayWindowOpen?.()) ?? null;
      } catch {
        projectorOpen = null;
      }
      return {
        songId: display.songId ?? "",
        title: song?.Title ?? "",
        sectionIndex: preview?.getSelectedSectionIndex() ?? -1,
        sections: (preview?.getSections() ?? []).map((section, index) => ({ index, ...section })),
        transpose: display.transpose ?? 0,
        capo: display.capo ?? -1,
        instructions: display.instructions ?? "",
        projectInstructions: app().settings?.projectInstructions === true,
        projectorOpen,
      };
    },
    showSong: async (songId) => {
      if (!database()?.getSongById(songId)) return "not-found";
      const playlist = app().leftPanel.current?.getCurrentPlaylist();
      const inPlaylist = playlist?.items.some((entry) => entry.songId === songId);
      if (inPlaylist) {
        await app().remoteDisplayUpdate({ command: "display_update", id: songId, from: 0, to: 0 });
        return "playlist";
      }
      app().leftPanel.current?.setSelectedSongId(songId);
      return "tree";
    },
    selectSection: (index) => {
      const preview = app().previewPanel.current;
      if (!preview) return false;
      preview.setSelectedSectionIndex(index);
      return true;
    },
    sectionCommand: (command) => app().previewPanel.current?.runSectionCommand(command as SectionListCommand) ?? false,

    getNetworkStatus: async () => {
      const settings = app().settings;
      const available = isWebServerRuntimeAvailable();
      const enabled = available && !!settings?.iWebEnabled;
      const localAddresses = await getLocalNetworkAddresses().catch(() => [] as string[]);
      const clientUrl = enabled
        ? buildLocalUrl({ ...settings, webServerDomainName: settings?.webServerDomainName || localAddresses[0] || "" })
        : null;
      const clients = await (async () => {
        try {
          const result = await getWebServerInterface()?.query({ kind: "clients" });
          return result?.kind === "clients" ? result.clients : [];
        } catch {
          return [];
        }
      })();
      const sessions = await window.electronAPI?.udpGetDiscoveredSessions?.().catch(() => []);
      return {
        webServerAvailable: available,
        webServerEnabled: enabled,
        clientUrl,
        netDisplayUrl: clientUrl && settings?.externalWebDisplayEnabled ? `${clientUrl}netdisplay` : null,
        localAddresses,
        port: settings?.webServerPort ?? 0,
        lanClientsOnly: settings?.webServerAcceptLanClientsOnly !== false,
        nearbySessionEnabled: settings?.ppdSessionEnabled !== false,
        allClientsCanLead: settings?.allClientsCanUseLeaderMode !== false,
        clients: clients.map((client) => ({
          name: client.deviceName,
          id: client.id,
          connected: client.isConnected !== false,
          leaderMode: client.isLeaderModeClient,
        })),
        discoveredSessions: (sessions ?? []).map((session) => ({ name: session.name, leader: session.hostId, transport: session.transport })),
        followingSession: app().following,
      };
    },
    openView: (target, page) => app().openView(target, page),
    getUiState: () => {
      const selectedId = app().leftPanel.current?.getSelectedSongId() ?? null;
      const selected = selectedId ? database()?.getSongById(selectedId) : undefined;
      return {
        view: currentView(),
        ...app().ui,
        selectedSong: selected ? songInfo(selected) : null,
        followingSession: app().following,
      };
    },
    getDisplayInfo: async () => {
      const api = window.electronAPI;
      const displays = (await api?.getAllDisplays?.().catch(() => [])) ?? [];
      const projectorOpen = (await api?.isDisplayWindowOpen?.().catch(() => null)) ?? null;
      return { displayCount: displays.length, projectorDisplaySelected: !!app().settings?.displayMonitorId, projectorOpen };
    },
    showInApp: spotlight,
    confirm: (title, message) => app().confirm(title, message),
  };
}

/** Answers MCP requests relayed by the Electron main process for as long as the app is mounted. */
export function useMcpBridge(bindings: McpAppBindings): void {
  const ref = useRef(bindings);
  // Tools read the latest state through the ref; it is refreshed after every render.
  useEffect(() => {
    ref.current = bindings;
  });

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onMcpRequest || !api.sendMcpResponse) return;
    let version = "";
    void api.getAppVersion?.().then((value) => {
      version = value;
    });
    const host = createAppMcpHost(ref, () => version);
    const handle = createMcpDispatcher({
      tools: createMcpTools(content),
      resources: createMcpResources(content),
      prompts: createMcpPrompts(),
      host,
      permissions: () => {
        const settings = ref.current.settings;
        return {
          allowChanges: settings?.mcpAllowChanges === true,
          allowLiveControl: settings?.mcpAllowLiveControl === true,
          confirmChanges: settings?.mcpConfirmChanges !== false,
        };
      },
    });
    return api.onMcpRequest((request) => {
      void handle(request.message).then((message) => api.sendMcpResponse?.({ requestId: request.requestId, message }));
    });
  }, []);
}
