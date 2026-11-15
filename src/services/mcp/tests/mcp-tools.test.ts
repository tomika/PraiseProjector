/** MCP tools and protocol against an in-memory host. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonRpcResponse } from "../../../../common/mcp-bridge";
import enStrings from "../../../localization/strings.en.json";
import huStrings from "../../../localization/strings.hu.json";
import enTooltips from "../../../localization/tooltips.en.json";
import huTooltips from "../../../localization/tooltips.hu.json";
import { getTutorialDefinition } from "../../../tutorial/tutorialDefinitions";
import { buildHelpTopics, findTutorialSteps, searchHelp } from "../help";
import { createMcpPrompts } from "../prompts";
import { createMcpDispatcher } from "../protocol";
import { SETTINGS_CATALOG, describeSettings, validateSettingsPatch } from "../settingsCatalog";
import { McpContent, createMcpResources, createMcpTools, diagnose, findSongs, foldPattern, isRiskyPattern, lyricsOf, resolveLeader } from "../tools";
import { McpToolError } from "../types";
import { FakeState, fakeHost, fakeState, song } from "./fakeHost";

const content: McpContent = {
  strings: { en: enStrings as Record<string, string>, hu: huStrings as Record<string, string> },
  help: {
    tutorials: [getTutorialDefinition("full"), getTutorialDefinition("client")],
    tooltips: { en: enTooltips as Record<string, string>, hu: huTooltips as Record<string, string> },
  },
};

function server(state: FakeState) {
  const host = fakeHost(state);
  const handle = createMcpDispatcher({
    tools: createMcpTools(content),
    resources: createMcpResources(content),
    prompts: createMcpPrompts(),
    host,
    permissions: () => ({
      allowChanges: state.settings.mcpAllowChanges === true,
      allowLiveControl: state.settings.mcpAllowLiveControl === true,
      confirmChanges: state.settings.mcpConfirmChanges !== false,
    }),
  });
  let id = 0;
  const request = async (method: string, params?: Record<string, unknown>) =>
    (await handle({ jsonrpc: "2.0", id: ++id, method, params })) as JsonRpcResponse;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await request("tools/call", { name, arguments: args });
    const result = response.result as { content: { text: string }[]; isError: boolean };
    const text = result.content[0].text;
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      /* plain text answer */
    }
    return { isError: result.isError, text, value: value as never };
  };
  return { handle, request, call, host };
}

test("initialize answers the requested handshake revision and falls back to the newest one", async () => {
  const { request } = server(fakeState());
  const known = (await request("initialize", { protocolVersion: "2025-03-26" })).result as Record<string, unknown>;
  assert.equal(known.protocolVersion, "2025-03-26");
  assert.equal((known.serverInfo as { version: string }).version, "9.9.9");
  const unknown = (await request("initialize", { protocolVersion: "2031-01-01" })).result as Record<string, unknown>;
  assert.equal(unknown.protocolVersion, "2025-11-25");
});

test("the stateless revision gets discovery and complete, cacheable results", async () => {
  const { request } = server(fakeState());
  const discover = (await request("server/discover")).result as Record<string, unknown>;
  assert.equal(discover.resultType, "complete");
  assert.ok((discover.supportedVersions as string[]).includes("2026-07-28"));
  const list = (await request("tools/list")).result as Record<string, unknown>;
  assert.equal(list.resultType, "complete");
  assert.equal(typeof list.ttlMs, "number");
  assert.equal(list.cacheScope, "public");
  const tools = list.tools as { name: string; inputSchema: { type: string } }[];
  assert.ok(tools.length > 20);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
  for (const tool of tools) {
    assert.match(tool.name, /^[a-z_]{1,64}$/);
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("notifications get no answer and unknown methods, tools and resources are protocol errors", async () => {
  const { handle, request } = server(fakeState());
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal((await request("no/such")).error?.code, -32601);
  assert.equal((await request("tools/call", { name: "nope" })).error?.code, -32602);
  assert.equal((await request("resources/read", { uri: "praiseprojector://none" })).error?.code, -32602);
});

test("the guide resource is the tutorial text", async () => {
  const { request } = server(fakeState());
  const list = (await request("resources/list")).result as { resources: { uri: string }[] };
  assert.deepEqual(
    list.resources.map((resource) => resource.uri),
    ["praiseprojector://guide/en", "praiseprojector://guide/hu"]
  );
  const read = (await request("resources/read", { uri: "praiseprojector://guide/hu" })).result as { contents: { text: string }[] };
  assert.match(read.contents[0].text, /Profil és adatbázis/);
});

test("write tools need the permission, and the user's confirmation when it is asked for", async () => {
  const state = fakeState();
  const { call } = server(state);
  state.settings.mcpAllowChanges = false;
  const denied = await call("update_settings", { changes: { keepAwake: true } });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /Allow changes/);
  assert.equal(state.settings.keepAwake, undefined);

  state.settings.mcpAllowChanges = true;
  state.confirmAnswer = false;
  const declined = await call("update_settings", { changes: { keepAwake: true } });
  assert.match(declined.text, /declined/);
  assert.match(state.confirmations[0], /Keep awake: true/);
  assert.equal(state.settings.keepAwake, undefined);

  state.confirmAnswer = true;
  assert.equal((await call("update_settings", { changes: { keepAwake: true } })).isError, false);
  assert.equal(state.settings.keepAwake, true);

  state.settings.mcpConfirmChanges = false;
  state.confirmations.length = 0;
  await call("update_settings", { changes: { keepAwake: false } });
  assert.equal(state.confirmations.length, 0);
  assert.equal(state.settings.keepAwake, false);
});

test("live control has its own switch", async () => {
  const state = fakeState();
  const { call } = server(state);
  assert.match((await call("section_command", { command: "next" })).text, /Allow live control/);
  state.settings.mcpAllowLiveControl = true;
  assert.equal((await call("section_command", { command: "next" })).isError, false);
  assert.deepEqual(state.calls, ["section:next-down"]);
});

test("settings: every label exists in both languages and risky keys cannot be written", () => {
  const keys = SETTINGS_CATALOG.map((descriptor) => descriptor.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const descriptor of SETTINGS_CATALOG) {
    if (!descriptor.labelKey) continue;
    assert.ok(descriptor.labelKey in enStrings, `en string ${descriptor.labelKey}`);
    assert.ok(descriptor.labelKey in huStrings, `hu string ${descriptor.labelKey}`);
  }
  for (const key of ["mcpEnabled", "mcpAllowChanges", "mcpAllowLiveControl", "mcpConfirmChanges", "typesenseApiKey", "chordProStyles", "nope"]) {
    assert.throws(() => validateSettingsPatch({ [key]: true }), McpToolError, key);
  }
  assert.throws(() => validateSettingsPatch({ webServerPort: 80 }), /at least 1024/);
  assert.throws(() => validateSettingsPatch({ netDisplayResolution: "1x1" }), /one of/);
  assert.throws(() => validateSettingsPatch({ verseSectionColor: "red" }), /color/);
  assert.throws(() => validateSettingsPatch({ keepAwake: true, webServerPort: "x" }), /Nothing was changed/);
  assert.deepEqual(validateSettingsPatch({ webServerPort: 8080, keepAwake: false }), { webServerPort: 8080, keepAwake: false });
});

test("settings are described with the page and label the user sees, secrets hidden", () => {
  const hu = describeSettings({ webServerPort: 19740, typesenseApiKey: "secret" }, huStrings as Record<string, string>);
  const port = hu.find((item) => item.key === "webServerPort")!;
  assert.equal(port.pageLabel, (huStrings as Record<string, string>).SettingsPageWebServer);
  assert.equal(port.value, 19740);
  const secret = hu.find((item) => item.key === "typesenseApiKey")!;
  assert.equal(secret.value, "(set, hidden)");
  assert.equal(secret.writable, false);
  const found = describeSettings({}, enStrings as Record<string, string>, { search: "keep awake" });
  assert.deepEqual(
    found.map((item) => item.key),
    ["keepAwake"]
  );
});

test("lyrics drop chords, directives, comments and scores", () => {
  assert.deepEqual(lyricsOf("{title: X}\n[G]Az [D]Úr\n# note\n{start_of_abc}\nK:G\nCDEF|\n{end_of_abc}\n\nvége"), ["Az Úr", "vége"]);
});

test("pattern search finds songs from alternative words, ignoring accents", () => {
  const host = fakeHost(fakeState());
  const find = (pattern: string, scope: "lyrics" | "title" | "chordpro", ignoreAccents = true, limit = 10, offset = 0) =>
    findSongs(host, { pattern, scope, ignoreAccents, offset, limit });
  const found = find("pászt|nyáj|flock", "lyrics");
  assert.deepEqual(
    found.songs.map((match) => match.song.id),
    ["s1", "s3"]
  );
  assert.deepEqual(found.songs[0].lines, ["Az Úr az én pásztorom,"]);
  // Written without accents it still matches; comments are not lyrics.
  assert.equal(find("pasztor", "lyrics").total, 1);
  assert.equal(find("pasztor", "lyrics", false).total, 0);
  assert.equal(find("^örvendj$", "title").total, 1);
  assert.equal(find("\\[Am\\]", "chordpro", false).songs[0].song.id, "s3");
  // Pages in title order.
  const first = find(".", "lyrics", true, 2);
  assert.deepEqual([first.total, first.returned, first.nextOffset], [3, 2, 2]);
  const rest = find(".", "lyrics", true, 2, 2);
  assert.deepEqual(
    [...first.songs, ...rest.songs].map((match) => match.song.title),
    ["A jó pásztor", "Örvendj", "The flock"]
  );
  assert.equal(rest.nextOffset, null);
});

test("pattern folding keeps escapes, and exploding or broken patterns are refused", () => {
  assert.equal(foldPattern("Á\\S+\\p{Lu}É"), "a\\S+\\p{Lu}e");
  assert.ok(isRiskyPattern("(a+)+$"));
  assert.ok(isRiskyPattern("(.*a)*"));
  assert.ok(!isRiskyPattern("(pászt|nyáj)\\w*"));
  const host = fakeHost(fakeState());
  assert.throws(() => findSongs(host, { pattern: "(a+)+b", scope: "lyrics", ignoreAccents: true, offset: 0, limit: 5 }), /freeze/);
  assert.throws(() => findSongs(host, { pattern: "(", scope: "lyrics", ignoreAccents: true, offset: 0, limit: 5 }), /valid regular expression/);
});

test("a search that runs too long stops and says so", () => {
  let clock = 0;
  const found = findSongs(fakeHost(fakeState()), { pattern: "a", scope: "lyrics", ignoreAccents: true, offset: 0, limit: 5 }, () => (clock += 1000));
  assert.match(found.incomplete ?? "", /took too long/);
});

test("search results and a leader's song usage come in pages", async () => {
  const state = fakeState();
  const songOf = (id: string) => {
    const { id: songId, title, language, kind, key } = state.songs.find((candidate) => candidate.id === id)!;
    return { id: songId, title, language, kind, key };
  };
  state.usage.own1 = ["s1", "s2", "s3"].map((id, index) => ({
    song: songOf(id),
    count: 3 - index,
    lastUsed: "2026-10-04",
    transpose: 0,
    leaderKey: "",
  }));
  state.leaders[0].scheduledDates = ["2026-01-04", "2026-10-04"];
  const { call } = server(state);
  const hits = (await call("search_songs", { query: "o", limit: 1 })).value as { total: number; nextOffset: number; songs: unknown[] };
  assert.deepEqual([hits.total, hits.songs.length, hits.nextOffset], [2, 1, 1]);
  const usage = (await call("get_leader_song_usage", { limit: 2, offset: 2, since: "2026-06-01" })).value as {
    playlistsCounted: number;
    songs: { song: { id: string } }[];
    nextOffset: number | null;
  };
  assert.deepEqual(
    usage.songs.map((entry) => entry.song.id),
    ["s3"]
  );
  assert.equal(usage.nextOffset, null);
  // Only the playlists in the period are counted.
  assert.equal(usage.playlistsCounted, 1);
});

test("leaders resolve by partial, accent-free name and prefer the own profile", () => {
  const state = fakeState();
  const host = fakeHost(state);
  assert.equal(resolveLeader(host, "lantos").id, "pub1");
  assert.equal(resolveLeader(host, "").id, "own1");
  assert.throws(() => resolveLeader(host, "nobody"), /No leader matches/);
  state.leaders.push({ id: "own2", name: "Lantos András", access: "own", scheduledDates: [], favorites: [] });
  assert.equal(resolveLeader(host, "Lantos Andras").id, "own2");
  state.leaders.push({ id: "own3", name: "Lantos Béla", access: "own", scheduledDates: [], favorites: [] });
  assert.throws(() => resolveLeader(host, "lantos"), /several leaders/);
});

test("scenario: a top list of a leader's songs, titles prefixed with the key, saved as a favorite", async () => {
  const state = fakeState();
  const songOf = (id: string) => {
    const { id: songId, title, language, kind, key } = state.songs.find((candidate) => candidate.id === id)!;
    return { id: songId, title, language, kind, key };
  };
  state.usage.pub1 = [
    { song: songOf("s1"), count: 7, lastUsed: "2026-09-13", transpose: 2, leaderKey: "A" },
    { song: songOf("s3"), count: 4, lastUsed: "2026-09-06", transpose: 0, leaderKey: "Am" },
    { song: songOf("s2"), count: 1, lastUsed: "2026-09-06", transpose: 0, leaderKey: "" },
  ];
  const { call } = server(state);

  const usage = (await call("get_leader_song_usage", { leader: "Lantos András", limit: 2 })).value as {
    leader: string;
    songs: { song: { id: string; title: string }; leaderKey: string; transpose: number }[];
  };
  assert.equal(usage.leader, "Lantos András");
  assert.equal(usage.songs.length, 2);

  const items = usage.songs.map((entry) => ({
    songId: entry.song.id,
    title: `${entry.leaderKey} – ${entry.song.title}`,
    transpose: entry.transpose,
  }));
  // The source leader is a read-only public profile: the favorite cannot go there …
  const refused = await call("create_stored_playlist", { favorite: "Lantos Top 10", items, leader: "Lantos András" });
  assert.match(refused.text, /read-only/);
  // … it goes to the user's own (selected) profile, and the loaded playlist stays as it was.
  const saved = await call("create_stored_playlist", { favorite: "Lantos Top 10", items });
  assert.equal(saved.isError, false);
  assert.match(state.confirmations.at(-1)!, /1\. A – A jó pásztor \(transpose \+2\)\n2\. Am – The flock/);
  assert.deepEqual(
    state.stored.get("own1/★lantos top 10")!.items.map((item) => [item.title, item.transpose, item.capo]),
    [
      ["A – A jó pásztor", 2, -1],
      ["Am – The flock", 0, -1],
    ]
  );
  assert.deepEqual(state.playlist, []);
  assert.match((await call("create_stored_playlist", { favorite: "Lantos Top 10", items })).text, /already has the favorite/);
  assert.equal((await call("create_stored_playlist", { favorite: "Lantos Top 10", items, overwrite: true })).isError, false);
  assert.match((await call("create_stored_playlist", { favorite: "x", items: [{ songId: "missing" }] })).text, /no song with id/);
  assert.match((await call("create_stored_playlist", { favorite: "x", items: [] })).text, /empty/);
});

test("the working list is replaced as a whole, items getting the leader's settings as the user's own add does", async () => {
  const state = fakeState();
  state.preferences.set("own1/s2", { transpose: 3, title: "Örvendj (Tamás)" });
  state.playlist = [{ songId: "s3", title: "The flock", transpose: 0, capo: -1, instructions: "" }];
  const { call } = server(state);
  await call("replace_playlist", { items: [{ songId: "s2" }, { songId: "s1", transpose: -2, title: "Pásztor" }] });
  assert.deepEqual(
    state.playlist.map((item) => [item.songId, item.title, item.transpose]),
    [
      ["s2", "Örvendj (Tamás)", 3],
      ["s1", "Pásztor", -2],
    ]
  );
  // Replacing a list saved nowhere says so in the question.
  assert.match(state.confirmations[0], /not saved anywhere[\s\S]*Ctrl\+Z/);
  assert.match((await call("replace_playlist", { items: [], revision: "0-00000000" })).text, /changed since you read it/);
  state.ui.followingSession = true;
  assert.match((await call("replace_playlist", { items: [] })).text, /following another session/);
  state.ui.followingSession = false;
  assert.match((await call("replace_playlist", { items: [{ songId: "s1", transpose: 40 }] })).text, /between -11 and 11/);
});

test("the working list is edited in place with ordered operations, guarded by its revision", async () => {
  const state = fakeState();
  const item = (songId: string, title: string) => ({ songId, title, transpose: 0, capo: -1, instructions: "" });
  state.playlist = [item("s1", "A jó pásztor"), item("s2", "Örvendj"), item("s3", "The flock")];
  state.source = { leaderId: "own1", leader: "Kiss Tamás", date: "2026-10-04" };
  state.stored.set("own1/2026-10-04", { name: "2026.10.04", items: state.playlist.map((entry) => ({ ...entry })) });
  state.preferences.set("own1/s2", { capo: 2 });
  const { call } = server(state);
  const before = (await call("get_playlist")).value as { revision: string; source: { unchangedSinceLoaded: boolean; date: string } };
  assert.deepEqual([before.source.date, before.source.unchangedSinceLoaded], ["2026-10-04", true]);

  const operations = [
    { op: "remove", index: 0 },
    { op: "add", songId: "s2", position: 0 },
    { op: "move", from: 2, to: 1 },
    { op: "update", index: 2, transpose: 2 },
  ];
  const edited = await call("edit_playlist", { revision: before.revision, operations });
  assert.equal(edited.isError, false, edited.text);
  assert.deepEqual(
    state.playlist.map((entry) => [entry.songId, entry.transpose, entry.capo]),
    [
      ["s2", 0, 2],
      ["s3", 0, -1],
      ["s2", 2, -1],
    ]
  );
  // Kept and moved items keep their identity (the source index), the new one has none.
  assert.equal(state.calls.at(-1), "edit:new,2,1");
  assert.equal(
    state.confirmations[0],
    "Change the current playlist like this?\n\n1. + Örvendj (capo 2)\n2. ↕ The flock\n3. ✎ Örvendj (transpose +2)\n\nRemoved: − A jó pásztor"
  );
  const after = edited.value as { revision: string; source: { unchangedSinceLoaded: boolean }; note: string };
  assert.notEqual(after.revision, before.revision);
  assert.equal(after.source.unchangedSinceLoaded, false);
  assert.match(after.note, /differs from the playlist of 2026-10-04/);

  // A stale revision changes nothing, and is caught before the user is asked.
  state.confirmations.length = 0;
  const stale = await call("edit_playlist", { revision: before.revision, operations: [{ op: "remove", index: 0 }] });
  assert.match(stale.text, new RegExp(`revision is now ${after.revision}`));
  assert.equal(state.confirmations.length, 0);
  assert.equal(state.playlist.length, 3);
  // An invalid operation changes nothing either.
  const invalid = await call("edit_playlist", {
    revision: after.revision,
    operations: [
      { op: "remove", index: 0 },
      { op: "move", from: 5, to: 0 },
    ],
  });
  assert.match(invalid.text, /Operation 2 \(move\): 'from' must be a whole number from 0 to 1/);
  assert.equal(state.playlist.length, 3);
  // An empty title restores the default one.
  state.playlist[0] = { ...state.playlist[0], title: "Saját cím" };
  const current = ((await call("get_playlist")).value as { revision: string }).revision;
  await call("edit_playlist", { revision: current, operations: [{ op: "update", index: 0, title: "" }] });
  assert.equal(state.playlist[0].title, "Örvendj");
});

test("stored playlists are loaded, saved and edited without mixing them up with the working list", async () => {
  const state = fakeState();
  const item = (songId: string, title: string, transpose = 0) => ({ songId, title, transpose, capo: -1, instructions: "" });
  state.stored.set("pub1/2026-09-13", { name: "2026.09.13", items: [item("s1", "A jó pásztor", 2), item("s3", "The flock")] });
  const { call } = server(state);

  assert.equal((await call("load_playlist", { leader: "Lantos", date: "2026-09-13" })).isError, false);
  assert.deepEqual(
    state.playlist.map((entry) => entry.songId),
    ["s1", "s3"]
  );
  assert.deepEqual(state.source, { leaderId: "pub1", leader: "Lantos András", date: "2026-09-13" });
  assert.match((await call("load_playlist", { date: "2026-09-14" })).text, /Kiss Tamás has no playlist of 2026-09-14/);
  assert.match((await call("load_playlist", {})).text, /'favorite' \(its name\), or give file: true/);
  assert.match((await call("get_stored_playlist", { date: "1985-03-01" })).text, /reserves this period for favorite playlists/);

  // Saving goes into an own profile only; an existing list needs overwrite.
  assert.match((await call("save_playlist", { leader: "Lantos", date: "2026-09-13", overwrite: true })).text, /read-only/);
  assert.equal((await call("save_playlist", { favorite: "Advent" })).isError, false);
  assert.deepEqual(state.source, { leaderId: "own1", leader: "Kiss Tamás", favorite: "Advent" });
  state.confirmations.length = 0;
  assert.match((await call("save_playlist", { favorite: "advent" })).text, /already has the favorite "advent"[\s\S]*overwrite=true/);
  assert.equal(state.confirmations.length, 0);

  // Editing the stored copy leaves the working list alone, and says how the two relate.
  const stored = (await call("get_stored_playlist", { favorite: "Advent" })).value as { revision: string; items: unknown[] };
  assert.equal(stored.items.length, 2);
  const edited = await call("edit_stored_playlist", { favorite: "ADVENT", revision: stored.revision, operations: [{ op: "remove", index: 1 }] });
  assert.equal(edited.isError, false, edited.text);
  assert.match((edited.value as { note: string }).note, /loaded from this list and stays as it is/);
  assert.match(state.confirmations.at(-1)!, /Removed: − The flock[\s\S]*stays as it is/);
  assert.equal(state.stored.get("own1/★advent")!.items.length, 1);
  assert.equal(state.playlist.length, 2);
  assert.match(
    (await call("edit_stored_playlist", { favorite: "Advent", revision: stored.revision, operations: [{ op: "remove", index: 0 }] })).text,
    /changed since/
  );
});

test("playlist files go through the app's own file dialogs", async () => {
  const state = fakeState();
  state.playlist = [{ songId: "s1", title: "A jó pásztor", transpose: 0, capo: -1, instructions: "" }];
  const { call } = server(state);
  assert.equal((await call("save_playlist", { file: true })).text, "Saved.");
  // The dialog itself is the user's decision: no separate question, unless unsaved work would be lost.
  assert.equal(state.confirmations.length, 0);
  state.fileResult = { status: "cancelled" };
  assert.match((await call("load_playlist", { file: true })).text, /cancelled/);
  assert.match(state.confirmations[0], /not saved anywhere/);
  state.fileResult = { status: "failed", error: "Access denied" };
  assert.match((await call("save_playlist", { file: true })).text, /Access denied/);
  assert.deepEqual(state.calls, ["file:save", "file:load", "file:save"]);
});

test("upload facts come from the cloud history, with the reason when they are missing", async () => {
  const state = fakeState();
  const version = (uploaded: string, uploader: string, text: string) => ({ uploaded, uploader, text, system: "G", language: "hu" });
  const [s1, s2, s3] = state.songs;
  state.history.s1 = { versions: [version("2026-03-01T10:00:00.000Z", "anna", "régi"), version("2026-05-02T09:00:00.000Z", "tamas", s1.text)] };
  state.history.s2 = { versions: [version("2026-09-01T10:00:00.000Z", "", "újabb"), version("2025-01-01T10:00:00.000Z", "anna", s2.text)] };
  state.history.s3 = { error: "network error" };
  state.songs.push({ ...s3, id: "s4", title: "Helyi dal", version: 0 });
  const { call } = server(state);

  const one = (await call("get_song", { songId: "s1" })).value as { upload: Record<string, unknown>; version?: number };
  assert.equal(one.version, undefined);
  assert.deepEqual(one.upload, {
    lastUploaded: "2026-05-02T09:00:00.000Z",
    lastUploader: "tamas",
    firstUploaded: "2026-03-01T10:00:00.000Z",
    versionCount: 2,
    localCopy: "same-as-cloud",
  });

  const many = (await call("get_upload_info", { songIds: ["s4", "s3", "s1", "s2"] })).value as {
    order: string;
    songs: { song: { id: string }; localCopy: string; note?: string; lastUploader: string | null }[];
  };
  assert.deepEqual(
    many.songs.map((entry) => [entry.song.id, entry.localCopy]),
    [
      ["s2", "older-than-cloud"],
      ["s1", "same-as-cloud"],
      ["s4", "not-on-server"],
      ["s3", "unknown"],
    ]
  );
  assert.match(many.order, /without one come last, by title/);
  assert.match(many.songs[0].note ?? "", /newer version is in the cloud[\s\S]*does not reveal/);
  assert.equal(many.songs[0].lastUploader, null);
  assert.match(many.songs[2].note ?? "", /never uploaded/);
  assert.match(many.songs[3].note ?? "", /network error/);
  // The first upload orders differently.
  const byFirst = (await call("get_upload_info", { songIds: ["s1", "s2"], sort: "firstUploaded" })).value as { songs: { song: { id: string } }[] };
  assert.deepEqual(
    byFirst.songs.map((entry) => entry.song.id),
    ["s1", "s2"]
  );
  // Histories are asked once while the local copy stays the same.
  assert.equal(state.calls.filter((entry) => entry === "history:s1").length, 1);
});

test("song versions are listed and compared as line diffs", async () => {
  const state = fakeState();
  const [s1] = state.songs;
  const older = s1.text.replace("pásztorom", "pásztorunk");
  state.history.s1 = {
    versions: [
      { uploaded: "2026-05-02T09:00:00.000Z", uploader: "tamas", text: s1.text, system: "G", language: "hu" },
      { uploaded: "2026-03-01T10:00:00.000Z", uploader: "anna", text: older, system: "G", language: "hu" },
    ],
  };
  const { call } = server(state);
  const listed = (await call("get_song_history", { songId: "s1" })).value as {
    versions: { version: number; sameAsThisComputer: boolean; firstLine: string }[];
  };
  assert.deepEqual(
    listed.versions.map((entry) => [entry.version, entry.sameAsThisComputer, entry.firstLine]),
    [
      [0, true, "Az Úr az én pásztorom,"],
      [1, false, "Az Úr az én pásztorunk,"],
    ]
  );
  assert.equal(((await call("get_song_history", { songId: "s1", version: 1 })).value as { text: string }).text, older);
  assert.match((await call("get_song_history", { songId: "s1", version: 5 })).text, /2 cloud versions/);

  assert.equal(((await call("compare_songs", { songId: "s1" })).value as { identical: boolean }).identical, true);
  const diff = ((await call("compare_songs", { songId: "s1", version: 1 })).value as { diff: string }).diff;
  assert.match(diff, /^--- A jó pásztor \(cloud version 1, 2026-03-01T10:00:00.000Z\)\n\+\+\+ A jó pásztor \(this computer\)/);
  assert.match(diff, /-\[G\]Az Úr az én \[D\]pásztorunk,\n\+\[G\]Az Úr az én \[D\]pásztorom,/);
  assert.match(
    ((await call("compare_songs", { songId: "s1", otherSongId: "s3" })).value as { diff: string }).diff,
    /\+\+\+ The flock \(this computer\)/
  );
  assert.match((await call("compare_songs", { songId: "s1", version: 0, otherVersion: 0 })).text, /two different texts/);
});

test("instructions: the song's sections and own order, a text checked line by line, and keeping them in the profile", async () => {
  const state = fakeState();
  state.songs.push(
    song(
      "i1",
      "Hálaének",
      "{title: Hálaének}\n{key: G}\n{start_of_verse: Verse 1}\n[G]Első vers[D]szak\n{end_of_verse}\n{start_of_chorus: Chorus}\n[C]Refrén [G]sor\n{end_of_chorus}\n{start_of_verse: Verse 2}\n[G]Második\n{end_of_verse}\n{c: Chorus}\n{c: halkan a végén}",
      "G"
    )
  );
  state.preferences.set("own1/i1", { transpose: 1 });
  const { call } = server(state);

  const read = (await call("get_song", { songId: "i1" })).value as {
    sections: { name: string; kind: string; firstLine: string }[];
    defaultInstructions: string;
    repeatedSections: string[][];
    selectedLeaderItem: { transpose: number; instructions: string };
  };
  assert.deepEqual(
    read.sections.map((section) => [section.name, section.kind, section.firstLine]),
    [
      ["Verse 1", "verse", "Első versszak"],
      ["Chorus", "chorus", "Refrén sor"],
      ["Verse 2", "verse", "Második"],
    ]
  );
  // The comment line naming the chorus repeats it in the song's own order.
  assert.equal(read.defaultInstructions, "Verse 1\nChorus\nVerse 2\nChorus\nhalkan a végén");
  assert.deepEqual(read.repeatedSections, []);
  assert.equal(read.selectedLeaderItem.transpose, 1);

  // The song's own comment lines are notes on purpose: no warnings for them.
  const own = (await call("check_instructions", { songId: "i1" })).value as {
    instructions: string;
    order: ({ section: string } | { note: string })[];
    warnings?: string[];
  };
  assert.match(own.instructions, /song's own order/);
  assert.deepEqual(
    own.order.map((step) => ("section" in step ? step.section : `(${step.note})`)),
    ["Verse 1", "Chorus", "Verse 2", "Chorus", "(halkan a végén)"]
  );
  assert.equal(own.warnings, undefined);

  const checked = (await call("check_instructions", { songId: "i1", instructions: "verse  1\nChorus\nChorus +2\nlassan\nVerse 3 2x", transpose: 2 }))
    .value as {
    order: ({ section: string; repeat: number; transpose: number; key?: string } | { note: string })[];
    normalized: string;
    warnings: string[];
    unusedSections: string[];
    projector: string;
  };
  // The section's transposition adds to the item's own (+2): the last chorus is at +4.
  assert.deepEqual(checked.order, [
    { section: "Verse 1", repeat: 1, transpose: 0, key: "G+2" },
    { section: "Chorus", repeat: 1, transpose: 0, key: "G+2" },
    { section: "Chorus", repeat: 1, transpose: 2, key: "G+4" },
    { note: "lassan" },
    { section: "Verse 1", repeat: 2, transpose: 0, key: "G+2" },
  ]);
  assert.equal(checked.normalized, "Verse 1\nChorus\nChorus +2\nlassan\nVerse 1 2x");
  // "verse  1" (two spaces) names Verse 1 exactly; only the note and the fallback are warned about.
  assert.equal(checked.warnings.length, 2);
  assert.match(checked.warnings[0], /'lassan' names no section of this song, so it is only a note[\s\S]*Verse 1, Chorus, Verse 2/);
  assert.match(checked.warnings[1], /'Verse 3 2x' is read as the section 'Verse 1'/);
  assert.deepEqual(checked.unusedSections, ["Verse 2"]);
  assert.match(checked.projector, /'projectInstructions' is off/);
  state.settings.projectInstructions = true;
  assert.match(((await call("check_instructions", { songId: "i1" })).value as { projector: string }).projector, /is on/);

  // Set on the working list and kept in the selected leader's profile.
  state.playlist = [{ songId: "i1", title: "Hálaének", transpose: 1, capo: -1, instructions: "" }];
  const revision = ((await call("get_playlist")).value as { revision: string }).revision;
  const edited = await call("edit_playlist", {
    revision,
    operations: [{ op: "update", index: 0, instructions: "Verse 1\nChorus 2x", storeInProfile: true }],
  });
  assert.equal(edited.isError, false, edited.text);
  assert.equal(state.playlist[0].instructions, "Verse 1\nChorus 2x");
  assert.equal(state.preferences.get("own1/i1")?.instructions, "Verse 1\nChorus 2x");
  assert.match(
    state.confirmations.at(-1)!,
    /instructions kept in Kiss Tamás's profile: Verse 1 \/ Chorus 2x[\s\S]*stay there even if the playlist change is undone/
  );
  // A new item can keep its instructions too; a move cannot.
  const next = ((await call("get_playlist")).value as { revision: string }).revision;
  assert.equal(
    (await call("edit_playlist", { revision: next, operations: [{ op: "add", songId: "s3", instructions: "Verse", storeInProfile: true }] })).isError,
    false
  );
  assert.equal(state.preferences.get("own1/s3")?.instructions, "Verse");
  const after = ((await call("get_playlist")).value as { revision: string }).revision;
  assert.match(
    (await call("edit_playlist", { revision: after, operations: [{ op: "move", from: 0, to: 1, storeInProfile: true }] })).text,
    /'storeInProfile' belongs to add and update/
  );
  // Not for stored lists, and not without a selected leader.
  state.stored.set("own1/2026-10-04", { name: "2026.10.04", items: [...state.playlist] });
  const storedRevision = ((await call("get_stored_playlist", { date: "2026-10-04" })).value as { revision: string }).revision;
  assert.match(
    (
      await call("edit_stored_playlist", {
        date: "2026-10-04",
        revision: storedRevision,
        operations: [{ op: "update", index: 0, storeInProfile: true }],
      })
    ).text,
    /'storeInProfile' works on the playlist loaded in the app/
  );
});

test("a ChordPro text with a section written out twice is reported", async () => {
  const { call } = server(fakeState());
  const report = (
    await call("validate_chordpro", {
      text: "{title: X}\n{start_of_chorus: Chorus 2x}\n[G]Ugyanaz a sor\n{end_of_chorus}\n{start_of_verse: Verse}\n[D]Más\n{end_of_verse}\n{start_of_chorus: Refrain}\n[G]Ugyanaz a  sor\n{end_of_chorus}",
    })
  ).value as { repeatedSections: string[][] };
  // By the names instructions use: the tag's repeat count is not part of the name.
  assert.deepEqual(report.repeatedSections, [["Chorus", "Refrain"]]);
});

test("help comes from the tutorials, is searchable in both languages and can be pointed at", async () => {
  const hu = buildHelpTopics(content.help, "hu");
  const en = buildHelpTopics(content.help, "en");
  assert.equal(hu.length, en.length);
  assert.ok(en.some((topic) => topic.id === "full/playlist" && topic.area === "full-view"));
  assert.ok(en.some((topic) => topic.id === "buttons/playlist" && /Add selected song to playlist/.test(topic.text)));
  assert.equal(searchHelp(en, "playlist", 3)[0].id.endsWith("/playlist"), true);
  assert.ok(searchHelp(hu, "lejatszasi lista", 3).length > 0);
  assert.deepEqual(searchHelp(en, "  ", 3), []);
  for (const topic of en) {
    for (const target of topic.targets ?? []) assert.ok(findTutorialSteps(content.help.tutorials, target.id), target.id);
  }
  assert.equal(findTutorialSteps(content.help.tutorials, "full/nope"), null);

  const { call } = server(fakeState());
  assert.equal((await call("show_in_app", { target: "full/playlist" })).isError, false);
  assert.match((await call("show_in_app", { target: "full/nope" })).text, /Unknown target/);
  const topics = (await call("search_help", { query: "synchronize", limit: 2 })).value as { id: string; targets: unknown[] }[];
  assert.ok(topics.length >= 1 && topics[0].targets.length >= 1);
});

test("diagnose names what blocks the user and how to get out", async () => {
  const healthy = await diagnose(fakeHost(fakeState()), () => Date.parse("2026-11-10T00:00:00Z"));
  assert.deepEqual(healthy, []);

  const state = fakeState({ account: { username: null, signedIn: false, guest: true }, songs: [], selectedLeaderId: null, displayCount: 1 });
  state.network = { ...state.network, webServerEnabled: false, clientUrl: null };
  state.ui = { ...state.ui, updateAvailable: true };
  const findings = (await diagnose(fakeHost(state))).map((entry) => entry.finding).join("\n");
  for (const expected of [
    /Nobody is signed in/,
    /database is empty/,
    /No leader profile/,
    /web server is off/,
    /Only one screen/,
    /update is available/,
  ]) {
    assert.match(findings, expected);
  }

  const stale = fakeState();
  stale.network = { ...stale.network, clients: [] };
  const old = await diagnose(fakeHost(stale), () => Date.parse("2027-03-01T00:00:00Z"));
  assert.match(old.map((entry) => entry.finding).join("\n"), /last synchronization was on 2026-11-01[\s\S]*No tablet or phone is connected/);
});

test("import opens the wizard with a file named after the title and format", async () => {
  const state = fakeState();
  const { call } = server(state);
  await call("import_song", { text: "X:1\nK:G\nCDE", format: "abc", title: 'Új/dal: "1"' });
  assert.deepEqual(state.calls, ["import:Új dal 1.abc"]);
});
